import {createHash} from 'node:crypto';
import {btaDriverProfiles} from './gradleBtaDriverRuntime.mjs';
import {ownerTupleArtifacts,ownerJdkProfile} from './gradleSnapshotOwnerExpected.mjs';
export const btaModes=['control','observe','mutate-before','mutate-after','blob-corrupt','source-fault','default-config','unregistered-config','foreign-config'];
export const btaSources=['src/test/fixtures/BtaOwnedDriver.java','src/test/fixtures/gradle-bta-owned-driver.gradle','src/test/fixtures/gradleBtaDriverRuntime.mjs','src/test/fixtures/gradleBtaDriverProof.mjs','src/test/fixtures/gradleBtaDriverProof.d.mts','src/test/gradle/btaDriver.integration.test.ts'];
export const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{throw Error(m)},eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b),sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const librarySource='package dep\nclass Library { fun message(): String = "library-value" }\n';
const consumerSource=v=>'package consumer\nfun main() { print(dep.Library().message() + ":'+v+'") }\n';
function inventory(items,paths,allowEmpty=false){
 if(!Array.isArray(items)||!items.length||new Set(items.map(i=>i.path)).size!==items.length||items.some(i=>typeof i.path!=='string'||i.path.startsWith('/')||i.path.split('/').some(x=>!x||x==='.'||x==='..')||!Number.isSafeInteger(i.size)||(allowEmpty?i.size<0:i.size<=0)||!sha(i.sha256))||paths&&!eq(items.map(i=>i.path),paths))fail('bta_driver_inventory_invalid');
}
function inspectCheck(c,sealed,reason){
 if(!c||c.reason!==reason||!Array.isArray(c.saved)||!Array.isArray(c.current)||c.storageReads!==c.saved.length||c.sourceReads!==c.current.length)fail('bta_driver_check_invalid');
 const expected=sealed.map(({id,size,sha256})=>({id,size,sha256}));
 if(reason==='kotlin_pipeline_snapshot_storage_mismatch'){
  if(c.sourceReads!==0||c.storageReads!==1||c.saved[0]?.id!==expected[0].id||c.saved[0].size!==expected[0].size||!sha(c.saved[0].sha256)||c.saved[0].sha256===expected[0].sha256)fail('bta_driver_storage_invalid');
 }else if(!eq(c.saved,expected)||c.storageReads!==2)fail('bta_driver_storage_invalid');
 if(reason==='kotlin_derived_snapshot_stale'){
  if(c.sourceReads!==1||c.current[0]?.id!==expected[0].id||c.current[0].size!==expected[0].size||!sha(c.current[0].sha256)||c.current[0].sha256===expected[0].sha256)fail('bta_driver_stale_invalid');
 }else if(reason===null&&(!eq(c.current,expected)||c.sourceReads!==2))fail('bta_driver_check_invalid');
}
export function configurationFaultReason(mode){return mode==='default-config'||mode==='unregistered-config'?'bta_driver_configuration_unregistered':mode==='foreign-config'?'bta_driver_configuration_binding_mismatch':null;}
function validateConfigurationEvidence(p,mode){
 const blockedBefore=['mutate-before','blob-corrupt'].includes(mode),fault=configurationFaultReason(mode),foreign=mode==='foreign-config';
 const files=p.snapshots.map(({id,size,sha256})=>({id,size,sha256}));
 const factories=[{configurationId:'config-1',stage:'library'},{configurationId:'config-2',stage:'warm'}];
 if(!blockedBefore)factories.push({configurationId:'config-3',stage:'consumer'});if(fault)factories.push({configurationId:'config-4',stage:'consumer'});
 const binding=(id,stage,parameter,source,snapshots)=>({configurationId:'config-'+id,bindingId:'binding-'+id,stage,parameterId:parameter?'parameter-'+parameter:null,sourceSha256:hash(source),snapshotBindings:snapshots});
 const bindings=[binding(1,'library',null,librarySource,[]),binding(2,'warm',1,consumerSource('v1'),files)];
 if(!blockedBefore)bindings.push(binding(3,'consumer',2,consumerSource('v2'),files));if(foreign)bindings.push(binding(4,'consumer',3,consumerSource('v2'),files));
 const use=(id,parameter,stage,kind)=>({configurationId:'config-'+id,parameterId:'parameter-'+parameter,stage,changes:{kind,modified:kind==='Known'?['build/owned/src/Consumer.kt']:[],removed:[]},snapshotBindings:files});
 const uses=[use(2,1,'warm','Unknown')];if(!blockedBefore)uses.push(use(3,2,'consumer','Known'));if(mode==='unregistered-config'||foreign)uses.push(use(4,3,'consumer','Known'));
 const check=(stage,id,parameter)=>({stage,expectedConfigurationId:'config-'+id,actualConfigurationId:'config-'+id,expectedBindingId:'binding-'+id,actualBindingId:'binding-'+id,expectedParameterId:parameter?'parameter-'+parameter:null,actualParameterId:parameter?'parameter-'+parameter:null,registered:true,configurationIdentity:true,bindingIdentity:true,contextIdentity:true,parameterIdentity:true,snapshotBindingsMatch:true,singleUse:true,reason:null});
 const checks=[check('library',1,null),check('warm',2,1)];
 if(!blockedBefore){
  const last=check('consumer',3,2);
  if(fault)Object.assign(last,{actualConfigurationId:'config-4',actualBindingId:foreign?'binding-4':null,actualParameterId:mode==='default-config'?null:'parameter-3',registered:foreign,configurationIdentity:false,bindingIdentity:false,contextIdentity:foreign,parameterIdentity:false,snapshotBindingsMatch:mode!=='default-config',singleUse:foreign,reason:fault});
  checks.push(last);
 }
 if(!eq(p.configurationFactories,factories)||!eq(p.configurationUses,uses)||!eq(p.configurationBindings,bindings)||!eq(p.configurationChecks,checks))fail('bta_driver_configuration_invalid');
 for(const c of p.compilations??[]){const id=c.stage==='library'?1:c.stage==='warm'?2:3,parameter=id===1?null:'parameter-'+(id-1);
  if(c.configurationId!=='config-'+id||c.bindingId!=='binding-'+id||c.parameterId!==parameter)fail('bta_driver_configuration_invalid');
 }
}
export function verifyBtaDriverRun(r,a){
 if(r?.schema!=='osv-mcp.bta-driver-run-v2'||!btaModes.includes(r.mode))fail('bta_driver_schema_invalid');
 const p=r.program,g=r.gradle,profile=btaDriverProfiles[a.gradleVersion];
 if(!profile||r.gradleVersion!==a.gradleVersion||!['Groovy','Kotlin'].includes(r.dsl)||r.dsl!==a.dsl||!r.runId||p?.schema!=='osv-mcp.bta-driver-program-v2'||g?.schema!=='osv-mcp.bta-driver-gradle-v1'||[p,g].some(x=>x.mode!==r.mode||x.runId!==r.runId)||g.gradleVersion!==r.gradleVersion||!eq(g.fixtureInputsSha256,a.fixtureInputsSha256))fail('bta_driver_identity_invalid');
 if(a.javaSha256!==ownerJdkProfile.java.sha256||g.javaExecutableSha256!==ownerJdkProfile.java.sha256||g.javacExecutableSha256!==ownerJdkProfile.javac.sha256||p.javaExecutableSha256!==ownerJdkProfile.java.sha256||p.javaVersion!==ownerJdkProfile.javap.version||g.javaVersion!==ownerJdkProfile.javap.version||p.kotlinVersion!==profile.kotlinVersion||p.actualCompilerVersion!==profile.kotlinVersion||p.privatePermissions!=='rwx------'||p.observationKind!=='offered-inputs-only'||p.naturalContentBinding!==false||p.productionAdopted!==false||p.listMutationRejected!==true||g.maxWorkers!==1||g.parallel!==false||!g.javaVersion?.startsWith('21.')||g.javaExecutableSha256!==a.javaSha256)fail('bta_driver_scope_invalid');
 if(g.gradleApi?.sha256!==ownerTupleArtifacts[a.gradleVersion].gradle)fail('bta_driver_artifact_invalid');
 if(!Array.isArray(p.runtime)||p.runtime.length!==profile.runtime.length)fail('bta_driver_artifact_invalid');
 for(let i=0;i<p.runtime.length;i++)if(p.runtime[i].sha256!==profile.runtime[i].sha256||p.runtime[i].name!==profile.runtime[i].relativePath.split('/').at(-1))fail('bta_driver_artifact_invalid');
 for(const [role,module]of [['api','kotlin-build-tools-api'],['implementation','kotlin-build-tools-impl'],['compiler','kotlin-compiler-embeddable']]){
  const entry=profile.runtime.find(x=>x.coordinate==='org.jetbrains.kotlin:'+module+':'+profile.kotlinVersion),actual=role==='compiler'?p.compiler:p.artifacts?.[role];
  if(!actual?.artifact||actual.sha256!==entry.sha256||p.runtime.filter(x=>x.sha256===actual.sha256&&x.artifact===actual.artifact).length!==1)fail('bta_driver_artifact_invalid');
 }
 inventory(p.driverClasses,['BtaOwnedDriver$Binding.class','BtaOwnedDriver$ConfigurationRejected.class','BtaOwnedDriver.class']);
 const libPaths=['META-INF/ownedLibrary.kotlin_module','dep/Library.class'],outPaths=['META-INF/ownedConsumer.kotlin_module','consumer/ConsumerKt.class'];
 if(p.library?.sourceSha256!==hash(librarySource)||!sha(p.library.jarSha256))fail('bta_driver_input_invalid');inventory(p.library.classes,libPaths);
 if(!eq(r.libraryJarEntries,p.library.classes))fail('bta_driver_jar_mapping_invalid');
 const stdlib=profile.runtime.find(x=>x.coordinate==='org.jetbrains.kotlin:kotlin-stdlib:'+profile.kotlinVersion);
 if(!Array.isArray(p.snapshots)||p.snapshots.length!==2)fail('bta_driver_snapshot_invalid');
 for(let i=0;i<2;i++){
  const s=p.snapshots[i];if(s.id!==['library.snapshot','stdlib.snapshot'][i]||s.role!==['library','stdlib'][i]||s.inputSha256!==(i?p.runtime.find(x=>x.sha256===stdlib.sha256)?.sha256:p.library.jarSha256)||!Number.isSafeInteger(s.classCount)||s.classCount<1||!Number.isSafeInteger(s.size)||s.size<=0||!sha(s.sha256))fail('bta_driver_snapshot_invalid');
 }
 if(p.snapshots[0].classCount!==1||p.selectionCalls!==1)fail('bta_driver_selection_invalid');
 const preReason=r.mode==='mutate-before'?'kotlin_derived_snapshot_stale':r.mode==='blob-corrupt'?'kotlin_pipeline_snapshot_storage_mismatch':null;
 inspectCheck(p.preflight,p.snapshots,preReason);
 const configurationReason=configurationFaultReason(r.mode);
 validateConfigurationEvidence(p,r.mode);
 const consumerRan=preReason===null&&configurationReason===null,postReason=r.mode==='mutate-after'?'kotlin_derived_snapshot_stale':null;
 if(consumerRan)inspectCheck(p.postflight,p.snapshots,postReason);else if(p.postflight!==undefined)fail('bta_driver_check_invalid');
 const capture=consumerRan&&!postReason&&r.mode!=='control';if(capture)inspectCheck(p.capture,p.snapshots,null);else if(p.capture!==undefined)fail('bta_driver_check_invalid');
 const checks=[p.preflight,p.postflight,p.capture].filter(Boolean);
 if(p.sourceFileReads!==checks.reduce((n,c)=>n+c.sourceReads,0)||p.storageFileReads!==checks.reduce((n,c)=>n+c.storageReads,0)||p.reason!==(preReason??configurationReason??postReason))fail('bta_driver_check_invalid');
 const expectedEvents=[];const event=(name,phase)=>expectedEvents.push({event:name,phase});
 const configure=(id,stage,parameter,register=true)=>{const phase='owner-'+(stage==='library'?'library':stage==='warm'?'warm':'consumer');event('configuration:create:config-'+id,phase);if(parameter)event('configuration:use-incremental:config-'+id+':parameter-'+parameter,phase);if(register)event('configuration:register:config-'+id+':binding-'+id,phase);};
 const compileEvent=(name,phase,ran=true)=>{event('configuration:check:'+name,phase);if(ran){event('compile:begin:'+name,phase);event('compile:end:'+name,phase);}};
 configure(1,'library',null);compileEvent('library','owner-library');for(const id of ['library.snapshot','stdlib.snapshot']){event('snapshot:begin:'+id,'owner-snapshot');event('snapshot:end:'+id,'owner-snapshot');}
 event('selection:begin','owner-offer');event('selection:end','owner-offer');configure(2,'warm',1);compileEvent('warm','owner-warm');
 const mutation=()=>{event('mutation:begin','mutation');event('mutation:end','mutation');};
 if(preReason)mutation();event('gate:begin','owner-gate');event('gate:end','owner-gate');
 if(preReason===null){
  if(r.mode!=='control'){event('observer:begin','observer');event('observer:end','observer');}
  configure(3,'consumer',2);
  if(configurationReason)configure(4,'consumer',r.mode==='default-config'?null:3,r.mode==='foreign-config');
  compileEvent('consumer','owner-consumer',consumerRan);
  if(consumerRan){if(postReason)mutation();event('post:begin','owner-post');event('post:end','owner-post');if(capture){event('capture:begin','capture');event('capture:end','capture');}}
 }
 if(!eq(p.events,expectedEvents))fail('bta_driver_program_trace_invalid');
 const stages=consumerRan?['library','warm','consumer']:['library','warm'];if(!Array.isArray(p.compilations)||p.compilations.length!==stages.length)fail('bta_driver_compilation_invalid');
 for(let i=0;i<stages.length;i++){
  const c=p.compilations[i],library=i===0;
  const args=['-d','$PROJECT_ROOT/build/owned/'+(library?'library-classes':'consumer-classes'),'-classpath',library?'$RUNTIME_STDLIB':'$PROJECT_ROOT/build/owned/library.jar:$RUNTIME_STDLIB','-no-stdlib','-no-reflect','-module-name',library?'ownedLibrary':'ownedConsumer','-jvm-target','17'];
  if(c.stage!==stages[i]||c.result!=='COMPILATION_SUCCESS'||c.source!=='build/owned/src/'+(library?'Library.kt':'Consumer.kt')||c.sourceSha256!==hash(library?librarySource:consumerSource(i===1?'v1':'v2'))||!eq(c.arguments,args)||!eq(c.snapshotIds,library?[]:['library.snapshot','stdlib.snapshot']))fail('bta_driver_compilation_invalid');
  inventory(c.outputs,library?libPaths:outPaths);
 }
 if(!eq(p.compilations[0].outputs,p.library.classes)||p.finalSourceSha256!==hash(consumerSource('v2')))fail('bta_driver_output_invalid');
 if(consumerRan&&p.compilations[1].outputs[1].sha256===p.compilations[2].outputs[1].sha256)fail('bta_driver_previous_output_reused');
 if(p.reason===null){if(!eq(p.finalOutputs,p.compilations[2].outputs))fail('bta_driver_output_invalid');}else if(!eq(p.finalOutputs,[]))fail('bta_driver_output_invalid');
 if(r.execution?.stage!==(consumerRan?'consumer':'warm')||r.execution?.code!==0||r.execution?.stdout!=='library-value:'+(consumerRan?'v2':'v1'))fail('bta_driver_execution_invalid');
 inventory(p.privateCache,undefined,true);if(!p.privateCache.some(f=>f.path==='shrunk-classpath-snapshot.bin'))fail('bta_driver_cache_invalid');
 // Gradle supplier placement is checked by interval, never by phase alone.
 if(['executed','didWork','skipped','noSource','failed'].some(k=>typeof g.stage?.[k]!=='boolean')||!g.stage.executed||!g.stage.didWork||g.stage.skipped||g.stage.noSource||g.stage.failed||!Array.isArray(g.events))fail('bta_driver_gradle_stage_invalid');
 const core=g.events.filter(e=>!e.event.startsWith('supplier:'));
 const coreExpected=[['registration:begin','configuration'],['registration:end','configuration'],['task:begin','natural'],['action:begin','action']];
 if(r.mode==='source-fault')coreExpected.push(['observer:begin','observer'],['getter:begin','observer'],['getter:end','observer'],['observer:end','observer']);
 coreExpected.push(['action:end','action'],['task:end','natural']);if(!eq(core.map(e=>[e.event,e.phase]),coreExpected))fail('bta_driver_gradle_trace_invalid');
 const at=name=>g.events.findIndex(e=>e.event===name),begin=at('observer:begin'),end=at('observer:end');
 const suppliers=g.events.flatMap((e,i)=>e.event==='supplier:begin'?[i]:[]);
 if(g.calls!==suppliers.length||g.calls<1||g.events.filter(e=>e.event==='supplier:end').length!==suppliers.length||g.getterCalls!==(r.mode==='source-fault'?1:0))fail('bta_driver_gradle_counter_invalid');
 let extra=0;
 for(const i of suppliers){const e=g.events[i];if(g.events[i+1]?.event!=='supplier:end'||g.events[i+1]?.phase!==e.phase)fail('bta_driver_gradle_trace_invalid');
  if(begin>=0&&begin<i&&i+1<end){if(e.phase!=='observer'||!(at('getter:begin')<i&&i+1<at('getter:end')))fail('bta_driver_extra_evaluation');extra++;}
  else if(!(e.phase==='configuration'&&at('registration:end')<i&&i+1<at('task:begin')||e.phase==='natural'&&at('task:begin')<i&&i+1<at('action:begin')||e.phase==='action'&&at('action:begin')<i&&i+1<at('action:end')))fail('bta_driver_gradle_phase_invalid');
 }
 if(extra!==(r.mode==='source-fault'?1:0))fail('bta_driver_fault_not_reproduced');
 return {offeredInputsVerified:p.reason===null&&!extra,reason:extra?'bta_driver_extra_evaluation':p.reason,kotlinCompilerCalls:p.compilations.length,extraMeasuredSupplierEvaluations:extra,naturalContentBinding:false,productionAdopted:false};
}
export function verifyBtaDriverCase(c,a){
 if(c?.schema!=='osv-mcp.bta-driver-case-v2'||c.gradleVersion!==a.gradleVersion||c.dsl!==a.dsl||!eq(c.sourcesSha256,a.sourcesSha256)||btaSources.some(p=>!sha(c.sourcesSha256?.[p]))||c.fixtureInputsSha256?.['BtaOwnedDriver.java']!==c.sourcesSha256[btaSources[0]]||c.fixtureInputsSha256?.['driver.gradle']!==c.sourcesSha256[btaSources[1]]||!Array.isArray(c.runs)||c.runs.length!==btaModes.length)fail('bta_driver_case_invalid');
 if(!Object.keys(c.fixtureInputsSha256).includes(c.dsl==='Kotlin'?'build.gradle.kts':'build.gradle'))fail('bta_driver_case_invalid');
 const ids=new Set();const decisions=c.runs.map((r,i)=>{if(r.mode!==btaModes[i]||ids.has(r.runId))fail('bta_driver_identity_invalid');ids.add(r.runId);return verifyBtaDriverRun(r,{...a,fixtureInputsSha256:c.fixtureInputsSha256});});
 const natural=r=>r.gradle.events.filter(e=>e.phase!=='observer');
 for(const r of c.runs.slice(1)){
  if(!eq(natural(r),natural(c.runs[0]))||r.gradle.calls!==c.runs[0].gradle.calls+(r.mode==='source-fault'?1:0)||!eq(r.program.library,c.runs[0].program.library)||!eq(r.program.snapshots,c.runs[0].program.snapshots)||!eq(r.program.driverClasses,c.runs[0].program.driverClasses)||!eq(r.program.compilations[1],c.runs[0].program.compilations[1]))fail('bta_driver_noninterference_failed');
  if(r.program.compilations.length===3&&!eq(r.program.compilations[2],c.runs[0].program.compilations[2]))fail('bta_driver_noninterference_failed');
 }
 return {runs:decisions,approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0};
}

export const btaDriverTargets=[
 ['configuration-missing','bta_driver_configuration_invalid'],['configuration-receiver','bta_driver_configuration_invalid'],['configuration-parameter','bta_driver_configuration_invalid'],['configuration-check','bta_driver_configuration_invalid'],['configuration-consumed','bta_driver_configuration_invalid'],['configuration-use','bta_driver_configuration_invalid'],['configuration-changes','bta_driver_configuration_invalid'],['configuration-fault-missing','bta_driver_configuration_invalid'],
 ['receipt','bta_driver_scope_invalid'],['permissions','bta_driver_scope_invalid'],['runtime','bta_driver_artifact_invalid'],['library-source','bta_driver_input_invalid'],['jar-mapping','bta_driver_jar_mapping_invalid'],['snapshot-input','bta_driver_snapshot_invalid'],['snapshot-count','bta_driver_snapshot_invalid'],['snapshot-size','bta_driver_snapshot_invalid'],['selection','bta_driver_selection_invalid'],['mutable-list','bta_driver_scope_invalid'],['missing-program-event','bta_driver_program_trace_invalid'],['compile-inputs','bta_driver_compilation_invalid'],['compile-arguments','bta_driver_compilation_invalid'],['missing-compile','bta_driver_compilation_invalid'],['previous-output','bta_driver_previous_output_reused'],['final-output','bta_driver_output_invalid'],['execution','bta_driver_execution_invalid'],['stage','bta_driver_gradle_stage_invalid'],['supplier-phase','bta_driver_gradle_phase_invalid'],['counter','bta_driver_gradle_counter_invalid'],['fault-not-read','bta_driver_fault_not_reproduced']
].map(([kind,reason])=>({kind,reason}));
export function mutateBtaDriver(c,target){
 const r=structuredClone(c.runs[target.kind==='fault-not-read'?5:target.kind==='configuration-fault-missing'?6:1]),p=r.program,g=r.gradle;
 switch(target.kind){
  case 'configuration-missing':delete p.configurationBindings;break;
  case 'configuration-receiver':p.compilations[2].configurationId='config-foreign';break;
  case 'configuration-parameter':p.configurationBindings[2].snapshotBindings[0].sha256='0'.repeat(64);break;
  case 'configuration-check':p.configurationChecks[2].configurationIdentity=false;break;
  case 'configuration-consumed':p.configurationChecks[2].singleUse=false;break;
  case 'configuration-use':p.configurationUses[1].configurationId='config-2';break;
  case 'configuration-changes':p.configurationUses[1].changes.modified=[];break;
  case 'configuration-fault-missing':p.configurationChecks[2].reason=null;break;
  case 'receipt':p.naturalContentBinding=true;break;
  case 'permissions':p.privatePermissions='rwxrwxrwx';break;
  case 'runtime':p.runtime[0].sha256='0'.repeat(64);break;
  case 'library-source':p.library.sourceSha256='0'.repeat(64);break;
  case 'jar-mapping':r.libraryJarEntries.pop();break;
  case 'snapshot-input':p.snapshots[0].inputSha256='0'.repeat(64);break;
  case 'snapshot-count':p.snapshots[0].classCount=0;break;
  case 'snapshot-size':p.snapshots[0].size=0;break;
  case 'selection':p.selectionCalls++;break;
  case 'mutable-list':p.listMutationRejected=false;break;
  case 'missing-program-event':p.events=p.events.filter(e=>e.event!=='gate:begin');break;
  case 'compile-inputs':p.compilations[2].snapshotIds=[];break;
  case 'compile-arguments':p.compilations[2].arguments[3]='$RUNTIME_STDLIB';break;
  case 'missing-compile':p.compilations.pop();break;
  case 'previous-output':p.compilations[2].outputs[1].sha256=p.compilations[1].outputs[1].sha256;break;
  case 'final-output':p.finalOutputs=[];break;
  case 'execution':r.execution.stdout='library-value:v1';break;
  case 'stage':delete g.stage.noSource;break;
  case 'supplier-phase':{const i=g.events.findIndex(e=>e.event==='supplier:begin');g.events[i].phase='capture';g.events[i+1].phase='capture';break;}
  case 'counter':g.calls++;break;
  case 'fault-not-read':g.events=g.events.filter(e=>!(e.phase==='observer'&&e.event.startsWith('supplier:')));g.calls--;break;
 }
 return r;
}
export function btaDriverRegressions(c,a){
 return btaDriverTargets.map(target=>{let reason;try{verifyBtaDriverRun(mutateBtaDriver(c,target),{...a,fixtureInputsSha256:c.fixtureInputsSha256});}catch(e){reason=e.message;}
  if(reason!==target.reason)fail('bta_driver_regression_failed:'+JSON.stringify(target)+':'+reason);return {...target,accepted:false};
 });
}
