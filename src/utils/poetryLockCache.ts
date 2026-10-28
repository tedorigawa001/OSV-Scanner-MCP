import path from "node:path";
import { MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES } from "./npmLockCopy.js";
import { readRegularFile, capitalizeReason } from "./safeRead.js";
import { parseBoundedToml } from "./boundedToml.js";
import { analyzePoetry, createPoetryBudget, type PoetryManifest } from "./poetryLock.js";
import type { RelationLookup } from "./dependencyRelations.js";

export type CapturedPoetryLock = { content: string; workspaces: Map<string, boolean | null> | null; relations: RelationLookup } | { reason: string };
export class PoetryLockCache {
  private readonly locks = new Map<string, CapturedPoetryLock>();
  private readonly companions = new Map<string, Record<string, unknown> | null>();
  private readonly coverageBudget = createPoetryBudget();
  private readonly relationBudget = createPoetryBudget();
  private companionRemaining = MAX_NPM_LOCK_TOTAL_BYTES;
  constructor(private remaining = MAX_NPM_LOCK_TOTAL_BYTES) {}
  async get(file: string, projectDir: string, packageFiles: readonly string[]): Promise<CapturedPoetryLock> {
    const cached = this.locks.get(file); if (cached) return cached;
    let captured: CapturedPoetryLock;
    if (this.remaining <= 0) captured = { reason: "Poetry lockfiles exceeded the total input size limit" };
    else {
      const read = await readRegularFile(file, { boundary: projectDir, maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining) });
      if (!read.ok) captured = { reason: capitalizeReason(read.message) };
      else {
        this.remaining -= read.bytes.length;
        const directory = path.dirname(file), inputs: PoetryManifest[] = [];
        const files = new Set([path.join(directory, "pyproject.toml"), ...packageFiles.map(p => path.join(projectDir, p))]);
        for (const companion of files) {
          const relative = path.relative(directory, companion).split(path.sep).join("/");
          if (relative.startsWith("../") || path.isAbsolute(relative)) continue;
          if (!this.companions.has(companion)) {
            const read = this.companionRemaining > 0 ? await readRegularFile(companion, { boundary: projectDir, maxBytes: Math.min(4 * 1024 * 1024, this.companionRemaining) }) : null;
            if (read?.ok) { this.companionRemaining -= read.bytes.length; this.companions.set(companion, parseBoundedToml(read.bytes.toString("utf8"))); }
            else this.companions.set(companion, null);
          }
          inputs.push({ path: relative, data: this.companions.get(companion)! });
        }
        const content = read.bytes.toString("utf8");
        captured = { content, ...analyzePoetry(content, inputs, this.coverageBudget, this.relationBudget) };
      }
    }
    this.locks.set(file, captured); return captured;
  }
}
