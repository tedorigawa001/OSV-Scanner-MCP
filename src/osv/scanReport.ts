/**
 * `scan_java_project`ツールの出力スキーマと、OSV-Scanner JSON出力からの変換。
 *
 * DESIGN_TODO.mdの実機調査で確定した方針:
 * - 脆弱性のグルーピングは`packages[].groups[]`(1エントリ=1脆弱性)をそのまま活用し、
 *   独自グルーピングは持たない
 * - `max_severity`は空文字列のケースが実在する(CVE-2015-6420で確認)ため、
 *   数値化できない値はscore=null / severity="unknown"として例外を投げずに扱う
 * - 同一pom.xmlが複数の`results[]`エントリに分かれるケースがあるため、
 *   pathでグルーピングせず全`results[].packages[]`をフラットに集約する
 *
 * OSV-Scannerの出力は外部由来データなので、形式が想定と異なっても例外を投げず
 * 読み取れた範囲でレポートを構築する(欠損フィールドはスキップ)。
 */

import { compareMavenVersions } from "../utils/mavenVersion.js";

export type SeverityLevel = "critical" | "high" | "medium" | "low" | "unknown";

export interface ScanReportVulnerability {
  /** 代表ID。OSV-Scannerの`group.ids[0]`(通常はGHSA-ID) */
  id: string;
  /** aliasesから抽出したCVE-ID。存在しなければnull */
  cve: string | null;
  /** 代表ID以外の関連ID(GHSA/CVE等) */
  aliases: string[];
  /** `group.max_severity`(CVSSスコア)。空文字・非数値はnull */
  severity_score: number | null;
  severity: SeverityLevel;
  /** OSVエントリのsummary。外部由来テキストのため長さ上限あり */
  summary: string | null;
  /** 修正版バージョン(Maven優先順位で昇順)。複数リリース系統が混在しうる。空=未修正 */
  fixed_versions: string[];
}

export interface ScanReportPackage {
  name: string;
  version: string;
  ecosystem: string;
  /** 深刻度の高い順(unknownは末尾) */
  vulnerabilities: ScanReportVulnerability[];
}

export interface ScanReport {
  /** スキャン対象として認識されたファイル(pom.xml等)のパス */
  source_files: string[];
  vulnerable_package_count: number;
  vulnerability_count: number;
  severity_breakdown: Record<SeverityLevel, number>;
  /** 最も深刻な脆弱性を持つパッケージ順 */
  packages: ScanReportPackage[];
}

/** 外部由来のsummaryをLLMに渡す際の長さ上限(プロンプト肥大・DoS対策) */
const MAX_SUMMARY_LENGTH = 500;

const CVSS_CRITICAL = 9.0;
const CVSS_HIGH = 7.0;
const CVSS_MEDIUM = 4.0;

function severityFromScore(score: number | null): SeverityLevel {
  if (score === null) return "unknown";
  if (score >= CVSS_CRITICAL) return "critical";
  if (score >= CVSS_HIGH) return "high";
  if (score >= CVSS_MEDIUM) return "medium";
  return "low";
}

// --- 外部JSON用の防御的アクセサ(形式不正でも例外を投げない) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === "string");
}

/** `max_severity`をCVSSスコアに変換する。空文字・非数値・範囲外はnull(unknown扱い)。 */
function parseSeverityScore(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const score = Number(raw);
  return Number.isFinite(score) && score >= 0 && score <= 10 ? score : null;
}

function truncateSummary(summary: string): string {
  return summary.length > MAX_SUMMARY_LENGTH ? `${summary.slice(0, MAX_SUMMARY_LENGTH)}…` : summary;
}

/** groupのidsに対応するOSVエントリ詳細(`packages[].vulnerabilities[]`)を探す。 */
function findVulnDetails(details: unknown[], ids: readonly string[]): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const detailRaw of details) {
    const detail = asRecord(detailRaw);
    if (!detail) continue;
    const id = asString(detail.id);
    if (id !== null && ids.includes(id)) found.push(detail);
  }
  return found;
}

function extractSummary(vulnDetails: Record<string, unknown>[]): string | null {
  for (const detail of vulnDetails) {
    const summary = asString(detail.summary);
    if (summary !== null && summary.trim() !== "") return truncateSummary(summary);
  }
  return null;
}

/**
 * OSVエントリの`affected[].ranges[].events[].fixed`から修正版を収集する。
 * 1つのOSVエントリが複数パッケージをカバーしうるため、対象パッケージ名で絞り込む。
 */
function extractFixedVersions(
  vulnDetails: Record<string, unknown>[],
  packageName: string,
): string[] {
  const versions = new Set<string>();
  for (const detail of vulnDetails) {
    for (const affectedRaw of asArray(detail.affected)) {
      const affected = asRecord(affectedRaw);
      if (!affected) continue;
      const affectedName = asString(asRecord(affected.package)?.name);
      if (affectedName !== null && affectedName !== packageName) continue;
      for (const rangeRaw of asArray(affected.ranges)) {
        for (const eventRaw of asArray(asRecord(rangeRaw)?.events)) {
          const fixed = asString(asRecord(eventRaw)?.fixed);
          if (fixed !== null && fixed !== "") versions.add(fixed);
        }
      }
    }
  }
  return [...versions].sort(compareMavenVersions);
}

interface MutablePackage {
  name: string;
  version: string;
  ecosystem: string;
  vulns: Map<string, ScanReportVulnerability>;
}

/**
 * OSV-Scannerの`--format json`出力を`scan_java_project`のレポートに変換する。
 *
 * @param raw `JSON.parse`済みのOSV-Scanner出力(形式不明な外部データとして扱う)
 */
export function parseOsvScanOutput(raw: unknown): ScanReport {
  const sourceFiles: string[] = [];
  const packageMap = new Map<string, MutablePackage>();

  for (const resultRaw of asArray(asRecord(raw)?.results)) {
    const result = asRecord(resultRaw);
    if (!result) continue;

    const sourcePath = asString(asRecord(result.source)?.path);
    if (sourcePath !== null && !sourceFiles.includes(sourcePath)) {
      sourceFiles.push(sourcePath);
    }

    for (const pkgRaw of asArray(result.packages)) {
      const pkgObj = asRecord(pkgRaw);
      if (!pkgObj) continue;
      const info = asRecord(pkgObj.package);
      const name = asString(info?.name);
      const version = asString(info?.version);
      if (name === null || version === null) continue;
      const ecosystem = asString(info?.ecosystem) ?? "unknown";

      // 同一パッケージが複数のresults[]エントリに分かれても1つに集約する
      const key = `${ecosystem}:${name}@${version}`;
      let entry = packageMap.get(key);
      if (!entry) {
        entry = { name, version, ecosystem, vulns: new Map() };
        packageMap.set(key, entry);
      }

      const details = asArray(pkgObj.vulnerabilities);
      for (const groupRaw of asArray(pkgObj.groups)) {
        const group = asRecord(groupRaw);
        if (!group) continue;
        const ids = asStrings(group.ids);
        const aliases = asStrings(group.aliases);
        const primaryId = ids[0] ?? aliases[0];
        if (primaryId === undefined || entry.vulns.has(primaryId)) continue;

        const score = parseSeverityScore(asString(group.max_severity));
        const vulnDetails = findVulnDetails(details, ids);
        entry.vulns.set(primaryId, {
          id: primaryId,
          cve:
            aliases.find((a) => a.startsWith("CVE-")) ??
            (primaryId.startsWith("CVE-") ? primaryId : null),
          aliases: [...new Set([...ids, ...aliases])].filter((a) => a !== primaryId),
          severity_score: score,
          severity: severityFromScore(score),
          summary: extractSummary(vulnDetails),
          fixed_versions: extractFixedVersions(vulnDetails, name),
        });
      }
    }
  }

  return buildReport(sourceFiles, packageMap);
}

/** ソート用: unknown(null)はどの数値スコアよりも後ろに置く */
function sortScore(score: number | null): number {
  return score ?? -1;
}

function buildReport(sourceFiles: string[], packageMap: Map<string, MutablePackage>): ScanReport {
  const severityBreakdown: Record<SeverityLevel, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  let vulnerabilityCount = 0;

  const packages: ScanReportPackage[] = [...packageMap.values()]
    .filter((entry) => entry.vulns.size > 0)
    .map((entry) => {
      const vulnerabilities = [...entry.vulns.values()].sort(
        (a, b) => sortScore(b.severity_score) - sortScore(a.severity_score) || cmpId(a.id, b.id),
      );
      for (const vuln of vulnerabilities) {
        severityBreakdown[vuln.severity]++;
        vulnerabilityCount++;
      }
      return { name: entry.name, version: entry.version, ecosystem: entry.ecosystem, vulnerabilities };
    })
    .sort(
      (a, b) =>
        maxScore(b.vulnerabilities) - maxScore(a.vulnerabilities) || cmpId(a.name, b.name),
    );

  return {
    source_files: sourceFiles,
    vulnerable_package_count: packages.length,
    vulnerability_count: vulnerabilityCount,
    severity_breakdown: severityBreakdown,
    packages,
  };
}

function maxScore(vulns: ScanReportVulnerability[]): number {
  return vulns.reduce((max, v) => Math.max(max, sortScore(v.severity_score)), -1);
}

function cmpId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
