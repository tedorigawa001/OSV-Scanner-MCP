import { MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES } from "./npmLockCopy.js";
import { readRegularFile, capitalizeReason } from "./safeRead.js";
import { parseBunLock, bunWorkspaceKeys, bunLockRelations, createBunWorkBudget } from "./bunLock.js";
import type { RelationLookup } from "./dependencyRelations.js";

export type CapturedBunLock = { content: string; workspaces: Set<string> | null; relations: RelationLookup } | { reason: string };
export class BunLockCache {
  private readonly locks = new Map<string, CapturedBunLock>();
  private readonly parseBudget = createBunWorkBudget();
  private readonly coverageBudget = createBunWorkBudget();
  private readonly relationBudget = createBunWorkBudget();
  constructor(private remaining = MAX_NPM_LOCK_TOTAL_BYTES) {}
  async get(file: string, projectDir: string): Promise<CapturedBunLock> {
    const cached = this.locks.get(file); if (cached) return cached;
    let captured: CapturedBunLock;
    if (this.remaining <= 0) captured = { reason: "Bun lockfiles exceeded the total input size limit" };
    else {
      const read = await readRegularFile(file, { boundary: projectDir, maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining) });
      if (!read.ok) captured = { reason: capitalizeReason(read.message) };
      else {
        this.remaining -= read.bytes.length;
        const content = read.bytes.toString("utf8"), data = parseBunLock(content, this.parseBudget);
        captured = { content, workspaces: data === null ? null : bunWorkspaceKeys(data, this.coverageBudget), relations: data === null ? null : bunLockRelations(data, this.relationBudget) };
      }
    }
    this.locks.set(file, captured); return captured;
  }
}
