import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { handleScanProject, buildRelationLookups } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { runOsvScan } from "../../osv/runner.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const lock = stringify({ lockfileVersion: "9.0", importers: { ".": { dependencies: { parent: { version: "1.0.0" } } }, "apps/web": { devDependencies: { dev: { version: "1.0.0" } } } },
  packages: { "parent@1.0.0": {}, "leaf@1.0.0": {}, "dev@1.0.0": {} },
  snapshots: { "parent@1.0.0": { dependencies: { leaf: "1.0.0" } }, "leaf@1.0.0": {}, "dev@1.0.0": {} } });
it.each(["apps/web", "apps/日本語", "apps/my app"])("propagates pnpm declarations from %s and transitive origins in both tools", async root => {
  const capturedLock = lock.replace("apps/web:", `${JSON.stringify(root)}:`);
  dir = await mkdtemp(path.join(os.tmpdir(), "osv-pnpm-origins-"));
  await mkdir(path.join(dir, "nested"));
  const file = path.join(dir, "nested/pnpm-lock.yaml");
  await writeFile(file, capturedLock);
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(await readFile(targets[0]!.path, "utf8")).toBe(capturedLock);
    await writeFile(file, "invalid original changed after capture");
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["parent", "leaf", "dev"].map(name => ({
      package: { name, version: "1.0.0", ecosystem: "npm" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
      vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
    })) }] });
  });
  for (const tool of ["scan", "fix"]) {
    await writeFile(file, capturedLock);
    const result = tool === "scan" ? await handleScanProject({ project_path: dir }) : await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" });
    const payload = JSON.parse(result.content[0]!.text);
    const packages = payload.packages ?? payload.suggestions;
    const byName = (name: string) => packages.find((p: { name?: string; package?: string }) => (p.name ?? p.package) === name);
    expect(byName("parent")).toMatchObject({ dependency_relation: "direct", declared_in: ["nested/package.json"] });
    expect(byName("dev")).toMatchObject({ dependency_relation: "direct", declared_in: [`nested/${root}/package.json`] });
    expect(byName("leaf")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["parent"] });
    expect(byName("leaf").declared_in).toBeUndefined();
    if (tool === "fix") {
      expect(byName("parent").update_hint).toContain("nested/package.json");
      expect(byName("dev").update_hint).toContain(`nested/${root}/package.json`);
      expect(byName("leaf").update_hint).toContain("parent");
      expect(byName("leaf").recommended_upgrade).toBe("1.0.1");
    }
  }
});
it("leaves pnpm relationships unknown when the shared read budget is exhausted", async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "osv-pnpm-budget-"));
  const file = path.join(dir, "pnpm-lock.yaml");
  await writeFile(file, lock);
  const result = await buildRelationLookups([{ copy: file, format: "pnpm-lock.yaml", originalRelative: "pnpm-lock.yaml" }], 10);
  expect(result.get(file)!.lookup).toBeNull();
});
