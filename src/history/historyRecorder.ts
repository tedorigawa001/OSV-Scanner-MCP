/**
 * スキャンのツール呼び出しを実行履歴に記録する。記録の失敗はスキャンを失敗させない(stderrに警告するだけ)。
 */

import { realpath } from "node:fs/promises";
import path from "node:path";
import { PINNED_OSV_SCANNER_VERSION } from "../osv/binaryDownloader.js";
import type { ToolResult } from "../tools/toolResult.js";
import { buildHistoryRecord, serializeHistoryRecord, type HistoryRecord, type HistoryTool } from "./historyRecord.js";
import { newRecordId, writeHistoryRecord, type HistoryConfig } from "./historyStore.js";

export interface RecorderOptions {
  config: HistoryConfig;
  serverVersion: string;
  allowedRootSet: boolean;
  env?: NodeJS.ProcessEnv;
  /** 警告の出力先(テスト用) */
  warn?: (message: string) => void;
}

function scannerSource(env: NodeJS.ProcessEnv): HistoryRecord["osv_scanner"]["source"] {
  if (env.OSV_SCANNER_PATH?.trim()) return "OSV_SCANNER_PATH";
  const prefer = env.OSV_MCP_PREFER_DOWNLOAD?.trim().toLowerCase();
  if (prefer === "1" || prefer === "true" || prefer === "yes") return "pinned_download";
  return "PATH_or_pinned_download";
}

async function resolveInput(input: string): Promise<string> {
  const absolute = path.resolve(input);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/** ツールを実行し、履歴が有効なら結果の要約を記録してから、結果をそのまま返す */
export async function withHistory(
  tool: HistoryTool,
  inputPath: string,
  run: () => Promise<ToolResult>,
  options: RecorderOptions,
): Promise<ToolResult> {
  if (!options.config.enabled) return run();
  const startedAt = new Date();
  const started = performance.now();
  const result = await run();
  const durationMs = performance.now() - started;
  try {
    const record = buildHistoryRecord(
      {
        id: newRecordId(startedAt),
        startedAt,
        durationMs,
        tool,
        serverVersion: options.serverVersion,
        pinnedScannerVersion: PINNED_OSV_SCANNER_VERSION,
        scannerSource: scannerSource(options.env ?? process.env),
        inputPath: typeof inputPath === "string" ? inputPath : String(inputPath),
        resolvedInput: await resolveInput(typeof inputPath === "string" ? inputPath : String(inputPath)),
        allowedRootSet: options.allowedRootSet,
      },
      result.content[0]?.text ?? "",
      result.isError === true,
    );
    await writeHistoryRecord(options.config, record.id, serializeHistoryRecord(record));
  } catch (error) {
    (options.warn ?? ((m) => console.error(m)))(
      `osv-scanner-mcp: [warning] The scan history could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return result;
}
