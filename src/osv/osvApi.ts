/**
 * OSVデータベースAPI(api.osv.dev)のクライアント。
 *
 * `explain_vulnerability`用に単一の脆弱性レコードを取得する。
 * セキュリティ考慮:
 * - 脆弱性IDはURLパス組み立てに使うため、英数字とハイフンのみの厳格な形式検証を行う
 *   (LLM由来の入力によるパス/クエリインジェクション対策)
 * - タイムアウトとレスポンスサイズ上限を設ける(DoS対策)
 * - レスポンスは外部由来データとして防御的にパースする(呼び出し側)
 */

import { ScanToolError } from "../errors.js";

export interface FetchOsvRecordOptions {
  /** デフォルト15秒 */
  timeoutMs?: number;
  /** レスポンスの上限バイト数。デフォルト4MB */
  maxResponseBytes?: number;
  /** テスト用の注入ポイント。省略時はglobalThis.fetch */
  fetchFn?: typeof fetch;
  /** デフォルト https://api.osv.dev */
  baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_BASE_URL = "https://api.osv.dev";

/**
 * OSVのID形式(GHSA-xxxx-xxxx-xxxx、CVE-YYYY-NNNN等)。
 * 英数字とハイフンのみ・先頭は英数字・最大64文字に制限する。
 */
const OSV_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;

/** 脆弱性IDを検証し、不正ならScanToolErrorを投げる。 */
export function validateVulnerabilityId(id: string): string {
  const trimmed = id.trim();
  if (!OSV_ID_PATTERN.test(trimmed)) {
    throw new ScanToolError(
      "invalid_vulnerability_id",
      "脆弱性IDの形式が不正です。GHSA-xxxx-xxxx-xxxx または CVE-YYYY-NNNN 形式のIDを指定してください",
    );
  }
  return trimmed;
}

/**
 * OSVデータベースから脆弱性レコードを1件取得する。
 *
 * @returns `JSON.parse`済みのOSVレコード(形式不明な外部データとして扱うこと)
 */
export async function fetchOsvRecord(
  id: string,
  options: FetchOsvRecordOptions = {},
): Promise<unknown> {
  const validatedId = validateVulnerabilityId(id);
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/vulns/${encodeURIComponent(validatedId)}`;

  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    throw new ScanToolError(
      "api_request_failed",
      isTimeout
        ? `OSV APIへのリクエストが${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした`
        : "OSV APIへの接続に失敗しました(ネットワークを確認してください)",
    );
  }

  if (response.status === 404) {
    // OSVの正規IDはGHSA等であり、CVE-IDはエイリアス解決できない場合がある
    const hint = validatedId.toUpperCase().startsWith("CVE-")
      ? "。CVE-IDで見つからない場合は、スキャン結果のid(GHSA-ID)で照会してください"
      : "";
    throw new ScanToolError(
      "vulnerability_not_found",
      `指定されたIDの脆弱性がOSVデータベースに見つかりません: ${validatedId}${hint}`,
    );
  }
  if (!response.ok) {
    throw new ScanToolError(
      "api_request_failed",
      `OSV APIがエラーを返しました(HTTP ${response.status})`,
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new ScanToolError(
      "output_too_large",
      `OSV APIのレスポンスがサイズ上限(${maxBytes}バイト)を超えました`,
    );
  }

  const body = await response.text();
  // 文字数(UTF-16単位)ではなくUTF-8バイト数で判定する(マルチバイト本文のズレ防止)
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new ScanToolError(
      "output_too_large",
      `OSV APIのレスポンスがサイズ上限(${maxBytes}バイト)を超えました`,
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new ScanToolError(
      "api_request_failed",
      "OSV APIのレスポンスをJSONとして解釈できませんでした",
    );
  }
}
