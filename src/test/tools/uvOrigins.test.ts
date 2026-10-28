import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "smol-toml";
import { detectProject } from "../../utils/manifestDetector.js";
import { handleScanProject, scanFromSnapshot, buildCoverage } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { runOsvScan } from "../../osv/runner.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
import { UvLockCache } from "../../utils/uvLockCache.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const member = "apps/日本語 app";
async function fixture(status = "included") {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-uv-")));
  const content = stringify({ version: status === "unconfirmed" ? 99 : 1, revision: 5,
    manifest: { members: status === "missing" ? ["app"] : ["app", "web"] }, package: [
      { name: "app", version: "0.1.0", source: { virtual: "." }, dependencies: [{ name: "parent" }] },
      { name: "web", version: "0.1.0", source: { editable: member }, "dev-dependencies": { dev: [{ name: "dev" }] } },
      { name: "parent", version: "1.0.0", source: { registry: "https://pypi.org/simple" }, dependencies: [{ name: "leaf" }] },
      { name: "leaf", version: "1.0.0", source: { registry: "https://pypi.org/simple" } },
      { name: "dev", version: "1.0.0", source: { registry: "https://pypi.org/simple" } },
    ],
  });
  await mkdir(path.join(dir, member), { recursive: true });
  await writeFile(path.join(dir, "pyproject.toml"), '[project]\nname="app"\nversion="0.1.0"');
  await writeFile(path.join(dir, member, "pyproject.toml"), '[project]\nname="web"\nversion="0.1.0"');
  await writeFile(path.join(dir, "uv.lock"), content);
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["parent", "leaf", "dev"].map(name => ({
      package: { name, version: "1.0.0", ecosystem: "PyPI" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    })) }] });
  });
  return content;
}
it.each(["included", "missing", "unconfirmed"])("propagates uv origins and %s coverage to both tools", async status => {
  await fixture(status);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(status === "included");
    if (status !== "included") expect(payload.coverage.lockfile_missing).toMatchObject([{ path: `${member}/pyproject.toml`, status }]);
    else {
      const packages = payload.packages ?? payload.suggestions;
      const get = (name: string) => packages.find((p: { name?: string; package?: string }) => (p.name ?? p.package) === name);
      expect(get("dev")).toMatchObject({ dependency_relation: "direct", declared_in: [`${member}/pyproject.toml`] });
      expect(get("leaf")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["parent"] });
      if (payload.suggestions) {
        expect(get("dev").update_hint).toContain(`${member}/pyproject.toml`);
        expect(get("leaf").update_hint).toContain("parent"); expect(get("leaf").recommended_upgrade).toBe("1.0.1");
      }
    }
  }
});
it("does not cover independent descendant projects or legacy marker files by name alone", async () => {
  await fixture(); await mkdir(path.join(dir, member, "independent"));
  await writeFile(path.join(dir, member, "independent/pyproject.toml"), '[project]\nname="web"');
  await writeFile(path.join(dir, member, "setup.py"), "");
  const missing = (await detectProject(dir)).lockfileMissing;
  expect(missing).toContainEqual(expect.objectContaining({ path: `${member}/independent/pyproject.toml`, status: "missing" }));
  expect(missing).toContainEqual(expect.objectContaining({ path: `${member}/setup.py`, status: "unconfirmed" }));
});
it("uses the same capture for coverage, graph metadata and scanner input after mutation", async () => {
  await fixture(); const project = await detectProject(dir);
  await writeFile(path.join(dir, "uv.lock"), "changed original");
  const report = await scanFromSnapshot(project, {});
  expect(buildCoverage(project).complete).toBe(true);
  expect(report.packages.find(p => p.name === "dev")?.declared_in).toEqual([`${member}/pyproject.toml`]);
});
it("caches captured uv input and respects the read budget", async () => {
  const content = await fixture(), file = path.join(dir, "uv.lock"), cache = new UvLockCache(Buffer.byteLength(content));
  const captured = await cache.get(file, dir);
  await writeFile(file, "changed original");
  expect(await cache.get(file, dir)).toBe(captured);
  expect(await cache.get(path.join(dir, "other/uv.lock"), dir)).toHaveProperty("reason");
});
