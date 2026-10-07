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
 * - 走査は上限付きで、シンボリックリンクのディレクトリは辿らない(projectWalk.ts)
 *
 * 検出したマニフェストが、そのままOSV-Scannerのスキャン範囲になる(ディレクトリは渡さない)。
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { ScanToolError } from "../errors.js";
import type { ManifestFormat, ManifestTarget } from "./manifestFormats.js";
import {
  assertInsideAllowedRoot,
  resolveExistingPath,
  walkProjectFiles,
  type SearchLimitOptions,
} from "./projectWalk.js";

export interface DetectedJavaProject {
  /** シンボリックリンク解決済みの絶対パス */
  projectDir: string;
  /** projectDirからの相対パスで表したマニフェスト(pom.xml / gradle.lockfile)の一覧 */
  manifests: string[];
  /** スキャン対象の元のファイル。osv-scannerにはスナップショット(scanSnapshot.ts)のコピーを渡す */
  targets: ManifestTarget[];
  /** 解決済みの許可ルート(未設定ならundefined)。親POMの検証に使う */
  allowedRootReal: string | undefined;
}

export interface DetectJavaProjectOptions extends SearchLimitOptions {
  /** 指定時、解決後のパスがこのディレクトリ配下でなければエラー */
  allowedRoot?: string;
}

/** ビルド成果物・VCS等、マニフェスト探索でスキップするディレクトリ */
const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "build", ".idea", ".vscode"]);

/** OSV-Scannerがスキャンできるマニフェスト(実機確認済み)。ファイル名がそのまま解析形式になる */
const MANIFEST_FILENAMES: ReadonlySet<string> = new Set<ManifestFormat>([
  "pom.xml",
  "gradle.lockfile",
  "buildscript-gradle.lockfile",
]);

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

function buildResult(
  projectDir: string,
  manifests: string[],
  allowedRootReal: string | undefined,
): DetectedJavaProject {
  const targets = manifests.map((manifest) => ({
    path: path.join(projectDir, manifest),
    format: path.basename(manifest) as ManifestFormat,
  }));
  return { projectDir, manifests, targets, allowedRootReal };
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
    const allowedRootReal = options.allowedRoot !== undefined ? await resolveExistingPath(options.allowedRoot) : undefined;
    if (allowedRootReal !== undefined) assertInsideAllowedRoot(projectDir, allowedRootReal);
    return buildResult(projectDir, [path.basename(resolved)], allowedRootReal);
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

  const allowedRootReal = options.allowedRoot !== undefined ? await resolveExistingPath(options.allowedRoot) : undefined;
  if (allowedRootReal !== undefined) assertInsideAllowedRoot(projectDir, allowedRootReal);

  const manifests: string[] = [];
  let gradleBuildFileFound = false;
  await walkProjectFiles(projectDir, options, SKIPPED_DIRS, (relativePath, name) => {
    if (MANIFEST_FILENAMES.has(name)) {
      manifests.push(relativePath);
      return true;
    }
    if (GRADLE_BUILD_FILENAMES.has(name)) gradleBuildFileFound = true;
    return false;
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

  return buildResult(projectDir, manifests, allowedRootReal);
}
