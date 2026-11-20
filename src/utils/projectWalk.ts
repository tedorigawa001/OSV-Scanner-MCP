/**
 * スキャン対象パスの検証と、上限付きのディレクトリ走査(Java用・汎用の検出で共有)。
 *
 * 検出したファイルがそのままOSV-Scannerのスキャン範囲になるため、走査は深さで打ち切らず
 * (Javaのソースツリーは深い)、上限に達した場合は結果を黙って欠落させずにエラーにする。
 */

import { opendir, realpath } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { ScanToolError } from "../errors.js";

export interface SearchLimitOptions {
  /** 探索の最大深さ(起点直下=1)。病的な入れ子への安全弁。デフォルト64 */
  maxDepth?: number;
  /** 探索するエントリ(ファイル・ディレクトリ)の総数の上限。デフォルト200,000 */
  maxEntries?: number;
  /** マニフェスト件数の上限。デフォルト1,000 */
  maxManifests?: number;
}

interface SearchLimits {
  maxDepth: number;
  maxEntries: number;
  maxManifests: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_MANIFESTS = 1_000;

/** Nodeの権限モデル(--permission)による拒否か */
export function isAccessDenied(error: unknown): error is Error & { permission?: string; resource?: string } {
  return error instanceof Error && (error as { code?: unknown }).code === "ERR_ACCESS_DENIED";
}

/** 権限モデルの拒否を、許可の付け方が分かるエラーにする */
export function permissionDeniedError(error: Error & { permission?: string; resource?: string }): ScanToolError {
  const resource = typeof error.resource === "string" ? `: ${error.resource}` : "";
  const kind = error.permission === "FileSystemWrite" ? "Writing (--allow-fs-write)" : error.permission === "ChildProcess"
    ? "Starting child processes (--allow-child-process)" : "Reading (--allow-fs-read)";
  return new ScanToolError(
    "permission_denied",
    `${kind} is not allowed by the Node permission model (--permission)${resource}. ` +
      "The scan targets, the temporary directory (both its symlinked and resolved paths), and the osv-scanner cache must be allowed (see \"Running with restricted permissions\" in the README)",
  );
}

export async function resolveExistingPath(inputPath: string): Promise<string> {
  try {
    return await realpath(path.resolve(inputPath));
  } catch (error) {
    // Nodeの権限モデルの拒否を「存在しない」と誤って伝えない
    if (isAccessDenied(error)) throw permissionDeniedError(error);
    throw new ScanToolError("project_not_found", `The path does not exist: ${inputPath}`);
  }
}

/** targetがbaseDir自身またはその配下か(どちらも解決済みの絶対パス) */
export function isInsideDir(baseDir: string, target: string): boolean {
  const relative = path.relative(baseDir, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertInsideAllowedRoot(resolvedDir: string, allowedRootReal: string): void {
  if (!isInsideDir(allowedRootReal, resolvedDir)) {
    throw new ScanToolError(
      "path_outside_allowed_root",
      `The path is outside the allowed directory (${allowedRootReal})`,
    );
  }
}

function searchLimitError(reason: string): ScanToolError {
  return new ScanToolError(
    "manifest_search_limit_exceeded",
    `The scan was stopped because the manifest search reached its limit (${reason}). ` +
      "Partial results are not returned, to avoid silently missing dependencies. Specify a narrower directory or the manifest itself",
  );
}

/** 読めなかったディレクトリ(rootDirからの相対パス。rootDir自身は".") */
export interface UnreadableDirectory {
  path: string;
  reason: string;
}

/** 読めないディレクトリの理由。応答に載るため、OSのエラーの文言やパスは含めない */
export const UNREADABLE_DIRECTORY_REASON =
  "The directory cannot be read (for example, missing permissions), so manifests in it were not searched";

/**
 * 上限付きで幅優先に走査し、ファイルごとにonFileを呼ぶ。シンボリックリンクは辿らない。
 * onFileがtrueを返したファイルをマニフェストとして数え、上限到達はエラーにする。
 * skipChildrenはディレクトリごとに、その中の項目の名前から追加で飛ばすサブディレクトリを返す
 * (.NETのプロジェクトのディレクトリのbin・obj。名前だけで飛ばすと他のエコシステムのbinまで飛ばすため)
 *
 * OSの権限不足等で読めないディレクトリは、走査を続けたうえでonUnreadableDirに渡す。呼び出し側は
 * スキャン範囲の欠けとして報告する(以前は黙って飛ばし、配下のマニフェストが欠けても
 * `coverage.complete: true`になっていた。脆弱性チェックで判明、2026-11-20)。
 * 項目は1件ずつ読み、エントリ数の上限を読みながら確かめる(以前は一覧全体をメモリに読み込んでから
 * 数えていたため、数百万件の項目を持つ1つのディレクトリで大量のメモリと時間を使っていた)
 */
export async function walkProjectFiles(
  rootDir: string,
  options: SearchLimitOptions,
  skippedDirs: ReadonlySet<string>,
  onFile: (relativePath: string, name: string) => boolean,
  skipChildren?: (entryNames: readonly string[]) => ReadonlySet<string>,
  onUnreadableDir?: (directory: UnreadableDirectory) => void,
): Promise<void> {
  const limits: SearchLimits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxManifests: options.maxManifests ?? DEFAULT_MAX_MANIFESTS,
  };
  let visited = 0;
  let manifests = 0;
  let currentLevel = [rootDir];

  for (let depth = 1; currentLevel.length > 0; depth++) {
    if (depth > limits.maxDepth) throw searchLimitError(`depth ${limits.maxDepth}`);
    const nextLevel: string[] = [];
    for (const dir of currentLevel) {
      const entries: Dirent[] = [];
      try {
        const handle = await opendir(dir);
        // for awaitは途中で抜けても例外でもディレクトリを閉じる
        for await (const entry of handle) {
          if (++visited > limits.maxEntries) throw searchLimitError(`${limits.maxEntries} entries`);
          entries.push(entry);
        }
      } catch (error) {
        if (error instanceof ScanToolError) throw error;
        // Nodeの権限モデルの拒否は、スキャン範囲を黙って欠落させずにエラーにする
        if (isAccessDenied(error)) throw permissionDeniedError(error);
        // 読めないディレクトリ(OSの権限不足等)は走査を続け、範囲の欠けとして呼び出し側に伝える。
        // 途中まで読めた項目も使わない(どこまで読めたかに結果を左右させない)
        onUnreadableDir?.({ path: path.relative(rootDir, dir) || ".", reason: UNREADABLE_DIRECTORY_REASON });
        continue;
      }
      // readdir(libuvのscandir)と同じく名前のバイト順に並べ、検出結果の順序を以前と変えない
      const sorted = entries.map((entry) => ({ entry, key: Buffer.from(entry.name) })).sort((a, b) => Buffer.compare(a.key, b.key));
      const extraSkipped = skipChildren?.(sorted.map(({ entry }) => entry.name));
      for (const { entry } of sorted) {
        if (entry.isFile()) {
          if (onFile(path.relative(rootDir, path.join(dir, entry.name)), entry.name)) {
            if (++manifests > limits.maxManifests) throw searchLimitError(`${limits.maxManifests} manifests`);
          }
        } else if (entry.isDirectory() && !skippedDirs.has(entry.name) && !extraSkipped?.has(entry.name)) {
          // isDirectory()はシンボリックリンクに対してfalseを返すため、リンクは自然に除外される
          nextLevel.push(path.join(dir, entry.name));
        }
      }
    }
    currentLevel = nextLevel;
  }
}
