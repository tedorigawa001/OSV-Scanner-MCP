/**
 * `scan_java_project`ツールのハンドラ。
 *
 * エラーレスポンス形式(ここで確定):
 * - 失敗時は`isError: true`+`{"error": {"kind", "message", "detail?"}}`のJSONテキストを返す
 * - `kind`は`ScanToolError`のkind(docs/DESIGN_TODO.md参照)。LLMクライアントが
 *   機械的に分岐できるよう、自然文のmessageとは別に必ず含める
 * - 予期しない例外は内部情報を漏らさず`internal_error`に丸める
 */

import { ScanToolError } from "../errors.js";
import { runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { detectJavaProject } from "../utils/projectDetector.js";

export interface ScanJavaProjectArgs {
  /** スキャン対象のディレクトリまたはpom.xmlのパス */
  project_path: string;
}

export interface ScanJavaProjectOptions extends RunOsvScanOptions {
  /** 指定時、このディレクトリ配下以外のスキャンを拒否する */
  allowedRoot?: string;
}

/** MCPのCallToolResultと互換の最小形 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleScanJavaProject(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectJavaProject(args.project_path, {
      allowedRoot: options.allowedRoot,
    });
    const report = await runOsvScan(project.projectDir, options);
    return jsonResult({
      project_dir: project.projectDir,
      manifests: project.manifests,
      ...report,
    });
  } catch (error) {
    if (error instanceof ScanToolError) {
      return jsonResult(
        {
          error: {
            kind: error.kind,
            message: error.message,
            ...(error.detail !== undefined && error.detail !== "" ? { detail: error.detail } : {}),
          },
        },
        true,
      );
    }
    // 想定外の例外はスタックトレース等の内部情報をクライアントへ返さない
    return jsonResult(
      { error: { kind: "internal_error", message: "予期しないエラーが発生しました" } },
      true,
    );
  }
}
