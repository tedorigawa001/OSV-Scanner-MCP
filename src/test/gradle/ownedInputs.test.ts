import {it,expect} from 'vitest';
import {ownedInputModes,ownedInputSourcePaths,ownedInputBoundaryEvents,verifyOwnedInputsCase} from '../fixtures/gradleOwnedInputsProof.mjs';
const hash='a'.repeat(64);
function fixture(){
 const sourcesSha256=Object.fromEntries(ownedInputSourcePaths.map(p=>[p,hash]));
 const fixtureInputsSha256={'build-logic/owned-inputs.gradle':hash,'build-logic/build.gradle.kts':hash,'build-logic/owned/a.txt':hash,'build-logic/owned/b.txt':hash};
 const proof:any={schema:'osv-mcp.owned-input-case-v3',gradleVersion:'8.11.1',consumerDSL:'Kotlin',producerDSL:'Kotlin',sourcesSha256,fixtureInputsSha256,runs:[]};
 for(const observe of [false,true]){
  const cases=ownedInputModes.map(mode=>{
   const events:any[]=['registration:begin:main','registration:end:main','registration:begin:auxiliary','registration:end:auxiliary','seal'].map(event=>({event,phase:'registration'}));
   const add=(event:string,phase='natural')=>events.push({event,phase});
   add('supplier:main');add('start:main');add('ready:main');
   const states=[{id:'main',state:'ready'},{id:'auxiliary',state:mode==='not-evaluated'?'not-evaluated':mode==='evaluating'?'evaluating':mode==='failed'?'failed':'ready'}];
   const reason=mode==='ready'?null:mode==='kgp-unsupported'?'recipe_unsupported':'owned_input_'+(mode==='evaluating'?'evaluation_in_progress':mode==='failed'?'evaluation_failed':'not_evaluated');
   if(['evaluating','failed'].includes(mode)){add('action:begin');add('natural-getter:auxiliary');}
   if(mode!=='not-evaluated'){add('supplier:auxiliary');add('start:auxiliary');if(mode!=='evaluating')add((mode==='failed'?'failed:':'ready:')+'auxiliary');}
   if(!['evaluating','failed'].includes(mode))add('action:begin');
   if(mode!=='evaluating')add('action:end');
   if(observe)add('capture:gate','observer');
   if(observe&&mode==='ready'){add('getter:main','observer');add('getter:auxiliary','observer');}
   if(mode==='evaluating'){add('ready:auxiliary');add('action:end');}
   return {mode,sealed:true,changesDisallowed:true,attachments:2,events,handles:[{id:'main',state:'ready',calls:1},{id:'auxiliary',state:mode==='not-evaluated'?'not-evaluated':mode==='failed'?'failed':'ready',calls:mode==='not-evaluated'?0:1}],getterCalls:observe&&mode==='ready'?2:0,kgpGetterCalls:0,kgpReaderCount:mode==='kgp-unsupported'?4:0,
    readFiles:observe&&mode==='ready'?['main','auxiliary'].flatMap(handle=>['a.txt','b.txt'].map(name=>({handle,name,size:2,sha256:hash}))):[],decision:observe?{accepted:mode==='ready',reason}:null,attempts:observe?[{states,reason}]:[]};
  });
  proof.runs.push({schema:'osv-mcp.owned-input-run-v3',gradleVersion:'8.11.1',preGateRead:false,preGateKgpRead:false,runId:observe?'observer':'control',observe,fixtureInputsSha256,maxWorkers:1,parallel:false,productionAdopted:false,kgpRecipeSupported:false,cases});
 }
 return {proof,approval:{gradleVersion:'8.11.1',consumerDSL:'Kotlin',producerDSL:'Kotlin',sourcesSha256}};
}
it('rejects an unbound or incomplete native observation',()=>expect(()=>verifyOwnedInputsCase({},{})).toThrow('owned_proof_schema_invalid'));
it('accepts complete helper evidence while leaving the full pipeline unsupported',()=>{
 const {proof,approval}=fixture();expect(verifyOwnedInputsCase(proof,approval)).toMatchObject({ownedHelperCandidate:true,fullPipelineCandidate:false,productionAdopted:false});
});
for(const mode of ownedInputModes.slice(1))it(`rejects getter reads on ${mode}`,()=>{
 const {proof,approval}=fixture();proof.runs[1].cases.find((c:any)=>c.mode===mode).getterCalls=1;
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_no_read_violated');
});
it('rejects even one KGP public getter invocation',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[4].kgpGetterCalls=1;
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_kgp_read_violated');
});
it('requires the actual readiness snapshot at the gate',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[2].attempts[0].states[1].state='ready';
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_gate_evidence_missing');
});
it('rejects readiness copied from another handle',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[0].events=proof.runs[1].cases[0].events.filter((e:any)=>e.event!=='ready:auxiliary');
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_readiness_invalid');
});
it('rejects missing observer slots rather than accepting a smaller proof',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases.pop();expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_inventory_incomplete');
});
it('rejects missing nonempty input evidence',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[0].readFiles=[];expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_nonempty_evidence_missing');
});
it('rejects additional supplier evaluations even with a successful decision',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[0].handles[0].calls=2;expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_trace_invalid');
});
it('rejects a producer-applied helper which differs from the captured helper source',()=>{
 const {proof,approval}=fixture();proof.fixtureInputsSha256['build-logic/owned-inputs.gradle']='b'.repeat(64);expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_source_missing');
});
it('rejects old or foreign verifier sources and versions',()=>{
 const {proof,approval}=fixture();expect(()=>verifyOwnedInputsCase(proof,{...approval,gradleVersion:'9.2.1'})).toThrow('owned_proof_identity_mismatch');
});

it('binds observed nonempty file bytes to independently hashed fixture inputs',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[0].readFiles[0].sha256='b'.repeat(64);
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_file_binding_invalid');
});

it('rejects a ready handle read before the gate even when the counter is zero',()=>{
 const {proof,approval}=fixture();const s=proof.runs[1].cases[1];
 s.events.splice(s.events.findIndex((e:any)=>e.event==='capture:gate'),0,{event:'getter:main',phase:'observer'});
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_getter_before_gate');
});
it('rejects missing registration and Action boundaries in both runs',()=>{
 const {proof,approval}=fixture();
 for(const r of proof.runs)for(const s of r.cases)s.events=s.events.filter((e:any)=>!e.event.startsWith('registration:')&&!e.event.startsWith('action:'));
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_event_inventory_invalid');
});

for(const runIndex of [0,1])for(const event of ownedInputBoundaryEvents){
 it(`rejects missing ${event} in run ${runIndex}`,()=>{
  const {proof,approval}=fixture();const s=proof.runs[runIndex].cases[0];s.events=s.events.filter((e:any)=>e.event!==event);
  expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_event_inventory_invalid');
 });
 it(`rejects duplicated ${event} in run ${runIndex}`,()=>{
  const {proof,approval}=fixture();const s=proof.runs[runIndex].cases[0];s.events.push({...s.events.find((e:any)=>e.event===event)});
  expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_event_inventory_invalid');
 });
 it(`rejects a wrong phase for ${event} in run ${runIndex}`,()=>{
  const {proof,approval}=fixture();proof.runs[runIndex].cases[0].events.find((e:any)=>e.event===event).phase='unknown';
  expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_event_inventory_invalid');
 });
}
it('rejects reversed registration boundaries',()=>{
 const {proof,approval}=fixture();const e=proof.runs[1].cases[0].events;[e[0],e[1]]=[e[1],e[0]];
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_event_inventory_invalid');
});
it('requires getter counters to match the actual getter events',()=>{
 const {proof,approval}=fixture();const s=proof.runs[1].cases[0];s.events=s.events.filter((e:any)=>e.event!=='getter:main');
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_getter_inventory_invalid');
});
it('rejects a ready handle read after a rejected gate even when its counter is zero',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[1].events.push({event:'getter:main',phase:'observer'});
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_getter_inventory_invalid');
});
it('rejects the wrong getter phase and duplicate reads',()=>{
 const {proof,approval}=fixture();proof.runs[1].cases[0].events.find((e:any)=>e.event==='getter:main').phase='natural';
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_event_inventory_invalid');
});
it('rejects a claimed fault which did not actually execute a pre-gate read',()=>{
 const {proof,approval}=fixture();proof.preGateRead=true;proof.runs[1].preGateRead=true;
 expect(()=>verifyOwnedInputsCase(proof,{...approval,preGateRead:true})).toThrow('owned_proof_fault_not_reproduced');
});
it('rejects an actual unsupported KGP reader call before the gate',()=>{
 const {proof,approval}=fixture();const s=proof.runs[1].cases.find((c:any)=>c.mode==='kgp-unsupported');
 s.events.splice(s.events.findIndex((e:any)=>e.event==='capture:gate'),0,{event:'kgp-getter:libraries',phase:'observer'});s.kgpGetterCalls=1;
 proof.preGateKgpRead=true;proof.runs[1].preGateKgpRead=true;
 expect(()=>verifyOwnedInputsCase(proof,{...approval,preGateKgpRead:true})).toThrow('owned_proof_getter_before_gate');
});
it('rejects a claimed KGP fault which did not actually call a reader',()=>{
 const {proof,approval}=fixture();proof.preGateKgpRead=true;proof.runs[1].preGateKgpRead=true;
 expect(()=>verifyOwnedInputsCase(proof,{...approval,preGateKgpRead:true})).toThrow('owned_proof_fault_not_reproduced');
});
it('rejects a KGP fault proof checked without the matching approval',()=>{
 const {proof,approval}=fixture();proof.preGateKgpRead=true;proof.runs[1].preGateKgpRead=true;
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_identity_mismatch');
});
it('requires helper-owned collections to disallow changes at seal',()=>{
 const {proof,approval}=fixture();proof.runs[0].cases[0].changesDisallowed=false;
 expect(()=>verifyOwnedInputsCase(proof,approval)).toThrow('owned_proof_inventory_incomplete');
});
