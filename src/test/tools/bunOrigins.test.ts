import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { detectProject } from "../../utils/manifestDetector.js";
import { handleScanProject, scanFromSnapshot, buildCoverage } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { runOsvScan } from "../../osv/runner.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
import { BunLockCache } from "../../utils/bunLockCache.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const member = "apps/日本語 app";
async function fixture(status = "included", version = 2) {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-bun-")));
  const content = "// Bun JSONC\n" + JSON.stringify({ lockfileVersion: status === "unconfirmed" ? 99 : version,
    workspaces: { "": { dependencies: { parent: "1.0.0" } }, ...(status === "missing" ? {} : { [member]: { name: "web", devDependencies: { dev: "1.0.0" } } }) },
    packages: { parent: ["parent@1.0.0", "", { dependencies: { leaf: "1.0.0" } }, "sha512-test"],
      leaf: ["leaf@1.0.0", "", {}, "sha512-test"], dev: ["dev@1.0.0", "", {}, "sha512-test"], web: [`web@workspace:${member}`] },
  }).replace(/}$/, ",}");
  await mkdir(path.join(dir, member), { recursive: true });
  await writeFile(path.join(dir, "package.json"), "{}");
  await writeFile(path.join(dir, member, "package.json"), "{}");
  await writeFile(path.join(dir, "bun.lock"), content);
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["parent", "leaf", "dev"].map(name => ({
      package: { name, version: "1.0.0", ecosystem: "npm" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    })) }] });
  });
  return content;
}
it.each([0, 1, 2])("propagates Bun relations, workspace coverage and update hints to both tools (v%s)", async version => {
  await fixture("included", version);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(true); expect(payload.coverage.lockfile_missing).toEqual([]);
    const packages = payload.packages ?? payload.suggestions;
    const get = (name: string) => packages.find((p: { name?: string; package?: string }) => (p.name ?? p.package) === name);
    expect(get("dev")).toMatchObject({ dependency_relation: "direct", declared_in: [`${member}/package.json`] });
    expect(get("leaf")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["parent"] });
    if (payload.suggestions) {
      expect(get("dev").update_hint).toContain(`${member}/package.json`);
      expect(get("leaf").update_hint).toContain("parent");
      expect(get("leaf").recommended_upgrade).toBe("1.0.1");
    }
  }
});
it.each(["missing", "unconfirmed"])("retains incomplete coverage for %s children in both tools", async status => {
  await fixture(status);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const coverage = JSON.parse(result.content[0]!.text).coverage;
    expect(coverage.complete).toBe(false);
    expect(coverage.lockfile_missing).toMatchObject([{ path: `${member}/package.json`, status }]);
  }
});
it("does not hide independent children beneath an existing workspace", async () => {
  await fixture(); await mkdir(path.join(dir, member, "independent"));
  await writeFile(path.join(dir, member, "independent/package.json"), "{}");
  const project = await detectProject(dir);
  expect(project.lockfileMissing).toMatchObject([{ path: `${member}/independent/package.json`, status: "missing" }]);
});
it("uses identical captured content for coverage and scanning after a source mutation", async () => {
  await fixture(); const project = await detectProject(dir);
  await writeFile(path.join(dir, "bun.lock"), "changed original");
  const report = await scanFromSnapshot(project, {});
  expect(buildCoverage(project).complete).toBe(true);
  expect(report.packages.find(p => p.name === "dev")?.declared_in).toEqual([`${member}/package.json`]);
});
it("caches input once and observes the total read budget", async () => {
  const content = await fixture(), file = path.join(dir, "bun.lock"), cache = new BunLockCache(Buffer.byteLength(content));
  const first = await cache.get(file, dir);
  await writeFile(file, "changed original");
  expect(await cache.get(file, dir)).toBe(first);
  expect(await cache.get(path.join(dir, "other/bun.lock"), dir)).toHaveProperty("reason");
});
