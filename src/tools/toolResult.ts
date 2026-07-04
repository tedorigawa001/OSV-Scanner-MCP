/**
 * MCPツール共通のレスポンス整形。
 *
 * エラーレスポンス形式(確定済み):
 * - 失敗時は`isError: true`+`{"error": {"kind", "message", "detail?"}}`のJSONテキスト
 * - `kind`は`ScanToolError`のkind。LLMクライアントが機械的に分岐できるよう必ず含める
 * - 予期しない例外は内部情報を漏らさず`internal_error`に丸める
 */

import { ScanToolError } from "../errors.js";

/** MCPのCallToolResultと互換の最小形 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function jsonResult(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** 捕捉した例外をエラーレスポンスに変換する。 */
export function errorResult(error: unknown): ToolResult {
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
