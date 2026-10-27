import { parseDocument } from "yaml";
import path from "node:path";
import { MAX_DEPENDENCY_EDGES, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identity = (name: string, version: string) => JSON.stringify([name, version]);
const fields = ["dependencies", "optionalDependencies"] as const;

/** Importers use portable forward-slash paths; preserve Unicode and spaces. */
function safeImporterPath(root: string): boolean {
  return root.length > 0 && !path.posix.isAbsolute(root) && !path.win32.isAbsolute(root)
    && !/^[A-Za-z]:/.test(root) && !/[\\\x00-\x1f\x7f]/.test(root)
    && !root.split("/").includes("..");
}

/** Read only the captured lockfile. Never resolve links, run pnpm, or solve version ranges. */
export function pnpmLockRelations(source: string, maxWork = MAX_DEPENDENCY_EDGES): RelationLookup {
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) return null;
    const lines = source.split(/\r?\n/);
    if (lines.length > 200_000) return null;
    // Conservative pre-parse nesting bounds, including flow collections.
    let flow = 0;
    for (const line of lines) {
      if (/^ {257}/.test(line)) return null;
      for (const char of line) {
        if (char === "[" || char === "{") { if (++flow > 128) return null; }
        else if (char === "]" || char === "}") flow = Math.max(0, flow - 1);
      }
    }
    const doc = parseDocument(source, { schema: "failsafe", uniqueKeys: true });
    if (doc.errors.length) return null;
    const data: unknown = doc.toJS({ maxAliasCount: 0 });
    if (!record(data) || !["5.3", "5.4", "6.0", "9.0"].includes(String(data.lockfileVersion))) return null;
    const modern = data.lockfileVersion === "9.0";
    const packages = record(data.packages) ? data.packages : {};
    const snapshots = modern ? data.snapshots : packages;
    if (!record(snapshots)) return null;
    let work = maxWork;
    const tick = () => { if (--work < 0) throw new Error("pnpm relationship work limit"); };
    const nodes = new Map<string, { name: string; version: string; value: Record<string, unknown> }>();
    for (const [rawKey, value] of Object.entries(snapshots)) {
      tick();
      if (!record(value)) continue;
      const key = rawKey.replace(/^\//, "");
      const match = /^(?:(@[^/]+\/[^/@]+|[^/@]+)@|(@[^/]+\/[^/]+|[^/]+)\/)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\(.*\)|_.*)?$/.exec(key);
      if (!match) continue;
      const base = key.split("(")[0]!;
      const metadata = modern ? packages[base] : value;
      // Non-registry identities cannot establish an npm release relationship.
      if (!record(metadata) || metadata.id !== undefined || metadata.name !== undefined || metadata.version !== undefined) continue;
      if (record(metadata.resolution) && (metadata.resolution.type !== undefined || metadata.resolution.directory !== undefined)) continue;
      if (nodes.has(key)) return null;
      nodes.set(key, { name: (match[1] ?? match[2])!, version: match[3]!, value });
    }
    const resolve = (name: string, raw: unknown): string | null => {
      tick();
      const ref = record(raw) ? raw.version : raw;
      if (typeof ref !== "string" || /^(?:link:|file:|workspace:|https?:|git|github:)/.test(ref)) return null;
      const normalized = ref.replace(/^npm:/, "").replace(/^\//, "");
      const candidates = new Set([normalized, `${name}@${normalized}`, `${name}/${normalized}`].filter(key => nodes.has(key)));
      return candidates.size === 1 ? [...candidates][0]! : null;
    };
    const direct = new Map<string, Set<string>>();
    const introduced = new Map<string, Set<string>>();
    const importers = record(data.importers) ? data.importers : { ".": data };
    for (const [root, importer] of Object.entries(importers)) {
      tick();
      if (!record(importer) || !safeImporterPath(root)) continue;
      for (const field of [...fields, "devDependencies"]) {
        const deps = importer[field];
        if (!record(deps)) continue;
        for (const [name, ref] of Object.entries(deps)) {
          const target = resolve(name, ref);
          if (!target) continue;
          const declarations = direct.get(target) ?? new Set<string>();
          declarations.add(root === "." ? "package.json" : `${root}/package.json`);
          direct.set(target, declarations);
        }
      }
    }
    for (const origin of direct.keys()) {
      const seen = new Set([origin]), queue = [origin];
      while (queue.length) {
        tick();
        const node = nodes.get(queue.pop()!)!;
        for (const field of fields) {
          const deps = node.value[field];
          if (!record(deps)) continue;
          for (const [name, ref] of Object.entries(deps)) {
            const target = resolve(name, ref);
            if (!target || seen.has(target)) continue;
            seen.add(target); queue.push(target);
            const roots = introduced.get(target) ?? new Set<string>();
            roots.add(nodes.get(origin)!.name); introduced.set(target, roots);
          }
        }
      }
    }
    const merged = new Map<string, { declaredIn: Set<string>; introducedBy: Set<string> }>();
    for (const [key, node] of nodes) {
      tick();
      const id = identity(node.name, node.version);
      const info = merged.get(id) ?? { declaredIn: new Set<string>(), introducedBy: new Set<string>() };
      for (const declaration of direct.get(key) ?? []) { tick(); info.declaredIn.add(declaration); }
      for (const origin of introduced.get(key) ?? []) { tick(); info.introducedBy.add(origin); }
      merged.set(id, info);
    }
    return (name, version): RelationInfo => {
      const info = merged.get(identity(name, version));
      return info ? {
        relation: info.declaredIn.size ? "direct" : info.introducedBy.size ? "transitive" : "unknown",
        ...(info.declaredIn.size ? { declaredIn: info.declaredIn } : {}),
        ...(info.introducedBy.size ? { introducedBy: info.introducedBy } : {}),
      } : { relation: "unknown" };
    };
  } catch { return null; }
}
