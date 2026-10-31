/** Opt-in real Gradle regressions. No dependency downloads: metadata comes from a local Maven repository. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeGradleContext, parseGradleGraph, parseGradleLock } from "../../utils/gradleGraph.js";

const binary = process.env.OSV_MCP_TEST_GRADLE;
const exporter = process.env.OSV_MCP_TEST_GRADLE_EXPORTER ?? fileURLToPath(new URL("../../../gradle/export-dependency-graph.init.gradle", import.meta.url));
const dirs: string[] = [];
const lock = "review:parent:1=compileClasspath,runtimeClasspath,testCompileClasspath,testRuntimeClasspath\n" +
  "review:leaf:1=compileClasspath,runtimeClasspath,testCompileClasspath,testRuntimeClasspath\nempty=annotationProcessor,testAnnotationProcessor\n";
const base = `plugins { id 'java-library' }
repositories { maven { url = uri('repo') } }
dependencyLocking { lockAllConfigurations() }
dependencies { implementation 'review:parent:1' }
`;
const directLeaf = "\ndependencies { implementation 'review:leaf:1' }\n";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function fixture(build = base, settings = "rootProject.name = 'exporter-regression'\n", buildName = "build.gradle") {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-gradle-exporter-test-"))); dirs.push(dir);
  await writeFile(path.join(dir, buildName), build);
  await writeFile(path.join(dir, "settings.gradle"), settings);
  await writeFile(path.join(dir, "gradle.lockfile"), lock);
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), '{"previous":true}\n');
  for (const name of ["parent", "leaf"]) {
    const dest = path.join(dir, "repo", "review", name, "1"); await mkdir(dest, { recursive: true });
    const dependencies = name === "parent" ? "<dependencies><dependency><groupId>review</groupId><artifactId>leaf</artifactId><version>1</version></dependency></dependencies>" : "";
    await writeFile(path.join(dest, name + "-1.pom"), `<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>${name}</artifactId><version>1</version>${dependencies}</project>`);
  }
  return dir;
}
async function run(dir: string, preceding: string[] = []) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(binary!, ["-p", dir, "-I", exporter, ...preceding, "osvMcpExportDependencies", "-PosvMcpConfigurations=*",
      "--offline", "--no-configuration-cache", "--no-daemon", "--console=plain"],
    { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
      resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, output: stdout + stderr });
    });
  });
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe.skipIf(!binary)("real Gradle exporter input snapshots", () => {
  it("rejects a preceding task's declaration update without overwriting the previous companion", async () => {
    const dir = await fixture(base + `tasks.register('mutate') { doLast { file('build.gradle').append(${JSON.stringify(directLeaf)}) } }\n`);
    const result = await run(dir, ["mutate"]);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("Build input changed during OSV graph export");
    expect(await readFile(path.join(dir, "build.gradle"), "utf8")).toContain(directLeaf);
    expect(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8")).toBe('{"previous":true}\n');
    // A fresh invocation evaluates the changed declaration and may safely export it.
    const retry = await run(dir); expect(retry.code, retry.output).toBe(0);
    const graph = parseGradleGraph(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8"));
    expect(graph.inputs.files.find(f => f.path === "build.gradle")?.sha256).toBe(digest(await readFile(path.join(dir, "build.gradle"), "utf8")));
    const context = graph.contexts.find(c => c.configuration === "runtimeClasspath")!;
    expect(analyzeGradleContext(context, parseGradleLock(lock)).lookup!("review:leaf", "1").relation).toBe("direct");
  }, 90_000);
  it("rejects a declaration changed while its build script is being evaluated", async () => {
    const dir = await fixture(base + `file('build.gradle').append(${JSON.stringify(directLeaf)})\n`);
    const result = await run(dir);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("Build input changed during OSV graph export");
    expect(await readFile(path.join(dir, "build.gradle"), "utf8")).toContain(directLeaf);
    expect(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8")).toBe('{"previous":true}\n');
  }, 90_000);
  it("captures settings before evaluation, including changes made by the settings script itself", async () => {
    const dir = await fixture(base, "rootProject.name = 'exporter-regression'\nfile('settings.gradle').append('\\n// changed\\n')\n");
    const result = await run(dir);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("Build input changed during OSV graph export");
    expect(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8")).toBe('{"previous":true}\n');
  }, 90_000);
  it("detects creation of a previously absent known input during evaluation", async () => {
    const dir = await fixture(base + "file('gradle.properties').text = 'newProperty=value\\n'\n");
    const result = await run(dir);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("Build input changed during OSV graph export");
  }, 90_000);
  it("captures child build files before a root build can modify them", async () => {
    const dir = await fixture(base + "file('child/build.gradle').append('\\n// changed\\n')\n", "rootProject.name = 'exporter-regression'\ninclude 'child'\n");
    await mkdir(path.join(dir, "child")); await writeFile(path.join(dir, "child/build.gradle"), "// child\n");
    const result = await run(dir);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("Build input changed during OSV graph export");
  }, 90_000);
  it("also refuses inputs changed during dependency resolution", async () => {
    const dir = await fixture(base + "configurations.runtimeClasspath.incoming.beforeResolve { file('build.gradle').append('\\n// resolved\\n') }\n");
    const result = await run(dir);
    expect(result.code, result.output).not.toBe(0);
    expect(result.output).toContain("Build input changed during OSV graph export");
    expect(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8")).toBe('{"previous":true}\n');
  }, 90_000);
  it("exports unchanged evaluated input hashes and the correct dependency origins", async () => {
    const dir = await fixture(); const result = await run(dir);
    expect(result.code, result.output).toBe(0);
    const graph = parseGradleGraph(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8"));
    expect(graph.inputs.files.find(f => f.path === "build.gradle")?.sha256).toBe(digest(base));
    expect(graph.inputs.files.every(f => f.sha256.length === 64)).toBe(true);
    expect(graph.contexts.every(c => c.complete)).toBe(true);
    const context = graph.contexts.find(c => c.configuration === "runtimeClasspath")!;
    const analysis = analyzeGradleContext(context, parseGradleLock(lock));
    expect(analysis.lookup!("review:parent", "1").relation).toBe("direct");
    expect(analysis.lookup!("review:leaf", "1")).toMatchObject({ relation: "transitive", introducedBy: new Set(["review:parent"]) });
  }, 90_000);

  it.each([false, true])("Kotlin build file captured before evaluation (mutation=%s)", async mutate => {
    const kotlin = `plugins { \`java-library\` }
repositories { maven { url = uri("repo") } }
dependencyLocking { lockAllConfigurations() }
dependencies { implementation("review:parent:1") }
` + (mutate ? 'file("build.gradle.kts").appendText("\\n// changed\\n")\n' : "");
    const dir = await fixture(kotlin, undefined, "build.gradle.kts"); const result = await run(dir);
    if (mutate) {
      expect(result.code, result.output).not.toBe(0);
      expect(result.output).toContain("Build input changed during OSV graph export");
      expect(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8")).toBe('{"previous":true}\n');
    } else {
      expect(result.code, result.output).toBe(0);
      const graph = parseGradleGraph(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8"));
      expect(graph.inputs.files.find(f => f.path === "build.gradle.kts")?.sha256).toBe(digest(kotlin));
      expect(graph.contexts.every(c => c.complete)).toBe(true);
    }
  }, 90_000);

});
