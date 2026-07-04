/**
 * `suggest_fix`の3段階Tierフォールバック(docs/DESIGN_TODO.mdで確定したアルゴリズム)。
 *
 * 同一パッケージの`fixed_versions`には複数のサポートブランチ(major.minor系統)への
 * バックポート修正が混在する(例: log4jの2.3.x / 2.12.x / メインライン)。単純な
 * 最大バージョンではなく「現在のバージョンに最も近い系統の修正版」を優先して提案する。
 *
 * CVEごとの探索順:
 *   Tier 1 (same_minor):     現在と同じmajor.minor系統内の修正版(最小の変更で済む)
 *   Tier 2 (major_internal): 同一メジャー内の最小の修正版(マイナーバージョンアップ)
 *   Tier 3 (cross_major):    全体最小の修正版(メジャーアップグレード、破壊的変更の可能性)
 *
 * パッケージ全体の推奨(recommended_upgrade)は全CVEのTier結果の最大値
 * (= すべての修正可能なCVEを解消できる最小バージョン)。
 * 現在より新しい修正版が存在しないCVEはunfixedとして明示し、推奨計算から除外する。
 */

import { compareMavenVersions, mavenVersionSeries } from "../utils/mavenVersion.js";
import type { ScanReportPackage, SeverityLevel } from "./scanReport.js";

export type UpgradeTier = "same_minor" | "major_internal" | "cross_major";

export interface CveFixDetail {
  /** 脆弱性の代表ID(通常はGHSA-ID) */
  id: string;
  cve: string | null;
  severity: SeverityLevel;
  /** このCVEを解消できる最小の修正版。null = 現在より新しい修正版が存在しない */
  fixed_in: string | null;
  tier: UpgradeTier | "unfixed";
}

export interface PackageUpgradeSuggestion {
  package: string;
  current_version: string;
  ecosystem: string;
  /** 修正可能な全CVEを解消できる最小バージョン。null = 修正可能なCVEがない */
  recommended_upgrade: string | null;
  /** recommended_upgradeと現在バージョンの系統関係 */
  upgrade_tier: UpgradeTier | null;
  upgrade_note: string;
  per_cve_detail: CveFixDetail[];
}

type Series = { major: number; minor: number };

function classifyTier(currentSeries: Series | null, candidate: string): UpgradeTier {
  const candidateSeries = mavenVersionSeries(candidate);
  if (currentSeries === null || candidateSeries === null) return "cross_major";
  if (currentSeries.major !== candidateSeries.major) return "cross_major";
  if (currentSeries.minor !== candidateSeries.minor) return "major_internal";
  return "same_minor";
}

/**
 * 1つのCVEに対する修正版をTierフォールバックで選ぶ。
 * 現在バージョンより新しい修正版が存在しなければnull(unfixed)。
 */
function pickFixForCve(
  currentVersion: string,
  currentSeries: Series | null,
  fixedVersions: readonly string[],
): { version: string; tier: UpgradeTier } | null {
  // 現在以下の修正版は別ブランチ向けバックポート(現在も影響を受けたまま)なので除外
  const candidates = fixedVersions
    .filter((v) => compareMavenVersions(v, currentVersion) > 0)
    .sort(compareMavenVersions);
  if (candidates.length === 0) return null;

  if (currentSeries !== null) {
    for (const tier of ["same_minor", "major_internal"] as const) {
      const found = candidates.find((v) => classifyTier(currentSeries, v) === tier);
      if (found !== undefined) return { version: found, tier };
    }
  }
  const version = candidates[0]!;
  return { version, tier: classifyTier(currentSeries, version) };
}

function buildNote(
  currentSeries: Series | null,
  recommended: string | null,
  tier: UpgradeTier | null,
  fixableCount: number,
  unfixedCount: number,
): string {
  if (recommended === null) {
    return `全${unfixedCount}件のCVEに現在より新しい修正版が存在しない(unfixed)`;
  }
  const label = currentSeries !== null ? `${currentSeries.major}.${currentSeries.minor}` : null;
  let note: string;
  switch (tier) {
    case "same_minor":
      note = `現在の${label}系統内の${recommended}で、修正版が存在する${fixableCount}件のCVEをすべて解消できる`;
      break;
    case "major_internal":
      note = `${label}系統向けの修正版は存在しない。同一メジャー(${currentSeries!.major}.x)内では${recommended}が${fixableCount}件のCVEを解消する最小版`;
      break;
    default:
      note =
        label !== null
          ? `同一メジャー(${currentSeries!.major}.x)内に修正版が存在しない。${recommended}へのメジャーアップグレードが必要(破壊的変更の可能性あり)`
          : `現在バージョンの系統を判定できないため、全体最小の修正版${recommended}を提示`;
  }
  if (unfixedCount > 0) {
    note += `。残り${unfixedCount}件は修正版が存在せず、このアップグレードでは解消されない`;
  }
  return note;
}

/** 1パッケージ分のアップグレード提案を組み立てる。 */
export function suggestUpgradeForPackage(pkg: ScanReportPackage): PackageUpgradeSuggestion {
  const currentSeries = mavenVersionSeries(pkg.version);
  const details: CveFixDetail[] = [];
  let recommended: string | null = null;
  let unfixedCount = 0;

  for (const vuln of pkg.vulnerabilities) {
    const pick = pickFixForCve(pkg.version, currentSeries, vuln.fixed_versions);
    if (pick === null) {
      unfixedCount++;
      details.push({
        id: vuln.id,
        cve: vuln.cve,
        severity: vuln.severity,
        fixed_in: null,
        tier: "unfixed",
      });
      continue;
    }
    details.push({
      id: vuln.id,
      cve: vuln.cve,
      severity: vuln.severity,
      fixed_in: pick.version,
      tier: pick.tier,
    });
    if (recommended === null || compareMavenVersions(pick.version, recommended) > 0) {
      recommended = pick.version;
    }
  }

  const fixableCount = details.length - unfixedCount;
  // 推奨バージョン自体のTierは「現在バージョンとの系統関係」で再分類する
  // (per-CVEのTierの寄せ集めではなく、実際に行うアップグレードの距離を表す)
  const upgradeTier = recommended !== null ? classifyTier(currentSeries, recommended) : null;

  return {
    package: pkg.name,
    current_version: pkg.version,
    ecosystem: pkg.ecosystem,
    recommended_upgrade: recommended,
    upgrade_tier: upgradeTier,
    upgrade_note: buildNote(currentSeries, recommended, upgradeTier, fixableCount, unfixedCount),
    per_cve_detail: details,
  };
}

/** スキャンレポート全体からパッケージごとの提案一覧を作る(深刻度順を維持)。 */
export function suggestUpgrades(packages: readonly ScanReportPackage[]): PackageUpgradeSuggestion[] {
  return packages.map(suggestUpgradeForPackage);
}
