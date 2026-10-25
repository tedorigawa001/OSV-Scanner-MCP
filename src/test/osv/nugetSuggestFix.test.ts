import { describe, expect, it } from "vitest";
import { compareNugetVersions, parseNugetVersion } from "../../utils/nugetVersion.js";
import { samePackageName, sortVersions, versionSchemeFor } from "../../osv/versionScheme.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
import { suggestUpgradeForPackage } from "../../osv/suggestFix.js";
import { checkRecommendedCandidates } from "../../osv/candidateCheck.js";

function report(current = "12.0.1", fixed = ["13.0.1"], ranges?: unknown[]) {
  return parseOsvScanOutput({ results: [{ source: { path: "packages.lock.json", type: "lockfile" }, packages: [{
    package: { name: "newtonsoft.json", version: current, ecosystem: "NuGet" },
    groups: [{ ids: ["GHSA-nuget-test"], aliases: [], max_severity: "7.5" }],
    vulnerabilities: [{ id: "GHSA-nuget-test", affected: [{ package: { name: "Newtonsoft.Json", ecosystem: "NuGet" },
      ranges: ranges ?? [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: fixed[0] }] }] }] }],
  }] }] }).packages[0]!;
}

describe("NuGet release ordering", () => {
  it.each([
    ["1", "1.0.0.0", 0], ["01.02.003", "1.2.3", 0], ["1.2.3.0", "1.2.3", 0],
    ["1.2.3.4", "1.2.3", 1], ["1.2.3-RC.2", "1.2.3-rc.10", -1],
    ["1.2.3-BETA", "1.2.3-beta", 0], ["1.0.0-alpha10", "1.0.0-alpha2", -1],
    ["1.0.0-2", "1.0.0-alpha", -1], ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-rc", "1.0.0", -1], ["1.0.0+build.2", "1.0.0+build.1", 0],
    ["1.0.0-2147483647", "1.0.0-2147483648", -1],
    ["1.0.0-rc.-1", "1.0.0-rc.0", -1],
  ])("compares %s and %s", (a, b, expected) => {
    expect(compareNugetVersions(a, b)).toBe(expected);
    expect(compareNugetVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });
  it.each(["v1.2.3", "1.2.3.4.5", "1.*", "[1.0,2.0)", "$(Version)", "1.0.0-rc..1", "1.0.0-01", "1.0.0+", "2147483648.0", "1.0.0\n", "1.0.0;echo hi", "1.0.0-" + "x".repeat(300)])("rejects unsupported version %s", v => expect(parseNugetVersion(v)).toBeNull());
  it("matches NuGet package IDs case insensitively without changing other ecosystems", () => {
    expect(samePackageName("Newtonsoft.Json", "newtonsoft.json", "NuGet")).toBe(true);
    expect(samePackageName("Example", "example", "Maven")).toBe(false);
  });
  it("sorts normalized releases and prereleases with legacy revisions", () => {
    expect(sortVersions(["1.0.0.2", "1.0", "1.0.0-rc.10", "1.0.0-RC.2"], "NuGet")).toEqual(["1.0.0-RC.2", "1.0.0-rc.10", "1.0", "1.0.0.2"]);
  });
});

describe("NuGet fix recommendations", () => {
  it.each([
    ["1.0.0", "1.0.0.1", "same_minor"], ["1.0.0", "1.1.0", "major_internal"],
    ["1.0.0", "2.0.0", "cross_major"], ["0.1.0", "0.2.0", "cross_major"],
  ])("recommends %s -> %s", (current, fixed, tier) => {
    const s = suggestUpgradeForPackage(report(current, [fixed]));
    expect(s).toMatchObject({ recommended_upgrade: fixed, verification: "verified", upgrade_tier: tier });
    expect(s.per_cve_detail[0]?.recommended_status).toBe("not_affected");
  });
  it("uses the closest verified branch rather than the highest fixed version", () => {
    const pkg = report("1.0.0", [], [{ type: "ECOSYSTEM", events: [
      { introduced: "0" }, { fixed: "1.0.5" }, { introduced: "2.0.0" }, { fixed: "2.0.9" },
    ] }]);
    expect(suggestUpgradeForPackage(pkg).recommended_upgrade).toBe("1.0.5");
  });
  it("prefers a stable candidate and labels prerelease-only recommendations", () => {
    const pkg = report("1.0.0", ["1.0.1-rc.1"]);
    expect(suggestUpgradeForPackage(pkg)).toMatchObject({ recommended_upgrade: "1.0.1-rc.1", recommended_is_prerelease: true });
    pkg.vulnerabilities[0]!.fixed_versions.push("1.1.0");
    expect(suggestUpgradeForPackage(pkg).recommended_upgrade).toBe("1.1.0");
  });
  it.each(["direct", "transitive", "unknown"] as const)("provides %s guidance with central management and restore caveats", dependency_relation => {
    const s = suggestUpgradeForPackage({ ...report(), dependency_relation, version_is_lower_bound: true });
    expect(s.update_hint).toContain("Directory.Packages.props");
    expect(s.update_hint).toContain("does not run dotnet restore");
    expect(s.upgrade_note).toContain("lower bound in PackageReference");
    expect(s.upgrade_note).not.toContain("requirements.txt");
    expect(s.version_is_lower_bound).toBe(true);
  });
  it("guides runtime-pack updates through the SDK/framework instead of PackageReference", () => {
    expect(suggestUpgradeForPackage({ ...report(), name: "Microsoft.NETCore.App.Runtime.linux-x64" }).update_hint).toContain("do not add an explicit PackageReference");
  });
  it("withholds candidates when an advisory boundary is unsupported", () => {
    expect(suggestUpgradeForPackage(report("1.0.0", [], [{ type: "ECOSYSTEM", events: [{ introduced: "$(unknown)" }, { fixed: "1.0.1" }] }]))).toMatchObject({ recommended_upgrade: null, verification: "no_verified_candidate" });
  });
  it("retains the lower-bound note even when a candidate cannot be verified", () => {
    const s = suggestUpgradeForPackage({ ...report("1.0.0", [], [{ type: "ECOSYSTEM", events: [{ introduced: "$(unknown)" }, { fixed: "1.0.1" }] }]), version_is_lower_bound: true });
    expect(s.recommended_upgrade).toBeNull(); expect(s.version_is_lower_bound).toBe(true);
    expect(s.upgrade_note).toContain("PackageReference");
  });
  it("does not confuse an equivalent normalized fixed version with an upgrade", () => {
    expect(suggestUpgradeForPackage(report("1.0.0.0", ["1.0.0"])).recommended_upgrade).toBeNull();
  });
  it("checks a NuGet candidate against OSV and reports success", async () => {
    const pkg = report();
    const checked = await checkRecommendedCandidates([pkg], [suggestUpgradeForPackage(pkg)], { fetchFn: async (_url, init) => {
      expect(JSON.parse(init!.body as string)).toMatchObject({ package: { name: "newtonsoft.json", ecosystem: "NuGet" }, version: "13.0.1" });
      return new Response(JSON.stringify({ vulns: [] }));
    } });
    expect(checked[0]).toMatchObject({ recommended_upgrade: "13.0.1", candidate_check: "clean" });
  });
  it("withholds a conflicting candidate and retains failed-check uncertainty", async () => {
    const pkg = report();
    const initial = suggestUpgradeForPackage(pkg);
    const conflict = await checkRecommendedCandidates([pkg], [initial], { fetchFn: async () => new Response(JSON.stringify({ vulns: [{ id: "GHSA-nuget-test" }] })) });
    expect(conflict[0]).toMatchObject({ recommended_upgrade: null, candidate_check: "conflict" });
    const failed = await checkRecommendedCandidates([pkg], [initial], { fetchFn: async () => { throw new Error("offline"); } });
    expect(failed[0]?.candidate_check).toBe("failed");
  });
  it("does not add NuGet as a strict SemVer ecosystem", () => {
    expect(versionSchemeFor("NuGet")?.isValid("1.0.0.4")).toBe(true);
  });
});
