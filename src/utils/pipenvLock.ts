import path from "node:path";
import { visit } from "jsonc-parser";
import { createParseBudget, MAX_DEPENDENCY_EDGES, type RelationLookup } from "./dependencyRelations.js";
import { comparePep440, parsePep440 } from "./pep440Version.js";
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
const validName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(s);
const localPath = (directory: string, value: string): string | undefined => {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(value)) return undefined;
  const result = path.posix.normalize(path.posix.join(directory, value)).replace(/\/$/, "");
  return !result.split("/").includes("..") ? result : undefined;
};
export interface PipenvManifest { path: string; data: Record<string, unknown> | null }
export const createPipenvBudget = () => ({ remaining: MAX_DEPENDENCY_EDGES });

/** Strict JSON with bounded allocation and duplicate-key rejection. */
export function parsePipenvLock(source: string, budget = createParseBudget(source)): Record<string, unknown> | null {
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) return null;
    const tick = () => { if (--budget.remaining < 0) throw new Error("Pipenv parse limit"); };
    type Container = { value: unknown[] | Record<string, unknown>; pending?: string; keys: Set<string> };
    const stack: Container[] = [];
    let result: unknown;
    const add = (value: unknown) => {
      tick(); const parent = stack.at(-1);
      if (!parent) { if (result !== undefined) throw new Error("multiple values"); result = value; }
      else if (Array.isArray(parent.value)) parent.value.push(value);
      else { if (parent.pending === undefined) throw new Error("missing key"); parent.value[parent.pending] = value; parent.pending = undefined; }
    };
    const begin = (value: Container["value"]) => {
      if (stack.length >= 128) throw new Error("Pipenv nesting limit");
      add(value); stack.push({ value, keys: new Set() });
    };
    visit(source, {
      onObjectBegin: () => begin(Object.create(null) as Record<string, unknown>),
      onObjectProperty: name => { tick(); const parent = stack.at(-1)!; if (parent.keys.has(name)) throw new Error("duplicate key"); parent.keys.add(name); parent.pending = name; },
      onObjectEnd: () => { tick(); stack.pop(); },
      onArrayBegin: () => begin([]),
      onArrayEnd: () => { tick(); stack.pop(); },
      onLiteralValue: add,
      onSeparator: tick,
      onComment: tick,
      onError: () => { throw new Error("invalid JSON"); },
    }, { allowTrailingComma: false, disallowComments: true });
    if (!record(result) || !record(result._meta) || result._meta["pipfile-spec"] !== 6) return null;
    return result;
  } catch { return null; }
}

interface Locked { name: string; version: string; registry: boolean; local?: string }
interface Declaration { name: string; local?: string; registry: boolean }
interface Category { name: string; packages: Map<string, Locked>; declarations: Declaration[]; complete: boolean }
interface Child { name: string; refs: { name: string; constraint: string }[]; complete: boolean }
const externalKeys = ["path", "file", "git", "hg", "svn", "bzr", "editable"];

/** Only basic PEP 440 comparisons can confirm a child; unsupported constraints are not guessed. */
function satisfies(version: string, constraint: string): boolean {
  if (constraint === "*" || constraint === "") return true;
  for (const part of constraint.replace(/\s/g, "").split(",")) {
    const match = /^(===|==|!=|>=|<=|>|<)(.+)$/.exec(part); if (!match) return false;
    // Ordered exclusions of local/prerelease versions need PEP 440 specifier semantics,
    // beyond a version comparator. Keep those child declarations unconfirmed.
    if (match[1] !== "===" && match[1] !== "==" && (!/^\d+(?:\.\d+)*$/.test(version) || !/^\d+(?:\.\d+)*$/.test(match[2]!))) return false;
    const cmp = comparePep440(version, match[2]!); if (cmp === null) return false;
    if (!(match[1] === "===" ? version === match[2] : match[1] === "==" ? cmp === 0 : match[1] === "!=" ? cmp !== 0 : match[1] === ">=" ? cmp >= 0 : match[1] === "<=" ? cmp <= 0 : match[1] === ">" ? cmp > 0 : cmp < 0)) return false;
  }
  return true;
}

function childInput(data: Record<string, unknown>, tick: () => void): Child | null {
  if (!record(data.project) || typeof data.project.name !== "string" || !validName(data.project.name)) return null;
  const name = norm(data.project.name);
  const project = data.project, refs: Child["refs"] = [];
  let complete = true;
  if (project.dynamic !== undefined) {
    if (!Array.isArray(project.dynamic)) return null;
    for (const field of project.dynamic) { tick(); if (typeof field !== "string") return null; if (field === "dependencies" || field === "optional-dependencies") complete = false; }
  }
  const list = (value: unknown) => {
    if (value === undefined) return;
    if (!Array.isArray(value)) { complete = false; return; }
    for (const raw of value) {
      tick(); if (typeof raw !== "string" || raw.length > 16384) { complete = false; continue; }
      // Extras, markers and direct URLs require more information than this flat lockfile contains.
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*((?:[<>=!].*)?)$/.exec(raw);
      if (!match || !validName(match[1]!) || /[;@\[\]]/.test(raw)) { complete = false; continue; }
      refs.push({ name: norm(match[1]!), constraint: match[2]!.trim() });
    }
  };
  list(project.dependencies);
  if (record(data.tool) && record(data.tool.poetry) && data.tool.poetry.dependencies !== undefined) complete = false;
  if (project["optional-dependencies"] !== undefined) {
    if (!record(project["optional-dependencies"])) complete = false;
    else for (const values of Object.values(project["optional-dependencies"])) { tick(); if (!Array.isArray(values) || values.length) complete = false; }
  }
  // A local package exports runtime metadata, not its Pipfile/development dependencies.
  for (const table of [data["dependency-groups"], record(data.tool) && record(data.tool.pdm) ? data.tool.pdm["dev-dependencies"] : undefined]) {
    if (table === undefined) continue;
    if (!record(table)) complete = false;
    else for (const group of Object.values(table)) { tick(); if (!Array.isArray(group) || group.length) complete = false; }
  }
  if (record(data.tool) && record(data.tool.poetry)) {
    const poetry = data.tool.poetry, legacy = poetry["dev-dependencies"];
    if (legacy !== undefined && (!record(legacy) || Object.keys(legacy).length)) complete = false;
    if (poetry.group !== undefined) {
      if (!record(poetry.group)) complete = false;
      else for (const group of Object.values(poetry.group)) {
        tick(); if (!record(group)) { complete = false; continue; }
        const deps = group.dependencies, includes = group["include-groups"];
        if (deps !== undefined && (!record(deps) || Object.keys(deps).length)) complete = false;
        if (includes !== undefined && (!Array.isArray(includes) || includes.length)) complete = false;
      }
    }
  }
  return { name, refs, complete };
}

/** Pipfile.lock is flat: category evidence establishes transitivity, not arbitrary dependency edges. */
export function analyzePipenv(source: string, manifests: readonly PipenvManifest[], coverageBudget = createPipenvBudget(), relationBudget = createPipenvBudget()): { workspaces: Map<string, boolean | null> | null; relations: RelationLookup } {
  const unknown = { workspaces: null, relations: null }, data = parsePipenvLock(source);
  if (!data) return unknown;
  const tick = () => { if (--coverageBudget.remaining < 0) throw Error("Pipenv coverage limit"); };
  const categories: Category[] = [], workspaces = new Map<string, boolean | null>();
  const children = new Map<string, Child | null>(), childCategories = new Map<string, Set<Category>>();
  const root = manifests.find(m => m.path === "Pipfile")?.data;
  try {
    for (const [name, raw] of Object.entries(data)) {
      tick(); if (name === "_meta") continue;
      if (!record(raw)) return unknown;
      const packages = new Map<string, Locked>();
      for (const [key, entry] of Object.entries(raw)) {
        tick(); if (!validName(key) || !record(entry) || packages.has(norm(key))) return unknown;
        const local = typeof entry.path === "string" ? localPath(".", entry.path) : undefined;
        const version = typeof entry.version === "string" && /^==[^=]/.test(entry.version) ? entry.version.slice(2) : "";
        const registry = !externalKeys.some(k => k in entry) && version.length <= 256 && parsePep440(version) !== null;
        packages.set(norm(key), { name: norm(key), version, registry, ...(local !== undefined ? { local } : {}) });
      }
      const category: Category = { name, packages, declarations: [], complete: !!root };
      const section = name === "default" ? "packages" : name === "develop" ? "dev-packages" : name;
      const declarations = root?.[section];
      if (declarations !== undefined && !record(declarations)) category.complete = false;
      if (record(declarations)) {
        const seen = new Set<string>();
        for (const [key, spec] of Object.entries(declarations)) {
          tick(); const normalized = norm(key);
          if (!validName(key) || seen.has(normalized) || (typeof spec !== "string" && !record(spec))) { category.complete = false; continue; }
          seen.add(normalized);
          const local = record(spec) && typeof spec.path === "string" ? localPath(".", spec.path) : undefined;
          const registry = typeof spec === "string" || !externalKeys.some(k => k in (spec as Record<string, unknown>));
          const entry = packages.get(normalized);
          if (!entry || (local !== undefined ? entry.local !== local : registry ? !entry.registry : true)) category.complete = false;
          category.declarations.push({ name: normalized, registry, ...(local !== undefined ? { local } : {}) });
        }
      }
      categories.push(category);
    }
    for (const manifest of manifests) {
      tick(); if (path.posix.basename(manifest.path) !== "pyproject.toml") continue;
      const directory = path.posix.dirname(manifest.path);
      children.set(directory, manifest.data ? childInput(manifest.data, tick) : null);
      let present = false, confirmed = false;
      for (const category of categories) {
        const matching = [...category.packages.values()].filter(entry => { tick(); return entry.local === directory; });
        if (matching.length) present = true;
        if (matching.length !== 1 || !root) continue;
        const entry = matching[0]!, child = children.get(directory);
        const declaration = category.declarations.find(d => { tick(); return d.name === entry.name && d.local === directory; });
        if (!declaration || !child || child.name !== entry.name || !child.complete) continue;
        const included = child.refs.every(ref => { tick(); const target = category.packages.get(ref.name); return !!target?.registry && satisfies(target.version, ref.constraint); });
        if (included) { confirmed = true; const set = childCategories.get(directory) ?? new Set<Category>(); set.add(category); childCategories.set(directory, set); }
      }
      workspaces.set(directory, confirmed ? true : present ? null : false);
    }
  } catch { return unknown; }
  if (!root) return { workspaces, relations: null };
  try {
    const step = () => { if (--relationBudget.remaining < 0) throw Error("Pipenv relation limit"); };
    const results = new Map<string, { direct: Set<string>; transitive: boolean; by: Set<string> }>();
    for (const category of categories) {
      step(); const declared = new Map<string, Set<string>>(), roots = new Set<string>();
      const direct = (name: string, file: string) => { step(); const files = declared.get(name) ?? new Set<string>(); files.add(file); declared.set(name, files); roots.add(name); };
      for (const declaration of category.declarations) {
        step(); const entry = category.packages.get(declaration.name); if (!entry) continue;
        if (declaration.registry && entry.registry) direct(entry.name, "Pipfile");
        else if (declaration.local !== undefined && entry.local === declaration.local && childCategories.get(declaration.local)?.has(category)) {
          for (const ref of children.get(declaration.local)!.refs) direct(ref.name, `${declaration.local}/pyproject.toml`);
        } else roots.add(declaration.name);
      }
      for (const entry of category.packages.values()) {
        step(); if (!entry.registry) continue;
        const key = JSON.stringify([entry.name, entry.version]), info = results.get(key) ?? { direct: new Set<string>(), transitive: false, by: new Set<string>() };
        for (const file of declared.get(entry.name) ?? []) { step(); info.direct.add(file); }
        if (category.complete && roots.size && !declared.has(entry.name)) {
          info.transitive = true;
          // With more than one root the flat lock cannot establish which one introduced this release.
          if (roots.size === 1) { const name = roots.values().next().value!; if (name !== entry.name) info.by.add(name); }
        }
        results.set(key, info);
      }
    }
    return { workspaces, relations: (name, version) => {
      const info = results.get(JSON.stringify([norm(name), version]));
      return info ? { relation: info.direct.size ? "direct" : info.transitive ? "transitive" : "unknown", ...(info.direct.size ? { declaredIn: info.direct } : {}), ...(info.by.size ? { introducedBy: info.by } : {}) } : { relation: "unknown" };
    } };
  } catch { return { workspaces, relations: null }; }
}
