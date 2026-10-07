/**
 * `scan_java_project`ツールのハンドラ。
 * レスポンス形式(成功/エラー)は`toolResult.ts`参照。
 */

import { isRemoteResolutionDisabled, runOsvScan, type RunOsvScanOptions } from "../osv/runner.js";
import { sanitizeExternalText } from "../utils/externalText.js";
import { detectJavaProject } from "../utils/projectDetector.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

const TRANSITIVE_OMITTED_WARNING =
  "OSV_MCP_NO_REMOTE_RESOLUTIONの設定により、マニフェスト(pom.xml)からの推移的依存の解決を省略しています。" +
  "lockfile(gradle.lockfile)に記録された依存は対象ですが、pom.xmlに直接記載された依存の先にある推移的依存の脆弱性は含まれません。" +
  "検出0件でも推移的依存の安全性は確認できていません";

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
  "一部のマニフェストをスキャン対象から外しました(skipped_manifestsを参照)。" +
  "それらの依存の脆弱性は結果に含まれないため、検出0件でも安全とは判断しないでください";

/**
 * 親POMが許可ルートの外を参照するため外したマニフェスト。外したものが無ければ何も出力しない
 * (既存の出力を変えない)。件数より前に置き、検出0件を安全と誤読させない
 */
export function skippedManifestsFields(skipped: readonly { path: string; reason: string }[]) {
  if (skipped.length === 0) return {};
  return {
    skipped_manifests: skipped.map((s) => ({ path: sanitizeExternalText(s.path), reason: sanitizeExternalText(s.reason) })),
    scope_warning: SKIPPED_MANIFESTS_WARNING,
  };
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
    const report = await runOsvScan(project.targets, { ...options, noRemoteResolution });
    return jsonResult({
      project_dir: project.projectDir,
      manifests: project.manifests,
      ...skippedManifestsFields(project.skipped),
      dependency_resolution: dependencyResolution(noRemoteResolution),
      ...report,
    });
  } catch (error) {
    return errorResult(error);
  }
}
