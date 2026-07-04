import { describe, expect, it } from "vitest";
import type { ScanReportPackage, ScanReportVulnerability } from "../../osv/scanReport.js";
import { suggestUpgradeForPackage, suggestUpgrades } from "../../osv/suggestFix.js";

function vuln(
  id: string,
  cve: string | null,
  fixedVersions: string[],
  severity: ScanReportVulnerability["severity"] = "high",
): ScanReportVulnerability {
  return {
    id,
    cve,
    aliases: cve !== null ? [cve] : [],
    severity_score: null,
    severity,
    summary: null,
    fixed_versions: fixedVersions,
  };
}

function pkg(
  name: string,
  version: string,
  vulnerabilities: ScanReportVulnerability[],
): ScanReportPackage {
  return { name, version, ecosystem: "Maven", vulnerabilities };
}

describe("suggestUpgradeForPackage", () => {
  it("設計メモの確定例: log4j-core 2.14.1は2.25.4/major_internalになる", () => {
    // 実スキャン(2026-07-04)で取得したfixed_versionsをそのまま使用
    const log4j = pkg("org.apache.logging.log4j:log4j-core", "2.14.1", [
      vuln("GHSA-jfh8-c2jp-5v3q", "CVE-2021-44228", ["2.3.1", "2.12.2", "2.15.0"], "critical"),
      vuln("GHSA-7rjr-3q55-vv33", "CVE-2021-45046", ["2.12.2", "2.16.0"], "critical"),
      vuln("GHSA-p6xc-xr62-6r2g", "CVE-2021-45105", ["2.3.1", "2.12.3", "2.17.0"]),
      vuln("GHSA-8489-44mv-ggj8", "CVE-2021-44832", ["2.3.2", "2.12.4", "2.17.1"], "medium"),
      vuln("GHSA-3pxv-7cmr-fjr4", "CVE-2026-34480", ["2.25.4"], "medium"),
      vuln("GHSA-6hg6-v5c8-fphq", "CVE-2026-34477", ["2.25.4"], "medium"),
      vuln("GHSA-vc5p-v9hr-52mj", "CVE-2025-68161", ["2.25.3"], "medium"),
    ]);
    const suggestion = suggestUpgradeForPackage(log4j);

    // 2.14系統向けの修正版は存在しない → 同一メジャー内の最大 2.25.4
    expect(suggestion.recommended_upgrade).toBe("2.25.4");
    expect(suggestion.upgrade_tier).toBe("major_internal");
    expect(suggestion.upgrade_note).toContain("2.14系統向けの修正版は存在しない");
    expect(suggestion.upgrade_note).toContain("2.25.4");

    // CVEごとのTier: 2.14.1より古いバックポート(2.3.x/2.12.x)は候補にならない
    const log4shell = suggestion.per_cve_detail.find((d) => d.cve === "CVE-2021-44228")!;
    expect(log4shell.fixed_in).toBe("2.15.0");
    expect(log4shell.tier).toBe("major_internal");
    expect(suggestion.per_cve_detail.every((d) => d.tier === "major_internal")).toBe(true);
  });

  it("Tier 1: 同一major.minor系統内の最小修正版を優先する", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "2.14.1", [vuln("GHSA-1", "CVE-1", ["2.15.0", "2.14.3", "2.14.2"])]),
    );
    expect(suggestion.per_cve_detail[0]!.fixed_in).toBe("2.14.2");
    expect(suggestion.per_cve_detail[0]!.tier).toBe("same_minor");
    expect(suggestion.recommended_upgrade).toBe("2.14.2");
    expect(suggestion.upgrade_tier).toBe("same_minor");
    expect(suggestion.upgrade_note).toContain("現在の2.14系統内");
  });

  it("Tier 3: 同一メジャー内に修正版がなければメジャーアップグレードを明示する", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "1.2.3", [vuln("GHSA-1", "CVE-1", ["2.0.0", "3.0.0"])]),
    );
    expect(suggestion.recommended_upgrade).toBe("2.0.0");
    expect(suggestion.upgrade_tier).toBe("cross_major");
    expect(suggestion.upgrade_note).toContain("メジャーアップグレード");
    expect(suggestion.upgrade_note).toContain("破壊的変更");
  });

  it("複数CVEの推奨は「全CVEを解消できる最小バージョン」(Tier結果の最大)", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "2.14.1", [
        vuln("GHSA-1", "CVE-1", ["2.14.2"]), // same_minorで解消可能
        vuln("GHSA-2", "CVE-2", ["2.16.0"]), // major_internalが必要
      ]),
    );
    expect(suggestion.recommended_upgrade).toBe("2.16.0");
    // 実際のアップグレード距離で再分類される(same_minorではない)
    expect(suggestion.upgrade_tier).toBe("major_internal");
  });

  it("unfixed: 修正版が空、または現在以下しか無いCVEは推奨計算から除外して明示する", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "2.14.1", [
        vuln("GHSA-1", "CVE-1", []), // 修正版なし
        vuln("GHSA-2", "CVE-2", ["2.12.2"]), // 別ブランチ向けバックポートのみ
        vuln("GHSA-3", "CVE-3", ["2.15.0"]),
      ]),
    );
    expect(suggestion.recommended_upgrade).toBe("2.15.0");
    const tiers = Object.fromEntries(suggestion.per_cve_detail.map((d) => [d.id, d.tier]));
    expect(tiers).toEqual({ "GHSA-1": "unfixed", "GHSA-2": "unfixed", "GHSA-3": "major_internal" });
    expect(suggestion.upgrade_note).toContain("残り2件は修正版が存在せず");
  });

  it("全CVEがunfixedならrecommended_upgradeはnull", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "3.2.1", [vuln("GHSA-1", "CVE-1", []), vuln("GHSA-2", null, ["3.0.0"])]),
    );
    expect(suggestion.recommended_upgrade).toBeNull();
    expect(suggestion.upgrade_tier).toBeNull();
    expect(suggestion.upgrade_note).toContain("全2件");
    expect(suggestion.upgrade_note).toContain("unfixed");
  });

  it("系統を判定できないバージョンはcross_major扱いで全体最小を提示する", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "unknown-version", [vuln("GHSA-1", "CVE-1", ["1.2.3", "2.0.0"])]),
    );
    expect(suggestion.recommended_upgrade).toBe("1.2.3");
    expect(suggestion.upgrade_tier).toBe("cross_major");
    expect(suggestion.upgrade_note).toContain("系統を判定できない");
  });

  it("Maven優先順位で比較する(2.9.0 < 2.10.0、修飾子付きも正しく扱う)", () => {
    const suggestion = suggestUpgradeForPackage(
      pkg("a:a", "2.9.0", [vuln("GHSA-1", "CVE-1", ["2.10.0", "2.9.1-RELEASE"])]),
    );
    // 2.9.1-RELEASE(=2.9.1)が同一系統内の修正版として選ばれる
    expect(suggestion.per_cve_detail[0]!.fixed_in).toBe("2.9.1-RELEASE");
    expect(suggestion.per_cve_detail[0]!.tier).toBe("same_minor");
  });
});

describe("suggestUpgrades", () => {
  it("パッケージの並び順(深刻度順)を維持したまま提案一覧を返す", () => {
    const suggestions = suggestUpgrades([
      pkg("a:critical-pkg", "1.0", [vuln("GHSA-1", "CVE-1", ["1.1"], "critical")]),
      pkg("b:low-pkg", "1.0", [vuln("GHSA-2", "CVE-2", ["1.2"], "low")]),
    ]);
    expect(suggestions.map((s) => s.package)).toEqual(["a:critical-pkg", "b:low-pkg"]);
  });
});
