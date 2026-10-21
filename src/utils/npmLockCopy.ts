/**
 * package-lock.json(npm-shrinkwrap.jsonを含む)のスナップショットのコピーで、`resolved`の無いエントリに
 * 公開レジストリの形のURLを補う(docs/DESIGN_TODO.md「osv-scannerのピン留め更新」)。
 *
 * osv-scanner 2.7.0(osv-scalibrの`DeterminePackageSource`)は、`resolved`が無いエントリをローカルのパッケージとみなして
 * 照会しない(2026-10-15 実機確認)。バンドルされた依存(`inBundle` / v1の`bundled`)や、npmの
 * `omit-lockfile-registry-resolved=true`で生成したlockfileのレジストリのパッケージが黙って照会されなくなる(偽陰性)。
 * 2.4.0は照会していたため、補うことで同じ範囲を照会させる(送る名前は2.4.0と同じ)。
 *
 * 対象外(ローカルのパッケージ): `link: true`、キーが`node_modules/`を含まないエントリ(ローカルのディレクトリ・workspace)、
 * 版が`file:`・`git+...`・`user/repo`等の参照のもの(v1の別名`npm:<名前>@<版>`は実際の名前と版で補う)。`resolved`があるもの(`file:`のtarballを含む)は変えない。
 */

import { ScanToolError } from "../errors.js";

export const MAX_NPM_LOCK_BYTES = 16 * 1024 * 1024;
export const MAX_NPM_LOCK_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_JSON_STRUCTURE = 1_000_000;
const REGISTRY = "https://registry.npmjs.org";

export interface NpmLockWorkBudget {
  remaining: number;
}

export function createNpmLockWorkBudget(): NpmLockWorkBudget {
  return { remaining: 2_000_000 };
}

function limitExceeded(limit: string): never {
  throw new ScanToolError("scan_input_too_large", `The npm lockfile exceeds the ${limit}. Narrow the target or use a smaller lockfile`);
}

/** Bound allocation before JSON.parse; JSON syntax itself is still validated by the native parser. */
export function parseNpmLock(text: string, budget = createNpmLockWorkBudget()): unknown {
  if (text.length > MAX_NPM_LOCK_BYTES || Buffer.byteLength(text, "utf8") > MAX_NPM_LOCK_BYTES) {
    limitExceeded(`input byte limit (${MAX_NPM_LOCK_BYTES} bytes)`);
  }
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let structure = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{" || char === "[") {
      if (++depth > MAX_JSON_DEPTH) limitExceeded(`JSON depth limit (${MAX_JSON_DEPTH})`);
      structure++;
    } else if (char === "}" || char === "]") depth--;
    else if (char === "," || char === ":") structure++;
    if (structure > MAX_JSON_STRUCTURE) limitExceeded(`JSON structure limit (${MAX_JSON_STRUCTURE})`);
    if (structure > budget.remaining) limitExceeded("scan-wide JSON structure limit");
  }
  budget.remaining -= structure;
  return JSON.parse(text);
}

/** Measure compact output before materializing it, including JSON escaping and number formatting. */
function stringifyNpmLock(lock: unknown, maxBytes: number): string {
  let remaining = maxBytes;
  const reserve = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) limitExceeded(`output byte limit (${maxBytes} bytes)`);
  };
  const measure = (value: unknown): void => {
    if (typeof value === "object" && value !== null) {
      reserve(2);
      const array = Array.isArray(value);
      const record = value as Record<string, unknown>;
      let first = true;
      for (const key of Object.keys(value)) {
        if (!first) reserve(1);
        first = false;
        if (!array) {
          reserve(key.length);
          reserve(Buffer.byteLength(JSON.stringify(key), "utf8") - key.length + 1);
        }
        measure(record[key]);
      }
    } else {
      if (typeof value === "string" && value.length > remaining) limitExceeded(`output byte limit (${maxBytes} bytes)`);
      reserve(Buffer.byteLength(JSON.stringify(value)!, "utf8"));
    }
  };
  measure(lock);
  return JSON.stringify(lock);
}

/** 照会させてよい版(参照でない、ふつうの版の文字) */
const PLAIN_VERSION = /^[0-9A-Za-z.+-]{1,256}$/;
const IN_NODE_MODULES = /(?:^|\/)node_modules\//;
/** v1の別名の依存の版(`npm:<実際の名前>@<版>`。スコープ付きの名前を含む) */
const NPM_ALIAS = /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)@(.+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lacksResolved(entry: Record<string, unknown>): boolean {
  return entry.resolved === undefined || entry.resolved === "";
}

function registryUrl(name: string, version: string): string {
  const base = name.split("/").pop()!;
  return `${REGISTRY}/${name}/-/${base}-${version}.tgz`;
}

/** v2以降の`packages`: キーの最後の`node_modules/`より後ろがパッケージ名(別名では`name`が実際の名前) */
function fillPackages(packages: Record<string, unknown>): number {
  let filled = 0;
  for (const [key, entry] of Object.entries(packages)) {
    if (!isRecord(entry) || !IN_NODE_MODULES.test(key) || entry.link === true || !lacksResolved(entry)) continue;
    const version = entry.version;
    if (typeof version !== "string" || !PLAIN_VERSION.test(version)) continue;
    const name = typeof entry.name === "string" ? entry.name : key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
    if (name === "") continue;
    entry.resolved = registryUrl(name, version);
    filled++;
  }
  return filled;
}

/**
 * v1の依存の実際の名前と版。別名(`"version": "npm:lodash@4.17.20"`)は実際の名前と版を取り出す
 * (osv-scannerもこの表記を実際の名前と版として照会する。2026-10-15 実機確認)。参照(`file:`・git等)はnull
 */
function registryPackage(name: string, version: string): { name: string; version: string } | null {
  if (PLAIN_VERSION.test(version)) return { name, version };
  const alias = NPM_ALIAS.exec(version);
  if (alias !== null && PLAIN_VERSION.test(alias[2]!)) return { name: alias[1]!, version: alias[2]! };
  return null;
}

/** v1の`dependencies`(入れ子) */
function fillDependencies(dependencies: Record<string, unknown>, depth: number): number {
  if (depth > 256) return 0;
  let filled = 0;
  for (const [name, entry] of Object.entries(dependencies)) {
    if (!isRecord(entry)) continue;
    const version = entry.version;
    const target = typeof version === "string" ? registryPackage(name, version) : null;
    if (lacksResolved(entry) && target !== null) {
      entry.resolved = registryUrl(target.name, target.version);
      filled++;
    }
    if (isRecord(entry.dependencies)) filled += fillDependencies(entry.dependencies, depth + 1);
  }
  return filled;
}

/**
 * `resolved`を補ったlockfileの内容。補うエントリが無ければ`changed: false`(コピーを書き換えない)。
 * JSONとして解析できなければnull(呼び出し側はコピーをそのまま渡す)。資源上限超過は型付きエラーで停止する。
 */
export function fillMissingResolved(
  text: string,
  maxOutputBytes = MAX_NPM_LOCK_BYTES,
  budget = createNpmLockWorkBudget(),
): { changed: boolean; content: string; filled: number } | null {
  let lock: unknown;
  try {
    lock = parseNpmLock(text, budget);
  } catch (error) {
    if (error instanceof ScanToolError) throw error;
    return null;
  }
  if (!isRecord(lock)) return null;
  let filled = 0;
  if (isRecord(lock.packages)) filled += fillPackages(lock.packages);
  if (isRecord(lock.dependencies)) filled += fillDependencies(lock.dependencies, 0);
  return filled === 0 ? { changed: false, content: text, filled } : { changed: true, content: stringifyNpmLock(lock, maxOutputBytes), filled };
}
