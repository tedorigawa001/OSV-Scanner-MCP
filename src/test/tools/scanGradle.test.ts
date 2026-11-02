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
import { syntheticGradleGraph, syntheticGradleTrees } from "../fixtures/gradleSyntheticGraph.js";
import { declarationFixture, mixedTrustFixture } from "../fixtures/gradleDeclarationsFixture.js";
import { graphFixture } from "../fixtures/gradleGraphFixture.js";
import { resetDeclarationTrustForTests } from "../../utils/gradleDeclarations.js";
vi.mock("../../osv/runner.js", async original => ({ ...await original<object>(), runOsvScan: vi.fn() }));
let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); vi.resetAllMocks(); vi.unstubAllEnvs(); resetDeclarationTrustForTests(); });
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

it("omits a partial origin when a project dependency also reaches the module in all three tools", async () => {
  const graph = await fixture(), c = graph.contexts[0]!;
  graph.projects.push({ id: "main::lib", buildId: "main", projectPath: ":lib", directory: "lib", ownerBuildFile: "lib/build.gradle" });
  c.components.push({ id: "lib", kind: "project", projectId: "main::lib" });
  c.variants.push({ id: "lib-v", componentId: "lib" });
  c.edges.push({ fromVariant: "root-v", selectedVariant: "lib-v", constraint: false, requested: { kind: "project", projectPath: ":lib" } as never },
    { fromVariant: "lib-v", selectedVariant: "b-v", constraint: false, requested: { kind: "module", group: "g", name: "b", selector: "2" } });
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const payload = JSON.parse((await handler({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
    const b = (payload.packages ?? payload.suggestions).find((p: any) => (p.name ?? p.package) === "g:b");
    expect(b.dependency_relation).toBe("transitive");
    expect(b.introduced_by).toBeUndefined();
    if (payload.suggestions) expect(b.update_hint).not.toContain("g:a");
  }
});

it("all three tools retain capped complete origins over multiple large contexts", async () => {
  await fixture(); const { graph, lockText } = syntheticGradleGraph(200, 1200);
  await writeFile(path.join(dir, "gradle.lockfile"), lockText);
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
  vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: [{
    source: { path: targets[0]!.path, type: "lockfile" }, packages: [{ package: { name: "g:p1199", version: "1", ecosystem: "Maven" }, groups: [{ ids: ["GHSA-test"], max_severity: "7.5" }] }],
  }] }));
  const expected = Array.from({ length: 200 }, (_, i) => `g:p${i}`).sort().slice(0, 10);
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
    expect(result.isError).toBeUndefined(); const p = JSON.parse(result.content[0]!.text), pkg = (p.packages ?? p.suggestions)[0];
    expect(p.coverage.complete).toBe(true); expect(p.coverage.dependency_metadata.gradle[0].relations_complete).toBe(true);
    expect(pkg.dependency_relation).toBe("transitive"); expect(pkg.introduced_by).toEqual(expected); expect(pkg.introduced_by_omitted).toBe(190);
  }
});

it("all three tools retain origins across 24 sparse-sharing contexts in three documents", async () => {
  await fixture();
  await rm(path.join(dir, "gradle.lockfile")); await rm(path.join(dir, "osv-mcp-gradle-dependencies.json"));
  const { graph, lockText } = syntheticGradleTrees(400, 6000, 8, true);
  for (let i = 0; i < 3; i++) {
    const project = path.join(dir, `project${i}`); await mkdir(project);
    await writeFile(path.join(project, "gradle.lockfile"), lockText);
    await writeFile(path.join(project, "osv-mcp-gradle-dependencies.json"), JSON.stringify(graph));
  }
  vi.mocked(runOsvScan).mockImplementation(async targets => parseOsvScanOutput({ results: targets.map(target => ({
    source: { path: target.path, type: "lockfile" }, packages: [{ package: { name: "g:p5999", version: "1", ecosystem: "Maven" }, groups: [{ ids: ["GHSA-test"], max_severity: "7.5" }] }],
  })) }));
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
    expect(result.isError).toBeUndefined(); const p = JSON.parse(result.content[0]!.text), pkg = (p.packages ?? p.suggestions)[0];
    expect(p.coverage.complete).toBe(true);
    expect(p.coverage.dependency_metadata.gradle).toHaveLength(3);
    expect(p.coverage.dependency_metadata.gradle.every((m: any) => m.relations_complete)).toBe(true);
    expect(pkg.dependency_relation).toBe("transitive"); expect(pkg.introduced_by).toEqual(["g:p399"]);
  }
});

it("keeps lock scanning and reports a newer metadata version as unsupported in all three tools", async () => {
  const graph = await fixture();
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), JSON.stringify({ ...graph, schemaVersion: 5 }));
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const payload = JSON.parse((await handler({ project_path: dir }, { candidateCheck: "disabled" })).content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    const metadata = payload.coverage.dependency_metadata.gradle[0];
    expect(metadata.status).toBe("unavailable");
    expect(metadata.reasons).toContain("unsupported_schema_version");
    expect(metadata.reasons).not.toContain("invalid_or_over_budget_metadata");
    const packages = payload.packages ?? payload.suggestions;
    expect(packages.map((p: any) => p.dependency_relation)).toEqual(["unknown", "unknown"]);
  }
});

async function registeredFixture() {
  await fixture(); const d=declarationFixture(); d.graph.lockfiles[0]!.sha256=sha256(lock);
  await writeFile(path.join(dir,"build.gradle"),d.source);
  await writeFile(path.join(dir,"osv-mcp-gradle-declarations.json"),d.contract);
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(d.graph));
  return d;
}
it("all three tools expose trusted declarations and their assurance without adding source files to OSV inputs",async()=>{
  await registeredFixture();
  for(const handler of [handleScanProject,handleScanJavaProject,handleSuggestFix]) {
    vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST","registered-helper-v1");
    const payload=JSON.parse((await handler({project_path:dir},{candidateCheck:"disabled"})).content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    const a=(payload.packages??payload.suggestions).find((p:any)=>(p.name??p.package)==="g:a");
    expect(a.declared_in).toEqual(["build.gradle"]);
    const metadata=payload.coverage.dependency_metadata.gradle[0];
    expect(metadata.declarations_complete).toBe(true);
    expect(metadata.declaration_provenance.trust_status).toBe("accepted");
    expect(metadata.declaration_provenance.limitations).toContain("unregistered_equal_additions_not_detectable");
    if(payload.suggestions) expect(a.update_hint).toContain("build.gradle");
  }
});
it("all tools suppress partial declarations across locks in both source orders",async()=>{
  await registeredFixture();vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST","registered-helper-v1");
  await mkdir(path.join(dir,"child"));await writeFile(path.join(dir,"child/gradle.lockfile"),lock);
  for(const reverse of [false,true]) {
    vi.mocked(runOsvScan).mockImplementation(async targets=>parseOsvScanOutput({results:(reverse?[...targets].reverse():targets).map(t=>({
      source:{path:t.path,type:"lockfile"},packages:[{package:{name:"g:a",version:"1",ecosystem:"Maven"},groups:[{ids:["GHSA-test"],max_severity:"7.5"}]}],
    }))}));
    for(const handler of [handleScanProject,handleScanJavaProject,handleSuggestFix]) {
      const payload=JSON.parse((await handler({project_path:dir},{candidateCheck:"disabled"})).content[0]!.text);
      expect((payload.packages??payload.suggestions)[0].declared_in).toBeUndefined();
      expect(payload.coverage.complete).toBe(true);
    }
  }
});
it("snapshots the declaration trust setting before scanner execution",async()=>{
  await registeredFixture();vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST","registered-helper-v1");
  const runner=vi.mocked(runOsvScan).getMockImplementation()!;
  vi.mocked(runOsvScan).mockImplementation(async(targets,options)=>{vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST","invalid");return runner(targets,options);});
  const payload=JSON.parse((await handleScanProject({project_path:dir})).content[0]!.text);
  expect(payload.packages.find((p:any)=>p.name==="g:a").declared_in).toEqual(["build.gradle"]);
});

it("converts companion-root declaration paths to scan-root paths for child locks",async()=>{
  const {graph,source,contract}=await registeredFixture();vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST","registered-helper-v1");
  await mkdir(path.join(dir,"child"));await mkdir(path.join(dir,"gradle"));
  await rm(path.join(dir,"gradle.lockfile"));await rm(path.join(dir,"build.gradle"));
  await writeFile(path.join(dir,"child/gradle.lockfile"),lock);await writeFile(path.join(dir,"gradle/deps.gradle"),source);
  graph.lockfiles[0]!.path="child/gradle.lockfile";graph.projects[0]!.directory="child";graph.projects[0]!.projectPath=":child";
  const author=JSON.parse(contract);author.sources=["gradle/deps.gradle"];author.scopes[0].projectPath=":child";
  const text=JSON.stringify(author);await writeFile(path.join(dir,"osv-mcp-gradle-declarations.json"),text);
  graph.inputs.files.find(f=>f.path==="osv-mcp-gradle-declarations.json")!.sha256=sha256(text);
  graph.inputs.files.find(f=>f.path==="build.gradle")!.path="gradle/deps.gradle";
  graph.contexts[0]!.declarations.trust.contractSha256=sha256(text);
  graph.contexts[0]!.declarations.records[0]!.source.path="gradle/deps.gradle";
  graph.contexts[0]!.declarations.records[0]!.source.kind="applied-script";
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify(graph));
  for(const handler of [handleScanProject,handleScanJavaProject,handleSuggestFix]) {
    const payload=JSON.parse((await handler({project_path:dir},{candidateCheck:"disabled"})).content[0]!.text);
    const a=(payload.packages??payload.suggestions).find((p:any)=>(p.name??p.package)==="g:a");
    expect(a.declared_in).toEqual(["gradle/deps.gradle"]);
  }
});

it.each([false,true])("all tools keep context trust and adopted paths stable across context order (same package=%s)",async samePackage=>{
  await fixture();vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST","registered-helper-v1");
  const data=mixedTrustFixture(samePackage);
  await writeFile(path.join(dir,"gradle.lockfile"),data.lock);
  await writeFile(path.join(dir,"build.gradle"),data.source);
  await writeFile(path.join(dir,"osv-mcp-gradle-declarations.json"),data.contract);
  vi.mocked(runOsvScan).mockImplementation(async targets=>parseOsvScanOutput({results:[{
    source:{path:targets[0]!.path,type:"lockfile"},packages:[{package:{name:"g:a",version:"1",ecosystem:"Maven"},groups:[{ids:["GHSA-test"],max_severity:"7.5"}]}],
  }]}));
  for(const handler of [handleScanProject,handleScanJavaProject,handleSuggestFix]) {
    const results=[];
    for(const reverse of [false,true]) {
      await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),JSON.stringify({...data.graph,contexts:reverse?[...data.graph.contexts].reverse():data.graph.contexts}));
      const payload=JSON.parse((await handler({project_path:dir},{candidateCheck:"disabled"})).content[0]!.text);
      const pkg=(payload.packages??payload.suggestions)[0];
      const metadata=payload.coverage.dependency_metadata.gradle[0];
      expect(payload.coverage.complete).toBe(true);
      expect(metadata.relations_complete).toBe(true);
      expect(metadata.declarations_complete).toBe(false);
      expect(metadata.declaration_provenance.trust_status).toBe("invalid");
      expect(metadata.declaration_provenance.contexts).toEqual(expect.arrayContaining([expect.objectContaining({configuration:"runtimeClasspath",trust_status:"accepted"})]));
      expect(pkg.declared_in).toEqual(samePackage?undefined:["build.gradle"]);
      results.push({declaredIn:pkg.declared_in,provenance:metadata.declaration_provenance});
    }
    expect(results[0]).toEqual(results[1]);
  }
});

it("an unknown trust setting disables only declaration sources and is reported in all three tools", async () => {
  await registeredFixture(); vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST", "registered-helper-V1");
  for (const handler of [handleScanProject, handleScanJavaProject, handleSuggestFix]) {
    const result = await handler({ project_path: dir }, { candidateCheck: "disabled" });
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.coverage.complete).toBe(true);
    const packages = payload.packages ?? payload.suggestions;
    const a = packages.find((p: any) => (p.name ?? p.package) === "g:a"), b = packages.find((p: any) => (p.name ?? p.package) === "g:b");
    expect(a).toMatchObject({ dependency_relation: "direct" }); expect(a.declared_in).toBeUndefined();
    expect(b).toMatchObject({ dependency_relation: "transitive", introduced_by: ["g:a"] });
    const metadata = payload.coverage.dependency_metadata.gradle[0];
    expect(metadata.reasons).toContain("declaration_trust_config_invalid");
    expect(metadata.declaration_provenance.trust_status).toBe("disabled");
    expect(metadata.declarations_complete).toBe(false);
  }
});
it("reads the trust setting once; later environment changes are ignored", async () => {
  await registeredFixture(); vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST", "registered-helper-v1");
  const first = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
  expect(first.packages.find((p: any) => p.name === "g:a").declared_in).toEqual(["build.gradle"]);
  for (const value of ["", "invalid"]) {
    vi.stubEnv("OSV_MCP_GRADLE_DECLARATION_TRUST", value);
    const later = JSON.parse((await handleScanProject({ project_path: dir })).content[0]!.text);
    expect(later.packages.find((p: any) => p.name === "g:a").declared_in).toEqual(["build.gradle"]);
  }
});

it.each(['valid-g0','invalid-owned'])('all three tools preserve trusted core results with v4 %s',async kind=>{
 const {ownedFixture,rewriteOwned}=await import('../fixtures/gradleOwnedFixture.js');
 const {ownedDigest}=await import('../../utils/gradleOwnedJson.js');
 const d=await registeredFixture();vi.stubEnv('OSV_MCP_GRADLE_DECLARATION_TRUST','registered-helper-v1');
 const handlers=[handleScanProject,handleScanJavaProject,handleSuggestFix],before=[];
 for(const handler of handlers)before.push(JSON.parse((await handler({project_path:dir},{candidateCheck:'disabled'})).content[0]!.text));
 const wrapper=ownedFixture();wrapper.coreGraph=d.graph;rewriteOwned(wrapper,()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedDigest(d.graph);if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(d.graph);});
 if(kind==='invalid-owned')wrapper.ownedOfferObjects=false;
 await writeFile(path.join(dir,'osv-mcp-gradle-dependencies.json'),JSON.stringify(wrapper));
 for(const [i,handler]of handlers.entries()){
  const after=JSON.parse((await handler({project_path:dir},{candidateCheck:'disabled'})).content[0]!.text);
  expect(after.packages??after.suggestions).toEqual(before[i].packages??before[i].suggestions);expect(after.coverage.complete).toBe(before[i].coverage.complete);
  const metadata=after.coverage.dependency_metadata.gradle[0];expect(metadata.declaration_provenance).toEqual(before[i].coverage.dependency_metadata.gradle[0].declaration_provenance);expect(metadata.declarations_complete).toBe(true);
  expect(metadata.owned_manifest).toMatchObject({diagnosticEligible:false,currentContentMatch:'not_checked',ownedFileReads:0,manifestStructure:kind==='valid-g0'?'verified':'invalid'});
 }
});
