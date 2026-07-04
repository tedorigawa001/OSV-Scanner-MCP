/**
 * Maven形式バージョンのコンパレータ。
 *
 * npmの`semver`は`2.17.1-RELEASE`のようなMaven特有の接尾辞を正しく扱えないため、
 * Maven本家の`org.apache.maven.artifact.versioning.ComparableVersion`の
 * アルゴリズムをTypeScriptに移植したもの。suggest_fixの3段階Tier
 * フォールバック(DESIGN_TODO.md参照)の前提部品。
 *
 * 仕様の要点:
 * - `.`と`-`でトークン分割。数字⇔文字の境界でも暗黙に分割される
 * - 修飾子の順序: alpha < beta < milestone < rc < snapshot < ""(通常リリース) < sp
 *   未知の修飾子はそれらの後に辞書順
 * - エイリアス: ga / final / release → ""(通常リリース)、cr → rc
 * - 数字直前の1文字略記: a → alpha, b → beta, m → milestone(例: `1a1` = `1-alpha-1`)
 * - 末尾のゼロ・空修飾子は正規化で除去(`1.0.0` = `1`、`1-ga` = `1`)
 */

const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];

const ALIASES = new Map([
  ["ga", ""],
  ["final", ""],
  ["release", ""],
  ["cr", "rc"],
]);

/** 修飾子を比較可能なキーに変換する。既知の修飾子は順序インデックス、未知はその後に辞書順で並ぶ。 */
function comparableQualifier(qualifier: string): string {
  const index = QUALIFIERS.indexOf(qualifier);
  return index === -1 ? `${QUALIFIERS.length}-${qualifier}` : String(index);
}

function cmp<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Item {
  /** otherがnullの場合は「相手側に対応するトークンが無い」ことを意味する(null埋め比較)。 */
  compareTo(other: Item | null): number;
  isNull(): boolean;
}

class IntItem implements Item {
  // タイムスタンプ形式(例: 20211215)や桁あふれに備えbigintで保持
  constructor(readonly value: bigint) {}

  isNull(): boolean {
    return this.value === 0n;
  }

  compareTo(other: Item | null): number {
    if (other === null) {
      return this.isNull() ? 0 : 1;
    }
    if (other instanceof IntItem) {
      return cmp(this.value, other.value);
    }
    // 数値トークンは修飾子(StrItem)やサブリスト(ListItem)より常に新しい
    return 1;
  }
}

class StrItem implements Item {
  readonly value: string;

  constructor(raw: string, followedByDigit: boolean) {
    let v = raw;
    if (followedByDigit && v.length === 1) {
      if (v === "a") v = "alpha";
      else if (v === "b") v = "beta";
      else if (v === "m") v = "milestone";
    }
    this.value = ALIASES.get(v) ?? v;
  }

  isNull(): boolean {
    return this.value === "";
  }

  compareTo(other: Item | null): number {
    if (other === null) {
      // トークン無し = 通常リリース("")との比較
      return cmp(comparableQualifier(this.value), comparableQualifier(""));
    }
    if (other instanceof StrItem) {
      return cmp(comparableQualifier(this.value), comparableQualifier(other.value));
    }
    // IntItemにもListItemにも負ける
    return -1;
  }
}

class ListItem implements Item {
  readonly items: Item[] = [];

  isNull(): boolean {
    return this.items.length === 0;
  }

  /** 末尾のnull相当トークン(0、空修飾子、空リスト)を取り除く。 */
  normalize(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const last = this.items[i]!;
      if (last.isNull()) {
        this.items.splice(i, 1);
      } else if (!(last instanceof ListItem)) {
        break;
      }
    }
  }

  compareTo(other: Item | null): number {
    if (other === null) {
      for (const item of this.items) {
        const result = item.compareTo(null);
        if (result !== 0) return result;
      }
      return 0;
    }
    if (other instanceof IntItem) {
      return -1;
    }
    if (other instanceof StrItem) {
      return 1;
    }
    const otherItems = (other as ListItem).items;
    const len = Math.max(this.items.length, otherItems.length);
    for (let i = 0; i < len; i++) {
      const left = i < this.items.length ? this.items[i]! : null;
      const right = i < otherItems.length ? otherItems[i]! : null;
      // 片側にトークンが無い場合はnull埋めで比較する
      const result =
        left === null ? (right === null ? 0 : -right.compareTo(null)) : left.compareTo(right);
      if (result !== 0) return result;
    }
    return 0;
  }
}

function isDigitChar(c: string): boolean {
  return c >= "0" && c <= "9";
}

function parseItem(digit: boolean, buf: string): Item {
  return digit ? new IntItem(BigInt(buf)) : new StrItem(buf, false);
}

function parseVersion(version: string): ListItem {
  const v = version.toLowerCase();
  const root = new ListItem();
  let list = root;
  const stack: ListItem[] = [root];
  let digit = false;
  let startIndex = 0;

  const pushSublist = () => {
    const sub = new ListItem();
    list.items.push(sub);
    list = sub;
    stack.push(sub);
  };

  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === ".") {
      if (i === startIndex) {
        list.items.push(new IntItem(0n));
      } else {
        list.items.push(parseItem(digit, v.slice(startIndex, i)));
      }
      startIndex = i + 1;
    } else if (c === "-") {
      if (i === startIndex) {
        list.items.push(new IntItem(0n));
      } else {
        list.items.push(parseItem(digit, v.slice(startIndex, i)));
      }
      startIndex = i + 1;
      pushSublist();
    } else if (isDigitChar(c)) {
      if (!digit && i > startIndex) {
        // 文字→数字の境界: 直前の文字列は「数字が続く修飾子」として解釈(a→alpha等)
        list.items.push(new StrItem(v.slice(startIndex, i), true));
        startIndex = i;
        pushSublist();
      }
      digit = true;
    } else {
      if (digit && i > startIndex) {
        list.items.push(parseItem(true, v.slice(startIndex, i)));
        startIndex = i;
        pushSublist();
      }
      digit = false;
    }
  }

  if (v.length > startIndex) {
    list.items.push(parseItem(digit, v.slice(startIndex)));
  }
  while (stack.length > 0) {
    stack.pop()!.normalize();
  }
  return root;
}

/**
 * Mavenのバージョン優先順位規則で2つのバージョン文字列を比較する。
 *
 * @returns a < b なら負、a > b なら正、優先順位が等しければ 0
 *   (例: `compareMavenVersions("2.17.1-RELEASE", "2.17.1") === 0`)
 */
export function compareMavenVersions(a: string, b: string): number {
  return parseVersion(a).compareTo(parseVersion(b));
}

/**
 * バージョンが属する「系統」(major.minor)を返す。
 * 3段階Tierフォールバックの系統判定に使う(例: `2.14.1` → major 2, minor 14)。
 * 先頭が数字で始まらないバージョンはnull(系統判定不能としてTier 3扱いを想定)。
 */
export function mavenVersionSeries(version: string): { major: number; minor: number } | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) };
}
