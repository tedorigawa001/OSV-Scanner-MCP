/**
 * `scan_java_project`ツールのハンドラ。
 * レスポンス形式(成功/エラー)は`toolResult.ts`参照。
 */

import { isRemoteResolutionDisabled, runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { detectJavaProject } from "../utils/projectDetector.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

const TRANSITIVE_OMITTED_WARNING =
  "OSV_MCP_NO_REMOTE_RESOLUTIONの設定により、マニフェスト(pom.xml)からの推移的依存の解決を省略しています。" +
  "lockfile(gradle.lockfile)に記録された依存は対象ですが、pom.xmlに直接記載された依存の先にある推移的依存の脆弱性は含まれません。" +
  "検出0件でも推移的依存の安全性は確認できていません";

/**
 * 推移的依存の解決状態。無効時に「検出0件」を安全と誤読されないよう応答の先頭付近に置く。
 * マニフェスト一覧の探索深さはosv-scannerの`-r`と一致しないため、一覧からpom.xmlの有無を
 * 判定せず、無効時は条件付きの警告を常に返す。
 */
export function dependencyResolution(noRemoteResolution: boolean) {
  return noRemoteResolution
    ? { transitive_resolution: "disabled" as const, warning: TRANSITIVE_OMITTED_WARNING }
    : { transitive_resolution: "enabled" as const };
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
    const report = await runOsvScan(project.manifestPaths, { ...options, noRemoteResolution });
    return jsonResult({
      project_dir: project.projectDir,
      manifests: project.manifests,
      dependency_resolution: dependencyResolution(noRemoteResolution),
      ...report,
    });
  } catch (error) {
    return errorResult(error);
  }
}
