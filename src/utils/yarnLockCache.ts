import path from "node:path";
import { MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES, createNpmLockWorkBudget, parseNpmLock } from "./npmLockCopy.js";
import { readRegularFile, capitalizeReason } from "./safeRead.js";
import { analyzeYarn, type YarnAnalysis, type YarnManifest } from "./yarnLock.js";
import { createPnpmWorkBudget } from "./pnpmRelations.js";

export type CapturedYarnLock = ({ content: string } & YarnAnalysis) | { reason: string };
export class YarnLockCache {
  private readonly locks = new Map<string, CapturedYarnLock>();
  private readonly manifests = new Map<string, Record<string, unknown> | null>();
  private readonly jsonBudget = createNpmLockWorkBudget();
  private readonly budget = createPnpmWorkBudget();
  /** Relationship traversal has its own budget so it cannot make coverage unconfirmed. */
  private readonly relationBudget = createPnpmWorkBudget();
  private remainingJson = MAX_NPM_LOCK_TOTAL_BYTES;
  constructor(private remaining = MAX_NPM_LOCK_TOTAL_BYTES) {}

  private async manifest(file: string, projectDir: string): Promise<Record<string, unknown> | null> {
    if (this.manifests.has(file)) return this.manifests.get(file)!;
    let data: Record<string, unknown> | null = null;
    if (this.remainingJson > 0) {
      const read = await readRegularFile(file, { boundary: projectDir, maxBytes: Math.min(4 * 1024 * 1024, this.remainingJson) });
      if (read.ok) {
        this.remainingJson -= read.bytes.length;
        try {
          const value = parseNpmLock(read.bytes.toString("utf8"), this.jsonBudget);
          if (value !== null && typeof value === "object" && !Array.isArray(value)) data = value as Record<string, unknown>;
        } catch { /* Unreadable declarations cannot establish workspace coverage. */ }
      }
    }
    this.manifests.set(file, data); return data;
  }

  async get(file: string, projectDir: string, packageFiles: readonly string[]): Promise<CapturedYarnLock> {
    const cached = this.locks.get(file); if (cached) return cached;
    let result: CapturedYarnLock;
    if (this.remaining <= 0) result = { reason: "Yarn lockfiles exceeded the total input size limit" };
    else {
      const read = await readRegularFile(file, { boundary: projectDir, maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining) });
      if (!read.ok) result = { reason: capitalizeReason(read.message) };
      else {
        this.remaining -= read.bytes.length;
        const root = path.dirname(file), inputs: YarnManifest[] = [];
        const names = new Set([path.relative(projectDir, path.join(root, "package.json")), ...packageFiles]);
        for (const relative of names) {
          if (--this.budget.remaining < 0) break;
          const absolute = path.join(projectDir, relative), member = path.relative(root, absolute);
          if (member.startsWith(`..${path.sep}`) || member === ".." || path.isAbsolute(member)) continue;
          inputs.push({ path: member.split(path.sep).join("/"), data: await this.manifest(absolute, projectDir) });
        }
        const content = read.bytes.toString("utf8");
        result = { content, ...analyzeYarn(content, inputs, this.budget, this.relationBudget) };
      }
    }
    this.locks.set(file, result); return result;
  }
}
