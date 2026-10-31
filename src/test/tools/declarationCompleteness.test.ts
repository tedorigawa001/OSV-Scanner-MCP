import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "smol-toml";
import { annotateRelations, handleScanProject } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
import { runOsvScan } from "../../osv/runner.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "osv-declarations-")); dirs.push(dir);
  for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), text); }
  return dir;
}
const registry = "registry+https://github.com/rust-lang/crates.io-index";
function cargo(root: string) { return `version = 3
[[package]]
name = "${root}"
version = "0.1.0"
dependencies = ["leaf"]
[[package]]
name = "leaf"
version = "1.0.0"
source = "${registry}"
`; }
function packageResult(ecosystem: string, name: string, version: string) {
  return { package: { name, version, ecosystem }, groups: [{ ids: ["GHSA-declarations"], max_severity: "7.5" }],
    vulnerabilities: [{ id: "GHSA-declarations", affected: [{ package: { name, ecosystem }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }] };
}
const handlers = [["scan_project", handleScanProject], ["suggest_fix", handleSuggestFix]] as const;
describe("declaration completeness across source files", () => {
  it.each(handlers)("%s withholds a partially mapped Cargo declaration list regardless of source order", async (_name, handler) => {
    const dir = await fixture({ "mapped/Cargo.lock": cargo("mapped"), "mapped/Cargo.toml": '[package]\nname = "mapped"\n', "unmapped/Cargo.lock": cargo("unmapped") });
    for (const reverse of [false, true]) {
      vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: (reverse ? [...targets].reverse() : targets).map(target => ({
        source: { path: target.path, type: "lockfile" }, packages: [packageResult("crates.io", "leaf", "1.0.0")],
      })) }));
      const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
      expect(result.isError).toBeUndefined(); const p = JSON.parse(result.content[0]!.text);
      const pkg = (p.packages ?? p.suggestions)[0];
      expect(pkg.dependency_relation).toBe("direct"); expect(pkg.declared_in).toBeUndefined();
      expect(pkg.declaring_crates).toContain("unmapped");
      if (pkg.update_hint) {
        expect(pkg.update_hint).not.toContain("mapped/Cargo.toml");
        expect(pkg.update_hint).toContain("the declaring Cargo.toml files");
      }
      expect(p.coverage.complete).toBe(true);
    }
  });
  it.each(handlers)("%s preserves complete npm paths and omits them when a source is unknown", async (_name, handler) => {
    const direct = JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { leaf: "1.0.0" } }, "node_modules/leaf": { version: "1.0.0" } } });
    const transitive = JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { parent: "1.0.0" } }, "node_modules/parent": { version: "1.0.0", dependencies: { leaf: "1.0.0" } }, "node_modules/leaf": { version: "1.0.0" } } });
    const dir = await fixture({ "a/package-lock.json": direct, "b/package-lock.json": direct });
    for (const [content, expected, relation] of [
      [direct, ["a/package.json", "b/package.json"], "direct"],
      [transitive, ["a/package.json"], "mixed"],
      [JSON.stringify({ lockfileVersion: 1, dependencies: { leaf: { version: "1.0.0" } } }), undefined, "mixed"],
    ] as const) {
      await writeFile(path.join(dir, "b/package-lock.json"), content);
      for (const reverse of [false, true]) {
        vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: (reverse ? [...targets].reverse() : targets).map(target => ({
          source: { path: target.path, type: "lockfile" }, packages: [packageResult("npm", "leaf", "1.0.0")],
        })) }));
        const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
        expect(result.isError).toBeUndefined(); const p = JSON.parse(result.content[0]!.text), pkg = (p.packages ?? p.suggestions)[0];
        expect(pkg.declared_in).toEqual(expected); expect(pkg.dependency_relation).toBe(relation);
        if (pkg.update_hint && !expected) expect(pkg.update_hint).not.toContain("a/package.json");
      }
    }
  });

  it.each(handlers)("%s does not infer a flattened requirements declaration from its filename", async (_name, handler) => {
    const uv = stringify({ version: 1, package: [
      { name: "app", version: "0.1.0", source: { virtual: "." }, dependencies: [{ name: "leaf" }] },
      { name: "leaf", version: "1.0.0", source: { registry: "https://pypi.org/simple" } },
    ] });
    const dir = await fixture({ "uv.lock": uv, "pyproject.toml": '[project]\nname="app"\nversion="0.1.0"\ndependencies=["leaf==1.0.0"]\n',
      "requirements.txt": "-r nested/dependencies.txt\n", "nested/dependencies.txt": "leaf==1.0.0\n" });
    for (const reverse of [false, true]) {
      vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: (reverse ? [...targets].reverse() : targets).map(target => ({
        source: { path: target.path, type: "lockfile" }, packages: [packageResult("PyPI", "leaf", "1.0.0")],
      })) }));
      const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
      expect(result.isError).toBeUndefined(); const p = JSON.parse(result.content[0]!.text), pkg = (p.packages ?? p.suggestions)[0];
      expect(pkg.dependency_relation).toBe("direct"); expect(pkg.declared_in).toBeUndefined();
      if (pkg.update_hint) expect(pkg.update_hint).toContain("requirements.txt, pyproject.toml, or Pipfile");
    }
  });
  it.each(handlers)("%s requires every direct NuGet source to have an identified declaration", async (_name, handler) => {
    const lock = JSON.stringify({ version: 1, dependencies: { net8: { Leaf: { type: "Direct", resolved: "1.0.0" } } } });
    const project = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Leaf" Version="1.0.0" /></ItemGroup></Project>';
    const dir = await fixture({ "App/App.csproj": project, "App/packages.lock.json": lock, "Other/packages.lock.json": lock });
    for (const mapped of [false, true]) {
      if (mapped) await writeFile(path.join(dir, "Other/Other.csproj"), project);
      for (const reverse of [false, true]) {
        vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: (reverse ? [...targets].reverse() : targets).map(target => ({
          source: { path: target.path, type: "lockfile" }, packages: [packageResult("NuGet", "Leaf", "1.0.0")],
        })) }));
        const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
        expect(result.isError).toBeUndefined(); const p = JSON.parse(result.content[0]!.text), pkg = (p.packages ?? p.suggestions)[0];
        expect(pkg.dependency_relation).toBe("direct");
        expect(pkg.declared_in).toEqual(mapped ? ["App/App.csproj", "Other/Other.csproj"] : undefined);
        if (pkg.update_hint && !mapped) { expect(pkg.update_hint).toContain("the project file"); expect(pkg.update_hint).not.toContain("App/App.csproj"); }
        expect(p.coverage.complete).toBe(true);
      }
    }
  });

});

it("same-file relation precedence does not erase declaration incompleteness", () => {
  for (const lower of ["unknown", "transitive"] as const) for (const reverse of [false, true]) {
    const types = reverse ? [lower, "direct"] : ["direct", lower];
    const report = parseOsvScanOutput({ results: types.map(type => ({ source: { path: "/copy", type }, packages: [packageResult("npm", "leaf", "1.0.0")] })) });
    const [pkg] = annotateRelations(report.packages, new Map([["/copy", {
      lockDir: "project", lookup: (_name, _version, type) => type === "direct"
        ? { relation: "direct", declaredIn: new Set(["package.json"]) } : { relation: lower },
    }]]));
    expect(pkg!.dependency_relation).toBe("direct");
    expect(pkg!.declared_in).toEqual(lower === "unknown" ? undefined : ["project/package.json"]);
  }
});
