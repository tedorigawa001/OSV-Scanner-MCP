import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {verifySnapshotContentRun,verifySnapshotContentFaults,contentTargets,mutateSnapshotContent} from '../fixtures/gradleSnapshotContentProof.mjs';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const digest='a'.repeat(64),api=Object.fromEntries(['gradle','kgp','implementation'].map(k=>[k,{artifact:'artifact-'+k,sha256:digest}]));
const approval={gradleVersion:'8.11.1',fixtureInputsSha256:{file:digest},approvedApi:{gradle:digest,kgp:digest,implementation:digest}};
function specimen(){
 const bytes=Buffer.from('snapshot'),file={id:'caches/snapshot.bin',size:bytes.length,sha256:hash(bytes)};
 const pairs=[['registration:begin','configuration'],['registration:end','configuration'],['task:begin','natural'],['supplier:begin','natural'],['supplier:end','natural'],['action:begin','action'],['boundary:begin','boundary'],['getter:begin','boundary'],['getter:end','boundary'],['boundary:end','boundary'],['action:end','action'],['task:end','natural'],['post-action:begin','post-action'],['post-action:end','post-action'],['capture:begin','capture'],['capture:end','capture']];
 return {schema:'osv-mcp.snapshot-content-run-v2',mode:'boundary',readFault:'none',runId:'run-1',gradleVersion:'8.11.1',fixtureInputsSha256:approval.fixtureInputsSha256,api:structuredClone(api),isolatedCache:true,profileApproved:true,maxWorkers:1,parallel:false,productionAdopted:false,naturalContentBinding:false,observationBoundary:'Task.doFirst-before-KGP-action',binding:{publicTaskType:true,propertyType:true,taskIdentity:true,propertyIdentity:true,role:'classpathSnapshotProperties.classpathSnapshot'},stage:{executed:true,didWork:true,skipped:false,noSource:false,failed:false},events:pairs.map(([event,phase])=>({event,phase})),calls:1,getterCalls:1,receipt:[{...file,bytes:bytes.toString('base64')}],postAction:[{...file}],current:[{...file}],capture:{accepted:true,reason:null},mutation:null as any,archiveSha256:digest,jarEntries:[{name:'Proof.class',sha256:digest}]};
}
describe('snapshot content observation',()=>{
 it('requires evidence rather than approving an empty receipt',()=>expect(()=>verifySnapshotContentRun({},{})).toThrow('snapshot_content_schema_invalid'));
 it('compares retained bytes without approving a natural-consumption receipt',()=>expect(verifySnapshotContentRun(specimen(),approval)).toMatchObject({boundaryFreshness:true,naturalContentBinding:false,additionalMeasuredEvaluations:0}));
 for(const target of contentTargets)it('rejects '+JSON.stringify(target),()=>expect(()=>verifySnapshotContentRun(mutateSnapshotContent(specimen(),target),approval)).toThrow(target.reason));
 for(const field of ['executed','didWork','skipped','noSource','failed'])for(const value of [null,'false',0,{},[]])it(`rejects ${field}=${JSON.stringify(value)}`,()=>{
  const r:any=specimen();r.stage[field]=value;expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_stage_invalid');
 });
 it('requires blob digest to match saved bytes',()=>{const r=specimen();r.receipt[0]!.bytes=Buffer.from('changed!').toString('base64');expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_capture_invalid');});
 it('does not accept stale source bytes as fresh',()=>{const r=specimen();r.current[0]!.sha256='b'.repeat(64);expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_capture_invalid');});
 it('rejects a supplier moved outside the getter but inside the boundary',()=>{const r=specimen();const at=r.events.findIndex(e=>e.event==='boundary:end');r.events.splice(at,0,{event:'supplier:begin',phase:'boundary'},{event:'supplier:end',phase:'boundary'});r.calls++;expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_extra_evaluation');});
});

for(const location of ['getter:begin','boundary:begin','post-action:begin','capture:begin'])it('rejects natural-labelled supplier inside '+location,()=>{
 const r=specimen(),at=r.events.findIndex(e=>e.event===location)+1;
 r.events.splice(at,0,{event:'supplier:begin',phase:'natural'},{event:'supplier:end',phase:'natural'});r.calls++;
 expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_extra_evaluation');
});
for(const phase of ['configuration','natural','action'])it('rejects phase laundering into getter: '+phase,()=>{
 const r=specimen(),begin=r.events.findIndex(e=>e.event==='supplier:begin'),pair=r.events.splice(begin,2);
 pair.forEach(e=>e.phase=phase);r.events.splice(r.events.findIndex(e=>e.event==='getter:begin')+1,0,...pair);
 expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_extra_evaluation');
});

function cachedFault(mode:'boundary'|'no-receipt'){
 const r:any=specimen();r.readFault=mode==='boundary'?'capture':'no-receipt';r.mode=mode;
 if(mode==='no-receipt'){
  r.events=r.events.filter((e:any)=>!['boundary:begin','getter:begin','getter:end','boundary:end','post-action:begin','post-action:end'].includes(e.event));
  r.receipt=[];r.postAction=[];r.current=[];r.getterCalls=0;r.capture={accepted:false,reason:'kgp_capture_content_evidence_unavailable'};
 }
 r.events.splice(r.events.findIndex((e:any)=>e.event==='capture:begin')+1,0,{event:'getter:begin',phase:'capture'},{event:'getter:end',phase:'capture'});r.getterCalls++;
 return r;
}
for(const mode of ['boundary','no-receipt'] as const){
 it('rejects a counted cached read in '+mode,()=>{const r=cachedFault(mode);expect(()=>verifySnapshotContentRun(r,{...approval,readFault:r.readFault})).toThrow('snapshot_content_no_read_violated');});
 it('requires an actual read rather than a fault flag in '+mode,()=>{const r=cachedFault(mode);r.events=r.events.filter((e:any)=>!(e.phase==='capture'&&e.event.startsWith('getter:')));r.getterCalls--;expect(()=>verifySnapshotContentRun(r,{...approval,readFault:r.readFault})).toThrow('snapshot_content_fault_not_reproduced');});
 it('validates fault artifacts before recognizing the no-read violation in '+mode,()=>{const r=cachedFault(mode);r.jarEntries=[];expect(()=>verifySnapshotContentRun(r,{...approval,readFault:r.readFault})).toThrow('snapshot_content_artifact_invalid');});
 it('requires explicit fault approval in '+mode,()=>{expect(()=>verifySnapshotContentRun(cachedFault(mode),approval)).toThrow('snapshot_content_fault_identity_invalid');});
}

function faultCase(){
 const faults=[cachedFault('boundary'),cachedFault('no-receipt')];
 faults.forEach((r,i)=>r.runId='fault-'+i);
 const runs=faults.map((r,i)=>{const n=structuredClone(r);n.events=n.events.filter((e:any)=>!(e.phase==='capture'&&e.event.startsWith('getter:')));n.getterCalls--;n.readFault='none';n.runId='normal-'+i;return n;});
 return {runs,faults,fixtureInputsSha256:approval.fixtureInputsSha256};
}
it('recognizes both actual cached faults only after validating their complete evidence',()=>expect(verifySnapshotContentFaults(faultCase(),approval)).toHaveLength(2));
it('rejects a missing cached-read fault',()=>{const c=faultCase();c.faults.pop();expect(()=>verifySnapshotContentFaults(c,approval)).toThrow('snapshot_content_fault_missing');});
it('rejects reuse of a normal run ID by a fault',()=>{const c=faultCase();c.faults[0]!.runId=c.runs[0]!.runId;expect(()=>verifySnapshotContentFaults(c,approval)).toThrow('snapshot_content_fault_identity_invalid');});
it('rejects fault evidence combined with a different normal run',()=>{const c=faultCase();c.runs[0]!.calls++;expect(()=>verifySnapshotContentFaults(c,approval)).toThrow('snapshot_content_fault_binding_invalid');});
it('rejects a cached getter counter without its events',()=>{const r=cachedFault('boundary');r.events=r.events.filter((e:any)=>!(e.phase==='capture'&&e.event.startsWith('getter:')));expect(()=>verifySnapshotContentRun(r,{...approval,readFault:r.readFault})).toThrow('snapshot_content_getter_counter_invalid');});

for(const where of ['mutation:begin','restore:begin'])for(const phase of ['configuration','natural','action'])it(`rejects ${phase} supplier in ${where}`,()=>{
 const r:any=specimen();r.mode='mutate-same-size';r.current[0].sha256='b'.repeat(64);
 r.mutation={id:r.current[0].id,before:r.receipt[0].sha256,after:r.current[0].sha256,restored:true};r.capture={accepted:false,reason:'kotlin_derived_snapshot_stale'};
 r.events.splice(r.events.findIndex((e:any)=>e.event==='capture:begin'),0,{event:'mutation:begin',phase:'mutation'},{event:'mutation:end',phase:'mutation'});
 r.events.push({event:'restore:begin',phase:'restore'},{event:'restore:end',phase:'restore'});
 expect(()=>verifySnapshotContentRun(r,approval)).not.toThrow();
 const at=r.events.findIndex((e:any)=>e.event===where)+1;r.events.splice(at,0,{event:'supplier:begin',phase},{event:'supplier:end',phase});r.calls++;
 expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_extra_evaluation');
});
for(const phase of ['configuration','action'])it('rejects a phase label inconsistent with the natural interval: '+phase,()=>{
 const r=specimen();r.events.filter(e=>e.event?.startsWith('supplier:')).forEach(e=>e.phase=phase);
 expect(()=>verifySnapshotContentRun(r,approval)).toThrow('snapshot_content_supplier_phase_invalid');
});
