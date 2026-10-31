import { sanitizeExternalText } from "./externalText.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { readRegularFile } from "./safeRead.js";
import { isInsideDir } from "./projectWalk.js";
import { analyzeGradleContext, createGradleBudget, gradleKey, parseGradleGraph, parseGradleLock, type GradleGraph, type GradleBudget } from "./gradleGraph.js";
import type { RelationInfo, RelationLookup } from "./dependencyRelations.js";

export const GRADLE_COMPANION = "osv-mcp-gradle-dependencies.json";
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export interface GradleMetadata {
  path: string; metadata_paths: string[]; status: "complete" | "partial" | "unavailable";
  relations_complete: boolean; declarations_complete: boolean; contexts: string[]; reasons: string[];
}
export interface GradleCaptureResult { lookup: RelationLookup; metadata: GradleMetadata; coverageReasons: string[] }
const unknown = (): RelationInfo => ({ relation: "unknown", introducedByComplete: false, declaredInComplete: false });

/** One cache per scan; all metadata/input bytes and work limits are shared. */
export class GradleGraphCache {
  private readonly documents = new Map<string, Promise<{ graph?: GradleGraph; reason?: string }>>();
  /** SHA-256 of a readable input, "absent" when it does not exist, null when it cannot be verified. */
  private readonly inputs = new Map<string, Promise<string | null>>();
  private remaining = 64 * 1024 * 1024;
  private lockRemaining = 64 * 1024 * 1024;
  private inputRemaining = 64 * 1024 * 1024;
  constructor(private readonly boundary: string, private readonly budget: GradleBudget = createGradleBudget()) {}

  private document(file: string) {
    let pending = this.documents.get(file);
    if (!pending) {
      pending = (async () => {
        const read = await readRegularFile(file, { boundary: this.boundary, maxBytes: Math.min(16 * 1024 * 1024, this.remaining) });
        if (!read.ok) return { reason: read.failure === "not_found" ? "metadata_missing" : `metadata_${read.failure}` };
        this.remaining -= read.bytes.length;
        try { return { graph: parseGradleGraph(read.bytes.toString("utf8"), this.budget) }; }
        catch { return { reason: "invalid_or_over_budget_metadata" }; }
      })();
      this.documents.set(file, pending);
    }
    return pending;
  }
  private input(file: string): Promise<string | null> {
    let pending = this.inputs.get(file);
    if (!pending) {
      pending = (async () => {
        // Only declared Gradle companion kinds can be read, never arbitrary JSON paths.
        const name = path.basename(file);
        if (!(/\.gradle(?:\.kts)?$/.test(name) || name === "gradle.properties" || name.endsWith(".versions.toml"))) return null;
        const read = await readRegularFile(file, { boundary: this.boundary, maxBytes: Math.min(4 * 1024 * 1024, this.inputRemaining) });
        if (!read.ok) return read.failure === "not_found" ? "absent" : null;
        this.inputRemaining -= read.bytes.length;
        return sha256(read.bytes);
      })();
      this.inputs.set(file, pending);
    }
    return pending;
  }
  async captureCopy(lockPath: string, copyPath: string): Promise<GradleCaptureResult> {
    const read = await readRegularFile(copyPath, { maxBytes: Math.min(16 * 1024 * 1024, this.lockRemaining) });
    if (read.ok) return this.capture(lockPath, read.bytes);
    return { lookup: unknown, coverageReasons: [], metadata: {
      path: sanitizeExternalText(path.relative(this.boundary, lockPath)), metadata_paths: [], status: "unavailable",
      relations_complete: false, declarations_complete: false, contexts: [], reasons: [`captured_lock_${read.failure}`],
    } };
  }
  async capture(lockPath: string, lockBytes: Buffer): Promise<GradleCaptureResult> {
    const metadata: GradleMetadata = { path: sanitizeExternalText(path.relative(this.boundary, lockPath)), metadata_paths: [], status: "unavailable",
      relations_complete: false, declarations_complete: false, contexts: [], reasons: [] };
    const result: GradleCaptureResult = { lookup: unknown, metadata, coverageReasons: [] };
    if (lockBytes.length > Math.min(16 * 1024 * 1024, this.lockRemaining)) { metadata.reasons.push("captured_lock_size_limit"); return result; }
    this.lockRemaining -= lockBytes.length;
    if (path.basename(lockPath) !== "gradle.lockfile") { metadata.reasons.push("buildscript_not_supported"); return result; }
    const candidates: { graph: GradleGraph; root: string; lockId: string; hash: string }[] = [];
    let directory = path.dirname(lockPath);
    // Ancestors are bounded by the scan root, even when allowedRoot is larger.
    for (let depth = 0; depth < 128 && isInsideDir(this.boundary, directory); depth++) {
      const file = path.join(directory, GRADLE_COMPANION), doc = await this.document(file);
      if (doc.graph) {
        const lock = doc.graph.lockfiles.find(l => path.resolve(directory, l.path) === lockPath);
        if (lock) { candidates.push({ graph: doc.graph, root: directory, lockId: lock.id, hash: lock.sha256 }); metadata.metadata_paths.push(sanitizeExternalText(path.relative(this.boundary, file))); }
      } else if (doc.reason !== "metadata_missing") metadata.reasons.push(doc.reason!);
      if (directory === this.boundary) break;
      directory = path.dirname(directory);
    }
    if (candidates.length !== 1) { metadata.reasons.push(candidates.length ? "ambiguous_metadata" : "metadata_unavailable"); return result; }
    const candidate = candidates[0]!;
    if (candidate.hash !== sha256(lockBytes)) { metadata.reasons.push("stale_lock_hash"); return result; }
    for (const input of candidate.graph.inputs.files) {
      const actual = await this.input(path.resolve(candidate.root, input.path));
      const expected = "absent" in input ? "absent" : input.sha256;
      if (actual !== expected) { metadata.reasons.push(actual === null ? "input_hash_unverifiable" : "stale_input_hash"); return result; }
    }
    let lock;
    try { lock = parseGradleLock(lockBytes.toString("utf8")); }
    catch { metadata.reasons.push("invalid_lock_metadata"); return result; }
    const contexts = candidate.graph.contexts.filter(c => c.lockfileId === candidate.lockId);
    const lookups = new Map<string, RelationLookup>();
    const completeContexts = new Set<string>();
    const invalidConfigurations = new Set<string>();
    const validContexts = [];
    for (const c of contexts) {
      const project = candidate.graph.projects.find(p => p.id === c.projectId)!;
      if (c.kind !== "project" || path.resolve(candidate.root, project.directory) !== path.dirname(lockPath)) {
        metadata.reasons.push("invalid_context_mapping"); invalidConfigurations.add(c.configuration); continue;
      }
      validContexts.push(c);
    }
    // Identity/freshness verified above: only now may graph differences affect coverage.
    for (const c of validContexts) {
      metadata.contexts.push(sanitizeExternalText(c.configuration));
      try {
        const analysis = analyzeGradleContext(c, lock, this.budget);
        lookups.set(c.configuration, analysis.lookup);
        if (analysis.lookup && !analysis.reasons.length) completeContexts.add(c.configuration);
        metadata.reasons.push(...analysis.reasons);
        result.coverageReasons.push(...analysis.coverageReasons);
      } catch { metadata.reasons.push("relationship_budget_exceeded"); lookups.set(c.configuration, null); }
    }
    if ([...lock.keys()].some(config => !completeContexts.has(config))) metadata.reasons.push("missing_or_incomplete_contexts");
    for (const config of invalidConfigurations) { lookups.set(config, null); completeContexts.delete(config); }
    const allComplete = invalidConfigurations.size === 0 && [...lock.keys()].every(config => completeContexts.has(config));
    metadata.status = allComplete ? "complete" : "partial";
    metadata.relations_complete = allComplete;
    // No source-map support in Stage B; ownership is not physical provenance.
    metadata.reasons.push("declaration_source_map_unavailable", "environment_freshness_not_proven");
    metadata.reasons = [...new Set(metadata.reasons)];
    result.coverageReasons = [...new Set(result.coverageReasons)];
    result.lookup = (name, version) => {
      const key = gradleKey(name, version), infos: RelationInfo[] = [];
      for (const [config, entries] of lock) {
        if (entries.has(key)) infos.push(lookups.get(config)?.(name, version) ?? unknown());
      }
      if (!infos.length) return unknown();
      const complete = infos.every(i => i.introducedByComplete === true);
      const direct = infos.some(i => i.relation === "direct");
      return { relation: direct ? "direct" : infos.every(i => i.relation === "transitive") ? "transitive" : "unknown",
        introducedByComplete: complete, declaredInComplete: infos.every(i => i.declaredInComplete === true),
        ...(complete ? { introducedBy: new Set(infos.flatMap(i => [...(i.introducedBy ?? [])])) } : {}) };
    };
    return result;
  }
}
