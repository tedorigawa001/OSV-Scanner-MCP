/**
 * エコシステムごとのバージョンの扱い(docs/DESIGN_TODO.md「suggest_fix npm/Go対応」)。
 *
 * - Maven: Mavenの優先順位(mavenVersion.ts)。範囲はECOSYSTEM型
 * - npm・Go: SemVer 2.0.0の優先順位(semverVersion.ts)。範囲はSEMVER型とECOSYSTEM型
 * - PyPI: PEP 440の優先順位(pep440Version.ts)。範囲はECOSYSTEM型。名前はPEP 503で正規化して照合する
 * - その他: 比較器なし。範囲はECOSYSTEM型
 *
 * GIT型の範囲(コミットハッシュ)はリリース版と無関係のため、どのエコシステムでも版として扱わない。
 */

import { compareMavenVersions, mavenVersionSeries } from "../utils/mavenVersion.js";
import { compareParsedPep440, parsePep440, type Pep440Version } from "../utils/pep440Version.js";
import { compareParsedSemver, parseSemver } from "../utils/semverVersion.js";

const SEMVER_ECOSYSTEMS = new Set(["npm", "Go"]);

/**
 * 現在の版から見た候補の距離(3段階Tier)。
 * same_minor: 同じ系統内 / major_internal: 同一メジャー内のマイナー更新 / cross_major: 破壊的変更の可能性
 */
export type UpgradeTier = "same_minor" | "major_internal" | "cross_major";

/** バージョン比較・系統判定が対応済みのエコシステムごとの操作 */
export interface VersionScheme {
  /** 比較に使える版か(SemVerとして解釈できない版はfalse) */
  isValid(version: string): boolean;
  /** 優先順位の比較。どちらかが無効なら0を返すため、呼び出し側でisValidを確認すること */
  compare(a: string, b: string): number;
  /** プレリリース(Goの疑似バージョンを含む)か。Mavenは常にfalse(従来の推奨を変えない) */
  isPrerelease(version: string): boolean;
  /** currentからcandidateへの更新の距離 */
  classify(current: string, candidate: string): UpgradeTier;
  /** 注記用の現在の系統の表記(例: "2.14"、"0.3"、"0.0.3")。判定できなければnull */
  seriesLabel(version: string): string | null;
}

const MAVEN_SCHEME: VersionScheme = {
  isValid: () => true,
  compare: compareMavenVersions,
  isPrerelease: () => false,
  classify(current, candidate) {
    const a = mavenVersionSeries(current);
    const b = mavenVersionSeries(candidate);
    if (a === null || b === null || a.major !== b.major) return "cross_major";
    return a.minor === b.minor ? "same_minor" : "major_internal";
  },
  seriesLabel(version) {
    const series = mavenVersionSeries(version);
    return series === null ? null : `${series.major}.${series.minor}`;
  },
};

/**
 * npm・Go: npmの^(キャレット)が互換とみなす範囲を同じ系統とする。
 * 1.0.0以上はmajor.minor、0.xは0.minor内だけが互換(マイナー更新は破壊的変更の可能性)、0.0.xはどの変更も非互換。
 */
const SEMVER_SCHEME: VersionScheme = {
  isValid: (version) => parseSemver(version) !== null,
  compare(a, b) {
    const x = parseSemver(a);
    const y = parseSemver(b);
    return x === null || y === null ? 0 : compareParsedSemver(x, y);
  },
  isPrerelease: (version) => (parseSemver(version)?.prerelease.length ?? 0) > 0,
  classify(current, candidate) {
    const a = parseSemver(current);
    const b = parseSemver(candidate);
    if (a === null || b === null) return "cross_major";
    return classifyCaret(a, b);
  },
  seriesLabel(version) {
    const v = parseSemver(version);
    if (v === null) return null;
    return v.major === 0 && v.minor === 0 ? `0.0.${v.patch}` : `${v.major}.${v.minor}`;
  },
};

/** major・minor・patchから、npmのキャレットに合わせた距離を判定する(npm・Go・PyPI共通) */
function classifyCaret(
  a: { major: bigint | number; minor: bigint | number; patch: bigint | number },
  b: { major: bigint | number; minor: bigint | number; patch: bigint | number },
): UpgradeTier {
  if (a.major !== b.major) return "cross_major";
  if (Number(a.major) === 0) {
    if (a.minor !== b.minor) return "cross_major";
    if (Number(a.minor) === 0 && a.patch !== b.patch) return "cross_major";
    return "same_minor";
  }
  return a.minor === b.minor ? "same_minor" : "major_internal";
}

function pep440Parts(v: Pep440Version) {
  return { major: v.release[0] ?? 0n, minor: v.release[1] ?? 0n, patch: v.release[2] ?? 0n };
}

/**
 * PyPI: PEP 440。共通の互換規則はないが、0.x系でマイナー更新が破壊的変更になるパッケージが実在する(FastAPI等)ため、
 * npm・Goと同じ規則で破壊的変更の可能性を少なく見積もらない側に倒す。epochが変わる更新もcross_major。
 * プレリリースはプレリリース・dev版(post版は正式版扱い)。
 */
const PEP440_SCHEME: VersionScheme = {
  isValid: (version) => parsePep440(version) !== null,
  compare(a, b) {
    const x = parsePep440(a);
    const y = parsePep440(b);
    return x === null || y === null ? 0 : compareParsedPep440(x, y);
  },
  isPrerelease(version) {
    const v = parsePep440(version);
    return v !== null && (v.pre !== null || v.dev !== null);
  },
  classify(current, candidate) {
    const a = parsePep440(current);
    const b = parsePep440(candidate);
    if (a === null || b === null || a.epoch !== b.epoch) return "cross_major";
    return classifyCaret(pep440Parts(a), pep440Parts(b));
  },
  seriesLabel(version) {
    const v = parsePep440(version);
    if (v === null) return null;
    const { major, minor, patch } = pep440Parts(v);
    const epoch = v.epoch === 0n ? "" : `${v.epoch}!`;
    return major === 0n && minor === 0n ? `${epoch}0.0.${patch}` : `${epoch}${major}.${minor}`;
  },
};

/** 修正版の推奨に対応するエコシステムの操作。未対応ならnull */
export function versionSchemeFor(ecosystem: string): VersionScheme | null {
  if (ecosystem === "Maven") return MAVEN_SCHEME;
  if (SEMVER_ECOSYSTEMS.has(ecosystem)) return SEMVER_SCHEME;
  if (ecosystem === "PyPI") return PEP440_SCHEME;
  return null;
}

/**
 * OSVレコードのパッケージ名とスキャン結果の名前が同じパッケージか。
 * PyPIはPEP 503の正規化(小文字化、`-` `_` `.`の連続を`-`)で比較する(実データでは完全一致したが防御的に)
 */
export function samePackageName(a: string, b: string, ecosystem: string): boolean {
  if (ecosystem !== "PyPI") return a === b;
  const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");
  return normalize(a) === normalize(b);
}

/** 修正版・影響範囲として読み取るOSVの範囲の型 */
export function versionRangeTypes(ecosystem: string): ReadonlySet<string> {
  if (ecosystem === "Maven") return new Set(["ECOSYSTEM"]);
  if (SEMVER_ECOSYSTEMS.has(ecosystem)) return new Set(["SEMVER", "ECOSYSTEM"]);
  return new Set(["ECOSYSTEM"]);
}

/**
 * 重複を除いた版の一覧を、エコシステムの優先順位で昇順に並べる。
 * - npm・Go・PyPI: 解釈できない版は末尾に記載順のまま置く
 * - 比較器のないエコシステム: 記載順のまま返す
 */
export function sortVersions(versions: Iterable<string>, ecosystem: string): string[] {
  const unique = [...new Set(versions)];
  if (ecosystem === "Maven") return unique.sort(compareMavenVersions);
  const scheme = versionSchemeFor(ecosystem);
  if (scheme === null) return unique;
  const parsed = unique.filter((raw) => scheme.isValid(raw));
  const unparsed = unique.filter((raw) => !scheme.isValid(raw));
  parsed.sort((a, b) => scheme.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
  return [...parsed, ...unparsed];
}
