import { MAX_DEPENDENCY_EDGES, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";
import { compareNugetVersions, parseNugetVersion } from "./nugetVersion.js";

export interface NugetGraphNode {
  name: string;
  version: string;
  lookupName?: string;
  direct: boolean;
  dependencies: { name: string; version?: string }[] | null;
}
export type NugetGraph = NugetGraphNode[];
export interface NugetGraphBudget { remaining: number }
export const createNugetGraphBudget = (): NugetGraphBudget => ({ remaining: MAX_DEPENDENCY_EDGES });
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";
const split = (key: string) => { const i = key.lastIndexOf("/"); return i > 0 ? { name: key.slice(0, i), version: key.slice(i + 1) } : null; };
const dependencyList = (v: unknown, exact = false): NugetGraphNode["dependencies"] => {
  if (v === undefined) return [];
  if (!record(v)) return null;
  const dependencies: NonNullable<NugetGraphNode["dependencies"]> = [];
  for (const [name, version] of Object.entries(v)) {
    if (typeof version !== "string") return null;
    dependencies.push({ name, ...(exact ? { version } : {}) });
  }
  return dependencies;
};

/** One graph per locked TFM/RID; range constraints are not solved again. */
export function nugetLockGraphs(data: Record<string, unknown>): NugetGraph[] {
  if (!record(data.dependencies)) return [];
  return Object.values(data.dependencies).filter(record).map(framework => Object.entries(framework).flatMap(([name, raw]) => {
    if (!record(raw) || !["Direct", "Transitive", "CentralTransitive", "Project"].includes(text(raw.type))) return [];
    return [{ name, version: text(raw.resolved), direct: raw.type === "Direct", dependencies: dependencyList(raw.dependencies) }];
  }));
}

/** Graphs remain separated by target; deps.json dependencies carry exact versions. */
export function nugetTargetGraphs(data: Record<string, unknown>, kind: "assets" | "deps"): NugetGraph[] {
  if (!record(data.targets)) return [];
  const libraries = record(data.libraries) ? data.libraries : {};
  const project = record(data.project) ? data.project : {};
  const frameworks = record(project.frameworks) ? project.frameworks : {};
  const frameworkIndex = new Map<string, Record<string, unknown> | null>();
  for (const [key, value] of Object.entries(frameworks)) {
    if (!record(value)) continue;
    for (const alias of new Set([key.toLowerCase(), text(value.targetAlias).toLowerCase()].filter(Boolean))) {
      frameworkIndex.set(alias, frameworkIndex.has(alias) && frameworkIndex.get(alias) !== value ? null : value);
    }
  }
  const graphs: NugetGraph[] = [];
  for (const [targetName, rawTarget] of Object.entries(data.targets)) {
    if (!record(rawTarget)) continue;
    const base = targetName.split("/")[0]!.toLowerCase();
    const framework = frameworkIndex.get(base);
    const direct = new Set(kind === "assets" && framework && record(framework.dependencies) ? Object.keys(framework.dependencies).map(n => n.toLowerCase()) : []);
    const nodes: NugetGraph = [];
    const projectDependencies: NonNullable<NugetGraphNode["dependencies"]> = [];
    for (const [key, raw] of Object.entries(rawTarget)) {
      const id = split(key), library = record(libraries[key]) ? libraries[key] : null;
      if (!id || !record(raw)) continue;
      const type = kind === "assets" ? text(raw.type) : text(library?.type);
      if (!["package", "runtimepack", "project", "reference"].includes(type)) continue;
      const name = type === "runtimepack" && id.name.toLowerCase().startsWith("runtimepack.") ? id.name.slice("runtimepack.".length) : id.name;
      const dependencies = dependencyList(raw.dependencies, kind === "deps");
      if (kind === "deps" && type === "project" && dependencies) {
        for (const dependency of dependencies) projectDependencies.push(dependency);
      }
      nodes.push({ name, version: id.version, lookupName: id.name, direct: (type === "package" || type === "runtimepack") && direct.has(name.toLowerCase()), dependencies });
    }
    if (kind === "deps") {
      const roots = new Set<string>();
      for (const dep of projectDependencies) {
        if (parseNugetVersion(dep.version!)) roots.add(nugetGraphKey(dep.name, dep.version!));
      }
      for (const node of nodes) {
        const library = libraries[`${node.lookupName}/${node.version}`];
        const type = record(library) ? library.type : null;
        if (type !== "package" && type !== "runtimepack") continue;
        node.direct = parseNugetVersion(node.version) !== null && roots.has(nugetGraphKey(node.name, node.version));
      }
    }
    graphs.push(nodes);
  }
  return graphs;
}

/** Exact package identity for merging target-specific reachability without crossing versions. */
export function nugetGraphKey(name: string, version: string): string {
  const parsed = parseNugetVersion(version);
  return JSON.stringify([name.toLowerCase(), parsed ? [parsed.parts, parsed.prerelease] : version]);
}

/** Metadata enrichment only. Existing direct/transitive classification remains authoritative. */
export function nugetGraphOrigins(graphs: readonly NugetGraph[], budget: NugetGraphBudget): Map<string, Set<string>> | null {
  const introduced = new Map<string, Set<string>>();
  const displayNames = new Map<string, string>();
  const tick = () => --budget.remaining >= 0;
  for (const nodes of graphs) {
    const names = new Map<string, NugetGraphNode[]>();
    for (const node of nodes) {
      if (!tick()) return null;
      for (const name of new Set([node.name.toLowerCase(), (node.lookupName ?? node.name).toLowerCase()])) {
        const entries = names.get(name) ?? []; entries.push(node); names.set(name, entries);
      }
    }
    const resolve = (dep: { name: string; version?: string }): NugetGraphNode | null => {
      const entries = names.get(dep.name.toLowerCase()) ?? [];
      if (dep.version === undefined) return entries.length === 1 ? entries[0]! : null;
      let selected: NugetGraphNode | null = null;
      for (const entry of entries) {
        if (!tick()) return null;
        if (parseNugetVersion(dep.version) && parseNugetVersion(entry.version) && compareNugetVersions(dep.version, entry.version) === 0) {
          if (selected) return null;
          selected = entry;
        }
      }
      return selected;
    };
    for (const origin of nodes) {
      if (!tick()) return null;
      if (!origin.direct || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(origin.name) || !parseNugetVersion(origin.version) || names.get(origin.name.toLowerCase())?.length !== 1) continue;
      const originKey = origin.name.toLowerCase();
      if (!displayNames.has(originKey)) displayNames.set(originKey, origin.name);
      const visited = new Set([origin]);
      const queue = [origin];
      while (queue.length) {
        if (!tick()) return null;
        for (const dep of queue.pop()!.dependencies ?? []) {
          if (!tick()) return null;
          const target = resolve(dep);
          if (budget.remaining < 0) return null;
          if (!target || visited.has(target)) continue;
          visited.add(target); queue.push(target);
          const key = nugetGraphKey(target.name, target.version);
          const sources = introduced.get(key) ?? new Set<string>();
          sources.add(displayNames.get(originKey)!); introduced.set(key, sources);
        }
      }
    }
  }
  return introduced;
}

export function enrichNugetRelations(base: RelationLookup, origins: Map<string, Set<string>> | null, declared: ReadonlyMap<string, string>): RelationLookup {
  return (name, version, type): RelationInfo => {
    const info = base?.(name, version, type) ?? { relation: "unknown" as const };
    const introducedBy = origins?.get(nugetGraphKey(name, version));
    const manifest = info.relation === "direct" ? declared.get(name.toLowerCase()) : undefined;
    return { ...info, ...(introducedBy?.size ? { introducedBy } : {}), ...(manifest ? { declaredIn: new Set([manifest]) } : {}) };
  };
}
