import path from "node:path";
import { satisfies, valid, validRange } from "semver";
import { MAX_DEPENDENCY_EDGES, MAX_LOCKFILE_LINES, createParseBudget, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";
import { parseLockYaml, type PnpmWorkBudget } from "./pnpmRelations.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const key = (name: string, version: string) => JSON.stringify([name, version]);
const fields = ["dependencies", "optionalDependencies"] as const;
const roots = [...fields, "devDependencies"];
const safePath = (p: string) => p.length > 0 && !path.posix.isAbsolute(p) && !path.win32.isAbsolute(p)
  && !/^[A-Za-z]:|[\\\x00-\x1f\x7f]/.test(p) && !p.split("/").includes("..");
export interface YarnManifest { path: string; data: Record<string, unknown> | null }
interface Node { name: string; version: string; value: Record<string, unknown>; workspace?: string }
export interface YarnAnalysis { lookup: RelationLookup; members: Map<string, boolean | null> }
const scalar = (s: string): string => s.startsWith('"') ? JSON.parse(s) as string : s;

/** Classic selector lists can contain quoted commas; never split inside quotes. */
function selectors(source: string): string[] {
  let start = 0, quoted = false, escaped = false;
  const out: string[] = [];
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && c === "\\") { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if ((!quoted && c === ",") || i === source.length) {
      const value = scalar(source.slice(start, i).trim());
      if (!value) throw new Error("empty Yarn selector");
      out.push(value); start = i + 1;
    }
  }
  if (quoted) throw new Error("unterminated Yarn selector");
  return out;
}

/** Classic's line format is not YAML. Reject syntax outside generated v1 maps. */
function classic(source: string, tick: () => void): Map<string, Record<string, unknown>> | null {
  if (!/^# yarn lockfile v1\s*$/m.test(source)) return null;
  const entries = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null, nested: Record<string, unknown> | null = null;
  for (const line of source.split(/\r?\n/)) {
    tick();
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!line.startsWith(" ")) {
      if (!line.endsWith(":")) return null;
      current = Object.create(null) as Record<string, unknown>; nested = null;
      for (const selector of selectors(line.slice(0, -1))) {
        if (entries.has(selector)) return null;
        entries.set(selector, current);
      }
      continue;
    }
    if (!current) return null;
    const match = /^( {2}| {4})("(?:[^"\\]|\\.)*"|[^\s:]+)(?::|\s+(.*))$/.exec(line);
    if (!match) return null;
    const name = scalar(match[2]!);
    const container = match[1]!.length === 2 ? current : nested;
    if (!container || Object.hasOwn(container, name)) return null;
    if (match[3] === undefined) {
      if (match[1]!.length !== 2) return null;
      nested = Object.create(null) as Record<string, unknown>; current[name] = nested;
    } else {
      container[name] = scalar(match[3]);
      if (match[1]!.length === 2) nested = null;
    }
  }
  return entries;
}

/** Bounded glob matching (*, ?, whole-segment **); no generated regular expressions. */
function glob(pattern: string, target: string, tick: () => void): boolean | null {
  if (!safePath(pattern) || /[\[\]{}()!]/.test(pattern) || pattern.split("/").some(s => s.includes("**") && s !== "**")) return null;
  // Yarn strips one trailing slash before matching; other empty segments remain unconfirmed.
  const parts = pattern.replace(/^\.\//, "").replace(/\/$/, "").split("/"), names = target.split("/");
  if (parts.includes("")) return null;
  let row = new Array<boolean>(names.length + 1).fill(false); row[0] = true;
  for (const part of parts) {
    const next = new Array<boolean>(names.length + 1).fill(false);
    if (part === "**") next[0] = row[0]!;
    for (let j = 1; j <= names.length; j++) {
      tick();
      if (part === "**") {
        // Globstar may match zero segments, but cannot consume a hidden one.
        next[j] = row[j]! || (!names[j - 1]!.startsWith(".") && next[j - 1]!);
        continue;
      }
      if (!row[j - 1]) continue;
      if (names[j - 1]!.startsWith(".") && !part.startsWith(".")) continue;
      let chars = new Array<boolean>(names[j - 1]!.length + 1).fill(false); chars[0] = true;
      for (const ch of part) {
        const values = new Array<boolean>(chars.length).fill(false); values[0] = ch === "*" && chars[0]!;
        for (let k = 1; k < chars.length; k++) {
          tick(); values[k] = ch === "*" ? chars[k]! || values[k - 1]! : chars[k - 1]! && (ch === "?" || ch === names[j - 1]![k - 1]);
        }
        chars = values;
      }
      next[j] = chars.at(-1)!;
    }
    row = next;
  }
  return row.at(-1)!;
}

function workspaceMatch(root: Record<string, unknown> | null, member: string, tick: () => void): boolean | null {
  if (root === null) return null;
  if (member === ".") return true;
  const raw = record(root.workspaces) ? root.workspaces.packages : root.workspaces;
  if (raw === undefined) return false;
  if (root.private !== true) return null;
  if (!Array.isArray(raw) || !raw.every(p => typeof p === "string")) return null;
  let matched = false;
  for (const rawPattern of raw as string[]) {
    tick();
    const negative = rawPattern.startsWith("!"), pattern = negative ? rawPattern.slice(1) : rawPattern;
    const result = glob(pattern, member, tick);
    if (result === null) return null;
    if (result && negative) return false;
    if (result) matched = true;
  }
  return matched;
}

/**
 * Captured inputs only. Unsupported identities never fall back to a same-named release.
 * Coverage and relationships use separate budgets: relationship traversal grows with direct roots x packages,
 * and exhausting it must not turn already confirmed workspace coverage into unconfirmed.
 */
export function analyzeYarn(source: string, manifests: readonly YarnManifest[], budget: PnpmWorkBudget = { remaining: MAX_DEPENDENCY_EDGES },
  relationBudget: PnpmWorkBudget = { remaining: MAX_DEPENDENCY_EDGES }): YarnAnalysis {
  const unknown = (): YarnAnalysis => ({ lookup: null, members: new Map(manifests.map(m => [m.path, null])) });
  // Parsing uses a per-file budget sized from the input; indexing and coverage then use the shared budget.
  let active = createParseBudget(source);
  const tick = () => { if (--active.remaining < 0) throw new Error("Yarn work limit"); };
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024 || source.split(/\r?\n/).length > MAX_LOCKFILE_LINES) return unknown();
    const isClassic = /^# yarn lockfile v1\s*$/m.test(source);
    let entries: Map<string, Record<string, unknown>>;
    if (isClassic) {
      const parsed = classic(source, tick); if (!parsed) return unknown(); entries = parsed;
      active = budget;
    } else {
      const data = parseLockYaml(source, active);
      active = budget;
      if (!data || !record(data.__metadata) || !["4", "5", "6", "8"].includes(String(data.__metadata.version))) return unknown();
      entries = new Map();
      for (const [combined, value] of Object.entries(data)) {
        tick(); if (combined === "__metadata") continue;
        if (!record(value)) return unknown();
        for (const descriptor of combined.split(/, /)) {
          if (entries.has(descriptor)) return unknown(); entries.set(descriptor, value);
        }
      }
    }
    const byValue = new Map<Record<string, unknown>, Node>(), descriptors = new Map<string, Node>();
    const workspaceNodes = new Map<string, Node | null>();
    for (const [descriptor, value] of entries) {
      tick(); let node = byValue.get(value);
      if (!node) {
        const resolution = typeof value.resolution === "string" ? value.resolution : descriptor;
        const match = /^(@[^/]+\/[^@]+|[^@]+)@(.+)$/.exec(resolution);
        if (!match || typeof value.version !== "string") continue;
        let name = match[1]!, ref = match[2]!;
        if (isClassic && ref.startsWith("npm:")) {
          const alias = /^npm:(@[^/]+\/[^@]+|[^@]+)@/.exec(ref);
          if (!alias) continue; name = alias[1]!; ref = ref.slice(alias[0].length);
        }
        if (!isClassic && ref.startsWith("workspace:")) {
          const location = ref.slice("workspace:".length);
          if (!safePath(location)) continue;
          node = { name, version: value.version, value, workspace: path.posix.normalize(location) };
          workspaceNodes.set(node.workspace!, workspaceNodes.has(node.workspace!) ? null : node);
        } else {
          if ((!isClassic && !/^npm:/.test(ref)) || (isClassic && validRange(ref) === null && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(ref)) || !valid(value.version)) continue;
          node = { name, version: value.version, value };
        }
        byValue.set(value, node);
      }
      descriptors.set(descriptor, node);
    }
    const local = new Map<string, YarnManifest | null>();
    const localMatch = (name: string, ref: string): boolean => {
      const candidate = local.get(name), version = candidate?.data?.version;
      return candidate !== null && typeof version === "string" && valid(version) !== null && satisfies(version, ref);
    };
    const resolve = (name: string, ref: unknown): Node | null => {
      tick(); if (typeof ref !== "string") return null;
      if (isClassic && (local.get(name) === null || localMatch(name, ref))) return null;
      const exact = descriptors.get(`${name}@${ref}`);
      return exact ?? (!isClassic && !/^[A-Za-z][A-Za-z+.-]*:/.test(ref) ? descriptors.get(`${name}@npm:${ref}`) ?? null : null);
    };
    const members = new Map<string, boolean | null>(), declarations = new Map<Node, Set<string>>();
    const rootManifest = manifests.find(m => m.path === "package.json")?.data ?? null;
    const included = new Map<string, YarnManifest>();
    for (const manifest of manifests) {
      tick(); const directory = path.posix.dirname(manifest.path);
      let status = isClassic ? workspaceMatch(rootManifest, directory, tick) : workspaceNodes.has(directory) ? workspaceNodes.get(directory) === null ? null : true : false;
      if (isClassic && status === true && directory !== "." && manifest.data !== null) {
        const { name, version } = manifest.data;
        // Classic ignores child manifests without a usable name/version; the root may omit them.
        if (typeof name !== "string" || name.trim() === "" || typeof version !== "string" || !valid(version)) status = false;
      }
      members.set(manifest.path, status === true && manifest.data === null ? null : status);
      if (status === true && manifest.data !== null) included.set(directory, manifest);
    }
    // Classic does not record workspace nodes; only uniquely named, configured captured members can satisfy local references.
    if (isClassic) for (const manifest of included.values()) {
      tick(); const name = manifest.data?.name;
      if (typeof name === "string") local.set(name, local.has(name) ? null : manifest);
    }
    const add = (node: Node, manifest: string) => {
      if (node.workspace !== undefined) return;
      const declared = declarations.get(node) ?? new Set<string>(); declared.add(manifest); declarations.set(node, declared);
    };
    for (const [directory, manifest] of included) {
      let confirmed = true;
      const data = manifest.data!;
      if (!isClassic && typeof data.name === "string" && workspaceNodes.get(directory)?.name !== data.name) confirmed = false;
      for (const field of roots) {
        const deps = data[field];
        if (deps !== undefined && !record(deps)) { confirmed = false; continue; }
        if (!record(deps)) continue;
        for (const [name, ref] of Object.entries(deps)) {
          tick(); const target = resolve(name, ref);
          if (target) {
            if (isClassic) add(target, manifest.path);
            else {
              const locked = workspaceNodes.get(directory)?.value.dependencies;
              if (!record(locked) || resolve(name, locked[name]) !== target) confirmed = false;
            }
          } else if (!(isClassic && typeof ref === "string" && localMatch(name, ref))) confirmed = false;
        }
      }
      if (!confirmed) members.set(manifest.path, null);
    }
    active = relationBudget;
    try {
      if (!isClassic) for (const [directory, node] of workspaceNodes) {
        tick(); if (!node) continue;
        for (const field of fields) if (record(node.value[field])) for (const [name, ref] of Object.entries(node.value[field])) {
          const target = resolve(name, ref); if (target) add(target, directory === "." ? "package.json" : `${directory}/package.json`);
        }
      }
      const origins = new Map<Node, Set<string>>();
      for (const origin of declarations.keys()) {
        const seen = new Set([origin]), queue = [origin];
        while (queue.length) {
          tick(); const node = queue.pop()!;
          for (const field of fields) if (record(node.value[field])) for (const [name, ref] of Object.entries(node.value[field])) {
            const target = resolve(name, ref);
            if (!target || seen.has(target) || target.workspace !== undefined) continue;
            seen.add(target); queue.push(target);
            const by = origins.get(target) ?? new Set<string>(); by.add(origin.name); origins.set(target, by);
          }
        }
      }
      const merged = new Map<string, { declaredIn: Set<string>; introducedBy: Set<string> }>();
      for (const node of byValue.values()) {
        tick(); if (node.workspace !== undefined) continue;
        const id = key(node.name, node.version), info = merged.get(id) ?? { declaredIn: new Set<string>(), introducedBy: new Set<string>() };
        for (const p of declarations.get(node) ?? []) { tick(); info.declaredIn.add(p); }
        for (const p of origins.get(node) ?? []) { tick(); info.introducedBy.add(p); }
        merged.set(id, info);
      }
      return { members, lookup: (name, version): RelationInfo => {
        const info = merged.get(key(name, version));
        return info ? { relation: info.declaredIn.size ? "direct" : info.introducedBy.size ? "transitive" : "unknown",
          ...(info.declaredIn.size ? { declaredIn: info.declaredIn } : {}), ...(info.introducedBy.size ? { introducedBy: info.introducedBy } : {}) } : { relation: "unknown" };
      } };
    } catch { return { members, lookup: null }; }
  } catch { return unknown(); }
}
