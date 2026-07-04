/**
 * `scan_java_project`ツールのハンドラ。
 * レスポンス形式(成功/エラー)は`toolResult.ts`参照。
 */

import { runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { detectJavaProject } from "../utils/projectDetector.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

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
    const report = await runOsvScan(project.projectDir, options);
    return jsonResult({
      project_dir: project.projectDir,
      manifests: project.manifests,
      ...report,
    });
  } catch (error) {
    return errorResult(error);
  }
}
