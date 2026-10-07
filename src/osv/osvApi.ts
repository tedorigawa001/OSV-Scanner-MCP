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
import { readResponseBytes } from "../utils/readResponseBytes.js";

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
      "Invalid vulnerability ID. Specify an ID such as GHSA-xxxx-xxxx-xxxx or CVE-YYYY-NNNN",
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
        ? `The OSV API request did not complete within ${Math.round(timeoutMs / 1000)} seconds`
        : "Could not connect to the OSV API (check the network)",
    );
  }

  if (response.status === 404) {
    // OSVの正規IDはGHSA等であり、CVE-IDはエイリアス解決できない場合がある
    const hint = validatedId.toUpperCase().startsWith("CVE-")
      ? ". If a CVE ID is not found, query with the id (GHSA ID) from the scan results"
      : "";
    throw new ScanToolError(
      "vulnerability_not_found",
      `No vulnerability with this ID was found in the OSV database: ${validatedId}${hint}`,
    );
  }
  if (!response.ok) {
    throw new ScanToolError(
      "api_request_failed",
      `The OSV API returned an error (HTTP ${response.status})`,
    );
  }

  let body: string;
  try {
    const bytes = await readResponseBytes(response, maxBytes, new ScanToolError(
      "output_too_large",
      `The OSV API response exceeded the size limit (${maxBytes} bytes)`,
    ));
    body = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    throw new ScanToolError(
      "api_request_failed",
      "Could not receive the OSV API response body",
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new ScanToolError(
      "api_request_failed",
      "Could not parse the OSV API response as JSON",
    );
  }
}

/** queryOsvPackageVersionでたどる続きのページの上限 */
const MAX_QUERY_PAGES = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): ScanToolError {
  return new ScanToolError("api_request_failed", "The OSV API response has an unexpected format");
}

async function readJsonBody(response: Response, maxBytes: number): Promise<unknown> {
  let body: string;
  try {
    const bytes = await readResponseBytes(response, maxBytes, new ScanToolError(
      "output_too_large",
      `The OSV API response exceeded the size limit (${maxBytes} bytes)`,
    ));
    body = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    throw new ScanToolError("api_request_failed", "Could not receive the OSV API response body");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ScanToolError("api_request_failed", "Could not parse the OSV API response as JSON");
  }
}

/**
 * パッケージの版に該当する脆弱性のレコードを取得する(`POST /v1/query`)。
 * suggest_fixの推奨先の照会に使う。送るのはスキャンで既に照会した名前と、公開されている修正版の版だけ。
 * 続きのページ(`next_page_token`)は上限までたどり、超えたら失敗とする(一部だけで「該当なし」と判断しない)。
 *
 * @returns 脆弱性レコードの配列(形式不明な外部データとして扱うこと)
 */
export async function queryOsvPackageVersion(
  ecosystem: string,
  name: string,
  version: string,
  options: FetchOsvRecordOptions = {},
): Promise<unknown[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/query`;
  const vulns: unknown[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_QUERY_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ package: { name, ecosystem }, version, ...(pageToken !== undefined ? { page_token: pageToken } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      throw new ScanToolError(
        "api_request_failed",
        isTimeout
          ? `The OSV API request did not complete within ${Math.round(timeoutMs / 1000)} seconds`
          : "Could not connect to the OSV API (check the network)",
      );
    }
    if (!response.ok) {
      throw new ScanToolError("api_request_failed", `The OSV API returned an error (HTTP ${response.status})`);
    }
    // 不正な応答を「該当なし」と読まない: ルート・各レコード・ページトークンの型を検証し、違えば失敗とする
    const body = await readJsonBody(response, maxBytes);
    if (!isPlainObject(body)) throw malformed();
    if (body.vulns !== undefined && (!Array.isArray(body.vulns) || !body.vulns.every(isPlainObject))) throw malformed();
    if (body.next_page_token !== undefined && typeof body.next_page_token !== "string") throw malformed();
    vulns.push(...((body.vulns as unknown[] | undefined) ?? []));
    if (body.next_page_token === undefined || body.next_page_token === "") return vulns;
    pageToken = body.next_page_token;
  }
  throw new ScanToolError("api_request_failed", `The OSV API response exceeded ${MAX_QUERY_PAGES} pages`);
}
