/**
 * スキャン対象パスの検証と、上限付きのディレクトリ走査(Java用・汎用の検出で共有)。
 *
 * 検出したファイルがそのままOSV-Scannerのスキャン範囲になるため、走査は深さで打ち切らず
 * (Javaのソースツリーは深い)、上限に達した場合は結果を黙って欠落させずにエラーにする。
 */

import { readdir, realpath } from "node:fs/promises";
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

/**
 * 上限付きで幅優先に走査し、ファイルごとにonFileを呼ぶ。シンボリックリンクは辿らない。
 * onFileがtrueを返したファイルをマニフェストとして数え、上限到達はエラーにする。
 */
export async function walkProjectFiles(
  rootDir: string,
  options: SearchLimitOptions,
  skippedDirs: ReadonlySet<string>,
  onFile: (relativePath: string, name: string) => boolean,
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
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        // Nodeの権限モデルの拒否は、スキャン範囲を黙って欠落させずにエラーにする
        if (isAccessDenied(error)) throw permissionDeniedError(error);
        continue; // 読めないディレクトリはスキップ(OSの権限不足等)
      }
      for (const entry of entries) {
        if (++visited > limits.maxEntries) throw searchLimitError(`${limits.maxEntries} entries`);
        if (entry.isFile()) {
          if (onFile(path.relative(rootDir, path.join(dir, entry.name)), entry.name)) {
            if (++manifests > limits.maxManifests) throw searchLimitError(`${limits.maxManifests} manifests`);
          }
        } else if (entry.isDirectory() && !skippedDirs.has(entry.name)) {
          // isDirectory()はシンボリックリンクに対してfalseを返すため、リンクは自然に除外される
          nextLevel.push(path.join(dir, entry.name));
        }
      }
    }
    currentLevel = nextLevel;
  }
}
