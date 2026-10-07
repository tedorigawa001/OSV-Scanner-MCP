/**
 * `scan_project`ツールのハンドラ: Java / JavaScript / Python / Goのlockfileをまとめてスキャンする。
 *
 * 誤要約対策(JAR実体スキャンと同じ原則): スキャンできなかった依存を示すcoverageを件数より前に置き、
 * complete=falseの場合は「検出0件でも安全とは言えない」旨の警告を付ける。
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRemoteResolutionDisabled, runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { parseOsvScanOutput, type ScanReport, type ScanReportPackage } from "../osv/scanReport.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import type { ManifestTarget } from "../utils/manifestFormats.js";
import { detectProject, type DetectedProject } from "../utils/manifestDetector.js";
import { normalizePypiName } from "../utils/requirementsFile.js";
import { dependencyResolution, type ScanJavaProjectArgs, type ScanJavaProjectOptions } from "./scanJavaProject.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

const TRANSITIVE_OMITTED_WARNING =
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

function buildCoverage(project: DetectedProject) {
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
function markLowerBounds(project: DetectedProject, packages: readonly ScanReportPackage[]) {
  return packages.map((pkg) =>
    pkg.ecosystem === "PyPI" &&
    project.lowerBounds.some((lb) => lb.name === normalizePypiName(pkg.name) && lb.version === pkg.version)
      ? { ...pkg, version_is_lower_bound: true }
      : pkg,
  );
}

/**
 * requirements.txtは検証済みの正規化行だけを専用の一時ディレクトリに書いてスキャンする
 * (元ファイルの取り込み指定をosv-scannerにたどらせない)。成功・失敗とも削除する。
 */
async function scanWithRequirementsCopies(
  project: DetectedProject,
  options: RunOsvScanOptions,
): Promise<ScanReport> {
  const copies = project.requirementsCopies.filter((copy) => copy.entries.length > 0);
  if (project.targets.length === 0 && copies.length === 0) return parseOsvScanOutput({ results: [] });
  const dir = copies.length > 0 ? await mkdtemp(path.join(await realpath(os.tmpdir()), "osv-mcp-req-")) : null;
  try {
    const targets: ManifestTarget[] = [...project.targets];
    for (const [index, copy] of copies.entries()) {
      const copyPath = path.join(dir!, `${index}.txt`);
      await writeFile(copyPath, `${copy.entries.join("\n")}\n`, { mode: 0o600, flag: "wx" });
      targets.push({ path: copyPath, format: "requirements.txt" });
    }
    return await runOsvScan(targets, options);
  } finally {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
  }
}

export async function handleScanProject(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectProject(args.project_path, { allowedRoot: options.allowedRoot });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const report = await scanWithRequirementsCopies(project, { ...options, noRemoteResolution });
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
