/** Public API proof only; never enables production convention-plugin adoption. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessConventionProof, captureConventionDirectory, proofDigest } from "../fixtures/gradleConventionProof.js";
const binary=process.env.OSV_MCP_TEST_GRADLE;
const init=fileURLToPath(new URL("../fixtures/gradle-convention-registration.init.gradle",import.meta.url));
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
  for(const dir of [path.join(home,"lib"),path.join(home,"lib/plugins")]) for(const name of await readdir(dir)) if(name.endsWith(".jar")) files.push(path.join(dir,name));
  files.push(path.join(cache,"caches",version,"generated-gradle-jars",`gradle-api-${version}.jar`));
  const entries=[];const paths=new Map<string,string>();let bytesRead=0;
  for(const file of files.sort()){
   const {size}=await stat(file);if(size>512*1024**2)throw new Error("toolchain-entry-budget");bytesRead+=size;
   const id=file.startsWith(home)?path.relative(home,file).split(path.sep).join("/"):`generated/gradle-api-${version}.jar`;
   entries.push({id,size,sha256:await digest(file)});paths.set(file,id);
  }
  if(bytesRead>1024**3)throw new Error("toolchain-startup-budget");
  return {profile:{schemaVersion:1,gradleVersion:version,jdk:process.env.JAVA_HOME?.split(path.sep).slice(-3).join("/"),entries},paths,files,bytesRead};
 })();
}
async function fixture(kotlin=false, included=false, kind="binary-java",directoryMutation:""|"extra"|"transient"=""):Promise<any>{
 const proofFiles=[fileURLToPath(import.meta.url),init,fileURLToPath(new URL("../fixtures/gradleConventionProof.ts",import.meta.url))];
 const proofSources=Object.fromEntries(await Promise.all(proofFiles.map(async f=>[path.basename(f),await digest(f)])));
 const invocationId=randomUUID();
 const prepared=await toolchain();
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"osv-convention-proof-")));dirs.push(root);
 const producer=included?"build-logic":"buildSrc";
 const source=kind==="precompiled-groovy"?`${producer}/src/main/groovy/proof.convention.gradle`:kind==="binary-kotlin"?`${producer}/src/main/kotlin/proof/Convention.kt`:`${producer}/src/main/java/proof/Convention.java`;
 await mkdir(path.dirname(path.join(root,source)),{recursive:true});
 await mkdir(path.join(root,".proof"));
 await writeFile(path.join(root,"settings.gradle"),`${included?"pluginManagement { includeBuild('build-logic') }":""}\nrootProject.name='convention-proof'\ninclude 'plain','control','registered','script'\n`);
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
 }
}
`);
 if(kind==="precompiled-groovy") {
  await writeFile(path.join(root,producer,"build.gradle"),`plugins { id 'groovy-gradle-plugin' }
${directoryMutation?`tasks.named('compileGroovy') { doFirst { def extra=file('build/classes/java/main/unrecorded.properties');extra.parentFile.mkdirs();extra.text='unrecorded=true' }${directoryMutation==="transient"?"; doLast { file('build/classes/java/main/unrecorded.properties').delete() }":""} }`:""}
`);
  await mkdir(path.join(root,producer,"src/main/groovy/proof"),{recursive:true});
  await writeFile(path.join(root,producer,"src/main/groovy/proof/Helper.groovy"),"package proof; class Helper {}\n");
  await writeFile(path.join(root,source),`def probe=extensions.getByName('osvConventionProbe')
def source=probe.pluginSource(this,'proof.convention','${source}')
probe.add('probe','review:parent:1',source)
['lazy','unused'].each { cfg -> probe.addProvider(cfg,providers.provider { probe.produced(cfg);'review:parent:1' },source) }
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
 const suffix=kotlin?".gradle.kts":".gradle";
 for(const name of ["plain","control","registered","script"]){
  await mkdir(path.join(root,name));
  await writeFile(path.join(root,name,`build${suffix}`),kotlin?`import org.gradle.kotlin.dsl.withGroovyBuilder
${name==="script"?"":"plugins { id(\"proof.convention\") }"}
val probe=extensions.getByName("osvConventionProbe")
val source=probe.withGroovyBuilder { "scriptSource"("${name}/build${suffix}") }
probe.withGroovyBuilder { "add"("probe","review:parent:1",source) }
`:`${name==="script"?"":"plugins { id 'proof.convention' }"}
def probe=extensions.getByName('osvConventionProbe')
probe.add('probe','review:parent:1',probe.scriptSource('${name}/build${suffix}'))
`);
 }
 const dest=path.join(root,"repo/review/parent/1");await mkdir(dest,{recursive:true});
 await writeFile(path.join(dest,"parent-1.pom"),"<project><modelVersion>4.0.0</modelVersion><groupId>review</groupId><artifactId>parent</artifactId><version>1</version></project>");
 const inputs=[...(kind==="precompiled-groovy"?[`${producer}/src/main/groovy/proof/Helper.groovy`]:[]),"settings.gradle",`${producer}/settings.gradle`,`${producer}/build.gradle`,source,...["plain","control","registered","script"].map(n=>`${n}/build${suffix}`)];
 let inputBytes=0;
 for(const p of inputs){const size=(await stat(path.join(root,p))).size;inputBytes+=size;if(size>4*1024**2 || inputBytes>64*1024**2)throw new Error("plugin-input-budget");}
 const baseline=Object.fromEntries(await Promise.all(inputs.map(async p=>[p,await digest(path.join(root,p))])));
 await writeFile(path.join(root,".proof/baseline.json"),JSON.stringify({inputs:baseline,source,producer,invocationId}));
 const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,["-p",root,"-I",init,`-Dosv.convention.root=${root}`,"osvProveConventions","--offline","--no-daemon","--no-configuration-cache","--no-build-cache","--rerun-tasks","--console=plain","--stacktrace"],{env:process.env,timeout:180000,maxBuffer:4*1024*1024},(e,out,err)=>resolve({code:e?typeof e.code==="number"?e.code:-1:0,output:out+err})));
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
 if(process.env.OSV_MCP_GRADLE_CONVENTION_OUTPUT) await writeFile(`${process.env.OSV_MCP_GRADLE_CONVENTION_OUTPUT}-${report.gradleVersion}-${kotlin?"kotlin":"groovy"}-${producer}-${kind}${directoryMutation?`-${directoryMutation}`:""}.json`,JSON.stringify(report,null,2)+"\n");
 return report;
}
for(const kotlin of [false,true]) for(const [included,kind] of [[false,"binary-java"],[true,"binary-kotlin"],[true,"precompiled-groovy"]] as const) {
 describe.skipIf(!binary)(`Convention public API (Kotlin=${kotlin}, included=${included}, ${kind})`,()=>{
  let r:any;
  beforeAll(async()=>{r=await fixture(kotlin,included,kind);},210000);
  it("preserves native resolution and Action ordering in all three routes",()=>{
   for(const name of ["control","registered"]){
    expect(r.projects[name].graph).toEqual(r.projects.plain.graph);
    expect(r.projects[name].trace).toEqual(r.projects.plain.trace);
   }
   expect(r.projects.registered.graph).toEqual(["review:parent:1"]);
  });
  it("retains script and plugin attempts even for one equal retained dependency",()=>{
   const p=r.projects.registered;
   expect(p.records.map((x:any)=>x.origin.kind)).toEqual(["plugin","script"]);
   expect(p.records.every((x:any)=>x.retained)).toBe(true);
   expect(p.candidateSources).toHaveLength(2);
   expect(p.applications).toHaveLength(1);
   expect(p.records[1].origin).toEqual({kind:"script"});
   expect(p.records[0].origin.pluginApplicationId).toBe(p.applications[0].id);
  });
  it("does not turn cached or generated load origins into proven physical sources",()=>{
   const p=r.projects.registered;
   expect(p.sourceArtifactVerified).toBe(false);
   expect(p.declaredIn).toEqual([]);
   expect(p.applications[0].reason).toBe("loaded_origin_outside_prepared_outputs");
   if(kind!=="precompiled-groovy") {
    expect(p.applications[0].instanceMatches).toBe(true);
    expect(p.applications[0].loadedClassDigestMatches).toBe(true);
   }
  });
  it("verifies the large approved toolchain without spending the source capture budget",()=>{
   expect(r.toolchain.profile.entries.some((e:any)=>e.id.startsWith("generated/gradle-api-")&&e.size>64*1024**2)).toBe(true);
   expect(r.toolchain.unchanged).toBe(true);
   expect(r.toolchain.bytesRead).toBeLessThanOrEqual(2*1024**3);
   expect(r.assessment.inputVerified).toBe(true);
   expect(r.assessment.originsVerified).toBe(true);
   expect(r.assessment.reasons).toEqual(["plugin_loaded_origin_unverifiable"]);
  });
  it("rejects unapproved and altered toolchain profiles independently of plugin trust",()=>{
   for(const pluginTrust of [false,true]){
    expect(assessConventionProof(r,{approvedProfiles:new Set(),pluginTrust}).inputVerified).toBe(false);
    const bad=structuredClone(r);bad.toolchain.profile.entries[0].sha256="0".repeat(64);
    expect(assessConventionProof(bad,{approvedProfiles:new Set([r.toolchain.approvedDigest]),pluginTrust}).inputVerified).toBe(false);
   }
  });
  it("does not allow a classpath entry to self-classify as trusted tooling",()=>{
   const bad=structuredClone(r);const c=bad.builds.flatMap((b:any)=>b.receipts).find((c:any)=>c.classpath.length);
   c.classpath[0].sha256="f".repeat(64);
   expect(assessConventionProof(bad,{approvedProfiles:new Set([r.toolchain.approvedDigest]),pluginTrust:true}).reasons).toContain("toolchain_classpath_unverified");
  });
  it("rejects rewriting a plugin origin as a script, deleting IDs or dropping reverse references",()=>{
   for(const mutation of ["script","null","reverse"]){
    const bad=structuredClone(r),p=bad.projects.registered;
    if(mutation==="script") p.records[0].origin={kind:"script"};
    if(mutation==="null") p.records[0].origin.pluginApplicationId=null;
    if(mutation==="reverse") p.applications[0].expectedRecordIds=[];
    expect(assessConventionProof(bad,{approvedProfiles:new Set([r.toolchain.approvedDigest]),pluginTrust:true}).originsVerified).toBe(false);
   }
  });
  it.each(["script","missing_origin","missing_id","null_app","unknown_app","mapping","remove_record","drop_reverse","duplicate_id"])("rejects Provider origin/application tampering: %s",mutation=>{
   const bad=structuredClone(r),p=bad.projects.registered,provider=p.providerRecords[0];
   expect(provider.id).toBe("p0");expect(p.applications[0].expectedRecordIds).toEqual(["r0","p0","p1"]);
   if(mutation==="script"){provider.origin={kind:"script"};provider.source=p.records[1].source;}
   if(mutation==="missing_origin")delete provider.origin;
   if(mutation==="missing_id")delete provider.id;
   if(mutation==="null_app")provider.origin.pluginApplicationId=null;
   if(mutation==="unknown_app")provider.origin.pluginApplicationId="forged";
   if(mutation==="mapping")provider.origin.sourceMappingId=null;
   if(mutation==="remove_record")p.providerRecords.shift();
   if(mutation==="drop_reverse")p.applications[0].expectedRecordIds=p.applications[0].expectedRecordIds.filter((id:string)=>id!=="p0");
   if(mutation==="duplicate_id")p.providerRecords[1].id="p0";
   for(const pluginTrust of [false,true])expect(assessConventionProof(bad,{approvedProfiles:new Set([r.toolchain.approvedDigest]),pluginTrust}).originsVerified).toBe(false);
  });
  it("does not accept plugin references or missing origin on a normal script",()=>{
   for(const origin of [{kind:"script",pluginApplicationId:"forged"},null,{kind:"unknown"}]){
    const bad=structuredClone(r);bad.projects.registered.records[1].origin=origin;
    expect(assessConventionProof(bad,{approvedProfiles:new Set([r.toolchain.approvedDigest]),pluginTrust:true}).originsVerified).toBe(false);
   }
  });
  it("keeps a script-only scope valid without inventing a plugin application",()=>{
   const p=r.projects.script;
   expect(p.applications).toEqual([]);
   expect(p.sourceArtifactVerified).toBe(true);
   expect(p.declaredIn).toEqual([`script/build.gradle${kotlin?".kts":""}`]);
   expect(p.records[0].origin).toEqual({kind:"script"});
  });
  it("preserves Provider materialization phase/count without realizing an unused configuration",()=>{
   for(const name of ["control","registered"]){
    expect(r.projects[name].producerCalls).toEqual(r.projects.plain.producerCalls);
    expect(r.projects[name].lazyGraph).toEqual(r.projects.plain.lazyGraph);
   }
   expect(r.projects.registered.producerCalls).toEqual({lazy:1});
   expect(r.projects.registered.providerRecords.map((p:any)=>[p.configuration,p.callbacks])).toEqual([["lazy",1],["unused",0]]);
   expect(r.projects.registered.lazyGraph).toEqual(["review:parent:1"]);
   expect(r.projects.registered.trace).toEqual(r.projects.plain.trace);
  });
  it("does not conflate main and producer identities or reuse another invocation receipt",()=>{
   expect(r.builds.map((b:any)=>b.build).sort()).toEqual([included?"build-logic":"buildSrc","main"].sort());
   expect(r.builds.every((b:any)=>b.invocationId===r.invocationId)).toBe(true);
   const ids=Object.values<any>(r.projects).flatMap(p=>p.applications.map((a:any)=>a.id));
   expect(new Set(ids).size).toBe(3);
  });
  it("observes producer initialization and compilation through public callbacks",()=>{
   const b=r.builds.find((b:any)=>b.build===(included?"build-logic":"buildSrc"));
   expect(b.events[0]).toBe("beforeSettings");
   expect(b.receipts.some((x:any)=>x.type==="compile" && x.didWork && !x.skipped && !x.failure)).toBe(true);
   expect(r.inputs.changed).toEqual([]);
  });
 });
}

for(const kotlin of [false,true]) it.skipIf(!binary)(`rejects an unrecorded classpath file on disk (Kotlin=${kotlin})`,async()=>{
 const r=await fixture(kotlin,true,"precompiled-groovy","extra");
 const dirs=r.builds.flatMap((b:any)=>b.receipts).flatMap((c:any)=>c.classpath).filter((e:any)=>e.pluginOutputRoot);
 expect(dirs.length).toBeGreaterThan(0);
 const directory=dirs.find((e:any)=>Object.keys(e.currentPluginOutputs??{}).some(p=>p.endsWith("/unrecorded.properties")));
 expect(directory).toBeDefined();
 expect(Object.keys(directory.pluginOutputs).some(p=>p.endsWith("/unrecorded.properties"))).toBe(false);
 expect(r.assessment.inputVerified).toBe(false);
 expect(r.assessment.reasons).toContain("plugin_classpath_directory_mismatch");
 expect(r.assessment.declaredIn).toEqual([]);
 expect(r.projects.registered.graph).toEqual(r.projects.plain.graph);
},210000);

// Known limit: the snapshot is taken after the build, so a file present only while compileGroovy ran is not detected.
for(const kotlin of [false,true]) it.skipIf(!binary)(`records a transient classpath file as currently undetected (Kotlin=${kotlin})`,async()=>{
 const r=await fixture(kotlin,true,"precompiled-groovy","transient");
 const dirs=r.builds.flatMap((b:any)=>b.receipts).flatMap((c:any)=>c.classpath).filter((e:any)=>e.pluginOutputRoot);
 expect(dirs.length).toBeGreaterThan(0);
 expect(dirs.some((e:any)=>Object.keys(e.currentPluginOutputs??{}).some(p=>p.endsWith("/unrecorded.properties")))).toBe(false);
 expect(r.assessment.inputVerified).toBe(true);
 expect(r.assessment.reasons).toEqual(["plugin_loaded_origin_unverifiable"]);
 expect(r.assessment.declaredIn).toEqual([]);
},210000);
