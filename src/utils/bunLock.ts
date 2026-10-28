import path from "node:path";
import { visit } from "jsonc-parser";
import { valid } from "semver";
import { MAX_DEPENDENCY_EDGES, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";

export interface BunWorkBudget { remaining: number }
export const createBunWorkBudget = (): BunWorkBudget => ({ remaining: MAX_DEPENDENCY_EDGES });
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const fields = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const rootFields = [...fields, "devDependencies"];
const safePath = (p: string) => !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p) && !/^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(p) && !p.split("/").includes("..");
const identity = (name: string, version: string) => JSON.stringify([name, version]);

/** JSONC visitor bounds allocation before constructing values, rejects duplicate keys. */
export function parseBunLock(source: string, budget = createBunWorkBudget()): Record<string, unknown> | null {
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) return null;
    const tick = () => { if (--budget.remaining < 0) throw new Error("Bun parse limit"); };
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
      if (stack.length >= 128) throw new Error("Bun nesting limit");
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
      onError: () => { throw new Error("invalid JSONC"); },
    }, { allowTrailingComma: true, disallowComments: false });
    if (!record(result) || ![0, 1, 2].includes(result.lockfileVersion as number)) return null;
    if (result.configVersion !== undefined && result.configVersion !== 0 && result.configVersion !== 1) return null;
    return result;
  } catch { return null; }
}

/** Coverage is independent of relationship traversal; empty workspace entries are valid. */
export function bunWorkspaceKeys(data: Record<string, unknown>, budget = createBunWorkBudget()): Set<string> | null {
  if (!record(data.workspaces)) return null;
  const keys = new Set<string>();
  for (const [raw, workspace] of Object.entries(data.workspaces)) {
    if (--budget.remaining < 0 || !safePath(raw) || !record(workspace)) return null;
    const normalized = raw === "" ? "" : path.posix.normalize(raw);
    if ((normalized === "." && raw !== "") || keys.has(normalized)) return null;
    for (const field of rootFields) {
      const deps = workspace[field];
      if (deps !== undefined && !record(deps)) return null;
      if (record(deps)) for (const ref of Object.values(deps)) {
        if (--budget.remaining < 0 || typeof ref !== "string" || ref.length === 0) return null;
      }
    }
    keys.add(normalized);
  }
  return keys;
}

/** Bun package paths omit node_modules; scoped names must remain single path components. */
function packagePath(key: string): string[] | null {
  const tokens = key.split("/"), parts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("@")) {
      const name = tokens[++i];
      if (!/^@[A-Za-z0-9_.-]+$/.test(token) || !name || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
      parts.push(`${token}/${name}`);
    } else {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(token) || token === "..") return null;
      parts.push(token);
    }
  }
  return parts;
}
interface BunNode { parts: string[]; name: string; version: string; info: Record<string, unknown>; registry: boolean; workspace?: string }

/** Resolve only the locked placement; never solve a range or follow local/Git source paths. */
export function bunLockRelations(data: Record<string, unknown>, budget = createBunWorkBudget()): RelationLookup {
  const tick = () => { if (--budget.remaining < 0) throw new Error("Bun relationship limit"); };
  try {
    if (!record(data.packages) || !record(data.workspaces)) return null;
    const workspaces = new Map<string, Record<string, unknown>>();
    for (const [rawPath, value] of Object.entries(data.workspaces)) {
      tick(); if (!record(value) || !safePath(rawPath)) return null;
      const location = rawPath === "" ? "" : path.posix.normalize(rawPath);
      if (location === "." || workspaces.has(location)) return null;
      workspaces.set(location, value);
    }
    const nodes = new Map<string, BunNode>(), anchors = new Map<string, string[] | null>();
    for (const [key, raw] of Object.entries(data.packages)) {
      tick(); const parts = packagePath(key);
      if (!parts || !Array.isArray(raw) || typeof raw[0] !== "string") return null;
      const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(raw[0]);
      if (!match) return null;
      const ref = match[2]!, registry = valid(ref) !== null && raw.length === 4 && typeof raw[1] === "string" && record(raw[2]) && typeof raw[3] === "string";
      const info = registry ? raw[2] as Record<string, unknown> : record(raw[1]) ? raw[1] : {};
      const node: BunNode = { parts, name: match[1]!, version: ref, info, registry };
      if (ref.startsWith("workspace:")) {
        const location = ref.slice("workspace:".length);
        if (safePath(location)) {
          node.workspace = location === "." ? "" : path.posix.normalize(location);
          anchors.set(node.workspace, anchors.has(node.workspace) ? null : parts);
        }
      }
      nodes.set(key, node);
    }
    const resolve = (from: string[], name: string, ref: unknown): BunNode | null => {
      tick();
      const nameParts = packagePath(name);
      if (typeof ref !== "string" || ref.length === 0 || !nameParts || nameParts.length !== 1) return null;
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) && !/^(?:npm:|workspace:|catalog:)/.test(ref)) return null;
      if (ref.includes("/") && !/^(?:npm:|workspace:|catalog:)/.test(ref)) return null;
      const context = [...from];
      for (;;) {
        tick(); const candidate = [...context, name].join("/");
        if (nodes.has(candidate)) {
          const node = nodes.get(candidate)!;
          return ref.startsWith("workspace:") && node.workspace === undefined ? null : node;
        } // An unsupported local identity is a barrier, not a fallback.
        if (!context.length) return null;
        context.pop();
      }
    };
    const declared = new Map<BunNode, Set<string>>(), introduced = new Map<BunNode, Set<string>>();
    const edges = (value: Record<string, unknown>, list: readonly string[]): [string, unknown][] => {
      const out: [string, unknown][] = [];
      const optional = record(value.optionalDependencies) ? value.optionalDependencies : {};
      if (value.unresolved !== undefined && (!Array.isArray(value.unresolved) || !value.unresolved.every(v => typeof v === "string"))) throw new Error("invalid unresolved dependencies");
      const unresolved = new Set(Array.isArray(value.unresolved) ? value.unresolved as string[] : []);
      for (const field of list) {
        const deps = value[field];
        if (deps === undefined) continue;
        if (!record(deps)) throw new Error("invalid dependencies");
        for (const [name, ref] of Object.entries(deps)) {
          tick();
          if (field !== "optionalDependencies" && Object.hasOwn(optional, name)) continue;
          if (field === "optionalDependencies" && unresolved.has(name)) continue;
          out.push([name, ref]);
        }
      }
      return out;
    };
    for (const [location, value] of workspaces) {
      tick();
      const context = location === "" ? [] : anchors.get(location);
      if (!context) continue;
      for (const [name, ref] of edges(value, rootFields)) {
        const target = resolve(context, name, ref);
        if (!target?.registry) continue;
        const paths = declared.get(target) ?? new Set<string>();
        paths.add(location === "" ? "package.json" : `${location}/package.json`); declared.set(target, paths);
      }
    }
    for (const origin of declared.keys()) {
      const seen = new Set([origin]), queue = [origin];
      while (queue.length) {
        tick(); const node = queue.pop()!;
        for (const [name, ref] of edges(node.info, fields)) {
          const target = resolve(node.parts, name, ref);
          if (!target?.registry || seen.has(target)) continue;
          seen.add(target); queue.push(target);
          const roots = introduced.get(target) ?? new Set<string>(); roots.add(origin.name); introduced.set(target, roots);
        }
      }
    }
    const merged = new Map<string, { declaredIn: Set<string>; introducedBy: Set<string> }>();
    for (const node of nodes.values()) {
      tick(); if (!node.registry) continue;
      const key = identity(node.name, node.version), info = merged.get(key) ?? { declaredIn: new Set<string>(), introducedBy: new Set<string>() };
      for (const p of declared.get(node) ?? []) { tick(); info.declaredIn.add(p); }
      for (const p of introduced.get(node) ?? []) { tick(); info.introducedBy.add(p); }
      merged.set(key, info);
    }
    return (name, version): RelationInfo => {
      const info = merged.get(identity(name, version));
      return info ? { relation: info.declaredIn.size ? "direct" : info.introducedBy.size ? "transitive" : "unknown",
        ...(info.declaredIn.size ? { declaredIn: info.declaredIn } : {}), ...(info.introducedBy.size ? { introducedBy: info.introducedBy } : {}) } : { relation: "unknown" };
    };
  } catch { return null; }
}
