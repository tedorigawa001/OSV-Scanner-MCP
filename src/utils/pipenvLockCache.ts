import path from "node:path";
import { MAX_NPM_LOCK_BYTES, MAX_NPM_LOCK_TOTAL_BYTES } from "./npmLockCopy.js";
import { readRegularFile, capitalizeReason } from "./safeRead.js";
import { parseBoundedToml } from "./boundedToml.js";
import { analyzePipenv, parsePipenvLock, createPipenvBudget, type PipenvManifest } from "./pipenvLock.js";
import type { RelationLookup } from "./dependencyRelations.js";

export type CapturedPipenvLock = { content: string; additionalCopies: { content: string; category: string }[]; issues: string[]; workspaces: Map<string, boolean | null> | null; relations: RelationLookup } | { reason: string };
export class PipenvLockCache {
  private readonly locks = new Map<string, CapturedPipenvLock>();
  private readonly companions = new Map<string, Record<string, unknown> | null>();
  private readonly coverageBudget = createPipenvBudget();
  private readonly relationBudget = createPipenvBudget();
  private companionRemaining = MAX_NPM_LOCK_TOTAL_BYTES;
  private generatedRemaining = MAX_NPM_LOCK_TOTAL_BYTES;
  private remainingCopies = 200;
  constructor(private remaining = MAX_NPM_LOCK_TOTAL_BYTES) {}
  async get(file: string, projectDir: string, packageFiles: readonly string[]): Promise<CapturedPipenvLock> {
    const cached = this.locks.get(file); if (cached) return cached;
    let captured: CapturedPipenvLock;
    if (this.remaining <= 0) captured = { reason: "Pipenv lockfiles exceeded the total input size limit" };
    else {
      const read = await readRegularFile(file, { boundary: projectDir, maxBytes: Math.min(MAX_NPM_LOCK_BYTES, this.remaining) });
      if (!read.ok) captured = { reason: capitalizeReason(read.message) };
      else {
        this.remaining -= read.bytes.length;
        const directory = path.dirname(file), inputs: PipenvManifest[] = [];
        const files = new Set([path.join(directory, "Pipfile"), ...packageFiles.map(p => path.join(projectDir, p))]);
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
        const data = parsePipenvLock(content), additionalCopies: { content: string; category: string }[] = [], issues: string[] = [];
        // OSV-Scanner only reads default/develop. Translate each custom category separately;
        // merging them could overwrite distinct versions of the same package.
        if (!data) issues.push("Pipenv metadata could not be interpreted; custom category coverage is unconfirmed");
        else for (const [category, packages] of Object.entries(data)) {
          if (["_meta", "default", "develop"].includes(category)) continue;
          if (!packages || typeof packages !== "object" || Array.isArray(packages)) { issues.push("A Pipenv custom category is malformed and could not be scanned"); continue; }
          if (!Object.keys(packages).length) continue;
          if (this.remainingCopies <= 0) { issues.push("Pipenv custom categories exceeded the scan-wide copy count limit (200)"); break; }
          const normalized = JSON.stringify({ _meta: { "pipfile-spec": 6 }, default: packages, develop: {} });
          const bytes = Buffer.byteLength(normalized);
          if (bytes > MAX_NPM_LOCK_BYTES || bytes > this.generatedRemaining) { issues.push("Pipenv custom category copies exceeded the input size limit"); continue; }
          this.generatedRemaining -= bytes;
          this.remainingCopies--;
          additionalCopies.push({ content: normalized, category });
        }
        captured = { content, additionalCopies, issues, ...analyzePipenv(content, inputs, this.coverageBudget, this.relationBudget) };
      }
    }
    this.locks.set(file, captured); return captured;
  }
}
