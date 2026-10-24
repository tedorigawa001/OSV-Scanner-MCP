import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composerLockCopy } from "../../utils/composerLock.js";
import { compareComposerVersions, parseComposerVersion } from "../../utils/composerVersion.js";
import { detectProject } from "../../utils/manifestDetector.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
import { suggestUpgradeForPackage } from "../../osv/suggestFix.js";
import { handleScanProject } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { runOsvScan } from "../../osv/runner.js";

vi.mock("../../osv/runner.js", async (original) => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const lock = { packages: [{ name: "symfony/http-foundation", version: "v5.4.0", dist: { url: "https://private.invalid/file", reference: "secret" } }],
  "packages-dev": [{ name: "phpunit/phpunit", version: "9.5.0" }] };
async function fixture(files: Record<string, string>) {
  dir = await mkdtemp(path.join(os.tmpdir(), "osv-composer-test-"));
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), text); }
  return dir;
}
function report(source = "composer.lock", fixed = "5.4.46", current = "v5.4.0") {
  return parseOsvScanOutput({ results: [{ source: { path: source, type: "lockfile" }, packages: [{
    package: { name: "symfony/http-foundation", version: current, ecosystem: "Packagist" },
    groups: [{ ids: ["GHSA-test"], aliases: [], max_severity: "7.5" }],
    vulnerabilities: [{ id: "GHSA-test", affected: [{ package: { name: "symfony/http-foundation", ecosystem: "Packagist" },
      ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed }] }] }] }],
  }] }] });
}

describe("Composer", () => {
  it("excludes path packages, even with public names and release versions, in both dependency groups", () => {
    const local = [{ name: "guzzlehttp/psr7", version: "1.8.1", dist: { type: "path", url: "../psr7" } },
      { name: "acme/internal-billing", version: "1.0.0", dist: { type: "path", url: "../billing" } }];
    const parsed = composerLockCopy(JSON.stringify({ packages: local, "packages-dev": local }));
    expect(parsed.packageCount).toBe(0);
    expect(parsed.content).not.toContain("guzzlehttp"); expect(parsed.content).not.toContain("internal-billing");
    // 自分のコードは範囲の欠けにせず、数だけ返す(local_crates・local_projectsと同じ)
    expect(parsed.issues).toEqual([]); expect(parsed.localPackages).toBe(4); expect(parsed.warnings).toEqual([]);
  });
  it("warns about uncertain source without treating notification-url as proof", () => {
    const parsed = composerLockCopy(JSON.stringify({ packages: [
      { name: "vendor/public", version: "1.0.0", "notification-url": "https://packagist.org/downloads/" },
      { name: "vendor/fork", version: "1.0.0", source: { type: "git", url: "https://private.invalid/fork" } },
    ] }));
    expect(parsed.packageCount).toBe(2); expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("1 Composer package");
    expect(parsed.warnings[0]).toContain("does not prove origin");
    expect(parsed.content).not.toContain("private.invalid");
  });
  it("propagates path exclusion and source warnings to both tools without querying local packages", async () => {
    await fixture({ "composer.lock": JSON.stringify({ packages: [...lock.packages,
      { name: "guzzlehttp/psr7", version: "1.8.1", dist: { type: "path" } },
      { name: "acme/internal-billing", version: "1.0.0", dist: { type: "path" } }] }) });
    vi.mocked(runOsvScan).mockImplementation(async targets => {
      const content = await readFile(targets[0]!.path, "utf8");
      expect(content).not.toContain("guzzlehttp/psr7"); expect(content).not.toContain("acme/internal-billing");
      return report(targets[0]!.path);
    });
    for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
      const p = JSON.parse(result.content[0]!.text);
      expect(p.coverage.complete).toBe(true);
      expect(p.coverage.local_composer_packages).toBe(2);
      expect(p.coverage.skipped_files).toEqual([]);
      expect(p.coverage.composer_warnings[0]).toContain("notification URL");
    }
  });
  it("capitalizes safe-read failures for Composer", async () => {
    await fixture({ "composer.lock": JSON.stringify(lock), "bad/composer.lock": "x".repeat(16 * 1024 * 1024 + 1) });
    const project = await detectProject(dir);
    expect(project.skippedFiles.find(f => f.path === path.join("bad", "composer.lock"))?.reason).toBe("The file exceeds the size limit");
  });
  it("never starts the scanner for a project containing only local path packages", async () => {
    await fixture({ "composer.lock": JSON.stringify({ packages: [{ name: "guzzlehttp/psr7", version: "1.8.1", dist: { type: "path" } }],
      "packages-dev": [{ name: "acme/internal-billing", version: "1.0.0", dist: { type: "path" } }] }) });
    const scan = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    const fix = JSON.parse((await handleSuggestFix({ project_path: dir })).content[0]!.text);
    // 照会する第三者のパッケージが無いだけで、範囲の欠けではない
    expect(scan.coverage).toMatchObject({ complete: true, local_composer_packages: 2, skipped_files: [] }); expect(scan.vulnerability_count).toBe(0);
    expect(fix.suggestions).toEqual([]); expect(fix.coverage.complete).toBe(true);
    expect(runOsvScan).not.toHaveBeenCalled();
  });
  it.each([
    ["v1.2", "1.2.0.0", 0], ["1.2.0.1", "1.2.0", 1], ["1.2.0RC2", "1.2.0-RC10", -1],
    ["1.2.0-alpha1", "1.2.0-beta1", -1], ["1.2.0-RC1", "1.2.0", -1], ["1.2.0", "1.2.0-p1", -1],
    ["1.2.0+metadata", "1.2.0", 0],
    ["1.2.0-RC", "1.2.0-RC0", -1], ["1.2.0-RC1", "1.2.0-RC1.0", -1],
    ["1.2.0-stable1", "1.2.0", 0],
  ])("compares %s with %s", (a, b, expected) => expect(compareComposerVersions(a, b)).toBe(expected));
  it.each(["dev-main", "1.x-dev", "1.0.0-dev", "1.0 as 2.0", "1.2.*", "1.2.0-unknown", "1.0.0;echo hi"])("does not interpret %s as a release", v => expect(parseComposerVersion(v)).toBeNull());
  it("rejects a long malformed numeric prerelease without ambiguous numeric repetition", () => {
    expect(parseComposerVersion("1.2.3-alpha" + "1".repeat(220) + "x")).toBeNull();
  });
  it("retains production and dev releases but strips repositories, scripts and commit IDs", () => {
    const parsed = composerLockCopy(JSON.stringify(lock));
    expect(JSON.parse(parsed.content)).toEqual({ packages: [{ name: "symfony/http-foundation", version: "v5.4.0" }], "packages-dev": [{ name: "phpunit/phpunit", version: "9.5.0" }] });
    expect(parsed.issues).toEqual([]);
  });
  it("reports unscannable branch versions and malformed entries", () => {
    const parsed = composerLockCopy(JSON.stringify({ packages: [null, { name: "vendor/pkg", version: "dev-main" }, { name: "vendor/ok", version: "1.2.3" }] }));
    expect(JSON.parse(parsed.content).packages).toHaveLength(1);
    expect(parsed.issues[0]).toContain("2 entries in packages");
    expect(() => composerLockCopy('{"packages":{}}')).toThrow();
  });
  it("does not add local_composer_packages to projects without composer.lock", async () => {
    await fixture({ "go.mod": "module x\n" });
    vi.mocked(runOsvScan).mockResolvedValue(parseOsvScanOutput({ results: [] }));
    const scan = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    expect(Object.keys(scan.coverage)).not.toContain("local_composer_packages");
  });
  it("detects nested lockfiles, ignores vendor, and reports independent composer.json without its own lock", async () => {
    await fixture({ "composer.lock": JSON.stringify(lock), "composer.json": "{}", "child/composer.json": "{}", "vendor/ignored/composer.lock": JSON.stringify(lock) });
    const project = await detectProject(dir);
    expect(project.manifests.map(m => m.path)).toEqual(["composer.lock"]);
    expect(project.composerCopies).toHaveLength(1);
    expect(project.lockfileMissing).toMatchObject([{ path: path.join("child", "composer.json"), ecosystem: "Packagist" }]);
  });
  it("accepts a lockfile path and explains a composer.json-only project", async () => {
    await fixture({ "composer.lock": JSON.stringify(lock) });
    expect((await detectProject(path.join(dir, "composer.lock"))).manifests[0]?.ecosystem).toBe("Packagist");
    await rm(path.join(dir, "composer.lock")); await writeFile(path.join(dir, "composer.json"), "{}");
    await expect(detectProject(dir)).rejects.toThrow("No composer.lock");
  });
  it("scans only sanitized private copies and offers a verified fix", async () => {
    const original = JSON.stringify(lock);
    await fixture({ "composer.lock": original, "composer.json": "{}" });
    vi.mocked(runOsvScan).mockImplementation(async targets => {
      expect(targets).toHaveLength(1); expect(targets[0]!.format).toBe("composer.lock");
      expect(targets[0]!.path.startsWith(dir)).toBe(false);
      expect(await readFile(targets[0]!.path, "utf8")).not.toContain("private.invalid");
      return report(targets[0]!.path);
    });
    const scan = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    expect(scan.coverage.complete).toBe(true); expect(scan.ecosystem_breakdown.Packagist.vulnerability_count).toBe(1);
    expect(scan.coverage.local_composer_packages).toBe(0);
    const fixes = JSON.parse((await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
    expect(fixes.suggestions[0]).toMatchObject({ recommended_upgrade: "5.4.46", verification: "verified", candidate_check: "disabled" });
    expect(fixes.suggestions[0].update_hint).toContain("composer.json");
    expect(await readFile(path.join(dir, "composer.lock"), "utf8")).toBe(original);
  });
  it("marks partial scans incomplete and isolates malformed Composer JSON", async () => {
    await fixture({ "composer.lock": JSON.stringify({ packages: [...lock.packages, { name: "vendor/dev", version: "dev-main" }] }), "bad/composer.lock": "not json" });
    vi.mocked(runOsvScan).mockResolvedValue(report());
    const scan = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    expect(scan.coverage.complete).toBe(false); expect(scan.coverage.skipped_files).toHaveLength(2);
  });
  it("returns incomplete coverage rather than a scanner error when only branches are present", async () => {
    await fixture({ "composer.lock": JSON.stringify({ packages: [{ name: "vendor/dev", version: "dev-main" }] }) });
    const scan = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    expect(scan.coverage.complete).toBe(false); expect(scan.vulnerability_count).toBe(0);
    expect(runOsvScan).not.toHaveBeenCalled();
  });
  it.each([["0.1.0", "0.2.0", "cross_major"], ["1.0.0", "1.1.0", "major_internal"], ["1.0.0", "1.0.1", "same_minor"]])("classifies %s -> %s", (current, fixed, tier) => {
    expect(suggestUpgradeForPackage(report("composer.lock", fixed, current).packages[0]!)).toMatchObject({ recommended_upgrade: fixed, upgrade_tier: tier });
  });
  it("withholds an upgrade when affected ranges cannot be compared", () => {
    expect(suggestUpgradeForPackage(report("composer.lock", "dev-main").packages[0]!).recommended_upgrade).toBeNull();
  });
});
