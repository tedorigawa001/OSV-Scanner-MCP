/**
 * PEP 440(Pythonパッケージのバージョン)の解釈と優先順位比較。
 *
 * 正規化と比較はPyPA `packaging`(packaging.version)と同じ規則に従う:
 * - 大文字小文字を無視し、先頭の`v`と前後の空白を許す
 * - プレリリースの別表記: alpha→a、beta→b、c/pre/preview→rc。区切り文字(`.` `-` `_`)と番号は省略可(番号の省略は0)
 * - post版: `.post1`、`-1`、`rev1`、`r1`。dev版: `.dev1`
 * - ローカル版: `+`以降。区切りは`.` `-` `_`
 * - 比較: epoch → リリース番号(末尾のゼロは無視: `1.0` = `1.0.0`) → プレリリース → post → dev → ローカル版
 *   `1.0.dev1` < `1.0a1.dev1` < `1.0a1` < `1.0a1.post1` < `1.0b1` < `1.0rc1` < `1.0` < `1.0.post1.dev1` < `1.0.post1` < `1.0.post1+local`
 *
 * 実データ(docs/DESIGN_TODO.md「suggest_fix PyPI対応」)では、Djangoの`1.8c1`、TensorFlowの`2.8.0-rc0`のような
 * 正規形でない値と、PyTorchの`2.6.0-cu124`のようなPEP 440でない値がある。後者はnullを返す。
 * 数値はBigIntで保持する(2^53を超える値を丸めない)。
 */

export interface Pep440Version {
  epoch: bigint;
  release: bigint[];
  pre: { kind: "a" | "b" | "rc"; number: bigint } | null;
  post: bigint | null;
  dev: bigint | null;
  /** ローカル版の区切りごとの値(数値の区切りはbigint、英字は小文字) */
  local: (string | bigint)[] | null;
}

const PEP440_RE = new RegExp(
  "^\\s*v?" +
    "(?:(?<epoch>[0-9]+)!)?" +
    "(?<release>[0-9]+(?:\\.[0-9]+)*)" +
    "(?<pre>[-_.]?(?<pre_l>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?<pre_n>[0-9]+)?)?" +
    "(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?" +
    "(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?" +
    "(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?" +
    "\\s*$",
  "i",
);

const PRE_KINDS: Record<string, "a" | "b" | "rc"> = {
  a: "a", alpha: "a", b: "b", beta: "b", c: "rc", pre: "rc", preview: "rc", rc: "rc",
};

/** PEP 440として解釈する。解釈できなければnull */
export function parsePep440(version: string): Pep440Version | null {
  const m = PEP440_RE.exec(version);
  const g = m?.groups;
  if (!g) return null;
  const preLetter = g.pre_l?.toLowerCase();
  return {
    epoch: BigInt(g.epoch ?? "0"),
    release: g.release!.split(".").map(BigInt),
    pre: preLetter === undefined ? null : { kind: PRE_KINDS[preLetter]!, number: BigInt(g.pre_n ?? "0") },
    post: g.post === undefined ? null : BigInt(g.post_n1 ?? g.post_n2 ?? "0"),
    dev: g.dev === undefined ? null : BigInt(g.dev_n ?? "0"),
    local: g.local === undefined ? null : g.local.toLowerCase().split(/[-_.]/).map((s) => (/^\d+$/.test(s) ? BigInt(s) : s)),
  };
}

function cmp<T extends bigint | number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const PRE_ORDER = { a: 0, b: 1, rc: 2 } as const;

/** プレリリースの順位: dev版だけの版はすべてのプレリリースより前、プレリリースのない版は後 */
function preKey(v: Pep440Version): [number, number, bigint] {
  if (v.pre === null) return v.post === null && v.dev !== null ? [0, 0, 0n] : [2, 0, 0n];
  return [1, PRE_ORDER[v.pre.kind], v.pre.number];
}

function compareRelease(a: bigint[], b: bigint[]): number {
  // 末尾のゼロは比較に影響しない(1.0 = 1.0.0)
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const result = cmp(a[i] ?? 0n, b[i] ?? 0n);
    if (result !== 0) return result;
  }
  return 0;
}

function compareLocal(a: (string | bigint)[] | null, b: (string | bigint)[] | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (typeof x === typeof y) {
      const result = cmp(x, y);
      if (result !== 0) return result;
    } else {
      // 数値の区切りは英字の区切りより大きい
      return typeof x === "bigint" ? 1 : -1;
    }
  }
  return cmp(a.length, b.length);
}

/** 解釈済みの2つの版をPEP 440の優先順位で比較する */
export function compareParsedPep440(a: Pep440Version, b: Pep440Version): number {
  const [ap0, ap1, ap2] = preKey(a);
  const [bp0, bp1, bp2] = preKey(b);
  return (
    cmp(a.epoch, b.epoch) ||
    compareRelease(a.release, b.release) ||
    cmp(ap0, bp0) || cmp(ap1, bp1) || cmp(ap2, bp2) ||
    // post版のない版はpost版より前
    cmp(a.post === null ? -1n : a.post, b.post === null ? -1n : b.post) ||
    // dev版でない版はdev版より後
    (a.dev === b.dev ? 0 : a.dev === null ? 1 : b.dev === null ? -1 : cmp(a.dev, b.dev)) ||
    compareLocal(a.local, b.local)
  );
}

/** 2つの版をPEP 440の優先順位で比較する。どちらかを解釈できなければnull */
export function comparePep440(a: string, b: string): number | null {
  const x = parsePep440(a);
  const y = parsePep440(b);
  return x === null || y === null ? null : compareParsedPep440(x, y);
}
