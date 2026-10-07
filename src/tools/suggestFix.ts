/**
 * `suggest_fix`ツールのハンドラ。
 * scan_projectと同じ検出・スキャンを実行し、脆弱なパッケージごとの
 * 推奨アップグレードバージョン(3段階Tier)を返す。推奨はMaven・npm・Goに対応し、
 * それ以外(PyPI等)はunsupported_ecosystemとして返す。
 */

import { isRemoteResolutionDisabled } from "../osv/runner.js";
import { suggestUpgrades } from "../osv/suggestFix.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { detectProject } from "../utils/manifestDetector.js";
import {
  dependencyResolution,
  type ScanJavaProjectArgs,
  type ScanJavaProjectOptions,
} from "./scanJavaProject.js";
import { buildCoverage, scanFromSnapshot, TRANSITIVE_OMITTED_WARNING } from "./scanProject.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export async function handleSuggestFix(
  args: ScanJavaProjectArgs,
  options: ScanJavaProjectOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectProject(args.project_path, { allowedRoot: options.allowedRoot });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const report = await scanFromSnapshot(project, { ...options, noRemoteResolution });
    const suggestions = suggestUpgrades(report.packages);
    const unfixedVulnerabilities = suggestions.reduce(
      (sum, s) => sum + s.per_cve_detail.filter((d) => d.tier === "unfixed").length,
      0,
    );
    return jsonResult({
      project_dir: project.projectDir,
      manifests: project.manifests.map((m) => sanitizeExternalText(m.path)),
      dependency_resolution: dependencyResolution(noRemoteResolution, TRANSITIVE_OMITTED_WARNING),
      coverage: buildCoverage(project),
      vulnerable_package_count: suggestions.length,
      unfixed_vulnerability_count: unfixedVulnerabilities,
      suggestions,
    });
  } catch (error) {
    return errorResult(error);
  }
}
