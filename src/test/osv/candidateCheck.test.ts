import { describe, expect, it } from "vitest";
import { candidateCheckDisabledFromEnv, checkRecommendedCandidates } from "../../osv/candidateCheck.js";
import { parseOsvScanOutput, type ScanReportPackage } from "../../osv/scanReport.js";
import { suggestUpgrades } from "../../osv/suggestFix.js";

const range = (introduced: string, fixed?: string) => ({
  type: "SEMVER",
  events: fixed === undefined ? [{ introduced }] : [{ introduced }, { fixed }],
});

/** osv-scannerの出力形式から、npmのパッケージ1件(脆弱性はidと範囲の組)を作る */
function scanned(name: string, version: string, vulns: { id: string; ranges: unknown[] }[]): ScanReportPackage {
  return parseOsvScanOutput({ results: [{ source: { path: "/x/package-lock.json" }, packages: [{
    package: { name, version, ecosystem: "npm" },
    groups: vulns.map((v) => ({ ids: [v.id], aliases: [], max_severity: "7.5" })),
    vulnerabilities: vulns.map((v) => ({ id: v.id, affected: [{ package: { name, ecosystem: "npm" }, ranges: v.ranges }] })),
  }] }] }).packages[0]!;
}

/** OSVのレコード(/v1/queryの応答の要素) */
function record(id: string, name: string, ranges: unknown[], aliases: string[] = []) {
  return { id, aliases, affected: [{ package: { name, ecosystem: "npm" }, ranges }] };
}

/** 版ごとの応答を返すfetchの差し替え。照会した版を記録する */
function stubFetch(responses: Record<string, unknown[] | Error | number>) {
  const queried: { name: string; ecosystem: string; version: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.osv.dev/v1/query");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init!.body)) as { package: { name: string; ecosystem: string }; version: string };
    queried.push({ name: body.package.name, ecosystem: body.package.ecosystem, version: body.version });
    const response = responses[`${body.package.name}@${body.version}`] ?? [];
    if (response instanceof Error) throw response;
    if (typeof response === "number") return new Response("error", { status: response });
    return new Response(JSON.stringify(response.length > 0 ? { vulns: response } : {}), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, queried };
}

async function check(packages: ScanReportPackage[], responses: Parameters<typeof stubFetch>[0], extra: Record<string, number> = {}) {
  const { fetchFn, queried } = stubFetch(responses);
  const suggestions = await checkRecommendedCandidates(packages, suggestUpgrades(packages), { fetchFn, ...extra });
  return { suggestions, queried };
}

describe("checkRecommendedCandidates", () => {
  const pkg = scanned("x", "1.0.0", [{ id: "GHSA-a", ranges: [range("0", "1.5.0")] }]);

  it("推奨先に既知の脆弱性がなければclean(照会は名前・エコシステム・版だけ)", async () => {
    const { suggestions, queried } = await check([pkg], {});
    expect(suggestions[0]).toMatchObject({ recommended_upgrade: "1.5.0", candidate_check: "clean", verification: "verified" });
    expect(queried).toEqual([{ name: "x", ecosystem: "npm", version: "1.5.0" }]);
    expect(suggestions[0]!.upgrade_note).not.toContain("OSVに照会");
  });

  it("推奨先に新しい脆弱性があれば、その修正版を候補に加えて選び直す(cryptography 3.2→49.0.0→50.0.0と同じ形)", async () => {
    const { suggestions, queried } = await check([pkg], {
      "x@1.5.0": [record("GHSA-new", "x", [range("1.4.0", "1.6.0")])],
    });
    expect(queried.map((q) => q.version)).toEqual(["1.5.0", "1.6.0"]);
    const s = suggestions[0]!;
    expect(s).toMatchObject({ recommended_upgrade: "1.6.0", upgrade_tier: "major_internal", candidate_check: "clean" });
    expect(s.upgrade_note).toContain("1.5.0は1件の既知の脆弱性に該当");
    // per_cve_detailはスキャンした(現在の版の)脆弱性だけ。最終的な推奨先で判定する
    expect(s.per_cve_detail.map((d) => [d.id, d.recommended_status])).toEqual([["GHSA-a", "not_affected"]]);
  });

  it("新しい脆弱性に修正版がなければ、推奨を残して該当する脆弱性を示す", async () => {
    const { suggestions } = await check([pkg], { "x@1.5.0": [record("GHSA-open", "x", [range("1.0.1")])] });
    expect(suggestions[0]).toMatchObject({
      recommended_upgrade: "1.5.0", candidate_check: "has_known_vulnerabilities", recommended_known_vulnerabilities: ["GHSA-open"],
    });
    expect(suggestions[0]!.upgrade_note).toContain("避けられる修正版の候補が見つかりませんでした");
  });

  it("スキャンで既に知っている脆弱性に該当と返った場合(範囲情報の食い違い)は、その候補を除外する", async () => {
    const two = scanned("x", "1.0.0", [
      { id: "GHSA-a", ranges: [range("0", "1.5.0")] },
      { id: "GHSA-b", ranges: [range("0", "1.2.0")] },
    ]);
    // 手元の範囲では1.5.0がGHSA-aの範囲外だが、OSVは別名で該当と返す → 1.5.0を除外し、他に候補がないため示す
    const { suggestions } = await check([two], { "x@1.5.0": [record("CVE-2026-1", "x", [range("0", "1.6.0")], ["GHSA-a"])] });
    // 回帰: 除外した候補をフォールバックで推奨に残さない(推奨を保留し、verifiedにしない)
    const s = suggestions[0]!;
    expect(s).toMatchObject({ recommended_upgrade: null, upgrade_tier: null, candidate_check: "conflict", verification: "no_verified_candidate" });
    expect(s.per_cve_detail.map((d) => d.recommended_status)).toEqual(["not_evaluated", "not_evaluated"]);
    expect(s.upgrade_note).toContain("範囲情報の食い違い");
    expect(s.upgrade_note).toContain("CVE-2026-1");
    expect("recommended_known_vulnerabilities" in s).toBe(false);
  });

  it("食い違いのある候補は除外し、他に候補があればそれを推奨する", async () => {
    const pkg2 = scanned("x", "1.0.0", [
      { id: "GHSA-a", ranges: [range("0", "1.5.0")] },
      { id: "GHSA-c", ranges: [range("0", "1.7.0")] },
    ]);
    // 1.7.0はGHSA-c(スキャン済み)に該当と返る食い違いで除外。同時に返った新しい脆弱性の修正版1.9.0を推奨する
    const res = await check([pkg2], {
      "x@1.7.0": [record("GHSA-c", "x", [range("0", "1.8.0")]), record("GHSA-new", "x", [range("1.6.0", "1.9.0")])],
    });
    expect(res.suggestions[0]).toMatchObject({ recommended_upgrade: "1.9.0", candidate_check: "clean" });
    expect(res.suggestions[0]!.upgrade_note).toContain("1.7.0は2件の既知の脆弱性に該当");
  });

  it.each([
    ["null", "null"],
    ["文字列", JSON.stringify("x")],
    ["配列", "[]"],
    ["vulnsがオブジェクト", JSON.stringify({ vulns: {} })],
    ["vulnsの要素がnull", JSON.stringify({ vulns: [null] })],
    ["vulnsの要素が文字列", JSON.stringify({ vulns: ["GHSA-x"] })],
    ["ページトークンが数値", JSON.stringify({ vulns: [], next_page_token: 1 })],
  ])("回帰: 不正なAPI応答(%s)はcleanにせずfailedにする", async (_label, body) => {
    const fetchFn = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const suggestions = await checkRecommendedCandidates([pkg], suggestUpgrades([pkg]), { fetchFn });
    expect(suggestions[0]!.candidate_check).toBe("failed");
  });

  it.each([
    ["接続の失敗", new Error("network down")],
    ["HTTPエラー", 500],
  ])("照会の失敗(%s)でも推奨は出し、failedと注記を付ける(ツール全体をエラーにしない)", async (_label, failure) => {
    const { suggestions } = await check([pkg], { "x@1.5.0": failure as Error | number });
    expect(suggestions[0]).toMatchObject({ recommended_upgrade: "1.5.0", candidate_check: "failed", verification: "verified" });
    expect(suggestions[0]!.upgrade_note).toContain("照会に失敗");
  });

  it("照会回数の上限: 合計を超えたパッケージと、1パッケージの上限で照会していない選び直しはskipped", async () => {
    const other = scanned("y", "1.0.0", [{ id: "GHSA-y", ranges: [range("0", "2.0.0")] }]);
    const total = await check([pkg, other], {}, { maxQueriesTotal: 1, concurrency: 1 });
    expect(total.suggestions.map((s) => s.candidate_check)).toEqual(["clean", "skipped"]);
    const perPackage = await check([pkg], { "x@1.5.0": [record("GHSA-new", "x", [range("1.4.0", "1.6.0")])] }, { maxQueriesPerPackage: 1 });
    expect(perPackage.suggestions[0]).toMatchObject({ recommended_upgrade: "1.6.0", candidate_check: "skipped" });
  });

  it("推奨のないパッケージは照会せずそのまま返す。無効化時はdisabled", async () => {
    const unfixed = scanned("z", "1.0.0", [{ id: "GHSA-z", ranges: [range("0")] }]);
    const { suggestions, queried } = await check([unfixed], {});
    expect(queried).toEqual([]);
    expect("candidate_check" in suggestions[0]!).toBe(false);
    const disabled = await checkRecommendedCandidates([pkg], suggestUpgrades([pkg]), "disabled");
    expect(disabled[0]!.candidate_check).toBe("disabled");
    expect(candidateCheckDisabledFromEnv({ OSV_MCP_NO_CANDIDATE_CHECK: " TRUE " })).toBe(true);
    expect(candidateCheckDisabledFromEnv({})).toBe(false);
  });

  it("続きのページをたどり、上限(5ページ)を超えたら失敗とする", async () => {
    let calls = 0;
    const paged = (async (_url: string, init?: RequestInit) => {
      calls++;
      const token = (JSON.parse(String(init!.body)) as { page_token?: string }).page_token;
      const page = token === undefined ? 0 : Number(token);
      return new Response(JSON.stringify(page < 1 ? { vulns: [], next_page_token: String(page + 1) } : {}), { status: 200 });
    }) as typeof fetch;
    const ok = await checkRecommendedCandidates([pkg], suggestUpgrades([pkg]), { fetchFn: paged });
    expect([ok[0]!.candidate_check, calls]).toEqual(["clean", 2]);
    const endless = (async () => new Response(JSON.stringify({ next_page_token: "more" }), { status: 200 })) as typeof fetch;
    const failed = await checkRecommendedCandidates([pkg], suggestUpgrades([pkg]), { fetchFn: endless });
    expect(failed[0]!.candidate_check).toBe("failed");
  });
});
