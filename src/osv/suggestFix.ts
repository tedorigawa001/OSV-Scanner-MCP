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
 * パッケージ全体の候補を全修正対象CVEの影響範囲と照合して推奨する。
 * 判定不能な候補は推奨しない。
 * 現在より新しい修正版が存在しないCVEはunfixedとして明示し、推奨計算から除外する。
 */

import { compareMavenVersions, mavenVersionSeries } from "../utils/mavenVersion.js";
import type { ScanReportPackage, SeverityLevel } from "./scanReport.js";
import { candidateStatus } from "./affectedVersions.js";

export type UpgradeTier = "same_minor" | "major_internal" | "cross_major";

export interface CveFixDetail {
  /** 脆弱性の代表ID(通常はGHSA-ID) */
  id: string;
  cve: string | null;
  severity: SeverityLevel;
  /** このCVEの修正版候補。最終推奨先での判定はrecommended_statusを参照 */
  fixed_in: string | null;
  tier: UpgradeTier | "unfixed";
  recommended_status?: "affected" | "not_affected" | "unknown" | "not_evaluated";
}

export interface PackageUpgradeSuggestion {
  package: string;
  current_version: string;
  ecosystem: string;
  /** 既知の修正版候補のうち影響範囲を検証できた版。null = 検証済み候補なし */
  recommended_upgrade: string | null;
  /** recommended_upgradeと現在バージョンの系統関係 */
  upgrade_tier: UpgradeTier | null;
  upgrade_note: string;
  per_cve_detail: CveFixDetail[];
  verification: "verified" | "no_verified_candidate";
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
    return `全${unfixedCount}件のCVEに現在より新しい修正版候補がない(unfixed)。修正版情報の欠落を含む可能性があります`;
  }
  const label = currentSeries !== null ? `${currentSeries.major}.${currentSeries.minor}` : null;
  let note: string;
  switch (tier) {
    case "same_minor":
      note = `現在の${label}系統内の候補${recommended}を推奨`;
      break;
    case "major_internal":
      note = `同一メジャー(${currentSeries!.major}.x)内の候補${recommended}を推奨`;
      break;
    default:
      note =
        label !== null
          ? `候補${recommended}へのメジャーアップグレードを推奨(破壊的変更の可能性あり)`
          : `現在バージョンの系統を判定できないため、検証済み候補${recommended}を提示`;
  }
  note += `。取得済みの影響範囲に基づき修正対象${fixableCount}件のCVEの範囲外と確認しました。全公開版の最小性や未検出の脆弱性がないことは保証しません`;
  if (unfixedCount > 0) note += `。残り${unfixedCount}件は現在より新しい修正版候補がなく、修正対象から除外しています。recommended_statusを確認してください`;
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
  }

  const fixableCount = details.length - unfixedCount;
  const targets = pkg.vulnerabilities.filter((_, i) => details[i]!.fixed_in !== null);
  const candidates = [...new Set(targets.flatMap(v => v.fixed_versions))]
    .filter(v => compareMavenVersions(v, pkg.version) > 0)
    .sort(compareMavenVersions);
  const tierOrder: UpgradeTier[] = ["same_minor", "major_internal", "cross_major"];
  recommended = null;
  for (const tier of tierOrder) {
    const candidate = candidates.find(v => classifyTier(currentSeries, v) === tier &&
      targets.every(target => candidateStatus(target.affected_versions, v) === "not_affected"));
    if (candidate !== undefined) { recommended = candidate; break; }
  }
  for (let i = 0; i < details.length; i++) {
    details[i]!.recommended_status = recommended === null ? "not_evaluated" :
      candidateStatus(pkg.vulnerabilities[i]!.affected_versions, recommended);
  }
  // 推奨バージョン自体のTierは「現在バージョンとの系統関係」で再分類する
  // (per-CVEのTierの寄せ集めではなく、実際に行うアップグレードの距離を表す)
  const upgradeTier = recommended !== null ? classifyTier(currentSeries, recommended) : null;

  return {
    package: pkg.name,
    current_version: pkg.version,
    ecosystem: pkg.ecosystem,
    recommended_upgrade: recommended,
    upgrade_tier: upgradeTier,
    upgrade_note: recommended === null && fixableCount > 0
      ? "既知の修正版候補から、全修正対象CVEの影響範囲外と確認できる版が見つかりません。情報不足・未対応の範囲形式を含む場合も推奨を保留します。"
      : buildNote(currentSeries, recommended, upgradeTier, fixableCount, unfixedCount),
    per_cve_detail: details,
    verification: recommended === null ? "no_verified_candidate" : "verified",
  };
}

/** スキャンレポート全体からパッケージごとの提案一覧を作る(深刻度順を維持)。 */
export function suggestUpgrades(packages: readonly ScanReportPackage[]): PackageUpgradeSuggestion[] {
  return packages.map(suggestUpgradeForPackage);
}
