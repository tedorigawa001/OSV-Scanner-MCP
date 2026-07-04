/**
 * OSV-Scannerバイナリの解決(DESIGN_TODO.md 方式C)。
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

/** 方式Cの案内メッセージ。バイナリ未検出時にそのままユーザーへ返す。 */
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
    envNote,
  ].join("\n");
}

/** バイナリのパスを返す。見つからなければ案内メッセージ付きのScanToolErrorを投げる。 */
export async function resolveOsvScannerBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const binary = await findOsvScannerBinary(env);
  if (binary === null) {
    throw new ScanToolError("binary_not_found", installGuidance(env));
  }
  return binary;
}
