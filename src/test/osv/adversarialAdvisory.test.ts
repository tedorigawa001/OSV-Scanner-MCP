/**
 * 細工したOSVレコードの文字列が、LLMへ返す応答に際限なく入らないこと・不可視の細工が残らないこと
 * (脆弱性チェックで判明、2026-11-20)。
 * 以前はsummary・details以外の文字列の長さを制限せず、1つの参照URLや別名で最大4 MBの任意の文字列が
 * 識別子のような欄に入っていた。異体字セレクタを並べた不可視の埋め込みも除去していなかった。
 */
import { describe, expect, it } from "vitest";
import { checkRecommendedCandidates } from "../../osv/candidateCheck.js";
import { extractFixedVersions, parseOsvScanOutput } from "../../osv/scanReport.js";
import { suggestUpgrades } from "../../osv/suggestFix.js";
import { buildVulnerabilityExplanation } from "../../osv/vulnerabilityExplanation.js";
import { sanitizeExternalText } from "../../utils/externalText.js";

const huge = "x".repeat(1_000_000);
const chars = (...codes: number[]) => String.fromCodePoint(...codes);

describe("sanitizeExternalText: 不可視の埋め込み", () => {
  it("異体字セレクタ(基本・補助)を除く", () => {
    const smuggled = "Fix" + chars(0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0xe0150);
    expect(sanitizeExternalText(smuggled)).toBe("Fix");
  });

  it("表示されない埋め字と行間注釈を除く", () => {
    expect(sanitizeExternalText("a" + chars(0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0xfff9, 0xfffa, 0xfffb) + "b")).toBe("ab");
  });

  it("隣接する範囲の可視文字は残す", () => {
    const visible = chars(0xfdff, 0xfe10, 0xe00ff, 0xe01f0, 0x3165, 0xfffc, 0x115e);
    expect(sanitizeExternalText(visible)).toBe(visible.normalize("NFC"));
  });
});

describe("buildVulnerabilityExplanation: 文字列の長さ", () => {
  const record = {
    id: "GHSA-aaaa-bbbb-cccc",
    aliases: ["CVE-2026-0001", `CVE-${huge}`],
    severity: [{ type: `CVSS_V3${huge}`, score: huge }],
    published: huge,
    modified: huge,
    affected: [{ package: { name: huge, ecosystem: huge }, ranges: [{ type: "SEMVER", events: [{ introduced: huge }, { fixed: huge }] }] }],
    references: [{ type: huge, url: `https://example.test/${huge}` }, { type: "WEB", url: "https://example.test/advisory" }],
  };

  it("summary・details以外の欄も上限で切り詰め、応答の大きさを入力に比例させない", () => {
    const explanation = buildVulnerabilityExplanation(record, "GHSA-aaaa-bbbb-cccc");
    expect(JSON.stringify(explanation).length).toBeLessThan(10_000);
    expect(explanation.aliases[0]).toBe("CVE-2026-0001");
    expect(explanation.aliases[1]!.length).toBeLessThanOrEqual(257);
    expect(explanation.affected[0]!.package.length).toBeLessThanOrEqual(257);
    expect(explanation.affected[0]!.ranges[0]!.fixed!.length).toBeLessThanOrEqual(257);
  });

  it("長すぎる参照URLは切り詰めずに除く(切り詰めたURLは別の場所を指しうる)", () => {
    expect(buildVulnerabilityExplanation(record, "GHSA-aaaa-bbbb-cccc").references).toEqual([
      { type: "WEB", url: "https://example.test/advisory" },
    ]);
  });

  it("IDの形式に合わないレコードのidは使わず、照会したIDを返す", () => {
    expect(buildVulnerabilityExplanation({ ...record, id: `GHSA ${huge}` }, "GHSA-aaaa-bbbb-cccc").id).toBe("GHSA-aaaa-bbbb-cccc");
    expect(buildVulnerabilityExplanation({ ...record, id: "PYSEC-2026-1" }, "CVE-2026-0001").id).toBe("PYSEC-2026-1");
  });
});

describe("修正版の候補", () => {
  it("異常に長い版は修正版の候補にしない", () => {
    const record = {
      affected: [{ package: { name: "x", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: `1.0.0-${huge}` }, { fixed: "1.5.0" }] }] }],
    };
    expect(extractFixedVersions([record], "x", "npm")).toEqual(["1.5.0"]);
  });
});

describe("checkRecommendedCandidates: 該当する脆弱性の一覧", () => {
  it("件数とIDの長さを上限付きにして示す", async () => {
    const pkg = parseOsvScanOutput({ results: [{ source: { path: "/x/package-lock.json" }, packages: [{
      package: { name: "x", version: "1.0.0", ecosystem: "npm" },
      groups: [{ ids: ["GHSA-a"], aliases: [], max_severity: "7.5" }],
      vulnerabilities: [{ id: "GHSA-a", affected: [{ package: { name: "x", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] }] }] }],
    }] }] }).packages[0]!;
    // 推奨先1.5.0に、修正版のない新しい脆弱性が30件(1件はIDが極端に長い)
    const open = Array.from({ length: 30 }, (_, i) => ({
      id: i === 0 ? `GHSA-${huge}` : `GHSA-open-${i}`,
      affected: [{ package: { name: "x", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.1" }] }] }],
    }));
    const fetchFn = (async () => new Response(JSON.stringify({ vulns: open }), { status: 200 })) as unknown as typeof fetch;
    const [suggestion] = await checkRecommendedCandidates([pkg], suggestUpgrades([pkg]), { fetchFn });
    expect(suggestion).toMatchObject({ recommended_upgrade: "1.5.0", candidate_check: "has_known_vulnerabilities" });
    const listed = suggestion!.recommended_known_vulnerabilities!;
    expect(listed).toHaveLength(21);
    expect(listed[0]!.length).toBeLessThanOrEqual(129);
    expect(listed[20]).toBe("(10 more)");
    expect(JSON.stringify(suggestion).length).toBeLessThan(20_000);
  });
});
