/**
 * Semantic Versioning 2.0.0のバージョン解釈と優先順位比較(semver.org 11節)。
 *
 * OSVのnpm・Goの範囲(SEMVER型、およびECOSYSTEM型)の順序はSemVerの優先順位に従う。
 * 実データ(docs/DESIGN_TODO.md「suggest_fix npm/Go対応」)の要点:
 * - Goの疑似バージョン(`0.0.0-20190101120000-abcdef123456`)はプレリリースとして正しく並ぶ
 * - Goの`+incompatible`はビルドメタデータとして比較で無視する(`20.10.14+incompatible` = `20.10.14`)
 * - `19.03.9`(数値部の先頭ゼロ)や`13.0`のような値はSemVerではないためnullを返す
 */

export interface SemverVersion {
  major: number;
  minor: number;
  patch: number;
  /** プレリリース識別子。数値の識別子はnumber */
  prerelease: (string | number)[];
}

const NUMERIC = "0|[1-9]\\d*";
const PRE_ID = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const BUILD_ID = "[0-9A-Za-z-]+";
const SEMVER_RE = new RegExp(
  `^v?(${NUMERIC})\\.(${NUMERIC})\\.(${NUMERIC})` +
    `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?` +
    `(?:\\+${BUILD_ID}(?:\\.${BUILD_ID})*)?$`,
);

/**
 * SemVer 2.0.0として厳密に解釈する。解釈できなければnull。
 * 先頭の`v`は防御的に1文字だけ受け付ける(OSVとosv-scannerはGoの版を`v`なしで返す)。
 */
export function parseSemver(version: string): SemverVersion | null {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  const numbers = [m[1], m[2], m[3]].map(Number);
  if (!numbers.every(Number.isSafeInteger)) return null;
  return {
    major: numbers[0]!,
    minor: numbers[1]!,
    patch: numbers[2]!,
    prerelease: m[4] === undefined ? [] : m[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)),
  };
}

function cmp(a: number | string, b: number | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 解釈済みの2つの版をSemVerの優先順位で比較する(ビルドメタデータは無視)。 */
export function compareParsedSemver(a: SemverVersion, b: SemverVersion): number {
  const core = cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch);
  if (core !== 0) return core;
  // プレリリースを持つ版は、同じ版の正式リリースより小さい
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = a.prerelease[i]!;
    const y = b.prerelease[i]!;
    if (typeof x === typeof y) {
      const result = cmp(x, y);
      if (result !== 0) return result;
    } else {
      // 数値の識別子は英数字の識別子より小さい
      return typeof x === "number" ? -1 : 1;
    }
  }
  return cmp(a.prerelease.length, b.prerelease.length);
}

/**
 * 2つの版をSemVerの優先順位で比較する。どちらかを解釈できなければnull。
 */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  return x === null || y === null ? null : compareParsedSemver(x, y);
}
