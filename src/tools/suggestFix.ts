/**
 * `suggest_fix`ツールのハンドラ。
 * scan_java_projectと同じスキャンを実行し、脆弱なパッケージごとの
 * 推奨アップグレードバージョン(3段階Tier)を返す。
 */

import { isRemoteResolutionDisabled } from "../osv/runner.js";
import { suggestUpgrades } from "../osv/suggestFix.js";
import { detectJavaProject } from "../utils/projectDetector.js";
import {
  dependencyResolution,
  scanJavaManifests,
  skippedManifestsFields,
  type ScanJavaProjectArgs,
  type ScanJavaProjectOptions,
} from "./scanJavaProject.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export async function handleSuggestFix(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectJavaProject(args.project_path, {
      allowedRoot: options.allowedRoot,
    });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const { manifests, skipped, report } = await scanJavaManifests(project, { ...options, noRemoteResolution });
    const suggestions = suggestUpgrades(report.packages);
    const unfixedVulnerabilities = suggestions.reduce(
      (sum, s) => sum + s.per_cve_detail.filter((d) => d.tier === "unfixed").length,
      0,
    );
    return jsonResult({
      project_dir: project.projectDir,
      manifests,
      ...skippedManifestsFields(skipped),
      dependency_resolution: dependencyResolution(noRemoteResolution),
      vulnerable_package_count: suggestions.length,
      unfixed_vulnerability_count: unfixedVulnerabilities,
      suggestions,
    });
  } catch (error) {
    return errorResult(error);
  }
}
