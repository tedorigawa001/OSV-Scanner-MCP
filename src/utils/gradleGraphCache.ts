import {loadBudget} from "./gradlePluginSnapshots.js";
import { GradlePluginReader, startupPluginSettings, type PluginSettings, type PluginAnalysis, type PluginStatus } from "./gradlePlugins.js";
import { catalogEntriesMatch, loadCatalogModels, UnsupportedCatalogModel, type CatalogModels } from "./gradleCatalogs.js";
import { sanitizeExternalText } from "./externalText.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { readRegularFile } from "./safeRead.js";
import { isInsideDir } from "./projectWalk.js";
import { analyzeGradleContext, createGradleBudget, gradleKey, parseGradleGraph, parseGradleLock, UnsupportedGradleSchemaVersion, type GradleGraph, type GradleContext, type GradleBudget } from "./gradleGraph.js";
import { analyzeDeclarations, catalogVerified, DECLARATION_CONTRACT, DECLARATION_MODEL, startupDeclarationTrust, knownDeclarations, parseDeclarationContract, type DeclarationTrust, type DeclarationTrustConfig, startupCatalogTrust, type CatalogTrust, type CatalogTrustConfig, CATALOG_MODEL } from "./gradleDeclarations.js";
import type { RelationInfo, RelationLookup } from "./dependencyRelations.js";

export const GRADLE_COMPANION = "osv-mcp-gradle-dependencies.json";
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
type DeclarationTrustStatus = "accepted" | "disabled" | "missing_assertion" | "invalid";
interface DeclarationContextProvenance {
  configuration: string; trust_status: DeclarationTrustStatus; assurance: string | null; contract_paths: string[]; catalog_trust_status?: DeclarationTrustStatus; plugin_trust_status?:PluginStatus; plugin_applications?:PluginAnalysis["applications"];
}
export interface GradleMetadata {
  path: string; metadata_paths: string[]; status: "complete" | "partial" | "unavailable";
  declaration_provenance?: { trust_model: string; trust_status: DeclarationTrustStatus;
    plugin_trust_model?:string;plugin_trust_status?:PluginStatus;catalog_trust_model?: string; catalog_trust_status?: DeclarationTrustStatus; contract_paths: string[]; assurance: string | null; limitations: string[]; contexts: DeclarationContextProvenance[] };
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
  private readonly catalogRequirements = new Map<string, boolean>();
  private readonly catalogModels = new Map<string, CatalogModels | UnsupportedCatalogModel | null>();
  private readonly catalogInputBudget = createGradleBudget();
  private remaining = 64 * 1024 * 1024;
  private lockRemaining = 64 * 1024 * 1024;
  private readonly pluginBudget=loadBudget();
  private readonly trust: DeclarationTrust;
  private readonly trustInvalid: boolean;
  private readonly catalogTrust: CatalogTrust;
  private readonly catalogTrustInvalid: boolean;
  private readonly pluginReader:GradlePluginReader;
  constructor(private readonly boundary: string, private readonly budget: GradleBudget = createGradleBudget(), trustSetting: DeclarationTrust | DeclarationTrustConfig = startupDeclarationTrust(), private readonly declarationBudget: GradleBudget = createGradleBudget(), catalogSetting: CatalogTrust | CatalogTrustConfig = startupCatalogTrust(), private readonly pluginSettings:PluginSettings=startupPluginSettings()) {
    const setting = typeof trustSetting === "object" ? trustSetting : { trust: trustSetting, invalid: false };
    this.trust = setting.trust; this.trustInvalid = setting.invalid;
    const catalog = typeof catalogSetting === "object" ? catalogSetting : { trust: catalogSetting, invalid: false };
    this.catalogTrust = catalog.trust; this.catalogTrustInvalid = catalog.invalid;this.pluginReader=new GradlePluginReader(pluginSettings,this.pluginBudget);
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
        const read = await readRegularFile(file, { boundary: this.boundary, maxBytes: Math.min(4 * 1024 * 1024, this.pluginBudget.bytes) });
        if (!read.ok) return read.failure === "not_found" ? "absent" : null;
        this.pluginBudget.bytes -= read.bytes.length;
        this.inputBytes.set(file, read.bytes);
        return sha256(read.bytes);
      })();
      this.inputs.set(file, pending);
    }
    return pending;
  }
  private capturedContract(file: string) {
    if (!this.contracts.has(file)) {
      const bytes = this.inputBytes.get(file);
      try { this.contracts.set(file, bytes ? parseDeclarationContract(bytes.toString("utf8")) : null); }
      catch { this.contracts.set(file, null); }
    }
    return this.contracts.get(file) ?? null;
  }
  private requiresCatalogValidation(file: string): boolean {
    if (!this.catalogRequirements.has(file)) {
      const contract = this.capturedContract(file);
      let required = contract?.catalogPolicy === "explicit-local-v1";
      if (!contract) {
        // This fallback can only require validation, never authorize declarations.
        // Preserve legacy declaration-only errors for an identifiable v1/none
        // contract; malformed or catalog-bearing manifests must fail closed.
        try {
          const raw: unknown = JSON.parse(this.inputBytes.get(file)?.toString("utf8") ?? "");
          required = !(raw && typeof raw === "object" && !Array.isArray(raw) &&
            "contractVersion" in raw && raw.contractVersion === 1 && "catalogPolicy" in raw && raw.catalogPolicy === "none" &&
            !Object.hasOwn(raw, "catalogs"));
        } catch { required = true; }
      }
      this.catalogRequirements.set(file, required);
    }
    return this.catalogRequirements.get(file)!;
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
    if (this.catalogTrustInvalid) metadata.reasons.push("catalog_trust_config_invalid");
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
    if (candidate.graph.schemaVersion >= 2) metadata.declaration_provenance = {
      trust_model: DECLARATION_MODEL, trust_status: this.trust ? "missing_assertion" : "disabled", contract_paths: [], assurance: null,
      limitations: ["unregistered_equal_additions_not_detectable", "reverted_external_mutations_not_detectable"], contexts: [],
    };
    // Catalog inventory failures affect graph adoption, independently of declaration trust.
    if (candidate.graph.contexts.some((c: import("./gradleGraph.js").GradleContext) => "catalogInputs" in c && !c.catalogInputs.inventoryComplete)) {
      metadata.reasons.push("catalog_graph_inputs_unverifiable"); return result;
    }
    let models: CatalogModels | undefined;
    const contractPath = path.resolve(candidate.root, DECLARATION_CONTRACT);
    const hasContractInput = candidate.graph.inputs.files.some(i => i.path === DECLARATION_CONTRACT);
    // The manifest has a fixed reserved name. Discover it independently of the
    // producer's input list, then require its hash reference for catalog use.
    const contractState = await this.input(contractPath);
    const author=this.capturedContract(contractPath);
    let pluginRequired=author?.contractVersion===3 || candidate.graph.schemaVersion===3;
    if(!author && contractState!=='absent'){
      try{const raw=JSON.parse(this.inputBytes.get(contractPath)?.toString('utf8')??'');pluginRequired ||=raw.contractVersion>=3||Object.hasOwn(raw,'plugins')||Object.hasOwn(raw,'pluginPolicy');}catch{/* existing contract validation fails closed below */}
    }
    if(pluginRequired && (!author||author.contractVersion!==3||candidate.graph.schemaVersion!==3||!hasContractInput)){
      metadata.reasons.push('plugin_contract_mismatch');return result;
    }
    if(this.pluginSettings.invalid)metadata.reasons.push('plugin_trust_config_invalid');
    const catalogRequired = contractState !== "absent" && this.requiresCatalogValidation(contractPath);
    const schemaOneCatalog = candidate.graph.schemaVersion === 1 && catalogRequired;
    if (candidate.graph.schemaVersion === 1 && hasContractInput && !this.capturedContract(contractPath)) {
      metadata.reasons.push("declaration_contract_mismatch"); return result;
    }
    if (catalogRequired || contexts.some((c: GradleContext) => "catalogInputs" in c && c.catalogInputs.entries.length)) {
      try {
        if (!this.inputBytes.has(contractPath) || !candidate.graph.inputs.files.some(i => i.path === DECLARATION_CONTRACT && "sha256" in i)) throw new Error("catalog_contract_missing");
        const contract = this.capturedContract(contractPath);
        if (!contract || (!schemaOneCatalog && contexts.some((c: GradleContext) => !("catalogInputs" in c) || !catalogEntriesMatch(c.catalogInputs.entries, contract, this.catalogInputBudget)))) throw new Error("catalog_manifest_mismatch");
        if (this.catalogModels.has(contractPath) && this.catalogModels.get(contractPath) === null) throw new Error("catalog_graph_inputs_unverifiable");
        let loaded = this.catalogModels.get(contractPath);
        if (!loaded) {
          const captured = new Map(candidate.graph.inputs.files.flatMap(i => {
            const b = this.inputBytes.get(path.resolve(candidate.root, i.path)); return b ? [[i.path, b] as const] : [];
          }));
          try { loaded = loadCatalogModels(contract, candidate.graph, captured, this.catalogInputBudget); }
          catch (error) {
            if (!(error instanceof UnsupportedCatalogModel)) { this.catalogModels.set(contractPath, null); throw error; }
            loaded = error;
          }
          this.catalogModels.set(contractPath, loaded);
        }
        // Verified inputs whose catalog shape is not modelled only lose declaration sources (no models → declarations incomplete).
        if (loaded instanceof UnsupportedCatalogModel) metadata.reasons.push("unsupported_catalog_model");
        else {
          models = loaded;
          metadata.declaration_provenance?.limitations.push("catalog_inputs_author_attested", "catalog_input_transient_changes_not_detectable");
        }
      } catch {
        metadata.reasons.push("catalog_graph_inputs_unverifiable"); return result;
      }
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
      let pluginAnalysis:PluginAnalysis|undefined;
      if(pluginRequired){
        const graph=candidate.graph;
        const d=knownDeclarations(c);
        if(graph.schemaVersion!==3||author?.contractVersion!==3||d?.adapterVersion!==5){metadata.reasons.push('unsupported_plugin_adapter');continue;}
        const scope=author.scopes.find(s=>s.id===d.trust.scopeId&&s.projectPath===candidate.graph.projects.find(p=>p.id===c.projectId)!.projectPath&&s.resolvableConfiguration===c.configuration);
        if(!scope){metadata.reasons.push('plugin_scope_missing');continue;}
        pluginAnalysis=await this.pluginReader.analyze(candidate.root,graph.pluginEvidence,author.plugins,scope.pluginIds,d.pluginApplications,d.records,c.projectId,!!this.trust);
        metadata.reasons.push(...pluginAnalysis.reasons);
        const provenance=contextTrust.get(c.configuration)!;
        provenance.plugin_trust_status=pluginAnalysis.status;provenance.plugin_applications=pluginAnalysis.applications;
        metadata.declaration_provenance!.plugin_trust_model=this.pluginSettings.trust??'disabled';
        metadata.declaration_provenance!.limitations=[...new Set([...metadata.declaration_provenance!.limitations,...pluginAnalysis.limitations])];
        if(!pluginAnalysis.inputVerified)continue;
      }
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
            const contract = this.capturedContract(contractPath);
            if (!contract) throw new Error("invalid_declaration_contract");
            const provenance = contextTrust.get(c.configuration)!;
            provenance.trust_status = "accepted"; provenance.assurance = "author-attested-and-structurally-checked";
            provenance.contract_paths = [sanitizeExternalText(path.relative(this.boundary, contractPath))];
            const needsCatalogTrust = contract.catalogPolicy === "explicit-local-v1" || ((d.adapterVersion === 4 || d.adapterVersion === 5) && d.catalogAdditions.length > 0);
            if (needsCatalogTrust) {
              provenance.catalog_trust_status = this.catalogTrust ? "accepted" : "disabled";
              metadata.declaration_provenance!.catalog_trust_model = CATALOG_MODEL;
            }
            const declarations = pluginAnalysis&&!pluginAnalysis.declarationsComplete?{sources:new Map<string,Set<string>>(),reasons:pluginAnalysis.reasons}:needsCatalogTrust && !this.catalogTrust ? { sources: new Map<string, Set<string>>(), reasons: [this.catalogTrustInvalid ? "catalog_trust_config_invalid" : "catalog_trust_disabled"] } :
              analyzeDeclarations(c, candidate.graph, contract, this.declarationBudget, models,pluginAnalysis);
            metadata.reasons.push(...declarations.reasons);
            if (declarations.reasons.includes("declaration_assertion_missing") || declarations.reasons.includes("provider_stability_assertion_missing") || declarations.reasons.includes("catalog_scope_assertion_missing")) {
              provenance.trust_status = "missing_assertion"; provenance.assurance = null;
            }
            if (needsCatalogTrust && declarations.reasons.includes("catalog_scope_assertion_missing")) provenance.catalog_trust_status = "missing_assertion";
            if(pluginAnalysis&&!pluginAnalysis.declarationsComplete&&(pluginAnalysis.status==='invalid'||pluginAnalysis.status==='missing_assertion')){provenance.trust_status=pluginAnalysis.status==='invalid'?'invalid':'missing_assertion';provenance.assurance=null;}
            if(pluginAnalysis?.declarationsComplete)provenance.assurance=pluginAnalysis.assurance;
            const adopted = provenance.trust_status === "accepted" && !declarations.reasons.length;
            if (adopted) {
              declarationContexts.add(c.configuration);
              if ((d.adapterVersion === 3 || d.adapterVersion === 4 || d.adapterVersion === 5) && d.records.some(r => "registrationKind" in r && r.registrationKind !== "synchronous")) {
                const limitations = metadata.declaration_provenance!.limitations;
                for (const limitation of ["provider_evaluations_outside_materialization_not_observable", "provider_stability_author_asserted"]) {
                  if (!limitations.includes(limitation)) limitations.push(limitation);
                }
              }
              if ((d.adapterVersion === 4 || d.adapterVersion === 5) && d.catalogAdditions.some(g => g.kind === "bundle") && !metadata.declaration_provenance!.limitations.includes("bundle_materialization_boundaries_not_observable")) {
                metadata.declaration_provenance!.limitations.push("bundle_materialization_boundaries_not_observable");
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
      provenance.assurance = provenance.trust_status === "accepted" ? contexts.some(c=>c.assurance==="author-attested-loader-and-structurally-checked")?"author-attested-loader-and-structurally-checked":"author-attested-and-structurally-checked" : null;
      provenance.contract_paths = [...new Set(contexts.flatMap(c => c.contract_paths))].sort();
      const catalogContexts = contexts.filter(c => c.catalog_trust_status !== undefined);
      if (catalogContexts.length) provenance.catalog_trust_status = catalogContexts.some(c => c.catalog_trust_status === "disabled") ? "disabled" :
        catalogContexts.some(c => c.catalog_trust_status === "missing_assertion") ? "missing_assertion" : "accepted";
      const pluginContexts=contexts.filter(c=>c.plugin_trust_status);
      if(pluginContexts.length){const rank:PluginStatus[]=['invalid','unverifiable','disabled_for_required_policy','missing_assertion','accepted'];provenance.plugin_trust_status=!this.trust||!this.pluginSettings.trust?'disabled':rank.find(s=>pluginContexts.some(c=>c.plugin_trust_status===s))??'missing_assertion';}
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
