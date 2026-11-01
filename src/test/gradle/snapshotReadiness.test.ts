import {it,expect} from 'vitest';
import {snapshotModes,snapshotSources,verifySnapshotReadinessCase,verifySnapshotReadinessFault,snapshotStateTargets,mutateSnapshotState,snapshotStateRegressions} from '../fixtures/gradleSnapshotReadinessProof.mjs';
const hash='a'.repeat(64);
function fixture(){
 const approvedApi={gradle:hash,kgp:hash,implementation:hash},sourcesSha256=Object.fromEntries(snapshotSources.map(p=>[p,hash]));
 const fixtureInputsSha256={'build-logic/snapshot-helper.gradle':hash};
 const runs=snapshotModes.map(mode=>{
  const events:any[]=[];const add=(event:string,phase:string)=>events.push({event,phase});
  add('registration:begin','configuration');add('registration:end','configuration');add('supplier:begin','configuration');add('supplier:end','configuration');add('task:begin','natural');
  if(mode!=='skipped'){add('supplier:begin','natural');add('supplier:end','natural');add('action:begin','action');if(mode==='observe'){add('preflight:begin:early','preflight:early');add('gate:early','preflight:early');add('preflight:end:early','preflight:early');}add('action:end','action');}
  add('task:end','natural');
  const names=mode==='observe'?['early','wrong-task','wrong-property','capture']:['skipped','unknown-source'].includes(mode)?['refusal']:[];
  const checks=names.map(name=>{
   const reason=name==='early'?'task_not_complete':name==='wrong-task'?'task_binding_mismatch':name==='wrong-property'?'property_binding_mismatch':name==='capture'?null:mode==='skipped'?'stage_not_executed':'source_kind_unsupported';
   if(name!=='early'){add('preflight:begin:'+name,'preflight:'+name);add('gate:'+name,'preflight:'+name);add('preflight:end:'+name,'preflight:'+name);}
   const facts={profileApproved:true,taskIdentity:name!=='wrong-task',propertyIdentity:name!=='wrong-property',sourceKnown:mode!=='unknown-source',stageObserved:name!=='early',stageComplete:name!=='early'&&mode!=='skipped',naturalCalls:mode==='skipped'?1:2};
   return {facts,name,accepted:reason===null,reason,getterCalls:0,taskIdentity:name!=='wrong-task',propertyIdentity:name!=='wrong-property',stageComplete:name!=='early'&&mode!=='skipped',naturalCalls:mode==='skipped'?1:2};
  });
  if(mode==='observe'){add('binding:recheck','capture');add('getter:begin','capture');add('getter:end','capture');}
  if(mode==='freeze-diagnostic'){add('mutation:begin','mutation-diagnostic');add('mutation:end','mutation-diagnostic');}
  return {schema:'osv-mcp.snapshot-readiness-run-v2',preflightReadFault:false,mode,runId:mode,gradleVersion:'8.11.1',profileApproved:true,api:Object.fromEntries(Object.keys(approvedApi).map(role=>[role,{artifact:'/cache/'+role+'.jar',sha256:hash}])),fixtureInputsSha256,maxWorkers:1,parallel:false,
   events,checks,calls:mode==='skipped'?1:2,getterCalls:mode==='observe'?1:0,metadataReadsAfterGate:mode==='observe'?1:0,
   binding:{taskId:'task-1',containerId:'nested-1',propertyId:'snapshot-1',role:'classpathSnapshotProperties.classpathSnapshot',publicTaskType:true,propertyType:true,sourceKind:mode==='unknown-source'?'live-tree':'reviewed-default-plus-empty-concrete-sensor',taskIdentityAfterExecution:true,...(mode==='observe'?{propertyIdentityAfterGate:true}:{})},
   stage:{observed:true,executed:true,didWork:mode!=='skipped',skipped:mode==='skipped',noSource:false,failed:false,completed:mode!=='skipped'},files:mode==='observe'?[{name:'snapshot.bin',size:4,sha256:hash}]:[],freeze:mode==='freeze-diagnostic'?{attempts:1,rejected:true,errorType:'java.lang.IllegalStateException'}:null,productionAdopted:false,archiveSha256:hash,jarEntries:[{name:'proof.class',sha256:hash}]};
 });
 const proof={preflightReadFault:false,schema:'osv-mcp.snapshot-readiness-case-v2',gradleVersion:'8.11.1',dsl:'Kotlin',approvedApi,sourcesSha256,fixtureInputsSha256,runs};
 return {proof,approval:{gradleVersion:'8.11.1',dsl:'Kotlin',approvedApi,sourcesSha256}};
}
it('requires complete instance binding and natural execution evidence',()=>expect(()=>verifySnapshotReadinessCase({},{})).toThrow('snapshot_readiness_schema_invalid'));
it('recognizes only a conditional snapshot witness with no content binding or production adoption',()=>{
 const {proof,approval}=fixture();expect(verifySnapshotReadinessCase(proof,approval)).toMatchObject({conditionalRereadWitness:true,productionAdopted:false,fullPipelineCandidate:false,naturalContentBinding:false});
});
for(const mode of ['control','skipped','unknown-source','freeze-diagnostic'])it(`rejects a hidden value read in ${mode}`,()=>{
 const {proof,approval}=fixture();proof.runs.find(r=>r.mode===mode)!.getterCalls=1;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_getter_counter_invalid');
});
for(const name of ['early','wrong-task','wrong-property'])it(`requires no source getter in the ${name} classifier`,()=>{
 const {proof,approval}=fixture();proof.runs[1]!.checks.find(c=>c.name===name)!.getterCalls=1;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_gate_invalid');
});
it('rejects a property recheck which does not identify the registered instance',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.binding.propertyIdentityAfterGate=false;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_capture_invalid');
});
it('requires a real natural materialization before reading',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.events=proof.runs[1]!.events.filter(e=>!e.event.startsWith('supplier:'));proof.runs[1]!.calls=0;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_stage_invalid');
});
it('rejects evaluation hidden in the capture phase',()=>{
 const {proof,approval}=fixture();const r=proof.runs[1]!;r.events.splice(r.events.findIndex(e=>e.event==='getter:end'),0,{event:'supplier:begin',phase:'capture'},{event:'supplier:end',phase:'capture'});r.calls++;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_supplier_invalid');
});
it('requires gate witness counts to match events before the gate',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.checks[0]!.naturalCalls++;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_witness_invalid');
});
it('does not upgrade a successful task with a skipped action into ready',()=>{
 const {proof,approval}=fixture();proof.runs[2]!.stage.completed=true;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_stage_invalid');
});
it('does not accept an unknown source as the closed source profile',()=>{
 const {proof,approval}=fixture();proof.runs[3]!.binding.sourceKind='reviewed-default-plus-empty-concrete-sensor';
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_binding_invalid');
});
it('rejects API drift and source drift',()=>{
 const {proof,approval}=fixture();proof.runs[0]!.api.gradle!.sha256='b'.repeat(64);
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_api_mismatch');
});
it('requires mutation diagnostics to actually attempt a change',()=>{
 const {proof,approval}=fixture();proof.runs[4]!.freeze!.attempts=0;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_mutation_invalid');
});
it('leaves the conditional witness false if the property accepts post-execution mutation',()=>{
 const {proof,approval}=fixture();proof.runs[4]!.freeze!.rejected=false;proof.runs[4]!.freeze!.errorType=null as any;
 expect(verifySnapshotReadinessCase(proof,approval).conditionalRereadWitness).toBe(false);
});
for(const event of ['registration:begin','registration:end','task:begin','task:end','action:begin','action:end','gate:capture','getter:begin','getter:end'])it(`rejects missing ${event}`,()=>{
 const {proof,approval}=fixture();proof.runs[1]!.events=proof.runs[1]!.events.filter(e=>e.event!==event);
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow();
});
it('rejects a forged current task identity',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.binding.taskIdentityAfterExecution=false;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_binding_invalid');
});
it('requires an actual nonempty snapshot inventory',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.files=[];
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_capture_invalid');
});

for(const field of ['noSource','skipped'])for(const value of [undefined,null,'false',0])it(`rejects missing/nonboolean ${field}=${String(value)}`,()=>{
 const {proof,approval}=fixture();const stage=proof.runs[1]!.stage as any;if(value===undefined)delete stage[field];else stage[field]=value;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_stage_flags_invalid');
});
it('rejects noSource=true despite a claimed completed task',()=>{
 const {proof,approval}=fixture();proof.runs[1]!.stage.noSource=true;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_stage_invalid');
});

function faultFixture(){
 const {proof,approval}=fixture();proof.preflightReadFault=true;proof.runs[1]!.preflightReadFault=true;
 const r=proof.runs[1]!,gate=r.events.findIndex(e=>e.event==='gate:wrong-task');
 r.events.splice(gate,0,{event:'getter:begin',phase:'preflight:wrong-task'},{event:'getter:end',phase:'preflight:wrong-task'});
 r.getterCalls++;r.checks.find(c=>c.name==='wrong-task')!.getterCalls++;
 return {proof,approval:{...approval,preflightReadFault:true}};
}
it('rejects a real-shaped cached read before a refusing preflight even without extra suppliers',()=>{
 const {proof,approval}=faultFixture();expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_preflight_read');
 expect(verifySnapshotReadinessFault(proof,approval)).toEqual({actualPreflightReads:1,extraInstrumentedSuppliers:0,gate:'wrong-task'});
});
it('does not count a flag without an actual broker read as a reproduced fault',()=>{
 const {proof,approval}=fixture();proof.preflightReadFault=true;proof.runs[1]!.preflightReadFault=true;
 expect(()=>verifySnapshotReadinessCase(proof,{...approval,preflightReadFault:true})).toThrow('snapshot_readiness_fault_not_reproduced');
});
it('requires explicit approval of the fault run contract',()=>{
 const {proof}=faultFixture();expect(()=>verifySnapshotReadinessCase(proof,{gradleVersion:proof.gradleVersion,dsl:proof.dsl,approvedApi:proof.approvedApi,sourcesSha256:proof.sourcesSha256})).toThrow('snapshot_readiness_identity_invalid');
});
it('does not permit raw object references in classifier facts',()=>{
 const {proof,approval}=fixture();(proof.runs[1]!.checks[1]!.facts as any).rawProperty={files:[]};
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_facts_invalid');
});
it('requires preflight read counters to match broker events',()=>{
 const {proof,approval}=faultFixture();proof.runs[1]!.checks[1]!.getterCalls=0;
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_gate_invalid');
});
it('requires fault artifact evidence before recognizing the expected refusal',()=>{
 const {proof,approval}=faultFixture();proof.runs[1]!.jarEntries=[];
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_artifact_invalid');
});
for(const target of snapshotStateTargets)it(`rejects state ${target.mode}/${target.field}/${target.action}`,()=>{
 const {proof,approval}=fixture();expect(()=>verifySnapshotReadinessCase(mutateSnapshotState(proof,target),approval)).toThrow(target.reason);
});
it('replays the same state rejection cases used by native and aggregate verification',()=>{
 const {proof,approval}=fixture();expect(snapshotStateRegressions(proof,approval)).toHaveLength(80);
});
for(const field of ['observed','executed','didWork','skipped','noSource','failed','completed'])it(`requires boolean TaskState ${field}`,()=>{
 const {proof,approval}=fixture();delete (proof.runs[1]!.stage as any)[field];
 expect(()=>verifySnapshotReadinessCase(proof,approval)).toThrow('snapshot_readiness_stage_flags_invalid');
});

// The published record is replayed against the current verifier and bound sources.
async function verifyPublishedRecord(record:any){
 const {readFile}=await import('node:fs/promises');const {createHash}=await import('node:crypto');
 const {assertNoAbsolutePaths}=await import('../manual/kgpRecordPaths.mjs');
 const {verifySnapshotFaultBinding,snapshotRecordCounts}=await import('../manual/snapshotReadinessRecord.mjs');
 const digest=async(p:string)=>createHash('sha256').update(await readFile(new URL('../../../'+p,import.meta.url))).digest('hex');
 assertNoAbsolutePaths(record);
 if(record.schema!=='osv-mcp.snapshot-readiness-experiment-v2')throw Error('snapshot-record-schema');
 for(const group of ['sourcesSha256','verificationSourcesSha256'])for(const [p,h] of Object.entries(record[group]))if(await digest(p)!==h)throw Error('snapshot-record-source-drift:'+p);
 if(Object.keys(record.sourcesSha256).join()!==snapshotSources.join())throw Error('snapshot-record-source-drift');
 if(await digest(record.apiReferenceRecord.path)!==record.apiReferenceRecord.sha256)throw Error('snapshot-record-api-reference-drift');
 const prior=JSON.parse(await readFile(new URL('../../../'+record.apiReferenceRecord.path,import.meta.url),'utf8'));
 if(record.matrices.map((m:any)=>m.gradleVersion).join()!=='8.11.1,9.2.1')throw Error('snapshot-record-matrix');
 for(const m of record.matrices){
  const old=prior.matrices.find((x:any)=>x.gradleVersion===m.gradleVersion).cases[0].runs[0];
  const approvedApi={gradle:old.apiArtifacts.gradle.sha256,kgp:old.apiArtifacts.kgp.sha256,implementation:old.implementation.sha256};
  if(m.cases.map((c:any)=>c.dsl).sort().join()!=='Groovy,Kotlin')throw Error('snapshot-record-matrix');
  for(const c of m.cases){
   const approval={gradleVersion:m.gradleVersion,dsl:c.dsl,approvedApi,sourcesSha256:record.sourcesSha256};
   if(JSON.stringify(verifySnapshotReadinessCase(c,approval))!==JSON.stringify(c.decision))throw Error('snapshot-record-decision-replay');
   if(JSON.stringify(snapshotStateRegressions(c,approval))!==JSON.stringify(c.stateRejections))throw Error('snapshot-record-state-replay');
   verifySnapshotFaultBinding(c);
   if(c.fault.accepted!==false||c.fault.reason!=='snapshot_readiness_preflight_read'||JSON.stringify(verifySnapshotReadinessFault(c.fault.proof,approval))!==JSON.stringify(c.fault.observation))throw Error('snapshot-record-fault-replay');
  }
 }
 const counts=snapshotRecordCounts(record.matrices);
 if(Object.entries(counts).some(([k,v])=>record.scope[k]!==v))throw Error('snapshot-record-scope');
 return counts;
}
const loadPublished=async()=>{const {readFile}=await import('node:fs/promises');return JSON.parse(await readFile(new URL('../../../docs/validation/gradle-snapshot-readiness-2026-11-01.json',import.meta.url),'utf8'));};
it('replays the published snapshot readiness record against current sources',async()=>{
 expect(await verifyPublishedRecord(await loadPublished())).toMatchObject({nativeBuilds:24,conditionalWitnesses:4,preflightCachedReadRejections:4,stateFlagRejections:320,noReadClassifierRefusals:20,productionAdoptions:0});
});
for(const [label,change,reason] of [
 ['a stale decision',(r:any)=>{r.matrices[0].cases[0].decision.conditionalRereadWitness=false;},'snapshot-record-decision-replay'],
 ['a fault proof paired with another control run',(r:any)=>{const c=r.matrices[0].cases[0];c.fault.proof.runs[0]={...c.fault.proof.runs[0],runId:'other-control'};},'snapshot-preflight-fault-unbound'],
 ['a fault run reusing the normal observe run id',(r:any)=>{const c=r.matrices[1].cases[1];c.fault.proof.runs[1].runId=c.runs[1].runId;},'snapshot-preflight-fault-unbound'],
 ['an inflated scope',(r:any)=>{r.scope.noReadClassifierRefusals++;},'snapshot-record-scope'],
 ['a drifted source hash',(r:any)=>{r.verificationSourcesSha256['src/test/fixtures/gradlePluginJarProof.ts']='0'.repeat(64);},'snapshot-record-source-drift'],
 ['an absolute path',(r:any)=>{r.matrices[0].cases[0].runs[0].api.gradle.artifact='/Users/someone/gradle.jar';},'kgp_availability_record_path_not_portable'],
] as const)it(`rejects a published record with ${label}`,async()=>{
 const record=await loadPublished();change(record);await expect(verifyPublishedRecord(record)).rejects.toThrow(reason);
});
