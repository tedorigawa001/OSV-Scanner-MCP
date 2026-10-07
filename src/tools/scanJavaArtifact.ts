import { stat } from "node:fs/promises";
import path from "node:path";
import { buildArtifactReport } from "../osv/artifactReport.js";
import { runOsvArtifactScan, type RunOsvScanOptions } from "../osv/runner.js";
import { detectJavaArtifacts, type DetectJavaArtifactsOptions } from "../utils/artifactDetector.js";
import { ScanSnapshot } from "../utils/scanSnapshot.js";
import { asArray, asRecord } from "../utils/unknownJson.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export interface ScanJavaArtifactArgs { artifact_path: string }
export interface ScanJavaArtifactOptions extends RunOsvScanOptions, DetectJavaArtifactsOptions {}

/** スキャナーが返したパス(スナップショットのコピー)を元のファイルに戻す */
function restoreSourcePaths(raw: unknown, originals: ReadonlyMap<string, string>): unknown {
  for (const result of asArray(asRecord(raw)?.results)) {
    const source = asRecord(asRecord(result)?.source);
    if (source && typeof source.path === "string") {
      const original = originals.get(source.path);
      if (original !== undefined) source.path = original;
    }
  }
  return raw;
}

export async function handleScanJavaArtifact(
  args: ScanJavaArtifactArgs,
  options: ScanJavaArtifactOptions = {},
): Promise<ToolResult> {
  try {
    const { targetPath, artifactPaths } = await detectJavaArtifacts(args.artifact_path, options);
    const boundary = (await stat(targetPath)).isDirectory() ? targetPath : path.dirname(targetPath);
    // 元のJAR/WARは渡さず、安全に読んだ内容のコピーをスキャンする(検査後の差し替え対策)。
    // コピーできなかったものはスキャンされず、同定不能として報告される
    const snapshot = await ScanSnapshot.create();
    try {
      const originals = new Map<string, string>();
      for (const artifact of artifactPaths) {
        const copy = await snapshot.copy(artifact, boundary);
        if (copy.ok) originals.set(copy.path, artifact);
      }
      const raw = originals.size > 0 ? await snapshot.guard(() => runOsvArtifactScan([...originals.keys()], options)) : { results: [] };
      return jsonResult(buildArtifactReport(restoreSourcePaths(raw, originals), artifactPaths));
    } finally {
      await snapshot.cleanup();
    }
  } catch (error) {
    return errorResult(error);
  }
}
