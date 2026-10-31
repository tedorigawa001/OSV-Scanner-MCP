import { parse as parseToml } from "smol-toml";
import type { DeclarationContract, Declarations } from "./gradleDeclarations.js";
import type { GradleGraph, GradleBudget } from "./gradleGraph.js";

export const normalizedCatalogAlias = (alias: string) => alias.replace(/[-_]/g, ".");
interface Library { module: string; simple: boolean }
interface CatalogModel { libraries: Map<string, Library>; bundles: Map<string, string[]> }
export type CatalogModels = Map<string, CatalogModel>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
function tick(budget: GradleBudget) { if (--budget.index < 0) throw new Error("catalog_budget_exceeded"); }
function aliases<T>(entries: Record<string, T>, budget: GradleBudget): Map<string, T> {
  const result = new Map<string, T>();
  for (const [name, value] of Object.entries(entries)) {
    tick(budget); const key = normalizedCatalogAlias(name);
    if (!name || name.length > 1024 || result.has(key)) throw new Error("invalid_catalog_alias");
    result.set(key, value);
  }
  return result;
}
/**
 * The captured inputs are verified, but their content is a catalog shape or size this reader does not model.
 * Only declaration sources depend on the model, so callers keep the verified graph relations.
 */
export class UnsupportedCatalogModel extends Error {
  constructor(readonly reason: string) { super(reason); }
}
/** Inputs are already safely captured and hash-checked by the shared scan cache. */
export function loadCatalogModels(contract: DeclarationContract, graph: GradleGraph, bytes: Map<string, Buffer>, budget: GradleBudget): CatalogModels {
  const models: CatalogModels = new Map();
  if (contract.contractVersion !== 2) throw new Error("catalog_contract_missing");
  const inputs = new Map(graph.inputs.files.map(f => [f.path, f]));
  let unsupported: UnsupportedCatalogModel | undefined;
  for (const cat of contract.catalogs) {
    tick(budget);
    if (cat.kind !== "local-toml" || cat.tomlPaths.length !== 1 ||
      !cat.inputPaths.some(p => (p === "settings.gradle" || p === "settings.gradle.kts") && bytes.has(p)) ||
      cat.inputPaths.some(p => { tick(budget); return !inputs.has(p) || ("sha256" in inputs.get(p)! && !bytes.has(p)); })) throw new Error("catalog_graph_inputs_unverifiable");
    const raw = bytes.get(cat.tomlPaths[0]!); if (!raw) throw new Error("catalog_graph_inputs_unverifiable");
    // TOML that does not parse cannot be what Gradle built the exported graph from, so it stays an input failure.
    const toml = parseToml(raw.toString("utf8"));
    try { models.set(cat.id, catalogModel(cat, toml, budget)); }
    // Keep checking the remaining catalogs: their unverified inputs must still reject the graph.
    catch (error) { unsupported ??= new UnsupportedCatalogModel(error instanceof Error ? error.message : "invalid_catalog_model"); }
  }
  if (unsupported) throw unsupported;
  return models;
}
function catalogModel(cat: Extract<DeclarationContract, { contractVersion: 2 }>["catalogs"][number], toml: Record<string, unknown>, budget: GradleBudget): CatalogModel {
  if (!object(toml.libraries ?? {}) || !object(toml.bundles ?? {}) || !object(toml.versions ?? {})) throw new Error("invalid_catalog_model");
  const versions = aliases(toml.versions as Record<string, unknown> ?? {}, budget);
  const libraries = new Map<string, Library>();
  for (const [name, value] of aliases(toml.libraries as Record<string, unknown> ?? {}, budget)) {
    let module: string, version: unknown;
    if (typeof value === "string") {
      const parts = value.split(":"); if (parts.length !== 3) throw new Error("invalid_catalog_library");
      module = parts.slice(0, 2).join(":"); version = parts[2];
    } else if (object(value)) {
      module = typeof value.module === "string" ? value.module : typeof value.group === "string" && typeof value.name === "string" ? `${value.group}:${value.name}` : "";
      version = value.version;
    } else throw new Error("invalid_catalog_library");
    if (!/^[^:\s]+:[^:\s]+$/.test(module) || module.length > 2049) throw new Error("invalid_catalog_library");
    if (object(version) && Object.keys(version).length === 1 && typeof version.ref === "string") {
      if (!versions.has(normalizedCatalogAlias(version.ref))) throw new Error("invalid_catalog_version_reference");
      version = versions.get(normalizedCatalogAlias(version.ref));
    }
    libraries.set(name, { module, simple: version === undefined || typeof version === "string" });
  }
  const bundles = new Map<string, string[]>();
  for (const [name, value] of aliases(toml.bundles as Record<string, unknown> ?? {}, budget)) {
    if (!Array.isArray(value) || value.length > 128 || value.some(v => typeof v !== "string" || !libraries.has(normalizedCatalogAlias(v)))) throw new Error("invalid_catalog_bundle");
    for (const _ of value) tick(budget);
    bundles.set(name, value.map(v => normalizedCatalogAlias(v as string)));
  }
  const expected = aliases(cat.bundleMembers, budget);
  if (expected.size !== bundles.size) throw new Error("catalog_bundle_manifest_mismatch");
  for (const [name, refs] of expected) {
    if (JSON.stringify(refs.map(normalizedCatalogAlias)) !== JSON.stringify(bundles.get(name))) throw new Error("catalog_bundle_manifest_mismatch");
  }
  return { libraries, bundles };
}

export function catalogEntriesMatch(entries: { id: string; kind: string; graphInputPaths: string[] }[], contract: DeclarationContract, budget: GradleBudget): boolean {
  if (contract.contractVersion !== 2 || entries.length !== contract.catalogs.length) return false;
  const expected = new Map(contract.catalogs.map(c => [c.id, { kind: c.kind, paths: new Set(c.inputPaths.map(p => { tick(budget); return p; })) }]));
  return entries.every(e => {
    tick(budget); const c = expected.get(e.id);
    return c && e.kind === c.kind && e.graphInputPaths.length === c.paths.size &&
      new Set(e.graphInputPaths).size === e.graphInputPaths.length && e.graphInputPaths.every(p => { tick(budget); return c.paths.has(p); });
  });
}

/** Recompute all group/member evidence. Callback order never identifies an alias. */
export function validateCatalogGroups(d: Extract<Declarations, { adapterVersion: 4 }>, contract: DeclarationContract,
  scopeId: string, models: CatalogModels | undefined, budget: GradleBudget): string | undefined {
  const records = new Map(d.records.map(r => { tick(budget); return [r.id, r] as const; }));
  const groupIds = new Set<string>(), members = new Set<string>();
  const scope = contract.scopes.find(s => s.id === scopeId);
  for (const group of d.catalogAdditions) {
    tick(budget);
    if (contract.contractVersion !== 2 || !scope || !("catalogIds" in scope) || !Array.isArray(scope.catalogIds) || !scope.catalogIds.includes(group.catalogInputId)) return "catalog_scope_assertion_missing";
    const model = models?.get(group.catalogInputId), alias = normalizedCatalogAlias(group.alias);
    if (!model || group.normalizedAlias !== alias || groupIds.has(group.id) || !group.observationComplete || group.reasons.length ||
      !group.source || !group.memberIds.length || new Set(group.memberIds).size !== group.memberIds.length) return "catalog_observation_incomplete";
    groupIds.add(group.id);
    const refs = group.kind === "library" ? [alias] : model.bundles.get(alias);
    if (!refs || !refs.length || (group.kind === "library" ? group.memberIds.length !== 1 : group.callbackCount !== refs.length || group.memberIds.length !== refs.length)) return "catalog_observation_incomplete";
    const expected = refs.map(ref => model.libraries.get(ref));
    if (expected.some(l => !l || !l.simple)) return "unsupported_catalog_version";
    const modules = new Map<string, number>();
    for (const library of expected) { tick(budget); modules.set(library!.module, (modules.get(library!.module) ?? 0) + 1); }
    for (const id of group.memberIds) {
      tick(budget); const r = records.get(id);
      if (!r || members.has(id) || r.catalogGroupId !== group.id || r.ownerProjectId !== group.ownerProjectId || r.configuration !== group.configuration ||
        JSON.stringify(r.source) !== JSON.stringify(group.source) || r.registrationForm !== group.registrationForm ||
        (group.kind === "bundle" ? r.registrationKind !== "bundle-member" || r.callbackCount !== 1 : r.registrationKind !== "provider" || r.callbackCount !== group.callbackCount) ||
        r.catalogUses.length !== 1 || r.catalogUses[0]!.catalogInputId !== group.catalogInputId || r.catalogUses[0]!.alias !== group.alias) return "catalog_observation_incomplete";
      const k = r.materializations[0]?.key;
      if (!k || k.status !== "supported") return "unsupported_resolution_key";
      const module = `${k.group}:${k.name}`, count = modules.get(module) ?? 0;
      if (!count) return "catalog_member_mismatch";
      modules.set(module, count - 1); members.add(id);
    }
    if ([...modules.values()].some(n => n !== 0)) return "catalog_member_mismatch";
  }
  for (const r of d.records) {
    tick(budget);
    if ((r.catalogGroupId !== null || r.catalogUses.length || r.registrationKind === "bundle-member") && !members.has(r.id)) return "catalog_observation_incomplete";
    if ((r.registrationKind === "synchronous") !== (r.registrationForm === "synchronous")) return "catalog_observation_incomplete";
  }
}
