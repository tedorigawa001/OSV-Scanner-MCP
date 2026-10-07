import { describe, expect, it } from "vitest";
import type { ScanReportPackage, ScanReportVulnerability } from "../../osv/scanReport.js";
import { suggestUpgradeForPackage, suggestUpgrades } from "../../osv/suggestFix.js";
import { compareMavenVersions } from "../../utils/mavenVersion.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";

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
    affected_versions: {
      complete: true,
      versions: [],
      // Legacy selection tests assume no reintroduction after the first fix.
      intervals: [{ introduced: "0", end: [...fixedVersions].sort(compareMavenVersions)[0] ?? null, inclusive: false }],
    },
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
  it("別系統で再び影響を受ける候補を除外する(スキャンJSONから通して検証)", () => {
    const result = parseOsvScanOutput({ results: [{ packages: [{
      package: { name: "a:a", ecosystem: "Maven", version: "1.0.0" },
      groups: [{ ids: ["A"] }, { ids: ["B"] }],
      vulnerabilities: [
        { id: "A", affected: [{ package: { name: "a:a", ecosystem: "Maven" }, ranges: [{
          type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }, { introduced: "2.0.0" }, { fixed: "2.0.5" }],
        }] }] },
        { id: "B", affected: [{ package: { name: "a:a", ecosystem: "Maven" }, ranges: [{
          type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.0.0" }],
        }] }] },
      ],
    }] }] });
    const suggestion = suggestUpgradeForPackage(result.packages[0]!);
    expect(suggestion.recommended_upgrade).toBe("2.0.5");
    expect(suggestion.verification).toBe("verified");
    expect(suggestion.per_cve_detail.every(v => v.recommended_status === "not_affected")).toBe(true);
  });

  it("影響範囲が欠落した場合、fixedだけで安全と判定しない", () => {
    const v = vuln("A", null, ["1.0.1"]);
    delete v.affected_versions;
    const result = suggestUpgradeForPackage(pkg("a:a", "1.0.0", [v]));
    expect(result.recommended_upgrade).toBeNull();
    expect(result.verification).toBe("no_verified_candidate");
  });

  it("全候補が別CVEの影響範囲内なら推奨を保留する", () => {
    const a = vuln("A", null, ["1.0.1"]);
    a.affected_versions!.intervals.push({ introduced: "2.0.0", end: null, inclusive: false });
    const b = vuln("B", null, ["2.0.0"]);
    expect(suggestUpgradeForPackage(pkg("a:a", "1.0.0", [a, b])).recommended_upgrade).toBeNull();
  });
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
    expect(suggestion.upgrade_note).toContain("同一メジャー");
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
    expect(suggestion.upgrade_note).toContain("残り2件は現在より新しい修正版候補がなく");
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

describe("未対応エコシステム(回帰: v0.3.3でnpmの脆弱性を修正版なしと誤表示)", () => {
  it("未対応のエコシステム(RubyGems)は推奨を出さず、unfixedではなくunsupportedとして返す", () => {
    const pypiPkg: ScanReportPackage = {
      name: "rack",
      version: "2.2.3",
      ecosystem: "RubyGems",
      vulnerabilities: [vuln("GHSA-x", "CVE-2022-1", ["2.2.4"])],
    };
    const suggestion = suggestUpgradeForPackage(pypiPkg);
    expect(suggestion.verification).toBe("unsupported_ecosystem");
    expect(suggestion.recommended_upgrade).toBeNull();
    expect(suggestion.per_cve_detail.map((d) => d.tier)).toEqual(["unsupported"]);
    expect(suggestion.upgrade_note).toContain("未対応");
    expect(suggestion.upgrade_note).not.toContain("unfixed");
  });

  it("Mavenと混在しても、Mavenの推奨は従来どおり算出する", () => {
    const [maven, pypi] = suggestUpgrades([
      pkg("a:a", "2.14.1", [vuln("GHSA-m", "CVE-2021-1", ["2.15.0"])]),
      { name: "rack", version: "2.2.3", ecosystem: "RubyGems", vulnerabilities: [vuln("GHSA-n", null, [])] },
    ]);
    expect(maven!.recommended_upgrade).toBe("2.15.0");
    expect("update_hint" in maven!).toBe(false);
    expect("recommended_is_prerelease" in maven!).toBe(false);
    expect(pypi!.verification).toBe("unsupported_ecosystem");
  });
});

/** osv-scannerの出力(1パッケージ)からレポートを通して提案を作る。rangesは実データ(api.osv.dev)の形 */
function suggestFromScan(
  ecosystem: string,
  name: string,
  version: string,
  vulns: { id: string; ranges: { type?: string; events: Record<string, string>[] }[] }[],
) {
  const report = parseOsvScanOutput({
    results: [{
      source: { path: "/work/lock" },
      packages: [{
        package: { name, version, ecosystem },
        groups: vulns.map((v) => ({ ids: [v.id], aliases: [], max_severity: "7.5" })),
        vulnerabilities: vulns.map((v) => ({
          id: v.id,
          affected: [{ package: { name, ecosystem }, ranges: v.ranges.map((r) => ({ type: "SEMVER", ...r })) }],
        })),
      }],
    }],
  });
  return suggestUpgradeForPackage(report.packages[0]!);
}

const range = (introduced: string, fixed: string): { events: Record<string, string>[] } => ({ events: [{ introduced }, { fixed }] });

describe("npm・Goの推奨(v0.5.0、実データの期待値)", () => {
  it("lodash 4.17.20 → 4.18.0(major_internal)。4.17.21・4.17.23では4.18.0で直る2件が残る", () => {
    const s = suggestFromScan("npm", "lodash", "4.17.20", [
      { id: "GHSA-29mw-wpgm-hmr9", ranges: [range("4.0.0", "4.17.21")] },
      { id: "GHSA-35jh-r3h4-6jhm", ranges: [range("0", "4.17.21")] },
      { id: "GHSA-f23m-r3pf-42rh", ranges: [range("0", "4.18.0")] },
      { id: "GHSA-r5fr-rjxr-66jc", ranges: [range("4.0.0", "4.18.0")] },
      { id: "GHSA-xxjr-mmjv-4gpg", ranges: [range("4.0.0", "4.17.23")] },
    ]);
    expect(s.verification).toBe("verified");
    expect(s.recommended_upgrade).toBe("4.18.0");
    expect(s.upgrade_tier).toBe("major_internal");
    expect(Object.fromEntries(s.per_cve_detail.map((d) => [d.id, `${d.fixed_in}/${d.tier}/${d.recommended_status}`]))).toEqual({
      "GHSA-29mw-wpgm-hmr9": "4.17.21/same_minor/not_affected",
      "GHSA-35jh-r3h4-6jhm": "4.17.21/same_minor/not_affected",
      "GHSA-f23m-r3pf-42rh": "4.18.0/major_internal/not_affected",
      "GHSA-r5fr-rjxr-66jc": "4.18.0/major_internal/not_affected",
      "GHSA-xxjr-mmjv-4gpg": "4.17.23/same_minor/not_affected",
    });
    expect(s.update_hint).toContain("overrides");
  });

  it("minimist 1.2.5 → 1.2.6(same_minor)。現在より古い0.2.4の区間は候補にしない", () => {
    const s = suggestFromScan("npm", "minimist", "1.2.5", [
      { id: "GHSA-xvch-5gv4-984h", ranges: [range("1.0.0", "1.2.6"), range("0", "0.2.4")] },
    ]);
    expect([s.recommended_upgrade, s.upgrade_tier]).toEqual(["1.2.6", "same_minor"]);
  });

  it("golang.org/x/text 0.3.0 → 0.39.0(0.x系のマイナー更新はcross_major)", () => {
    const s = suggestFromScan("Go", "golang.org/x/text", "0.3.0", [
      { id: "GO-2020-0015", ranges: [range("0", "0.3.3")] },
      { id: "GO-2021-0113", ranges: [range("0", "0.3.7")] },
      { id: "GO-2022-1059", ranges: [range("0", "0.3.8")] },
      { id: "GO-2026-5970", ranges: [range("0", "0.39.0")] },
    ]);
    expect([s.recommended_upgrade, s.upgrade_tier]).toEqual(["0.39.0", "cross_major"]);
    expect(s.per_cve_detail.map((d) => d.tier)).toEqual(["same_minor", "same_minor", "same_minor", "cross_major"]);
    expect(s.upgrade_note).toContain("0.x系のため、マイナー更新でも破壊的変更の可能性あり");
    expect(s.update_hint).toContain("/v2");
  });

  it("0.0.xはパッチ更新もcross_major", () => {
    const s = suggestFromScan("npm", "tiny", "0.0.3", [{ id: "GHSA-a", ranges: [range("0", "0.0.4")] }]);
    expect([s.recommended_upgrade, s.upgrade_tier]).toEqual(["0.0.4", "cross_major"]);
  });

  it("プレリリースの修正版があっても、正式版で解消できれば正式版を推奨する(上のTierの正式版を優先)", () => {
    const s = suggestFromScan("npm", "express", "4.17.1", [
      { id: "GHSA-a", ranges: [range("0", "4.20.0"), range("5.0.0-alpha.1", "5.0.0-beta.3")] },
    ]);
    expect(s.recommended_upgrade).toBe("4.20.0");
    expect("recommended_is_prerelease" in s).toBe(false);
    const t = suggestFromScan("npm", "pkg", "1.2.0", [{ id: "GHSA-b", ranges: [range("0", "1.2.5-rc.1")] }, { id: "GHSA-c", ranges: [range("0", "1.3.0")] }]);
    // 1.2.5-rc.1(same_minorのプレリリース)より1.3.0(major_internalの正式版)を優先する
    expect([t.recommended_upgrade, t.upgrade_tier]).toEqual(["1.3.0", "major_internal"]);
    expect(t.per_cve_detail.map((d) => d.fixed_in)).toEqual(["1.2.5-rc.1", "1.3.0"]);
    // 1つのCVEに正式版とプレリリースの修正版がある場合、CVEごとの修正版も正式版を優先する
    const u = suggestFromScan("npm", "pkg", "1.2.0", [{ id: "GHSA-d", ranges: [range("0", "1.2.5-rc.1"), range("1.2.5", "1.3.0")] }]);
    expect(u.per_cve_detail[0]!.fixed_in).toBe("1.3.0");
  });

  it("正式版の候補で解消できない場合だけプレリリースを推奨し、recommended_is_prereleaseを付ける", () => {
    const s = suggestFromScan("npm", "next", "15.5.0", [{ id: "GHSA-a", ranges: [range("15.0.0", "15.6.0-canary.61")] }]);
    expect(s.recommended_upgrade).toBe("15.6.0-canary.61");
    expect(s.recommended_is_prerelease).toBe(true);
    expect(s.upgrade_note).toContain("プレリリース版を推奨");
  });

  it("SemVerとして解釈できない範囲(docker/dockerのGHSA)を含むと推奨を保留する", () => {
    const s = suggestFromScan("Go", "github.com/docker/docker", "19.3.0", [{ id: "GHSA-a", ranges: [range("0", "19.03.9")] }]);
    expect(s.verification).toBe("no_verified_candidate");
    expect(s.recommended_upgrade).toBeNull();
    const t = suggestFromScan("Go", "github.com/docker/docker", "20.10.14+incompatible", [
      { id: "GO-a", ranges: [range("0", "20.10.24+incompatible")] },
      { id: "GHSA-b", ranges: [range("0", "20.10.24+incompatible"), range("17.0.0", "19.03.9")] },
    ]);
    expect([t.recommended_upgrade, t.verification]).toEqual([null, "no_verified_candidate"]);
  });

  it("回帰: 解釈できない修正版のCVEをunfixedとして外さず、別CVEの修正版だけで推奨しない", () => {
    // 現在1.0.0、CVE-Aの修正版は13.0(SemVerでない)、CVE-Bの修正版は1.0.1
    const s = suggestFromScan("npm", "pkg", "1.0.0", [
      { id: "GHSA-a", ranges: [range("0", "13.0")] },
      { id: "GHSA-b", ranges: [range("0", "1.0.1")] },
    ]);
    expect(s.recommended_upgrade).toBeNull();
    expect(s.verification).toBe("no_verified_candidate");
    expect(Object.fromEntries(s.per_cve_detail.map((d) => [d.id, d.tier]))).toEqual({ "GHSA-a": "unparseable_fix", "GHSA-b": "same_minor" });
    expect(s.upgrade_note).toContain("解釈できない");
    // 解釈できない修正版だけの場合も「修正版なし」とは言わない
    const only = suggestFromScan("npm", "pkg", "1.0.0", [{ id: "GHSA-a", ranges: [range("0", "13.0")] }]);
    expect([only.recommended_upgrade, only.verification, only.per_cve_detail[0]!.tier]).toEqual([null, "no_verified_candidate", "unparseable_fix"]);
    expect(only.upgrade_note).not.toContain("unfixed)");
    // 修正版の記載が無い・現在以下のCVEは従来どおりunfixedとして外し、残りで推奨する
    const old = suggestFromScan("npm", "pkg", "1.0.0", [
      { id: "GHSA-c", ranges: [range("0", "0.9.0")] },
      { id: "GHSA-b", ranges: [range("0", "1.0.1")] },
    ]);
    expect(old.recommended_upgrade).toBe("1.0.1");
    expect(Object.fromEntries(old.per_cve_detail.map((d) => [d.id, d.tier]))).toEqual({ "GHSA-c": "unfixed", "GHSA-b": "same_minor" });
  });

  it("Goの+incompatibleを比較で扱い、疑似バージョンの現在版には注記を付ける", () => {
    const s = suggestFromScan("Go", "github.com/docker/docker", "20.10.14+incompatible", [
      { id: "GO-a", ranges: [range("0", "20.10.24+incompatible")] },
    ]);
    expect([s.recommended_upgrade, s.upgrade_tier]).toEqual(["20.10.24+incompatible", "same_minor"]);
    // 同じ版が+incompatibleの有無で両方載る(実データ)場合、現在の版と同じ形を推奨する
    for (const ranges of [[range("0", "20.10.24"), range("0", "20.10.24+incompatible")], [range("0", "20.10.24+incompatible"), range("0", "20.10.24")]]) {
      const both = suggestFromScan("Go", "github.com/docker/docker", "20.10.14+incompatible", [{ id: "GO-x", ranges }]);
      expect([both.recommended_upgrade, both.per_cve_detail[0]!.fixed_in]).toEqual(["20.10.24+incompatible", "20.10.24+incompatible"]);
      const plain = suggestFromScan("Go", "github.com/moby/moby", "20.10.14", [{ id: "GO-y", ranges }]);
      expect(plain.recommended_upgrade).toBe("20.10.24");
    }
    const t = suggestFromScan("Go", "golang.org/x/net", "0.0.0-20190101120000-abcdef123456", [
      { id: "GO-b", ranges: [range("0", "0.0.0-20190813141303-74dc4d7220e7")] },
      { id: "GO-c", ranges: [range("0", "0.7.0")] },
    ]);
    expect([t.recommended_upgrade, t.upgrade_tier]).toEqual(["0.7.0", "cross_major"]);
    expect(t.upgrade_note).toContain("疑似バージョン");
  });

  it("現在の版を解釈できない場合はunparseable_versionとし、unfixedに数えない", () => {
    const s = suggestFromScan("npm", "local-pkg", "file:../local", [{ id: "GHSA-a", ranges: [range("0", "1.0.0")] }]);
    expect(s.verification).toBe("unparseable_version");
    expect(s.per_cve_detail.map((d) => d.tier)).toEqual(["unsupported"]);
    expect(s.upgrade_note).toContain("解釈できない");
  });
});

describe("PyPIの推奨(v0.6.0、実データの形)", () => {
  const eco = (introduced: string, fixed: string): { type: string; events: Record<string, string>[] } => ({ type: "ECOSYSTEM", events: [{ introduced }, { fixed }] });

  it("requests 2.19.0: 正規形でない値も扱い、同一メジャー内の候補を推奨してupdate_hintを付ける", () => {
    const s = suggestFromScan("PyPI", "requests", "2.19.0", [
      { id: "PYSEC-2018-28", ranges: [eco("0", "2.20.0")] },
      { id: "PYSEC-2023-74", ranges: [eco("2.3.0", "2.31.0")] },
      { id: "GHSA-9wx4-h78v-vm56", ranges: [eco("0", "2.32.0")] },
    ]);
    expect([s.recommended_upgrade, s.upgrade_tier, s.verification]).toEqual(["2.32.0", "major_internal", "verified"]);
    expect(s.update_hint).toContain("pyproject.toml");
  });

  it("正式版で解消できればrc版より正式版、post版は正式版として扱う", () => {
    // 修正版がrc版しかなければrc版を推奨して明示する
    const s = suggestFromScan("PyPI", "pkg", "1.0", [{ id: "A", ranges: [eco("0", "1.1rc1")] }]);
    expect([s.recommended_upgrade, s.recommended_is_prerelease]).toEqual(["1.1rc1", true]);
    // post版は正式版(プレリリース扱いしない)
    const p = suggestFromScan("PyPI", "pkg", "1.0", [{ id: "A", ranges: [eco("0", "1.0.post1")] }]);
    expect([p.recommended_upgrade, p.upgrade_tier, "recommended_is_prerelease" in p]).toEqual(["1.0.post1", "same_minor", false]);
    const t = suggestFromScan("PyPI", "pkg", "1.0", [{ id: "A", ranges: [eco("0", "1.0.post1")] }, { id: "B", ranges: [eco("0", "1.1rc1")] }, { id: "C", ranges: [eco("0", "1.1")] }]);
    expect([t.recommended_upgrade, "recommended_is_prerelease" in t]).toEqual(["1.1", false]);
  });

  it("0.x系のマイナー更新とepochの変更はcross_major", () => {
    expect(suggestFromScan("PyPI", "fastapi", "0.99.0", [{ id: "A", ranges: [eco("0", "0.109.1")] }]).upgrade_tier).toBe("cross_major");
    expect(suggestFromScan("PyPI", "pkg", "1.2", [{ id: "A", ranges: [eco("0", "1!1.0")] }]).upgrade_tier).toBe("cross_major");
  });

  it("下限でスキャンした版は、推奨が下限の引き上げであることを示す", () => {
    const report = parseOsvScanOutput({ results: [{ source: { path: "/x" }, packages: [{
      package: { name: "jinja2", version: "2.0", ecosystem: "PyPI" },
      groups: [{ ids: ["A"], aliases: [], max_severity: "7.5" }],
      vulnerabilities: [{ id: "A", affected: [{ package: { name: "jinja2", ecosystem: "PyPI" }, ranges: [eco("0", "2.11.3")] }] }],
    }] }] });
    const s = suggestUpgradeForPackage({ ...report.packages[0]!, version_is_lower_bound: true });
    expect(s.version_is_lower_bound).toBe(true);
    expect(s.upgrade_note).toContain("下限をその版以上に引き上げる");
  });
});
