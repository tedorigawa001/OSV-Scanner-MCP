import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runOsvSbomScan, type RunOsvScanOptions } from "../osv/runner.js";
import { buildSbomReport } from "../osv/sbomReport.js";
import { SBOM_DIR_PREFIX, trackTempDir } from "../utils/processCleanup.js";
import { loadSbom, type SbomInputOptions } from "../utils/sbomInput.js";
import { errorResult, jsonResult, type ToolResult } from "./toolResult.js";

export interface ScanSbomArgs { sbom_path: string }
export interface ScanSbomOptions extends RunOsvScanOptions, SbomInputOptions {}

export async function handleScanSbom(args: ScanSbomArgs, options: ScanSbomOptions = {}): Promise<ToolResult> {
  try {
    const input = await loadSbom(args.sbom_path, options);
    const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), SBOM_DIR_PREFIX));
    // シグナル等で終了しても残さない(processCleanup.ts)
    const untrack = trackTempDir(dir);
    try {
      // A fixed filename selects the native parser, irrespective of the user's filename.
      const snapshotPath = path.join(dir, input.format === "CycloneDX" ? "input.cdx.json" : "input.spdx.json");
      await writeFile(snapshotPath, input.bytes, { mode: 0o600, flag: "wx" });
      const raw = await runOsvSbomScan(snapshotPath, options);
      return jsonResult(buildSbomReport(raw, input, snapshotPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
      untrack();
    }
  } catch (error) {
    return errorResult(error);
  }
}
