import { buildArtifactReport } from "../osv/artifactReport.js";
import { runOsvArtifactScan, type RunOsvScanOptions } from "../osv/runner.js";
import { detectJavaArtifacts, type DetectJavaArtifactsOptions } from "../utils/artifactDetector.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export interface ScanJavaArtifactArgs { artifact_path: string }
export interface ScanJavaArtifactOptions extends RunOsvScanOptions, DetectJavaArtifactsOptions {}

export async function handleScanJavaArtifact(
  args: ScanJavaArtifactArgs,
  options: ScanJavaArtifactOptions = {},
): Promise<ToolResult> {
  try {
    const { artifactPaths } = await detectJavaArtifacts(args.artifact_path, options);
    const raw = await runOsvArtifactScan(artifactPaths, options);
    return jsonResult(buildArtifactReport(raw, artifactPaths));
  } catch (error) {
    return errorResult(error);
  }
}
