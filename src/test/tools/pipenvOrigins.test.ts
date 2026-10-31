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
import { PipenvLockCache } from "../../utils/pipenvLockCache.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const member = "apps/日本語 app";
async function fixture(status = "included") {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-pipenv-")));
  const content = JSON.stringify({ _meta: { "pipfile-spec": status === "unconfirmed" ? 99 : 6 }, default: {
    parent: { version: "==1.0.0" }, leaf: { version: "==1.0.0" },
  }, develop: {
    ...status === "missing" ? {} : { web: { path: `./${member}`, editable: true } }, dev: { version: "==1.0.0" },
  } });
  await mkdir(path.join(dir, member), { recursive: true });
  await writeFile(path.join(dir, "Pipfile"), `[packages]\nparent="==1.0.0"\n[dev-packages]\nweb={path="./${member}",editable=true}`);
  await writeFile(path.join(dir, member, "pyproject.toml"), `[project]\nname="web"\nversion="0.1.0"\ndependencies=["dev==1.0.0"]${status === 'nonmember' ? '\n[dependency-groups]\ntest=["unlocked==1.0.0"]' : ''}`);
  await writeFile(path.join(dir, "Pipfile.lock"), content);
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["parent", "leaf", "dev"].map(name => ({
      package: { name, version: "1.0.0", ecosystem: "PyPI" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    })) }] });
  });
  return content;
}
it("scans a custom category through an additional captured default-category copy", async () => {
  const original = await fixture(), data = JSON.parse(original);
  data.docs = data.develop; data.develop = {};
  const content = JSON.stringify(data);
  await writeFile(path.join(dir, "Pipfile.lock"), content);
  const file = path.join(dir, "Pipfile");
  await writeFile(file, (await readFile(file, "utf8")).replace("[dev-packages]", "[docs]"));
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(targets).toHaveLength(2);
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    const copy = JSON.parse(await readFile(targets[1]!.path, "utf8"));
    expect(copy.default).toEqual(data.docs); expect(copy.develop).toEqual({});
    return parseOsvScanOutput({ results: [{ source: { path: targets[1]!.path, type: "lockfile" }, packages: [{
      package: { name: "dev", version: "1.0.0", ecosystem: "PyPI" }, groups: [{ ids: ["GHSA-dev"], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-dev", affected: [{ package: { name: "dev", ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    }] }] });
  });
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    expect((payload.packages ?? payload.suggestions)[0]).toMatchObject({ dependency_relation: "direct", declared_in: [`${member}/pyproject.toml`], dependency_groups: ["docs"] });
  }
});
it.each([
  '[tool.poetry.group.dev.dependencies]\npytest="==6.0.0"',
  '[tool.poetry.dev-dependencies]\npytest="==6.0.0"',
])("reports unexported child Poetry development declarations as unconfirmed in both tools", async declarations => {
  await fixture();
  const file = path.join(dir, member, "pyproject.toml");
  await writeFile(file, await readFile(file, "utf8") + "\n" + declarations);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(false);
    expect(payload.coverage.lockfile_missing).toContainEqual(expect.objectContaining({ path: `${member}/pyproject.toml`, status: "unconfirmed" }));
  }
});
it("reports custom-copy count exhaustion as incomplete coverage", async () => {
  const original = await fixture(), data = JSON.parse(original);
  for (let i = 0; i < 201; i++) data[`category${i}`] = { parent: { version: "==1.0.0" } };
  await writeFile(path.join(dir, "Pipfile.lock"), JSON.stringify(data));
  const project = await detectProject(dir);
  expect(project.pipenvCopies).toHaveLength(201);
  expect(buildCoverage(project).complete).toBe(false);
  expect(project.skippedFiles).toContainEqual(expect.objectContaining({ path: "Pipfile.lock", reason: expect.stringContaining("count limit") }));
});
it("merges custom category labels with existing scanner groups in both tools", async () => {
  const original = await fixture(), data = JSON.parse(original);
  data.docs = { dev: { version: "==1.0.0" } };
  data.tests = { dev: { version: "==1.0.0" } };
  await writeFile(path.join(dir, "Pipfile.lock"), JSON.stringify(data));
  const file = path.join(dir, "Pipfile");
  await writeFile(file, await readFile(file, "utf8") + '\n[docs]\ndev="==1.0.0"\n[tests]\ndev="==1.0.0"\n');
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(targets).toHaveLength(3);
    return parseOsvScanOutput({ results: targets.map((target, i) => ({ source: { path: target.path, type: "lockfile" }, packages: [{
      package: { name: "dev", version: "1.0.0", ecosystem: "PyPI" },
      ...(i === 0 ? { dependency_groups: ["dev"] } : {}),
      groups: [{ ids: ["GHSA-dev"], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-dev", affected: [{ package: { name: "dev", ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    }] })) });
  });
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect((payload.packages ?? payload.suggestions)[0].dependency_groups).toEqual(["dev", "docs", "tests"]);
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
// Child development groups are not installed through a parent path dependency.
it.each(["included", "missing", "unconfirmed", "nonmember"])("propagates Pipenv origins and %s coverage to both tools", async status => {
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
it("omits a partial introduced_by when another category has several possible origins in both tools", async () => {
  const data = JSON.parse(await fixture());
  data.develop.leaf = { version: "==1.0.0" }; data.develop.other = { version: "==1.0.0" };
  await writeFile(path.join(dir, "Pipfile.lock"), JSON.stringify(data));
  const file = path.join(dir, "Pipfile");
  await writeFile(file, (await readFile(file, "utf8")).replace("[dev-packages]\n", '[dev-packages]\nother="==1.0.0"\n'));
  vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: [{
    package: { name: "leaf", version: "1.0.0", ecosystem: "PyPI" }, groups: [{ ids: ["GHSA-leaf"], aliases: [] }],
    vulnerabilities: [{ id: "GHSA-leaf", affected: [{ package: { name: "leaf", ecosystem: "PyPI" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
  }] }] }));
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    const leaf = (payload.packages ?? payload.suggestions)[0];
    expect(leaf).toMatchObject({ dependency_relation: "transitive" });
    expect(leaf.introduced_by).toBeUndefined();
    if (payload.suggestions) expect(leaf.update_hint).not.toContain("parent");
  }
});
it("does not cover independent descendant projects or legacy marker files by name alone", async () => {
  await fixture(); await mkdir(path.join(dir, member, "independent"));
  await writeFile(path.join(dir, member, "independent/pyproject.toml"), '[project]\nname="web"');
  await writeFile(path.join(dir, member, "Pipfile"), "");
  const missing = (await detectProject(dir)).lockfileMissing;
  expect(missing).toContainEqual(expect.objectContaining({ path: `${member}/independent/pyproject.toml`, status: "missing" }));
  expect(missing).toContainEqual(expect.objectContaining({ path: `${member}/Pipfile`, status: "unconfirmed" }));
});
it("uses the same capture for coverage, graph metadata and scanner input after mutation", async () => {
  await fixture(); const project = await detectProject(dir);
  await writeFile(path.join(dir, "Pipfile.lock"), "changed original");
  await writeFile(path.join(dir, member, "pyproject.toml"), "changed companion");
  const report = await scanFromSnapshot(project, {});
  expect(buildCoverage(project).complete).toBe(true);
  expect(report.packages.find(p => p.name === "dev")?.declared_in).toEqual([`${member}/pyproject.toml`]);
});
it("caches captured Pipenv input and respects the read budget", async () => {
  const content = await fixture(), file = path.join(dir, "Pipfile.lock"), cache = new PipenvLockCache(Buffer.byteLength(content));
  const captured = await cache.get(file, dir, [`${member}/pyproject.toml`]);
  await writeFile(file, "changed original");
  expect(await cache.get(file, dir, [`${member}/pyproject.toml`])).toBe(captured);
  expect(await cache.get(path.join(dir, "other/pipenv.lock"), dir, [])).toHaveProperty("reason");
});
