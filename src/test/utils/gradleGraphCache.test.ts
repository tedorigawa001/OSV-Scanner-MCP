import { mkdtemp, realpath, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it, expect } from "vitest";
import { GradleGraphCache, sha256, GRADLE_COMPANION } from "../../utils/gradleGraphCache.js";
import { graphFixture } from "../fixtures/gradleGraphFixture.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() { const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gradle-cache-test-"))); dirs.push(dir); return dir; }
const bytes = Buffer.from("g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n");
async function metadata(dir: string) { const graph = graphFixture(); graph.lockfiles[0]!.sha256 = sha256(bytes); await writeFile(path.join(dir, GRADLE_COMPANION), JSON.stringify(graph)); return graph; }
it("does not follow symlink metadata or read metadata outside the selected child boundary", async () => {
  const dir = await fixture(), outside = await fixture(); await metadata(outside);
  await symlink(path.join(outside, GRADLE_COMPANION), path.join(dir, GRADLE_COMPANION));
  const result = await new GradleGraphCache(dir).capture(path.join(dir, "gradle.lockfile"), bytes);
  expect(result.metadata.status).toBe("unavailable"); expect(result.coverageReasons).toEqual([]);
  await rm(path.join(dir, GRADLE_COMPANION)); await metadata(dir);
  await mkdir(path.join(dir, "child"));
  const child = await new GradleGraphCache(path.join(dir, "child")).capture(path.join(dir, "child", "gradle.lockfile"), bytes);
  expect(child.metadata.status).toBe("unavailable");
});
it("a missing configuration suppresses transitive origins while retaining direct evidence", async () => {
  const dir = await fixture(); const graph = await metadata(dir);
  const twoConfigs = Buffer.from(bytes.toString().replaceAll("runtimeClasspath", "runtimeClasspath,testRuntimeClasspath"));
  graph.lockfiles[0]!.sha256 = sha256(twoConfigs); await writeFile(path.join(dir, GRADLE_COMPANION), JSON.stringify(graph));
  const result = await new GradleGraphCache(dir).capture(path.join(dir, "gradle.lockfile"), twoConfigs);
  expect(result.metadata.status).toBe("partial");
  expect(result.lookup!("g:a", "1")).toMatchObject({ relation: "direct", introducedByComplete: false });
  expect(result.lookup!("g:b", "2")).toMatchObject({ relation: "unknown", introducedByComplete: false });
  expect(result.lookup!("g:b", "2").introducedBy).toBeUndefined(); expect(result.coverageReasons).toEqual([]);
});
it("work exhaustion suppresses relations without inventing coverage gaps", async () => {
  const dir = await fixture(); await metadata(dir);
  const result = await new GradleGraphCache(dir, { index: 1000, traversal: 0 }).capture(path.join(dir, "gradle.lockfile"), bytes);
  expect(result.metadata.reasons).toContain("relationship_budget_exceeded"); expect(result.coverageReasons).toEqual([]);
});

it("retains a valid context's scope gap when another context has an invalid project mapping", async () => {
  const dir = await fixture(), graph: any = await metadata(dir);
  const bad = structuredClone(graph.contexts[0]); bad.id = "bad"; bad.projectId = "other";
  bad.configuration = bad.lockConfiguration = "otherClasspath"; bad.components[0].projectId = "other";
  graph.projects.push({ id: "other", buildId: "main", projectPath: ":other", directory: "other", ownerBuildFile: "other/build.gradle" });
  graph.contexts.push(bad);
  const locked = Buffer.from("g:a:1=runtimeClasspath\n"); graph.lockfiles[0].sha256 = sha256(locked);
  await writeFile(path.join(dir, GRADLE_COMPANION), JSON.stringify(graph));
  const result = await new GradleGraphCache(dir).capture(path.join(dir, "gradle.lockfile"), locked);
  expect(result.metadata.reasons).toContain("invalid_context_mapping");
  expect(result.coverageReasons).toContain("graph_modules_missing_from_lock");
});
it("treats creation of an input recorded as absent as stale metadata", async () => {
  const dir = await fixture(); const graph: any = await metadata(dir);
  graph.inputs.files.push({ path: "build.gradle.kts", absent: true });
  await writeFile(path.join(dir, GRADLE_COMPANION), JSON.stringify(graph));
  const fresh = await new GradleGraphCache(dir).capture(path.join(dir, "gradle.lockfile"), bytes);
  expect(fresh.metadata.status).toBe("complete");
  await writeFile(path.join(dir, "build.gradle.kts"), "dependencies {}\n");
  const stale = await new GradleGraphCache(dir).capture(path.join(dir, "gradle.lockfile"), bytes);
  expect(stale.metadata.reasons).toContain("stale_input_hash");
  expect(stale.lookup!("g:b", "2").relation).toBe("unknown");
});
