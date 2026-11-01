/** Synthetic files exercise the static trust contract; native compilation is tested separately. */
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach,expect,it} from 'vitest';
import {declarationFixture} from '../fixtures/gradleDeclarationsFixture.js';
import {sha,captureLoadTree,treeDigest,saveDirectorySnapshot} from '../../utils/gradlePluginSnapshots.js';
import {pluginApplicationSchema,pluginProfileDigest,type PluginSettings} from '../../utils/gradlePlugins.js';
import {GradleGraphCache} from '../../utils/gradleGraphCache.js';
const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function fixture(distinct=false,mismatch=false){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-plugin-reader-')));dirs.push(root);
 const write=async(p:string,b:string)=>{await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),b);};
 const source='buildSrc/src/main/java/Plugin.java',image='buildSrc/build/image',lock='g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\n';
 const files={'build.gradle':'// script\n','buildSrc/settings.gradle':"rootProject.name='logic'\n",'buildSrc/build.gradle':"// compile\n",[source]:'// plugin\n'};
 for(const [p,b]of Object.entries(files))await write(p,b);
 await write(image+'/META-INF/gradle-plugins/proof.properties','implementation-class=Plugin\n');await write(image+'/Plugin.class','synthetic compiled output');
 const built={kind:'directory',path:image,treeDigest:treeDigest(await captureLoadTree(root,image))};
 if(distinct)await cp(path.join(root,image),path.join(root,'runtime-image'),{recursive:true});
 if(mismatch)await write('runtime-image/Plugin.class','different runtime class');
 const ref=await saveDirectorySnapshot(root,distinct?'runtime-image':image,'invocation',undefined,'export-task');
 const profile={schemaVersion:1,gradleVersion:'8.11.1',distributionSha256:'a'.repeat(64),jdkIdentity:'test-jdk',compilerIdentity:'test-compiler',generatedApiMethod:'test',entries:[{id:'api',role:'gradle-api-generated',size:1,sha256:'b'.repeat(64)},...['jdk/java','jdk/modules','jdk/release'].map(id=>({id,role:'jdk-runtime',size:1,sha256:'c'.repeat(64)}))]};
 const loader={schemaVersion:1,toolchainProfileDigest:pluginProfileDigest(profile),gradleVersion:'8.11.1',jdkIdentity:'test-jdk',loaderPolicy:'gradle-managed-only',transformPolicy:'operator-attested-pipeline',agents:[],exportSettings:{configurationCache:false,parallel:false},attestations:{approvedRuntimeOnly:true,noUnregisteredAgentsOrLoaders:true,artifactsImmutableThroughLoad:true}};
 const spec={id:'local',producer:{kind:'build-src',rootDirectory:'buildSrc',projectPath:':'},pluginIds:['proof'],implementationClass:'Plugin',registrationForm:'binary-instance',sourcePaths:[source],inputPaths:['buildSrc/settings.gradle','buildSrc/build.gradle',source],outputRoots:[{kind:'directory',role:'plugin-artifact',path:image}],sourceMappings:[{id:'entry',sourcePath:source,implementationClass:'Plugin'}],toolchainProfileDigest:pluginProfileDigest(profile),loadPolicy:'approved-gradle-loader-v1',loaderProfileDigest:pluginProfileDigest(loader),assertions:{buildInputs:'all-plugin-build-inputs-listed',additions:'all-contributing-plugin-additions-use-helper',mapping:'source-artifact-mapping-reviewed',mutation:'immutable-during-export'}};
 const base=declarationFixture(),author=JSON.parse(base.contract);author.contractVersion=3;author.catalogs=[];author.pluginPolicy='explicit-local-build-v1';author.plugins=[spec];author.sources.push(source);author.scopes[0].pluginIds=['local'];author.scopes[0].catalogIds=[];
 const graph:any=base.graph;graph.schemaVersion=3;graph.producer.exporterVersion='3';graph.lockfiles[0].sha256=sha(lock);
 const d=graph.contexts[0].declarations;d.adapterVersion=5;d.catalogAdditions=[];
 const original=d.records[0];original.origin={kind:'script'};original.source.sha256=sha(files['build.gradle']);original.registrationKind='synchronous';original.registrationForm='synchronous';original.callbackCount=0;original.materializations=[];original.catalogGroupId=null;
 d.records.push({...structuredClone(original),id:'plugin-d0',source:{kind:'convention-plugin',path:source,sha256:sha(files[source])},origin:{kind:'plugin',applicationId:'application',sourceMappingId:'entry'}});d.bindings[0].declarationIds.push('plugin-d0');
 d.pluginApplications=[{id:'application',pluginSpecId:'local',ownerProjectId:'main::',invocationId:'invocation',producerBuildId:'buildSrc',registrationForm:'binary-instance',registrationUnique:true,beginBeforeApplied:true,ended:true,endOutcome:'complete',observerFired:true,instanceMatches:true,implementationClass:'Plugin',descriptorImplementation:'Plugin',loadObservationPhase:'export-task',builtArtifact:built,expectedRecordIds:['plugin-d0'],loadPolicy:'approved-gradle-loader-v1',loaderProfileDigest:pluginProfileDigest(loader),originRelation:distinct?'distinct-path-origin':'same-path-origin',runtimeSnapshotRef:ref,runtimeAttestations:loader.attestations}];
 graph.pluginEvidence={invocationId:'invocation',toolchainProfiles:[profile],loaderProfiles:[loader],toolchainReceipts:[{profileDigest:pluginProfileDigest(profile),beforeVerified:true,afterVerified:true,runtimeIdentityVerified:true,bytesRead:8,maxBuffer:1024}],runtime:{gradleVersion:'8.11.1',jdkIdentity:'test-jdk',agents:[],configurationCache:false,parallel:false},builds:[{id:'buildSrc',producer:spec.producer,invocationId:'invocation',inputs:spec.inputPaths.map(p=>({path:p,sha256:sha(files[p as keyof typeof files])})),receipts:[{id:'compile',task:':compileJava',type:'compile',executed:true,didWork:true,skipped:false,failure:false,classpath:[{kind:'toolchain',entryId:'api',size:1,sha256:'b'.repeat(64)}],outputs:[built]},{id:'package',task:':image',type:'package',executed:true,didWork:true,skipped:false,failure:false,classpath:[],outputs:[built]}]}]};
 const settings:PluginSettings={trust:'local-plugin-loader-attested-v2',invalid:false,toolchains:new Set([pluginProfileDigest(profile)]),loaders:new Set([pluginProfileDigest(loader)])};
 const save=async()=>{const text=JSON.stringify(author);await write('osv-mcp-gradle-declarations.json',text);graph.inputs.files=[{path:'build.gradle',sha256:sha(files['build.gradle'])},{path:source,sha256:sha(files[source])},{path:'osv-mcp-gradle-declarations.json',sha256:sha(text)}];for(const c of graph.contexts)c.declarations.trust.contractSha256=sha(text);await write('osv-mcp-gradle-dependencies.json',JSON.stringify(graph));};
 await save();const state={lock};const capture=async(s=settings)=>new GradleGraphCache(root,undefined,'registered-helper-v1',undefined,undefined,s).capture(path.join(root,'gradle.lockfile'),Buffer.from(state.lock));
 return {root,source,image,graph,author,settings,save,capture,state};
}
it('adopts the complete mixed declaration list and explicit attested metadata',async()=>{
 const f=await fixture(),r=await f.capture();expect(r.metadata.declarations_complete,JSON.stringify(r.metadata)).toBe(true);expect([...r.lookup!('g:a','1').declaredIn!].sort()).toEqual(['build.gradle',f.source].sort());expect(r.metadata.declaration_provenance?.plugin_trust_status).toBe('accepted');expect(r.metadata.declaration_provenance?.limitations).toContain('plugin_loaded_bytes_not_independently_observed');
});
it.each(['disabled','old','loader','toolchain'])('enforces independent consumer settings: %s',async kind=>{
 const f=await fixture(),s={...f.settings};if(kind==='disabled')s.trust=undefined;if(kind==='old')s.trust='local-plugin-build-v1';if(kind==='loader')s.loaders=new Set();if(kind==='toolchain')s.toolchains=new Set();const r=await f.capture(s);expect(r.metadata.declarations_complete).toBe(false);expect(r.lookup!('g:a','1').relation).toBe('direct');expect(r.lookup!('g:a','1').declaredIn).toBeUndefined();
 if(kind==='loader'||kind==='toolchain'){expect(r.metadata.reasons).toContain(`plugin_${kind}_not_approved`);expect(r.metadata.declaration_provenance?.plugin_trust_status).toBe('disabled_for_required_policy');}
});
it.each(['late','unclosed','failed','origin','mapping','reverse-reference','duplicate'])('preserves graph relations but withholds the whole declaration list: %s',async kind=>{
 const f=await fixture(),d=f.graph.contexts[0].declarations,a=d.pluginApplications[0];if(kind==='late')a.beginBeforeApplied=false;if(kind==='unclosed')a.ended=false;if(kind==='failed')a.endOutcome='failed';if(kind==='origin')d.records[1].origin={kind:'script'};if(kind==='mapping')d.records[1].origin.sourceMappingId='wrong';if(kind==='reverse-reference')a.expectedRecordIds=[];if(kind==='duplicate')d.pluginApplications.push({...structuredClone(a),id:'again',expectedRecordIds:[]});await f.save();const r=await f.capture();expect(r.lookup!('g:a','1').relation).toBe('direct');expect(r.lookup!('g:a','1').declaredIn).toBeUndefined();expect(r.metadata.declarations_complete).toBe(false);
});
it.each(['missing-app','downgrade','receipt','runtime-identity','toolchain-bytes','invocation','classpath','descriptor','built','snapshot'])('rejects unverifiable graph inputs independently of disabled declaration trust: %s',async kind=>{
 const f=await fixture(),d=f.graph.contexts[0].declarations,e=f.graph.pluginEvidence,a=d.pluginApplications[0];if(kind==='missing-app')d.pluginApplications=[];if(kind==='downgrade'){d.adapterVersion=4;delete d.pluginApplications;for(const r of d.records)delete r.origin;}
 if(kind==='runtime-identity')e.toolchainReceipts[0].runtimeIdentityVerified=false;if(kind==='receipt')e.builds[0].receipts[0].didWork=false;if(kind==='toolchain-bytes')e.toolchainReceipts[0].bytesRead=0;if(kind==='invocation')e.builds[0].invocationId='other';if(kind==='classpath')e.builds[0].receipts[0].classpath[0].entryId='wrong';if(kind==='descriptor')a.descriptorImplementation='Wrong';if(kind==='built')a.builtArtifact.treeDigest='0'.repeat(64);if(kind==='snapshot')a.runtimeSnapshotRef.treeDigest='0'.repeat(64);await f.save();const r=await f.capture({...f.settings,trust:undefined});expect(r.lookup!('g:a','1').relation).toBe('unknown');expect(r.metadata.declarations_complete).toBe(false);
});
it('rejects snapshot blobs modified on disk',async()=>{
 const f=await fixture(),ref=f.graph.contexts[0].declarations.pluginApplications[0].runtimeSnapshotRef,manifest=JSON.parse(await readFile(path.join(f.root,ref.manifestPath),'utf8')),file=manifest.entries.find((e:any)=>e.kind==='file');await writeFile(path.join(f.root,path.dirname(ref.manifestPath),'blobs',file.sha256),'changed');expect((await f.capture()).lookup!('g:a','1').relation).toBe('unknown');
});
it('keeps strict independent of loader approval and requires extra trust for pending registration',async()=>{
 const f=await fixture(),s=f.author.plugins[0],a=f.graph.contexts[0].declarations.pluginApplications[0];s.loadPolicy='prepared-output-only-v1';delete s.loaderProfileDigest;a.loadPolicy=s.loadPolicy;delete a.loaderProfileDigest;delete a.runtimeSnapshotRef;delete a.runtimeAttestations;delete a.originRelation;a.directLoadObserved=true;a.unverifiedTransform=false;await f.save();const settings={...f.settings,trust:'local-plugin-build-v1' as const,loaders:new Set<string>()};expect((await f.capture(settings)).metadata.declarations_complete).toBe(true);
 // Strict production exporter still emits unverifiedTransform=true; this is synthetic classification only.
 a.unverifiedTransform=true;await f.save();expect((await f.capture(settings)).lookup!('g:a','1').relation).toBe('unknown');
});

it('keeps incomplete same-GAV declaration lists suppressed regardless of context order',async()=>{
 const f=await fixture(),c=structuredClone(f.graph.contexts[0]);c.id='other';c.configuration='otherClasspath';c.lockConfiguration='otherClasspath';c.declarations.trust.scopeId='other';c.declarations.configurationClosure[0]='otherClasspath';c.declarations.configurationTopology[0].name='otherClasspath';c.declarations.pluginApplications[0].ended=false;
 f.graph.contexts.push(c);f.author.scopes.push({...f.author.scopes[0],id:'other',resolvableConfiguration:'otherClasspath'});f.state.lock='g:a:1=runtimeClasspath,otherClasspath\ng:b:2=runtimeClasspath,otherClasspath\n';f.graph.lockfiles[0].sha256=sha(f.state.lock);await f.save();
 const first=await f.capture();f.graph.contexts.reverse();await f.save();const second=await f.capture();
 for(const r of [first,second]){expect(r.lookup!('g:a','1').relation).toBe('direct');expect(r.lookup!('g:a','1').declaredIn).toBeUndefined();expect(r.metadata.declaration_provenance?.plugin_trust_status).toBe('missing_assertion');}
 expect(second.metadata.declaration_provenance).toEqual(first.metadata.declaration_provenance);
});

it('sanitizes application IDs only at the output boundary while preserving exact internal references',async()=>{
 const f=await fixture(),d=f.graph.contexts[0].declarations;d.pluginApplications[0].id='application\u202e';d.records[1].origin.applicationId='application\u202e';await f.save();const r=await f.capture();expect(r.metadata.declarations_complete).toBe(true);expect(r.metadata.declaration_provenance?.contexts[0]?.plugin_applications?.[0]?.id).toBe('application');
});

it('keeps helper trust accepted when only the independent plugin consumer trust is disabled',async()=>{
 const f=await fixture(),r=await f.capture({...f.settings,trust:undefined});expect(r.metadata.declarations_complete).toBe(false);expect(r.metadata.declaration_provenance?.plugin_trust_status).toBe('disabled');expect(r.metadata.declaration_provenance?.trust_status).toBe('accepted');
});

it('preserves same-path directory comparison and mandatory limitations in production metadata',async()=>{
 const f=await fixture(),r=await f.capture();expect(r.metadata.declarations_complete).toBe(true);
 expect(r.metadata.declaration_provenance?.limitations).toContain('plugin_directory_origin_same_path_not_compared');
 expect(r.metadata.declaration_provenance?.limitations).toContain('plugin_directory_snapshot_post_build');
 expect(r.metadata.declaration_provenance?.contexts[0]?.plugin_applications?.[0]?.comparison).toBe('same-path-origin');
});

it('reports a distinct directory content comparison without the same-path limitation',async()=>{
 const f=await fixture(true),r=await f.capture();expect(r.metadata.declarations_complete).toBe(true);const m=r.metadata.declaration_provenance!;expect(m.contexts[0]!.plugin_applications![0]!.comparison).toBe('directory-content-exact');expect(m.limitations).toContain('plugin_directory_snapshot_post_build');expect(m.limitations).not.toContain('plugin_directory_origin_same_path_not_compared');
});
it('does not treat a distinct directory content mismatch as a same-path observation',async()=>{
 const f=await fixture(true,true),r=await f.capture();expect(r.lookup!('g:a','1').relation).toBe('unknown');expect(r.metadata.reasons).toContain('plugin_snapshot_mismatch');
});
it.each(['missing','null','unknown'])('rejects incomplete directory origin identity: %s',async kind=>{
 const f=await fixture(),a=f.graph.contexts[0].declarations.pluginApplications[0];if(kind==='missing')delete a.originRelation;else a.originRelation=kind==='null'?null:'unknown';await f.save();expect((await f.capture()).metadata.declarations_complete).toBe(false);
});

it('forbids directory-origin evidence on a JAR snapshot',async()=>{
 const f=await fixture(),a=f.graph.contexts[0].declarations.pluginApplications[0];a.runtimeSnapshotRef={kind:'jar',snapshotVersion:1,invocationId:'invocation',capturePhase:'export-task',size:0,sha256:'0'.repeat(64),snapshotPath:'.osv-mcp/plugin-runtime/invocation/jars/'+('0'.repeat(64))+'.jar'};expect(pluginApplicationSchema.safeParse(a).success).toBe(false);
});
it('keeps verified relations with the default unset plugin settings',async()=>{
 const f=await fixture(),r=await f.capture({trust:undefined,invalid:false,toolchains:new Set(),loaders:new Set()});
 expect(r.lookup!('g:a','1').relation).toBe('direct');expect(r.lookup!('g:a','1').declaredIn).toBeUndefined();expect(r.metadata.declarations_complete).toBe(false);
 expect(r.metadata.reasons).toEqual(expect.arrayContaining(['plugin_toolchain_not_approved','plugin_loader_not_approved']));expect(r.metadata.declaration_provenance?.plugin_trust_status).toBe('disabled');
});
it('still rejects a loader profile that does not match the plugin specification',async()=>{
 const f=await fixture(),a=f.graph.contexts[0].declarations.pluginApplications[0];a.loaderProfileDigest='0'.repeat(64);await f.save();
 const r=await f.capture();expect(r.lookup!('g:a','1').relation).toBe('unknown');expect(r.metadata.reasons).toContain('plugin_loader_profile_mismatch');
});
