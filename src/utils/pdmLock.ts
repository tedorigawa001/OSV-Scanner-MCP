import path from "node:path";
import { parseBoundedToml } from "./boundedToml.js";
import { comparePep440 } from "./pep440Version.js";
import { MAX_DEPENDENCY_EDGES, type RelationLookup } from "./dependencyRelations.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
const validName = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/.test(s);
const safePath = (s: string) => !!s && !path.posix.isAbsolute(s) && !path.win32.isAbsolute(s) && !/^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(s) && !s.split("/").includes("..");
const location = (directory: string, value: string): string | undefined => {
  if (!value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(value)) return undefined;
  const result = path.posix.normalize(path.posix.join(directory, value)).replace(/\/$/, "");
  return safePath(result) ? result : undefined;
};
export interface PdmManifest { path: string; data: Record<string, unknown> | null }
export const createPdmBudget = () => ({ remaining: MAX_DEPENDENCY_EDGES });
interface Ref { name: string; extras: string[]; constraint: string; marker?: string; local?: string; external: boolean }
interface Node { name: string; version: string; extras: string[]; raw: Record<string, unknown>; refs: Ref[]; registry: boolean; location?: string }
interface Input { name?: string; version?: string; runtime: Ref[]; groups: Map<string, Ref[]>; development: boolean; complete: boolean; workspace?: unknown }
const extrasKey = (name: string, extras: readonly string[]) => JSON.stringify([name, extras]);

/** A bounded name/extras/marker reader, not a PEP 508 environment or constraint solver. */
function requirement(raw: unknown, directory: string): Ref {
  if (typeof raw !== "string" || raw.length > 16384) throw Error("invalid PDM requirement");
  let value = raw;
  if (/^\s*-e\s/.test(value)) {
    // PDM writes editable dev requirements as a URL with an explicit egg identity.
    // Do not infer identities from a path, contact URLs or open the source directory.
    const editable = /^\s*-e\s+(\S+?)(?:\s*;\s*(.+))?\s*$/.exec(value);
    if (!editable) throw Error("invalid PDM editable");
    const hash = editable[1]!.indexOf("#"), url = editable[1]!.slice(0, hash);
    const egg = hash < 0 ? null : /^egg=([^&#]+)$/.exec(editable[1]!.slice(hash + 1));
    if (!egg || !url) throw Error("missing or ambiguous PDM editable identity");
    const identity = decodeURIComponent(egg[1]!);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._, -]*\])?$/.test(identity)) throw Error("invalid PDM editable identity");
    value = `${identity} @ ${url}${editable[2] ? ` ; ${editable[2]}` : ""}`;
  }
  const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[([^\]]*)\])?\s*(.*)$/.exec(value);
  if (!match || !validName(match[1]!)) throw Error("invalid PDM name");
  const extras = [...new Set((match[2] ? match[2].split(",").map(s => norm(s.trim())) : []))].sort();
  if (!extras.every(validName)) throw Error("invalid PDM extras");
  const tail = match[3]!, separator = tail.indexOf(";"), body = (separator < 0 ? tail : tail.slice(0, separator)).trim();
  const marker = separator < 0 ? undefined : tail.slice(separator + 1).trim();
  const external = body.startsWith("@");
  if (body && !external && !/^(?:[<>=!~]|\()/.test(body)) throw Error("invalid PDM constraint");
  let local: string | undefined;
  if (external) {
    const url = body.slice(1).trim();
    const prefix = "file:///${PROJECT_ROOT}/";
    if (url.startsWith(prefix)) local = location(directory, decodeURIComponent(url.slice(prefix.length)));
    else if (url.startsWith("file:./") || url.startsWith("file:../")) local = location(directory, decodeURIComponent(url.slice(5)));
  }
  return { name: norm(match[1]!), extras, constraint: external ? "" : body.replace(/^\((.*)\)$/, "$1").replace(/\s/g, "") || "*", external,
    ...(marker ? { marker } : {}), ...(local !== undefined ? { local } : {}) };
}

function input(data: Record<string, unknown>, directory: string, tick: () => void): Input {
  if (!record(data.project)) throw Error("missing project metadata");
  const project = data.project, pdm = record(data.tool) && record(data.tool.pdm) ? data.tool.pdm : {};
  let complete = true;
  const parseRef = (value: unknown): Ref | null => {
    try { return requirement(value, directory); } catch { return null; }
  };
  const list = (value: unknown): Ref[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw Error("invalid dependencies");
    const refs: Ref[] = [];
    for (const item of value) {
      tick(); const ref = parseRef(item);
      if (ref) refs.push(ref);
      else complete = false; // Preserve known roots, but never confirm an incomplete child declaration.
    }
    return refs;
  };
  const runtime = list(project.dependencies), groups = new Map<string, Ref[]>([["default", [...runtime]]]);
  if (project["optional-dependencies"] !== undefined) {
    if (!record(project["optional-dependencies"])) throw Error("invalid optional dependencies");
    for (const [name, value] of Object.entries(project["optional-dependencies"])) { tick(); const refs = list(value); groups.set(norm(name), refs); for (const ref of refs) { tick(); runtime.push(ref); } }
  }
  const rawGroups = new Map<string, unknown[]>();
  for (const table of [pdm["dev-dependencies"], data["dependency-groups"]]) {
    if (table === undefined) continue;
    if (!record(table)) throw Error("invalid dependency groups");
    for (const [name, value] of Object.entries(table)) { tick(); if (!Array.isArray(value) || rawGroups.has(norm(name)) || groups.has(norm(name))) throw Error("ambiguous dependency groups"); rawGroups.set(norm(name), value); }
  }
  for (const name of rawGroups.keys()) {
    const refs: Ref[] = [], seen = new Set<string>(), queue = [name];
    while (queue.length) {
      tick(); const current = queue.pop()!; if (seen.has(current)) continue; seen.add(current);
      const entries = rawGroups.get(current); if (!entries) throw Error("missing included group");
      for (const entry of entries) { tick();
        if (record(entry) && typeof entry["include-group"] === "string" && Object.keys(entry).length === 1) queue.push(norm(entry["include-group"]));
        else { const ref = parseRef(entry); if (ref) refs.push(ref); }
      }
    }
    groups.set(name, refs);
  }
  if (project.dynamic !== undefined) {
    if (!Array.isArray(project.dynamic)) throw Error("invalid dynamic metadata");
    for (const field of project.dynamic) { tick(); if (typeof field !== "string") throw Error("invalid dynamic field"); if (field === "dependencies" || field === "optional-dependencies") complete = false; }
  }
  return { runtime, groups, development: [...rawGroups.values()].some(v => v.length > 0), complete,
    ...(typeof project.name === "string" ? { name: norm(project.name) } : {}), ...(typeof project.version === "string" ? { version: project.version } : {}),
    ...(pdm.workspace !== undefined ? { workspace: pdm.workspace } : {}) };
}

/** Python pathlib-style subset: *, ?, whole-segment **, including dot directories. */
function glob(pattern: string, target: string, tick: () => void): boolean | null {
  if (!safePath(pattern) || /[\[\]{}()!]/.test(pattern) || pattern.split("/").some(s => s.includes("**") && s !== "**")) return null;
  const parts = pattern.replace(/^\.\//, "").replace(/\/$/, "").split("/"), names = target.split("/");
  if (parts.includes("")) return null;
  let row = new Array<boolean>(names.length + 1).fill(false); row[0] = true;
  for (const part of parts) {
    tick(); const next = new Array<boolean>(names.length + 1).fill(false);
    if (part === "**") next[0] = row[0]!;
    for (let j = 1; j <= names.length; j++) {
      tick(); if (part === "**") { next[j] = row[j]! || next[j - 1]!; continue; }
      if (!row[j - 1]) continue;
      const chars = Array.from(names[j - 1]!); let match = new Array<boolean>(chars.length + 1).fill(false); match[0] = true;
      for (const ch of part) {
        const values = new Array<boolean>(match.length).fill(false); values[0] = ch === "*" && match[0]!;
        for (let k = 1; k < match.length; k++) { tick(); values[k] = ch === "*" ? match[k]! || values[k - 1]! : match[k - 1]! && (ch === "?" || ch === chars[k - 1]); }
        match = values;
      }
      next[j] = match.at(-1)!;
    }
    row = next;
  }
  return row.at(-1)!;
}
function workspaceMatch(workspace: unknown, directory: string, tick: () => void): boolean | null {
  if (workspace === undefined) return false;
  if (!record(workspace) || !Array.isArray(workspace.members) || Object.keys(workspace).some(k => k !== "members")) return null;
  let unknown = false;
  for (const pattern of workspace.members) { tick(); if (typeof pattern !== "string") return null; const match = glob(pattern, directory, tick); if (match === true) return true; if (match === null) unknown = true; }
  return unknown ? null : false;
}

export function analyzePdm(source: string, manifests: readonly PdmManifest[], coverageBudget = createPdmBudget(), relationBudget = createPdmBudget()): { workspaces: Map<string, boolean | null> | null; relations: RelationLookup } {
  const unknown = { workspaces: null, relations: null }, data = parseBoundedToml(source);
  if (!data || !record(data.metadata) || typeof data.metadata.lock_version !== "string" || !/^4\.(?:[0-4](?:\.[0-9]{1,3})?|5(?:\.[01])?)$/.test(data.metadata.lock_version) || !Array.isArray(data.package)) return unknown;
  const workspaces = new Map<string, boolean | null>(), inputs = new Map<string, Input | null>(), nodes: Node[] = [], named = new Map<string, Node[]>();
  const tick = () => { if (--coverageBudget.remaining < 0) throw Error("PDM coverage limit"); };
  let selected: Set<string> | null = null;
  try {
    if (data.metadata.groups !== undefined) {
      if (!Array.isArray(data.metadata.groups)) return unknown;
      selected = new Set<string>(); for (const group of data.metadata.groups) { tick(); if (typeof group !== "string") return unknown; selected.add(norm(group)); }
    }
    for (const raw of data.package) {
      tick(); if (!record(raw) || typeof raw.name !== "string" || !validName(raw.name) || typeof raw.version !== "string" || raw.version.length > 256) return unknown;
      const extras: string[] = [];
      if (raw.extras !== undefined) { if (!Array.isArray(raw.extras)) return unknown; for (const extra of raw.extras) { tick(); if (typeof extra !== "string" || !validName(extra)) return unknown; extras.push(norm(extra)); } }
      const local = typeof raw.path === "string" && safePath(raw.path) ? path.posix.normalize(raw.path).replace(/\/$/, "") : undefined;
      const registry = !["path", "url", "git", "hg", "svn", "bzr", "editable"].some(key => key in raw);
      const refs: Ref[] = [];
      if (raw.dependencies !== undefined) { if (!Array.isArray(raw.dependencies)) return unknown; for (const ref of raw.dependencies) { tick(); refs.push(requirement(ref, ".")); } }
      const node: Node = { name: norm(raw.name), version: raw.version, extras: [...new Set(extras)].sort(), raw, refs, registry, ...(local !== undefined ? { location: local } : {}) };
      nodes.push(node); const key = extrasKey(node.name, node.extras), entries = named.get(key) ?? []; entries.push(node); named.set(key, entries);
    }
    for (const manifest of manifests) {
      tick(); const directory = path.posix.dirname(manifest.path); let parsed: Input | null = null;
      try { parsed = manifest.data ? input(manifest.data, directory, tick) : null; } catch { /* Unreadable/unsupported companions remain unconfirmed. */ }
      inputs.set(directory, parsed);
    }
  } catch { return unknown; }
  const root = inputs.get(".");
  const configured = new Map<string, boolean | null>();
  try { for (const node of nodes) { tick(); if (node.location !== undefined && !configured.has(node.location)) configured.set(node.location, workspaceMatch(root?.workspace, node.location, tick)); } }
  catch { return unknown; }
  const resolve = (ref: Ref): Node | null => {
    const entries = named.get(extrasKey(ref.name, ref.extras)) ?? []; if (entries.length !== 1) return null;
    const node = entries[0]!;
    if (ref.local !== undefined) return node.location === ref.local ? node : null;
    return !ref.external && (node.registry || (node.location !== undefined && configured.get(node.location) === true)) ? node : null;
  };
  const rootRefs: Ref[] = [];
  try {
    if (root) for (const [group, refs] of root.groups) { tick(); if (selected === null || selected.has(group)) for (const ref of refs) { tick(); rootRefs.push(ref); } }
    const reachable = new Set<Node>(), queue = rootRefs.map(resolve).filter((n): n is Node => n !== null);
    for (const node of nodes) {
      tick(); if (node.location !== undefined && configured.get(node.location) === true && (selected === null || selected.has("default"))) queue.push(node);
    }
    while (queue.length) {
      tick(); const node = queue.pop()!; if (reachable.has(node)) continue; reachable.add(node);
      for (const ref of node.refs) { tick(); const next = resolve(ref); if (next) queue.push(next); }
    }
    const locations = new Map<string, Node[]>();
    for (const node of nodes) { tick(); if (node.location !== undefined && node.extras.length === 0) { const entries = locations.get(node.location) ?? []; entries.push(node); locations.set(node.location, entries); } }
    for (const [directory, child] of inputs) {
      tick(); if (directory === ".") continue;
      const entries = locations.get(directory) ?? [];
      if (!entries.length) { workspaces.set(directory, false); continue; }
      const node = entries[0]!;
      if (!root || !child || entries.length !== 1 || named.get(extrasKey(node.name, []))?.length !== 1 || !reachable.has(node) || child.name !== node.name || !child.version || comparePep440(child.version, node.version) !== 0 || !child.complete || child.development) { workspaces.set(directory, null); continue; }
      const edges = new Map<string, Ref[]>();
      for (const ref of node.refs) { tick(); const key = extrasKey(ref.name, ref.extras), list = edges.get(key) ?? []; list.push(ref); edges.set(key, list); }
      const complete = child.runtime.every(ref => {
        tick(); const target = resolve(ref), locked = edges.get(extrasKey(ref.name, ref.extras));
        if (!target || locked?.length !== 1) return false;
        const edge = locked[0]!;
        return resolve(edge) === target && ref.marker === edge.marker && (ref.local !== undefined ? ref.local === edge.local : !ref.external &&
          (target.registry || (target.location !== undefined && configured.get(target.location) === true)) &&
          (ref.constraint === "*" || ref.constraint === edge.constraint || comparePep440(ref.constraint.replace(/^==|^=/, ""), target.version) === 0));
      });
      workspaces.set(directory, complete ? true : null);
    }
  } catch { return unknown; }
  try {
    const step = () => { if (--relationBudget.remaining < 0) throw Error("PDM relationship limit"); };
    const declared = new Map<Node, Set<string>>(), origins = new Map<Node, Set<string>>(), starts: { node: Node; ref: Ref }[] = [];
    const add = (ref: Ref, file: string) => {
      step(); const node = resolve(ref); if (!node) return;
      if (node.registry) { const files = declared.get(node) ?? new Set<string>(); files.add(file); declared.set(node, files); }
      if (node.location === undefined || workspaces.get(node.location) !== true) starts.push({ node, ref });
    };
    for (const ref of rootRefs) add(ref, "pyproject.toml");
    for (const [directory, child] of inputs) { step(); if (directory === "." || !child || workspaces.get(directory) !== true) continue; for (const ref of child.runtime) add(ref, `${directory}/pyproject.toml`); }
    const started = new Map<Node, Set<string | undefined>>();
    for (const start of starts) {
      step(); const done = started.get(start.node) ?? new Set<string | undefined>(); if (done.has(start.ref.marker)) continue; done.add(start.ref.marker); started.set(start.node, done);
      const seen = new Map<Node, Set<string | undefined>>(), queue = [{ node: start.node, marker: start.ref.marker }];
      while (queue.length) {
        step(); const current = queue.pop()!, states = seen.get(current.node) ?? new Set<string | undefined>(); if (states.has(current.marker)) continue; states.add(current.marker); seen.set(current.node, states);
        for (const ref of current.node.refs) {
          step(); if (current.marker !== undefined && ref.marker !== undefined && current.marker !== ref.marker) continue;
          const node = resolve(ref); if (!node) continue;
          if (node.registry && node !== start.node) { const by = origins.get(node) ?? new Set<string>(); by.add(start.node.name); origins.set(node, by); }
          queue.push({ node, marker: current.marker ?? ref.marker });
        }
      }
    }
    const result = new Map<string, { files: Set<string>; by: Set<string>; ambiguous: boolean }>();
    for (const node of nodes) {
      step(); const key = JSON.stringify([node.name, node.version]), info = result.get(key) ?? { files: new Set<string>(), by: new Set<string>(), ambiguous: false };
      if (!node.registry || named.get(extrasKey(node.name, node.extras))!.length !== 1) info.ambiguous = true;
      for (const file of declared.get(node) ?? []) { step(); info.files.add(file); }
      for (const name of origins.get(node) ?? []) { step(); if (name !== node.name) info.by.add(name); }
      result.set(key, info);
    }
    return { workspaces, relations: (name, version) => {
      // OSV preserves the raw locked release version; normalization is used if no exact identity exists.
      let info = result.get(JSON.stringify([norm(name), version]));
      if (!info) for (const node of named.get(extrasKey(norm(name), [])) ?? []) if (comparePep440(node.version, version) === 0) { info = result.get(JSON.stringify([node.name, node.version])); break; }
      if (!info || info.ambiguous) return { relation: "unknown" };
      return { relation: info.files.size ? "direct" : info.by.size ? "transitive" : "unknown", ...(info.files.size ? { declaredIn: info.files } : {}), ...(info.by.size ? { introducedBy: info.by } : {}) };
    } };
  } catch { return { workspaces, relations: null }; }
}
