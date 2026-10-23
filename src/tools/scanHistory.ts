/**
 * `scan_history`ツールのハンドラ: スキャンの実行履歴の一覧・1回の詳細・直近2回の比較を返す
 * (docs/DESIGN_TODO.md「スキャンの実行履歴」)。
 *
 * - 履歴が無効ならhistory_disabled(空の結果は「履歴がない」と誤読されるため)
 * - OSV_MCP_ALLOWED_ROOT設定時は、対象が許可ルートの内側の回だけを返す
 * - 履歴のファイルは信頼しない入力として形式を確かめ、文字列は返す前にも無害化する
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { compareHistoryRecords, type HistoryChanges } from "../history/historyDiff.js";
import { parseHistoryRecord, type HistoryRecord, type ScanKind } from "../history/historyRecord.js";
import { HISTORY_ENV, HistoryUnavailableError, readHistoryRecords, type HistoryConfig } from "../history/historyStore.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { assertInsideAllowedRoot, isInsideDir } from "../utils/projectWalk.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export interface ScanHistoryArgs {
  project_path?: string;
  limit?: number;
  run_id?: string;
}

export interface ScanHistoryOptions {
  config: HistoryConfig;
  allowedRoot?: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_DETAIL_PACKAGES = 500;
const RUN_ID = /^\d{8}T\d{9}Z-[0-9a-f]{12}$/;

const NOTE =
  "Changes are computed from the vulnerability data at the time of each scan: they can also appear when the OSV database changes " +
  "without any change to the project. Scan results list only vulnerable packages, so a package that disappears from the results " +
  "may have been upgraded to a version without known vulnerabilities, removed, or no longer scanned (reason: package_not_reported)";

/** 応答に含める文字列をすべて無害化する(履歴のファイルは書き換えられうる) */
function sanitizeDeep(value: unknown): unknown {
  if (typeof value === "string") return sanitizeExternalText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeExternalText(k), sanitizeDeep(v)]));
  }
  return value;
}

async function resolveLoosely(input: string): Promise<string> {
  const absolute = path.resolve(input);
  try {
    return await realpath(absolute);
  } catch {
    return absolute; // 削除済みのプロジェクトの履歴も引けるようにする
  }
}

function summary(record: HistoryRecord) {
  return {
    id: record.id,
    started_at: record.started_at,
    tool: record.tool,
    target: record.target.input,
    project: record.target.resolved,
    status: record.status,
    ...(record.error_kind !== undefined ? { error_kind: record.error_kind } : {}),
    coverage_complete: record.coverage_complete,
    ...(record.counts !== undefined
      ? {
          vulnerable_package_count: record.counts.vulnerable_package_count,
          vulnerability_count: record.counts.vulnerability_count,
          ...(record.counts.informational_count > 0 ? { informational_count: record.counts.informational_count } : {}),
        }
      : {}),
    duration_ms: record.duration_ms,
  };
}

function detail(record: HistoryRecord) {
  const findings = record.findings ?? [];
  return {
    ...summary(record),
    server_version: record.server_version,
    osv_scanner: record.osv_scanner,
    allowed_root_set: record.allowed_root_set,
    ...(record.target_truncated ? { target_truncated: true } : {}),
    ...(record.manifests !== undefined ? { manifests: record.manifests } : {}),
    ...(record.manifests_truncated ? { manifests_truncated: true } : {}),
    ...(record.coverage_gaps !== undefined ? { coverage_gaps: record.coverage_gaps } : {}),
    ...(record.counts?.severity_breakdown ? { severity_breakdown: record.counts.severity_breakdown } : {}),
    ...(record.findings !== undefined ? { findings: findings.slice(0, MAX_DETAIL_PACKAGES) } : {}),
    ...(findings.length > MAX_DETAIL_PACKAGES ? { findings_omitted_from_response: findings.length - MAX_DETAIL_PACKAGES } : {}),
    ...(record.findings_truncated ? { findings_truncated: true } : {}),
    ...(record.findings_omitted ? { findings_omitted: true } : {}),
  };
}

function matchesProject(record: HistoryRecord, resolvedQuery: string, absoluteQuery: string): boolean {
  return record.target.resolved === resolvedQuery || path.resolve(record.target.input) === absoluteQuery;
}

/** 種類ごとに、直近の成功した2回を比べる */
function changesByKind(records: readonly HistoryRecord[]): ({ kind: ScanKind } & (HistoryChanges | { note: string }))[] {
  const kinds = [...new Set(records.map((r) => r.kind))];
  return kinds.map((kind) => {
    const ok = records.filter((r) => r.kind === kind && r.status === "ok"); // 新しい順
    if (ok.length < 2) return { kind, note: "Fewer than two successful runs of this kind are recorded, so there is nothing to compare yet" };
    return { kind, ...compareHistoryRecords(ok[1]!, ok[0]!) };
  });
}

export async function handleScanHistory(args: ScanHistoryArgs, options: ScanHistoryOptions): Promise<ToolResult> {
  try {
    if (!options.config.enabled) {
      throw new ScanToolError(
        "history_disabled",
        `The scan history is disabled. Set ${HISTORY_ENV}=1 in the MCP server environment to record scans from then on ` +
          "(records are kept locally; see the README for the location and limits)",
      );
    }
    if (args.run_id !== undefined && !RUN_ID.test(args.run_id)) {
      throw new ScanToolError("history_run_not_found", "run_id is not a valid history record ID (use an id from the runs list)");
    }
    const limit = Math.min(Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const rootReal = options.allowedRoot !== undefined ? await resolveLoosely(options.allowedRoot) : undefined;

    let resolvedQuery: string | undefined;
    let absoluteQuery: string | undefined;
    if (args.project_path !== undefined) {
      if (typeof args.project_path !== "string" || args.project_path.trim() === "") {
        throw new ScanToolError("project_not_found", "project_path is empty");
      }
      absoluteQuery = path.resolve(args.project_path);
      resolvedQuery = await resolveLoosely(args.project_path);
      if (rootReal !== undefined) assertInsideAllowedRoot(resolvedQuery, rootReal);
    }

    let stored: Awaited<ReturnType<typeof readHistoryRecords>>;
    try {
      stored = await readHistoryRecords(options.config);
    } catch (error) {
      if (error instanceof HistoryUnavailableError) throw new ScanToolError("history_unavailable", error.message);
      throw error;
    }
    let skipped = stored.skipped;
    const records: HistoryRecord[] = [];
    for (const { id, data } of stored.records) {
      const record = parseHistoryRecord(id, data);
      if (record === null) {
        skipped++;
        continue;
      }
      // 許可ルートを狭めて起動し直した場合に、範囲外の過去の情報を返さない
      if (rootReal !== undefined && !isInsideDir(rootReal, record.target.resolved)) continue;
      records.push(record);
    }

    if (args.run_id !== undefined) {
      const record = records.find((r) => r.id === args.run_id);
      if (record === undefined) throw new ScanToolError("history_run_not_found", `No recorded run with id ${args.run_id} is available`);
      return jsonResult(sanitizeDeep({ run: detail(record), note: NOTE }));
    }

    const selected = resolvedQuery !== undefined ? records.filter((r) => matchesProject(r, resolvedQuery!, absoluteQuery!)) : records;
    return jsonResult(sanitizeDeep({
      history: {
        directory: options.config.dir,
        max_entries: options.config.maxEntries,
        recorded_runs: selected.length,
        ...(skipped > 0 ? { skipped_records: skipped } : {}),
      },
      runs: selected.slice(0, limit).map(summary),
      ...(resolvedQuery !== undefined ? { changes: changesByKind(selected) } : {}),
      note: NOTE,
    }));
  } catch (error) {
    return errorResult(error);
  }
}
