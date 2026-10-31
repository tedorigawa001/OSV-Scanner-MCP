/** Production adapter + exporter + static reader, offline with real Gradle. */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { GradleGraphCache } from "../../utils/gradleGraphCache.js";
import { knownDeclarations } from "../../utils/gradleDeclarations.js";
import { parseGradleGraph } from "../../utils/gradleGraph.js";
const binary=process.env.OSV_MCP_TEST_GRADLE;
const adapter=fileURLToPath(new URL("../../../gradle/register-declarations.init.gradle", import.meta.url));
const exporter=fileURLToPath(new URL("../../../gradle/export-dependency-graph.init.gradle", import.meta.url));
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
const configurations=["compileClasspath","runtimeClasspath","testCompileClasspath","testRuntimeClasspath"];
const lock=`review:parent:1=${configurations.join(",")}\nreview:leaf:1=${configurations.join(",")}\n`;
async function run(dir:string, flags:string[]=[]) {
  return new Promise<{code:number;output:string}>(resolve=>execFile(binary!,["-p",dir,"-I",adapter,"-I",exporter,
    "-PosvMcpDeclarationContract=osv-mcp-gradle-declarations.json","osvMcpExportDependencies","--offline","--no-daemon","--no-configuration-cache","--console=plain","--stacktrace",...flags],
    {timeout:120_000,maxBuffer:2*1024*1024,env:process.env},(e,out,err)=>resolve({code:e?typeof e.code==="number"?e.code:-1:0,output:out+err})));
}
async function fixture(kotlin:boolean, mutation=false) {
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),"osv-registered-gradle-")));dirs.push(dir);
  const suffix=kotlin?".gradle.kts":".gradle";
  await writeFile(path.join(dir,"settings.gradle"),"rootProject.name='registered'\n");
  const build=kotlin?`
import org.gradle.kotlin.dsl.withGroovyBuilder
plugins { java }
repositories { maven { url=uri("repo") } }
val helper=extensions.getByName("osvMcpDeclarations")
val source=helper.withGroovyBuilder { "source"("build${suffix}") }
helper.withGroovyBuilder { "add"("implementation","review:parent:1",source) }
apply(from="extra${suffix}")
`:`
plugins { id 'java' }
repositories { maven { url=uri('repo') } }
def helper=extensions.getByName('osvMcpDeclarations')
def source=helper.source('build${suffix}')
helper.add('implementation','review:parent:1',source)
apply from: 'extra${suffix}'
`;
  let extra=kotlin?`import org.gradle.kotlin.dsl.withGroovyBuilder
val helper=extensions.getByName("osvMcpDeclarations")
val source=helper.withGroovyBuilder { "source"("extra${suffix}","applied-script") }
helper.withGroovyBuilder { "add"("implementation","review:parent:1",source) }
`:`def helper=extensions.getByName('osvMcpDeclarations')
helper.add('implementation','review:parent:1',helper.source('extra${suffix}','applied-script'))
`;
  if(mutation) extra+=`file("build${suffix}").${kotlin?"appendText":"append"}(${JSON.stringify("\n// mutation\n")})\n`;
  await writeFile(path.join(dir,`build${suffix}`),build);await writeFile(path.join(dir,`extra${suffix}`),extra);
  await writeFile(path.join(dir,"gradle.lockfile"),lock);
  await writeFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),'{}');
  await writeFile(path.join(dir,"osv-mcp-gradle-declarations.json"),JSON.stringify({contractVersion:1,trustModel:"registered-helper-v1",catalogPolicy:"none",
    sources:[`build${suffix}`,`extra${suffix}`],scopes:configurations.map(name=>({id:name,projectPath:":",resolvableConfiguration:name,
      declarationConfigurations:["implementation"],assertion:"all-contributing-additions-use-helper",mutationPolicy:"immutable-after-add"}))}));
  for(const name of ["parent","leaf"]) {
    const dest=path.join(dir,"repo/review",name,"1");await mkdir(dest,{recursive:true});
    const deps=name==="parent"?"<dependencies><dependency><groupId>review</groupId><artifactId>leaf</artifactId><version>1</version></dependency></dependencies>":"";
    await writeFile(path.join(dest,`${name}-1.pom`),`<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>${name}</artifactId><version>1</version>${deps}</project>`);
  }
  return dir;
}
it.skipIf(!binary).each([false,true])("exports and statically verifies real C1a declarations (Kotlin=%s)",async kotlin=>{
  const dir=await fixture(kotlin),result=await run(dir);expect(result.code,result.output).toBe(0);
  const graph=parseGradleGraph(await readFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),"utf8"));
  expect(graph.schemaVersion).toBe(2);
  const c=graph.contexts.find(c=>c.configuration==="runtimeClasspath")!;
  expect(knownDeclarations(c)?.inventoryComplete).toBe(true);
  const accepted=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(accepted.metadata.reasons).not.toContain("invalid_or_over_budget_metadata");
  expect(accepted.metadata.declarations_complete,JSON.stringify(accepted.metadata)).toBe(true);
  expect(accepted.lookup!("review:parent","1").declaredIn).toEqual(new Set([`build.gradle${kotlin?".kts":""}`,`extra.gradle${kotlin?".kts":""}`]));
  expect(accepted.lookup!("review:leaf","1")).toMatchObject({relation:"transitive",introducedBy:new Set(["review:parent"])});
  const disabled=await new GradleGraphCache(dir,undefined,undefined).capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(disabled.lookup!("review:parent","1").declaredIn).toBeUndefined();
  const v1=await run(dir,["-PosvMcpSchemaVersion=1"]);expect(v1.code,v1.output).toBe(0);
  expect(parseGradleGraph(await readFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),"utf8")).schemaVersion).toBe(1);
},150_000);
it.skipIf(!binary)("rejects applied-script input mutation without overwriting the companion",async()=>{
  const dir=await fixture(false,true),result=await run(dir);
  expect(result.code).not.toBe(0);expect(result.output).toContain("Build input changed during OSV graph export");
  expect(await readFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),"utf8")).toBe('{}');
},150_000);

it.skipIf(!binary).each(["unregistered","mutation","provider"])("keeps graph information but withholds declarations for %s",async kind=>{
  const dir=await fixture(false);
  const addition=kind==="unregistered"?"dependencies.add('implementation','review:leaf:1')":kind==="mutation"?
    "configurations.implementation.dependencies.first().exclude(group:'unused',module:'unused')":
    "def evaluated=false\ndef p=providers.provider { evaluated=true; dependencies.create('review:leaf:1') }\nhelper.add('implementation',p,helper.source('extra.gradle','applied-script'))\nif(evaluated) throw new GradleException('Provider realized by registration')";
  const extra=path.join(dir,"extra.gradle");await writeFile(extra,await readFile(extra,"utf8")+addition+"\n");
  const result=await run(dir);expect(result.code,result.output).toBe(0);
  const captured=await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(captured.metadata.relations_complete,JSON.stringify(captured.metadata)).toBe(true);
  expect(captured.metadata.declarations_complete).toBe(false);
  expect(captured.lookup!("review:parent","1").relation).toBe("direct");
  expect(captured.lookup!("review:parent","1").declaredIn).toBeUndefined();
},150_000);

it.skipIf(!binary).each([false,true])("retains equal declarations inherited from different configurations (Kotlin=%s)", async kotlin => {
  const dir = await fixture(kotlin), suffix = kotlin ? ".gradle.kts" : ".gradle";
  const file = path.join(dir, `extra${suffix}`);
  await writeFile(file, (await readFile(file, "utf8")).replace('"implementation"', '"runtimeOnly"').replace("'implementation'", "'runtimeOnly'"));
  const authorFile = path.join(dir, "osv-mcp-gradle-declarations.json");
  const author = JSON.parse(await readFile(authorFile, "utf8"));
  for (const scope of author.scopes) scope.declarationConfigurations.push("runtimeOnly");
  await writeFile(authorFile, JSON.stringify(author));
  const result = await run(dir); expect(result.code, result.output).toBe(0);
  const graph = parseGradleGraph(await readFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),"utf8"));
  const d = knownDeclarations(graph.contexts.find(c => c.configuration === "runtimeClasspath")!)!;
  expect(d.inventoryComplete, JSON.stringify(d.reasons)).toBe(true);
  expect(d.records.map(r => r.configuration).sort()).toEqual(["implementation", "runtimeOnly"]);
  expect(d.bindings[0]!.declarationIds).toHaveLength(2);
  const captured = await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(captured.metadata.declarations_complete, JSON.stringify(captured.metadata)).toBe(true);
  expect(captured.lookup!("review:parent","1").declaredIn).toEqual(new Set([`build${suffix}`,`extra${suffix}`]));
},150_000);
it.skipIf(!binary).each([false,true])("detects an unregistered equal dependency in another configuration (Kotlin=%s)", async kotlin => {
  const dir = await fixture(kotlin), suffix = kotlin ? ".gradle.kts" : ".gradle";
  const file = path.join(dir,`extra${suffix}`);
  // Put the registered configuration first: the aggregate set then hides the
  // equal unregistered instance, which must still be found in its own collection.
  await writeFile(file, kotlin ? 'dependencies.add("runtimeOnly", "review:parent:1")\nconfigurations["runtimeClasspath"].setExtendsFrom(listOf(configurations["implementation"], configurations["runtimeOnly"]))\n' : "dependencies.add('runtimeOnly', 'review:parent:1')\nconfigurations.runtimeClasspath.setExtendsFrom([configurations.implementation, configurations.runtimeOnly])\n");
  const authorFile = path.join(dir,"osv-mcp-gradle-declarations.json");
  const author = JSON.parse(await readFile(authorFile,"utf8"));
  for(const scope of author.scopes) scope.declarationConfigurations.push("runtimeOnly");
  await writeFile(authorFile,JSON.stringify(author));
  const result = await run(dir); expect(result.code,result.output).toBe(0);
  const graph = parseGradleGraph(await readFile(path.join(dir,"osv-mcp-gradle-dependencies.json"),"utf8"));
  const d = knownDeclarations(graph.contexts.find(c => c.configuration === "runtimeClasspath")!)!;
  expect(d.inventoryComplete).toBe(false);
  expect(d.reasons).toContain("unregistered_declaration");
  const captured = await new GradleGraphCache(dir,undefined,"registered-helper-v1").capture(path.join(dir,"gradle.lockfile"),Buffer.from(lock));
  expect(captured.metadata.relations_complete).toBe(true);
  expect(captured.lookup!("review:parent","1").declaredIn).toBeUndefined();
},150_000);


it.skipIf(!binary).each([false,true])("exports and statically adopts explicitly stable Providers (Kotlin=%s)", async kotlin => {
  const dir = await fixture(kotlin), suffix = kotlin ? ".gradle.kts" : ".gradle";
  for (const file of [`build${suffix}`, `extra${suffix}`]) {
    const target = path.join(dir, file);
    const text = await readFile(target, "utf8");
    const replaced = kotlin ? text.replace('val helper=', 'var producerCalls=0\nval helper=').replace('"add"("implementation","review:parent:1",source)',
      '"addProvider"("implementation",providers.provider { producerCalls++; "review:parent:1" },source)') :
      text.replace("def helper=", "def producerCalls=0\ndef helper=").replace("helper.add('implementation','review:parent:1',", "helper.addProvider('implementation',providers.provider { producerCalls++; 'review:parent:1' },");
    await writeFile(target, replaced + (kotlin ? `
check(producerCalls==0)
gradle.projectsEvaluated { tasks.named("osvMcpExportDependencies") { doLast { check(producerCalls==1) } } }
` : `
assert producerCalls==0
gradle.projectsEvaluated { tasks.named('osvMcpExportDependencies') { doLast { assert producerCalls==1 } } }
`));
  }
  const authorFile = path.join(dir, "osv-mcp-gradle-declarations.json");
  const author = JSON.parse(await readFile(authorFile, "utf8"));
  for (const scope of author.scopes) scope.providerPolicy = "stable-during-export";
  await writeFile(authorFile, JSON.stringify(author));
  const result = await run(dir); expect(result.code, result.output).toBe(0);
  const graph = parseGradleGraph(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8"));
  const d = knownDeclarations(graph.contexts.find(c => c.configuration === "runtimeClasspath")!)!;
  expect(d.adapterVersion).toBe(3);
  expect(d.inventoryComplete, JSON.stringify(d.reasons)).toBe(true);
  expect(d.records).toHaveLength(2);
  const captured = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(captured.metadata.declarations_complete, JSON.stringify(captured.metadata)).toBe(true);
  expect(captured.lookup!("review:parent", "1").declaredIn).toEqual(new Set([`build${suffix}`, `extra${suffix}`]));
  expect(captured.metadata.declaration_provenance!.limitations).toContain("provider_stability_author_asserted");
  const disabled = await new GradleGraphCache(dir, undefined, undefined).capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(disabled.lookup!("review:parent", "1").declaredIn).toBeUndefined();
  expect(disabled.metadata.relations_complete).toBe(true);
}, 150_000);


it.skipIf(!binary).each(["missing-policy", "absent", "mutation", "shape", "unused"])("fails closed for Provider boundary %s without losing relations", async kind => {
  const dir = await fixture(false);
  const authorFile = path.join(dir, "osv-mcp-gradle-declarations.json");
  const author = JSON.parse(await readFile(authorFile, "utf8"));
  if (kind !== "missing-policy") for (const scope of author.scopes) scope.providerPolicy = "stable-during-export";
  await writeFile(authorFile, JSON.stringify(author));
  const file = path.join(dir, "extra.gradle");
  const target = kind === "unused" ? "unused" : "implementation";
  const addition = `${kind === "unused" ? "configurations.create('unused')\n" : ""}
def evaluated=false
helper.addProvider('${target}',providers.provider { evaluated=true; ${kind === "absent" ? "null" : "'review:parent:1'"} },helper.source('extra.gradle','applied-script')${kind === "shape" ? ", { dep -> dep.transitive=false } as org.gradle.api.Action" : ""})
if(evaluated) throw new GradleException('Provider realized by registration')
${kind === "mutation" ? "configurations.implementation.withDependencies { deps -> deps.each { it.exclude(group:'unused',module:'unused') } }" : ""}
`;
  await writeFile(file, (await readFile(file, "utf8")) + addition);
  const result = await run(dir); expect(result.code, result.output).toBe(0);
  const captured = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(captured.metadata.relations_complete, JSON.stringify(captured.metadata)).toBe(true);
  expect(captured.coverageReasons).toEqual([]);
  if (kind === "unused") expect(captured.metadata.declarations_complete).toBe(true);
  else {
    expect(captured.metadata.declarations_complete).toBe(false);
    expect(captured.lookup!("review:parent", "1").declaredIn).toBeUndefined();
  }
  if (kind === "missing-policy") {
    expect(captured.metadata.reasons).toContain("provider_stability_assertion_missing");
    expect(captured.metadata.declaration_provenance!.trust_status).toBe("missing_assertion");
  }
  if (kind === "absent") expect(captured.metadata.reasons).toContain("provider_unobserved");
}, 150_000);

it.skipIf(!binary).each([false,true])("snapshots a Provider after the original version-changing Action (Kotlin=%s)", async kotlin => {
  const dir = await fixture(kotlin), suffix = kotlin ? ".gradle.kts" : ".gradle";
  const authorFile = path.join(dir, "osv-mcp-gradle-declarations.json");
  const author = JSON.parse(await readFile(authorFile, "utf8"));
  for (const scope of author.scopes) scope.providerPolicy = "stable-during-export";
  await writeFile(authorFile, JSON.stringify(author));
  const file = path.join(dir, `extra${suffix}`);
  await writeFile(file, (await readFile(file, "utf8")) + (kotlin ? `
helper.withGroovyBuilder { "addProvider"("implementation",providers.provider { "review:parent:2" },source,
  org.gradle.api.Action<org.gradle.api.artifacts.ExternalModuleDependency> { version { require("1") } }) }
` : `
helper.addProvider('implementation',providers.provider { 'review:parent:2' },helper.source('extra.gradle','applied-script'),
  { dep -> dep.version { require('1') } } as org.gradle.api.Action)
`));
  const result = await run(dir); expect(result.code, result.output).toBe(0);
  const captured = await new GradleGraphCache(dir, undefined, "registered-helper-v1").capture(path.join(dir, "gradle.lockfile"), Buffer.from(lock));
  expect(captured.metadata.declarations_complete, JSON.stringify(captured.metadata)).toBe(true);
  expect(captured.lookup!("review:parent", "1").declaredIn).toEqual(new Set([`build${suffix}`, `extra${suffix}`]));
}, 150_000);


it.skipIf(!binary).each([[false,"supplier"], [true,"supplier"], [false,"action"], [true,"action"]] as const)("reports Provider failure and preserves strict-resolution exceptions (Kotlin=%s, %s)", async (kotlin, kind) => {
  const dir = await fixture(kotlin), suffix = kotlin ? ".gradle.kts" : ".gradle";
  const file = path.join(dir, `extra${suffix}`);
  const provider = kind === "supplier" ? 'throw IllegalStateException("supplier-sentinel")' : '"review:parent:1"';
  const action = kind === "action" ? ', org.gradle.api.Action<org.gradle.api.artifacts.ExternalModuleDependency> { throw IllegalStateException("action-sentinel") }' : '';
  const addition = kotlin ? `
helper.withGroovyBuilder { "addProvider"("implementation",providers.provider<String> { ${provider} },source${action}) }
` : `
helper.addProvider('implementation',providers.provider { ${kind === "supplier" ? "throw new IllegalStateException('supplier-sentinel')" : "'review:parent:1'"} },helper.source('extra.gradle','applied-script')${kind === "action" ? ", { dep -> throw new IllegalStateException('action-sentinel') } as org.gradle.api.Action" : ""})
`;
  await writeFile(file, (await readFile(file, "utf8")) + addition);
  const result = await run(dir);
  expect(result.code, result.output).toBe(0);
  const graph = parseGradleGraph(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8"));
  expect(graph.contexts.every(c => !c.complete && (c.reasons?.includes("graph_export_failed") || c.unresolved.some(e => e.reason === "resolution_failed")))).toBe(true);
  expect(graph.contexts.every(c => knownDeclarations(c)?.inventoryComplete === false)).toBe(true);
  // The exporter deliberately records resolution failures. A normal strict
  // resolution must still receive the original exception before export begins.
  await writeFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), '{}');
  await writeFile(file, (await readFile(file, "utf8")) + (kotlin ? `
gradle.projectsEvaluated { tasks.named("osvMcpExportDependencies") {
  doFirst { configurations["runtimeClasspath"].incoming.resolutionResult.rootComponent.get() }
} }
` : `
gradle.projectsEvaluated { tasks.named('osvMcpExportDependencies') {
  doFirst { configurations.runtimeClasspath.incoming.resolutionResult.rootComponent.get() }
} }
`));
  const strict = await run(dir);
  expect(strict.code).not.toBe(0);
  expect(strict.output).toContain(`${kind}-sentinel`);
  expect(await readFile(path.join(dir, "osv-mcp-gradle-dependencies.json"), "utf8")).toBe('{}');
}, 150_000);
