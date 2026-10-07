/**
 * `suggest_fix`ツールのハンドラ。
 * scan_projectと同じ検出・スキャンを実行し、脆弱なパッケージごとの
 * 推奨アップグレードバージョン(3段階Tier)を返す。推奨はMaven・npm・Go・PyPIに対応し、
 * それ以外はunsupported_ecosystemとして返す。
 */

import { isRemoteResolutionDisabled } from "../osv/runner.js";
import { candidateCheckDisabledFromEnv, checkRecommendedCandidates, type CandidateCheckOptions } from "../osv/candidateCheck.js";
import { suggestUpgrades } from "../osv/suggestFix.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { detectProject } from "../utils/manifestDetector.js";
import {
  dependencyResolution,
  type ScanJavaProjectArgs,
  type ScanJavaProjectOptions,
} from "./scanJavaProject.js";
import { buildCoverage, markLowerBounds, scanFromSnapshot, TRANSITIVE_OMITTED_WARNING } from "./scanProject.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export interface SuggestFixOptions extends ScanJavaProjectOptions {
  /** 推奨先のOSV照会。"disabled"で無効。省略時は環境変数OSV_MCP_NO_CANDIDATE_CHECKに従う */
  candidateCheck?: CandidateCheckOptions | "disabled";
}

export async function handleSuggestFix(
  args: ScanJavaProjectArgs,
  options: SuggestFixOptions = {},
): Promise<ToolResult> {
  try {
    const project = await detectProject(args.project_path, { allowedRoot: options.allowedRoot });
    const noRemoteResolution = isRemoteResolutionDisabled(options);
    const report = await scanFromSnapshot(project, { ...options, noRemoteResolution });
    const packages = markLowerBounds(project, report.packages);
    const candidateCheck = options.candidateCheck ?? (candidateCheckDisabledFromEnv() ? "disabled" : {});
    const suggestions = await checkRecommendedCandidates(packages, suggestUpgrades(packages), candidateCheck);
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
