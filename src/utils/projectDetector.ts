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
 * - マニフェスト探索はエントリ数・件数・深さに上限を設け、シンボリックリンクのディレクトリは辿らない
 *
 * 検出したマニフェストが、そのままOSV-Scannerのスキャン範囲になる(ディレクトリは渡さない)。
 * そのため探索を深さで打ち切らず(Javaのソースツリーは深い)、上限に達した場合は
 * 結果を黙って欠落させずにエラーにする。
 */

import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";

export interface DetectedJavaProject {
  /** シンボリックリンク解決済みの絶対パス。OSV-Scannerにはこれを渡す */
  projectDir: string;
  /** projectDirからの相対パスで表したマニフェスト(pom.xml / gradle.lockfile)の一覧 */
  manifests: string[];
  /** manifestsの絶対パス。OSV-Scannerにはこれだけを渡す(スキャン範囲=この一覧) */
  manifestPaths: string[];
}

export interface DetectJavaProjectOptions {
  /** 指定時、解決後のパスがこのディレクトリ配下でなければエラー */
  allowedRoot?: string;
  /** 探索の最大深さ(projectDir直下=1)。病的な入れ子への安全弁。デフォルト64 */
  maxDepth?: number;
  /** 探索するエントリ(ファイル・ディレクトリ)の総数の上限。デフォルト200,000 */
  maxEntries?: number;
  /** マニフェスト件数の上限。デフォルト1,000 */
  maxManifests?: number;
}

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_MANIFESTS = 1_000;
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

interface SearchLimits {
  maxDepth: number;
  maxEntries: number;
  maxManifests: number;
}

function searchLimitError(reason: string): ScanToolError {
  return new ScanToolError(
    "manifest_search_limit_exceeded",
    `マニフェスト探索が上限(${reason})に達したため、スキャンを中止しました。` +
      "結果の欠落を避けるため途中までの結果は返しません。より狭いディレクトリ、またはpom.xml / gradle.lockfileを直接指定してください",
  );
}

/** 上限付きでマニフェストを探索する。シンボリックリンクは辿らない。上限到達はエラー。 */
async function findManifests(rootDir: string, limits: SearchLimits): Promise<ManifestSearchResult> {
  const manifests: string[] = [];
  let gradleBuildFileFound = false;
  let visited = 0;
  let currentLevel = [rootDir];

  for (let depth = 1; currentLevel.length > 0; depth++) {
    if (depth > limits.maxDepth) throw searchLimitError(`深さ${limits.maxDepth}`);
    const nextLevel: string[] = [];
    for (const dir of currentLevel) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue; // 読めないディレクトリはスキップ(権限不足等)
      }
      for (const entry of entries) {
        if (++visited > limits.maxEntries) throw searchLimitError(`${limits.maxEntries}エントリ`);
        if (entry.isFile() && MANIFEST_FILENAMES.has(entry.name)) {
          if (manifests.length >= limits.maxManifests) throw searchLimitError(`マニフェスト${limits.maxManifests}件`);
          manifests.push(path.relative(rootDir, path.join(dir, entry.name)));
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

  // マニフェストの直接指定は、そのファイル1件だけをスキャン範囲にする。
  // 親ディレクトリを探索しないため、探索上限エラーの回避手段として使える
  if (stats.isFile() && MANIFEST_FILENAMES.has(path.basename(resolved))) {
    const projectDir = path.dirname(resolved);
    if (options.allowedRoot !== undefined) {
      assertInsideAllowedRoot(projectDir, await resolveExistingPath(options.allowedRoot));
    }
    return { projectDir, manifests: [path.basename(resolved)], manifestPaths: [resolved] };
  }

  let projectDir: string;
  if (stats.isDirectory()) {
    projectDir = resolved;
  } else if (stats.isFile() && GRADLE_BUILD_FILENAMES.has(path.basename(resolved))) {
    // build.gradle等の直接指定は、lockfileを探すためディレクトリとして解決する
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

  const { manifests, gradleBuildFileFound } = await findManifests(projectDir, {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxManifests: options.maxManifests ?? DEFAULT_MAX_MANIFESTS,
  });
  if (manifests.length === 0) {
    if (gradleBuildFileFound) {
      throw new ScanToolError("gradle_lockfile_missing", GRADLE_LOCKFILE_GUIDANCE);
    }
    throw new ScanToolError(
      "no_manifest_found",
      `対応マニフェスト(pom.xml / gradle.lockfile)が見つかりません: ${projectDir}`,
    );
  }

  return {
    projectDir,
    manifests,
    manifestPaths: manifests.map((manifest) => path.join(projectDir, manifest)),
  };
}
