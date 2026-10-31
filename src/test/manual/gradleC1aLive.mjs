/** Explicit live validation only. Requires trusted Gradle/JDK/scanner paths; not a unit test. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const execute = promisify(execFile);
const scanner = process.env.OSV_MCP_LIVE_SCANNER;
const profiles = [
  { name: "groovy-8", dsl: "groovy", gradle: process.env.OSV_MCP_LIVE_GRADLE_8 },
  { name: "kotlin-9", dsl: "kotlin", gradle: process.env.OSV_MCP_LIVE_GRADLE_9 },
];
assert(scanner && profiles.every(p => p.gradle) && process.env.JAVA_HOME, "Set OSV_MCP_LIVE_SCANNER, OSV_MCP_LIVE_GRADLE_8, OSV_MCP_LIVE_GRADLE_9 and JAVA_HOME");
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-c1a-live-")));
const evidence = path.join(base, "evidence"); await mkdir(evidence);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");
const sh = value => "'" + value.replaceAll("'", "'\\''") + "'";
const required = ["org.apache.logging.log4j:log4j-core", "com.fasterxml.jackson.core:jackson-databind"];
const transitive = new Map([
  ["org.apache.logging.log4j:log4j-api", "org.apache.logging.log4j:log4j-core"],
  ["com.fasterxml.jackson.core:jackson-core", "com.fasterxml.jackson.core:jackson-databind"],
]);
const scannerVersion = (await execute(scanner, ["--version"])).stdout.trim();
const scannerSha256 = digest(await readFile(scanner));
const revision = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
const summary = { schema: "osv-mcp.gradle-c1a-live-validation", timestamp: new Date().toISOString(), revision, node: process.version,
  scanner: { version: scannerVersion, sha256: scannerSha256 },
  sources_sha256: Object.fromEntries(await Promise.all(["gradle/register-declarations.init.gradle", "gradle/export-dependency-graph.init.gradle", "src/utils/gradleGraphCache.ts", "src/utils/gradleDeclarations.ts"].map(async p => [p, digest(await readFile(path.join(repo,p)))]))), profiles: [] };
await save(path.join(evidence,"environment.json"),summary);
console.log(JSON.stringify({ phase: "start", directory: base, scanner: scannerVersion }));

async function generate(profile) {
  const root = path.join(base, profile.name); await mkdir(path.join(root,"gradle"), {recursive:true});
  const suffix = profile.dsl === "kotlin" ? ".gradle.kts" : ".gradle";
  const main = `build${suffix}`, extra = `gradle/extra${suffix}`;
  await writeFile(path.join(root,"settings.gradle"), `rootProject.name = 'c1a-live-${profile.name}'\n`);
  const build = profile.dsl === "groovy" ? `
plugins { id 'java-library' }
repositories { mavenCentral() }
dependencyLocking { lockAllConfigurations() }
def h=extensions.getByName('osvMcpDeclarations')
h.add('implementation','org.apache.logging.log4j:log4j-core:2.14.1',h.source('${main}'))
apply from: '${extra}'
` : `
import org.gradle.kotlin.dsl.withGroovyBuilder
plugins { \`java-library\` }
repositories { mavenCentral() }
dependencyLocking { lockAllConfigurations() }
val h=extensions.getByName("osvMcpDeclarations")
val source=h.withGroovyBuilder { "source"("${main}") }
h.withGroovyBuilder { "add"("implementation","org.apache.logging.log4j:log4j-core:2.14.1",source) }
apply(from="${extra}")
`;
  const script = profile.dsl === "groovy" ? `
def h=extensions.getByName('osvMcpDeclarations')
def source=h.source('${extra}','applied-script')
h.add('runtimeOnly','org.apache.logging.log4j:log4j-core:2.14.1',source)
h.add('implementation','com.fasterxml.jackson.core:jackson-databind:2.9.10.7',source)
` : `
import org.gradle.kotlin.dsl.withGroovyBuilder
val h=extensions.getByName("osvMcpDeclarations")
val source=h.withGroovyBuilder { "source"("${extra}","applied-script") }
h.withGroovyBuilder { "add"("runtimeOnly","org.apache.logging.log4j:log4j-core:2.14.1",source) }
h.withGroovyBuilder { "add"("implementation","com.fasterxml.jackson.core:jackson-databind:2.9.10.7",source) }
`;
  await writeFile(path.join(root,main),build); await writeFile(path.join(root,extra),script);
  const configurations = ["annotationProcessor","compileClasspath","runtimeClasspath","testAnnotationProcessor","testCompileClasspath","testRuntimeClasspath"];
  await save(path.join(root,"osv-mcp-gradle-declarations.json"),{contractVersion:1,trustModel:"registered-helper-v1",catalogPolicy:"none",sources:[main,extra],
    scopes:configurations.map(configuration=>({id:configuration,projectPath:":",resolvableConfiguration:configuration,declarationConfigurations:["implementation","runtimeOnly"],assertion:"all-contributing-additions-use-helper",mutationPolicy:"immutable-after-add"}))});
  const args = ["-p",root,"-I",path.join(repo,"gradle/register-declarations.init.gradle"),"-I",path.join(repo,"gradle/export-dependency-graph.init.gradle"),
    "-PosvMcpDeclarationContract=osv-mcp-gradle-declarations.json","--offline","--no-daemon","--no-configuration-cache","--console=plain"];
  const out = path.join(evidence,profile.name); await mkdir(out);
  for(const task of [["dependencies","--write-locks"],["osvMcpExportDependencies","-PosvMcpConfigurations=*"]]) {
    console.log(JSON.stringify({phase:"gradle",profile:profile.name,task:task[0]}));
    try {
      const result=await execute(profile.gradle,[...args,...task],{timeout:120000,maxBuffer:4*1024*1024,env:process.env});
      await writeFile(path.join(out,task[0]+".log"),result.stdout+result.stderr);
    } catch(error) { await writeFile(path.join(out,task[0]+".log"),(error.stdout??"")+(error.stderr??"")); throw error; }
  }
  const graph=JSON.parse(await readFile(path.join(root,"osv-mcp-gradle-dependencies.json"),"utf8"));
  assert.equal(graph.schemaVersion,2);assert(graph.contexts.every(c=>c.complete&&c.declarations.inventoryComplete));
  const runtime=graph.contexts.find(c=>c.configuration==="runtimeClasspath");
  assert.deepEqual(runtime.declarations.records.filter(r=>r.declarationAtAdd.key.name==="log4j-core").map(r=>r.configuration).sort(),["implementation","runtimeOnly"]);
  return {root,out,main,extra,graph};
}
async function independentQuery(name,version,out) {
  const pages=[];let pageToken;
  for(let page=0;page<5;page++) {
    const request={package:{ecosystem:"Maven",name},version,...(pageToken?{page_token:pageToken}:{})};
    const response=await fetch("https://api.osv.dev/v1/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request),signal:AbortSignal.timeout(30000)});
    const text=await response.text(); assert(text.length<4*1024*1024);
    const body=JSON.parse(text);pages.push({request,http_status:response.status,response:body,timestamp:new Date().toISOString()});
    await save(out,pages);assert(response.ok,`Independent OSV HTTP ${response.status}`);
    assert(body.vulns===undefined||Array.isArray(body.vulns));
    assert(body.next_page_token===undefined||typeof body.next_page_token==="string");
    pageToken=body.next_page_token;
    if(!pageToken) return {name,version,http_status:response.status,vulnerability_ids:pages.flatMap(p=>(p.response.vulns??[]).map(v=>v.id)),pages:pages.length};
  }
  throw new Error("Independent query page limit reached");
}
async function checkTools(profile,project,enabled) {
  const {root,out,main,extra}=project;
  const scenario=enabled?"accepted":"disabled",dest=path.join(out,scenario);await mkdir(dest);
  const fake=path.join(out,"fake-bin");await mkdir(fake,{recursive:true});
  const marker=path.join(out,"BUILD_EXECUTED");
  for(const name of ["java","gradle"]) await writeFile(path.join(fake,name),`#!/bin/sh\nprintf unexpected > ${sh(marker)}\nexit 99\n`,{mode:0o755});
  await writeFile(path.join(root,"gradlew"),`#!/bin/sh\nprintf unexpected > ${sh(marker)}\nexit 99\n`,{mode:0o755});
  const files=[main,extra,"settings.gradle","gradle.lockfile","osv-mcp-gradle-declarations.json","osv-mcp-gradle-dependencies.json","gradlew"];
  const before=Object.fromEntries(await Promise.all(files.map(async f=>[f,digest(await readFile(path.join(root,f)))])));
  const env={...process.env,PATH:fake+path.delimiter+process.env.PATH,OSV_SCANNER_PATH:scanner,OSV_MCP_AUTO_DOWNLOAD:"0",OSV_MCP_ALLOWED_ROOT:root,OSV_MCP_REQUIRE_ALLOWED_ROOT:"1",OSV_MCP_HISTORY:"0",OSV_MCP_NO_CANDIDATE_CHECK:"0",OSV_MCP_NO_REMOTE_RESOLUTION:"1"};
  if(enabled) env.OSV_MCP_GRADLE_DECLARATION_TRUST="registered-helper-v1";else delete env.OSV_MCP_GRADLE_DECLARATION_TRUST;
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,"dist/index.js")],stderr:"pipe",env});
  let stderr="";transport.stderr?.on("data",c=>stderr+=c);
  const client=new Client({name:"gradle-c1a-live-validation",version:"1.0.0"});const tools=[];
  try {
    await client.connect(transport);
    for(const tool of ["scan_project","scan_java_project","suggest_fix"]) {
      console.log(JSON.stringify({phase:"mcp",profile:profile.name,scenario,tool}));
      const response=await client.callTool({name:tool,arguments:{project_path:root}},undefined,{timeout:180000});
      await save(path.join(dest,tool+".json"),response);
      const payload=JSON.parse(response.content.find(c=>c.type==="text").text);
      assert(!response.isError,JSON.stringify(payload));
      const metadata=payload.coverage.dependency_metadata.gradle[0];
      assert.equal(payload.coverage.complete,true,JSON.stringify(payload.coverage));
      assert.equal(metadata.relations_complete,true);assert.equal(metadata.declarations_complete,enabled);
      assert.equal(metadata.declaration_provenance.trust_status,scenario);
      assert.equal(metadata.declaration_provenance.assurance,enabled?"author-attested-and-structurally-checked":null);
      assert(metadata.declaration_provenance.contexts.every(c=>c.trust_status===scenario));
      assert.deepEqual(metadata.declaration_provenance.limitations,["unregistered_equal_additions_not_detectable","reverted_external_mutations_not_detectable"]);
      const packages=payload.packages??payload.suggestions,get=name=>packages.find(p=>(p.name??p.package)===name);
      for(const name of required) {
        const pkg=get(name);assert(pkg,`Missing ${name}`);assert.equal(pkg.dependency_relation,"direct");
        assert.deepEqual(pkg.declared_in,enabled?(name.includes("log4j-core")?[main,extra]:[extra]):undefined);
        if(tool==="suggest_fix") {
          assert(pkg.recommended_upgrade);assert.equal(pkg.candidate_check,"clean");assert(!pkg.update_hint.includes("pom.xml"));
          if(enabled) for(const file of pkg.declared_in) assert(pkg.update_hint.includes(file));
        }
      }
      for(const [name,parent] of transitive) {
        const pkg=get(name);assert(pkg,`Missing ${name}`);assert.equal(pkg.dependency_relation,"transitive");assert.deepEqual(pkg.introduced_by,[parent]);assert.equal(pkg.declared_in,undefined);
      }
      const rows=packages.map(p=>({name:p.name??p.package,version:p.version??p.current_version,dependency_relation:p.dependency_relation,declared_in:p.declared_in??null,introduced_by:p.introduced_by??null,
        recommended_upgrade:p.recommended_upgrade??null,candidate_check:p.candidate_check??null,update_hint:p.update_hint??null,
        vulnerability_ids:(p.vulnerabilities??p.per_cve_detail??[]).map(v=>v.id)}));
      const checks=[];
      if(tool==="suggest_fix"&&enabled) for(const row of rows.filter(r=>r.recommended_upgrade)) {
        const checked=await independentQuery(row.name,row.recommended_upgrade,path.join(dest,"query-"+checks.length+".json"));
        assert.deepEqual(checked.vulnerability_ids,[],`Independent OSV results differ for ${row.name}`);checks.push(checked);
      }
      tools.push({tool,coverage_complete:payload.coverage.complete,metadata,packages:rows,independent_candidate_queries:checks});
      console.log(JSON.stringify({phase:"passed",profile:profile.name,scenario,tool,packages:rows.length,checked_candidates:checks.length}));
    }
    for(const f of files) assert.equal(digest(await readFile(path.join(root,f))),before[f],`Input changed: ${f}`);
    await assert.rejects(access(marker));
    await save(path.join(dest,"summary.json"),{tools,input_sha256:before,inputs_unchanged:true,build_execution_marker_absent:true});
    return {scenario,tools,input_sha256:before,inputs_unchanged:true,build_execution_marker_absent:true};
  } finally {await client.close();await writeFile(path.join(dest,"server.log"),stderr);}
}
for(const profile of profiles) {
  const project=await generate(profile);
  const gradleVersion=(await execute(profile.gradle,["--version"],{env:process.env})).stdout.trim();
  const checks=[];for(const enabled of [true,false]) checks.push(await checkTools(profile,project,enabled));
  summary.profiles.push({name:profile.name,dsl:profile.dsl,gradle_version:gradleVersion,checks});
  await save(path.join(evidence,"summary.json"),summary);
}
console.log(JSON.stringify({phase:"complete",evidence,profiles:summary.profiles.length}));
