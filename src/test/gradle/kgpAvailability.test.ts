import {it,expect} from 'vitest';
import {kgpSlots,kgpAvailabilitySources,verifyKgpAvailabilityCase,verifyApiArtifact,resolveGradleApiArtifact,verifyKgpSnapshotFault,kgpAvailabilityRegressionTargets,mutateKgpAvailabilityFault,kgpAvailabilityRegressions} from '../fixtures/gradleKgpAvailabilityProof.mjs';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash='a'.repeat(64);
function injectGetter(r:any,slot:string,count=true){
 const i=r.events.findIndex((e:any)=>e.event==='gate:'+slot),phase='gate:'+slot;
 r.events.splice(i,0,{event:'getter:'+slot,phase},{event:'getter:end:'+slot,phase});
 if(count)r.getterCalls[slot]++;
}

function fixture(){
 const sourcesSha256=Object.fromEntries(kgpAvailabilitySources.map(p=>[p,hash]));
 const fixtureInputsSha256=Object.fromEntries(Array.from({length:7},(_,i)=>['input'+i,hash]));
 const runs=['control','diagnostic','unsupported'].map(mode=>{
  const events:any[]=[{event:'registration:begin',phase:'configuration'},{event:'registration:end',phase:'configuration'},{event:'task:begin:compileKotlin',phase:'natural:compileKotlin'},...kgpSlots.map(s=>({event:'supplier:'+s,phase:'natural:compileKotlin'})),{event:'action:begin',phase:'natural:compileKotlin'},{event:'action:end',phase:'natural:compileKotlin'},{event:'task:end:compileKotlin',phase:'natural:compileKotlin'}];
  const reads:any[]=[],decisions:any[]=[];
  const counts=Object.fromEntries(kgpSlots.map(s=>[s,1]));
  for(const slot of kgpSlots){
   const phase=(mode==='diagnostic'?'diagnostic:':mode==='control'?'control:':'gate:')+slot;
   events.push({event:'slot:begin:'+slot,phase});
   if(mode==='diagnostic'){
    events.push({event:'getter:'+slot,phase:'diagnostic:'+slot});const before={...counts};counts[slot]=(counts[slot]??0)+1;events.push({event:'supplier:'+slot,phase:'diagnostic:'+slot},{event:'getter:end:'+slot,phase:'diagnostic:'+slot});
    reads.push({slot,before,after:{...counts},files:[{name:slot+'.jar',size:4,sha256:hash}]});
   }else if(mode==='unsupported'){
    events.push({event:'gate:'+slot,phase:'gate:'+slot});decisions.push({slot,status:'unsupported',reason:'kgp_capture_recipe_unsupported',getterCalls:0});
   }
   events.push({event:'slot:end:'+slot,phase});
  }
  return {schema:'osv-mcp.kgp-availability-run-v2',faultSnapshotRead:false,runId:mode,gradleVersion:'8.11.1',mode,maxWorkers:1,parallel:false,implementation:{artifact:'/cache/kgp.jar',sha256:hash},apiArtifacts:{gradle:{type:'org.gradle.api.tasks.TaskInputs',artifact:'/gradle/core-api.jar',sha256:hash},kgp:{type:'org.jetbrains.kotlin.gradle.tasks.KotlinCompileTool',artifact:'/kgp/api.jar',sha256:hash}},fixtureInputsSha256,events,reads,decisions,getterCalls:Object.fromEntries(kgpSlots.map(s=>[s,mode==='diagnostic'?1:0])),compileState:{executed:true,didWork:true,noSource:false,failed:false},approvedRecipes:[],adopted:false,jarEntries:[{name:'proof.class',sha256:hash}],archiveSha256:hash};
 });
 return {proof:{faultSnapshotRead:false,schema:'osv-mcp.kgp-availability-case-v2',gradleVersion:'8.11.1',dsl:'Groovy',sourcesSha256,fixtureInputsSha256,runs},approval:{gradleVersion:'8.11.1',dsl:'Groovy',sourcesSha256}};
}
it('rejects incomplete availability evidence instead of assuming unsupported was tested',()=>expect(()=>verifyKgpAvailabilityCase({},{})).toThrow('kgp_availability_schema_invalid'));
it('records diagnostic deltas without promoting a slot to supported',()=>{
 const {proof,approval}=fixture();expect(verifyKgpAvailabilityCase(proof,approval)).toMatchObject({adopted:false,ownerReceiptSupported:false,stableRereadSupported:false});
});
for(const slot of kgpSlots){
 it(`rejects a hidden source getter in unsupported ${slot}`,()=>{
  const {proof,approval}=fixture();injectGetter(proof.runs[2],slot);
  expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_no_read_violated');
 });
 it(`requires concrete nonempty acquisition evidence for ${slot}`,()=>{
  const {proof,approval}=fixture();proof.runs[1]!.reads.find(r=>r.slot===slot).files=[];
  expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_read_invalid');
 });
 it(`checks supplier deltas against the actual trace for ${slot}`,()=>{
  const {proof,approval}=fixture();proof.runs[1]!.reads.find(r=>r.slot===slot).after[slot]++;
  expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_counter_invalid');
 });
 it(`rejects a missing unsupported gate for ${slot}`,()=>{
  const {proof,approval}=fixture();proof.runs[2]!.events=proof.runs[2]!.events.filter(e=>e.event!=='gate:'+slot);
  expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_event_invalid');
 });
}
it('does not accept a task which failed or never compiled',()=>{
 const {proof,approval}=fixture();proof.runs[0]!.compileState.didWork=false;
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_compile_invalid');
});
it('rejects implementation or source-version drift',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.implementation.sha256='b'.repeat(64);
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_implementation_changed');
});
it('rejects a missing registration boundary',()=>{
 const {proof,approval}=fixture();proof.runs[0]!.events=proof.runs[0]!.events.filter(e=>e.event!=='registration:end');
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_event_invalid');
});
it('requires unsupported and control natural traces to match',()=>{
 const {proof,approval}=fixture();const e=proof.runs[2]!.events;e.splice(e.findIndex(x=>x.event==='task:end:compileKotlin'),0,{event:'supplier:libraries',phase:'natural:compileKotlin'});
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_noninterference_failed');
});
it('rejects missing output artifact evidence',()=>{
 const {proof,approval}=fixture();proof.runs[2]!.jarEntries=[];
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_artifact_missing');
});

it('rejects a forged adoption flag despite matching diagnostic traces',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.adopted=true;
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_scope_invalid');
});
it('does not promote snapshot zero sensor deltas into a readiness recipe',()=>{
 const {proof,approval}=fixture();const r=proof.runs[1]!;
 r.events=r.events.filter(e=>!(e.event==='supplier:snapshots'&&e.phase==='diagnostic:snapshots'));
 for(const read of r.reads){if(read.slot==='snapshots')read.after.snapshots--;if(['compilerClasspath','taskInputs'].includes(read.slot)){read.before.snapshots--;read.after.snapshots--;}}
 expect(verifyKgpAvailabilityCase(proof,approval).stableRereadSupported).toBe(false);
});
it('rejects acquisition which ran before the natural compile finished',()=>{
 const {proof,approval}=fixture();const e=proof.runs[1]!.events,index=e.findIndex(x=>x.event==='getter:libraries');
 const getter=e.splice(index,1)[0]!;e.splice(e.findIndex(x=>x.event==='task:end:compileKotlin'),0,getter);
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_event_invalid');
});
it('rejects foreign source hashes or the wrong runtime version',()=>{
 const {proof,approval}=fixture();expect(()=>verifyKgpAvailabilityCase(proof,{...approval,gradleVersion:'9.2.1'})).toThrow('kgp_availability_identity_invalid');
});

it('rejects an uncounted getter event in a no-read run',()=>{
 const {proof,approval}=fixture();injectGetter(proof.runs[2],'snapshots',false);
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_getter_counter_invalid');
});
it('rejects unsupported snapshot reads even with cached values and identical natural traces',()=>{
 const {proof,approval}=fixture();proof.faultSnapshotRead=true;proof.runs[2]!.faultSnapshotRead=true;proof.runs[2]!.getterCalls.snapshots=1;
 injectGetter(proof.runs[2],'snapshots',false);
 expect(()=>verifyKgpAvailabilityCase(proof,{...approval,faultSnapshotRead:true})).toThrow('kgp_availability_no_read_violated');
});
it('rejects a fault flag without an actual diagnostic getter call',()=>{
 const {proof,approval}=fixture();proof.faultSnapshotRead=true;proof.runs[2]!.faultSnapshotRead=true;
 expect(()=>verifyKgpAvailabilityCase(proof,{...approval,faultSnapshotRead:true})).toThrow('kgp_availability_fault_not_reproduced');
});

it('requires explicit fault approval rather than accepting a changed run contract',()=>{
 const {proof,approval}=fixture();proof.faultSnapshotRead=true;
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_identity_invalid');
});

it('rejects an API artifact from a different Gradle runtime',()=>{
 expect(()=>verifyApiArtifact({artifact:'/gradle-8/lib/core-api.jar',sha256:hash},{artifact:'/gradle-9/lib/core-api.jar',sha256:'b'.repeat(64)})).toThrow('kgp_availability_api_artifact_mismatch');
});
it('rejects an invalid phase in the actual getter fault before accepting its rejection reason',()=>{
 const {proof,approval}=fixture();proof.faultSnapshotRead=true;const r=proof.runs[2]!;r.faultSnapshotRead=true;r.getterCalls.snapshots=1;
 injectGetter(r,'snapshots',false);for(const e of r.events)if(e.event==='getter:snapshots'||e.event==='getter:end:snapshots')e.phase='unbound-fault';
 expect(()=>verifyKgpAvailabilityCase(proof,{...approval,faultSnapshotRead:true})).toThrow('kgp_availability_trace_phase_invalid');
});
it('rejects additional supplier evaluations outside a fault getter window',()=>{
 const {proof,approval}=fixture();proof.faultSnapshotRead=true;const r=proof.runs[2]!;r.faultSnapshotRead=true;r.getterCalls.snapshots=1;
 injectGetter(r,'snapshots',false);r.events.splice(r.events.findIndex((e:any)=>e.event==='gate:snapshots'),0,{event:'supplier:snapshots',phase:'gate:snapshots'});
 expect(()=>verifyKgpAvailabilityCase(proof,{...approval,faultSnapshotRead:true})).toThrow('kgp_availability_supplier_outside_getter');
});

function faultFixture(){const {proof,approval}=fixture();proof.faultSnapshotRead=true;proof.runs[2]!.faultSnapshotRead=true;injectGetter(proof.runs[2],'snapshots');return {proof,approval:{...approval,faultSnapshotRead:true}};}
it('validates the entire cached getter fault before returning its expected rejection',()=>{
 const {proof,approval}=faultFixture();expect(verifyKgpSnapshotFault(proof,approval)).toMatchObject({actualGetterCalls:1,extraInstrumentedSuppliers:0});
});
for(const target of kgpAvailabilityRegressionTargets)it(`rejects fault regression ${target.name}`,()=>{
 const {proof,approval}=faultFixture();expect(()=>verifyKgpAvailabilityCase(mutateKgpAvailabilityFault(proof,target.name),approval)).toThrow(target.reason);
});
it('shares the same fault rejection targets with the native harness and aggregator',()=>{
 const {proof,approval}=faultFixture();expect(kgpAvailabilityRegressions(proof,approval)).toHaveLength(kgpAvailabilityRegressionTargets.length);
});
it('rejects a different Gradle API JAR in the supplied runtime directory',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'kgp-api-binding-'));
 try{
  const native=path.join(root,'native-gradle-core-api-8.11.1.jar'),lib=path.join(root,'gradle-8.11.1','lib');await mkdir(lib,{recursive:true});
  await writeFile(native,'actual runtime API');await writeFile(path.join(lib,'gradle-core-api-9.2.1.jar'),'different runtime API');
  const expected={artifact:native,sha256:createHash('sha256').update('actual runtime API').digest('hex')};
  await expect(resolveGradleApiArtifact(lib,expected)).rejects.toThrow('kgp_availability_api_artifact_mismatch');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('allows a legitimate directory alias to the same runtime API artifact',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'kgp-api-alias-'));
 try{
  const native=path.join(root,'native.jar'),lib=path.join(root,'lib');await mkdir(lib);await writeFile(native,'same API');
  await symlink(native,path.join(lib,'gradle-core-api-8.11.1.jar'));
  const expected={artifact:await import('node:fs/promises').then(fs=>fs.realpath(native)),sha256:createHash('sha256').update('same API').digest('hex')};
  await expect(resolveGradleApiArtifact(lib,expected)).resolves.toEqual(expected);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('requires API origin bindings even in a fault proof',()=>{
 const {proof,approval}=faultFixture();delete (proof.runs[2]!.apiArtifacts as any).gradle;
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_api_binding_missing');
});

it('allows natural task-graph preparation between registration and the first task',()=>{
 const {proof,approval}=fixture();
 for(const r of proof.runs){r.events.splice(2,0,...kgpSlots.map(s=>({event:'supplier:'+s,phase:'configuration'})));if(r.mode==='diagnostic')for(const read of r.reads)for(const s of kgpSlots){read.before[s]++;read.after[s]++;}}
 expect(verifyKgpAvailabilityCase(proof,approval).adopted).toBe(false);
});
it('does not hide a post-compile fault evaluation under the preparation phase',()=>{
 const {proof,approval}=faultFixture();const e=proof.runs[2]!.events;e.splice(e.findIndex(x=>x.event==='gate:snapshots'),0,{event:'supplier:snapshots',phase:'configuration'});
 expect(()=>verifyKgpAvailabilityCase(proof,approval)).toThrow('kgp_availability_trace_phase_invalid');
});

it('rejects changed bytes at the same runtime API path',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'kgp-api-bytes-'));
 try{
  const lib=path.join(root,'lib');await mkdir(lib);const jar=path.join(lib,'gradle-core-api-8.11.1.jar');await writeFile(jar,'old API');
  const expected={artifact:await import('node:fs/promises').then(fs=>fs.realpath(jar)),sha256:createHash('sha256').update('old API').digest('hex')};
  await writeFile(jar,'new API');await expect(resolveGradleApiArtifact(lib,expected)).rejects.toThrow('kgp_availability_api_artifact_mismatch');
 }finally{await rm(root,{recursive:true,force:true});}
});
