import { MAX_DEPENDENCY_EDGES, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";
import { parseNpmLock, type NpmLockWorkBudget } from "./npmLockCopy.js";

export interface ComposerRelationPackage {
  name: string;
  version: string;
  requires: string[] | null;
  aliases: string[] | null;
}
export interface ComposerRelationBudget { remaining: number }
export const createComposerRelationBudget = (): ComposerRelationBudget => ({ remaining: MAX_DEPENDENCY_EDGES });
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const composerPackageName = (v: unknown): v is string => typeof v === "string" && v.length <= 200 && /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(v);

/** Platform requirements such as php, ext-json and lib-* are not package edges. */
export function composerLinkNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!record(value)) return null;
  const names: string[] = [];
  for (const [name, constraint] of Object.entries(value)) {
    if (typeof constraint !== "string") return null;
    const looksLikePackage = name.includes("/");
    if (composerPackageName(name)) names.push(name);
    else if (looksLikePackage) return null;
  }
  return names;
}

/** Analyze only the captured companion manifest, never another root or a path repository's URL. */
export function composerRootRequirements(text: string, budget?: NpmLockWorkBudget): string[] | null {
  const root = parseNpmLock(text, budget);
  if (!record(root)) return null;
  const production = composerLinkNames(root.require), dev = composerLinkNames(root["require-dev"]);
  return production === null || dev === null ? null : [...new Set([...production, ...dev])];
}

/** Name-based reachability of the locked solution, not a Composer constraint solver.
 * require-dev is root-only; suggest/conflict/replace/provide are not dependency edges.
 * Provider/replacement ambiguity and duplicate installed names are never guessed.
 */
export function composerRelations(
  packages: readonly ComposerRelationPackage[],
  roots: readonly string[],
  budget = createComposerRelationBudget(),
): RelationLookup {
  const charge = () => --budget.remaining >= 0;
  const byName = new Map<string, ComposerRelationPackage | null>();
  const aliased = new Set<string>();
  for (const pkg of packages) {
    if (!charge() || pkg.aliases === null) return null;
    byName.set(pkg.name, byName.has(pkg.name) ? null : pkg);
    for (const alias of pkg.aliases) { if (!charge()) return null; if (alias !== pkg.name) aliased.add(alias); }
  }
  const resolve = (name: string) => aliased.has(name) ? null : byName.get(name) ?? null;
  const direct = new Set<string>();
  for (const name of roots) {
    if (!charge()) return null;
    if (resolve(name)) direct.add(name);
  }
  const introduced = new Map<string, Set<string>>();
  for (const origin of direct) {
    const visited = new Set([origin]);
    const queue = [origin];
    while (queue.length > 0) {
      if (!charge()) return null;
      const current = resolve(queue.pop()!);
      for (const name of current?.requires ?? []) {
        if (!charge()) return null;
        const target = resolve(name);
        if (!target || visited.has(name)) continue;
        visited.add(name); queue.push(name);
        let sources = introduced.get(name);
        if (!sources) introduced.set(name, sources = new Set());
        sources.add(origin);
      }
    }
  }
  const results = new Map<string, RelationInfo>();
  for (const [name, pkg] of byName) {
    if (!charge()) return null;
    if (!pkg || aliased.has(name)) continue;
    const sources = introduced.get(name);
    results.set(JSON.stringify([name, pkg.version]), {
      relation: direct.has(name) ? "direct" : sources ? "transitive" : "unknown",
      ...(direct.has(name) ? { declaredIn: new Set(["composer.json"]) } : {}),
      ...(sources ? { introducedBy: sources } : {}),
    });
  }
  return (name, version) => results.get(JSON.stringify([name, version])) ?? { relation: "unknown" };
}
