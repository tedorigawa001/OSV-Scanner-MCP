/**
 * スキャン対象パスの検証とJavaプロジェクト(Maven / Gradle)の検出。
 *
 * 対応マニフェスト:
 * - Maven: pom.xml
 * - Gradle: gradle.lockfile / buildscript-gradle.lockfile(lockfile方式)
 *   ビルド実行方式(gradle dependencies)はbuild.gradle自体が任意コードとして
 *   実行されるため採用しない(docs/DESIGN_TODO.md参照)。lockfileが無い場合は
 *   生成手順を案内する専用エラー(gradle_lockfile_missing)を返す
 *
 * `project_path`はLLM・ユーザー由来の信頼できない入力として扱う:
 * - `realpath`で正規化し、シンボリックリンクを解決した実体パスで判定する
 * - `allowedRoot`指定時は、解決後のパスがその配下にあることを検証する(パストラバーサル対策)
 * - マニフェスト探索は深さ・件数に上限を設け、シンボリックリンクのディレクトリは辿らない
 */

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";

export interface DetectedJavaProject {
  /** シンボリックリンク解決済みの絶対パス。OSV-Scannerにはこれを渡す */
  projectDir: string;
  /** projectDirからの相対パスで表したマニフェスト(pom.xml / gradle.lockfile)の一覧 */
  manifests: string[];
}

export interface DetectJavaProjectOptions {
  /** 指定時、解決後のパスがこのディレクトリ配下でなければエラー */
  allowedRoot?: string;
  /** マニフェスト探索の最大深さ(projectDir直下=1)。デフォルト3 */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 3;
/** 探索を打ち切るマニフェスト件数の上限(巨大モノレポでの暴走防止) */
const MAX_MANIFESTS = 100;
/** ビルド成果物・VCS等、マニフェスト探索でスキップするディレクトリ */
const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "build", ".idea", ".vscode"]);

/** OSV-Scannerがスキャンできるマニフェスト(実機確認済み) */
const MANIFEST_FILENAMES = new Set(["pom.xml", "gradle.lockfile", "buildscript-gradle.lockfile"]);

/** Gradleプロジェクトの存在を示すが、それ自体はスキャンできないビルドファイル */
const GRADLE_BUILD_FILENAMES = new Set([
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);

const GRADLE_LOCKFILE_GUIDANCE =
  "Gradleプロジェクトを検出しましたが、gradle.lockfileがありません。" +
  "本ツールはlockfile方式のみ対応しています(ビルド実行方式はbuild.gradleの任意コード実行を伴うため非対応)。" +
  "`./gradlew dependencies --write-locks` でlockfileを生成してから再実行してください" +
  "(依存ロックが未設定の場合は build.gradle に dependencyLocking { lockAllConfigurations() } の追加が必要です)";

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

interface ManifestSearchResult {
  manifests: string[];
  /** lockfileの有無に関わらず、Gradleビルドファイルを見つけたか */
  gradleBuildFileFound: boolean;
}

/** 深さ・件数上限付きでマニフェストを探索する。シンボリックリンクは辿らない。 */
async function findManifests(rootDir: string, maxDepth: number): Promise<ManifestSearchResult> {
  const manifests: string[] = [];
  let gradleBuildFileFound = false;
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
        if (entry.isFile() && MANIFEST_FILENAMES.has(entry.name)) {
          manifests.push(path.relative(rootDir, path.join(dir, entry.name)));
          if (manifests.length >= MAX_MANIFESTS) return { manifests, gradleBuildFileFound };
        } else if (entry.isFile() && GRADLE_BUILD_FILENAMES.has(entry.name)) {
          gradleBuildFileFound = true;
        } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
          // isDirectory()はシンボリックリンクに対してfalseを返すため、リンクは自然に除外される
          nextLevel.push(path.join(dir, entry.name));
        }
      }
    }
    currentLevel = nextLevel;
  }
  return { manifests, gradleBuildFileFound };
}

/**
 * 入力パスを検証し、スキャン対象のJavaプロジェクトとして解決する。
 * ディレクトリ、またはマニフェスト(pom.xml / gradle.lockfile)・
 * Gradleビルドファイルのパスを受け付ける。
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
  } else if (
    stats.isFile() &&
    (MANIFEST_FILENAMES.has(path.basename(resolved)) ||
      GRADLE_BUILD_FILENAMES.has(path.basename(resolved)))
  ) {
    // build.gradle等の直接指定も受け付け、ディレクトリとして解決する
    // (lockfileが無ければ後段でgradle_lockfile_missingの案内になる)
    projectDir = path.dirname(resolved);
  } else {
    throw new ScanToolError(
      "project_not_found",
      `指定されたパスはディレクトリでも対応マニフェスト(pom.xml / gradle.lockfile)でもありません: ${inputPath}`,
    );
  }

  if (options.allowedRoot !== undefined) {
    assertInsideAllowedRoot(projectDir, await resolveExistingPath(options.allowedRoot));
  }

  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const { manifests, gradleBuildFileFound } = await findManifests(projectDir, maxDepth);
  if (manifests.length === 0) {
    if (gradleBuildFileFound) {
      throw new ScanToolError("gradle_lockfile_missing", GRADLE_LOCKFILE_GUIDANCE);
    }
    throw new ScanToolError(
      "no_manifest_found",
      `対応マニフェスト(pom.xml / gradle.lockfile)が見つかりません(深さ${maxDepth}まで探索): ${projectDir}`,
    );
  }

  return { projectDir, manifests };
}
