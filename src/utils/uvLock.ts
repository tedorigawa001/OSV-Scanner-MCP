import path from "node:path";
import { parse } from "smol-toml";
import { comparePep440 } from "./pep440Version.js";
import { MAX_DEPENDENCY_EDGES, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";

export interface UvWorkBudget { remaining: number }
export const createUvWorkBudget = (): UvWorkBudget => ({ remaining: MAX_DEPENDENCY_EDGES });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
const identity = (name: string, version: string) => JSON.stringify([normalize(name), version]);
const safePath = (s: string) => s.length > 0 && !path.posix.isAbsolute(s) && !path.win32.isAbsolute(s) && !/^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(s) && !s.split("/").includes("..");

/** Bound TOML containers and structural work before asking the parser to allocate them. */
export function parseUvLock(source: string): Record<string, unknown> | null {
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) return null;
    let quote = "", triple = false, escaped = false, comment = false, depth = 0, structure = 0, dots = 0;
    for (let i = 0; i < source.length; i++) {
      const c = source[i]!;
      if (comment) { if (c === "\n") { comment = false; dots = 0; } continue; }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (quote === '"' && c === "\\") { escaped = true; continue; }
        if (c === quote && (!triple || source.slice(i, i + 3) === quote.repeat(3))) {
          if (triple) i += 2;
          quote = ""; triple = false;
        }
        continue;
      }
      if (c === "#") { comment = true; continue; }
      if (c === '"' || c === "'") { quote = c; triple = source.slice(i, i + 3) === c.repeat(3); if (triple) i += 2; continue; }
      if (c === "\n") dots = 0;
      if (c === "." && ++dots > 128) return null;
      if (c === "[" || c === "{") { if (++depth > 128) return null; }
      else if (c === "]" || c === "}") { if (--depth < 0) return null; }
      if ("[]{}=,.".includes(c) && ++structure > 1_000_000) return null;
    }
    if (depth || quote) return null;
    const value = parse(source, { unsafeKeyBehaviour: "throw" });
    if (!record(value) || value.version !== 1 || (value.revision !== undefined && (!Number.isInteger(value.revision) || Number(value.revision) < 0 || Number(value.revision) > 5))) return null;
    return value;
  } catch { return null; }
}

interface UvNode { name: string; version: string; source: Record<string, unknown>; raw: Record<string, unknown>; location?: string; registry: boolean }
function nodes(data: Record<string, unknown>, tick: () => void): UvNode[] | null {
  if (!Array.isArray(data.package)) return null;
  const out: UvNode[] = [];
  for (const raw of data.package) {
    tick(); if (!record(raw) || typeof raw.name !== "string" || raw.name.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw.name) || !record(raw.source)) return null;
    const version = typeof raw.version === "string" && raw.version.length <= 256 ? raw.version : "";
    const source = raw.source;
    const localFields = ["editable", "virtual", "directory"].filter(field => typeof source[field] === "string");
    let location: string | undefined;
    if (localFields.length === 1) {
      const rawPath = source[localFields[0]!] as string;
      if (safePath(rawPath)) location = path.posix.normalize(rawPath);
    }
    out.push({ name: normalize(raw.name), version, source: raw.source, raw, location, registry: typeof raw.source.registry === "string" && Object.keys(raw.source).length === 1 && version.length > 0 });
  }
  return out;
}
const sourceKey = (source: Record<string, unknown>) => JSON.stringify(Object.keys(source).sort().map(key => [key, source[key]]));

/** Local dependency paths are not automatically workspace members. */
export function uvWorkspaceIndex(data: Record<string, unknown>, budget = createUvWorkBudget()): Map<string, boolean | null> | null {
  try {
    const tick = () => { if (--budget.remaining < 0) throw new Error("uv coverage limit"); };
    const packages = nodes(data, tick); if (!packages) return null;
    const manifest = record(data.manifest) ? data.manifest : {};
    const rawMembers = manifest.members;
    if (rawMembers !== undefined && (!Array.isArray(rawMembers) || !rawMembers.every(m => typeof m === "string"))) return null;
    const members = new Set<string>();
    for (const name of rawMembers as string[] ?? []) { tick(); const normalized = normalize(name); if (members.has(normalized)) return null; members.add(normalized); }
    const names = new Map<string, number>();
    for (const node of packages) { tick(); if (node.location !== undefined) names.set(node.name, (names.get(node.name) ?? 0) + 1); }
    const locations = new Map<string, boolean | null>();
    for (const node of packages) {
      tick(); if (node.location === undefined) continue;
      const member = node.location === "." ? true : rawMembers === undefined ? null : members.has(node.name);
      locations.set(node.location, locations.has(node.location) || names.get(node.name)! > 1 ? null : member);
    }
    return locations;
  } catch { return null; }
}

/** Markers remain universal; only unique locked identities and explicitly requested extras are followed. */
export function uvLockRelations(data: Record<string, unknown>, membership: ReadonlyMap<string, boolean | null> | null, budget = createUvWorkBudget()): RelationLookup {
  try {
    if (membership === null) return null;
    const tick = () => { if (--budget.remaining < 0) throw new Error("uv relationship limit"); };
    const packages = nodes(data, tick); if (!packages) return null;
    const named = new Map<string, UvNode[]>();
    for (const node of packages) { tick(); const entries = named.get(node.name) ?? []; entries.push(node); named.set(node.name, entries); }
    const resolve = (ref: unknown): UvNode | null => {
      tick(); if (!record(ref) || typeof ref.name !== "string") return null;
      const candidates: UvNode[] = [];
      for (const node of named.get(normalize(ref.name)) ?? []) {
        tick();
        if (ref.version !== undefined && (typeof ref.version !== "string" || ref.version.length > 256 || comparePep440(ref.version, node.version) !== 0)) continue;
        if (ref.source !== undefined && (!record(ref.source) || sourceKey(ref.source) !== sourceKey(node.source))) continue;
        candidates.push(node);
      }
      return candidates.length === 1 ? candidates[0]! : null;
    };
    const refs = (value: unknown): Record<string, unknown>[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) throw new Error("invalid uv dependencies");
      const result: Record<string, unknown>[] = [];
      for (const ref of value) { tick(); if (!record(ref) || typeof ref.name !== "string") throw new Error("invalid uv dependency"); result.push(ref); }
      return result;
    };
    const groups = (value: unknown): Record<string, unknown>[] => {
      if (value === undefined) return [];
      if (!record(value)) throw new Error("invalid uv groups");
      const result: Record<string, unknown>[] = [];
      for (const entry of Object.values(value)) for (const ref of refs(entry)) result.push(ref);
      return result;
    };
    const declared = new Map<UvNode, Set<string>>();
    const origins = new Map<UvNode, Set<string>>();
    const starts: { node: UvNode; ref: Record<string, unknown>; origin: string }[] = [];
    const addRoot = (ref: Record<string, unknown>, manifest: string) => {
      const node = resolve(ref); if (!node) return;
      if (node.registry) { const files = declared.get(node) ?? new Set<string>(); files.add(manifest); declared.set(node, files); }
      if (node.location !== undefined && membership.get(node.location) === true) return; // Each member has its own roots.
      starts.push({ node, ref, origin: node.name });
    };
    for (const root of packages) {
      tick(); if (root.location === undefined || membership.get(root.location) !== true) continue;
      const manifest = root.location === "." ? "pyproject.toml" : `${root.location}/pyproject.toml`;
      for (const ref of refs(root.raw.dependencies)) addRoot(ref, manifest);
      for (const ref of groups(root.raw["optional-dependencies"])) addRoot(ref, manifest);
      for (const ref of groups(root.raw["dev-dependencies"])) addRoot(ref, manifest);
    }
    // Non-project workspace roots can keep dependency groups in manifest rather than a local package.
    if (record(data.manifest)) for (const ref of groups(data.manifest["dependency-groups"])) addRoot(ref, "pyproject.toml");
    const extrasCache = new Map<Record<string, unknown>, string[]>();
    const extras = (ref: Record<string, unknown>): string[] => {
      const cached = extrasCache.get(ref); if (cached) return cached;
      if (ref.extra === undefined) return [];
      if (!Array.isArray(ref.extra)) throw new Error("invalid uv extras");
      const names = new Set<string>();
      for (const extra of ref.extra) { tick(); if (typeof extra !== "string" || extra.length > 512) throw new Error("invalid uv extra"); names.add(normalize(extra)); }
      const result = [...names].sort(); extrasCache.set(ref, result); return result;
    };
    const marker = (ref: Record<string, unknown>): string | undefined => {
      if (ref.marker === undefined) return undefined;
      if (typeof ref.marker !== "string") throw new Error("invalid uv marker");
      return ref.marker;
    };
    for (const start of starts) {
      const seen = new Map<UvNode, Set<string>>(), queue = [{ node: start.node, extra: extras(start.ref), marker: marker(start.ref) }];
      while (queue.length) {
        tick(); const current = queue.pop()!, state = JSON.stringify([current.extra, current.marker]);
        const states = seen.get(current.node) ?? new Set<string>(); if (states.has(state)) continue;
        states.add(state); seen.set(current.node, states);
        const outgoing = refs(current.node.raw.dependencies);
        if (record(current.node.raw["optional-dependencies"])) for (const extra of current.extra) {
          for (const ref of refs(current.node.raw["optional-dependencies"][extra])) outgoing.push(ref);
        }
        for (const ref of outgoing) {
          const condition = marker(ref);
          // Do not join different conditional branches without evaluating PEP 508 expressions.
          if (current.marker !== undefined && condition !== undefined && current.marker !== condition) continue;
          const node = resolve(ref); if (!node) continue;
          if (node.registry && node !== start.node) { const by = origins.get(node) ?? new Set<string>(); by.add(start.origin); origins.set(node, by); }
          queue.push({ node, extra: extras(ref), marker: current.marker ?? condition });
        }
      }
    }
    const result = new Map<string, { declaredIn: Set<string>; introducedBy: Set<string> }>();
    for (const node of packages) {
      tick(); if (!node.registry) continue;
      const id = identity(node.name, node.version), info = result.get(id) ?? { declaredIn: new Set<string>(), introducedBy: new Set<string>() };
      for (const file of declared.get(node) ?? []) { tick(); info.declaredIn.add(file); }
      for (const origin of origins.get(node) ?? []) { tick(); info.introducedBy.add(origin); }
      result.set(id, info);
    }
    return (name, version): RelationInfo => {
      const info = result.get(identity(name, version));
      return info ? { relation: info.declaredIn.size ? "direct" : info.introducedBy.size ? "transitive" : "unknown",
        ...(info.declaredIn.size ? { declaredIn: info.declaredIn } : {}), ...(info.introducedBy.size ? { introducedBy: info.introducedBy } : {}) } : { relation: "unknown" };
    };
  } catch { return null; }
}
