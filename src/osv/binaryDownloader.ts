/**
 * OSV-Scannerバイナリの自動ダウンロード(docs/DESIGN_TODO.md 方式B)。
 *
 * サプライチェーン対策:
 * - 取得元は公式GitHub Releases(github.com/google/osv-scanner)に限定
 * - バージョンをピン留めし、各プラットフォームのSHA256を**このソースに埋め込む**。
 *   リリース側のSHA256SUMSファイルは参照しない(配布元が改ざんされた場合でも、
 *   リポジトリにコミットされた値との照合で検出できる)
 * - チェックサム検証に合格するまでファイルに実行権限を与えない
 *   (一時ファイルに書き込み→検証→chmod→アトミックにリネーム)
 * - キャッシュ済みバイナリも使用のたびに再検証する(キャッシュ改ざん対策)
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import { readResponseBytes } from "../utils/readResponseBytes.js";

/**
 * ピン留めするOSV-Scannerのバージョン。更新時は下のチェックサムも必ず更新すること。
 * 範囲外の読み込みを防ぐ検証はこの版の挙動に合わせているため、更新時は
 * docs/DESIGN_TODO.md「B5」の監査と、requirements.txt・親POMの解釈の実機確認をやり直すこと。
 * pom.xmlの直接/推移的依存の判定(dependencyRelations.tsのpomRelations)も、この版が同じpom.xmlを
 * source.type "lockfile"(宣言された依存)と"unknown"(deps.devで解決された推移的依存)に分けて報告する挙動に依存するため再確認すること。
 * 2.7.0への更新時の確認結果はdocs/DESIGN_TODO.md「osv-scannerのピン留め更新(2.4.0 → 2.7.0)」(2026-10-15)
 */
export const PINNED_OSV_SCANNER_VERSION = "2.7.0";

/**
 * v2.7.0公式リリースのSHA256(2026-10-15取得)。osv-scanner_SHA256SUMSとGitHub APIのリリース資産のdigestの
 * 両方で一致を確認し、darwin_arm64はダウンロードした実体のハッシュとも照合した。
 * https://github.com/google/osv-scanner/releases/tag/v2.7.0
 */
const ASSET_CHECKSUMS: Record<string, string> = {
  "osv-scanner_darwin_amd64": "e82c5df7ab0a42dff29a1cd0660711447b56b4c0483ff66ad8634df10fd81a45",
  "osv-scanner_darwin_arm64": "d4926ef8da134332543be276dff157e4c170f99ad91fc48e89448a8816bdf70b",
  "osv-scanner_linux_amd64": "160c6253e2922e9e0a6a9771c5c4c40a4b3c6090b34a3cdd5e80c96cc2e4218b",
  "osv-scanner_linux_arm64": "4061ef4c021ed3c47f203b818f337e351336cc5cd67c0274fc36bd1dfc728dd7",
  "osv-scanner_windows_amd64.exe":
    "9964ed64ec9a387391eb4cc006ad5c531154821aef29b793e02c448de4686438",
  "osv-scanner_windows_arm64.exe":
    "3e630381c1f1fd3c9c4d447e6ff2ef6c737083371722773db8337eead0f97962",
};

const DOWNLOAD_TIMEOUT_MS = 300_000;
/** バイナリは実測50〜55MB。余裕を持たせつつ暴走は防ぐ */
const MAX_BINARY_BYTES = 200 * 1024 * 1024;

export interface DownloadOsvScannerOptions {
  /** キャッシュ先。デフォルト: $XDG_CACHE_HOME/osv-scanner-mcp または ~/.cache/osv-scanner-mcp */
  cacheDir?: string;
  /** テスト用の注入ポイント */
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  /** テスト用: 埋め込みチェックサムの上書き */
  checksums?: Record<string, string>;
  timeoutMs?: number;
}

/** GitHub Releasesの資産名(例: osv-scanner_darwin_arm64)。未対応プラットフォームはnull */
export function assetNameForPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const osName = { darwin: "darwin", linux: "linux", win32: "windows" }[platform as string];
  const cpuName = { x64: "amd64", arm64: "arm64" }[arch];
  if (osName === undefined || cpuName === undefined) return null;
  return `osv-scanner_${osName}_${cpuName}${osName === "windows" ? ".exe" : ""}`;
}

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "osv-scanner-mcp");
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

async function verifyFile(filePath: string, expectedSha256: string): Promise<boolean> {
  try {
    return sha256Hex(await readFile(filePath)) === expectedSha256;
  } catch {
    return false;
  }
}

async function downloadAsset(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    throw new ScanToolError(
      "binary_download_failed",
      isTimeout
        ? `The OSV-Scanner download did not complete within ${Math.round(timeoutMs / 1000)} seconds`
        : "The OSV-Scanner download failed (check the network)",
    );
  }
  if (!response.ok) {
    throw new ScanToolError(
      "binary_download_failed",
      `The OSV-Scanner download failed (HTTP ${response.status}): ${url}`,
    );
  }
  try {
    return await readResponseBytes(response, MAX_BINARY_BYTES, new ScanToolError(
      "binary_download_failed",
      `The download exceeds the size limit (${MAX_BINARY_BYTES} bytes)`,
    ));
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    throw new ScanToolError(
      "binary_download_failed",
      "Could not receive the OSV-Scanner download body",
    );
  }
}

/**
 * ピン留めバージョンのOSV-Scannerをキャッシュから返す。
 * 無ければ公式GitHub Releasesからダウンロードし、チェックサム検証後に配置する。
 *
 * @returns 検証済みバイナリの絶対パス
 */
export async function ensureOsvScannerDownloaded(
  options: DownloadOsvScannerOptions = {},
): Promise<string> {
  const assetName = assetNameForPlatform(options.platform, options.arch);
  if (assetName === null) {
    throw new ScanToolError(
      "binary_download_failed",
      `There is no official OSV-Scanner binary for this platform (${options.platform ?? process.platform}/${options.arch ?? process.arch}). Install it manually and set the OSV_SCANNER_PATH environment variable`,
    );
  }
  const checksums = options.checksums ?? ASSET_CHECKSUMS;
  const expected = checksums[assetName];
  if (expected === undefined) {
    throw new ScanToolError(
      "binary_download_failed",
      `No embedded checksum for ${assetName} (the package needs to be updated)`,
    );
  }

  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const versionDir = path.join(cacheDir, `v${PINNED_OSV_SCANNER_VERSION}`);
  const targetPath = path.join(versionDir, assetName);

  // キャッシュディレクトリは所有者のみアクセス可(0700)にする。
  // mkdirのmodeは新規作成時しか効かないため、旧版が広い権限で作った
  // 既存ディレクトリも明示的なchmodで締める(キャッシュヒット時も毎回)
  await mkdir(versionDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700);
  await chmod(versionDir, 0o700);

  // キャッシュ済みでも毎回検証する(改ざん・破損したキャッシュは再ダウンロード)
  if (await verifyFile(targetPath, expected)) {
    return targetPath;
  }

  const url = `https://github.com/google/osv-scanner/releases/download/v${PINNED_OSV_SCANNER_VERSION}/${assetName}`;
  console.error(`osv-scanner-mcp: downloading OSV-Scanner v${PINNED_OSV_SCANNER_VERSION}... (${url})`);
  const buffer = await downloadAsset(
    url,
    options.fetchFn ?? fetch,
    options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  );

  const actual = sha256Hex(buffer);
  if (actual !== expected) {
    throw new ScanToolError(
      "binary_checksum_mismatch",
      `The checksum of the downloaded OSV-Scanner does not match (possible tampering or corruption). expected=${expected} actual=${actual}`,
    );
  }

  // 検証合格後に初めて実行権限を付与し、アトミックに配置する。
  // 一時ファイル名はランダム+排他作成(wx)で同時ダウンロードやシンボリック
  // リンクの差し込みと競合しないようにする
  const tempPath = `${targetPath}.download-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(tempPath, buffer, { mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o755);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw new ScanToolError(
      "binary_download_failed",
      `Failed to install OSV-Scanner: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.error(`osv-scanner-mcp: installed the verified binary: ${targetPath}`);
  return targetPath;
}
