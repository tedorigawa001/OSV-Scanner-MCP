import { CST, Lexer, Parser } from "yaml";
import path from "node:path";
import { MAX_DEPENDENCY_EDGES, MAX_LOCKFILE_LINES, createParseBudget, type RelationInfo, type RelationLookup } from "./dependencyRelations.js";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const identity = (name: string, version: string) => JSON.stringify([name, version]);
const fields = ["dependencies", "optionalDependencies"] as const;

/** Importers use portable forward-slash paths; preserve Unicode and spaces. */
function safeImporterPath(root: string): boolean {
  return root.length > 0 && !path.posix.isAbsolute(root) && !path.win32.isAbsolute(root)
    && !/^[A-Za-z]:/.test(root) && !/[\\\x00-\x1f\x7f]/.test(root)
    && !root.split("/").includes("..");
}

export interface PnpmWorkBudget { remaining: number }
export const createPnpmWorkBudget = (): PnpmWorkBudget => ({ remaining: MAX_DEPENDENCY_EDGES });

/** 文書の組み立てに使わず、構文木だけで拒否するトークン(別名による展開・型の指定・複数の文書) */
const REJECTED_TOKENS = new Set(["anchor", "alias", "tag", "directive-line", "directive", "doc-start"]);

/**
 * yamlのparseDocumentは大きなマップの組み立てが二次時間で、5.5MiB(28,000パッケージ)で11秒同期的に止まった
 * (脆弱性チェックで判明、2026-10-27)。構文木(Parser。線形時間)から必要な値だけをJSの値にする。
 * 文字列・マップ・配列だけを扱い(failsafeと同じ)、別名・タグ・重複キー・解釈できない構文はnull
 */
function lockfileToJs(source: string, tick: () => void): unknown {
  for (const token of new Lexer().lex(source)) {
    tick();
    const type = CST.tokenType(token);
    if (type !== null && REJECTED_TOKENS.has(type)) return null;
  }
  const documents = [];
  for (const token of new Parser().parse(source)) {
    tick();
    if (token.type === "document") documents.push(token);
    else if (token.type !== "comment" && token.type !== "space" && token.type !== "newline") return null;
  }
  if (documents.length !== 1) return null;
  let invalid = false;
  const convert = (node: CST.Token | undefined): unknown => {
    tick();
    if (node === undefined || invalid) return "";
    switch (node.type) {
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
      case "block-scalar": {
        const resolved = CST.resolveAsScalar(node, true, () => { invalid = true; });
        if (resolved === null) invalid = true;
        return resolved?.value ?? "";
      }
      case "block-map":
      case "flow-collection": {
        const isFlowSeq = node.type === "flow-collection" && node.start.source === "[";
        if (node.type === "block-map" || !isFlowSeq) {
          // __proto__等のキーで原型を汚染しないよう、原型の無いオブジェクトにする
          const map: Record<string, unknown> = Object.create(null);
          for (const item of node.items) {
            const key = item.key === undefined || item.key === null ? null : convert(item.key);
            if (typeof key !== "string" || key in map) { invalid = true; return map; }
            map[key] = convert(item.value ?? undefined);
          }
          return map;
        }
        return node.items.map((item) => convert(item.value ?? undefined));
      }
      case "block-seq":
        return node.items.map((item) => convert(item.value ?? undefined));
      default:
        invalid = true;
        return "";
    }
  };
  const value = convert(documents[0]!.value);
  return invalid ? null : value;
}

/** Bounded YAML parsing shared by relationships and workspace coverage. */
export function parseLockYaml(source: string, workBudget: number | PnpmWorkBudget = MAX_DEPENDENCY_EDGES): Record<string, unknown> | null {
  // 予算は数(この呼び出しだけ)か、スキャン全体で共有するオブジェクト
  const budget = typeof workBudget === "number" ? { remaining: workBudget } : workBudget;
  const tick = () => { if (--budget.remaining < 0) throw new Error("pnpm relationship work limit"); };
  try {
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) return null;
    const lines = source.split(/\r?\n/);
    if (lines.length > MAX_LOCKFILE_LINES) return null;
    // Conservative pre-parse nesting bounds, including flow collections.
    let flow = 0;
    for (const line of lines) {
      if (/^ {257}/.test(line)) return null;
      for (const char of line) {
        if (char === "[" || char === "{") { if (++flow > 128) return null; }
        else if (char === "]" || char === "}") flow = Math.max(0, flow - 1);
      }
    }
    const data = lockfileToJs(source, tick);
    return record(data) ? data : null;
  } catch { return null; }
}

export function parsePnpmLock(source: string, workBudget: number | PnpmWorkBudget = MAX_DEPENDENCY_EDGES): Record<string, unknown> | null {
  const data = parseLockYaml(source, workBudget);
  return data && ["5.3", "5.4", "6.0", "9.0"].includes(String(data.lockfileVersion)) ? data : null;
}

/** Importer paths establish inclusion without following any source paths. */
export function pnpmImporterKeys(data: Record<string, unknown>, budget: PnpmWorkBudget): Set<string> | null {
  const importers = data.importers;
  if (!record(importers)) return importers === undefined && String(data.lockfileVersion).startsWith("5.") ? new Set(["."]) : null;
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(importers)) {
    if (--budget.remaining < 0 || !safeImporterPath(key) || !record(value)) return null;
    const normalized = path.posix.normalize(key);
    if (keys.has(normalized)) return null;
    for (const field of [...fields, "devDependencies"]) {
      if (value[field] !== undefined && !record(value[field])) return null;
      if (record(value[field])) for (const ref of Object.values(value[field])) {
        if (--budget.remaining < 0) return null;
        const version = record(ref) ? ref.version : ref;
        if (typeof version !== "string" || version.length === 0) return null;
      }
    }
    keys.add(normalized);
  }
  return keys;
}

/** Read only the captured lockfile. Never resolve links, run pnpm, or solve version ranges. */
export function pnpmLockRelations(source: string, workBudget: number | PnpmWorkBudget = MAX_DEPENDENCY_EDGES): RelationLookup {
  const budget = typeof workBudget === "number" ? { remaining: workBudget } : workBudget;
  const tick = () => { if (--budget.remaining < 0) throw new Error("pnpm relationship work limit"); };
  try {
    // Parsing has its own size-based budget; the shared budget bounds the graph work.
    const data = parsePnpmLock(source, createParseBudget(source));
    if (data === null) return null;
    const modern = data.lockfileVersion === "9.0";
    const packages = record(data.packages) ? data.packages : {};
    const snapshots = modern ? data.snapshots : packages;
    if (!record(snapshots)) return null;
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
