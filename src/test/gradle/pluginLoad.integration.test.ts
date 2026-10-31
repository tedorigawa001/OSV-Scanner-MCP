/** Public API proof only; never enables production convention-plugin adoption. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, unlink, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessConventionProof, captureConventionDirectory, proofDigest } from "../fixtures/gradleConventionProof.js";
import { compareJars } from "../fixtures/gradlePluginJarProof.js";
import { assessPluginLoad } from "../fixtures/gradlePluginLoadPolicy.js";
import { readProofFile,sha,verifyDirectorySnapshot,compareDirectoryOrigin,loadBudget } from "../fixtures/gradlePluginLoadProof.js";
const binary=process.env.OSV_MCP_TEST_GRADLE;
const init=fileURLToPath(new URL("../fixtures/gradle-plugin-load.init.gradle",import.meta.url));
const dirs:string[]=[];
afterAll(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
async function digest(file:string){const h=createHash("sha256");for await(const bytes of createReadStream(file,{highWaterMark:1024*1024})) h.update(bytes);return h.digest("hex");}
let toolchainPromise:Promise<any>|undefined;
async function toolchain(){
 return toolchainPromise??=(async()=>{
  const home=path.dirname(path.dirname(await realpath(binary!)));
  const version=(await new Promise<string>((resolve,reject)=>execFile(binary!,["--version"],{env:process.env},(e,out)=>e?reject(e):resolve(out)))).match(/Gradle (\d+\.\d+(?:\.\d+)?)/)![1]!;
  const cache=process.env.GRADLE_USER_HOME??path.join(os.homedir(),".gradle");
  const files:string[]=[];
  for(const dir of [path.join(home,"lib"),path.join(home,"lib/plugins"),path.join(home,"lib/agents")]) for(const name of await readdir(dir)) if(name.endsWith(".jar")) files.push(path.join(dir,name));
  files.push(path.join(cache,"caches",version,"generated-gradle-jars",`gradle-api-${version}.jar`));
  const entries=[];const paths=new Map<string,string>();let bytesRead=0;
  for(const file of files.sort()){
   const {size}=await stat(file);if(size>512*1024**2)throw new Error("toolchain-entry-budget");bytesRead+=size;
   const id=file.startsWith(home)?path.relative(home,file).split(path.sep).join("/"):`generated/gradle-api-${version}.jar`;
   entries.push({id,size,sha256:await digest(file)});paths.set(file,id);
  }
  if(bytesRead>1024**3)throw new Error("toolchain-startup-budget");
  const release=await readFile(path.join(process.env.JAVA_HOME!,"release"),"utf8");
  const javaRuntimeVersion=release.match(/^JAVA_RUNTIME_VERSION="([^"]+)"/m)![1]!;
  return {javaRuntimeVersion,home,profile:{schemaVersion:1,gradleVersion:version,jdk:process.env.JAVA_HOME?.split(path.sep).slice(-3).join("/"),entries},paths,files,bytesRead};
 })();
}
async function fixture(kotlin=false, included=false, kind="binary-java",artifactMode:"jar"|"directory"="jar"):Promise<any>{
 const proofFiles=[fileURLToPath(import.meta.url),init,...["gradleConventionProof.ts","gradlePluginLoadProof.ts","gradlePluginLoadPolicy.ts","gradlePluginJarProof.ts"].map(n=>fileURLToPath(new URL("../fixtures/"+n,import.meta.url)))];
 const proofSources=Object.fromEntries(await Promise.all(proofFiles.map(async f=>[path.basename(f),await digest(f)])));
 const invocationId=randomUUID();
 const prepared=await toolchain();
 const loaderProfile={schemaVersion:1,toolchainProfileDigest:proofDigest(prepared.profile),gradleVersion:prepared.profile.gradleVersion,javaRuntimeVersion:prepared.javaRuntimeVersion,loaderPolicy:"gradle-managed-only",transformPolicy:"operator-attested-pipeline",agents:prepared.profile.entries.filter((e:any)=>e.id.startsWith("lib/agents/")).map((e:any)=>({kind:"javaagent",entryId:e.id,sha256:e.sha256})),attestations:{approvedRuntimeOnly:true,noUnregisteredAgentsOrLoaders:true,artifactsImmutableThroughLoad:true}};
 const loaderDigest=proofDigest(loaderProfile);
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"osv-plugin-load-proof-")));dirs.push(root);
 const producer=included?"build-logic":"buildSrc";
 const source=kind==="precompiled-groovy"?`${producer}/src/main/groovy/proof.convention.gradle`:kind==="binary-kotlin"?`${producer}/src/main/kotlin/proof/Convention.kt`:`${producer}/src/main/java/proof/Convention.java`;
 await mkdir(path.dirname(path.join(root,source)),{recursive:true});
 await mkdir(path.join(root,".proof"));
 await writeFile(path.join(root,"settings.gradle"),`${included?"pluginManagement { includeBuild('build-logic') }":""}\nrootProject.name='convention-proof'\ninclude 'plain','control','registered','script','late','unfinished','failed','duplicate','duplicateClosed'\n`);
 await writeFile(path.join(root,producer,"settings.gradle"),"rootProject.name='logic'\n");
 await writeFile(path.join(root,producer,"build.gradle"),`plugins { id 'java-gradle-plugin' }
gradlePlugin { plugins { convention { id='proof.convention'; implementationClass='proof.Convention' } } }
`);
 await writeFile(path.join(root,source),`package proof;
import org.gradle.api.Plugin;
import org.gradle.api.Project;
import groovy.lang.GroovyObject;
public class Convention implements Plugin<Project> {
 public void apply(Project p) {
  GroovyObject probe=(GroovyObject)p.getExtensions().getByName("osvConventionProbe");
  Object handle=probe.invokeMethod("pluginSource",new Object[]{this,"proof.convention","${source}"});
  probe.invokeMethod("add",new Object[]{"probe","review:parent:1",handle});
  for(String cfg:new String[]{"lazy","unused"}) probe.invokeMethod("addProvider",new Object[]{cfg,p.getProviders().provider(()->{probe.invokeMethod("produced",new Object[]{cfg});return "review:parent:1";}),handle});
  if(p.getName().equals("duplicate")) { Object extra=probe.invokeMethod("pluginSource",new Object[]{this,"proof.convention","${source}"}); probe.invokeMethod("endPlugin",new Object[]{extra,"complete"}); }
  if(!p.getName().equals("unfinished")) probe.invokeMethod("endPlugin",new Object[]{handle,p.getName().equals("failed")?"failed":"complete"});
  if(p.getName().equals("duplicateClosed")) { Object extra=probe.invokeMethod("pluginSource",new Object[]{this,"proof.convention","${source}"}); probe.invokeMethod("endPlugin",new Object[]{extra,"complete"}); }
 }
}
`);
 if(kind==="precompiled-groovy") {
  await writeFile(path.join(root,producer,"build.gradle"),`plugins { id 'groovy-gradle-plugin' }

`);
  await mkdir(path.join(root,producer,"src/main/groovy/proof"),{recursive:true});
  await writeFile(path.join(root,producer,"src/main/groovy/proof/Helper.groovy"),"package proof; class Helper {}\n");
  await writeFile(path.join(root,source),`def probe=extensions.getByName('osvConventionProbe')
def source=probe.beginPrecompiled('proof.convention','${source}')
probe.add('probe','review:parent:1',source)
['lazy','unused'].each { cfg -> probe.addProvider(cfg,providers.provider { probe.produced(cfg);'review:parent:1' },source) }
if(project.name=='duplicate') { def extra=probe.beginPrecompiled('proof.convention','${source}');probe.endPlugin(extra,'complete') }
if(project.name!='unfinished')probe.endPlugin(source,project.name=='failed'?'failed':'complete')
if(project.name=='duplicateClosed') { def extra=probe.beginPrecompiled('proof.convention','${source}');probe.endPlugin(extra,'complete') }
`);
 } else if(kind==="binary-kotlin") {
  await writeFile(path.join(root,source),`package proof
import org.gradle.api.Plugin
import org.gradle.api.Project
import groovy.lang.GroovyObject
class Convention : Plugin<Project> {
 override fun apply(p: Project) {
  val probe=p.extensions.getByName("osvConventionProbe") as GroovyObject
  val handle=probe.invokeMethod("pluginSource",arrayOf(this,"proof.convention","${source}"))
  probe.invokeMethod("add",arrayOf("probe","review:parent:1",handle))
  for (cfg in listOf("lazy","unused")) probe.invokeMethod("addProvider",arrayOf(cfg,p.providers.provider { probe.invokeMethod("produced",arrayOf(cfg)); "review:parent:1" },handle))
  if(p.name=="duplicate") { val extra=probe.invokeMethod("pluginSource",arrayOf(this,"proof.convention","${source}"));probe.invokeMethod("endPlugin",arrayOf(extra,"complete")) }
  if(p.name!="unfinished")probe.invokeMethod("endPlugin",arrayOf(handle,if(p.name=="failed")"failed" else "complete"))
  if(p.name=="duplicateClosed") { val extra=probe.invokeMethod("pluginSource",arrayOf(this,"proof.convention","${source}"));probe.invokeMethod("endPlugin",arrayOf(extra,"complete")) }
 }
}
`);
  await writeFile(path.join(root,producer,"build.gradle"),`plugins { id 'java-gradle-plugin' }
gradlePlugin { plugins { convention { id='proof.convention'; implementationClass='proof.Convention' } } }
def kotlinOutput=layout.buildDirectory.dir('classes/kotlin/main')
def compileKotlin=tasks.register('compileProofKotlin',JavaExec) {
 classpath=fileTree(new File(gradle.gradleHomeDir,'lib')) { include '*.jar' }
 mainClass='org.jetbrains.kotlin.cli.jvm.K2JVMCompiler'
 inputs.file('src/main/kotlin/proof/Convention.kt')
 outputs.dir(kotlinOutput)
 doFirst {
  def libs=fileTree(new File(gradle.gradleHomeDir,'lib')) { include 'kotlin-stdlib-*.jar'; include 'groovy-*.jar' }
  def cp=files(configurations.compileClasspath,libs)
  extensions.extraProperties.set('proofDependencyClasspath',cp)
  args '-no-stdlib','-no-reflect','-jvm-target','17','-classpath',cp.asPath,'-d',kotlinOutput.get().asFile.absolutePath,file('src/main/kotlin/proof/Convention.kt').absolutePath
 }
}
sourceSets.main.output.dir(kotlinOutput,builtBy:compileKotlin)
`);
 }
 if(artifactMode==="directory"){
  const file=path.join(root,producer,"build.gradle");
  await writeFile(file,(await readFile(file,"utf8"))+`
def image=tasks.register('pluginImage',Sync) {
 dependsOn tasks.named('classes')
 from sourceSets.main.output
 into layout.buildDirectory.dir('plugin-image')
}
configurations.runtimeElements.outgoing.artifacts.clear()
artifacts.add('runtimeElements',layout.buildDirectory.dir('plugin-image')) { builtBy image;type='java-classes-directory' }
`);
 }
 const suffix=kotlin?".gradle.kts":".gradle";
 for(const name of ["plain","control","registered","script","late","unfinished","failed","duplicate","duplicateClosed"]){
  await mkdir(path.join(root,name));
  await writeFile(path.join(root,name,`build${suffix}`),kotlin?`import org.gradle.kotlin.dsl.withGroovyBuilder
${name==="script"?"":"plugins { id(\"proof.convention\") }"}
val probe=extensions.getByName("osvConventionProbe")
${name==="late"?'probe.withGroovyBuilder { "prepare"() }':""}
val source=probe.withGroovyBuilder { "scriptSource"("${name}/build${suffix}") }
probe.withGroovyBuilder { "add"("probe","review:parent:1",source) }
`:`${name==="script"?"":"plugins { id 'proof.convention' }"}
def probe=extensions.getByName('osvConventionProbe')
${name==="late"?"probe.prepare()":""}
probe.add('probe','review:parent:1',probe.scriptSource('${name}/build${suffix}'))
`);
 }
 const dest=path.join(root,"repo/review/parent/1");await mkdir(dest,{recursive:true});
 await writeFile(path.join(dest,"parent-1.pom"),"<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>parent</artifactId><version>1</version></project>");
 const inputs=[...(kind==="precompiled-groovy"?[`${producer}/src/main/groovy/proof/Helper.groovy`]:[]),"settings.gradle",`${producer}/settings.gradle`,`${producer}/build.gradle`,source,...["plain","control","registered","script","late","unfinished","failed","duplicate","duplicateClosed"].map(n=>`${n}/build${suffix}`)];
 let inputBytes=0;
 for(const p of inputs){const size=(await stat(path.join(root,p))).size;inputBytes+=size;if(size>4*1024**2 || inputBytes>64*1024**2)throw new Error("plugin-input-budget");}
 const baseline=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,await digest(path.join(root,p))])));
 await writeFile(path.join(root,".proof/baseline.json"),JSON.stringify({inputs:baseline,source,producer,invocationId}));
 const runtimeRoot=await realpath(process.env.GRADLE_USER_HOME??path.join(os.homedir(),".gradle"));
 const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,["-p",root,"-I",init,`-Dosv.convention.root=${root}`,`-Dosv.plugin.runtimeRoot=${runtimeRoot}`,"osvProveConventions","--offline","--no-daemon","--no-configuration-cache","--no-parallel","--no-build-cache","--rerun-tasks","--console=plain","--stacktrace"],{env:process.env,timeout:180000,maxBuffer:4*1024*1024},(e,out,err)=>resolve({code:e?typeof e.code==="number"?e.code:-1:0,output:out+err})));
 expect(result.code,result.output).toBe(0);
 const json=await readFile(path.join(root,"convention-proof.json"),"utf8");const report=JSON.parse(json);
 report.pluginSource=source;report.requiresPlugin=true;report.pluginInputBytes=inputBytes;report.invocationId=invocationId;report.proofSourcesSha256=proofSources;
 for(const f of proofFiles) expect(await digest(f)).toBe(proofSources[path.basename(f)]);
 // This test runner acts as the trusted operator preparing the allowlisted profile.
 const approvedDigest=proofDigest(prepared.profile);let verifiedBytes=0;let unchanged=true;
 for(const file of prepared.files){const entry=prepared.profile.entries.find((e:any)=>e.id===prepared.paths.get(file));verifiedBytes+=entry.size;unchanged&&=await digest(file)===entry.sha256;}
 let observedBytes=0;
 const directoryBudget={bytes:64*1024**2-inputBytes,entries:10000};
 const directorySnapshots=new Map<string,Record<string,string>>();
 for(const b of report.builds) for(const c of b.receipts) for(const e of [...c.classpath,...c.dependencyClasspath]) {
  e.toolchainId=prepared.paths.get(e.path)??null;
  if(e.toolchainId) observedBytes+=e.size;
  else if(!e.sha256 && e.path.startsWith(root+path.sep)) {
   const relative=path.relative(root,e.path).split(path.sep).join("/");
   e.pluginOutputRoot=relative;
   e.pluginOutputs=Object.assign({},...report.builds.flatMap((b:any)=>b.receipts).map((c:any)=>Object.fromEntries(Object.entries(c.outputs).filter(([p])=>p.startsWith(relative+"/")))));
   try {
    if(!directorySnapshots.has(relative)) directorySnapshots.set(relative,await captureConventionDirectory(root,relative,directoryBudget));
    e.currentPluginOutputs=directorySnapshots.get(relative);
   } catch(error) {e.pluginDirectoryError=error instanceof Error?error.message:"directory_capture_failed";}

  }
  delete e.path;
 }
 report.pluginDirectoryCapture={bytesRead:64*1024**2-inputBytes-directoryBudget.bytes,entriesVisited:10000-directoryBudget.entries};
 report.toolchain={profile:prepared.profile,approvedDigest,unchanged,bytesRead:prepared.bytesRead+verifiedBytes+observedBytes,maxBuffer:1024*1024};
 for(const project of Object.values<any>(report.projects)) for(const a of project.applications){
  // Diagnostic URLs only: avoid publishing workstation-specific cache paths.
  a.loadedOrigin=a.loadedOrigin?.startsWith("../")?"outside-boundary/"+path.basename(a.loadedOrigin):a.loadedOrigin;
  if(a.loadedResource) a.loadedResource=a.loadedResource.replaceAll(root,"$FIXTURE").replaceAll(process.env.GRADLE_USER_HOME??path.join(os.homedir(),".gradle"),"$GRADLE_CACHE");
 }
 report.assessment=assessConventionProof(report,{approvedProfiles:new Set([approvedDigest]),pluginTrust:true});
 const observedAgents=report.runtime.vmArguments.map((arg:string)=>{const id=arg.startsWith("-javaagent:")?prepared.paths.get(arg.slice(11)):null;const e=prepared.profile.entries.find((e:any)=>e.id===id);return {kind:"javaagent",entryId:id??"unapproved",sha256:e?.sha256??null};});
 const runtimeConfigMatches=JSON.stringify(observedAgents)===JSON.stringify(loaderProfile.agents)&&report.runtime.javaRuntimeVersion===loaderProfile.javaRuntimeVersion;
 report.runtime={javaRuntimeVersion:report.runtime.javaRuntimeVersion,observedAgents,configMatches:runtimeConfigMatches};
 report.loaderProfile=loaderProfile;report.loaderProfileDigest=loaderDigest;
 const approval={toolchains:new Set([approvedDigest]),loaders:new Set([loaderDigest]),helper:true,trust:"local-plugin-loader-attested-v2" as const};
 const budget=loadBudget();
 for(const p of Object.values<any>(report.projects)) for(const a of p.applications){
  let comparison:"raw-exact"|"entry-content-exact"|"directory-content-exact"|"same-path-origin"|"unverifiable"="unverifiable",snapshotVerified=false;
  if(a.runtimeSnapshotPath&&a.builtJarPath){
   const runtimeBytes=await readProofFile(root,a.runtimeSnapshotPath,budget),builtBytes=await readProofFile(root,a.builtJarPath,budget);
   snapshotVerified=sha(runtimeBytes)===a.runtimeSnapshotSha256;
   comparison=compareJars(builtBytes,runtimeBytes,budget);
  }
  if(a.loadedOriginKind==="directory"&&a.builtDirectoryPath&&a.directoryOriginPath){
   const inside=path.relative(root,a.directoryOriginPath);
   const external=inside.startsWith("..")||path.isAbsolute(inside);
   const originRoot=external?runtimeRoot:root;
   const originRelative=path.relative(originRoot,a.directoryOriginPath).split(path.sep).join("/");
   if(a.originApproved){
    const {comparison:result,ref,snapshot}=await compareDirectoryOrigin(root,a.builtDirectoryPath,originRoot,originRelative,invocationId,budget);
    comparison=result;
    snapshotVerified=true;a.snapshotCapturePhase="post-build";a.directorySnapshotRef=ref;a.directorySnapshotEntries=snapshot.entries;
   }
  }
  const common={applicationId:a.id,registrationForm:a.registrationForm,artifactKind:a.loadedOriginKind,toolchainProfileDigest:approvedDigest,inputsVerified:report.assessment.inputVerified,registrationUnique:a.registrationUnique,originsVerified:p.recordingEnabled&&assessConventionProof({...report,projects:{registered:p}},{approvedProfiles:new Set([approvedDigest]),pluginTrust:true}).originsVerified,constructedThisInvocation:report.builds.some((b:any)=>b.build===producer&&b.invocationId===invocationId&&b.receipts.some((c:any)=>c.type==="compile"&&c.didWork&&!c.failure&&!c.skipped)),instanceMatches:a.instanceMatches,descriptorMatches:a.descriptorMatches,beginBeforeApplied:a.beginBeforeApplied,ended:a.ended,endOutcome:a.endOutcome??"failed",observerFired:a.observerFired,comparison};
  const evidence={...common,loadPolicy:"approved-gradle-loader-v1",loaderProfileDigest:loaderDigest,runtimeConfigMatches,snapshotVerified:snapshotVerified&&a.originApproved,runtimeAttested:true};
  // No public API observes the loader transform here, so strict evidence is rejected by assumption, not by observation.
  const strict={...common,loadPolicy:"prepared-output-only-v1",directLoadObserved:a.loadedOrigin===(a.builtJarPath??a.builtDirectoryPath),unverifiedTransform:true};
  a.loadEvidence=evidence;
  a.policies={attested:assessPluginLoad(evidence,approval),strict:assessPluginLoad(strict,{...approval,loaders:new Set<string>(),trust:"local-plugin-build-v1"})};
  a.declaredIn=a.policies.attested.declarationsComplete?p.candidateSources:[];
  if(a.directoryOriginPath)delete a.directoryOriginPath;
 }

 for(const p of Object.values<any>(report.projects)){
  p.preparedOutputMatchObserved=p.sourceArtifactVerified;delete p.sourceArtifactVerified;
  if(p.applications.length)p.declaredIn=p.recordingEnabled&&p.applications.every((a:any)=>a.policies.attested.declarationsComplete)?p.candidateSources:[];
 }
 delete report.assessment.declaredIn;
 Object.defineProperty(report,"fixtureRoot",{value:root,enumerable:false});
 if(process.env.OSV_MCP_GRADLE_CONVENTION_OUTPUT){
  const output=`${process.env.OSV_MCP_GRADLE_CONVENTION_OUTPUT}-${report.gradleVersion}-${kotlin?"kotlin":"groovy"}-${producer}-${kind}${artifactMode==="directory"?"-directory":""}.json`;
  Object.defineProperty(report,"saveProof",{value:()=>writeFile(output,JSON.stringify(report,null,2)+"\n"),enumerable:false});await report.saveProof();
 }
 return report;
}
const cases=[...[false,true].flatMap(included=>["binary-java","binary-kotlin","precompiled-groovy"].map(kind=>({included,kind,artifactMode:"jar" as const}))),...[false,true].map(included=>({included,kind:"binary-java",artifactMode:"directory" as const}))];
for(const kotlin of [false,true])for(const item of cases)describe.skipIf(!binary)(`Revised plugin load (${kotlin?"Kotlin":"Groovy"}, ${item.included?"included":"buildSrc"}, ${item.kind}, ${item.artifactMode})`,()=>{
 let r:any;
 beforeAll(async()=>{r=await fixture(kotlin,item.included,item.kind,item.artifactMode);},210000);
 it("binds the pending/binary source handle to the actual public Plugin and descriptor",()=>{
  const a=r.projects.registered.applications[0];
  expect(a.instanceMatches).toBe(true);expect(a.descriptorMatches).toBe(true);
  expect(a.beginBeforeApplied).toBe(true);expect(a.ended).toBe(true);expect(a.endOutcome).toBe("complete");expect(a.observerFired).toBe(true);
  expect(r.projects.registered.applicationEvents).toEqual([`begin:${a.registrationForm}`,"end:complete","after-apply"]);
 });
 it("adopts only under the independently approved loader-attested policy",()=>{
  const a=r.projects.registered.applications[0];
  expect(a.policies.attested.declarationsComplete).toBe(true);
  expect(a.policies.attested.assurance).toBe("author-attested-loader-and-structurally-checked");
  expect(a.policies.attested.limitations).toContain("plugin_loaded_bytes_not_independently_observed");
  expect(a.policies.strict.declarationsComplete).toBe(false);
  expect(a.declaredIn).toHaveLength(2);
  expect(r.runtime.configMatches).toBe(true);
 });
 it.each(["duplicate","duplicateClosed"])("rejects repeated begin even when every session ends: %s",name=>{
  const p=r.projects[name];expect(p.applications).toHaveLength(2);
  for(const a of p.applications){expect(a.ended).toBe(true);expect(a.endOutcome).toBe("complete");expect(a.policies.attested.inputVerified).toBe(true);expect(a.policies.attested.declarationsComplete).toBe(false);}
  expect(p.declaredIn).toEqual([]);
 });
 it("records actual load observation and snapshot capture phases",()=>{
  for(const p of Object.values<any>(r.projects))for(const a of p.applications){
   expect(a.loadObservationPhase).toBe("verification-task");
   expect(a.snapshotCapturePhase).toBe(item.artifactMode==="directory"?"post-build":"verification-task");
   if(a.directorySnapshotRef)expect(a.directorySnapshotRef.capturePhase).toBe("post-build");
  }
 });
 it("checks all native artifact contents, including directory container round-trip",()=>{
  const a=r.projects.registered.applications[0];
  expect(a.loadEvidence.snapshotVerified).toBe(true);
  if(item.artifactMode==="directory"){
   // The public directory artifact is loaded from the prepared output itself, so no independent content comparison happens.
   expect(a.loadedOriginKind).toBe("directory");expect(a.loadEvidence.comparison).toBe("same-path-origin");expect(a.directorySnapshotEntries.length).toBeGreaterThan(0);
   expect(a.policies.attested.limitations).toEqual(expect.arrayContaining(["plugin_directory_snapshot_post_build","plugin_directory_origin_same_path_not_compared"]));
  }else expect(["raw-exact","entry-content-exact"]).toContain(a.loadEvidence.comparison);
 });
 it.each(["late","unfinished","failed","duplicate","duplicateClosed"])("keeps an invalid registration session incomplete: %s",name=>{
  const a=r.projects[name].applications[0];
  expect(a.policies.attested.inputVerified).toBe(true);
  expect(a.policies.attested.declarationsComplete).toBe(false);
  expect(a.policies.attested.reasons).toContain("plugin_registration_incomplete");
  expect(a.declaredIn).toEqual([]);
 });
 it("preserves original graph, Action phases, Provider counts and an unused Provider",()=>{
  for(const name of ["control","registered"]){expect(r.projects[name].graph).toEqual(r.projects.plain.graph);expect(r.projects[name].trace).toEqual(r.projects.plain.trace);expect(r.projects[name].producerCalls).toEqual({lazy:1});}
  expect(r.projects.registered.providerRecords.map((p:any)=>[p.id,p.callbacks])).toEqual([["p0",1],["p1",0]]);
  expect(r.projects.registered.applications[0].expectedRecordIds).toEqual(["r0","p0","p1"]);
  expect(r.projects.script.applications).toEqual([]);expect(r.projects.script.declaredIn).toHaveLength(1);
 });
 it.each(["disabled","local-plugin-build-v1"])("withholds attested declarations under trust=%s",trust=>{
  const e=r.projects.registered.applications[0].loadEvidence;
  const result=assessPluginLoad(e,{toolchains:new Set([e.toolchainProfileDigest]),loaders:new Set([e.loaderProfileDigest]),helper:true,trust:trust as any});
  expect(result.inputVerified).toBe(true);expect(result.declarationsComplete).toBe(false);
 });
 it("rejects a missing loader profile without changing the runtime observations",()=>{
  const e=r.projects.registered.applications[0].loadEvidence;
  expect(assessPluginLoad(e,{toolchains:new Set([e.toolchainProfileDigest]),loaders:new Set(),helper:true,trust:"local-plugin-loader-attested-v2"}).inputVerified).toBe(false);
 });
 if(item.artifactMode==="directory")it.each(["changed","deleted","extra"])("rejects directory snapshot tampering on disk: %s",async mutation=>{
  const a=r.projects.registered.applications[0],ref=a.directorySnapshotRef;
  const entry=a.directorySnapshotEntries.find((e:any)=>e.kind==="file"),base=path.join(r.fixtureRoot,path.dirname(ref.manifestPath),"blobs");
  const file=path.join(base,entry.sha256),before=await readFile(file),extra=path.join(base,"0".repeat(64));
  try{
   if(mutation==="changed")await writeFile(file,"tampered");if(mutation==="deleted")await unlink(file);if(mutation==="extra")await writeFile(extra,"extra");
   await expect(verifyDirectorySnapshot(r.fixtureRoot,ref)).rejects.toThrow(mutation==="changed"?"snapshot_blob_mismatch":"snapshot_storage_mismatch");
  }finally{if(mutation==="extra")await rm(extra,{force:true});else await writeFile(file,before);}
  await expect(verifyDirectorySnapshot(r.fixtureRoot,ref)).resolves.toBeDefined();
  (r.snapshotMutationChecks??=[]).push({mutation,rejected:true,restoredAndVerified:true});await r.saveProof?.();
 });
 else it("rejects a modified JAR snapshot instead of retaining the original verification flag",async()=>{
  const a=r.projects.registered.applications[0],file=path.join(r.fixtureRoot,a.runtimeSnapshotPath),before=await readFile(file);
  try{
   await writeFile(file,Buffer.concat([before,Buffer.from([0])]));
   const current=await readProofFile(r.fixtureRoot,a.runtimeSnapshotPath);
   expect(sha(current)).not.toBe(a.runtimeSnapshotSha256);
   expect(()=>compareJars(before,current)).toThrow();
   const e={...a.loadEvidence,snapshotVerified:sha(current)===a.runtimeSnapshotSha256};
   expect(assessPluginLoad(e,{toolchains:new Set([e.toolchainProfileDigest]),loaders:new Set([e.loaderProfileDigest]),helper:true,trust:"local-plugin-loader-attested-v2"}).inputVerified).toBe(false);
  }finally{await writeFile(file,before);}
  (r.snapshotMutationChecks??=[]).push({mutation:"jar-bytes",rejected:true,restoredAndVerified:sha(await readProofFile(r.fixtureRoot,a.runtimeSnapshotPath))===a.runtimeSnapshotSha256});await r.saveProof?.();
 });
 it("does not confuse producer builds or invocation receipts",()=>{
  expect(r.builds.every((b:any)=>b.invocationId===r.invocationId)).toBe(true);expect(r.inputs.changed).toEqual([]);
 });
});
