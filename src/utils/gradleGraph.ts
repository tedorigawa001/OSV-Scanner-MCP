/** Static Gradle graph contract. No build code is evaluated here. */
import { visit } from "jsonc-parser";
import { z } from "zod";
import type { RelationInfo, RelationLookup } from "./dependencyRelations.js";

const id = z.string().min(1).max(1024);
const atom = z.string().min(1).max(1024).regex(/^[^\s:=,\\/]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z.string().min(1).max(4096).refine(s => s === "." || (!s.startsWith("/") && !s.includes("\\") && !s.includes(":") && !/[\x00-\x1f\x7f]/.test(s) && s.split("/").every(p => p !== ".." && p !== "" && p !== ".")));
const requested = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("module"), group: atom, name: atom, selector: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal("project"), projectPath: id }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]);
const component = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("module"), group: atom, name: atom, version: atom }).strict(),
  z.object({ id, kind: z.literal("project"), projectId: id }).strict(),
]);
const context = z.object({
  id, projectId: id, kind: z.enum(["project", "buildscript"]), configuration: id,
  lockfileId: id, lockConfiguration: id, complete: z.boolean(), rootVariant: id,
  components: z.array(component).max(100_000),
  variants: z.array(z.object({ id, componentId: id }).strict()).max(200_000),
  edges: z.array(z.object({ fromVariant: id, selectedVariant: id, constraint: z.boolean(), requested,
    selectionReasons: z.array(z.string().max(128)).max(32).optional() }).strict()).max(200_000),
  unresolved: z.array(z.object({ fromVariant: id, requested, reason: z.enum(["resolution_failed", "unsupported_identity", "unsupported_variant"]) }).strict()).max(200_000),
  unrepresentedDependencies: z.array(z.object({ kind: z.enum(["file", "source", "unsupported"]), count: z.number().int().positive() }).strict()).max(32),
  // Stage B never claims physical declaration locations.
  declarationEvidence: z.array(z.never()).max(0),
  reasons: z.array(z.string().max(128)).max(128).optional(),
}).strict();
const schema = z.object({
  schema: z.literal("osv-mcp.gradle-graph"), schemaVersion: z.literal(1),
  producer: z.object({ exporterVersion: id, gradleVersion: id }).strict(),
  lockfiles: z.array(z.object({ id, path: relative, sha256: hash }).strict()).max(2000),
  projects: z.array(z.object({ id, buildId: id, projectPath: id, directory: relative, ownerBuildFile: relative }).strict()).max(2000),
  // absent: a candidate the exporter saw missing; creating it later makes the export stale.
  inputs: z.object({ complete: z.boolean(), files: z.array(z.union([z.object({ path: relative, sha256: hash }).strict(), z.object({ path: relative, absent: z.literal(true) }).strict()])).max(10_000) }).strict(),
  contexts: z.array(context).max(2000),
}).strict();
export type GradleGraph = z.infer<typeof schema>;
export type GradleContext = GradleGraph["contexts"][number];
export interface GradleBudget { index: number; traversal: number }
export function createGradleBudget(): GradleBudget { return { index: 2_000_000, traversal: 2_000_000 }; }
function spend(b: GradleBudget, key: keyof GradleBudget) { if (--b[key] < 0) throw new Error("graph_budget_exceeded"); }
function unique<T extends { id: string }>(items: T[]): Map<string, T> {
  const map = new Map(items.map(v => [v.id, v]));
  if (map.size !== items.length) throw new Error("duplicate_id");
  return map;
}
export function parseGradleGraph(text: string, budget = createGradleBudget()): GradleGraph {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("graph_size_limit");
  // Validate depth and duplicate keys before JSON.parse/zod recurse into untrusted input.
  const stack: (Set<string> | null)[] = [];
  const enter = (object: boolean) => { if (stack.length >= 128) throw new Error("graph_depth_limit"); stack.push(object ? new Set() : null); };
  visit(text, { onObjectBegin: () => enter(true), onArrayBegin: () => enter(false),
    onObjectProperty: key => { const keys = stack.at(-1); if (keys?.has(key)) throw new Error("duplicate_json_key"); keys?.add(key); },
    onObjectEnd: () => { stack.pop(); }, onArrayEnd: () => { stack.pop(); },
    onError: () => { throw new Error("invalid_json"); },
  }, { disallowComments: true, allowTrailingComma: false });
  const graph = schema.parse(JSON.parse(text));
  const locks = unique(graph.lockfiles), projects = unique(graph.projects);
  unique(graph.contexts);
  if (new Set(graph.lockfiles.map(l => l.path)).size !== graph.lockfiles.length ||
      new Set(graph.inputs.files.map(f => f.path)).size !== graph.inputs.files.length) throw new Error("duplicate_path");
  const contexts = new Set<string>();
  for (const c of graph.contexts) {
    const key = JSON.stringify([c.projectId, c.kind, c.configuration]);
    if (contexts.has(key) || !locks.has(c.lockfileId) || !projects.has(c.projectId) || c.configuration !== c.lockConfiguration) throw new Error("invalid_context_mapping");
    contexts.add(key);
    const cs = unique(c.components), vs = unique(c.variants);
    const root = vs.get(c.rootVariant);
    const rootComponent = root && cs.get(root.componentId);
    if (rootComponent?.kind !== "project" || rootComponent.projectId !== c.projectId) throw new Error("invalid_root");
    for (const v of vs.values()) { spend(budget, "index"); if (!cs.has(v.componentId)) throw new Error("dangling_variant"); }
    for (const v of cs.values()) { spend(budget, "index"); if (v.kind === "project" && !projects.has(v.projectId)) throw new Error("unknown_project"); }
    for (const e of c.edges) { spend(budget, "index"); if (!vs.has(e.fromVariant) || !vs.has(e.selectedVariant)) throw new Error("dangling_edge"); }
    for (const e of c.unresolved) { spend(budget, "index"); if (!vs.has(e.fromVariant)) throw new Error("dangling_unresolved"); }
  }
  return graph;
}
export type GradleLock = Map<string, Set<string>>;
export const gradleKey = (name: string, version: string) => JSON.stringify([name, version]);
export function parseGradleLock(text: string): GradleLock {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error("lock_size_limit");
  const result: GradleLock = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(empty|[^\s:=,]+:[^\s:=,]+:[^\s:=,]+)=([^\s=]*)$/.exec(line);
    if (!match) throw new Error("invalid_lock_entry");
    if (!match[2] && match[1] !== "empty") throw new Error("invalid_lock_configuration");
    const gav = match[1]!, pos = gav.lastIndexOf(":");
    const key = gav === "empty" ? null : gradleKey(gav.slice(0, pos), gav.slice(pos + 1));
    for (const configuration of match[2]!.split(",").filter(Boolean)) {
      let entries = result.get(configuration);
      if (!entries) result.set(configuration, entries = new Set());
      if (key !== null) { if (entries.has(key)) throw new Error("duplicate_lock_entry"); entries.add(key); }
    }
  }
  return result;
}
export function analyzeGradleContext(c: GradleContext, lock: GradleLock, budget = createGradleBudget()): {
  lookup: RelationLookup; coverageReasons: string[]; reasons: string[];
} {
  const components = new Map(c.components.map(v => [v.id, v]));
  const variants = new Map(c.variants.map(v => [v.id, components.get(v.componentId)!]));
  const locked = lock.get(c.lockConfiguration);
  const selected = new Set(c.components.flatMap(v => v.kind === "module" ? [gradleKey(`${v.group}:${v.name}`, v.version)] : []));
  const coverageReasons: string[] = [];
  if ([...selected].some(k => !locked?.has(k))) coverageReasons.push("graph_modules_missing_from_lock");
  if (c.unresolved.length) coverageReasons.push("unresolved_dependencies");
  if (c.unrepresentedDependencies.length) coverageReasons.push("unrepresented_dependencies");
  if (!locked) return { lookup: null, coverageReasons, reasons: ["configuration_not_locked"] };
  const matching = selected.size === locked.size && [...locked].every(k => selected.has(k));
  const complete = c.complete && !c.unresolved.length && !c.unrepresentedDependencies.length && matching;
  if (!matching) return { lookup: null, coverageReasons, reasons: ["lock_projection_mismatch"] };
  try {
    const adjacency = new Map<string, string[]>();
    for (const e of c.edges) { spend(budget, "traversal"); if (!e.constraint) { const list = adjacency.get(e.fromVariant) ?? []; list.push(e.selectedVariant); adjacency.set(e.fromVariant, list); } }
    const direct = new Set<string>(), reached = new Set<string>(), origins = new Map<string, Set<string>>();
    const keyOf = (v: string) => { const p = variants.get(v)!; return p.kind === "module" ? gradleKey(`${p.group}:${p.name}`, p.version) : null; };
    for (const v of adjacency.get(c.rootVariant) ?? []) { const k = keyOf(v); if (k) direct.add(k); }
    // Walk once for relation reachability (including project-only paths).
    const queue = [...(adjacency.get(c.rootVariant) ?? [])], seen = new Set<string>();
    for (let i = 0; i < queue.length; i++) {
      spend(budget, "traversal"); const v = queue[i]!; if (seen.has(v)) continue; seen.add(v);
      const k = keyOf(v); if (k) reached.add(k);
      for (const child of adjacency.get(v) ?? []) queue.push(child);
    }
    // Each origin/variant pair is visited at most once, sharing the scan budget.
    for (const root of adjacency.get(c.rootVariant) ?? []) {
      const p = variants.get(root)!; if (p.kind !== "module") continue;
      const name = `${p.group}:${p.name}`, originKey = keyOf(root);
      const visited = new Set<string>(), pending = [root];
      for (let i = 0; i < pending.length; i++) {
        spend(budget, "traversal"); const v = pending[i]!; if (visited.has(v)) continue; visited.add(v);
        const k = keyOf(v); if (k && k !== originKey) { const by = origins.get(k) ?? new Set<string>(); by.add(name); origins.set(k, by); }
        for (const child of adjacency.get(v) ?? []) pending.push(child);
      }
    }
    // Paths through a project dependency have no public module origin; modules on them never get a complete origin list.
    const viaProject = new Set<string>(), projectPending = (adjacency.get(c.rootVariant) ?? []).filter(v => variants.get(v)!.kind === "project"), projectSeen = new Set<string>();
    for (let i = 0; i < projectPending.length; i++) {
      spend(budget, "traversal"); const v = projectPending[i]!; if (projectSeen.has(v)) continue; projectSeen.add(v);
      const k = keyOf(v); if (k) viaProject.add(k);
      for (const child of adjacency.get(v) ?? []) projectPending.push(child);
    }
    return { coverageReasons, reasons: complete ? (reached.size === selected.size ? [] : ["unreachable_modules"]) : ["incomplete_context"], lookup: (name, version): RelationInfo => {
      const k = gradleKey(name, version);
      return { relation: direct.has(k) ? "direct" : complete && reached.has(k) ? "transitive" : "unknown",
        ...(complete && origins.has(k) ? { introducedBy: origins.get(k) } : {}),
        introducedByComplete: complete && reached.has(k) && !viaProject.has(k), declaredInComplete: complete && reached.has(k) && !direct.has(k) };
    } };
  } catch { return { lookup: null, coverageReasons, reasons: ["relationship_budget_exceeded"] }; }
}
