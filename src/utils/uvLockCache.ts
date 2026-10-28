import { MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES } from "./npmLockCopy.js";
import { readRegularFile, capitalizeReason } from "./safeRead.js";
import { parseUvLock, uvWorkspaceIndex, uvLockRelations, createUvWorkBudget } from "./uvLock.js";
import type { RelationLookup } from "./dependencyRelations.js";

export type CapturedUvLock = { content: string; workspaces: Map<string, boolean | null> | null; relations: RelationLookup } | { reason: string };
export class UvLockCache {
  private readonly locks = new Map<string, CapturedUvLock>();
  private readonly coverageBudget = createUvWorkBudget();
  private readonly relationBudget = createUvWorkBudget();
  constructor(private remaining = MAX_NPM_LOCK_TOTAL_BYTES) {}
  async get(file: string, projectDir: string): Promise<CapturedUvLock> {
    const cached = this.locks.get(file); if (cached) return cached;
    let captured: CapturedUvLock;
    if (this.remaining <= 0) captured = { reason: "uv lockfiles exceeded the total input size limit" };
    else {
      const read = await readRegularFile(file, { boundary: projectDir, maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining) });
      if (!read.ok) captured = { reason: capitalizeReason(read.message) };
      else {
        this.remaining -= read.bytes.length;
        const content = read.bytes.toString("utf8"), data = parseUvLock(content);
        const workspaces = data === null ? null : uvWorkspaceIndex(data, this.coverageBudget);
        captured = { content, workspaces, relations: data === null ? null : uvLockRelations(data, workspaces, this.relationBudget) };
      }
    }
    this.locks.set(file, captured); return captured;
  }
}
