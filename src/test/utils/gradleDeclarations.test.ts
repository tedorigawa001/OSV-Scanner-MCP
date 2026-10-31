import { mkdtemp, realpath, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { GradleGraphCache, sha256 } from "../../utils/gradleGraphCache.js";
import { declarationFixture, mixedTrustFixture, providerDeclarationFixture } from "../fixtures/gradleDeclarationsFixture.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const lock = "g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n";
async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-gradle-declarations-test-"))); dirs.push(dir);
  const data = declarationFixture(); data.graph.lockfiles[0]!.sha256 = sha256(lock);
  for (const [name, bytes] of Object.entries({ "gradle.lockfile": lock, "build.gradle": data.source,
    "osv-mcp-gradle-declarations.json": data.contract, "osv-mcp-gradle-dependencies.json": JSON.stringify(data.graph) })) await writeFile(path.join(dir, name), bytes);
  return { dir, ...data };
}
it("adopts complete physical declarations only with the consumer's explicit trust setting", async () => {
  const {dir} = await fixture();
  const accepted = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(accepted.lookup!("g:a", "1")).toMatchObject({ relation: "direct", declaredIn: new Set(["build.gradle"]), declaredInComplete: true });
  expect(accepted.lookup!("g:b", "2")).toMatchObject({ relation: "transitive", introducedBy: new Set(["g:a"]) });
  expect(accepted.metadata.declarations_complete).toBe(true);
  expect(accepted.metadata.declaration_provenance).toMatchObject({ trust_status: "accepted", assurance: "author-attested-and-structurally-checked" });
  const disabled = await new GradleGraphCache(dir, undefined, undefined).capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(disabled.lookup!("g:a", "1").declaredIn).toBeUndefined();
  expect(disabled.metadata.relations_complete).toBe(true);
});

it.each([
  ["unverified plugin source", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.records[0]!.source.kind="convention-plugin"; }],
  ["topology cycle", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.configurationTopology[1]!.extendsFrom=["runtimeClasspath"]; }],
  ["partial inventory", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.inventoryComplete=false; }],
  ["missing binding", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.bindings=[]; }],
  ["unbound extra attempt", (g: ReturnType<typeof declarationFixture>["graph"]) => { const d=g.contexts[0]!.declarations; d.records.push({...structuredClone(d.records[0]!),id:"d1"}); }],
  ["mutation", (g: ReturnType<typeof declarationFixture>["graph"]) => { const r=g.contexts[0]!.declarations.records[0]!; r.declarationAtResolve=structuredClone(r.declarationAtAdd); r.declarationAtResolve.key.versionConstraint.required="99"; }],
  ["nondefault shape", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.records[0]!.declarationAtAdd.shape.transitive=false; }],
  ["scope omission", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.configurationTopology[0]!.hasDependencies=true; }],
  ["orphan topology", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.configurationClosure.push("orphan"); }],
  ["other project record", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.declarations.records[0]!.ownerProjectId="other"; }],
  ["unverified source", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.inputs.files=g.inputs.files.filter(f=>f.path!=="build.gradle"); }],
  ["substitution", (g: ReturnType<typeof declarationFixture>["graph"]) => { g.contexts[0]!.edges[0]!.resolutionKey.group="other"; }],
])("withholds all declarations for %s without losing graph relations", async (_name, mutate) => {
  const {dir,graph}=await fixture(); mutate(graph);
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.relations_complete).toBe(true);
  expect(result.metadata.declarations_complete).toBe(false);
  expect(result.lookup!("g:a","1").declaredIn).toBeUndefined();
  expect(result.lookup!("g:b","2").introducedBy).toEqual(new Set(["g:a"]));
  expect(result.coverageReasons).toEqual([]);
});
it("validates every equal attempt rather than trusting a complete binding",async()=>{
  const {dir,graph}=await fixture();const d=graph.contexts[0]!.declarations;
  d.records.push({...structuredClone(d.records[0]!),id:"d1"});d.bindings[0]!.declarationIds.push("d1");
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.declarations_complete).toBe(true);
  expect(result.lookup!("g:a","1").declaredIn).toEqual(new Set(["build.gradle"]));
});
it.each(["source", "contract", "symlink"])("invalidates stale or unreadable graph inputs (%s)",async kind=>{
  const {dir}=await fixture();const name=kind==="contract"?"osv-mcp-gradle-declarations.json":"build.gradle";
  if(kind==="symlink") { await rm(path.join(dir,name));await symlink("gradle.lockfile",path.join(dir,name)); }
  else await writeFile(path.join(dir,name),"changed");
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.lookup!("g:a","1").relation).toBe("unknown");expect(result.coverageReasons).toEqual([]);
});
it("keeps relation budgets independent when the declaration budget is exhausted",async()=>{
  const {dir}=await fixture();
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1",{index:0,traversal:0}).capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.relations_complete).toBe(true);expect(result.metadata.declarations_complete).toBe(false);
  expect(result.metadata.reasons).toContain("declaration_budget_exceeded");
  expect(result.lookup!("g:b","2").introducedBy).toEqual(new Set(["g:a"]));
});
it("does not adopt unverifiable catalog contexts even with a trust setting",async()=>{
  const {dir,graph}=await fixture();graph.contexts[0]!.catalogInputs.inventoryComplete=false;
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.lookup!("g:a","1").relation).toBe("unknown");expect(result.coverageReasons).toEqual([]);
});
it("rejects duplicate-key author contracts without adopting declarations",async()=>{
  const {dir,graph,contract}=await fixture();const invalid=contract.replace('"contractVersion":1','"contractVersion":1,"contractVersion":1');
  await writeFile(path.join(dir,"osv-mcp-gradle-declarations.json"),invalid);
  graph.inputs.files.find(f=>f.path==="osv-mcp-gradle-declarations.json")!.sha256=sha256(invalid);
  graph.contexts[0]!.declarations.trust.contractSha256=sha256(invalid);
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.declarations_complete).toBe(false);expect(result.metadata.relations_complete).toBe(true);
});

it.each(["duplicate record", "unknown record", "duplicate reference", "unknown edge"])("rejects structurally invalid declaration references (%s)",async kind=>{
  const {dir,graph}=await fixture();const d=graph.contexts[0]!.declarations;
  if(kind==="duplicate record") d.records.push(structuredClone(d.records[0]!));
  else if(kind==="unknown record") d.bindings[0]!.declarationIds=["unknown"];
  else if(kind==="duplicate reference") d.bindings[0]!.declarationIds=["d0","d0"];
  else d.bindings[0]!.edgeId="unknown";
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.reasons).toContain("invalid_or_over_budget_metadata");expect(result.lookup!("g:a","1").relation).toBe("unknown");
});

it("does not merge source evidence across ambiguous selected variants",async()=>{
  const {dir,graph}=await fixture();const c=graph.contexts[0]!;
  c.variants.push({id:"a-other",componentId:"a"});
  c.edges.push({...structuredClone(c.edges[0]!),id:"other-edge",selectedVariant:"a-other"});
  c.declarations.bindings.push({edgeId:"other-edge",declarationIds:["d0"],complete:true,reasons:[]});
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  const result=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(result.metadata.relations_complete).toBe(true);expect(result.metadata.declarations_complete).toBe(false);
});

it.each([false, true])("keeps context trust and declaration adoption order-independent (same package=%s)", async samePackage => {
  const { dir } = await fixture();
  const data = mixedTrustFixture(samePackage);
  await writeFile(path.join(dir, "gradle.lockfile"), data.lock);
  await writeFile(path.join(dir, "osv-mcp-gradle-declarations.json"), data.contract);
  const results = [];
  for (const reverse of [false, true]) {
    const graph = { ...data.graph, contexts: reverse ? [...data.graph.contexts].reverse() : data.graph.contexts };
    await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
    const result = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(data.lock));
    expect(result.metadata.relations_complete).toBe(true);
    expect(result.metadata.declarations_complete).toBe(false);
    expect(result.metadata.declaration_provenance?.trust_status).toBe("invalid");
    expect(result.metadata.declaration_provenance?.assurance).toBeNull();
    expect(result.metadata.declaration_provenance?.contexts).toEqual([
      { configuration: "otherClasspath", trust_status: "invalid", assurance: null, contract_paths: [] },
      { configuration: "runtimeClasspath", trust_status: "accepted", assurance: "author-attested-and-structurally-checked", contract_paths: ["osv-mcp-gradle-declarations.json"] },
    ]);
    const info = result.lookup!("g:a", "1");
    expect(info.relation).toBe("direct");
    if (samePackage) {
      expect(info.declaredIn).toBeUndefined();
      expect(info.declaredInComplete).toBe(false);
    } else {
      expect(info.declaredIn).toEqual(new Set(["build.gradle"]));
      expect(info.declaredInComplete).toBe(true);
      expect(result.lookup!("g:b", "2").declaredIn).toBeUndefined();
    }
    results.push({ provenance: result.metadata.declaration_provenance, declaredIn: info.declaredIn ? [...info.declaredIn] : null });
  }
  expect(results[0]).toEqual(results[1]);
});


it.each(["accepted", "reobserved", "missing-policy", "unobserved", "unstable", "count-mismatch", "overflow", "at-add-forgery", "unknown-adapter", "sync-forgery"])("recomputes Provider completeness from static evidence (%s)", async kind => {
  const { dir } = await fixture();
  const data = providerDeclarationFixture(), d = data.graph.contexts[0]!.declarations, r = d.records[0]!;
  data.graph.lockfiles[0]!.sha256 = sha256(lock);
  if (kind === "missing-policy") {
    const author = JSON.parse(data.contract); delete author.scopes[0].providerPolicy;
    data.contract = JSON.stringify(author);
    data.graph.inputs.files.find(f => f.path === "osv-mcp-gradle-declarations.json")!.sha256 = sha256(data.contract);
    d.trust.contractSha256 = sha256(data.contract);
  }
  if (kind === "reobserved") { r.materializations.push(structuredClone(r.materializations[0]!)); r.callbackCount++; }
  if (kind === "unobserved") { r.callbackCount = 0; r.materializations = []; }
  if (kind === "unstable") { const other = structuredClone(r.materializations[0]!); other.key.versionConstraint.required = "99"; r.materializations.push(other); r.callbackCount++; }
  if (kind === "count-mismatch") r.callbackCount++;
  if (kind === "overflow") { r.callbackCount = 129; r.materializations = Array.from({ length: 128 }, () => structuredClone(r.materializations[0]!)); }
  if (kind === "at-add-forgery") r.declarationAtAdd = structuredClone(r.materializations[0]!);
  if (kind === "unknown-adapter") d.adapterVersion = 999;
  if (kind === "sync-forgery") { r.registrationKind = "synchronous"; r.declarationAtAdd = structuredClone(r.materializations[0]!); }
  await writeFile(path.join(dir, "osv-mcp-gradle-declarations.json"), data.contract);
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(data.graph));
  const result = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(result.metadata.relations_complete, JSON.stringify(result.metadata)).toBe(true);
  expect(result.lookup!("g:b", "2").introducedBy).toEqual(new Set(["g:a"]));
  expect(result.coverageReasons).toEqual([]);
  if (kind === "accepted" || kind === "reobserved") {
    expect(result.metadata.declarations_complete).toBe(true);
    expect(result.lookup!("g:a", "1").declaredIn).toEqual(new Set(["build.gradle"]));
    expect(result.metadata.declaration_provenance!.limitations).toEqual([
      "unregistered_equal_additions_not_detectable", "reverted_external_mutations_not_detectable",
      "provider_evaluations_outside_materialization_not_observable", "provider_stability_author_asserted",
    ]);
  } else {
    expect(result.metadata.declarations_complete).toBe(false);
    expect(result.lookup!("g:a", "1").declaredIn).toBeUndefined();
  }
});
