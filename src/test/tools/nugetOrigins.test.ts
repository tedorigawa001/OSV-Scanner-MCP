import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectProject } from "../../utils/manifestDetector.js";
import { handleScanProject } from "../../tools/scanProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { runOsvScan } from "../../osv/runner.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
async function fixture(files: Record<string, string>) {
  dir = await mkdtemp(path.join(os.tmpdir(), "osv-nuget-origins-"));
  for (const [name, value] of Object.entries(files)) { await mkdir(path.dirname(path.join(dir, name)), { recursive: true }); await writeFile(path.join(dir, name), value); }
}
const project = (name = "Parent", version = "1.0.0") => `<Project><ItemGroup><PackageReference Include="${name}" Version="${version}" /></ItemGroup></Project>`;
const lock = JSON.stringify({ version: 1, dependencies: { net8: { Parent: { type: "Direct", resolved: "1.0.0", dependencies: { Leaf: "[1.0.0,)" } }, Leaf: { type: "Transitive", resolved: "1.0.0" } } } });
function report(source: string) {
  return parseOsvScanOutput({ results: [{ source: { path: source, type: "lockfile" }, packages: ["Parent", "Leaf"].map(name => ({
    package: { name, version: "1.0.0", ecosystem: "NuGet" }, groups: [{ ids: ["GHSA-" + name], aliases: [] }],
    vulnerabilities: [{ id: "GHSA-" + name, affected: [{ package: { name, ecosystem: "NuGet" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "1.0.1" }] }] }] }],
  })) }] });
}

describe("NuGet declaration origins", () => {
  it("propagates origins and declaring projects to both tools using captured data", async () => {
    await fixture({ "App/App.csproj": project(), "App/packages.lock.json": lock });
    vi.mocked(runOsvScan).mockImplementation(async targets => {
      expect(await readFile(targets[0]!.path, "utf8")).not.toContain("dependencies\":{\"Leaf");
      await writeFile(path.join(dir, "App/App.csproj"), "<Project />");
      return report(targets[0]!.path);
    });
    const scan = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    expect(scan.packages.find((p: { name: string }) => p.name === "Parent")).toMatchObject({ dependency_relation: "direct", declared_in: [path.join("App", "App.csproj")] });
    expect(scan.packages.find((p: { name: string }) => p.name === "Leaf")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["Parent"] });
    await writeFile(path.join(dir, "App/App.csproj"), project());
    const fix = JSON.parse((await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
    const parent = fix.suggestions.find((p: { package: string }) => p.package === "Parent");
    const leaf = fix.suggestions.find((p: { package: string }) => p.package === "Leaf");
    expect(parent.declared_in).toEqual([path.join("App", "App.csproj")]); expect(parent.update_hint).toContain(path.join("App", "App.csproj"));
    expect(leaf.introduced_by).toEqual(["Parent"]); expect(leaf.update_hint).toContain("Parent");
    expect(leaf.recommended_upgrade).toBe("1.0.1"); expect(leaf.declared_in).toBeUndefined();
  });
  it("does not choose a project for an ambiguous unnamed lockfile", async () => {
    await fixture({ "A.csproj": project(), "B.csproj": project(), "packages.lock.json": lock });
    const copy = (await detectProject(dir)).nugetCopies.find(c => c.path === "packages.lock.json")!;
    expect(copy.relations!("Parent", "1.0.0").declaredIn).toBeUndefined();
    expect(copy.relations!("Leaf", "1.0.0").introducedBy).toEqual(new Set(["Parent"]));
  });
  it("matches named lockfiles, including csproj/fsproj/vbproj, without cross-project declarations", async () => {
    await fixture({ "A.fsproj": project(), "B.vbproj": project("Other"), "packages.A.lock.json": lock });
    const copy = (await detectProject(dir)).nugetCopies.find(c => c.path === "packages.A.lock.json")!;
    expect(copy.relations!("Parent", "1.0.0").declaredIn).toEqual(new Set(["A.fsproj"]));
  });
  it.each(["$(Version)", "", "1.*"])("recognizes unconditional declarations with unresolved versions (%s)", async version => {
    await fixture({ "App.csproj": project("Parent", version), "packages.lock.json": lock });
    const copy = (await detectProject(dir)).nugetCopies[0]!;
    expect(copy.relations!("parent", "1.0.0").declaredIn).toEqual(new Set(["App.csproj"]));
  });
  it("does not declare implicit or conditional references as confirmed project declarations", async () => {
    await fixture({ "App.csproj": '<Project><ItemGroup><PackageReference Include="Parent" Version="1" Condition="false" /></ItemGroup></Project>', "packages.lock.json": lock });
    expect((await detectProject(dir)).nugetCopies[0]!.relations!("Parent", "1.0.0").declaredIn).toBeUndefined();
  });
  it("matches assets to the owning project and restores the correct relative path", async () => {
    await fixture({ "App/App.csproj": project(), "App/obj/project.assets.json": JSON.stringify({ libraries: { "Parent/1.0.0": { type: "package" }, "Leaf/1.0.0": { type: "package" } },
      project: { restore: { projectPath: "C:\\src\\App.csproj" }, frameworks: { net8: { dependencies: { Parent: {} } } } },
      targets: { net8: { "Parent/1.0.0": { type: "package", dependencies: { Leaf: "1.0.0" } }, "Leaf/1.0.0": { type: "package" } } } }) });
    const copy = (await detectProject(dir)).nugetCopies[0]!;
    expect(copy.relations!("Parent", "1.0.0").declaredIn).toEqual(new Set([path.join("..", "App.csproj")]));
    expect(copy.relations!("Leaf", "1.0.0").introducedBy).toEqual(new Set(["Parent"]));
  });
  it("gives direct-only declarations while retaining lower-bound status and coverage gaps", async () => {
    await fixture({ "App.csproj": project() });
    const p = await detectProject(dir), copy = p.nugetCopies[0]!;
    expect(copy.packages[0]!.lowerBound).toBe(true); expect(p.lockfileMissing).toHaveLength(1);
    expect(copy.relations!("Parent", "1.0.0").declaredIn).toEqual(new Set(["App.csproj"]));
  });
  it("standalone deps/config files do not guess declaration paths", async () => {
    await fixture({ "app.deps.json": JSON.stringify({ libraries: { "app/1": { type: "project" }, "Parent/1.0.0": { type: "package" }, "Leaf/1.0.0": { type: "package" } },
      targets: { net8: { "app/1": { dependencies: { Parent: "1.0.0" } }, "Parent/1.0.0": { dependencies: { Leaf: "1.0.0" } }, "Leaf/1.0.0": {} } } }),
      "packages.config": '<packages><package id="Parent" version="1.0.0" /></packages>' });
    const p = await detectProject(dir);
    const deps = p.nugetCopies.find(c => c.format === "deps.json")!;
    expect(deps.relations!("Leaf", "1.0.0").introducedBy).toEqual(new Set(["Parent"]));
    for (const copy of p.nugetCopies) expect(copy.relations!("Parent", "1.0.0").declaredIn).toBeUndefined();
  });
});
