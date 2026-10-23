/**
 * 実行履歴の1件の内容(要約と差分用の識別子)。ツールの応答(JSON)から作り、読み出し時に形式を確かめる。
 * 結果の全文・エラーメッセージは保存しない(docs/DESIGN_TODO.md「スキャンの実行履歴」)。
 */

import { asArray, asRecord, asString, asStrings } from "../utils/unknownJson.js";
import { MAX_RECORD_BYTES } from "./historyStore.js";

export const HISTORY_TOOLS = ["scan_project", "suggest_fix", "scan_java_project", "scan_java_artifact", "scan_sbom"] as const;
export type HistoryTool = (typeof HISTORY_TOOLS)[number];

/** 比較できるスキャンの種類。scan_projectとsuggest_fixは検出が同じため同じ種類 */
export type ScanKind = "project" | "java_project" | "artifact" | "sbom";

export function scanKind(tool: HistoryTool): ScanKind {
  switch (tool) {
    case "scan_project":
    case "suggest_fix":
      return "project";
    case "scan_java_project":
      return "java_project";
    case "scan_java_artifact":
      return "artifact";
    case "scan_sbom":
      return "sbom";
  }
}

export interface HistoryVulnerability {
  id: string;
  aliases: string[];
  informational?: string;
}

export interface HistoryFinding {
  ecosystem: string;
  name: string;
  version: string;
  vulnerabilities: HistoryVulnerability[];
  /** suggest_fixだけ */
  recommended_upgrade?: string | null;
  upgrade_tier?: string | null;
  verification?: string;
}

export interface HistoryManifest {
  path: string;
  ecosystem: string | null;
  format: string | null;
}

export interface HistoryRecord {
  schema: 1;
  id: string;
  started_at: string;
  duration_ms: number;
  tool: HistoryTool;
  kind: ScanKind;
  server_version: string;
  osv_scanner: { pinned_version: string; source: "OSV_SCANNER_PATH" | "pinned_download" | "PATH_or_pinned_download" };
  /** input: ツールに渡したパス / resolved: 比較・絞り込みに使う対象(プロジェクトのディレクトリ等の実パス) */
  target: { input: string; resolved: string };
  /** 対象のパスが長さの上限を超えたため切り詰めた */
  target_truncated?: true;
  allowed_root_set: boolean;
  status: "ok" | "error";
  error_kind?: string;
  /** coverage.complete(該当しないツールはnull) */
  coverage_complete: boolean | null;
  manifests?: HistoryManifest[];
  /** 範囲の欠けの件数(lockfile_missing等) */
  coverage_gaps?: Record<string, number>;
  counts?: {
    vulnerable_package_count: number | null;
    vulnerability_count: number | null;
    informational_count: number;
    severity_breakdown: Record<string, number> | null;
  };
  findings?: HistoryFinding[];
  /** findingsを上限で打ち切った(差分は不完全) */
  findings_truncated?: true;
  /** 1件の上限を超えたためfindingsを省いた(差分はとれない) */
  findings_omitted?: true;
  /** 1件の上限に収めるため、マニフェストの一覧を一部(または全部)省いた */
  manifests_truncated?: true;
}

const MAX_FINDING_PACKAGES = 5_000;
const MAX_FINDING_VULNERABILITIES = 20_000;
const MAX_ALIASES = 20;
const MAX_MANIFESTS = 1_000;
const MAX_TEXT = 512;
const MAX_SEVERITY_KEYS = 16;
/** 対象のパスの長さの上限(LinuxのPATH_MAX。これより長いパスは実在しえず、スキャンは失敗する) */
const MAX_PATH = 4096;

function text(value: unknown): string | null {
  const s = asString(value);
  return s === null ? null : s.slice(0, MAX_TEXT);
}

/** 対象のパス。照合に使うため、MAX_TEXTより長いパスもそのまま残す */
function pathText(value: unknown): { path: string; truncated: boolean } | null {
  const s = asString(value);
  return s === null ? null : { path: s.slice(0, MAX_PATH), truncated: s.length > MAX_PATH };
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function vulnerabilitiesOf(raw: unknown, budget: { remaining: number }): HistoryVulnerability[] | null {
  const out: HistoryVulnerability[] = [];
  for (const item of asArray(raw)) {
    const vuln = asRecord(item);
    const id = text(vuln?.id);
    if (id === null) continue;
    if (budget.remaining <= 0) return null;
    budget.remaining--;
    const aliases = [...new Set([...asStrings(vuln!.aliases), ...(text(vuln!.cve) !== null ? [text(vuln!.cve)!] : [])])]
      .filter((a) => a !== id).slice(0, MAX_ALIASES).map((a) => a.slice(0, MAX_TEXT));
    const informational = text(vuln!.informational);
    out.push({ id, aliases, ...(informational !== null ? { informational } : {}) });
  }
  return out;
}

/** ツールの応答から差分用の識別子を取り出す。上限を超えたらtruncated */
function findingsOf(tool: HistoryTool, payload: Record<string, unknown>): { findings: HistoryFinding[]; truncated: boolean } {
  const findings: HistoryFinding[] = [];
  const budget = { remaining: MAX_FINDING_VULNERABILITIES };
  const source = tool === "suggest_fix" ? asArray(payload.suggestions) : asArray(payload.packages);
  for (const item of source) {
    const pkg = asRecord(item);
    if (pkg === null) continue;
    const name = text(tool === "suggest_fix" ? pkg.package : pkg.name);
    const version = text(tool === "suggest_fix" ? pkg.current_version : pkg.version);
    const ecosystem = text(pkg.ecosystem);
    if (name === null || version === null || ecosystem === null) continue;
    if (findings.length >= MAX_FINDING_PACKAGES) return { findings, truncated: true };
    const vulnerabilities = vulnerabilitiesOf(tool === "suggest_fix" ? pkg.per_cve_detail : pkg.vulnerabilities, budget);
    if (vulnerabilities === null) return { findings, truncated: true };
    findings.push({
      ecosystem, name, version, vulnerabilities,
      ...(tool === "suggest_fix"
        ? { recommended_upgrade: text(pkg.recommended_upgrade), upgrade_tier: text(pkg.upgrade_tier), verification: text(pkg.verification) ?? "unknown" }
        : {}),
    });
  }
  return { findings, truncated: false };
}

function manifestsOf(payload: Record<string, unknown>): HistoryManifest[] | undefined {
  const coverage = asRecord(payload.coverage);
  const raw = coverage?.manifests ?? payload.manifests;
  if (raw === undefined) return undefined;
  const out: HistoryManifest[] = [];
  for (const item of asArray(raw).slice(0, MAX_MANIFESTS)) {
    const rec = asRecord(item);
    const p = text(rec?.path ?? item);
    if (p !== null) out.push({ path: p, ecosystem: text(rec?.ecosystem), format: text(rec?.format) });
  }
  return out;
}

/** 深刻度別の件数。キーの数も抑える(1件の大きさの上限を保証するため) */
function severityOf(severity: Record<string, unknown> | null): Record<string, number> | null {
  if (severity === null) return null;
  return Object.fromEntries(
    Object.entries(severity).filter(([, v]) => count(v) !== null).slice(0, MAX_SEVERITY_KEYS).map(([k, v]) => [k.slice(0, 32), count(v)!]),
  );
}

const GAP_FIELDS = [
  "lockfile_missing", "unpinned_requirements", "unscannable_requirements", "unscannable_crates", "unscannable_nuget_packages",
  "unresolved_package_references", "skipped_files", "unidentified_jars", "unidentified_packages",
];

function gapsOf(payload: Record<string, unknown>): Record<string, number> | undefined {
  const coverage = asRecord(payload.coverage);
  const gaps: Record<string, number> = {};
  for (const field of GAP_FIELDS) {
    const value = coverage?.[field];
    if (Array.isArray(value)) gaps[field] = value.length;
  }
  const skipped = payload.skipped_manifests; // scan_java_project
  if (Array.isArray(skipped)) gaps.skipped_manifests = skipped.length;
  return Object.keys(gaps).length > 0 ? gaps : undefined;
}

export interface RecordContext {
  id: string;
  startedAt: Date;
  durationMs: number;
  tool: HistoryTool;
  serverVersion: string;
  pinnedScannerVersion: string;
  scannerSource: HistoryRecord["osv_scanner"]["source"];
  inputPath: string;
  /** 応答にプロジェクトのディレクトリが無い場合に使う、入力のパスの実パス */
  resolvedInput: string;
  allowedRootSet: boolean;
}

/** ツールの応答(JSONテキスト)から1件を作る。応答を解釈できない場合はエラーの記録にする */
export function buildHistoryRecord(context: RecordContext, responseText: string, isError: boolean): HistoryRecord {
  let payload: Record<string, unknown> | null = null;
  try {
    payload = asRecord(JSON.parse(responseText));
  } catch {
    payload = null;
  }
  const input = pathText(context.inputPath) ?? { path: "", truncated: false };
  const resolved = pathText(payload?.project_dir) ?? pathText(context.resolvedInput) ?? input;
  const base = {
    schema: 1 as const,
    id: context.id,
    started_at: context.startedAt.toISOString(),
    duration_ms: Math.max(0, Math.round(context.durationMs)),
    tool: context.tool,
    kind: scanKind(context.tool),
    server_version: context.serverVersion,
    osv_scanner: { pinned_version: context.pinnedScannerVersion, source: context.scannerSource },
    target: { input: input.path, resolved: resolved.path },
    ...(input.truncated || resolved.truncated ? { target_truncated: true as const } : {}),
    allowed_root_set: context.allowedRootSet,
  };
  const errorKind = text(asRecord(payload?.error)?.kind);
  if (isError || payload === null || errorKind !== null) {
    return { ...base, status: "error", error_kind: errorKind ?? "unknown", coverage_complete: null };
  }
  const coverage = asRecord(payload.coverage);
  const complete = typeof coverage?.complete === "boolean" ? coverage.complete : null;
  const severity = asRecord(payload.severity_breakdown);
  const { findings, truncated } = findingsOf(context.tool, payload);
  const record: HistoryRecord = {
    ...base,
    status: "ok",
    coverage_complete: complete,
    ...(manifestsOf(payload) !== undefined ? { manifests: manifestsOf(payload) } : {}),
    ...(gapsOf(payload) !== undefined ? { coverage_gaps: gapsOf(payload) } : {}),
    counts: {
      vulnerable_package_count: count(payload.vulnerable_package_count ?? payload.identified_vulnerable_package_count),
      vulnerability_count: count(payload.vulnerability_count ?? payload.identified_vulnerability_count),
      informational_count: count(payload.informational_count) ?? 0,
      severity_breakdown: severityOf(severity),
    },
    findings,
    ...(truncated ? { findings_truncated: true as const } : {}),
  };
  if (context.tool === "suggest_fix") {
    // suggest_fixの応答には脆弱性の総数が無いため、提案の脆弱性の数を数える
    record.counts!.vulnerability_count = findings.reduce((n, f) => n + f.vulnerabilities.filter((v) => v.informational === undefined).length, 0);
  }
  return record;
}

function fitting(value: unknown): string | null {
  const text = JSON.stringify(value);
  return Buffer.byteLength(text, "utf8") <= MAX_RECORD_BYTES ? text : null;
}

/**
 * 保存する文字列。1件の上限(読み出しの上限と同じ)に必ず収める:
 * findingsを省き、それでも超えればマニフェストの一覧を半分ずつ減らし、最後は一覧を省く
 * (残りの項目は文字列の長さ・件数に上限があり、上限を十分に下回る。対象のパスも含む)
 */
export function serializeHistoryRecord(record: HistoryRecord): string {
  const full = fitting(record);
  if (full !== null) return full;
  const { findings: _findings, findings_truncated: _truncated, manifests, ...rest } = record;
  const summary = { ...rest, findings_omitted: true as const };
  if (manifests === undefined) return JSON.stringify(summary);
  const withAll = fitting({ ...summary, manifests });
  if (withAll !== null) return withAll;
  for (let n = Math.floor(manifests.length / 2); n > 0; n = Math.floor(n / 2)) {
    const partial = fitting({ ...summary, manifests: manifests.slice(0, n), manifests_truncated: true });
    if (partial !== null) return partial;
  }
  const last = fitting({ ...summary, manifests_truncated: true });
  // 残りの項目はどれも大きさに上限があるため通常は届かない。読み戻せないファイルは書かない(記録側が警告する)
  if (last === null) throw new Error("The history record exceeds the size limit even without findings and manifests");
  return last;
}

/** 読み出した記録の形式を確かめる(履歴のファイルは信頼しない)。解釈できなければnull */
export function parseHistoryRecord(id: string, raw: unknown): HistoryRecord | null {
  const rec = asRecord(raw);
  if (rec === null || rec.schema !== 1 || rec.id !== id) return null;
  const tool = asString(rec.tool);
  if (tool === null || !(HISTORY_TOOLS as readonly string[]).includes(tool)) return null;
  const target = asRecord(rec.target);
  const input = pathText(target?.input)?.path ?? null;
  const resolved = pathText(target?.resolved)?.path ?? null;
  const startedAt = text(rec.started_at);
  const status = rec.status === "ok" || rec.status === "error" ? rec.status : null;
  if (input === null || resolved === null || startedAt === null || status === null) return null;
  const osv = asRecord(rec.osv_scanner);
  const source = asString(osv?.source);
  const findings: HistoryFinding[] = [];
  for (const item of asArray(rec.findings).slice(0, MAX_FINDING_PACKAGES)) {
    const f = asRecord(item);
    const ecosystem = text(f?.ecosystem);
    const name = text(f?.name);
    const version = text(f?.version);
    if (ecosystem === null || name === null || version === null) continue;
    const vulnerabilities = (vulnerabilitiesOf(f!.vulnerabilities, { remaining: MAX_FINDING_VULNERABILITIES }) ?? []);
    findings.push({
      ecosystem, name, version, vulnerabilities,
      ...("recommended_upgrade" in f! ? { recommended_upgrade: text(f!.recommended_upgrade) } : {}),
      ...("upgrade_tier" in f! ? { upgrade_tier: text(f!.upgrade_tier) } : {}),
      ...(text(f!.verification) !== null ? { verification: text(f!.verification)! } : {}),
    });
  }
  const counts = asRecord(rec.counts);
  const severity = asRecord(counts?.severity_breakdown);
  return {
    schema: 1,
    id,
    started_at: startedAt,
    duration_ms: count(rec.duration_ms) ?? 0,
    tool: tool as HistoryTool,
    kind: scanKind(tool as HistoryTool),
    server_version: text(rec.server_version) ?? "unknown",
    osv_scanner: {
      pinned_version: text(osv?.pinned_version) ?? "unknown",
      source: source === "OSV_SCANNER_PATH" || source === "pinned_download" ? source : "PATH_or_pinned_download",
    },
    target: { input, resolved },
    ...(rec.target_truncated === true ? { target_truncated: true as const } : {}),
    allowed_root_set: rec.allowed_root_set === true,
    status,
    ...(status === "error" ? { error_kind: text(rec.error_kind) ?? "unknown" } : {}),
    coverage_complete: typeof rec.coverage_complete === "boolean" ? rec.coverage_complete : null,
    ...(Array.isArray(rec.manifests) ? { manifests: manifestsOf({ manifests: rec.manifests }) ?? [] } : {}),
    ...(asRecord(rec.coverage_gaps) !== null
      ? { coverage_gaps: Object.fromEntries(Object.entries(asRecord(rec.coverage_gaps)!).filter(([, v]) => count(v) !== null).map(([k, v]) => [k.slice(0, 64), count(v)!])) }
      : {}),
    ...(counts !== null
      ? {
          counts: {
            vulnerable_package_count: count(counts.vulnerable_package_count),
            vulnerability_count: count(counts.vulnerability_count),
            informational_count: count(counts.informational_count) ?? 0,
            severity_breakdown: severityOf(severity),
          },
        }
      : {}),
    ...(Array.isArray(rec.findings) ? { findings } : {}),
    ...(rec.findings_truncated === true ? { findings_truncated: true as const } : {}),
    ...(rec.findings_omitted === true ? { findings_omitted: true as const } : {}),
    ...(rec.manifests_truncated === true ? { manifests_truncated: true as const } : {}),
  };
}
