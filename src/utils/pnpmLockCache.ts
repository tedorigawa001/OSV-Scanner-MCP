import { MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES } from "./npmLockCopy.js";
import { capitalizeReason, readRegularFile } from "./safeRead.js";
import { createPnpmWorkBudget, parsePnpmLock, pnpmImporterKeys } from "./pnpmRelations.js";

export type CapturedPnpmLock = { content: string; importers: Set<string> | null } | { reason: string };

/** Capture once per scan; coverage and scanner input must refer to the same bytes. */
export class PnpmLockCache {
  private readonly locks = new Map<string, CapturedPnpmLock>();
  private readonly budget = createPnpmWorkBudget();
  constructor(private remaining = MAX_NPM_LOCK_TOTAL_BYTES) {}

  async get(file: string, projectDir: string): Promise<CapturedPnpmLock> {
    const cached = this.locks.get(file);
    if (cached) return cached;
    let captured: CapturedPnpmLock;
    if (this.remaining <= 0) {
      captured = { reason: "Pnpm lockfiles exceeded the total input size limit" };
    } else {
      const read = await readRegularFile(file, { maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining), boundary: projectDir });
      if (!read.ok) captured = { reason: capitalizeReason(read.message) };
      else {
        this.remaining -= read.bytes.length;
        const content = read.bytes.toString("utf8"), data = parsePnpmLock(content, this.budget);
        captured = { content, importers: data === null ? null : pnpmImporterKeys(data, this.budget) };
      }
    }
    this.locks.set(file, captured);
    return captured;
  }
}
