import { mkdtemp, realpath, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { GradleGraphCache, sha256, GRADLE_COMPANION } from "../../utils/gradleGraphCache.js";
import { graphFixture } from "../fixtures/gradleGraphFixture.js";
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
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
it('preserves core relations and coverage when v4 owned metadata is invalid',async()=>{
 const dir=await fixture(),core=await metadata(dir);
 const legacy=await new GradleGraphCache(dir).capture(path.join(dir,'gradle.lockfile'),bytes);
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify({schema:'osv-mcp.gradle-graph',schemaVersion:4,graphId:'g',exportId:'e',coreGraph:core,ownedOfferBundles:'invalid',ownedOfferObjects:[]}));
 const result=await new GradleGraphCache(dir).capture(path.join(dir,'gradle.lockfile'),bytes);
 expect(result.lookup!('g:a','1')).toEqual(legacy.lookup!('g:a','1'));expect(result.lookup!('g:b','2')).toEqual(legacy.lookup!('g:b','2'));
 expect(result.coverageReasons).toEqual(legacy.coverageReasons);expect(result.metadata.status).toBe(legacy.metadata.status);
});

import * as safeReader from '../../utils/safeRead.js';
import {ownedFixture} from '../fixtures/gradleOwnedFixture.js';
import {rewriteOwned} from '../fixtures/gradleOwnedFixture.js';
import {ownedDigest} from '../../utils/gradleOwnedJson.js';
it('G0 never opens an owned source or runtime artifact, even when current bytes differ',async()=>{
 const dir=await fixture(),doc=ownedFixture();doc.coreGraph.lockfiles[0].sha256=sha256(bytes);
 rewriteOwned(doc,()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedDigest(doc.coreGraph);if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(doc.coreGraph);});
 await mkdir(path.join(dir,'日本語 空白','%'),{recursive:true});await writeFile(path.join(dir,'日本語 空白','%','Driver.java'),'current bytes deliberately differ from the claim');
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify(doc));const spy=vi.spyOn(safeReader,'readRegularFile');
 const result=await new GradleGraphCache(dir).capture(path.join(dir,'gradle.lockfile'),bytes);
 expect(result.metadata.owned_manifest).toMatchObject({manifestStructure:'verified',currentContentMatch:'not_checked',ownedFileReads:0,diagnosticEligible:false});
 expect(spy.mock.calls.map(c=>path.relative(dir,c[0]))).toEqual([GRADLE_COMPANION,'osv-mcp-gradle-declarations.json']);
});

it('keeps the 16 MiB limit for non-wrapper companions and refunds the scan budget',async()=>{
 const dir=await fixture(),core=await metadata(dir);
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify({...core,pad:'x'.repeat(16*1024*1024)}));
 const cache=new GradleGraphCache(dir),result=await cache.capture(path.join(dir,'gradle.lockfile'),bytes);
 expect(result.metadata.reasons).toContain('metadata_too_large');expect((cache as any).remaining).toBe(64*1024*1024);
});
it('reports a schemaVersion 4 document without the wrapper shape as invalid_graph_wrapper',async()=>{
 const dir=await fixture(),core=await metadata(dir);
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify({...core,schemaVersion:4}));
 const result=await new GradleGraphCache(dir).capture(path.join(dir,'gradle.lockfile'),bytes);
 expect(result.metadata.reasons).toContain('invalid_graph_wrapper');expect(result.metadata.reasons).not.toContain('unsupported_schema_version');
});
it('still reports a later exporter schema version as unsupported',async()=>{
 const dir=await fixture(),core=await metadata(dir);
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify({...core,schemaVersion:5}));
 const result=await new GradleGraphCache(dir).capture(path.join(dir,'gradle.lockfile'),bytes);
 expect(result.metadata.reasons).toContain('unsupported_schema_version');
});
import {exportFields} from '../../utils/gradleExportJson.js';
it('rejects unknown root tokens instead of slicing them as values',()=>{
 for(const text of ['{"a":foo}','{"a":"x","b":@}','{"a":"\\q"}'])expect(()=>exportFields(text)).toThrow('invalid_graph_wrapper');
 expect(exportFields('{"a":1,"b":{"c":[true,null]}}').get('b')).toBe('{"c":[true,null]}');
});

import {parseOwnedSettings,emptyOwnedRegistry} from '../../utils/gradleOwnedPolicy.js';
for(const trust of [undefined,'invalid','owned-bta-offered-inputs-v1'])it('G1 preserves core results and does not open owned inputs: '+trust,async()=>{
 const dir=await fixture(),doc=ownedFixture();doc.coreGraph.lockfiles[0].sha256=sha256(bytes);
 rewriteOwned(doc,()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedDigest(doc.coreGraph);if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(doc.coreGraph);});
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify(doc.coreGraph));
 const legacy=await new GradleGraphCache(dir).capture(path.join(dir,'gradle.lockfile'),bytes);
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify(doc));const spy=vi.spyOn(safeReader,'readRegularFile');
 const policy={settings:parseOwnedSettings(trust),registry:emptyOwnedRegistry};
 const result=await new GradleGraphCache(dir,undefined,undefined,undefined,undefined,undefined,policy).capture(path.join(dir,'gradle.lockfile'),bytes);
 expect(result.metadata.owned_manifest?.reasons).toEqual(['owned_manifest_'+(!trust?'trust_disabled':trust==='invalid'?'configuration_invalid':'profile_unapproved')]);
 expect(result.lookup!('g:a','1')).toEqual(legacy.lookup!('g:a','1'));expect(result.lookup!('g:b','2')).toEqual(legacy.lookup!('g:b','2'));expect(result.coverageReasons).toEqual(legacy.coverageReasons);expect(result.metadata.status).toBe(legacy.metadata.status);
 expect(spy.mock.calls.map(c=>path.relative(dir,c[0]))).toEqual([GRADLE_COMPANION,'osv-mcp-gradle-declarations.json']);
});

import {ownedExecutionCase} from '../fixtures/gradleOwnedExecutionFixture.js';
it('rechecks G2 lookup on repeated capture without reopening owned files or reusing a verified verdict',async()=>{
 const dir=await fixture(),f=ownedExecutionCase('completed','offer',undefined,undefined,sha256(bytes));
 await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify(f.doc));let calls=0;const lookup=f.caller.lookup;f.caller.lookup=(r:any)=>{calls++;return lookup(r);};
 const spy=vi.spyOn(safeReader,'readRegularFile');
 const cache=new GradleGraphCache(dir,undefined,undefined,undefined,undefined,undefined,f.policy,f.caller);
 const first=await cache.capture(path.join(dir,'gradle.lockfile'),bytes);expect(first.metadata.owned_manifest).toMatchObject({executionWitness:'verified',ownedFileReads:0,diagnosticEligible:false});
 f.caller.lookup=()=>{calls++;return {status:'unavailable',reason:'receipt-missing'};};
 const second=await cache.capture(path.join(dir,'gradle.lockfile'),bytes);expect(second.metadata.owned_manifest).toMatchObject({executionWitness:'unavailable',reasons:['owned_manifest_witness_unavailable'],ownedFileReads:0});expect(calls).toBe(2);
 expect(second.lookup!('g:a','1')).toEqual(first.lookup!('g:a','1'));expect(second.lookup!('g:b','2')).toEqual(first.lookup!('g:b','2'));expect(second.coverageReasons).toEqual(first.coverageReasons);
 expect(spy.mock.calls.map(c=>path.relative(dir,c[0]))).toEqual([GRADLE_COMPANION,'osv-mcp-gradle-declarations.json']);
});
for(const status of ['revoked','superseded'])it('does not retain G2 verification after current session becomes '+status,async()=>{
 const dir=await fixture(),f=ownedExecutionCase('completed','offer',undefined,undefined,sha256(bytes));await writeFile(path.join(dir,GRADLE_COMPANION),JSON.stringify(f.doc));
 const cache=new GradleGraphCache(dir,undefined,undefined,undefined,undefined,undefined,f.policy,f.caller);
 expect((await cache.capture(path.join(dir,'gradle.lockfile'),bytes)).metadata.owned_manifest?.executionWitness).toBe('verified');f.session.status=status;
 expect((await cache.capture(path.join(dir,'gradle.lockfile'),bytes)).metadata.owned_manifest).toMatchObject({executionWitness:'unavailable',reasons:['owned_manifest_witness_unavailable']});
});
