import path from "node:path";
import { parseBoundedToml } from "./boundedToml.js";
import { comparePep440 } from "./pep440Version.js";
import { MAX_DEPENDENCY_EDGES, type RelationLookup } from "./dependencyRelations.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
const validName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(s);
const safePath = (s: string) => !!s && !path.posix.isAbsolute(s) && !path.win32.isAbsolute(s) && !/^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(s) && !s.split("/").includes("..");
/** A declared path, relative to its manifest directory, resolved inside the lock directory (siblings use ".."). */
const within = (directory: string, local: string): string | undefined => {
  if (!local || path.posix.isAbsolute(local) || path.win32.isAbsolute(local) || /^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(local)) return undefined;
  const resolved = path.posix.normalize(path.posix.join(directory, local)).replace(/\/$/, "");
  return resolved !== "." && safePath(resolved) ? resolved : undefined;
};
/** Poetry locks a path dependency as a table; only an unconditional {path, develop} edge is accepted. */
const localEdge = (edge: unknown, directory: string, target: string) => record(edge) && typeof edge.path === "string"
  && Object.keys(edge).every(key => key === "path" || key === "develop") && within(directory, edge.path) === target;
export interface PoetryManifest { path: string; data: Record<string, unknown> | null }
interface Declaration { name: string; local?: string; constraint?: string; external: boolean }
interface Declarations { name?: string; version?: string; runtime: Declaration[]; development: Declaration[]; runtimeComplete: boolean }
interface Node { name: string; version: string; raw: Record<string, unknown>; location?: string; registry: boolean }
export const createPoetryBudget = () => ({ remaining: MAX_DEPENDENCY_EDGES });

/** Read names without running Poetry, a build backend or a marker/constraint solver. */
function declarations(data: Record<string, unknown>, tick: () => void): Declarations {
  const project = record(data.project) ? data.project : {};
  const tool = record(data.tool) && record(data.tool.poetry) ? data.tool.poetry : {};
  const runtime: Declaration[] = [], development: Declaration[] = [];
  let runtimeComplete = true;
  if (project.dynamic !== undefined) {
    if (!Array.isArray(project.dynamic)) throw Error("invalid dynamic metadata");
    for (const field of project.dynamic) {
      tick(); if (typeof field !== "string") throw Error("invalid dynamic field");
      // A backend may supply dependencies that are absent from the captured TOML.
      if (field === "dependencies" || field === "optional-dependencies") runtimeComplete = false;
    }
  }
  const table = (value: unknown, out: Declaration[]) => {
    if (value === undefined) return;
    if (!record(value)) throw Error("invalid dependency table");
    for (const [name, spec] of Object.entries(value)) {
      tick(); if (name === "python") continue;
      if (!validName(name)) throw Error("invalid dependency name");
      const specs = Array.isArray(spec) ? spec : [spec];
      for (const item of specs) {
        tick(); if (typeof item !== "string" && !record(item)) throw Error("invalid dependency");
        const local = record(item) && typeof item.path === "string" ? item.path : undefined;
        const constraint = typeof item === "string" ? item : typeof item.version === "string" ? item.version : undefined;
        out.push({ name: norm(name), ...(constraint !== undefined ? { constraint } : {}), ...(local !== undefined ? { local } : {}), external: record(item) && ("git" in item || "url" in item || "path" in item || "source" in item) });
      }
    }
  };
  const requirements = (value: unknown, out: Declaration[]) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) throw Error("invalid requirement list");
    for (const spec of value) {
      tick();
      // Group includes are expanded by iterating all group declarations below.
      if (record(spec) && typeof spec["include-group"] === "string" && Object.keys(spec).length === 1) { out.push({ name: "#included-group", external: true }); continue; }
      if (typeof spec !== "string") throw Error("invalid requirement");
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|\[|[<>=!~@;(]|$)/.exec(spec);
      if (!match || !validName(match[1]!)) throw Error("invalid requirement name");
      const tail = spec.slice(match[0].length).replace(/^\[[^\]]*\]/, "").split(";")[0]!.trim().replace(/^\((.*)\)$/, "$1");
      out.push({ name: norm(match[1]!), constraint: tail || "*", external: tail.includes("@") });
    }
  };
  table(tool.dependencies, runtime);
  requirements(project.dependencies, runtime);
  if (project["optional-dependencies"] !== undefined) {
    if (!record(project["optional-dependencies"])) throw Error("invalid optional dependencies");
    for (const specs of Object.values(project["optional-dependencies"])) requirements(specs, runtime);
  }
  table(tool["dev-dependencies"], development);
  if (tool.group !== undefined) {
    if (!record(tool.group)) throw Error("invalid groups");
    for (const group of Object.values(tool.group)) { tick(); if (!record(group)) throw Error("invalid group"); table(group.dependencies, development); if (Array.isArray(group["include-groups"]) && group["include-groups"].length) development.push({ name: "#included-group", external: true }); }
  }
  if (data["dependency-groups"] !== undefined) {
    if (!record(data["dependency-groups"])) throw Error("invalid groups");
    for (const group of Object.values(data["dependency-groups"])) requirements(group, development);
  }
  const name = project.name ?? tool.name, version = project.version ?? tool.version;
  return { runtime, development, runtimeComplete, ...(typeof name === "string" ? { name: norm(name) } : {}), ...(typeof version === "string" ? { version } : {}) };
}

export function analyzePoetry(source: string, manifests: readonly PoetryManifest[], coverageBudget = createPoetryBudget(), relationBudget = createPoetryBudget()): { workspaces: Map<string, boolean | null> | null; relations: RelationLookup } {
  const unknown = { workspaces: null, relations: null };
  const data = parseBoundedToml(source);
  if (!data || !record(data.metadata) || !["1.1", "2.0", "2.1"].includes(String(data.metadata["lock-version"])) || !Array.isArray(data.package)) return unknown;
  const nodes: Node[] = [], named = new Map<string, Node[]>();
  const tick = () => { if (--coverageBudget.remaining < 0) throw Error("Poetry coverage limit"); };
  const inputs = new Map<string, Declarations | null>();
  const workspaces = new Map<string, boolean | null>();
  try {
    for (const raw of data.package) {
      tick(); if (!record(raw) || typeof raw.name !== "string" || !validName(raw.name) || typeof raw.version !== "string" || raw.version.length > 256) return unknown;
      const src = raw.source;
      if (src !== undefined && !record(src)) return unknown;
      const location = record(src) && src.type === "directory" && typeof src.url === "string" && safePath(src.url) ? path.posix.normalize(src.url) : undefined;
      const node: Node = { name: norm(raw.name), version: raw.version, raw, registry: src === undefined || (record(src) && src.type === "legacy"), ...(location !== undefined ? { location } : {}) };
      nodes.push(node); const list = named.get(node.name) ?? []; list.push(node); named.set(node.name, list);
    }
    for (const manifest of manifests) {
      tick(); let parsed: Declarations | null = null;
      try { parsed = manifest.data ? declarations(manifest.data, tick) : null; } catch { /* Malformed companion remains unconfirmed. */ }
      inputs.set(path.posix.dirname(manifest.path), parsed);
    }
    const root = inputs.get(".");
    const reachable = new Set<Node>(), queue: string[] = [];
    for (const declaration of [...root?.runtime ?? [], ...root?.development ?? []]) {
      tick(); const candidates = named.get(declaration.name) ?? [];
      if (candidates.length !== 1) continue;
      const node = candidates[0]!;
      if (declaration.local !== undefined ? node.location !== undefined && within(".", declaration.local) === node.location : !declaration.external && node.registry) queue.push(declaration.name);
    }
    while (queue.length) {
      tick(); const name = queue.pop()!, candidates = named.get(name) ?? [];
      if (candidates.length !== 1) continue;
      const node = candidates[0]!; if (reachable.has(node)) continue; reachable.add(node);
      if (record(node.raw.dependencies)) for (const name of Object.keys(node.raw.dependencies)) { tick(); queue.push(norm(name)); }
    }
    const locations = new Map<string, Node[]>();
    for (const node of nodes) if (node.location !== undefined) { tick(); const list = locations.get(node.location) ?? []; list.push(node); locations.set(node.location, list); }
    for (const [directory, input] of inputs) {
      tick(); if (directory === ".") continue;
      const local = locations.get(directory) ?? [];
      if (!local.length) { workspaces.set(directory, false); continue; }
      const node = local[0]!;
      if (local.length !== 1 || !root || !input || !reachable.has(node) || input.name !== node.name || !input.version || comparePep440(input.version, node.version) !== 0) { workspaces.set(directory, null); continue; }
      // Child development groups are not exported as dependencies of a path package.
      const edges = new Map<string, unknown>();
      if (record(node.raw.dependencies)) for (const [name, spec] of Object.entries(node.raw.dependencies)) { tick(); edges.set(norm(name), spec); }
      const complete = input.runtimeComplete && input.development.length === 0 && input.runtime.every(d => {
        tick(); const candidates = named.get(d.name) ?? [], edge = edges.get(d.name);
        if (candidates.length !== 1 || edge === undefined) return false;
        const target = candidates[0]!;
        if (d.local !== undefined) return target.location !== undefined && within(directory, d.local) === target.location && localEdge(edge, directory, target.location);
        if (typeof edge !== "string" || d.external || !target.registry) return false;
        const constraint = d.constraint?.replace(/\s/g, "") ?? "*";
        // Exact locked constraints or exact versions can establish agreement without a solver.
        return constraint === "*" || constraint === edge.replace(/\s/g, "") || comparePep440(constraint.replace(/^==|^=/, ""), target.version) === 0;
      });
      workspaces.set(directory, complete ? true : null);
    }
  } catch { return unknown; }
  try {
    const step = () => { if (--relationBudget.remaining < 0) throw Error("Poetry relationship limit"); };
    const declared = new Map<Node, Set<string>>(), origins = new Map<Node, Set<string>>();
    const starts = new Set<Node>();
    for (const [directory, input] of inputs) {
      step(); if (!input || (directory !== "." && workspaces.get(directory) !== true)) continue;
      const file = directory === "." ? "pyproject.toml" : `${directory}/pyproject.toml`;
      for (const declaration of [...input.runtime, ...directory === "." ? input.development : []]) {
        step(); const candidates = named.get(declaration.name) ?? []; if (candidates.length !== 1) continue;
        const node = candidates[0]!;
        if (declaration.local !== undefined) {
          if (node.location === undefined || within(directory, declaration.local) !== node.location) continue;
        } else if (declaration.external || !node.registry) continue;
        if (node.registry) { const files = declared.get(node) ?? new Set<string>(); files.add(file); declared.set(node, files); }
        if (node.location === undefined || workspaces.get(node.location) !== true) starts.add(node);
      }
    }
    for (const start of starts) {
      const seen = new Set<Node>(), queue = [start];
      while (queue.length) {
        step(); const node = queue.pop()!; if (seen.has(node)) continue; seen.add(node);
        if (!record(node.raw.dependencies)) continue;
        for (const [name, spec] of Object.entries(node.raw.dependencies)) {
          step(); const candidates = named.get(norm(name)) ?? []; if (candidates.length !== 1) continue;
          // Conditional/optional edges need an environment/extras solver; leave them unresolved.
          if (typeof spec !== "string") continue;
          const child = candidates[0]!;
          if (child.registry && child !== start) { const by = origins.get(child) ?? new Set<string>(); by.add(start.name); origins.set(child, by); }
          queue.push(child);
        }
      }
    }
    return { workspaces, relations: (name, version) => {
      const candidates = named.get(norm(name)) ?? [];
      if (candidates.length !== 1) return { relation: "unknown" };
      const node = candidates[0]!; if (!node.registry || comparePep440(node.version, version) !== 0) return { relation: "unknown" };
      const files = declared.get(node), by = origins.get(node);
      return { relation: files?.size ? "direct" : by?.size ? "transitive" : "unknown", ...(files?.size ? { declaredIn: files } : {}), ...(by?.size ? { introducedBy: by } : {}) };
    } };
  } catch { return { workspaces, relations: null }; }
}
