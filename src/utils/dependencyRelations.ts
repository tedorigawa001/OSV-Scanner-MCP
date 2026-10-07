/**
 * 直接/推移的依存の判定(docs/DESIGN_TODO.md「直接/推移的依存の区別(v0.7.0)詳細設計メモ」)。
 *
 * osv-scannerの出力には直接/推移的の区別がないため、スキャンしたファイル(スナップショットのコピー)を解析する。
 * 新しい外部依存は追加せず、JSON(package-lock.json)と行形式(go.mod、requirements.txt)だけを扱う。
 * - package-lock.json(v2以降): ルートとworkspaceの依存をNodeの解決規則で解決したものが直接依存、
 *   そこからたどれるものが推移的依存。経由した直接依存の名前(introduced_by)と、宣言したpackage.json(declared_in)を返す
 * - go.mod: `// indirect`のないrequireが直接依存。replaceの置換先にも同じ関係を当てる(osv-scannerは置換先で報告する)
 * - requirements.txt: 本サーバーが書いたコピーの行が直接依存、それ以外(deps.devで解決された依存)が推移的依存
 */

export type DependencyRelation = "direct" | "transitive" | "mixed" | "unknown";

/** 1つのファイルでの、ある名前・版の依存の関係 */
export interface RelationInfo {
  relation: "direct" | "transitive" | "unknown";
  /** npm: 推移的に要求している直接依存の名前 */
  introducedBy?: ReadonlySet<string>;
  /** npm: 直接依存として宣言しているpackage.json(projectからの相対パスではなく、lockfileの位置からの相対パス) */
  declaredIn?: ReadonlySet<string>;
  /** Go: go.modのreplaceの置換元または置換先(requireの版を変えても効かない) */
  replaced?: true;
}

/**
 * ファイルごとの判定。null = このファイルでは判定できない(すべてunknown)。
 * sourceTypeはosv-scannerの`results[].source.type`(pom.xmlの判定に使う。他の形式は使わない)
 */
export type RelationLookup = ((name: string, version: string, sourceType?: string | null) => RelationInfo) | null;

/** たどる依存の辺の上限(巨大・悪意あるlockfileで処理が膨らまないように) */
export const MAX_DEPENDENCY_EDGES = 2_000_000;

const UNKNOWN: RelationInfo = { relation: "unknown" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function depNames(entry: Record<string, unknown>, fields: readonly string[]): string[] {
  const names: string[] = [];
  for (const field of fields) {
    const deps = entry[field];
    if (isRecord(deps)) names.push(...Object.keys(deps));
  }
  return names;
}

const NODE_MODULES = "node_modules/";
const INSTALLED_DEP_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const ROOT_DEP_FIELDS = [...INSTALLED_DEP_FIELDS, "devDependencies"] as const;

/** エントリの本来の名前: `name`があればそれ(別名のインストール)、なければキーの最後のnode_modules/以降 */
function entryName(key: string, entry: Record<string, unknown>): string {
  if (typeof entry.name === "string" && entry.name !== "") return entry.name;
  const index = key.lastIndexOf(NODE_MODULES);
  return index === -1 ? key : key.slice(index + NODE_MODULES.length);
}

/** ルート("")とworkspace(node_modules/の外のディレクトリ)が起点 */
function isRoot(key: string): boolean {
  return key === "" || (!key.startsWith(NODE_MODULES) && !key.includes(`/${NODE_MODULES}`));
}

/**
 * package-lock.json(v2以降)の依存の関係を判定する。`packages`が無い(v1形式)・上限を超える場合はnull。
 */
export function npmLockRelations(lock: unknown, maxEdges = MAX_DEPENDENCY_EDGES): RelationLookup {
  const packages = isRecord(lock) ? lock.packages : undefined;
  if (!isRecord(packages)) return null;
  const entries = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(packages)) if (isRecord(value)) entries.set(key, value);

  /** link(workspaceへのシンボリックリンク)をたどった実体のキー */
  const follow = (key: string): string | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.link === true) return typeof entry.resolved === "string" && entries.has(entry.resolved) ? entry.resolved : null;
    return key;
  };
  /** Nodeの解決規則: <from>/node_modules/<名前>から上位のnode_modulesへ順に探す */
  const resolve = (from: string, dep: string): string | null => {
    let base = from;
    for (;;) {
      const candidate = `${base === "" ? "" : `${base}/`}${NODE_MODULES}${dep}`;
      if (entries.has(candidate)) return follow(candidate);
      if (base === "") return null;
      const parent = base.lastIndexOf(`/${NODE_MODULES}`);
      base = parent === -1 ? "" : base.slice(0, parent);
    }
  };

  let edges = 0;
  const direct = new Map<string, Set<string>>(); // エントリ → 宣言したpackage.json
  const introducedBy = new Map<string, Set<string>>(); // エントリ → 経由した直接依存の名前
  for (const root of [...entries.keys()].filter(isRoot)) {
    const manifest = root === "" ? "package.json" : `${root}/package.json`;
    for (const dep of depNames(entries.get(root)!, ROOT_DEP_FIELDS)) {
      if (++edges > maxEdges) return null;
      const target = resolve(root, dep);
      if (target === null || isRoot(target)) continue; // 未インストール、またはworkspace自身
      let declared = direct.get(target);
      if (declared === undefined) direct.set(target, (declared = new Set()));
      declared.add(manifest);
    }
  }
  // 直接依存ごとに、到達できるエントリへその名前を記録する(訪問済みを記録して循環で止める)
  for (const origin of direct.keys()) {
    const originName = entryName(origin, entries.get(origin)!);
    const visited = new Set<string>([origin]);
    const queue = [origin];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const dep of depNames(entries.get(current)!, INSTALLED_DEP_FIELDS)) {
        if (++edges > maxEdges) return null;
        const target = resolve(current, dep);
        if (target === null || isRoot(target) || visited.has(target)) continue;
        visited.add(target);
        queue.push(target);
        let names = introducedBy.get(target);
        if (names === undefined) introducedBy.set(target, (names = new Set()));
        names.add(originName);
      }
    }
  }

  // 名前と版ごとにまとめる(同じ名前と版が複数の位置にインストールされうる)
  const byPackage = new Map<string, { direct: boolean; transitive: boolean; introducedBy: Set<string>; declaredIn: Set<string> }>();
  for (const [key, entry] of entries) {
    if (isRoot(key) || entry.link === true || typeof entry.version !== "string") continue;
    const id = `${entryName(key, entry)}@${entry.version}`;
    let info = byPackage.get(id);
    if (info === undefined) byPackage.set(id, (info = { direct: false, transitive: false, introducedBy: new Set(), declaredIn: new Set() }));
    const declared = direct.get(key);
    if (declared !== undefined) {
      info.direct = true;
      for (const manifest of declared) info.declaredIn.add(manifest);
    }
    const names = introducedBy.get(key);
    if (names !== undefined) {
      info.transitive = true;
      for (const name of names) info.introducedBy.add(name);
    }
  }
  return (name, version) => {
    const info = byPackage.get(`${name}@${version}`);
    if (info === undefined || (!info.direct && !info.transitive)) return UNKNOWN; // 未収録、またはどこからも到達しない
    return {
      relation: info.direct ? "direct" : "transitive",
      ...(info.introducedBy.size > 0 ? { introducedBy: info.introducedBy } : {}),
      ...(info.declaredIn.size > 0 ? { declaredIn: info.declaredIn } : {}),
    };
  };
}

/** go.modの1行からコメントを除いた本体と、`// indirect`の有無 */
function splitGoComment(line: string): { body: string; indirect: boolean } {
  const index = line.indexOf("//");
  if (index === -1) return { body: line.trim(), indirect: false };
  // Goと同じく、コメントが`indirect`だけか`indirect;`で始まる場合に間接依存とみなす
  return { body: line.slice(0, index).trim(), indirect: /^indirect(?:;|$)/.test(line.slice(index + 2).trim()) };
}

/** go.modの版(`v1.2.3`)を、osv-scannerの報告と同じ`v`なしの形にする */
function stripV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

interface GoReplace {
  from: string;
  /** 置換元の版。null = 全版(`replace a => b v1`) */
  fromVersion: string | null;
  to: string;
  /** 置換先の版。null = ローカルディレクトリへの置換(`replace a => ../a`) */
  toVersion: string | null;
}

/**
 * go.modの依存の関係を判定する(requireの`// indirect`で判定し、版には依らない)。
 * requireの単一行・括弧のブロック、replaceの単一行・ブロックを扱う。
 * replaceはGoと同じく、版を限定したもの(`replace a v1.0.0 => ...`)はrequireの版が一致する場合だけ、
 * 版を限定しないものは全版に適用する(同じモジュールでは版を限定したものが優先)。osv-scanner 2.4.0で同じ挙動を確認。
 * 適用されたreplaceの置換先(osv-scannerはこのパスと版で報告する)に、置換元と同じ関係とreplacedを付ける。
 */
export function goModRelations(text: string): RelationLookup {
  const requires = new Map<string, { relation: "direct" | "transitive"; version: string }>();
  const replaces: GoReplace[] = [];
  let block: "require" | "replace" | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const { body, indirect } = splitGoComment(raw);
    if (body === "") continue;
    if (block !== null && body === ")") { block = null; continue; }
    let directive: "require" | "replace" | null = block;
    let rest = body;
    if (block === null) {
      const head = /^(require|replace)\b\s*(.*)$/.exec(body);
      if (head === null) continue;
      directive = head[1] as "require" | "replace";
      rest = head[2]!.trim();
      if (rest === "(") { block = directive; continue; }
    }
    const fields = rest.split(/\s+/);
    if (directive === "require" && fields.length >= 2) {
      const existing = requires.get(fields[0]!);
      // 同じモジュールが複数回requireされた場合は、直接依存を優先する
      if (existing?.relation !== "direct") {
        requires.set(fields[0]!, { relation: indirect ? "transitive" : "direct", version: stripV(fields[1]!) });
      }
    } else if (directive === "replace") {
      const arrow = fields.indexOf("=>");
      if ((arrow === 1 || arrow === 2) && fields[arrow + 1] !== undefined) {
        replaces.push({
          from: fields[0]!,
          fromVersion: arrow === 2 ? stripV(fields[1]!) : null,
          to: fields[arrow + 1]!,
          toVersion: fields[arrow + 2] !== undefined ? stripV(fields[arrow + 2]!) : null,
        });
      }
    }
  }

  /** osv-scannerが報告する名前 → 関係(置換されたモジュールは置換先の名前) */
  const relations = new Map<string, "direct" | "transitive">();
  /** 適用されたreplaceで報告される「名前@版」(ローカルへの置換は置換元の名前) */
  const replaced = new Set<string>();
  const replacedLocal = new Set<string>();
  const setRelation = (name: string, relation: "direct" | "transitive") => {
    if (relations.get(name) !== "direct") relations.set(name, relation);
  };
  for (const [modulePath, { relation, version }] of requires) {
    setRelation(modulePath, relation);
    const replace =
      replaces.find((r) => r.from === modulePath && r.fromVersion === version) ??
      replaces.find((r) => r.from === modulePath && r.fromVersion === null);
    if (replace === undefined) continue;
    if (replace.toVersion === null) {
      replacedLocal.add(modulePath);
    } else {
      setRelation(replace.to, relation);
      replaced.add(`${replace.to}@${replace.toVersion}`);
    }
  }
  return (name, version) => {
    const relation = relations.get(name);
    if (relation === undefined) return UNKNOWN;
    return replaced.has(`${name}@${version}`) || replacedLocal.has(name) ? { relation, replaced: true } : { relation };
  };
}

/**
 * pom.xmlの依存の関係を、osv-scannerの`source.type`で判定する(pom.xmlは自前で解析しない)。
 * osv-scanner 2.4.0は同じpom.xmlを、宣言された依存(親POM・プロファイル・プロパティ・依存管理をosv-scannerが解釈したもの)を
 * `type: "lockfile"`、deps.devで解決された推移的依存を`type: "unknown"`の結果に分けて報告する(実データで確認)。
 * 文書化された仕様ではないため、想定外のtypeはunknownにする(osv-scannerのピン留め更新時に再確認する)。
 */
export function pomRelations(): RelationLookup {
  return (_name, _version, sourceType) =>
    sourceType === "lockfile" ? { relation: "direct" } : sourceType === "unknown" ? { relation: "transitive" } : UNKNOWN;
}

/** PEP 503の正規化 */
function normalizePypi(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * requirements.txtのコピーに書いた行(`名前==版`等)から関係を判定する。
 * 書いた名前が直接依存、それ以外(deps.devで解決された依存)が推移的依存。
 */
export function requirementsRelations(entries: readonly string[]): RelationLookup {
  const direct = new Set<string>();
  for (const line of entries) {
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(line)?.[0];
    if (name !== undefined) direct.add(normalizePypi(name));
  }
  return (name) => ({ relation: direct.has(normalizePypi(name)) ? "direct" : "transitive" });
}

/** 複数のファイルでの判定をまとめる。ファイルごとの関係がすべて同じならその値、異なればmixed */
export function combineRelations(infos: readonly RelationInfo[]): {
  relation: DependencyRelation;
  introducedBy: string[];
  declaredIn: string[];
  replaced: boolean;
} {
  const relations = new Set(infos.map((info) => info.relation));
  const relation: DependencyRelation = relations.size === 1 ? [...relations][0]! : relations.size === 0 ? "unknown" : "mixed";
  const introducedBy = new Set<string>();
  const declaredIn = new Set<string>();
  for (const info of infos) {
    for (const name of info.introducedBy ?? []) introducedBy.add(name);
    for (const manifest of info.declaredIn ?? []) declaredIn.add(manifest);
  }
  return { relation, introducedBy: [...introducedBy].sort(), declaredIn: [...declaredIn].sort(), replaced: infos.some((info) => info.replaced) };
}
