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

const REGISTRY = "https://registry.npmjs.org";

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
 * JSONとして解析できなければnull(呼び出し側はコピーをそのまま渡す)
 */
export function fillMissingResolved(text: string): { changed: boolean; content: string; filled: number } | null {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(lock)) return null;
  let filled = 0;
  if (isRecord(lock.packages)) filled += fillPackages(lock.packages);
  if (isRecord(lock.dependencies)) filled += fillDependencies(lock.dependencies, 0);
  return filled === 0 ? { changed: false, content: text, filled } : { changed: true, content: JSON.stringify(lock, null, 2), filled };
}
