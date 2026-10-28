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
import { PdmLockCache } from "../../utils/pdmLockCache.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const member = "apps/日本語 app";
async function fixture(status = "included", optionalRoot = false) {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-pdm-")));
  const content = stringify({ metadata: { lock_version: status === "unconfirmed" ? "99" : "4.5.1", groups: ["default", "docs"] }, package: [
    ...status === "missing" ? [] : [{ name: "web", version: "0.1.0", path: `./${member}`, editable: true, dependencies: ["dev==1.0.0"] }],
    { name: "parent", version: "1.0.0", dependencies: ["leaf==1.0.0"] },
    { name: "leaf", version: "1.0.0" }, { name: "dev", version: "1.0.0" },
  ] });
  await mkdir(path.join(dir, member), { recursive: true });
  await writeFile(path.join(dir, "pyproject.toml"), optionalRoot
    ? `[project]\nname="app"\nversion="0.1.0"\n[project.optional-dependencies]\ndocs=["parent==1.0.0"]\n[tool.pdm.workspace]\nmembers=["apps/*"]`
    : `[project]\nname="app"\nversion="0.1.0"\ndependencies=["parent==1.0.0"]\n[tool.pdm.workspace]\nmembers=["apps/*"]`);
  await writeFile(path.join(dir, member, "pyproject.toml"), `[project]\nname="web"\nversion="0.1.0"\ndependencies=["dev==1.0.0"]${status === 'nonmember' ? '\n[dependency-groups]\ntest=["unlocked==1.0.0"]' : ''}`);
  await writeFile(path.join(dir, "pdm.lock"), content);
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["parent", "leaf", "dev"].map(name => ({
      package: { name, version: "1.0.0", ecosystem: "PyPI" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    })) }] });
  });
  return content;
}
it("keeps conflicting literal/syntax markers unconfirmed in both tools", async () => {
  const original = await fixture();
  const declared = 'platform_release == \'x"andplatform_system=="y\'';
  const locked = 'platform_release == "x" and platform_system == "y"';
  await writeFile(path.join(dir, member, "pyproject.toml"), stringify({ project: { name: "web", version: "0.1.0", dependencies: [`dev==1.0.0; ${declared}`] } }));
  // Reuse the scanner's captured-input assertion with a lock containing the differing marker.
  const { parse } = await import("smol-toml");
  const data = parse(original);
  (data.package as { name: string; dependencies?: string[] }[]).find(p => p.name === "web")!.dependencies = [`dev==1.0.0; ${locked}`];
  const content = stringify(data);
  await writeFile(path.join(dir, "pdm.lock"), content);
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: [{
      package: { name: "dev", version: "1.0.0", ecosystem: "PyPI" }, groups: [{ ids: ["GHSA-dev"], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-dev", affected: [{ package: { name: "dev", ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    }] }] });
  });
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(false);
    expect(payload.coverage.lockfile_missing).toContainEqual(expect.objectContaining({ path: `${member}/pyproject.toml`, status: "unconfirmed" }));
    expect((payload.packages ?? payload.suggestions)[0].dependency_relation).not.toBe("direct");
  }
});
it.each(["legacy", "standard"])("preserves origins and complete coverage with %s editable group declarations in both tools", async kind => {
  await fixture();
  const file = path.join(dir, "pyproject.toml");
  const declaration = '-e file:///${PROJECT_ROOT}/apps/%E6%97%A5%E6%9C%AC%E8%AA%9E%20app#egg=web';
  await writeFile(file, await readFile(file, "utf8") + `\n[${kind === "legacy" ? "tool.pdm.dev-dependencies" : "dependency-groups"}]\ndocs=[${JSON.stringify(declaration)}]\n`);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    const packages = payload.packages ?? payload.suggestions;
    const get = (name: string) => packages.find((p: { name?: string; package?: string }) => (p.name ?? p.package) === name);
    expect(get("parent")).toMatchObject({ dependency_relation: "direct", declared_in: ["pyproject.toml"] });
    expect(get("leaf")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["parent"] });
    expect(get("dev")).toMatchObject({ dependency_relation: "direct", declared_in: [`${member}/pyproject.toml`] });
    if (payload.suggestions) expect(get("leaf").update_hint).toContain("parent");
  }
});
it.each(["dependencies", "optional-dependencies"])("reports dynamic child %s as unconfirmed in both tools", async field => {
  await fixture();
  await writeFile(path.join(dir, member, "pyproject.toml"), stringify({
    project: { name: "web", version: "0.1.0", dynamic: [field] },
    "build-system": { requires: ["setuptools"], "build-backend": "setuptools.build_meta" },
    tool: { setuptools: { dynamic: { [field]: field === "dependencies" ? { file: ["deps.txt"] } : { docs: { file: ["deps.txt"] } } } } },
  }));
  await writeFile(path.join(dir, member, "deps.txt"), "unlocked-package==1.0.0\n");
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(false);
    expect(payload.coverage.lockfile_missing).toContainEqual(expect.objectContaining({ path: `${member}/pyproject.toml`, status: "unconfirmed" }));
  }
});
it("preserves optional-root transitive origins and update hints in both tools", async () => {
  await fixture("included", true);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    const leaf = (payload.packages ?? payload.suggestions).find((p: { name?: string; package?: string }) => (p.name ?? p.package) === "leaf");
    expect(leaf).toMatchObject({ dependency_relation: "transitive", introduced_by: ["parent"] });
    if (payload.suggestions) expect(leaf.update_hint).toContain("parent");
  }
});
// Child development groups are not installed through a parent path dependency.
it.each(["included", "missing", "unconfirmed", "nonmember"])("propagates Pdm origins and %s coverage to both tools", async status => {
  await fixture(status);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(status === "included");
    if (status !== "included") expect(payload.coverage.lockfile_missing).toMatchObject([{ path: `${member}/pyproject.toml`, status: status === "nonmember" ? "unconfirmed" : status }]);
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
  await writeFile(path.join(dir, "pdm.lock"), "changed original");
  await writeFile(path.join(dir, member, "pyproject.toml"), "changed companion");
  const report = await scanFromSnapshot(project, {});
  expect(buildCoverage(project).complete).toBe(true);
  expect(report.packages.find(p => p.name === "dev")?.declared_in).toEqual([`${member}/pyproject.toml`]);
});
it("caches captured Pdm input and respects the read budget", async () => {
  const content = await fixture(), file = path.join(dir, "pdm.lock"), cache = new PdmLockCache(Buffer.byteLength(content));
  const captured = await cache.get(file, dir, []);
  await writeFile(file, "changed original");
  expect(await cache.get(file, dir, [])).toBe(captured);
  expect(await cache.get(path.join(dir, "other/pdm.lock"), dir, [])).toHaveProperty("reason");
});
