import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { handleScanProject } from "../../tools/scanProject.js";
import { handleScanJavaProject } from "../../tools/scanJavaProject.js";
import { handleSuggestFix } from "../../tools/suggestFix.js";
import { runOsvScan } from "../../osv/runner.js";
import { parseOsvScanOutput } from "../../osv/scanReport.js";
import { sha256 } from "../../utils/gradleGraphCache.js";
import { graphFixture } from "../fixtures/gradleGraphFixture.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); });
const lock = "g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n";
async function fixture() {
  dir = await mkdtemp(path.join(os.tmpdir(), "osv-gradle-test-"));
  await writeFile(path.join(dir, "gradle.lockfile"), lock);
  const graph = graphFixture(); graph.lockfiles[0]!.sha256 = sha256(lock);
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
  // A scan must never execute this Wrapper.
  await writeFile(path.join(dir, "gradlew"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  vi.mocked(runOsvScan).mockImplementation(async targets => {
    expect(targets).toHaveLength(1); expect(targets[0]!.format).toBe("gradle.lockfile");
    return parseOsvScanOutput({ results: [{ source: { path: targets[0]!.path, type: "lockfile" }, packages: ["a", "b"].map((name, i) => ({
      package: { name: `g:${name}`, version: String(i + 1), ecosystem: "Maven" },
      groups: [{ ids: ["GHSA-test"], max_severity: "7.5" }],
      vulnerabilities: [{ id: "GHSA-test", affected: [{ package: { name: `g:${name}`, ecosystem: "Maven" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "3" }] }] }] }],
    })) }] });
  });
  return graph;
}
it("all three tools enrich only captured lockfiles with Gradle relations and hints", async () => {
  await fixture();
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
    expect(result.isError).toBeUndefined(); const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    const packages = payload.packages ?? payload.suggestions;
    const a = packages.find((p: any) => (p.name ?? p.package) === "g:a");
    const b = packages.find((p: any) => (p.name ?? p.package) === "g:b");
    expect(a.dependency_relation).toBe("direct"); expect(a.declared_in).toBeUndefined();
    expect(b.dependency_relation).toBe("transitive"); expect(b.introduced_by).toEqual(["g:a"]);
    if (payload.suggestions) { expect(b.update_hint).toContain("Gradle"); expect(b.update_hint).not.toContain("pom.xml"); }
  }
});

it("stale metadata cannot lower vulnerability coverage, but verified graph-only modules do", async () => {
  const graph = await fixture();
  await writeFile(path.join(dir, "gradle.lockfile"), "g:a:1=runtimeClasspath\n");
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const run = async () => JSON.parse((await handler({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
    const stale = await run(); expect(stale.coverage.complete).toBe(true);
    expect(stale.coverage.dependency_metadata.gradle[0].reasons).toContain("stale_lock_hash");
    graph.lockfiles[0]!.sha256 = sha256("g:a:1=runtimeClasspath\n");
    await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
    const valid = await run(); expect(valid.coverage.complete).toBe(false);
    expect(valid.coverage.skipped_files).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "Gradle graph: graph_modules_missing_from_lock" })]));
    graph.lockfiles[0]!.sha256 = sha256(lock);
    await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
  }
});

it("input freshness and ambiguous companions affect metadata, not lock coverage", async () => {
  const graph: any = await fixture();
  await writeFile(path.join(dir, "build.gradle"), "// changed\n");
  graph.inputs.files = [{ path: "build.gradle", sha256: sha256("// original\n") }];
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const p = JSON.parse((await handler({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
    expect(p.coverage.complete).toBe(true);
    expect(p.coverage.dependency_metadata.gradle[0].reasons).toContain("stale_input_hash");
    expect((p.packages ?? p.suggestions).every((v: any) => v.dependency_relation === "unknown")).toBe(true);
  }
});

it("all tools withhold partial origins across locks regardless of source order", async () => {
  await fixture(); await mkdir(path.join(dir, "child")); await writeFile(path.join(dir, "child", "gradle.lockfile"), lock);
  for (const reverse of [false, true]) {
    vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: (reverse ? [...targets].reverse() : targets).map(target => ({
      source: { path: target.path, type: "lockfile" }, packages: [{ package: { name: "g:b", version: "2", ecosystem: "Maven" }, groups: [{ ids: ["GHSA-test"], max_severity: "7.5" }] }],
    })) }));
    for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
      const payload = JSON.parse((await handler({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
      const pkg = (payload.packages ?? payload.suggestions)[0];
      expect(pkg.dependency_relation).toBe("mixed"); expect(pkg.introduced_by).toBeUndefined(); expect(pkg.introduced_by_omitted).toBeUndefined(); expect(pkg.declared_in).toBeUndefined();
      expect(payload.coverage.complete).toBe(true);
    }
  }
});

it("mixed Maven/Gradle sources get both update targets without exposing internal source context", async () => {
  await fixture(); await writeFile(path.join(dir, "pom.xml"), "<project/>");
  vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: targets.map(target => ({
    source: { path: target.path, type: "lockfile" }, packages: [{ package: { name: "g:b", version: "2", ecosystem: "Maven" }, groups: [{ ids: ["GHSA-test"], max_severity: "7.5" }] }],
  })) }));
  const result = await handleSuggestFix({ project_path: dir }, { candidateCheck: "disabled" });
  const p = JSON.parse(result.content[0]!.text);
  expect(p.suggestions[0].update_hint).toContain("Gradle"); expect(p.suggestions[0].update_hint).toContain("pom.xml");
  expect(result.content[0]!.text).not.toContain("build_systems");
});
it("uses the captured lock and metadata even if originals change during the scan", async () => {
  await fixture(); const originalRunner = vi.mocked(runOsvScan).getMockImplementation()!;
  vi.mocked(runOsvScan).mockImplementation(async (targets, options) => {
    await writeFile(path.join(dir, "gradle.lockfile"), "g:a:99=runtimeClasspath\n");
    await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "{}");
    return originalRunner(targets, options);
  });
  const result = await handleScanProject({ project_path: dir });
  const p = JSON.parse(result.content[0]!.text);
  expect(p.packages.find((v: any) => v.name === "g:b")).toMatchObject({ dependency_relation: "transitive", introduced_by: ["g:a"] });
  expect(p.coverage.complete).toBe(true);
});
