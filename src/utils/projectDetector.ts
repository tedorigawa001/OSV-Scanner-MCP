/**
 * スキャン対象パスの検証とMavenプロジェクトの検出。
 *
 * `project_path`はLLM・ユーザー由来の信頼できない入力として扱う:
 * - `realpath`で正規化し、シンボリックリンクを解決した実体パスで判定する
 * - `allowedRoot`指定時は、解決後のパスがその配下にあることを検証する(パストラバーサル対策)
 * - pom.xml探索は深さ・件数に上限を設け、シンボリックリンクのディレクトリは辿らない
 */

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";

export interface DetectedJavaProject {
  /** シンボリックリンク解決済みの絶対パス。OSV-Scannerにはこれを渡す */
  projectDir: string;
  /** projectDirからの相対パスで表したpom.xmlの一覧 */
  manifests: string[];
}

export interface DetectJavaProjectOptions {
  /** 指定時、解決後のパスがこのディレクトリ配下でなければエラー */
  allowedRoot?: string;
  /** pom.xml探索の最大深さ(projectDir直下=1)。デフォルト3 */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 3;
/** 探索を打ち切るpom.xml件数の上限(巨大モノレポでの暴走防止) */
const MAX_MANIFESTS = 100;
/** ビルド成果物・VCS等、pom.xml探索でスキップするディレクトリ */
const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "build", ".idea", ".vscode"]);

async function resolveExistingPath(inputPath: string): Promise<string> {
  try {
    return await realpath(path.resolve(inputPath));
  } catch {
    throw new ScanToolError(
      "project_not_found",
      `指定されたパスが存在しません: ${inputPath}`,
    );
  }
}

function assertInsideAllowedRoot(resolvedDir: string, allowedRootReal: string): void {
  const relative = path.relative(allowedRootReal, resolvedDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ScanToolError(
      "path_outside_allowed_root",
      `指定されたパスは許可されたディレクトリ(${allowedRootReal})の外にあります`,
    );
  }
}

/** 深さ・件数上限付きでpom.xmlを探索する。シンボリックリンクは辿らない。 */
async function findPomFiles(rootDir: string, maxDepth: number): Promise<string[]> {
  const manifests: string[] = [];
  let currentLevel = [rootDir];

  for (let depth = 1; depth <= maxDepth && currentLevel.length > 0; depth++) {
    const nextLevel: string[] = [];
    for (const dir of currentLevel) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 読めないディレクトリはスキップ(権限不足等)
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === "pom.xml") {
          manifests.push(path.relative(rootDir, path.join(dir, entry.name)));
          if (manifests.length >= MAX_MANIFESTS) return manifests;
        } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
          // isDirectory()はシンボリックリンクに対してfalseを返すため、リンクは自然に除外される
          nextLevel.push(path.join(dir, entry.name));
        }
      }
    }
    currentLevel = nextLevel;
  }
  return manifests;
}

/**
 * 入力パスを検証し、スキャン対象のMavenプロジェクトとして解決する。
 * ディレクトリまたはpom.xmlファイルのパスを受け付ける。
 */
export async function detectJavaProject(
  inputPath: string,
  options: DetectJavaProjectOptions = {},
): Promise<DetectedJavaProject> {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new ScanToolError("project_not_found", "スキャン対象のパスが指定されていません");
  }

  const resolved = await resolveExistingPath(inputPath);
  const stats = await stat(resolved);

  let projectDir: string;
  if (stats.isDirectory()) {
    projectDir = resolved;
  } else if (stats.isFile() && path.basename(resolved) === "pom.xml") {
    projectDir = path.dirname(resolved);
  } else {
    throw new ScanToolError(
      "project_not_found",
      `指定されたパスはディレクトリでもpom.xmlでもありません: ${inputPath}`,
    );
  }

  if (options.allowedRoot !== undefined) {
    assertInsideAllowedRoot(projectDir, await resolveExistingPath(options.allowedRoot));
  }

  const manifests = await findPomFiles(projectDir, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  if (manifests.length === 0) {
    throw new ScanToolError(
      "no_pom_found",
      `pom.xmlが見つかりません(深さ${options.maxDepth ?? DEFAULT_MAX_DEPTH}まで探索): ${projectDir}。MVPではMavenプロジェクトのみ対応しています`,
    );
  }

  return { projectDir, manifests };
}
