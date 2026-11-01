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
import { compareJars, jarContents } from "../fixtures/gradlePluginJarProof.js";
import { assessPipelinePackage,verifyPipelineContent,manifestLiteral,checkLiteralBinding,mappingDecision } from "../fixtures/gradleKotlinPipelineProof.js";
import { assessKotlinStages } from "../fixtures/gradleKotlinProof.js";
import { assessPluginLoad } from "../fixtures/gradlePluginLoadPolicy.js";
import { readProofFile,sha,verifyDirectorySnapshot,compareDirectoryOrigin,loadBudget } from "../fixtures/gradlePluginLoadProof.js";
const binary=process.env.OSV_MCP_TEST_GRADLE;
const init=fileURLToPath(new URL("../fixtures/gradle-kotlin-plugin.init.gradle",import.meta.url));
const pipelineMode=process.env.OSV_MCP_KOTLIN_PIPELINE_PROOF==="1";
const pipelineInit=fileURLToPath(new URL("../fixtures/gradle-kotlin-pipeline.init.gradle",import.meta.url));
const dirs:string[]=[];
afterAll(async()=>{for(const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true});});
async function digest(file:string){const h=createHash("sha256");for await(const bytes of createReadStream(file,{highWaterMark:1024*1024})) h.update(bytes);return h.digest("hex");}
let toolchainPromise:Promise<any>|undefined;
async function toolchain(){
 return toolchainPromise??=(async()=>{
  const home=path.dirname(path.dirname(await realpath(binary!)));
  const version=(await new Promise<string>((resolve,reject)=>execFile(binary!,["--version"],{env:process.env},(e,out)=>e?reject(e):resolve(out)))).match(/Gradle (\d+\.\d+(?:\.\d+)?)/)![1]!;
  const cache=await realpath(process.env.GRADLE_USER_HOME??path.join(os.homedir(),".gradle"));
  const jdk=await realpath(process.env.JAVA_HOME!);
  const files:string[]=[];
  for(const dir of [path.join(home,"lib"),path.join(home,"lib/plugins"),path.join(home,"lib/agents")]) for(const name of await readdir(dir)) if(name.endsWith(".jar")) files.push(path.join(dir,name));
  files.push(path.join(cache,"caches",version,"generated-gradle-jars",`gradle-api-${version}.jar`));
  for(const group of ["org.jetbrains.kotlinx","org.jetbrains.kotlin","org.gradle.kotlin","org.jetbrains.intellij.deps","org.jetbrains","org.jetbrains.kotlin.jvm","org.gradle.kotlin.kotlin-dsl"]) {
   const base=path.join(cache,"caches/modules-2/files-2.1",group);
   async function walk(dir:string):Promise<void>{let items;try{items=await readdir(dir,{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}for(const item of items){const f=path.join(dir,item.name);if(item.isDirectory())await walk(f);else if(item.isFile()&&item.name.endsWith(".jar"))files.push(f);}}
   await walk(base);
  }
  for(const file of ['bin/java','lib/modules','release'])files.push(path.join(jdk,file));
  const entries=[];const paths=new Map<string,string>();let bytesRead=0;
  for(const file of files.sort()){
   const {size}=await stat(file);if(size>512*1024**2)throw new Error("toolchain-entry-budget");bytesRead+=size;
   const id=file.startsWith(home)?path.relative(home,file).split(path.sep).join("/"):file.startsWith(jdk+path.sep)?"jdk/"+path.relative(jdk,file):file.includes("/modules-2/files-2.1/")?"kotlin-dependency/"+file.split("/modules-2/files-2.1/")[1]:`generated/gradle-api-${version}.jar`;
   entries.push({id,size,sha256:await digest(file)});paths.set(await realpath(file),id);
  }
  if(bytesRead>1024**3)throw new Error("toolchain-startup-budget");
  const release=await readFile(path.join(process.env.JAVA_HOME!,"release"),"utf8");
  const javaRuntimeVersion=release.match(/^JAVA_RUNTIME_VERSION="([^"]+)"/m)![1]!;
  return {javaRuntimeVersion,home,profile:{schemaVersion:1,gradleVersion:version,jdk:jdk.split(path.sep).slice(-3).join("/"),entries},paths,files,bytesRead};
 })();
}
async function fixture(kotlin=false, included=false, kind="binary-java",artifactMode:"jar"|"directory"="jar",replaceClass=false):Promise<any>{
 const proofFiles=[fileURLToPath(import.meta.url),init,...(pipelineMode?[pipelineInit,fileURLToPath(new URL("../fixtures/gradleKotlinPipelineProof.ts",import.meta.url))]:[]),...["gradleConventionProof.ts","gradlePluginLoadProof.ts","gradlePluginLoadPolicy.ts","gradlePluginJarProof.ts","gradleKotlinProof.ts"].map(n=>fileURLToPath(new URL("../fixtures/"+n,import.meta.url)))];
 const proofSources=Object.fromEntries(await Promise.all(proofFiles.map(async f=>[path.basename(f),await digest(f)])));
 const invocationId=randomUUID();
 const prepared=await toolchain();
 const loaderProfile={schemaVersion:1,toolchainProfileDigest:proofDigest(prepared.profile),gradleVersion:prepared.profile.gradleVersion,javaRuntimeVersion:prepared.javaRuntimeVersion,loaderPolicy:"gradle-managed-only",transformPolicy:"operator-attested-pipeline",agents:prepared.profile.entries.filter((e:any)=>e.id.startsWith("lib/agents/")).map((e:any)=>({kind:"javaagent",entryId:e.id,sha256:e.sha256})),attestations:{approvedRuntimeOnly:true,noUnregisteredAgentsOrLoaders:true,artifactsImmutableThroughLoad:true}};
 const loaderDigest=proofDigest(loaderProfile);
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"osv-kotlin-plugin-proof-")));dirs.push(root);
 const producer=included?"build-logic":"buildSrc";
 const source=kind==="precompiled-kotlin"?`${producer}/src/main/kotlin/proof.convention.gradle.kts`:kind==="binary-kotlin"?`${producer}/src/main/kotlin/proof/Convention.kt`:`${producer}/src/main/java/proof/Convention.java`;
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
 await writeFile(path.join(root,producer,"build.gradle.kts"),`plugins { \`kotlin-dsl\` }
repositories { mavenCentral();gradlePluginPortal() }
if (providers.gradleProperty("osvProofReplaceClass").orNull=="true") {
 tasks.named<Jar>("jar") { doFirst {
  val targets=fileTree(layout.buildDirectory.dir("classes/kotlin/main")) { include("**/*PackageMarker.class") }.files
  check(targets.size==1)
  val file=targets.single()
  val text=file.readBytes().toString(Charsets.ISO_8859_1)
  check(text.contains("original-marker"))
  file.writeBytes(text.replace("original-marker","modified-marker").toByteArray(Charsets.ISO_8859_1))
 } }
}
${kind==="binary-kotlin"?'gradlePlugin { plugins { create("convention") { id="proof.convention";implementationClass="proof.Convention" } } }':''}
`);
 await unlink(path.join(root,producer,"build.gradle"));
 if(kind==="precompiled-kotlin") {
  await writeFile(path.join(root,source),`import groovy.lang.GroovyObject
plugins { java }
val probe=extensions.getByName("osvConventionProbe") as GroovyObject
val source=probe.invokeMethod("beginPrecompiled",arrayOf("proof.convention","${source}"))
probe.invokeMethod("add",arrayOf("probe","review:parent:1",source))
for (cfg in listOf("lazy","unused")) probe.invokeMethod("addProvider",arrayOf(cfg,providers.provider { probe.invokeMethod("produced",arrayOf(cfg)); "review:parent:1" },source))
if(project.name=="duplicate") { val extra=probe.invokeMethod("beginPrecompiled",arrayOf("proof.convention","${source}"));probe.invokeMethod("endPlugin",arrayOf(extra,"complete")) }
if(project.name!="unfinished") probe.invokeMethod("endPlugin",arrayOf(source,if(project.name=="failed")"failed" else "complete"))
if(project.name=="duplicateClosed") { val extra=probe.invokeMethod("beginPrecompiled",arrayOf("proof.convention","${source}"));probe.invokeMethod("endPlugin",arrayOf(extra,"complete")) }
`);
 } else {
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
 }
 await writeFile(path.join(root,source),(await readFile(path.join(root,source),'utf8'))+'\nclass PackageMarker { fun marker()="original-marker" }\n');
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
 if(pipelineMode){
  for(const [name,body]of [["settings.txt","proof-resource\n"],["META-INF/services/proof.Service","proof.Implementation\n"]]){
   const f=path.join(root,producer,"src/main/resources",name!);await mkdir(path.dirname(f),{recursive:true});await writeFile(f,body!);
  }
 }
 const inputs=[...(pipelineMode?[`${producer}/src/main/resources/settings.txt`,`${producer}/src/main/resources/META-INF/services/proof.Service`]:[]),"settings.gradle",`${producer}/settings.gradle`,`${producer}/build.gradle.kts`,source,...["plain","control","registered","script","late","unfinished","failed","duplicate","duplicateClosed"].map(n=>`${n}/build${suffix}`)];
 let inputBytes=0;
 for(const p of inputs){const size=(await stat(path.join(root,p))).size;inputBytes+=size;if(size>4*1024**2 || inputBytes>64*1024**2)throw new Error("plugin-input-budget");}
 const baseline=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,await digest(path.join(root,p))])));
 await writeFile(path.join(root,".proof/baseline.json"),JSON.stringify({inputs:baseline,source,producer,invocationId}));
 const runtimeRoot=await realpath(process.env.GRADLE_USER_HOME??path.join(os.homedir(),".gradle"));
 const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,["-p",root,"-I",init,...(pipelineMode?["-I",pipelineInit,"-Pkotlin.incremental=false","-Pkotlin.daemon.useFallbackStrategy=false"]:[]),`-Dosv.convention.root=${root}`,`-Dosv.plugin.runtimeRoot=${runtimeRoot}`,"osvProveConventions",...(replaceClass?["-PosvProofReplaceClass=true"]:[]),"--offline","--max-workers=2","-Pkotlin.compiler.execution.strategy=in-process","--no-daemon","--no-configuration-cache","--no-parallel","--no-build-cache","--rerun-tasks","--console=plain","--stacktrace"],{env:process.env,timeout:240000,maxBuffer:4*1024*1024},(e,out,err)=>resolve({code:e?typeof e.code==="number"?e.code:-1:0,output:out+err})));
 expect(result.code,result.output).toBe(0);
 const json=await readFile(path.join(root,"convention-proof.json"),"utf8");const report=JSON.parse(json);
 report.nativePackageMutation=replaceClass;report.pathAliases={cache:process.env.GRADLE_USER_HOME!==runtimeRoot,jdk:process.env.JAVA_HOME!==await realpath(process.env.JAVA_HOME!)};report.pluginSource=source;report.requiresPlugin=true;report.pluginInputBytes=inputBytes;report.invocationId=invocationId;report.proofSourcesSha256=proofSources;
 for(const f of proofFiles) expect(await digest(f)).toBe(proofSources[path.basename(f)]);
 // This test runner acts as the trusted operator preparing the allowlisted profile.
 const approvedDigest=proofDigest(prepared.profile);let verifiedBytes=0;let unchanged=true;
 for(const file of prepared.files){const canonical=await realpath(file);const entry=prepared.profile.entries.find((e:any)=>e.id===prepared.paths.get(canonical));verifiedBytes+=entry.size;unchanged&&=await digest(file)===entry.sha256;}
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
 report.toolchain={profile:prepared.profile,approvedDigest,unchanged,bytesRead:prepared.bytesRead+verifiedBytes+report.builds.reduce((n:number,b:any)=>n+b.observedFileBytesRead,0),maxBuffer:1024*1024};
 for(const project of Object.values<any>(report.projects)) for(const a of project.applications){
  // Diagnostic URLs only: avoid publishing workstation-specific cache paths.
  a.loadedOrigin=a.loadedOrigin?.startsWith("../")?"outside-boundary/"+path.basename(a.loadedOrigin):a.loadedOrigin;
  if(a.loadedResource) a.loadedResource=a.loadedResource.replaceAll(root,"$FIXTURE").replaceAll(runtimeRoot,"$GRADLE_CACHE");
 }
 for(const b of report.builds)for(const r of b.receipts)for(const e of r.externalInputObservations??[]){
  e.toolchainId=prepared.paths.get(e.path)??null;
  e.observation=e.toolchainId?'approved-toolchain':'derived-or-unapproved-task-input';
  e.path=e.path.replaceAll(root,'$FIXTURE').replaceAll(runtimeRoot,'$GRADLE_CACHE').replaceAll(prepared.home,'$GRADLE_HOME');
 }
 const packageReceipt=report.builds.find((b:any)=>b.build===producer)?.receipts.find((r:any)=>r.task===':jar'&&r.didWork&&!r.skipped&&!r.failure);
 const packageBytes=await readProofFile(root,packageReceipt.archivePath,loadBudget());
 report.kotlinPackage={producer,invocationId,archivePath:packageReceipt.archivePath,sha256:sha(packageBytes),entries:jarContents(packageBytes,loadBudget())};
 if(pipelineMode){
  report.pipeline=JSON.parse(await readFile(path.join(root,`.proof/pipeline-${producer}.json`),"utf8"));
  report.pipeline.package=assessPipelinePackage(report,producer);
  const budget={bytes:256*1024**2,refs:4096};
  for(const t of report.pipeline.receipts){
   for(const e of t.snapshots??[])await verifyPipelineContent(root,e.content,true,budget);
   if(t.manifest)await verifyPipelineContent(root,t.manifest,false,budget);
   for(const e of [...t.libraries??[],...t.compilerClasspath??[]]){
    e.toolchainId=prepared.paths.get(e.path)??null;
    const approved=prepared.profile.entries.find((x:any)=>x.id===e.toolchainId);
    e.approved=!!approved&&approved.sha256===e.sha256&&approved.size===e.size;
   }
   for(const e of t.selectedPlugins??[]){
    const f=e.origin?.startsWith("file:")?await realpath(fileURLToPath(e.origin)):null;
    e.toolchainId=f?prepared.paths.get(f)??null:null;
    e.origin=e.origin?.replaceAll(runtimeRoot,"$GRADLE_CACHE").replaceAll(prepared.home,"$GRADLE_HOME");
   }
   // Paths remain diagnostic only; static validation reads the bounded content store.
   for(const e of [...t.libraries??[],...t.snapshots??[],...t.compilerClasspath??[]])e.path=e.path.replaceAll(runtimeRoot,"$GRADLE_CACHE").replaceAll(prepared.home,"$GRADLE_HOME");
   if(t.publicInputPaths)t.publicInputPaths=t.publicInputPaths.map((p:string)=>p.replaceAll(root,"$FIXTURE").replaceAll(runtimeRoot,"$GRADLE_CACHE").replaceAll(prepared.home,"$GRADLE_HOME"));
  }
  report.pipeline.storageVerified=true;
  report.pipeline.limitations=["test_only_no_production_adoption","aggregate_not_per_jar_mapping","snapshot_supplier_trace_not_independently_observed","full_v4_schema_and_trust_parser_not_implemented"];
  report.pipeline.recipeStatus=kind==='precompiled-kotlin'&&report.gradleVersion==='9.2.1'?'kotlin_pipeline_recipe_unsupported':'candidate-public-collection-observed';
 }
 report.kotlinStages=assessKotlinStages(report,producer,source,kind==='precompiled-kotlin');
 report.assessment=assessConventionProof(report,{approvedProfiles:new Set([approvedDigest]),pluginTrust:true});
 const observedAgents=await Promise.all(report.runtime.vmArguments.map(async(arg:string)=>{const id=arg.startsWith("-javaagent:")?prepared.paths.get(await realpath(arg.slice(11))):null;const e=prepared.profile.entries.find((e:any)=>e.id===id);return {kind:"javaagent",entryId:id??"unapproved",sha256:e?.sha256??null};}));
 const jdkHomeMatches=await realpath(report.runtime.javaHome)===await realpath(process.env.JAVA_HOME!);
 const runtimeConfigMatches=jdkHomeMatches&&JSON.stringify(observedAgents)===JSON.stringify(loaderProfile.agents)&&report.runtime.javaRuntimeVersion===loaderProfile.javaRuntimeVersion;
 report.runtime={jdkHomeMatches,javaRuntimeVersion:report.runtime.javaRuntimeVersion,observedAgents,configMatches:runtimeConfigMatches};
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
  const common={applicationId:a.id,registrationForm:a.registrationForm,artifactKind:a.loadedOriginKind,toolchainProfileDigest:approvedDigest,inputsVerified:report.assessment.inputVerified&&report.kotlinStages.complete,registrationUnique:a.registrationUnique,originsVerified:p.recordingEnabled&&assessConventionProof({...report,projects:{registered:p}},{approvedProfiles:new Set([approvedDigest]),pluginTrust:true}).originsVerified,constructedThisInvocation:report.builds.some((b:any)=>b.build===producer&&b.invocationId===invocationId&&b.receipts.some((c:any)=>c.type==="compile"&&c.didWork&&!c.failure&&!c.skipped)),instanceMatches:a.instanceMatches,descriptorMatches:a.descriptorMatches,beginBeforeApplied:a.beginBeforeApplied,ended:a.ended,endOutcome:a.endOutcome??"failed",observerFired:a.observerFired,comparison};
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
 if(process.env.OSV_MCP_GRADLE_KOTLIN_OUTPUT){
  const output=`${process.env.OSV_MCP_GRADLE_KOTLIN_OUTPUT}-${report.gradleVersion}-${kotlin?"kotlin":"groovy"}-${producer}-${kind}${artifactMode==="directory"?"-directory":""}${replaceClass?"-package-tampered":""}.json`;
  Object.defineProperty(report,"saveProof",{value:()=>writeFile(output,JSON.stringify(report,null,2)+"\n"),enumerable:false});await report.saveProof();
 }
 return report;
}
const cases=[false,true].flatMap(included=>["binary-kotlin","precompiled-kotlin"].map(kind=>({included,kind,artifactMode:"jar" as "jar"|"directory"})));
for(const kotlin of [false,true])for(const item of cases)describe.skipIf(!binary)(`Standard Kotlin plugin (${kotlin?"Kotlin":"Groovy"}, ${item.included?"included":"buildSrc"}, ${item.kind}, ${item.artifactMode})`,()=>{
 let r:any;
 beforeAll(async()=>{r=await fixture(kotlin,item.included,item.kind,item.artifactMode);},270000);
 if(pipelineMode){
 it("captures the public ordered snapshot collection without inferring per-JAR mapping",()=>{
  const c=r.pipeline.receipts.find((t:any)=>t.task===":compileKotlin");
  expect(c.incremental).toBe(false);expect(c.executionStrategy).toBe("IN_PROCESS");expect(c.fallback).toBe(false);
  expect(c.before.classFiles).toEqual([]);expect(c.before.javaSources).toEqual([]);
  expect(c.libraries.length).toBeGreaterThan(0);expect(c.libraries.every((e:any)=>e.approved)).toBe(true);
  expect(c.compilerClasspath.every((e:any)=>e.approved)).toBe(true);
  expect(c.snapshots.length).toBeGreaterThan(0);
  expect(c.snapshots.every((e:any)=>c.publicInputPaths.includes(e.path))).toBe(true);
  expect(c.selectedPlugins.filter((e:any)=>/KotlinPluginWrapper|KotlinDslPlugin_Decorated/.test(e.type)).every((e:any)=>e.toolchainId)).toBe(true);
  expect(r.pipeline.storageVerified).toBe(true);expect(r.pipeline.maxBuffer).toBe(1024**2);
  expect(Math.max(...c.snapshots.map((e:any)=>e.content.size))).toBeGreaterThan(18*1000**2);
 });
 it("binds the post-task temporary MANIFEST to the fixed literal and package input slot",()=>{
  const j=r.pipeline.receipts.find((t:any)=>t.task===":jar");
  expect(j.manifest.sha256).toBe(sha(manifestLiteral));
  expect(r.kotlinPackage.entries.find((e:any)=>e.path==='META-INF/MANIFEST.MF').sha256).toBe(sha(manifestLiteral));
  expect(checkLiteralBinding({recipe:j.recipe,stage:j.task,slot:'manifest',temporaryRoot:j.temporaryRoot,path:j.manifestPath,publicInputs:j.publicInputs,input:manifestLiteral,entry:manifestLiteral})).toEqual([]);
  expect(Object.keys(r.inputs.baseline)).not.toContain(j.manifestPath);
  expect(r.builds.flatMap((b:any)=>b.receipts).filter((t:any)=>t.task!==':jar').some((t:any)=>t.outputs[j.manifestPath])).toBe(false);
 });
 it("covers Kotlin module metadata, descriptors, resources, services and all package entries",()=>{
  expect(r.pipeline.package.complete,JSON.stringify(r.pipeline.package)).toBe(true);
  expect(r.pipeline.package.inventory.length).toBe(r.kotlinPackage.entries.length);
  expect(r.pipeline.package.inventory.map((e:any)=>e.path)).toEqual(expect.arrayContaining(['settings.txt','META-INF/services/proof.Service','META-INF/gradle-plugins/proof.convention.properties']));
  const d=r.pipeline.receipts.find((t:any)=>t.task===":pluginDescriptors");
  const a=r.projects.registered.applications[0];
  expect(d.descriptors).toEqual([{id:'proof.convention',implementationClass:a.implementationClass}]);
  const generated=r.builds.find((b:any)=>b.build===r.pipeline.producer).receipts.find((t:any)=>t.task===':pluginDescriptors');
  expect(generated.outputs[r.pipeline.producer+'/build/pluginDescriptors/proof.convention.properties']).toBe(sha(Buffer.from(`implementation-class=${a.implementationClass}\n`)));
 });
 it.each(['metadata','descriptor','resource','service','manifest','extra'])('rejects nonclass package mutations: %s',kind=>{
  const changed=structuredClone(r);
  const suffix=({metadata:'.kotlin_module',descriptor:'proof.convention.properties',resource:'settings.txt',service:'proof.Service',manifest:'MANIFEST.MF'} as Record<string,string>)[kind];
  if(kind==='extra')changed.kotlinPackage.entries.push({path:'unowned.txt',sha256:'0'.repeat(64)});
  else changed.kotlinPackage.entries.find((e:any)=>e.path.endsWith(suffix)).sha256='0'.repeat(64);
  const result=assessPipelinePackage(changed,r.pipeline.producer);
  expect(result.complete).toBe(false);expect(result.reasons).toContain(kind==='extra'?'kotlin_package_origin_incomplete':'kotlin_package_entry_mismatch');
 });
 it.each(['META-INF/MANIFEST.MF','settings.txt','META-INF/services/proof.Service','META-INF/gradle-plugins/proof.convention.properties','.kotlin_module','.class'])('rejects an expected entry omitted from the package: %s',async suffix=>{
  const changed=structuredClone(r),producer=r.pipeline.producer;
  const entry=changed.kotlinPackage.entries.find((e:any)=>e.path.endsWith(suffix));
  expect(entry).toBeDefined();
  changed.kotlinPackage.entries=changed.kotlinPackage.entries.filter((e:any)=>e.path!==entry.path);
  if(!['META-INF/MANIFEST.MF','.kotlin_module','.class'].includes(suffix)){
   const output=producer+'/build/resources/main/'+entry.path;
   for(const t of changed.builds.find((b:any)=>b.build===producer).receipts){delete t.outputs[output];delete t.declaredInputs[output];}
  }
  const result=assessPipelinePackage(changed,producer);
  expect(result.complete).toBe(false);expect(result.reasons).toContain('kotlin_package_origin_incomplete');
  // Persist the observed decision, not the expected constant, so the consolidator can recheck it.
  (r.pipeline.expectedEntryRejections??=[]).push({suffix,complete:result.complete,reasons:result.reasons});
  await r.saveProof?.();
 });
 it("records Java NO-SOURCE independently and refuses an unproved plugins-block collection",()=>{
  const j=r.pipeline.receipts.find((t:any)=>t.task===":compileJava");
  expect(j.noSource).toBe(true);expect(j.before.javaSources).toEqual([]);expect(j.javaOutputs).toEqual([]);
  expect(r.pipeline.recipeStatus).toBe(item.kind==='precompiled-kotlin'&&r.gradleVersion==='9.2.1'?'kotlin_pipeline_recipe_unsupported':'candidate-public-collection-observed');
 });
 it.each(['changed','deleted'])('revalidates persisted snapshot bytes after export: %s',async mutation=>{
  const ref=r.pipeline.receipts.find((t:any)=>t.task===":compileKotlin").snapshots[0].content;
  const f=path.join(r.fixtureRoot,'.proof/pipeline-blobs',ref.chunks[0].sha256),bytes=await readFile(f);
  try{if(mutation==='changed')await writeFile(f,Buffer.alloc(bytes.length));else await unlink(f);
   await expect(verifyPipelineContent(r.fixtureRoot,ref,true)).rejects.toThrow('kotlin_pipeline_snapshot_storage_mismatch');
  }finally{await writeFile(f,bytes);}
  await verifyPipelineContent(r.fixtureRoot,ref,true);
 });
 }
 it("observes the real standard Kotlin compile and precompiled generation tasks",()=>{
  const tasks=r.builds.filter((b:any)=>b.build===(item.included?'build-logic':'buildSrc')).flatMap((b:any)=>b.receipts);
  expect(tasks.some((t:any)=>t.task===':compileKotlin'&&t.type==='compile'&&t.didWork&&!t.failure)).toBe(true);
  expect(r.kotlinStages.complete,JSON.stringify(r.kotlinStages)).toBe(true);
  if(item.kind==='precompiled-kotlin'){
   expect(r.kotlinStages.adapterPaths.length).toBeGreaterThan(0);
   for(const name of ['extractPrecompiledScriptPluginPlugins','compilePluginsBlocks','generatePrecompiledScriptPluginAccessors','generateScriptPluginAdapters','generateExternalPluginSpecBuilders'])expect(tasks.some((t:any)=>t.task===':'+name&&t.didWork&&!t.failure),name).toBe(true);
   expect(r.projects.registered.declaredIn).not.toEqual(expect.arrayContaining(r.kotlinStages.adapterPaths));
  }
 });
 it.each([['compile-hash','kotlin_compile_package_mismatch'],['package-input','kotlin_compile_package_mismatch'],['jar-entry','kotlin_compile_package_mismatch'],['loaded-class','kotlin_loaded_class_mismatch'],['extra-class','kotlin_package_class_set_mismatch']])('rejects broken compile-to-package correspondence: %s',(mutation,reason)=>{
  const changed=structuredClone(r),producer=item.included?'build-logic':'buildSrc',tasks=changed.builds.find((b:any)=>b.build===producer).receipts;
  const compile=tasks.find((t:any)=>t.task===':compileKotlin'),jar=tasks.find((t:any)=>t.task===':jar');
  const entry=changed.kotlinPackage.entries.find((e:any)=>e.path.endsWith('.class')),file=producer+'/build/classes/kotlin/main/'+entry.path;
  if(mutation==='compile-hash')compile.outputs[file]='0'.repeat(64);
  if(mutation==='package-input')jar.declaredInputs[file]='0'.repeat(64);
  if(mutation==='jar-entry')entry.sha256='0'.repeat(64);
  if(mutation==='loaded-class')changed.projects.registered.applications[0].loadedClassSha256='0'.repeat(64);
  if(mutation==='extra-class')changed.kotlinPackage.entries.push({path:'Extra.class',sha256:'0'.repeat(64),size:1});
  const result=assessKotlinStages(changed,producer,r.pluginSource,item.kind==='precompiled-kotlin');
  expect(result.complete).toBe(false);
  expect(result.reasons).toContain(reason);
 });
 it("binds the pending/binary source handle to the actual public Plugin and descriptor",()=>{
  const a=r.projects.registered.applications[0];
  expect(a.instanceMatches).toBe(true);expect(a.descriptorMatches).toBe(true);
  expect(a.beginBeforeApplied).toBe(true);expect(a.ended).toBe(true);expect(a.endOutcome).toBe("complete");expect(a.observerFired).toBe(true);
  expect(r.projects.registered.applicationEvents).toEqual([`begin:${a.registrationForm}`,"end:complete","after-apply"]);
 });
 it("classifies a test-only candidate under explicit operator toolchain and loader approvals",()=>{
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

for(const precompiled of [false,true])describe.skipIf(!binary)(`Native compile/package substitution (${precompiled?'Kotlin included precompiled':'Groovy buildSrc binary'})`,()=>{
 let r:any;
 beforeAll(async()=>{r=await fixture(precompiled,precompiled,precompiled?'precompiled-kotlin':'binary-kotlin','jar',true);},270000);
 it('rejects a valid unused class changed on disk after compile and before packaging',()=>{
  expect(r.kotlinStages.complete).toBe(false);
  expect(r.kotlinStages.reasons).toContain('kotlin_compile_package_mismatch');
  expect(r.projects.registered.declaredIn).toEqual([]);
  expect(r.projects.registered.applications[0].policies.attested.declarationsComplete).toBe(false);
 });
 it('separates the compile mismatch from successful plugin loading and runtime snapshot comparison',()=>{
  const a=r.projects.registered.applications[0];
  expect(r.assessment.inputVerified).toBe(true);
  expect(a.instanceMatches).toBe(true);expect(a.descriptorMatches).toBe(true);
  expect(a.loadEvidence.snapshotVerified).toBe(true);
  expect(['raw-exact','entry-content-exact']).toContain(a.loadEvidence.comparison);
 });
});
