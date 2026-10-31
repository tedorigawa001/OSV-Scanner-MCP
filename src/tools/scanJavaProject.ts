/**
 * `scan_java_project`ツールのハンドラ。
 * レスポンス形式(成功/エラー)は`toolResult.ts`参照。
 */

import path from "node:path";
import { GradleGraphCache, type GradleMetadata } from "../utils/gradleGraphCache.js";
import { annotateRelations, buildRelationLookups } from "./scanProject.js";
import { ScanToolError } from "../errors.js";
import { isRemoteResolutionDisabled, runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import type { ScanReport } from "../osv/scanReport.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { detectJavaProject, type DetectedJavaProject } from "../utils/projectDetector.js";
import { ScanSnapshot, snapshotManifests } from "../utils/scanSnapshot.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

const TRANSITIVE_OMITTED_WARNING =
  "Because OSV_MCP_NO_REMOTE_RESOLUTION is set, transitive dependencies of manifests (pom.xml) were not resolved. " +
  "Dependencies recorded in lockfiles (gradle.lockfile) are covered, but vulnerabilities in the transitive dependencies of the dependencies listed directly in pom.xml are not included. " +
  "Zero findings does not confirm that the transitive dependencies are safe";

/**
 * 推移的依存の解決状態。無効時に「検出0件」を安全と誤読されないよう応答の先頭付近に置く。
 * 無効時は、どのマニフェストを含むかに依らず条件付きの警告を常に返す。
 */
export function dependencyResolution(noRemoteResolution: boolean, warning = TRANSITIVE_OMITTED_WARNING) {
  return noRemoteResolution
    ? { transitive_resolution: "disabled" as const, warning }
    : { transitive_resolution: "enabled" as const };
}

const SKIPPED_MANIFESTS_WARNING =
  "Some manifests were excluded from the scan, or scanned without their parent POM (see skipped_manifests / incomplete_manifests). " +
  "Vulnerabilities in those dependencies are not included, so do not conclude that the project is safe even with zero findings";

type ManifestNote = { path: string; reason: string };

/**
 * 外したマニフェスト(skipped)と、親POMを再現できずにスキャンしたマニフェスト(incomplete)。
 * どちらも無ければ何も出力しない(既存の出力を変えない)。件数より前に置き、検出0件を安全と誤読させない
 */
export function skippedManifestsFields(skipped: readonly ManifestNote[], incomplete: readonly ManifestNote[] = []) {
  if (skipped.length === 0 && incomplete.length === 0) return {};
  const list = (items: readonly ManifestNote[]) =>
    items.map((s) => ({ path: sanitizeExternalText(s.path), reason: sanitizeExternalText(s.reason) }));
  return {
    ...(skipped.length > 0 ? { skipped_manifests: list(skipped) } : {}),
    ...(incomplete.length > 0 ? { incomplete_manifests: list(incomplete) } : {}),
    scope_warning: SKIPPED_MANIFESTS_WARNING,
  };
}

/**
 * スキャン対象を外した・親POMを含めずにスキャンしたマニフェストがある状態で「パッケージなし」になった場合、
 * エラーにもその旨を含める(応答の一覧が出ないため、欠落を黙って「依存なし」と読ませない)。
 */
export async function withScopeNotes<T>(notes: readonly ManifestNote[], scan: () => Promise<T>): Promise<T> {
  try {
    return await scan();
  } catch (error) {
    if (!(error instanceof ScanToolError) || error.kind !== "no_packages_found" || notes.length === 0) throw error;
    throw new ScanToolError(
      error.kind,
      `${error.message}. However, the following manifests were excluded from the scan or scanned without their parent POM, ` +
        `so do not conclude that the project is safe: ${notes.map((n) => `${n.path}: ${n.reason}`).join(" / ")}`,
      error.detail,
    );
  }
}

/**
 * 検出したマニフェストをスナップショットへコピーし、コピーをスキャンする(元のファイルは渡さない)。
 * 応答に一時ディレクトリのパスを出さないよう、スキャナーのパスは元のファイルに戻す。
 * スナップショットは成功・失敗とも削除する。全件除外ならエラー。
 */
export async function scanJavaManifests(
  project: DetectedJavaProject,
  options: RunOsvScanOptions,
): Promise<{ manifests: string[]; skipped: ManifestNote[]; incomplete: ManifestNote[]; report: ScanReport; gradleMetadata: GradleMetadata[]; gradleIncomplete: ManifestNote[] }> {
  const snapshot = await ScanSnapshot.create();
  try {
    const { targets, skipped, incomplete } = await snapshotManifests(snapshot, project.targets, {
      projectDir: project.projectDir,
      allowedRootReal: project.allowedRootReal,
    });
    const skippedPaths = new Set(skipped.map((s) => s.path));
    const scanned = project.targets.filter((t) => !skippedPaths.has(t.path));
    const relative = (file: string) => path.relative(project.projectDir, file);
    const skippedRelative = skipped.map((s) => ({ path: relative(s.path), reason: s.reason }));
    if (targets.length === 0) {
      const details = skippedRelative.map((s) => `${s.path}: ${s.reason}`).join(" / ");
      throw new ScanToolError(
        skipped.every((s) => s.kind === "outside_allowed_root") ? "path_outside_allowed_root" : "no_manifest_found",
        `No manifest can be scanned (${details})`,
      );
    }
    const originals = new Map(targets.map((copy, i) => [copy.path, scanned[i]!.path]));
    const incompleteRelative = incomplete.map((s) => ({ path: relative(s.path), reason: s.reason }));
    const cache = new GradleGraphCache(project.projectDir);
    const gradleMetadata: GradleMetadata[] = [], gradleIncomplete: ManifestNote[] = [];
    const sources = targets.map((copy, i) => ({ copy: copy.path, format: copy.format, originalRelative: relative(scanned[i]!.path), gradleLookup: null as import("../utils/dependencyRelations.js").RelationLookup }));
    for (const source of sources) {
      if (source.format !== "gradle.lockfile" && source.format !== "buildscript-gradle.lockfile") continue;
      const capture = await cache.captureCopy(path.join(project.projectDir, source.originalRelative), source.copy);
      source.gradleLookup = capture.lookup; gradleMetadata.push(capture.metadata);
      gradleIncomplete.push(...capture.coverageReasons.map(reason => ({ path: source.originalRelative, reason: `Gradle graph: ${reason}` })));
    }
    const report = await withScopeNotes([...skippedRelative, ...incompleteRelative, ...gradleIncomplete], () => snapshot.guard(() => runOsvScan(targets, options)));
    return {
      gradleMetadata, gradleIncomplete,
      manifests: scanned.map((t) => relative(t.path)),
      skipped: skippedRelative,
      incomplete: incompleteRelative,
      report: { ...report, packages: annotateRelations(report.packages, await buildRelationLookups(sources)), source_files: report.source_files.map((file) => originals.get(file) ?? file) },
    };
  } finally {
    await snapshot.cleanup();
  }
}

export type { ToolResult } from "./toolResult.js";

export interface ScanJavaProjectArgs {
  /** スキャン対象のディレクトリまたはpom.xmlのパス */
  project_path: string;
}

export interface ScanJavaProjectOptions extends RunOsvScanOptions {
  /** 指定時、このディレクトリ配下以外のスキャンを拒否する */
  allowedRoot?: string;
}

export async function handleScanJavaProject(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectJavaProject(args.project_path, {
      allowedRoot: options.allowedRoot,
    });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const { manifests, skipped, incomplete, report, gradleMetadata, gradleIncomplete } = await scanJavaManifests(project, { ...options, noRemoteResolution });
    return jsonResult({
      project_dir: project.projectDir,
      manifests,
      ...skippedManifestsFields(skipped, [...incomplete, ...gradleIncomplete]),
      ...(gradleMetadata.length ? { coverage: {
        complete: skipped.length === 0 && incomplete.length === 0 && gradleIncomplete.length === 0,
        dependency_metadata: { gradle: gradleMetadata }, skipped_files: [...skipped, ...incomplete, ...gradleIncomplete].map(note => ({ path: sanitizeExternalText(note.path), reason: sanitizeExternalText(note.reason) })),
      } } : {}),
      dependency_resolution: dependencyResolution(noRemoteResolution),
      ...report,
    });
  } catch (error) {
    return errorResult(error);
  }
}
