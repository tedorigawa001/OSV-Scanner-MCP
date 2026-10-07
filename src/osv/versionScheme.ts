/**
 * エコシステムごとのバージョンの扱い(docs/DESIGN_TODO.md「suggest_fix npm/Go対応」)。
 *
 * - Maven: Mavenの優先順位(mavenVersion.ts)。範囲はECOSYSTEM型
 * - npm・Go: SemVer 2.0.0の優先順位(semverVersion.ts)。範囲はSEMVER型とECOSYSTEM型
 * - その他(PyPI等): 比較器なし。範囲はECOSYSTEM型
 *
 * GIT型の範囲(コミットハッシュ)はリリース版と無関係のため、どのエコシステムでも版として扱わない。
 */

import { compareMavenVersions } from "../utils/mavenVersion.js";
import { compareParsedSemver, parseSemver } from "../utils/semverVersion.js";

const SEMVER_ECOSYSTEMS = new Set(["npm", "Go"]);

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
