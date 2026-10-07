/**
 * `scan_project`ツールのハンドラ: Java / JavaScript / Python / Goのlockfileをまとめてスキャンする。
 *
 * 誤要約対策(JAR実体スキャンと同じ原則): スキャンできなかった依存を示すcoverageを件数より前に置き、
 * complete=falseの場合は「検出0件でも安全とは言えない」旨の警告を付ける。
 */

import path from "node:path";
import { ScanToolError } from "../errors.js";
import { isRemoteResolutionDisabled, runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { parseOsvScanOutput, type ScanReport, type ScanReportPackage } from "../osv/scanReport.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { detectProject, type DetectedProject } from "../utils/manifestDetector.js";
import { normalizePypiName } from "../utils/requirementsFile.js";
import { ScanSnapshot, snapshotManifests } from "../utils/scanSnapshot.js";
import { dependencyResolution, withScopeNotes, type ScanJavaProjectArgs, type ScanJavaProjectOptions } from "./scanJavaProject.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export const TRANSITIVE_OMITTED_WARNING =
  "OSV_MCP_NO_REMOTE_RESOLUTIONの設定により、マニフェスト(pom.xml / requirements.txt)からの推移的依存の解決を省略しています。" +
  "lockfile(package-lock.json / poetry.lock / go.mod / gradle.lockfile等)に記録された依存は対象ですが、" +
  "pom.xml・requirements.txtに直接記載された依存の先にある推移的依存の脆弱性は含まれません。" +
  "検出0件でも推移的依存の安全性は確認できていません";

const INCOMPLETE_WARNING =
  "一部の依存はスキャンされていないか、版を推測してスキャンしています" +
  "(lockfile_missing / unpinned_requirements / unscannable_requirements / skipped_filesを参照)。" +
  "検出0件でも、それらの依存の安全性は確認できていません";

/** coverageの各一覧の上限(巨大なrequirements.txtで応答を膨らませない) */
const MAX_COVERAGE_ITEMS = 200;

function capped<T>(items: readonly T[]): { items: T[]; omitted: number } {
  return { items: items.slice(0, MAX_COVERAGE_ITEMS), omitted: Math.max(0, items.length - MAX_COVERAGE_ITEMS) };
}

export function buildCoverage(project: DetectedProject) {
  const rel = (file: string) => sanitizeExternalText(path.relative(project.projectDir, file));
  const lockfileMissing = capped(project.lockfileMissing);
  const unpinned = capped(project.requirementIssues);
  const unscannable = capped(project.requirementReferences);
  const skipped = capped(project.skippedFiles);
  const complete =
    project.lockfileMissing.length === 0 &&
    project.requirementIssues.length === 0 &&
    project.requirementReferences.length === 0 &&
    project.skippedFiles.length === 0;
  const omitted = lockfileMissing.omitted + unpinned.omitted + unscannable.omitted + skipped.omitted;
  return {
    complete,
    ...(complete ? {} : { warning: INCOMPLETE_WARNING }),
    manifests: project.manifests.map((m) => ({ path: sanitizeExternalText(m.path), ecosystem: m.ecosystem, format: m.format })),
    lockfile_missing: lockfileMissing.items.map((m) => ({
      path: sanitizeExternalText(m.path),
      ecosystem: m.ecosystem,
      status: m.status,
      hint: sanitizeExternalText(m.hint),
    })),
    unpinned_requirements: unpinned.items.map((issue) => ({
      file: rel(issue.file),
      line: issue.line,
      name: sanitizeExternalText(issue.name),
      specifier: sanitizeExternalText(issue.specifier),
      kind: issue.kind,
    })),
    unscannable_requirements: unscannable.items.map((ref) => ({
      file: rel(ref.file),
      line: ref.line,
      text: sanitizeExternalText(ref.text),
      reason: ref.reason,
    })),
    skipped_files: skipped.items.map((s) => ({ path: sanitizeExternalText(s.path), reason: sanitizeExternalText(s.reason) })),
    ...(omitted > 0 ? { omitted_items: omitted } : {}),
  };
}

function ecosystemBreakdown(project: DetectedProject, packages: readonly ScanReportPackage[]) {
  const breakdown: Record<string, { manifests: number; vulnerable_package_count: number; vulnerability_count: number }> = {};
  for (const manifest of project.manifests) {
    breakdown[manifest.ecosystem] ??= { manifests: 0, vulnerable_package_count: 0, vulnerability_count: 0 };
    breakdown[manifest.ecosystem]!.manifests++;
  }
  for (const pkg of packages) {
    breakdown[pkg.ecosystem] ??= { manifests: 0, vulnerable_package_count: 0, vulnerability_count: 0 };
    breakdown[pkg.ecosystem]!.vulnerable_package_count++;
    breakdown[pkg.ecosystem]!.vulnerability_count += pkg.vulnerabilities.length;
  }
  return breakdown;
}

/** `>=X` / `~=X` の行は、osv-scannerが下限Xを使用中の版とみなしてスキャンしている */
export function markLowerBounds(project: DetectedProject, packages: readonly ScanReportPackage[]): ScanReportPackage[] {
  return packages.map((pkg) =>
    pkg.ecosystem === "PyPI" &&
    project.lowerBounds.some((lb) => lb.name === normalizePypiName(pkg.name) && lb.version === pkg.version)
      ? { ...pkg, version_is_lower_bound: true as const }
      : pkg,
  );
}

/**
 * 元のファイルはosv-scannerに渡さず、スナップショット(scanSnapshot.ts)のコピーをスキャンする。
 * lockfile・pom.xml(親POMの連鎖を含む)は安全に読んだ内容のコピー、requirements.txtは
 * 検証済みの正規化行だけを書いたコピー。コピーできず外したファイルはskippedFilesに記録する。
 * スナップショットは成功・失敗とも削除する。suggest_fixも同じスキャンを使う。
 */
export async function scanFromSnapshot(project: DetectedProject, options: RunOsvScanOptions): Promise<ScanReport> {
  const snapshot = await ScanSnapshot.create();
  try {
    const { targets, skipped, incomplete } = await snapshotManifests(snapshot, project.targets, {
      projectDir: project.projectDir,
      allowedRootReal: project.allowedRootReal,
    });
    // 親POMを再現できずにスキャンしたpom.xmlも、欠落の可能性としてcoverageに出す(complete=falseになる)
    project.skippedFiles.push(...incomplete.map((s) => ({ path: path.relative(project.projectDir, s.path), reason: s.reason })));
    if (skipped.length > 0) {
      const skippedPaths = new Set(skipped.map((s) => s.path));
      project.manifests = project.manifests.filter((m) => !skippedPaths.has(path.join(project.projectDir, m.path)));
      project.skippedFiles.push(...skipped.map((s) => ({ path: path.relative(project.projectDir, s.path), reason: s.reason })));
      if (project.manifests.length === 0) {
        throw new ScanToolError(
          skipped.every((s) => s.kind === "outside_allowed_root") ? "path_outside_allowed_root" : "no_manifest_found",
          `スキャンできるlockfile・マニフェストがありません(${project.skippedFiles.map((s) => `${s.path}: ${s.reason}`).join(" / ")})`,
        );
      }
    }
    for (const copy of project.requirementsCopies) {
      if (copy.entries.length === 0) continue;
      targets.push({ path: await snapshot.writeGenerated(`${copy.entries.join("\n")}\n`), format: "requirements.txt" });
    }
    if (targets.length === 0) return parseOsvScanOutput({ results: [] });
    return await withScopeNotes(project.skippedFiles, () => snapshot.guard(() => runOsvScan(targets, options)));
  } finally {
    await snapshot.cleanup();
  }
}

export async function handleScanProject(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectProject(args.project_path, { allowedRoot: options.allowedRoot });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const report = await scanFromSnapshot(project, { ...options, noRemoteResolution });
    return jsonResult({
      project_dir: project.projectDir,
      dependency_resolution: dependencyResolution(noRemoteResolution, TRANSITIVE_OMITTED_WARNING),
      coverage: buildCoverage(project),
      ecosystem_breakdown: ecosystemBreakdown(project, report.packages),
      vulnerable_package_count: report.vulnerable_package_count,
      vulnerability_count: report.vulnerability_count,
      severity_breakdown: report.severity_breakdown,
      packages: markLowerBounds(project, report.packages),
    });
  } catch (error) {
    return errorResult(error);
  }
}
