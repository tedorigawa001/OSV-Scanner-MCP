/** Stage C feasibility gate: real public Gradle APIs, offline local metadata only. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const binary = process.env.OSV_MCP_TEST_GRADLE;
const probe = fileURLToPath(new URL("../fixtures/gradle-declaration-probe.init.gradle", import.meta.url));
const dirs: string[] = [];
afterAll(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

interface ProbeReport {
  gradleVersion: string;
  equalDeclarations: boolean; sameInstance: boolean; dependencies: number; additionCallbacks: number; rootEdges: number;
  providerRealizedBefore: boolean; providerRealizedAfter: boolean;
  lazy: { callbacksBefore: number; callbacksAfter: number; edges: number };
  defaults: { callbacksBefore: number; callbacksAfter: number; edges: number };
  copySameInstance: boolean; copyCoordinatesEqual: boolean;
  mutation: { callbacks: number; version: string };
  selectorMethods: string[]; dependencyMethods: string[];
}
async function runProbe(observe = true): Promise<ProbeReport> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-gradle-declarations-"))); dirs.push(dir);
  await writeFile(path.join(dir, "settings.gradle"), "rootProject.name = 'declaration-probe'\n");
  await writeFile(path.join(dir, "build.gradle"), `
repositories { maven { url = uri('repo') } }
configurations { sample { canBeResolved = true; canBeConsumed = false } }
def first = dependencies.create('review:sample:1')
def second = dependencies.create('review:sample:1')
ext.probeFirst = first
ext.probeSecond = second
configurations.sample.dependencies.add(first)
configurations.sample.dependencies.add(second)
ext.probeCopy = first.copy()
configurations {
    lazySample { canBeResolved = true; canBeConsumed = false }
    defaultSample { canBeResolved = true; canBeConsumed = false }
    mutableSample { canBeResolved = true; canBeConsumed = false }
}
ext.probeProviderRealized = false
configurations.lazySample.dependencies.addLater(providers.provider {
    project.ext.probeProviderRealized = true
    dependencies.create('review:sample:1')
})
configurations.defaultSample.defaultDependencies { set -> set.add(dependencies.create('review:sample:1')) }
def mutable = dependencies.create('review:sample:1')
configurations.mutableSample.dependencies.add(mutable)
mutable.version { require '2' }
`);
  const dest = path.join(dir, "repo/review/sample/1"); await mkdir(dest, { recursive: true });
  await writeFile(path.join(dest, "sample-1.pom"), '<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>sample</artifactId><version>1</version></project>');
  const result = await new Promise<{code: number; output: string}>(resolve => {
    execFile(binary!, ["-p", dir, "-I", probe, `-PprobeObserve=${observe}`, "osvMcpProbeDeclarations", "--offline", "--no-daemon", "--no-configuration-cache", "--console=plain"],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, env: process.env }, (error, stdout, stderr) =>
        resolve({ code: error ? typeof error.code === "number" ? error.code : -1 : 0, output: stdout + stderr }));
  });
  expect(result.code, result.output).toBe(0);
  const json = await readFile(path.join(dir, "declaration-probe.json"), "utf8");
  const report: ProbeReport = JSON.parse(json);
  const evidence = process.env.OSV_MCP_GRADLE_PROBE_OUTPUT;
  if (evidence) await writeFile(`${evidence}-${report.gradleVersion}-${observe ? "observed" : "baseline"}.json`, json);
  return report;
}

describe.skipIf(!binary)("Stage C public API feasibility", () => {
  let report: ProbeReport, baseline: ProbeReport;
  beforeAll(async () => { report = await runProbe(); baseline = await runProbe(false); }, 90_000);
  it("cannot count equal unregistered additions using collection callbacks", async () => {
    const result = report;
    expect(result.equalDeclarations).toBe(true);
    expect(result.sameInstance).toBe(false);
    expect(result.dependencies).toBe(1);
    expect(result.additionCallbacks).toBe(1);
    expect(result.rootEdges).toBe(1);
  });
  it("eager callback observation realizes providers earlier than the unobserved build", () => {
    expect(baseline.providerRealizedBefore).toBe(false);
    expect(baseline.providerRealizedAfter).toBe(true);
    expect(report.providerRealizedBefore).toBe(true);
    expect(report.lazy.callbacksBefore).toBeGreaterThan(0);
    expect(report.lazy.callbacksAfter).toBeGreaterThanOrEqual(report.lazy.callbacksBefore);
    expect(report.lazy.edges).toBe(1);
    expect(baseline.lazy.edges).toBe(report.lazy.edges);
    expect(report.defaults).toEqual({ callbacksBefore: 0, callbacksAfter: 1, edges: 1 });
  });
  it("a copied dependency retains coordinates but needs its own identity registration", () => {
    expect(report.copyCoordinatesEqual).toBe(true);
    expect(report.copySameInstance).toBe(false);
  });
  it("does not receive another addition event when the version is mutated", () => {
    expect(report.mutation).toEqual({ callbacks: 1, version: '2' });
  });
  it("lacks complete artifact and endorsement request data on the public selector", () => {
    expect(report.selectorMethods).toContain('getAttributes');
    expect(report.selectorMethods).toContain('getRequestedCapabilities');
    expect(report.selectorMethods).not.toContain('getArtifacts');
    expect(report.selectorMethods).not.toContain('isEndorsingStrictVersions');
    expect(report.dependencyMethods).toContain('getArtifacts');
    expect(report.dependencyMethods).toContain('isEndorsingStrictVersions');
  });
});
