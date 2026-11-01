/** Explicit live validation only. Requires trusted Gradle/JDK/scanner paths; not a unit test. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pluginProfileDigest } from "../../../dist/utils/gradlePlugins.js";
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
assert(scanner && profiles.every(p => p.gradle) && process.env.JAVA_HOME && process.env.GRADLE_USER_HOME, "Set OSV_MCP_LIVE_SCANNER, OSV_MCP_LIVE_GRADLE_8, OSV_MCP_LIVE_GRADLE_9, JAVA_HOME and GRADLE_USER_HOME");
const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "osv-plugin-live-")));
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
const summary = { schema: "osv-mcp.gradle-plugin-live-validation", timestamp: new Date().toISOString(), revision, tracked_working_tree_modified: (await execute("git",["diff","--name-only"],{cwd:repo})).stdout.trim().length>0, node: process.version,
  java_version:(await execute(path.join(process.env.JAVA_HOME,"bin/java"),["-version"])).stderr.trim(),
  server_dist_sha256:digest(await readFile(path.join(repo,"dist/index.js"))),
  scanner: { version: scannerVersion, sha256: scannerSha256 },
  manual_harness_sha256: digest(await readFile(fileURLToPath(import.meta.url))), sources_sha256: Object.fromEntries(await Promise.all(["gradle/plugin-provenance.init.gradle", "src/utils/gradlePlugins.ts", "src/utils/gradlePluginSnapshots.ts", "src/utils/gradlePluginJar.ts", "gradle/register-declarations.init.gradle", "gradle/export-dependency-graph.init.gradle", "src/utils/gradleGraphCache.ts", "src/utils/gradleDeclarations.ts", "src/utils/gradleCatalogs.ts", "src/index.ts"].map(async p => [p, digest(await readFile(path.join(repo,p)))]))), profiles: [] };
await save(path.join(evidence,"environment.json"),summary);
console.log(JSON.stringify({ phase: "start", directory: base, scanner: scannerVersion }));

async function generate(profile) {
  const root=path.join(base,profile.name), out=path.join(evidence,profile.name); await mkdir(out,{recursive:true});
  const write=async(p,s)=>{await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),s);};
  const included=profile.dsl==="kotlin",directory=included,precompiled=included;
  const producer=included?"build-logic":"buildSrc", main=included?"build.gradle.kts":"build.gradle";
  const source=producer+(precompiled?"/src/main/groovy/proof.convention.gradle":"/src/main/java/proof/Convention.java");
  const home=path.dirname(path.dirname(await realpath(profile.gradle)));
  const version=(await execute(profile.gradle,["--version"],{env:process.env})).stdout.match(/Gradle (\d+\.\d+(?:\.\d+)?)/)[1];
  const hashFile=async(f)=>{const h=createHash('sha256');for await(const b of createReadStream(f))h.update(b);return h.digest('hex');};
  const paths=[],entries=[];
  for(const folder of ['lib','lib/plugins','lib/agents'])for(const name of await readdir(path.join(home,folder)))if(name.endsWith('.jar'))paths.push({id:folder+'/'+name,path:path.join(home,folder,name)});
  paths.push({id:'generated/api',path:path.join(process.env.GRADLE_USER_HOME,'caches',version,'generated-gradle-jars',`gradle-api-${version}.jar`)});
  for(const [id,file]of [['jdk/java','bin/java'],['jdk/modules','lib/modules'],['jdk/release','release']])paths.push({id,path:path.join(process.env.JAVA_HOME,file)});
  for(const p of paths)entries.push({id:p.id,role:p.id.startsWith('jdk/')?'jdk-runtime':p.id==='generated/api'?'gradle-api-generated':'gradle-distribution',size:(await stat(p.path)).size,sha256:await hashFile(p.path)});
  const release=await readFile(path.join(process.env.JAVA_HOME,'release'),'utf8'),jdkIdentity=release.match(/^JAVA_RUNTIME_VERSION="([^"]+)"/m)[1];
  const toolchain={schemaVersion:1,gradleVersion:version,distributionSha256:pluginProfileDigest(entries),jdkIdentity,compilerIdentity:'gradle-bundled',generatedApiMethod:'gradle-generated-api',entries};
  const loader={schemaVersion:1,toolchainProfileDigest:pluginProfileDigest(toolchain),gradleVersion:version,jdkIdentity,loaderPolicy:'gradle-managed-only',transformPolicy:'operator-attested-pipeline',agents:entries.filter(e=>e.id.startsWith('lib/agents/')).map(e=>({kind:'javaagent',entryId:e.id,sha256:e.sha256})),exportSettings:{configurationCache:false,parallel:false},attestations:{approvedRuntimeOnly:true,noUnregisteredAgentsOrLoaders:true,artifactsImmutableThroughLoad:true}};
  // Test-only explicit approvals of the selected local runtime. This is not deployment provisioning.
  await write('.profiles/toolchain.json',JSON.stringify({profile:toolchain,paths}));await write('.profiles/loader.json',JSON.stringify(loader));
  await write('settings.gradle',`${included?"pluginManagement { includeBuild('build-logic') }":""}\nrootProject.name='plugin-live'\n`);
  await write(producer+'/settings.gradle',"rootProject.name='logic'\n");
  await write(producer+'/build.gradle',(precompiled?"plugins {id 'groovy-gradle-plugin'}":"plugins {id 'java-gradle-plugin'};gradlePlugin {plugins {convention {id='proof.convention';implementationClass='proof.Convention'}}}")+(directory?`
def image=tasks.register('pluginImage',Sync) {dependsOn tasks.named('classes');from sourceSets.main.output;into layout.buildDirectory.dir('plugin-image')}
configurations.runtimeElements.outgoing.artifacts.clear()
artifacts.add('runtimeElements',layout.buildDirectory.dir('plugin-image')) {builtBy image;type='java-classes-directory'}
`:''));
  const gavs=['org.apache.logging.log4j:log4j-core:2.14.1','com.fasterxml.jackson.core:jackson-databind:2.9.10.7'];
  await write(source,precompiled?`def h=extensions.getByName('osvMcpDeclarations')
def session=h.beginPrecompiled('local')
def source=h.pluginSource(session,'entry')
${gavs.map(g=>`h.add('implementation','${g}',source)`).join('\n')}
h.endPlugin(session,'complete')
`:`package proof;
import org.gradle.api.Plugin;import org.gradle.api.Project;import groovy.lang.GroovyObject;
public class Convention implements Plugin<Project> {public void apply(Project p) {
GroovyObject h=(GroovyObject)p.getExtensions().getByName("osvMcpDeclarations");
Object session=h.invokeMethod("beginPlugin",new Object[]{"local",this});
Object source=h.invokeMethod("pluginSource",new Object[]{session,"entry"});
${gavs.map(g=>`h.invokeMethod("add",new Object[]{"implementation","${g}",source});`).join('\n')}
h.invokeMethod("endPlugin",new Object[]{session,"complete"});
}}
`);
  await write(main,included?`import org.gradle.kotlin.dsl.withGroovyBuilder
plugins { java;id("proof.convention") }
repositories {mavenCentral()}
dependencyLocking {lockAllConfigurations()}
val h=extensions.getByName("osvMcpDeclarations")
val source=h.withGroovyBuilder {"source"("${main}")}
h.withGroovyBuilder {"add"("implementation","${gavs[0]}",source)}
`:`plugins {id 'java';id 'proof.convention'}
repositories {mavenCentral()}
dependencyLocking {lockAllConfigurations()}
def h=extensions.getByName('osvMcpDeclarations');h.add('implementation','${gavs[0]}',h.source('${main}'))
`);
  const implementationClass=precompiled?'ProofConventionPlugin':'proof.Convention';
  const configurations=['annotationProcessor','compileClasspath','runtimeClasspath','testAnnotationProcessor','testCompileClasspath','testRuntimeClasspath'];
  const contract={contractVersion:3,trustModel:'registered-helper-v1',sources:[main,source],catalogPolicy:'none',catalogs:[],pluginPolicy:'explicit-local-build-v1',plugins:[{id:'local',producer:{kind:included?'included-build':'build-src',rootDirectory:producer,projectPath:':'},pluginIds:['proof.convention'],implementationClass,registrationForm:precompiled?'precompiled-pending':'binary-instance',sourcePaths:[source],inputPaths:[producer+'/settings.gradle',producer+'/build.gradle',source],outputRoots:[{kind:'directory',role:'classes',path:producer+'/build/classes/java/main'},{kind:'directory',role:'resources',path:producer+'/build/resources/main'},...(precompiled?[{kind:'directory',role:'classes',path:producer+'/build/classes/groovy/main'}]:[]),{kind:directory?'directory':'jar',role:'plugin-artifact',path:producer+(directory?'/build/plugin-image':'/build/libs/logic.jar')}],sourceMappings:[{id:'entry',sourcePath:source,implementationClass}],toolchainProfileDigest:pluginProfileDigest(toolchain),loadPolicy:'approved-gradle-loader-v1',loaderProfileDigest:pluginProfileDigest(loader),assertions:{buildInputs:'all-plugin-build-inputs-listed',additions:'all-contributing-plugin-additions-use-helper',mapping:'source-artifact-mapping-reviewed',mutation:'immutable-during-export'}}],scopes:configurations.map(c=>({id:c,projectPath:':',resolvableConfiguration:c,declarationConfigurations:['implementation'],assertion:'all-contributing-additions-use-helper',mutationPolicy:'immutable-after-add',catalogIds:[],pluginIds:['local']}))};
  await write('osv-mcp-gradle-declarations.json',JSON.stringify(contract));
  const args=['-p',root,...['plugin-provenance.init.gradle','register-declarations.init.gradle','export-dependency-graph.init.gradle'].flatMap(n=>['-I',path.join(repo,'gradle',n)]),'-DosvMcpPluginBoundary='+root,'-DosvMcpPluginToolchainProfile='+path.join(root,'.profiles/toolchain.json'),'-DosvMcpPluginLoaderProfile='+path.join(root,'.profiles/loader.json'),'-DosvMcpPluginRuntimeRoots='+process.env.GRADLE_USER_HOME,'-PosvMcpDeclarationContract=osv-mcp-gradle-declarations.json','--offline','--no-daemon','--no-configuration-cache','--no-parallel','--no-build-cache','--rerun-tasks','--console=plain'];
  const run=async(task,label)=>{console.log(JSON.stringify({phase:'gradle',profile:profile.name,task:label}));try {const r=await execute(profile.gradle,[...args,...task],{timeout:180000,maxBuffer:8*1024**2,env:process.env});await writeFile(path.join(out,label+'.log'),r.stdout+r.stderr);}catch(e){await writeFile(path.join(out,label+'.log'),(e.stdout??'')+(e.stderr??''));throw e;}};
  await run(['dependencies','--write-locks'],'lock');await run(['osvMcpExportDependencies','-PosvMcpConfigurations=*'],'export');
  const graph=JSON.parse(await readFile(path.join(root,'osv-mcp-gradle-dependencies.json'),'utf8'));
  assert.equal(graph.schemaVersion,3);assert(graph.contexts.every(c=>c.complete));
  await save(path.join(out,'graph-accepted.json'),graph);
  return {root,out,main,source,directory,graph,contract,toolchain,loader,run};
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
    if(!pageToken) return {name,version,http_status:response.status,vulnerability_ids:pages.flatMap(p=>(p.response.vulns??[]).map(v=>v.id)),pages:pages.length,evidence:pages};
  }
  throw new Error("Independent query page limit reached");
}
async function checkTools(profile,project,scenario) {
  const {root,out,main,source,directory}=project;
  const enabled=scenario!=="helper_disabled", adopted=["accepted","reexported"].includes(scenario), rejected=scenario==="snapshot_modified", dest=path.join(out,scenario);await mkdir(dest);
  const fake=path.join(out,"fake-bin");await mkdir(fake,{recursive:true});
  const marker=path.join(out,"BUILD_EXECUTED");
  for(const name of ["java","gradle"]) await writeFile(path.join(fake,name),`#!/bin/sh\nprintf unexpected > ${sh(marker)}\nexit 99\n`,{mode:0o755});
  await writeFile(path.join(root,"gradlew"),`#!/bin/sh\nprintf unexpected > ${sh(marker)}\nexit 99\n`,{mode:0o755});
  const producer=directory?"build-logic":"buildSrc";
  const files=[producer+"/build.gradle",producer+"/settings.gradle",main,source,"settings.gradle","gradle.lockfile","osv-mcp-gradle-declarations.json","osv-mcp-gradle-dependencies.json","gradlew"];
  const before=Object.fromEntries(await Promise.all(files.map(async f=>[f,digest(await readFile(path.join(root,f)))])));
  const env={...process.env,PATH:fake+path.delimiter+process.env.PATH,OSV_SCANNER_PATH:scanner,OSV_MCP_AUTO_DOWNLOAD:"0",OSV_MCP_ALLOWED_ROOT:root,OSV_MCP_REQUIRE_ALLOWED_ROOT:"1",OSV_MCP_HISTORY:"0",OSV_MCP_NO_CANDIDATE_CHECK:"0",OSV_MCP_NO_REMOTE_RESOLUTION:"1"};
  if(enabled) env.OSV_MCP_GRADLE_DECLARATION_TRUST="registered-helper-v1";else delete env.OSV_MCP_GRADLE_DECLARATION_TRUST;
  delete env.OSV_MCP_GRADLE_CATALOG_TRUST;
  env.OSV_MCP_GRADLE_PLUGIN_TRUST="local-plugin-loader-attested-v2";
  env.OSV_MCP_GRADLE_PLUGIN_TOOLCHAIN_PROFILES=scenario==="toolchain_unapproved"?"":pluginProfileDigest(project.toolchain);
  env.OSV_MCP_GRADLE_PLUGIN_LOADER_PROFILES=scenario==="loader_unapproved"?"":pluginProfileDigest(project.loader);
  if(scenario==="plugin_disabled") delete env.OSV_MCP_GRADLE_PLUGIN_TRUST;
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,"dist/index.js")],stderr:"pipe",env});
  let stderr="";transport.stderr?.on("data",c=>stderr+=c);
  const client=new Client({name:"gradle-plugin-live-validation",version:"1.0.0"});const tools=[];
  try {
    await client.connect(transport);
    for(const tool of ["scan_project","scan_java_project","suggest_fix"]) {
      console.log(JSON.stringify({phase:"mcp",profile:profile.name,scenario,tool}));
      const response=await client.callTool({name:tool,arguments:{project_path:root}},undefined,{timeout:180000});
      await save(path.join(dest,tool+".json"),response);
      const payload=JSON.parse(response.content.find(c=>c.type==="text").text);
      assert(!response.isError,JSON.stringify(payload));
      const metadata=payload.coverage.dependency_metadata.gradle[0];
      assert.equal(payload.coverage.complete,tool==="scan_java_project",JSON.stringify(payload.coverage));
      // The plugin producer is an independent build without a dependency lock; do not hide that coverage warning.
      const producer=directory?'build-logic':'buildSrc';
      if(tool!=="scan_java_project")assert.deepEqual(payload.coverage.lockfile_missing.map(m=>m.path).sort(),[producer+'/build.gradle',producer+'/settings.gradle'].sort());
      assert.equal(payload.coverage.skipped_files.length,0);
      assert.equal(metadata.relations_complete,!rejected,JSON.stringify(metadata));assert.equal(metadata.declarations_complete,adopted,JSON.stringify(metadata));
      if(!rejected) {
        const p=metadata.declaration_provenance;
        assert.equal(p.trust_status,scenario==="registration_incomplete"?"missing_assertion":enabled?"accepted":"disabled");
        if(scenario==="registration_incomplete"){assert(metadata.reasons.includes("plugin_declarations_incomplete"));assert.equal(p.plugin_trust_status,"missing_assertion");}
        if(adopted) {
          assert.equal(p.plugin_trust_status,"accepted");
          assert.equal(p.assurance,"author-attested-loader-and-structurally-checked");
          const apps=p.contexts.flatMap(c=>c.plugin_applications??[]);assert(apps.length>0);
          for(const app of apps){assert.equal(app.source_artifact_status,"build-lineage-and-runtime-attested");assert.equal(app.transform_status,"trusted-runtime-not-independently-observed");assert(directory?app.comparison==="same-path-origin":["raw-exact","entry-content-exact"].includes(app.comparison));}
          if(directory)for(const limit of ["plugin_directory_snapshot_post_build","plugin_directory_origin_same_path_not_compared"])assert(p.limitations.includes(limit));
        }
        if(scenario==="toolchain_unapproved")assert(metadata.reasons.includes("plugin_toolchain_not_approved"));
        if(scenario==="loader_unapproved")assert(metadata.reasons.includes("plugin_loader_not_approved"));
        if(scenario==="plugin_disabled")assert.equal(p.plugin_trust_status,"disabled");
      } else {assert(metadata.reasons.includes(directory?"plugin_evidence_unverifiable":"plugin_snapshot_mismatch"));assert.equal(metadata.declaration_provenance.plugin_trust_status,"unverifiable");}
      const packages=payload.packages??payload.suggestions,get=name=>packages.find(p=>(p.name??p.package)===name);
      for(const name of required) {
        const pkg=get(name);assert(pkg,`Missing ${name}`);assert.equal(pkg.dependency_relation,rejected?"unknown":"direct");
        assert.deepEqual(pkg.declared_in?.toSorted(),adopted?(name.includes("log4j-core")?[main,source].sort():[source]):undefined);
        if(tool==="suggest_fix") {
          assert(pkg.recommended_upgrade);assert.equal(pkg.candidate_check,"clean");assert(!pkg.update_hint.includes("pom.xml"));
          if(adopted) for(const file of pkg.declared_in) assert(pkg.update_hint.includes(file));
          else assert(!pkg.update_hint.includes(source));
        }
      }
      for(const [name,parent] of transitive) {
        const pkg=get(name);assert(pkg,`Missing ${name}`);assert.equal(pkg.dependency_relation,rejected?"unknown":"transitive");assert.deepEqual(pkg.introduced_by,rejected?undefined:[parent]);assert.equal(pkg.declared_in,undefined);
      }
      const rows=packages.map(p=>({name:p.name??p.package,version:p.version??p.current_version,dependency_relation:p.dependency_relation,declared_in:p.declared_in??null,introduced_by:p.introduced_by??null,
        recommended_upgrade:p.recommended_upgrade??null,candidate_check:p.candidate_check??null,update_hint:p.update_hint??null,
        vulnerability_ids:(p.vulnerabilities??p.per_cve_detail??[]).map(v=>v.id)}));
      assert(rows.every(row=>row.vulnerability_ids.length>0));
      assert(get(required[0]).vulnerabilities?.some(v=>v.id==="GHSA-jfh8-c2jp-5v3q") || get(required[0]).per_cve_detail?.some(v=>v.id==="GHSA-jfh8-c2jp-5v3q"));
      const checks=[];
      if(tool==="suggest_fix") for(const row of rows.filter(r=>r.recommended_upgrade)) {
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
  const project=await generate(profile),checks=[];
  for(const scenario of ['accepted','helper_disabled','plugin_disabled','toolchain_unapproved','loader_unapproved'])checks.push(await checkTools(profile,project,scenario));
  const graphPath=path.join(project.root,'osv-mcp-gradle-dependencies.json');
  const oldSource=await readFile(path.join(project.root,project.source),'utf8');
  // Native negative control: rebuild a plugin which actually leaves its session open.
  const unclosed=oldSource.split('\n').filter(line=>!line.includes('endPlugin')).join('\n');
  assert.notEqual(unclosed,oldSource);await writeFile(path.join(project.root,project.source),unclosed);
  await project.run(['osvMcpExportDependencies','-PosvMcpConfigurations=*'],'export-unclosed');
  const incomplete=JSON.parse(await readFile(graphPath,'utf8'));
  assert(incomplete.contexts.every(c=>c.declarations.pluginApplications.every(a=>!a.ended)));
  checks.push(await checkTools(profile,project,'registration_incomplete'));
  const newSource=project.directory?oldSource+'\nclass LiveReexportMarker {}\n':oldSource.replace('public class Convention implements Plugin<Project> {','public class Convention implements Plugin<Project> { public static final int LIVE_REEXPORT_MARKER=1;');
  assert.notEqual(newSource,oldSource);await writeFile(path.join(project.root,project.source),newSource);
  await project.run(['osvMcpExportDependencies','-PosvMcpConfigurations=*'],'reexport');
  const fresh=JSON.parse(await readFile(graphPath,'utf8'));
  const apps=g=>g.contexts.flatMap(c=>c.declarations.pluginApplications);
  assert.notEqual(digest(JSON.stringify(apps(fresh))),digest(JSON.stringify(apps(project.graph))));
  const built=a=>a.builtArtifact;
  assert.notDeepEqual(built(apps(fresh)[0]),built(apps(project.graph)[0]));
  checks.push(await checkTools(profile,project,'reexported'));
  const ref=apps(fresh)[0].runtimeSnapshotRef,target=path.join(project.root,ref.kind==='jar'?ref.snapshotPath:ref.manifestPath),bytes=await readFile(target);
  try {await writeFile(target,Buffer.concat([bytes,Buffer.from('modified')]));checks.push(await checkTools(profile,project,'snapshot_modified'));}finally{await writeFile(target,bytes);}
  for(const tool of ['scan_project','scan_java_project','suggest_fix']) {
    const stable=c=>c.tools.find(t=>t.tool===tool).packages.map(({declared_in,update_hint,dependency_relation,introduced_by,...r})=>r).sort((a,b)=>a.name.localeCompare(b.name));
    for(const c of checks.slice(1))assert.deepEqual(stable(checks[0]),stable(c));
  }
  summary.profiles.push({name:profile.name,dsl:profile.dsl,gradle_version:project.toolchain.gradleVersion,artifact:project.directory?'directory':'jar',producer:project.directory?'included-build':'buildSrc',registration:project.directory?'precompiled-pending':'binary-instance',toolchain:project.toolchain,loader:project.loader,
    fixture:{main:await readFile(path.join(project.root,project.main),'utf8'),initial_plugin_source:oldSource,reexported_plugin_source:newSource,settings:await readFile(path.join(project.root,'settings.gradle'),'utf8'),producer_build:await readFile(path.join(project.root,project.directory?'build-logic/build.gradle':'buildSrc/build.gradle'),'utf8'),producer_settings:await readFile(path.join(project.root,project.directory?'build-logic/settings.gradle':'buildSrc/settings.gradle'),'utf8'),contract:project.contract,initial_graph:project.graph,unclosed_graph:incomplete,reexported_graph:fresh,lock:await readFile(path.join(project.root,'gradle.lockfile'),'utf8')},checks});
  await save(path.join(evidence,'summary.json'),summary);
}
const queries=summary.profiles.flatMap(p=>p.checks.flatMap(c=>c.tools.flatMap(t=>t.independent_candidate_queries)));
summary.scope={mcp_transport:'stdio',osv_endpoint:'https://api.osv.dev/v1/query',remote_manifest_resolution_disabled:true,gradle_offline:true,configuration_cache:false,graph_schema_version:3,declaration_adapter_version:5,contract_version:3,policy:'approved-gradle-loader-v1',registration_negative_control:'native rebuild with endPlugin omitted; fresh graph and input hashes',matrix:'Groovy/8.11.1 buildSrc binary Java JAR; Kotlin/9.2.1 included-build precompiled Groovy directory. Other combinations covered by offline production regressions.',trust:'Explicit test-only approvals of locally selected runtime, not independent bytecode observation or production profile provisioning.'};
summary.verification={successful_tool_calls:summary.profiles.reduce((n,p)=>n+p.checks.reduce((m,c)=>m+c.tools.length,0),0),independent_candidate_queries:queries.length,independent_queries_http_200_and_no_vulnerabilities:queries.every(q=>q.http_status===200&&!q.vulnerability_ids.length),inputs_unchanged_during_mcp:summary.profiles.every(p=>p.checks.every(c=>c.inputs_unchanged&&c.build_execution_marker_absent))};
assert.equal(summary.verification.successful_tool_calls,48);assert.equal(queries.length,64);
await save(path.join(evidence,'summary.json'),summary);
console.log(JSON.stringify({phase:'complete',evidence,verification:summary.verification}));
