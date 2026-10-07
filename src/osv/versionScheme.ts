/**
 * エコシステムごとのバージョンの扱い(docs/DESIGN_TODO.md「suggest_fix npm/Go対応」)。
 *
 * - Maven: Mavenの優先順位(mavenVersion.ts)。範囲はECOSYSTEM型
 * - npm・Go: SemVer 2.0.0の優先順位(semverVersion.ts)。範囲はSEMVER型とECOSYSTEM型
 * - その他(PyPI等): 比較器なし。範囲はECOSYSTEM型
 *
 * GIT型の範囲(コミットハッシュ)はリリース版と無関係のため、どのエコシステムでも版として扱わない。
 */

import { compareMavenVersions, mavenVersionSeries } from "../utils/mavenVersion.js";
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
    if (a === null || b === null || a.major !== b.major) return "cross_major";
    if (a.major === 0) {
      if (a.minor !== b.minor) return "cross_major";
      if (a.minor === 0 && a.patch !== b.patch) return "cross_major";
      return "same_minor";
    }
    return a.minor === b.minor ? "same_minor" : "major_internal";
  },
  seriesLabel(version) {
    const v = parseSemver(version);
    if (v === null) return null;
    return v.major === 0 && v.minor === 0 ? `0.0.${v.patch}` : `${v.major}.${v.minor}`;
  },
};

/** 修正版の推奨に対応するエコシステムの操作。未対応ならnull */
export function versionSchemeFor(ecosystem: string): VersionScheme | null {
  if (ecosystem === "Maven") return MAVEN_SCHEME;
  if (SEMVER_ECOSYSTEMS.has(ecosystem)) return SEMVER_SCHEME;
  return null;
}

/** 修正版・影響範囲として読み取るOSVの範囲の型 */
export function versionRangeTypes(ecosystem: string): ReadonlySet<string> {
  if (ecosystem === "Maven") return new Set(["ECOSYSTEM"]);
  if (SEMVER_ECOSYSTEMS.has(ecosystem)) return new Set(["SEMVER", "ECOSYSTEM"]);
  return new Set(["ECOSYSTEM"]);
}

/**
 * 重複を除いた版の一覧を、エコシステムの優先順位で昇順に並べる。
 * - npm・Go: SemVerとして解釈できない版は末尾に記載順のまま置く
 * - 比較器のないエコシステム: 記載順のまま返す
 */
export function sortVersions(versions: Iterable<string>, ecosystem: string): string[] {
  const unique = [...new Set(versions)];
  if (ecosystem === "Maven") return unique.sort(compareMavenVersions);
  if (!SEMVER_ECOSYSTEMS.has(ecosystem)) return unique;
  const parsed = unique.flatMap((raw) => {
    const version = parseSemver(raw);
    return version === null ? [] : [{ raw, version }];
  });
  const unparsed = unique.filter((raw) => parseSemver(raw) === null);
  parsed.sort((a, b) => compareParsedSemver(a.version, b.version) || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0));
  return [...parsed.map((p) => p.raw), ...unparsed];
}
