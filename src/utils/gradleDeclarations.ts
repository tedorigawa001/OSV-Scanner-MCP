import { validateCatalogGroups } from "./gradleCatalogs.js";
import { z } from "zod";
import { parseGradleJson } from "./gradleJson.js";
import type { GradleContext, GradleGraph, GradleBudget } from "./gradleGraph.js";
export const DECLARATION_CONTRACT = "osv-mcp-gradle-declarations.json";
export const DECLARATION_MODEL = "registered-helper-v1";
export type DeclarationTrust = typeof DECLARATION_MODEL | undefined;
export const DECLARATION_TRUST_ENV = "OSV_MCP_GRADLE_DECLARATION_TRUST";
/** invalid: an unknown value, treated as disabled (fail closed) instead of stopping the server. */
export interface DeclarationTrustConfig { trust: DeclarationTrust; invalid: boolean }
export function parseDeclarationTrust(value: string | undefined): DeclarationTrustConfig {
  if (value === undefined || value === "") return { trust: undefined, invalid: false };
  return value === DECLARATION_MODEL ? { trust: value, invalid: false } : { trust: undefined, invalid: true };
}
export const CATALOG_TRUST_ENV = "OSV_MCP_GRADLE_CATALOG_TRUST";
export const CATALOG_MODEL = "local-catalog-inputs-v1";
export type CatalogTrust = typeof CATALOG_MODEL | undefined;
export interface CatalogTrustConfig { trust: CatalogTrust; invalid: boolean }
export function parseCatalogTrust(value: string | undefined): CatalogTrustConfig {
  if (value === undefined || value === "") return { trust: undefined, invalid: false };
  return value === CATALOG_MODEL ? { trust: value, invalid: false } : { trust: undefined, invalid: true };
}
let catalogStartupTrust: CatalogTrustConfig | undefined;
export function startupCatalogTrust(): CatalogTrustConfig { return catalogStartupTrust ??= parseCatalogTrust(process.env[CATALOG_TRUST_ENV]); }
let startupTrust: DeclarationTrustConfig | undefined;
/** Read once (at server startup) and fixed for the process; later environment changes are ignored. */
export function startupDeclarationTrust(): DeclarationTrustConfig {
  return startupTrust ??= parseDeclarationTrust(process.env[DECLARATION_TRUST_ENV]);
}
/** Tests only: forget the snapshot so that the next read sees a stubbed environment. */
export function resetDeclarationTrustForTests(): void { startupTrust = undefined; catalogStartupTrust = undefined; }
const id = z.string().min(1).max(1024), str = z.string().max(4096), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const declarationPath = z.string().min(1).max(4096).refine(s => !/[\\:\x00-\x1f\x7f]/.test(s) && s.split("/").every(p => p !== "" && p !== "." && p !== ".."));
const reason = z.string().min(1).max(128), reasons = z.array(reason).max(128);
const unsupported = z.object({ version: z.literal(1), status: z.literal("unsupported"), reason }).strict();
const attribute = z.object({ name: id, type: z.enum(["string", "boolean", "integer", "named"]),
  value: z.union([str, z.boolean(), z.number().int().safe(), z.object({ className: id, name: str }).strict()]) }).strict();
export const resolutionKeySchema = z.union([unsupported, z.object({ version: z.literal(1), status: z.literal("supported"), kind: z.literal("module"),
  group: id, name: id, versionConstraint: z.object({ required: str, preferred: str, strict: str, rejected: z.array(str).max(128), branch: str.nullable() }).strict(),
  attributes: z.array(attribute).max(128), capabilitySelectors: z.array(z.unknown()).max(128),
}).strict()]);
const shape = z.union([unsupported, z.object({ version: z.literal(1), status: z.literal("supported"), artifacts: z.array(z.unknown()).max(128),
  targetConfiguration: str.nullable(), endorseStrictVersions: z.boolean(), transitive: z.boolean(), excludes: z.array(z.unknown()).max(128) }).strict()]);
const snapshot = z.object({ key: resolutionKeySchema, shape }).strict();
const source = z.object({ kind: z.enum(["build-script", "applied-script", "convention-plugin"]), path: declarationPath, sha256: hash }).strict();
const recordFields = { id, state: z.enum(["materialized", "pending", "removed", "unsupported", "unregistered"]), ownerProjectId: id, configuration: id,
  declarationAtAdd: snapshot.nullable(), declarationAtResolve: snapshot.nullable(), source: source.nullable(),
  catalogUses: z.array(z.object({ catalogInputId: id, alias: id }).strict()).max(32), reasons };
const declarationFields = { inventoryComplete: z.boolean(),
  trust: z.object({ model: z.literal(DECLARATION_MODEL), contractPath: z.literal(DECLARATION_CONTRACT), contractSha256: hash, scopeId: id }).strict(),
  configurationClosure: z.array(id).max(2000),
  configurationTopology: z.array(z.object({ name: id, extendsFrom: z.array(id).max(2000), hasDependencies: z.boolean() }).strict()).max(2000),
  bindings: z.array(z.object({ edgeId: id, declarationIds: z.array(id).max(100_000), complete: z.boolean(), reasons }).strict()).max(200_000), reasons };
const declarationsV2 = z.object({ adapterVersion: z.literal(2), ...declarationFields,
  records: z.array(z.object(recordFields).strict()).max(100_000) }).strict();
const declarationsV3 = z.object({ adapterVersion: z.literal(3), ...declarationFields,
  records: z.array(z.object({ ...recordFields, registrationKind: z.enum(["synchronous", "provider"]),
    callbackCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    materializations: z.array(snapshot).max(128) }).strict()).max(100_000) }).strict();
const catalogAddition = z.object({ id, ownerProjectId: id, configuration: id, source: source.nullable(),
  catalogInputId: id, kind: z.enum(["library", "bundle"]), alias: id, normalizedAlias: id,
  registrationForm: z.enum(["provider", "provider-convertible"]), callbackCount: z.number().int().min(0).safe(),
  observationComplete: z.boolean(), memberIds: z.array(id).max(128), reasons }).strict();
const declarationsV4 = z.object({ adapterVersion: z.literal(4), ...declarationFields,
  catalogAdditions: z.array(catalogAddition).max(100_000),
  records: z.array(z.object({ ...recordFields, registrationKind: z.enum(["synchronous", "provider", "bundle-member"]),
    registrationForm: z.enum(["synchronous", "provider", "provider-convertible"]), catalogGroupId: id.nullable(),
    callbackCount: z.number().int().min(0).safe(), materializations: z.array(snapshot).max(128) }).strict()).max(100_000) }).strict();
export const declarationsSchema = z.union([declarationsV2, declarationsV3, declarationsV4]);
export const declarationEnvelope = z.union([declarationsSchema,
  z.object({ adapterVersion: z.number().int().refine(v => v !== 2 && v !== 3 && v !== 4) }).passthrough()]);
export const catalogSchema = z.object({ inventoryComplete: z.boolean(), entries: z.array(z.object({ id,
  kind: z.enum(["local-toml", "programmatic", "remote"]), state: z.enum(["verifiable", "unverifiable"]),
  graphInputPaths: z.array(declarationPath).max(10_000), reason: reason.nullable() }).strict()).max(10_000) }).strict();
export type Declarations = z.infer<typeof declarationsSchema>;
const scopeFields = { id, projectPath: id, resolvableConfiguration: id, declarationConfigurations: z.array(id).max(2000),
  assertion: z.literal("all-contributing-additions-use-helper"), mutationPolicy: z.literal("immutable-after-add"), providerPolicy: z.literal("stable-during-export").optional() };
const catalogManifest = z.object({ id, name: id, kind: z.enum(["local-toml", "programmatic", "remote"]),
  tomlPaths: z.array(declarationPath).max(1), inputPaths: z.array(declarationPath).min(1).max(10_000),
  constructionPolicy: z.literal("registered-inputs-only"), mutationPolicy: z.literal("immutable-during-export"),
  overridePolicy: z.enum(["none", "registered-local"]), inputCompletenessAssertion: z.literal("all-catalog-construction-inputs-listed"),
  bundleMembers: z.record(id, z.array(id).max(128)) }).strict();
const contractFields = { trustModel: z.literal(DECLARATION_MODEL), sources: z.array(declarationPath).max(10_000) };
const contractSchema = z.union([
  z.object({ ...contractFields, catalogPolicy: z.literal("none"), contractVersion: z.literal(1),
    scopes: z.array(z.object(scopeFields).strict()).max(2000) }).strict(),
  z.object({ ...contractFields, catalogPolicy: z.literal("explicit-local-v1"), contractVersion: z.literal(2),
    catalogs: z.array(catalogManifest).min(1).max(100), scopes: z.array(z.object({ ...scopeFields, catalogIds: z.array(id).max(100) }).strict()).max(2000) }).strict(),
]);
export type DeclarationContract = z.infer<typeof contractSchema>;
export function parseDeclarationContract(text: string): DeclarationContract {
  const c = contractSchema.parse(parseGradleJson(text, 4 * 1024 * 1024));
  if (new Set(c.sources).size !== c.sources.length || new Set(c.scopes.map(s => s.id)).size !== c.scopes.length ||
    new Set(c.scopes.map(s => JSON.stringify([s.projectPath, s.resolvableConfiguration]))).size !== c.scopes.length ||
    c.scopes.some(s => new Set(s.declarationConfigurations).size !== s.declarationConfigurations.length)) throw new Error("invalid_declaration_contract");
  if (c.contractVersion === 2) {
    const ids = new Set(c.catalogs.map(x => x.id));
    if (ids.size !== c.catalogs.length || new Set(c.catalogs.map(x => x.name)).size !== c.catalogs.length ||
      c.scopes.some(s => new Set(s.catalogIds).size !== s.catalogIds.length || s.catalogIds.some(x => !ids.has(x)))) throw new Error("invalid_catalog_manifest");
    let references = 0;
    for (const cat of c.catalogs) {
      if (new Set(cat.inputPaths).size !== cat.inputPaths.length || new Set(cat.tomlPaths).size !== cat.tomlPaths.length ||
        cat.tomlPaths.some(p => !p.endsWith(".versions.toml") || !cat.inputPaths.includes(p)) ||
        cat.inputPaths.some(p => !/\.(?:gradle(?:\.kts)?|versions\.toml|properties|kt|java|groovy)$/.test(p)) ||
        !cat.inputPaths.some(p => p === "settings.gradle" || p === "settings.gradle.kts") ||
        (cat.kind === "local-toml" && cat.tomlPaths.length !== 1) || Object.keys(cat.bundleMembers).length > 10_000) throw new Error("invalid_catalog_manifest");
      references += cat.inputPaths.length + Object.values(cat.bundleMembers).reduce((n, v) => n + v.length, 0);
      if (references > 100_000) throw new Error("catalog_manifest_budget_exceeded");
    }
  }
  return c;
}
export function knownDeclarations(c: GradleContext): Declarations | undefined {
  if (!("declarations" in c) || ![2, 3, 4].includes(c.declarations.adapterVersion)) return undefined;
  return c.declarations as Declarations;
}
export function catalogVerified(c: GradleContext, graph: GradleGraph): boolean {
  if (!("catalogInputs" in c)) return true;
  const inputs = new Set(graph.inputs.files.map(i => i.path));
  return c.catalogInputs.inventoryComplete && c.catalogInputs.entries.every(e => e.state === "verifiable" && e.kind !== "remote" && e.reason === null && e.graphInputPaths.length > 0 && e.graphInputPaths.every(p => inputs.has(p)));
}
function tick(budget: GradleBudget, field: "index" | "traversal" = "traversal") { if (--budget[field] < 0) throw new Error("declaration_budget_exceeded"); }
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b); // schemas fix object order; supported collections are empty
function supported(k: z.infer<typeof resolutionKeySchema>) {
  return k.status === "supported" && !k.attributes.length && !k.capabilitySelectors.length && !k.versionConstraint.preferred && !k.versionConstraint.strict && !k.versionConstraint.rejected.length && k.versionConstraint.branch === null;
}
/** Recompute bindings from all records; never trust producer complete=true alone. */
export function analyzeDeclarations(c: GradleContext, graph: GradleGraph, contract: DeclarationContract, budget: GradleBudget, catalogs?: import("./gradleCatalogs.js").CatalogModels): { sources: Map<string, Set<string>>; reasons: string[] } {
  const d = knownDeclarations(c), sources = new Map<string, Set<string>>();
  if (!d || !("catalogInputs" in c)) return { sources, reasons: ["unsupported_declaration_adapter"] };
  const fail = (r: string) => ({ sources: new Map<string, Set<string>>(), reasons: [r] });
  if (contract.contractVersion === 2 && d.adapterVersion !== 4) return fail("unsupported_catalog_adapter");
  if (c.catalogInputs.entries.length && (d.adapterVersion !== 4 || !catalogs)) return fail("declaration_inventory_incomplete");
  if (!d.inventoryComplete || d.reasons.length) return { sources, reasons: ["declaration_inventory_incomplete",
    ...d.reasons.filter(r => ["provider_stability_assertion_missing", "provider_unobserved", "provider_unstable", "provider_observation_incomplete", "catalog_scope_assertion_missing", "catalog_observation_incomplete"].includes(r))] };
  const project = graph.projects.find(p => p.id === c.projectId);
  const scope = contract.scopes.find(s => s.id === d.trust.scopeId);
  if (!scope || !project || project.buildId !== "main" || scope.projectPath !== project.projectPath || scope.resolvableConfiguration !== c.configuration) return fail("declaration_assertion_missing");
  const topology = new Map(d.configurationTopology.map(n => { tick(budget, "index"); return [n.name, n] as const; }));
  if (topology.size !== d.configurationTopology.length || new Set(d.configurationClosure).size !== d.configurationClosure.length) return fail("declaration_inventory_incomplete");
  const closure = new Set<string>(), queue = [c.configuration];
  for (let i=0; i<queue.length; i++) {
    tick(budget); const name = queue[i]!; if (closure.has(name)) continue;
    const node = topology.get(name); if (!node || new Set(node.extendsFrom).size !== node.extendsFrom.length) return fail("declaration_inventory_incomplete");
    closure.add(name); for (const parent of node.extendsFrom) { tick(budget); queue.push(parent); }
  }
  if (closure.size !== topology.size || closure.size !== d.configurationClosure.length || d.configurationClosure.some(n => !closure.has(n))) return fail("declaration_inventory_incomplete");
  const incoming = new Map([...topology.keys()].map(k => [k,0]));
  for (const n of topology.values()) for (const parent of n.extendsFrom) { tick(budget); incoming.set(parent,incoming.get(parent)!+1); }
  const ready = [...incoming].filter(([,n]) => n===0).map(([k]) => k);
  for (let i=0; i<ready.length; i++) for (const parent of topology.get(ready[i]!)!.extendsFrom) {
    tick(budget); const count = incoming.get(parent)!-1; incoming.set(parent,count); if(count===0) ready.push(parent);
  }
  if (ready.length!==topology.size) return fail("declaration_inventory_incomplete");
  const scoped = new Set(scope.declarationConfigurations), inputHashes = new Map(graph.inputs.files.filter(i => "sha256" in i).map(i => [i.path, i.sha256]));
  const prepared = new Set(contract.sources), catalogIds = new Set(c.catalogInputs.entries.map(e => e.id));
  for (const n of topology.values()) { tick(budget); if (n.hasDependencies && !scoped.has(n.name)) return fail("declaration_inventory_incomplete"); }
  const configsWithRecords = new Set<string>(), recordPaths = new Map<string, string>();
  const groups = new Map<string, string[]>(), recordIds = new Set<string>();
  for (const r of d.records) {
    tick(budget, "index");
    if (recordIds.has(r.id)) return fail("declaration_inventory_incomplete"); recordIds.add(r.id);
    if (r.state !== "materialized" || r.ownerProjectId !== c.projectId || !scoped.has(r.configuration) || !topology.get(r.configuration)?.hasDependencies || r.reasons.length) return fail("declaration_inventory_incomplete");
    let a = r.declarationAtAdd;
    if ("registrationKind" in r) {
      if (r.registrationKind === "provider" || r.registrationKind === "bundle-member") {
        if (scope.providerPolicy !== "stable-during-export") return fail("provider_stability_assertion_missing");
        if (r.declarationAtAdd !== null || r.callbackCount < 1 || r.callbackCount !== r.materializations.length) return fail("provider_observation_incomplete");
        a = r.materializations[0]!;
        for (const observation of r.materializations) { tick(budget); if (!equal(a, observation)) return fail("provider_unstable"); }
        if (r.registrationKind === "bundle-member" && r.callbackCount !== 1) return fail("catalog_observation_incomplete");
      } else if (r.callbackCount !== 0 || r.materializations.length) return fail("provider_observation_incomplete");
    }
    const after = r.declarationAtResolve;
    if (!a || !after || !equal(a, after)) return fail("declaration_mutation_detected");
    if (!supported(a.key) || a.shape.status !== "supported" || a.shape.artifacts.length || a.shape.targetConfiguration !== null || a.shape.endorseStrictVersions || !a.shape.transitive || a.shape.excludes.length) return fail("unsupported_declaration_shape");
    if (r.source?.kind === "convention-plugin") return fail("declaration_source_unverifiable");
    if (!r.source || !/\.gradle(?:\.kts)?$/.test(r.source.path) || !prepared.has(r.source.path) || inputHashes.get(r.source.path) !== r.source.sha256) return fail("declaration_source_unverifiable");
    for (const use of r.catalogUses) { tick(budget); if (!catalogIds.has(use.catalogInputId)) return fail("declaration_inventory_incomplete"); }
    configsWithRecords.add(r.configuration); recordPaths.set(r.id, r.source.path);
    const key = JSON.stringify(a.key); const list = groups.get(key) ?? []; list.push(r.id); groups.set(key, list);
  }
  for (const n of topology.values()) { tick(budget); if (n.hasDependencies && !configsWithRecords.has(n.name)) return fail("declaration_inventory_incomplete"); }
  if (d.adapterVersion === 4) {
    const catalogReasons = validateCatalogGroups(d, contract, scope.id, catalogs, budget);
    if (catalogReasons) return fail(catalogReasons);
  }
  const components = new Map(c.components.map(p => [p.id, p])), variants = new Map(c.variants.map(v => [v.id, v.componentId]));
  const bindings = new Map(d.bindings.map(b => { tick(budget, "index"); return [b.edgeId,b] as const; }));
  if (bindings.size !== d.bindings.length) return fail("ambiguous_declaration_binding");
  const boundRecords = new Set<string>(), usedBindings = new Set<string>();
  const selectedByKey = new Map<string, string>();
  for (const e of c.edges) {
    tick(budget); if (e.fromVariant !== c.rootVariant || e.constraint) continue;
    const p = components.get(variants.get(e.selectedVariant)!);
    if (!p || p.kind !== "module" || e.requested.kind !== "module" || !supported(e.resolutionKey)) return fail("unsupported_resolution_key");
    const k = e.resolutionKey; if (k.status !== "supported") return fail("unsupported_resolution_key");
    if (k.group !== e.requested.group || k.name !== e.requested.name || k.versionConstraint.required !== e.requested.selector || p.group !== k.group || p.name !== k.name) return fail("unsupported_substitution_mapping");
    const key = JSON.stringify(k), ids = groups.get(key), binding = bindings.get(e.id);
    if (!ids || !binding?.complete || binding.reasons.length || new Set(binding.declarationIds).size !== binding.declarationIds.length || ids.length !== binding.declarationIds.length) return fail("ambiguous_declaration_binding");
    const expected = new Set(ids);
    for (const id of binding.declarationIds) { tick(budget); if (!expected.has(id)) return fail("ambiguous_declaration_binding"); boundRecords.add(id); }
    const gav = JSON.stringify([`${p.group}:${p.name}`,p.version]);
    const selection = JSON.stringify([gav,e.selectedVariant]);
    if (selectedByKey.has(key) && selectedByKey.get(key) !== selection) return fail("ambiguous_declaration_binding");
    selectedByKey.set(key,selection); usedBindings.add(e.id);
    const paths = sources.get(gav) ?? new Set<string>();
    for (const id of ids) { tick(budget); paths.add(recordPaths.get(id)!); }
    sources.set(gav,paths);
  }
  if (usedBindings.size !== bindings.size || boundRecords.size !== recordIds.size) return fail("ambiguous_declaration_binding");
  return { sources, reasons: [] };
}
