/**
 * OSV-Scannerバイナリの解決(docs/DESIGN_TODO.md 方式C)。
 * MVPでは自動ダウンロードは行わず、「存在チェック → なければ案内メッセージ」で対応する。
 * 探索順: 環境変数 OSV_SCANNER_PATH → PATH上の osv-scanner
 */

import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";

export const OSV_SCANNER_PATH_ENV = "OSV_SCANNER_PATH";

const BINARY_NAME = process.platform === "win32" ? "osv-scanner.exe" : "osv-scanner";

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return false;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** OSV-Scannerバイナリのパスを返す。見つからなければnull。 */
export async function findOsvScannerBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const explicit = env[OSV_SCANNER_PATH_ENV];
  if (explicit !== undefined && explicit.trim() !== "") {
    // 明示指定が無効な場合はPATHにフォールバックせず失敗させる(意図しないバイナリの実行を防ぐ)
    return (await isExecutableFile(explicit)) ? explicit : null;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, BINARY_NAME);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** インストール案内メッセージ。バイナリ未検出かつ自動ダウンロード不可のときに返す。 */
export function installGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[OSV_SCANNER_PATH_ENV];
  const envNote =
    explicit !== undefined && explicit.trim() !== ""
      ? `環境変数 ${OSV_SCANNER_PATH_ENV}(${explicit})が実行可能ファイルを指していません。パスを確認してください。`
      : `インストール済みの場合は、環境変数 ${OSV_SCANNER_PATH_ENV} でバイナリのパスを指定することもできます。`;
  return [
    "OSV-Scannerが見つかりません。以下のいずれかの方法でインストールしてください:",
    "  - Homebrew: brew install osv-scanner",
    "  - Go: go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest",
    "  - 公式リリース: https://github.com/google/osv-scanner/releases (取得後はチェックサム検証を推奨)",
    `  - または環境変数 ${AUTO_DOWNLOAD_ENV} の無効化(=0)を解除すると、検証済み公式バイナリを自動ダウンロードします`,
    envNote,
  ].join("\n");
}

export const AUTO_DOWNLOAD_ENV = "OSV_MCP_AUTO_DOWNLOAD";

function isAutoDownloadEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[AUTO_DOWNLOAD_ENV]?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export interface ResolveOsvScannerOptions {
  /** テスト用の注入ポイント。省略時はensureOsvScannerDownloaded */
  downloadFn?: () => Promise<string>;
}

/**
 * バイナリのパスを解決する。
 * 探索順: OSV_SCANNER_PATH(明示指定時はダウンロードにフォールバックしない)
 * → PATH → 自動ダウンロード(チェックサム検証付き、OSV_MCP_AUTO_DOWNLOAD=0で無効化)。
 * どれも不可なら案内メッセージ付きのScanToolErrorを投げる。
 */
export async function resolveOsvScannerBinary(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOsvScannerOptions = {},
): Promise<string> {
  const binary = await findOsvScannerBinary(env);
  if (binary !== null) {
    return binary;
  }

  const explicit = env[OSV_SCANNER_PATH_ENV];
  const explicitlySpecified = explicit !== undefined && explicit.trim() !== "";
  // 明示指定が無効な場合は、意図しないバイナリの使用を避けるためダウンロードしない
  if (!explicitlySpecified && isAutoDownloadEnabled(env)) {
    const download =
      options.downloadFn ??
      (async () => (await import("./binaryDownloader.js")).ensureOsvScannerDownloaded());
    return download();
  }

  throw new ScanToolError("binary_not_found", installGuidance(env));
}
