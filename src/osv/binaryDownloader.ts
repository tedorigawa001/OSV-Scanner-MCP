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

/** ピン留めするOSV-Scannerのバージョン。更新時は下のチェックサムも必ず更新すること */
export const PINNED_OSV_SCANNER_VERSION = "2.4.0";

/**
 * v2.4.0公式リリースのSHA256(osv-scanner_SHA256SUMSより転記、2026-07-04取得)。
 * https://github.com/google/osv-scanner/releases/tag/v2.4.0
 */
const ASSET_CHECKSUMS: Record<string, string> = {
  "osv-scanner_darwin_amd64": "088119325156321c34c456ac3703d6013538fd71cbac82b891ab34db491e4d66",
  "osv-scanner_darwin_arm64": "9ca3185ad63e9ab54f7cb90f46a7362be02d80e37f0123d095a54355ea202f5d",
  "osv-scanner_linux_amd64": "15314940c10d26af9c6649f150b8a47c1262e8fc7e17b1d1029b0e479e8ed8a0",
  "osv-scanner_linux_arm64": "44e580752910f0ff36ec99aff59af20f65df1e859aa31e5605a8f0d055b496e9",
  "osv-scanner_windows_amd64.exe":
    "0cdd113610126d5dfd5e12ad0e0b4f3e879291ff19bb43b0c52ed2f2c2df1a37",
  "osv-scanner_windows_arm64.exe":
    "1ce89d7d8ef083634648ef0f193fe1254f36f46f4bdc93d61178adacc2e60da0",
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

function defaultCacheDir(): string {
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
        ? `OSV-Scannerのダウンロードが${Math.round(timeoutMs / 1000)}秒以内に完了しませんでした`
        : "OSV-Scannerのダウンロードに失敗しました(ネットワークを確認してください)",
    );
  }
  if (!response.ok) {
    throw new ScanToolError(
      "binary_download_failed",
      `OSV-Scannerのダウンロードに失敗しました(HTTP ${response.status}): ${url}`,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BINARY_BYTES) {
    throw new ScanToolError(
      "binary_download_failed",
      `ダウンロードサイズが上限(${MAX_BINARY_BYTES}バイト)を超えています`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_BINARY_BYTES) {
    throw new ScanToolError(
      "binary_download_failed",
      `ダウンロードサイズが上限(${MAX_BINARY_BYTES}バイト)を超えています`,
    );
  }
  return buffer;
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
      `このプラットフォーム(${options.platform ?? process.platform}/${options.arch ?? process.arch})向けのOSV-Scanner公式バイナリが存在しません。手動でインストールし、環境変数OSV_SCANNER_PATHで指定してください`,
    );
  }
  const checksums = options.checksums ?? ASSET_CHECKSUMS;
  const expected = checksums[assetName];
  if (expected === undefined) {
    throw new ScanToolError(
      "binary_download_failed",
      `${assetName}の埋め込みチェックサムがありません(パッケージの更新が必要です)`,
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
  console.error(`osv-scanner-mcp: OSV-Scanner v${PINNED_OSV_SCANNER_VERSION} をダウンロード中... (${url})`);
  const buffer = await downloadAsset(
    url,
    options.fetchFn ?? fetch,
    options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS,
  );

  const actual = sha256Hex(buffer);
  if (actual !== expected) {
    throw new ScanToolError(
      "binary_checksum_mismatch",
      `ダウンロードしたOSV-Scannerのチェックサムが一致しません(改ざんまたは破損の可能性)。expected=${expected} actual=${actual}`,
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
      `OSV-Scannerの配置に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.error(`osv-scanner-mcp: 検証済みバイナリを配置しました: ${targetPath}`);
  return targetPath;
}
