import { sanitizeExternalText } from "./externalText.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { readRegularFile } from "./safeRead.js";
import { isInsideDir } from "./projectWalk.js";
import { analyzeGradleContext, createGradleBudget, gradleKey, parseGradleGraph, parseGradleLock, UnsupportedGradleSchemaVersion, type GradleGraph, type GradleBudget } from "./gradleGraph.js";
import { analyzeDeclarations, catalogVerified, DECLARATION_CONTRACT, DECLARATION_MODEL, startupDeclarationTrust, knownDeclarations, parseDeclarationContract, type DeclarationTrust, type DeclarationTrustConfig } from "./gradleDeclarations.js";
import type { RelationInfo, RelationLookup } from "./dependencyRelations.js";

export const GRADLE_COMPANION = "osv-mcp-gradle-dependencies.json";
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type DeclarationTrustStatus = "accepted" | "disabled" | "missing_assertion" | "invalid";
interface DeclarationContextProvenance {
  configuration: string; trust_status: DeclarationTrustStatus; assurance: string | null; contract_paths: string[];
}
export interface GradleMetadata {
  path: string; metadata_paths: string[]; status: "complete" | "partial" | "unavailable";
  declaration_provenance?: { trust_model: string; trust_status: DeclarationTrustStatus;
    contract_paths: string[]; assurance: string | null; limitations: string[]; contexts: DeclarationContextProvenance[] };
  relations_complete: boolean; declarations_complete: boolean; contexts: string[]; reasons: string[];
}
export interface GradleCaptureResult { lookup: RelationLookup; metadata: GradleMetadata; coverageReasons: string[] }
const unknown = (): RelationInfo => ({ relation: "unknown", introducedByComplete: false, declaredInComplete: false });

/** One cache per scan; all metadata/input bytes and work limits are shared. */
export class GradleGraphCache {
  private readonly documents = new Map<string, Promise<{ graph?: GradleGraph; reason?: string }>>();
  /** SHA-256 of a readable input, "absent" when it does not exist, null when it cannot be verified. */
  private readonly inputs = new Map<string, Promise<string | null>>();
  private readonly inputBytes = new Map<string, Buffer>();
  private readonly contracts = new Map<string, ReturnType<typeof parseDeclarationContract> | null>();
  private remaining = 64 * 1024 * 1024;
  private lockRemaining = 64 * 1024 * 1024;
  private inputRemaining = 64 * 1024 * 1024;
  private readonly trust: DeclarationTrust;
  private readonly trustInvalid: boolean;
  constructor(private readonly boundary: string, private readonly budget: GradleBudget = createGradleBudget(), trustSetting: DeclarationTrust | DeclarationTrustConfig = startupDeclarationTrust(), private readonly declarationBudget: GradleBudget = createGradleBudget()) {
    const setting = typeof trustSetting === "object" ? trustSetting : { trust: trustSetting, invalid: false };
    this.trust = setting.trust; this.trustInvalid = setting.invalid;
  }

  private document(file: string) {
    let pending = this.documents.get(file);
    if (!pending) {
      pending = (async () => {
        const read = await readRegularFile(file, { boundary: this.boundary, maxBytes: Math.min(16 * 1024 * 1024, this.remaining) });
        if (!read.ok) return { reason: read.failure === "not_found" ? "metadata_missing" : `metadata_${read.failure}` };
        this.remaining -= read.bytes.length;
        try { return { graph: parseGradleGraph(read.bytes.toString("utf8"), this.budget) }; }
        catch (error) { return { reason: error instanceof UnsupportedGradleSchemaVersion ? "unsupported_schema_version" : "invalid_or_over_budget_metadata" }; }
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
        if (!(/\.gradle(?:\.kts)?$/.test(name) || name === "gradle.properties" || name.endsWith(".versions.toml") || /\.(?:kt|java|groovy)$/.test(name) || name === DECLARATION_CONTRACT)) return null;
        const read = await readRegularFile(file, { boundary: this.boundary, maxBytes: Math.min(4 * 1024 * 1024, this.inputRemaining) });
        if (!read.ok) return read.failure === "not_found" ? "absent" : null;
        this.inputRemaining -= read.bytes.length;
        this.inputBytes.set(file, read.bytes);
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
      relations_complete: false, declarations_complete: false, contexts: [], reasons: [`captured_lock_${read.failure}`, ...(this.trustInvalid ? ["declaration_trust_config_invalid"] : [])],
    } };
  }
  async capture(lockPath: string, lockBytes: Buffer): Promise<GradleCaptureResult> {
    const metadata: GradleMetadata = { path: sanitizeExternalText(path.relative(this.boundary, lockPath)), metadata_paths: [], status: "unavailable",
      relations_complete: false, declarations_complete: false, contexts: [], reasons: [] };
    const result: GradleCaptureResult = { lookup: unknown, metadata, coverageReasons: [] };
    // A mistyped trust setting is reported on every Gradle lock, even when no declaration map is present.
    if (this.trustInvalid) metadata.reasons.push("declaration_trust_config_invalid");
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
    const declarationContexts = new Set<string>();
    // Each context authorizes only its own GAVs. The lock summary is diagnostic,
    // never a switch that can erase a separately verified declaration list.
    const contextTrust = new Map<string, DeclarationContextProvenance>([...lock.keys()].map(configuration => [configuration, {
      configuration, trust_status: this.trust ? "missing_assertion" : "disabled", assurance: null, contract_paths: [],
    }]));
    if (candidate.graph.schemaVersion === 2) metadata.declaration_provenance = {
      trust_model: DECLARATION_MODEL, trust_status: this.trust ? "missing_assertion" : "disabled", contract_paths: [], assurance: null,
      limitations: ["unregistered_equal_additions_not_detectable", "reverted_external_mutations_not_detectable"], contexts: [],
    };
    // Catalog inventory failures affect graph adoption, independently of declaration trust.
    if (candidate.graph.contexts.some((c: import("./gradleGraph.js").GradleContext) => "catalogInputs" in c && !c.catalogInputs.inventoryComplete)) {
      metadata.reasons.push("catalog_graph_inputs_unverifiable"); return result;
    }
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
      if (!catalogVerified(c, candidate.graph)) { metadata.reasons.push("catalog_graph_inputs_unverifiable"); continue; }
      metadata.contexts.push(sanitizeExternalText(c.configuration));
      try {
        const analysis = analyzeGradleContext(c, lock, this.budget);
        lookups.set(c.configuration, analysis.lookup);
        if (analysis.lookup && !analysis.reasons.length) completeContexts.add(c.configuration);
        metadata.reasons.push(...analysis.reasons);
        result.coverageReasons.push(...analysis.coverageReasons);
        const d = knownDeclarations(c);
        if (!d) metadata.reasons.push("declarations" in c ? "unsupported_declaration_adapter" : "declaration_source_map_unavailable");
        else if (!this.trust) metadata.reasons.push(this.trustInvalid ? "declaration_trust_config_invalid" : "declaration_trust_disabled");
        else if (analysis.lookup && !analysis.reasons.length) {
          try {
            const contractPath = path.resolve(candidate.root, DECLARATION_CONTRACT);
            const input = candidate.graph.inputs.files.find(i => i.path === DECLARATION_CONTRACT);
            const bytes = this.inputBytes.get(contractPath);
            if (!input || !("sha256" in input) || input.sha256 !== d.trust.contractSha256 || !bytes) throw new Error("declaration_contract_mismatch");
            if (!this.contracts.has(contractPath)) {
              try { this.contracts.set(contractPath, parseDeclarationContract(bytes.toString("utf8"))); } catch { this.contracts.set(contractPath, null); }
            }
            const contract = this.contracts.get(contractPath);
            if (!contract) throw new Error("invalid_declaration_contract");
            const provenance = contextTrust.get(c.configuration)!;
            provenance.trust_status = "accepted"; provenance.assurance = "author-attested-and-structurally-checked";
            provenance.contract_paths = [sanitizeExternalText(path.relative(this.boundary, contractPath))];
            const declarations = analyzeDeclarations(c, candidate.graph, contract, this.declarationBudget);
            metadata.reasons.push(...declarations.reasons);
            if (declarations.reasons.includes("declaration_assertion_missing") || declarations.reasons.includes("provider_stability_assertion_missing")) {
              provenance.trust_status = "missing_assertion"; provenance.assurance = null;
            }
            const adopted = provenance.trust_status === "accepted" && !declarations.reasons.length;
            if (adopted) {
              declarationContexts.add(c.configuration);
              if (d.adapterVersion === 3 && d.records.some(r => "registrationKind" in r && r.registrationKind === "provider")) {
                const limitations = metadata.declaration_provenance!.limitations;
                for (const limitation of ["provider_evaluations_outside_materialization_not_observable", "provider_stability_author_asserted"]) {
                  if (!limitations.includes(limitation)) limitations.push(limitation);
                }
              }
            }
            const base = analysis.lookup;
            lookups.set(c.configuration, (name, version) => {
              const info = base(name, version);
              const paths = adopted ? declarations.sources.get(gradleKey(name, version)) : undefined;
              return info.relation !== "direct" || !paths?.size ? info : { ...info, declaredInComplete: true,
                declaredIn: new Set([...paths].map(p => path.relative(path.dirname(lockPath), path.resolve(candidate.root, p)))) };
            });
          } catch (error) {
            const exhausted = this.declarationBudget.index < 0 || this.declarationBudget.traversal < 0;
            metadata.reasons.push(exhausted ? "declaration_budget_exceeded" : "declaration_contract_mismatch");
            if (!exhausted) {
              const provenance = contextTrust.get(c.configuration)!;
              provenance.trust_status = "invalid"; provenance.assurance = null;
            }
          }
        }
      } catch { metadata.reasons.push("relationship_budget_exceeded"); lookups.set(c.configuration, null); }
    }
    if ([...lock.keys()].some(config => !completeContexts.has(config))) metadata.reasons.push("missing_or_incomplete_contexts");
    for (const config of invalidConfigurations) {
      lookups.set(config, null); completeContexts.delete(config);
      const provenance = contextTrust.get(config);
      if (provenance && this.trust) { provenance.trust_status = "invalid"; provenance.assurance = null; }
    }
    if (metadata.declaration_provenance) {
      const contexts = [...contextTrust.values()].sort((a,b) => a.configuration < b.configuration ? -1 : a.configuration > b.configuration ? 1 : 0);
      const provenance = metadata.declaration_provenance;
      // Severity precedence makes aggregation commutative, including missing contexts.
      provenance.trust_status = !this.trust ? "disabled" : contexts.some(c => c.trust_status === "invalid") ? "invalid" :
        !contexts.length || contexts.some(c => c.trust_status !== "accepted") ? "missing_assertion" : "accepted";
      provenance.assurance = provenance.trust_status === "accepted" ? "author-attested-and-structurally-checked" : null;
      provenance.contract_paths = [...new Set(contexts.flatMap(c => c.contract_paths))].sort();
      provenance.contexts = contexts.map(c => ({ ...c, configuration: sanitizeExternalText(c.configuration) }));
    }
    const allComplete = invalidConfigurations.size === 0 && [...lock.keys()].every(config => completeContexts.has(config));
    metadata.status = allComplete ? "complete" : "partial";
    metadata.relations_complete = allComplete;
    metadata.declarations_complete = metadata.declaration_provenance?.trust_status === "accepted" && allComplete && [...lock.keys()].every(config => declarationContexts.has(config));
    metadata.reasons.push("environment_freshness_not_proven");
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
        ...(infos.every(i => i.declaredInComplete === true) ? { declaredIn: new Set(infos.flatMap(i => [...(i.declaredIn ?? [])])) } : {}),
        ...(complete ? { introducedBy: new Set(infos.flatMap(i => [...(i.introducedBy ?? [])])) } : {}) };
    };
    return result;
  }
}
