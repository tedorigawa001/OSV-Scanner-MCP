/** Native production adapter -> static reader regression, opt in with OSV_MCP_TEST_GRADLE. */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {GradleGraphCache} from '../../utils/gradleGraphCache.js';
import {pluginProfileDigest,type PluginSettings} from '../../utils/gradlePlugins.js';
const binary=process.env.OSV_MCP_TEST_GRADLE,dirs:string[]=[];
const scripts=['plugin-provenance.init.gradle','register-declarations.init.gradle','export-dependency-graph.init.gradle'].map(n=>fileURLToPath(new URL('../../../gradle/'+n,import.meta.url)));
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});});
const run=(args:string[])=>new Promise<string>((resolve,reject)=>execFile(binary!,args,{env:process.env,timeout:180000,maxBuffer:4*1024**2},(e,out,err)=>e?reject(new Error(out+err)):resolve(out)));
const digest=async(f:string)=>{const h=createHash('sha256');for await(const b of createReadStream(f))h.update(b);return h.digest('hex');};
let profiles:Promise<any>|undefined;
async function prepared(){return profiles??=(async()=>{
 const home=path.dirname(path.dirname(await realpath(binary!))),version=(await run(['--version'])).match(/Gradle (\d+\.\d+(?:\.\d+)?)/)![1]!;
 const paths:any[]=[],entries:any[]=[];
 for(const folder of ['lib','lib/plugins','lib/agents'])for(const name of await readdir(path.join(home,folder)))if(name.endsWith('.jar'))paths.push({id:folder+'/'+name,path:path.join(home,folder,name)});
 paths.push({id:'generated/api',path:path.join(process.env.GRADLE_USER_HOME!,'caches',version,'generated-gradle-jars',`gradle-api-${version}.jar`)});
 for(const [id,file]of [['jdk/java','bin/java'],['jdk/modules','lib/modules'],['jdk/release','release']])paths.push({id,path:path.join(process.env.JAVA_HOME!,file!)});
 for(const p of paths)entries.push({id:p.id,role:p.id.startsWith('jdk/')?'jdk-runtime':p.id==='generated/api'?'gradle-api-generated':'gradle-distribution',size:(await stat(p.path)).size,sha256:await digest(p.path)});
 const release=await readFile(path.join(process.env.JAVA_HOME!,'release'),'utf8'),jdkIdentity=release.match(/^JAVA_RUNTIME_VERSION="([^"]+)"/m)![1]!;
 const profile={schemaVersion:1,gradleVersion:version,distributionSha256:pluginProfileDigest(entries),jdkIdentity,compilerIdentity:'gradle-bundled',generatedApiMethod:'gradle-generated-api',entries};
 const loader={schemaVersion:1,toolchainProfileDigest:pluginProfileDigest(profile),gradleVersion:version,jdkIdentity,loaderPolicy:'gradle-managed-only',transformPolicy:'operator-attested-pipeline',agents:entries.filter(e=>e.id.startsWith('lib/agents/')).map(e=>({kind:'javaagent',entryId:e.id,sha256:e.sha256})),exportSettings:{configurationCache:false,parallel:false},attestations:{approvedRuntimeOnly:true,noUnregisteredAgentsOrLoaders:true,artifactsImmutableThroughLoad:true}};
 return {profile,paths,loader};
 })();}
async function fixture(kotlin:boolean,included:boolean,precompiled:boolean,directory:boolean,duplicate=false,binaryKotlin=false,options:{badJdk?:boolean;provider?:boolean;actionFailure?:boolean}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-plugin-export-')));dirs.push(root);
 const sources=[...scripts,...['gradlePlugins.ts','gradlePluginSnapshots.ts','gradlePluginJar.ts','gradleGraph.ts','gradleGraphCache.ts','gradleDeclarations.ts','gradleCatalogs.ts'].map(n=>fileURLToPath(new URL('../../utils/'+n,import.meta.url))),fileURLToPath(import.meta.url)];
 const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async p=>[path.relative(process.cwd(),p),await digest(p)])));
 const config=structuredClone(await prepared()),producer=included?'build-logic':'buildSrc',suffix=kotlin?'.gradle.kts':'.gradle';
 if(options.badJdk){
  const file=path.join(process.env.JAVA_HOME!,'release'),entry=config.profile.entries.find((e:any)=>e.id==='jdk/java');entry.sha256=await digest(file);entry.size=(await stat(file)).size;config.paths.find((p:any)=>p.id==='jdk/java').path=file;config.loader.toolchainProfileDigest=pluginProfileDigest(config.profile);
 }
 const source=producer+(precompiled?'/src/main/groovy/proof.convention.gradle':binaryKotlin?'/src/main/kotlin/proof/Convention.kt':'/src/main/java/proof/Convention.java');
 const write=async(p:string,s:string)=>{await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),s);};
 await write('settings.gradle',`${included?"pluginManagement { includeBuild('build-logic') }":''}\nrootProject.name='consumer'\n`);
 await write(producer+'/settings.gradle',"rootProject.name='logic'\n");
 await write(producer+'/build.gradle',(precompiled?"plugins { id 'groovy-gradle-plugin' }":"plugins { id 'java-gradle-plugin' };gradlePlugin {plugins {convention {id='proof.convention';implementationClass='proof.Convention'}}}")+ (directory?`
def image=tasks.register('pluginImage',Sync) { dependsOn tasks.named('classes');from sourceSets.main.output;into layout.buildDirectory.dir('plugin-image') }
configurations.runtimeElements.outgoing.artifacts.clear()
artifacts.add('runtimeElements',layout.buildDirectory.dir('plugin-image')) {builtBy image;type='java-classes-directory'}
`:''));
 await write(source,precompiled?`def h=extensions.getByName('osvMcpDeclarations')
def session=h.beginPrecompiled('local')
def source=h.pluginSource(session,'entry')
h.add('implementation','g:a:1',source)
h.endPlugin(session)
${duplicate?"def again=h.beginPrecompiled('local');h.endPlugin(again)":''}
`:`package proof;
import org.gradle.api.Plugin;import org.gradle.api.Project;import groovy.lang.GroovyObject;
public class Convention implements Plugin<Project> { public void apply(Project p) {
 GroovyObject h=(GroovyObject)p.getExtensions().getByName("osvMcpDeclarations");
 Object session=h.invokeMethod("beginPlugin",new Object[]{"local",this});
 Object source=h.invokeMethod("pluginSource",new Object[]{session,"entry"});
 ${options.actionFailure?'try {h.invokeMethod("add",new Object[]{"implementation","g:a:1",source,(org.gradle.api.Action<org.gradle.api.artifacts.ExternalModuleDependency>)(d)->{throw new IllegalStateException("expected");}});}catch(Exception expected){}':''}
 h.invokeMethod("add",new Object[]{"implementation","g:a:1",source});
 ${options.provider?'h.invokeMethod("addProvider",new Object[]{"implementation",p.getProviders().provider(()->"g:a:1"),source});':''}
 h.invokeMethod("endPlugin",new Object[]{session,"complete"});
 ${duplicate?'Object again=h.invokeMethod("beginPlugin",new Object[]{"local",this});h.invokeMethod("endPlugin",new Object[]{again,"complete"});':''}
} }
`);
 if(binaryKotlin){
  await write(source,`package proof
import org.gradle.api.Plugin
import org.gradle.api.Project
import groovy.lang.GroovyObject
class Convention : Plugin<Project> {
 override fun apply(p: Project) {
  val h=p.extensions.getByName("osvMcpDeclarations") as GroovyObject
  val session=h.invokeMethod("beginPlugin",arrayOf("local",this))
  val source=h.invokeMethod("pluginSource",arrayOf(session,"entry"))
  h.invokeMethod("add",arrayOf("implementation","g:a:1",source))
  h.invokeMethod("endPlugin",arrayOf(session,"complete"))
 }
}
`);
  await write(producer+'/build.gradle',`plugins {id 'java-gradle-plugin'}
gradlePlugin {plugins {convention {id='proof.convention';implementationClass='proof.Convention'}}}
def kotlinOutput=layout.buildDirectory.dir('classes/kotlin/main')
def compileKotlin=tasks.register('compileProofKotlin',JavaExec) {
 classpath=fileTree(new File(gradle.gradleHomeDir,'lib')) {include '*.jar'}
 mainClass='org.jetbrains.kotlin.cli.jvm.K2JVMCompiler'
 inputs.file('src/main/kotlin/proof/Convention.kt');outputs.dir(kotlinOutput)
 doFirst {
  def libs=fileTree(new File(gradle.gradleHomeDir,'lib')) {include 'kotlin-stdlib-*.jar';include 'groovy-*.jar'}
  def cp=files(configurations.compileClasspath,libs)
  extensions.extraProperties.set('proofDependencyClasspath',cp)
  args '-no-stdlib','-no-reflect','-jvm-target','17','-classpath',cp.asPath,'-d',kotlinOutput.get().asFile.absolutePath,file('src/main/kotlin/proof/Convention.kt').absolutePath
 }
}
sourceSets.main.output.dir(kotlinOutput,builtBy:compileKotlin)
`);
 }
 await write('build'+suffix,kotlin?`import org.gradle.kotlin.dsl.withGroovyBuilder
plugins { java;id("proof.convention") }
repositories {maven {url=uri("repo")}}
val h=extensions.getByName("osvMcpDeclarations")
val source=h.withGroovyBuilder { "source"("build.gradle.kts") }
h.withGroovyBuilder {"add"("implementation","g:a:1",source)}
`:`plugins {id 'java';id 'proof.convention'}
repositories {maven {url=uri('repo')}}
def h=extensions.getByName('osvMcpDeclarations');h.add('implementation','g:a:1',h.source('build.gradle'))
`);
 await write('repo/g/a/1/a-1.pom','<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>');
 const lock='g:a:1=runtimeClasspath\n';await write('gradle.lockfile',lock);
 const outputRoots=[{kind:'directory',role:'classes',path:producer+'/build/classes/java/main'},{kind:'directory',role:'resources',path:producer+'/build/resources/main'},...(precompiled?[{kind:'directory',role:'classes',path:producer+'/build/classes/groovy/main'}]:[]),...(binaryKotlin?[{kind:'directory',role:'classes',path:producer+'/build/classes/kotlin/main'}]:[]),{kind:directory?'directory':'jar',role:'plugin-artifact',path:producer+(directory?'/build/plugin-image':'/build/libs/logic.jar')}];
 const implementationClass=precompiled?'ProofConventionPlugin':'proof.Convention';
 const spec={id:'local',producer:{kind:included?'included-build':'build-src',rootDirectory:producer,projectPath:':'},pluginIds:['proof.convention'],implementationClass,registrationForm:precompiled?'precompiled-pending':'binary-instance',sourcePaths:[source],inputPaths:[producer+'/settings.gradle',producer+'/build.gradle',source],outputRoots,sourceMappings:[{id:'entry',sourcePath:source,implementationClass}],toolchainProfileDigest:pluginProfileDigest(config.profile),loadPolicy:'approved-gradle-loader-v1',loaderProfileDigest:pluginProfileDigest(config.loader),assertions:{buildInputs:'all-plugin-build-inputs-listed',additions:'all-contributing-plugin-additions-use-helper',mapping:'source-artifact-mapping-reviewed',mutation:'immutable-during-export'}};
 const contract={contractVersion:3,trustModel:'registered-helper-v1',sources:['build'+suffix,source],catalogPolicy:'none',catalogs:[],pluginPolicy:'explicit-local-build-v1',plugins:[spec],scopes:[{id:'runtime',projectPath:':',resolvableConfiguration:'runtimeClasspath',declarationConfigurations:['implementation'],assertion:'all-contributing-additions-use-helper',mutationPolicy:'immutable-after-add',catalogIds:[],pluginIds:['local']}]};
 if(options.provider)(contract.scopes[0] as any).providerPolicy='stable-during-export';
 await write('osv-mcp-gradle-declarations.json',JSON.stringify(contract));
 await write('.profiles/toolchain.json',JSON.stringify({profile:config.profile,paths:config.paths}));await write('.profiles/loader.json',JSON.stringify(config.loader));
 const exportArgs=['-p',root,...scripts.flatMap(s=>['-I',s]),'-DosvMcpPluginBoundary='+root,'-DosvMcpPluginToolchainProfile='+path.join(root,'.profiles/toolchain.json'),'-DosvMcpPluginLoaderProfile='+path.join(root,'.profiles/loader.json'),'-DosvMcpPluginRuntimeRoots='+process.env.GRADLE_USER_HOME,'-PosvMcpDeclarationContract=osv-mcp-gradle-declarations.json','-PosvMcpConfigurations=runtimeClasspath','osvMcpExportDependencies','--offline','--no-daemon','--no-configuration-cache','--no-parallel','--no-build-cache','--rerun-tasks','--console=plain','--stacktrace'];
 await run(exportArgs);
 const settings:PluginSettings={trust:'local-plugin-loader-attested-v2',invalid:false,toolchains:new Set([pluginProfileDigest(config.profile)]),loaders:new Set([pluginProfileDigest(config.loader)])};
 for(const p of sources)expect(await digest(p)).toBe(sourceHashes[path.relative(process.cwd(),p)]);
 const saveEvidence=async(sequence="initial",metadata?:unknown)=>{if(process.env.OSV_MCP_GRADLE_PLUGIN_OUTPUT){
  const graph=JSON.parse(await readFile(path.join(root,'osv-mcp-gradle-dependencies.json'),'utf8'));
  const identity={version:config.profile.gradleVersion,consumer:kotlin?'kotlin':'groovy',producer,kind:precompiled?'precompiled-groovy':binaryKotlin?'binary-kotlin':'binary-java',artifact:directory?'directory':'jar',duplicate,provider:!!options.provider,actionFailure:!!options.actionFailure};
  const name=Object.values(identity).join('-')+'-'+sequence;await writeFile(process.env.OSV_MCP_GRADLE_PLUGIN_OUTPUT+'-'+name+'.json',JSON.stringify({identity,sequence,sourceHashes,graph,metadata}));
 }};
 await saveEvidence();
 return {root,lock,settings,source,reexport:()=>run(exportArgs),saveEvidence};
}
for(const kotlin of [false,true])for(const included of [false,true])for(const precompiled of [false,true])for(const directory of [false,true])describe.skipIf(!binary)(`Production plugin (${kotlin?'Kotlin':'Groovy'},${included?'included':'buildSrc'},${precompiled?'precompiled':'binary'},${directory?'directory':'jar'})`,()=>{
 let f:Awaited<ReturnType<typeof fixture>>;
 beforeAll(async()=>{f=await fixture(kotlin,included,precompiled,directory);},210000);
 it('exports and statically adopts a complete mixed script/plugin declaration list',async()=>{
  const captured=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
  expect(captured.metadata.reasons).not.toContain('plugin_evidence_unverifiable');expect(captured.metadata.relations_complete,JSON.stringify(captured.metadata)).toBe(true);
  expect(captured.metadata.declarations_complete,JSON.stringify(captured.metadata)).toBe(true);
  expect([...captured.lookup!('g:a','1').declaredIn!].sort()).toEqual(['build'+(kotlin?'.gradle.kts':'.gradle'),f.source].sort());
  await f.saveEvidence('initial',captured.metadata);
  const disabled=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,{...f.settings,trust:undefined}).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
  expect(disabled.lookup!('g:a','1').relation).toBe('direct');expect(disabled.metadata.declarations_complete).toBe(false);
 },210000);
 it('returns comparison evidence and directory limitations without conflating same-path observations',async()=>{
  const g=JSON.parse(await readFile(path.join(f.root,'osv-mcp-gradle-dependencies.json'),'utf8')),a=g.contexts[0].declarations.pluginApplications[0];
  const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
  const metadata=r.metadata.declaration_provenance!,app=metadata.contexts[0]!.plugin_applications![0]!;
  expect(r.metadata.declarations_complete).toBe(true);
  if(directory){expect(a.originRelation).toBe('same-path-origin');expect(app.comparison).toBe('same-path-origin');expect(metadata.limitations).toContain('plugin_directory_origin_same_path_not_compared');expect(metadata.limitations).toContain('plugin_directory_snapshot_post_build');}
  else {expect(a.originRelation).toBeNull();expect(['raw-exact','entry-content-exact']).toContain(app.comparison);expect(metadata.limitations).not.toContain('plugin_directory_origin_same_path_not_compared');expect(metadata.limitations).not.toContain('plugin_directory_snapshot_post_build');}
 });
 it.each(['old-trust','no-loader','no-toolchain','helper-disabled'])('applies independent trust and profile requirements: %s',async kind=>{
  const settings={...f.settings,trust:kind==='old-trust'?'local-plugin-build-v1' as const:f.settings.trust,loaders:kind==='no-loader'?new Set<string>():f.settings.loaders,toolchains:kind==='no-toolchain'?new Set<string>():f.settings.toolchains};
  const r=await new GradleGraphCache(f.root,undefined,kind==='helper-disabled'?undefined:'registered-helper-v1',undefined,undefined,settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
  expect(r.metadata.declarations_complete).toBe(false);expect(r.lookup!('g:a','1').relation).toBe(kind==='no-loader'||kind==='no-toolchain'?'unknown':'direct');
 });
 it.each(['late','unclosed','failed','origin','coverage','empty-apps','downgrade','classpath','descriptor'])('fails closed for changed plugin evidence: %s',async kind=>{
  const file=path.join(f.root,'osv-mcp-gradle-dependencies.json'),before=await readFile(file,'utf8'),g=JSON.parse(before),d=g.contexts[0].declarations,a=d.pluginApplications[0];
  if(kind==='late')a.beginBeforeApplied=false;if(kind==='unclosed')a.ended=false;if(kind==='failed')a.endOutcome='failed';
  if(kind==='origin'){const r=d.records.find((r:any)=>r.origin.kind==='plugin');r.origin={kind:'script'};}
  if(kind==='coverage')a.expectedRecordIds=[];if(kind==='empty-apps')d.pluginApplications=[];
  if(kind==='downgrade'){d.adapterVersion=4;delete d.pluginApplications;for(const r of d.records)delete r.origin;}
  if(kind==='classpath')g.pluginEvidence.builds[0].receipts.find((r:any)=>r.type==='compile').classpath[0].entryId='unapproved';
  if(kind==='descriptor')a.descriptorImplementation='Wrong';
  try {await writeFile(file,JSON.stringify(g));const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));expect(r.metadata.declarations_complete).toBe(false);expect(r.lookup!('g:a','1').declaredIn).toBeUndefined();}
  finally{await writeFile(file,before);}
 });
 it.each(['source','snapshot','built-output','resource-output'])('rechecks current bytes and never returns stale declaration sources: %s',async kind=>{
  const g=JSON.parse(await readFile(path.join(f.root,'osv-mcp-gradle-dependencies.json'),'utf8')),a=g.contexts[0].declarations.pluginApplications[0],ref=a.runtimeSnapshotRef;
  let target=kind==='source'?f.source:kind==='built-output'?a.builtArtifact.path:ref.kind==='jar'?ref.snapshotPath:ref.manifestPath;
  if(kind==='resource-output')target=f.source.split('/')[0]+'/build/resources/main/META-INF/gradle-plugins/proof.convention.properties';
  if(kind==='built-output'&&a.builtArtifact.kind==='directory')target+='/META-INF/gradle-plugins/proof.convention.properties';
  const file=path.join(f.root,target),before=await readFile(file);
  try{await writeFile(file,Buffer.concat([before,Buffer.from('modified')]));const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,{...f.settings,trust:undefined}).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));expect(r.lookup!('g:a','1').relation).toBe('unknown');expect(r.metadata.declarations_complete).toBe(false);}
  finally{await writeFile(file,before);}
 });
 it('adopts a fresh re-export after a source update in the same project',async()=>{
  const file=path.join(f.root,f.source),before=await readFile(file,'utf8');
  const changed=precompiled?before+"\nclass ReviewReexportMarker {}\n":before.replace('public class Convention implements Plugin<Project> {','public class Convention implements Plugin<Project> { public static final int REVIEW_REEXPORT_MARKER=1;');
  expect(changed).not.toBe(before);await writeFile(file,changed);await f.reexport();
  const g=JSON.parse(await readFile(path.join(f.root,'osv-mcp-gradle-dependencies.json'),'utf8'));
  const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
  expect(r.metadata.declarations_complete,JSON.stringify(r.metadata)).toBe(true);
  expect(r.lookup!('g:a','1').declaredIn).toContain(f.source);
  await f.saveEvidence('reexport',r.metadata);
  for(const receipt of g.pluginEvidence.builds[0].receipts)if(receipt.type==='compile')expect(receipt.outputs.every((o:any)=>o.path!==g.contexts[0].declarations.pluginApplications[0].builtArtifact.path)).toBe(true);
 });
});
describe.skipIf(!binary)('Production duplicate registration',()=>{it('keeps relation but withholds every declaration after a closed session is begun again',async()=>{
 const f=await fixture(false,false,false,false,true);const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
 expect(r.lookup!('g:a','1').relation).toBe('direct');expect(r.metadata.declarations_complete).toBe(false);expect(r.metadata.reasons).toContain('plugin_duplicate_registration');
},210000);});

for(const kotlin of [false,true])for(const included of [false,true])describe.skipIf(!binary)(`Production Kotlin binary (${kotlin?'Kotlin':'Groovy'},${included?'included':'buildSrc'})`,()=>{
 it('binds an independently compiled Kotlin producer to physical source',async()=>{
  const f=await fixture(kotlin,included,false,false,false,true);
  const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));
  expect(r.metadata.declarations_complete,JSON.stringify(r.metadata)).toBe(true);expect(r.lookup!('g:a','1').declaredIn).toContain(f.source);
  await f.saveEvidence('initial',r.metadata);
  const file=path.join(f.root,f.source),before=await readFile(file,'utf8');await writeFile(file,before.replace('class Convention : Plugin<Project> {','class Convention : Plugin<Project> { companion object { const val REVIEW_REEXPORT_MARKER = 1 }'));
  await f.reexport();const next=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));expect(next.metadata.declarations_complete,JSON.stringify(next.metadata)).toBe(true);await f.saveEvidence('reexport',next.metadata);
 },210000);
});

describe.skipIf(!binary)('Production plugin registration boundaries',()=>{
 it('retains deferred declaration provenance without early materialization',async()=>{
  const f=await fixture(false,false,false,false,false,false,{provider:true});const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));expect(r.metadata.declarations_complete,JSON.stringify(r.metadata)).toBe(true);
 });
 it('does not allow a caught configure Action failure to be cleared by end complete',async()=>{
  const f=await fixture(false,false,false,false,false,false,{actionFailure:true});const r=await new GradleGraphCache(f.root,undefined,'registered-helper-v1',undefined,undefined,f.settings).capture(path.join(f.root,'gradle.lockfile'),Buffer.from(f.lock));expect(r.lookup!('g:a','1').relation).toBe('direct');expect(r.metadata.declarations_complete).toBe(false);expect(r.metadata.reasons).toContain('plugin_declarations_incomplete');
 });
 it('rejects an approved profile pointing to another file instead of the selected JDK',async()=>{
  await expect(fixture(false,false,false,false,false,false,{badJdk:true})).rejects.toThrow('OSV selected JDK not bound to approved profile');
 });
});
