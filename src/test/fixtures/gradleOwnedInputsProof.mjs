export const ownedInputModes=['ready','not-evaluated','evaluating','failed','kgp-unsupported'];
export const ownedInputSourcePaths=['src/test/fixtures/gradle-owned-inputs-helper.gradle','src/test/fixtures/gradleOwnedInputsProof.mjs','src/test/fixtures/gradleOwnedInputsProof.d.mts','src/test/gradle/ownedInputs.integration.test.ts'];
const fail=m=>{throw new Error(m)};
export const ownedInputBoundaryEvents=['registration:begin:main','registration:end:main','registration:begin:auxiliary','registration:end:auxiliary','seal','action:begin','action:end'];
export const ownedInputFaults=[{kind:'owned-pre-gate',flag:'preGateRead'},{kind:'kgp-pre-gate',flag:'preGateKgpRead'}];
export const ownedInputEvidenceTargets=[0,1].flatMap(runIndex=>ownedInputModes.flatMap(mode=>ownedInputBoundaryEvents.map(event=>({runIndex,mode,event}))));
function verifyEvents(s,observe){
 const events=s.events;
 const indices=name=>events.flatMap((e,i)=>e.event===name?[i]:[]);
 const gate=indices('capture:gate');
 const getters=events.flatMap((e,i)=>e.event.startsWith('getter:')||e.event.startsWith('kgp-getter:')?[i]:[]);
 if(getters.some(i=>gate.length!==1||i<gate[0]))fail('owned_proof_getter_before_gate');
 const exactly=(name,phase)=>{
  const found=indices(name);
  if(found.length!==1||events[found[0]].phase!==phase)fail('owned_proof_event_inventory_invalid');
  return found[0];
 };
 const bounds=ownedInputBoundaryEvents.map(name=>exactly(name,name.startsWith('action:')?'natural':'registration'));
 if(bounds.some((value,i)=>i>0&&value<=bounds[i-1]))fail('owned_proof_event_inventory_invalid');
 if(gate.length!==(observe?1:0)||gate.some(i=>events[i].phase!=='observer'))fail('owned_proof_event_inventory_invalid');
 if(observe&&(s.mode==='evaluating'?!(bounds[5]<gate[0]&&gate[0]<bounds[6]):gate[0]<=bounds[6]))fail('owned_proof_event_inventory_invalid');
 const allowed=new Set([...ownedInputBoundaryEvents,'capture:gate',...['main','auxiliary'].flatMap(h=>['supplier:','start:','ready:','failed:','getter:','natural-getter:'].map(p=>p+h)),...['libraries','snapshots','compilerClasspath','taskInputs'].map(h=>'kgp-getter:'+h)]);
 for(const e of events){
  if(!allowed.has(e.event)||e.event.startsWith('getter:')&&e.phase!=='observer'||e.event.startsWith('kgp-getter:')&&e.phase!=='observer'||/^(supplier|start|ready|failed|natural-getter):/.test(e.event)&&e.phase!=='natural')fail('owned_proof_event_inventory_invalid');
 }
 const natural=indices('natural-getter:auxiliary');
 if(natural.length!==(['evaluating','failed'].includes(s.mode)?1:0)||natural.some(i=>i<=bounds[5]||i>=bounds[6])||indices('natural-getter:main').length)fail('owned_proof_event_inventory_invalid');
}
export function verifyOwnedInputsCase(c,a){
 if(c?.schema!=='osv-mcp.owned-input-case-v3'||!Array.isArray(c.runs)||c.runs.length!==2)fail('owned_proof_schema_invalid');
 if(c.gradleVersion!==a.gradleVersion||c.consumerDSL!==a.consumerDSL||c.producerDSL!==a.producerDSL||JSON.stringify(c.sourcesSha256)!==JSON.stringify(a.sourcesSha256))fail('owned_proof_identity_mismatch');
 if(!Object.keys(c.fixtureInputsSha256??{}).some(p=>p.endsWith('owned-inputs.gradle'))||!Object.keys(c.fixtureInputsSha256??{}).some(p=>p.startsWith('build-logic/build.gradle')))fail('owned_proof_source_missing');
 if(Object.keys(c.sourcesSha256??{}).length!==ownedInputSourcePaths.length||ownedInputSourcePaths.some(p=>!(/^[a-f0-9]{64}$/.test(c.sourcesSha256[p]??'')))||c.fixtureInputsSha256['build-logic/owned-inputs.gradle']!==c.sourcesSha256[ownedInputSourcePaths[0]])fail('owned_proof_source_missing');
 if((c.preGateRead??false)!==(a.preGateRead??false)||(c.preGateKgpRead??false)!==(a.preGateKgpRead??false))fail('owned_proof_identity_mismatch');
 const ids=new Set();
 for(let i=0;i<2;i++){
  const r=c.runs[i];
  if(r.schema!=='osv-mcp.owned-input-run-v3'||r.gradleVersion!==c.gradleVersion||r.observe!==(i===1)||!r.runId||ids.has(r.runId)||JSON.stringify(r.fixtureInputsSha256)!==JSON.stringify(c.fixtureInputsSha256))fail('owned_proof_run_invalid');
  ids.add(r.runId);
  if(r.preGateRead!==(i===1&&(c.preGateRead??false))||r.preGateKgpRead!==(i===1&&(c.preGateKgpRead??false)))fail('owned_proof_run_invalid');
  if(r.maxWorkers!==1||r.parallel!==false||r.productionAdopted!==false||r.kgpRecipeSupported!==false)fail('owned_proof_scope_invalid');
  if(!Array.isArray(r.cases)||r.cases.length!==ownedInputModes.length||new Set(r.cases.map(x=>x.mode)).size!==ownedInputModes.length)fail('owned_proof_inventory_incomplete');
  for(const mode of ownedInputModes){
   const s=r.cases.find(x=>x.mode===mode);
   if(!s||s.sealed!==true||s.changesDisallowed!==true||s.attachments!==2||!Array.isArray(s.events)||!Array.isArray(s.handles)||s.handles.length!==2)fail('owned_proof_inventory_incomplete');
   verifyEvents(s,i===1);
   if(s.events.some(e=>e.phase==='registration'&&e.event.startsWith('supplier:')))fail('owned_proof_early_evaluation');
   if(!s.events.some(e=>e.event==='seal'))fail('owned_proof_registration_invalid');
   for(const h of s.handles){
    const start=s.events.findIndex(e=>e.event==='start:'+h.id),end=s.events.findIndex(e=>e.event==='ready:'+h.id),failure=s.events.findIndex(e=>e.event==='failed:'+h.id),seal=s.events.findIndex(e=>e.event==='seal');
    if(h.state==='ready'&&(start<=seal||end<=start||failure>=0||s.events[start].phase!=='natural'||s.events[end].phase!=='natural'))fail('owned_proof_readiness_invalid');
    if(h.state==='failed'&&(start<=seal||failure<=start||end>=0))fail('owned_proof_readiness_invalid');
    if(h.calls!==s.events.filter(e=>e.event==='supplier:'+h.id).length||h.calls>1)fail('owned_proof_trace_invalid');
   }
   const expected=mode==='ready'?null:mode==='kgp-unsupported'?'recipe_unsupported':'owned_input_'+(mode==='evaluating'?'evaluation_in_progress':mode==='failed'?'evaluation_failed':'not_evaluated');
   if(i===1){
    if(s.decision?.reason!==expected||s.decision?.accepted!==(mode==='ready'))fail('owned_proof_decision_invalid');
    if(mode==='ready'){
     if(s.getterCalls!==2||s.readFiles?.length!==4||s.readFiles.some(f=>!f.name||!f.size||!/^[a-f0-9]{64}$/.test(f.sha256)))fail('owned_proof_nonempty_evidence_missing');
     const expectedFiles=['main','auxiliary'].flatMap(handle=>['a.txt','b.txt'].map(name=>({handle,name,sha256:c.fixtureInputsSha256['build-logic/owned/'+name]})));
     const actualFiles=s.readFiles.map(({handle,name,sha256})=>({handle,name,sha256}));
     if(JSON.stringify(actualFiles)!==JSON.stringify(expectedFiles)||expectedFiles.some(f=>!f.sha256))fail('owned_proof_file_binding_invalid');
    }else if(s.getterCalls!==0||s.readFiles?.length!==0)fail('owned_proof_no_read_violated');
   }else if(s.getterCalls!==0||s.decision!==null)fail('owned_proof_control_invalid');
   const aux=s.handles.find(h=>h.id==='auxiliary'),main=s.handles.find(h=>h.id==='main');
   if(!aux||!main||main.state!=='ready'||main.calls!==1||aux.state!==(mode==='not-evaluated'?'not-evaluated':mode==='failed'?'failed':'ready')||aux.calls!==(mode==='not-evaluated'?0:1))fail('owned_proof_readiness_invalid');
   if(!Array.isArray(s.attempts)||s.attempts.length!==(i===1?1:0))fail('owned_proof_gate_evidence_missing');
   if(i===1){
    const attempt=s.attempts[0],gate=s.events.findIndex(e=>e.event==='capture:gate');
    const states=[{id:'main',state:'ready'},{id:'auxiliary',state:mode==='evaluating'?'evaluating':aux.state}];
    if(gate<0||attempt.reason!==expected||JSON.stringify(attempt.states)!==JSON.stringify(states))fail('owned_proof_gate_evidence_missing');
    for(const state of states){
     const start=s.events.findIndex(e=>e.event==='start:'+state.id),end=s.events.findIndex(e=>e.event==='ready:'+state.id),failure=s.events.findIndex(e=>e.event==='failed:'+state.id);
     if(state.state==='ready'&&!(end>=0&&end<gate)||state.state==='evaluating'&&!(start<gate&&end>gate)||state.state==='failed'&&!(failure>=0&&failure<gate)||state.state==='not-evaluated'&&start!==-1)fail('owned_proof_gate_evidence_missing');
    }
   }
   if(s.kgpReaderCount!==(mode==='kgp-unsupported'?4:0))fail('owned_proof_inventory_incomplete');
   if(s.kgpGetterCalls!==0)fail('owned_proof_kgp_read_violated');
   const getterEvents=s.events.filter(e=>e.event.startsWith('getter:'));
   const expectedGetters=i===1&&mode==='ready'?['getter:main','getter:auxiliary']:[];
   if(JSON.stringify(getterEvents.map(e=>e.event))!==JSON.stringify(expectedGetters)||getterEvents.length!==s.getterCalls||s.events.filter(e=>e.event.startsWith('kgp-getter:')).length!==s.kgpGetterCalls)fail('owned_proof_getter_inventory_invalid');
  }
 }
 for(const mode of ownedInputModes){
  const x=c.runs[0].cases.find(s=>s.mode===mode),y=c.runs[1].cases.find(s=>s.mode===mode);
  const natural=s=>s.events.filter(e=>['registration','natural'].includes(e.phase));
  if(JSON.stringify(natural(x))!==JSON.stringify(natural(y))||JSON.stringify(x.handles)!==JSON.stringify(y.handles))fail('owned_proof_noninterference_failed');
 }
 if(c.preGateRead||c.preGateKgpRead)fail('owned_proof_fault_not_reproduced');
 return {ownedHelperCandidate:true,productionAdopted:false,fullPipelineCandidate:false,rejectedModes:ownedInputModes.slice(1)};
}
