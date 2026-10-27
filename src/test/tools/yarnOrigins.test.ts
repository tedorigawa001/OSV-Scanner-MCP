import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { handleScanProject, scanFromSnapshot, buildCoverage } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { detectProject } from "../../utils/manifestDetector.js";
import { YarnLockCache } from "../../utils/yarnLockCache.js";
import { runOsvScan } from "../../osv/runner.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const member = "apps/日本語 app";
const classic = `# yarn lockfile v1
parent@^1:
  version "1.0.0"
  dependencies:
    leaf "^1"
leaf@^1:
  version "1.0.0"
dev@1.0.0:
  version "1.0.0"
`;
function berry(status: string) {
  return stringify({ __metadata: { version: status === "unconfirmed" ? "99" : "8" },
    "app@workspace:.": { version: "0.0.0-use.local", resolution: "app@workspace:.", dependencies: { parent: "npm:^1" } },
    ...(status === "missing" ? {} : { [`web@workspace:${member}`]: { version: "0.0.0-use.local", resolution: `web@workspace:${member}`, dependencies: { dev: "npm:1.0.0" } } }),
    "parent@npm:^1": { version: "1.0.0", resolution: "parent@npm:1.0.0", dependencies: { leaf: "npm:^1" } },
    "leaf@npm:^1": { version: "1.0.0", resolution: "leaf@npm:1.0.0" },
    "dev@npm:1.0.0": { version: "1.0.0", resolution: "dev@npm:1.0.0" },
  });
}
async function fixture(flavor: string, status: string) {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-yarn-")));
  await mkdir(path.join(dir, member), { recursive: true });
  const content = flavor === "classic" ? classic : berry(status);
  await writeFile(path.join(dir, "yarn.lock"), content);
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", private: true, workspaces: status === "missing" ? ["other/*"] : status === "unconfirmed" ? ["apps/{a,b}"] : ["apps/*"], dependencies: { parent: "^1" } }));
  await writeFile(path.join(dir, member, "package.json"), JSON.stringify({ name: "web", version: "1.0.0", devDependencies: { dev: "1.0.0" } }));
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(content);
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["parent", "leaf", "dev"].map(name => ({
      package: { name, version: "1.0.0", ecosystem: "npm" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    })) }] });
  });
  return content;
}
it.each(["classic", "berry"].flatMap(flavor => ["included", "missing", "unconfirmed"].map(status => ({ flavor, status }))))("reports $flavor $status workspace coverage in both tools", async ({ flavor, status }) => {
  await fixture(flavor, status);
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(status === "included");
    if (status !== "included") expect(payload.coverage.lockfile_missing).toMatchObject([{ path: `${member}/package.json`, status }]);
    else {
      const packages = payload.packages ?? payload.suggestions;
      const get = (name: string) => packages.find((p: { name?: string; package?: string }) => (p.name ?? p.package) === name);
      expect(get("dev")).toMatchObject({ dependency_relation: "direct", declared_in: [`${member}/package.json`] });
      expect(get("leaf")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["parent"] });
      if (payload.suggestions) { expect(get("dev").update_hint).toContain(`${member}/package.json`); expect(get("leaf").update_hint).toContain("parent"); }
    }
  }
});
it.each(["classic", "berry"])("uses captured lock and manifest data after changes (%s)", async flavor => {
  await fixture(flavor, "included");
  const project = await detectProject(dir);
  await writeFile(path.join(dir, "yarn.lock"), "changed after capture");
  await writeFile(path.join(dir, member, "package.json"), "{}");
  const report = await scanFromSnapshot(project, {});
  expect(buildCoverage(project).complete).toBe(true);
  expect(report.packages.find(p => p.name === "dev")?.declared_in).toEqual([`${member}/package.json`]);
});
it("caches captured inputs once and observes the shared read limit", async () => {
  const content = await fixture("classic", "included");
  const file = path.join(dir, "yarn.lock"), cache = new YarnLockCache(Buffer.byteLength(content));
  const first = await cache.get(file, dir, ["package.json", `${member}/package.json`]);
  await writeFile(file, "changed");
  expect(await cache.get(file, dir, [])).toBe(first);
  expect(await cache.get(path.join(dir, "other/yarn.lock"), dir, [])).toHaveProperty("reason");
});
it.each(["missing-name", "missing-version", "hidden"])("does not confirm ignored Classic children in either tool: %s", async scenario => {
  await fixture("classic", "included");
  let directory = member;
  const child: Record<string, unknown> = { name: "web", version: "1.0.0", devDependencies: { dev: "1.0.0" } };
  if (scenario === "hidden") {
    await rm(path.join(dir, member), { recursive: true });
    directory = "apps/.hidden";
    await mkdir(path.join(dir, directory), { recursive: true });
  } else delete child[scenario === "missing-name" ? "name" : "version"];
  await writeFile(path.join(dir, directory, "package.json"), JSON.stringify(child));
  for (const result of [await handleScanProject({ project_path: dir }), await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })]) {
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(false);
    expect(payload.coverage.lockfile_missing).toMatchObject([{ path: `${directory}/package.json`, status: "missing" }]);
    const packages = payload.packages ?? payload.suggestions;
    const pkg = packages.find((p: { name?: string; package?: string }) => (p.name ?? p.package) === "dev");
    expect(pkg.dependency_relation).toBe("unknown");
    expect(pkg.declared_in).toBeUndefined();
    if (payload.suggestions) expect(pkg.update_hint).not.toContain(`${directory}/package.json`);
  }
});
