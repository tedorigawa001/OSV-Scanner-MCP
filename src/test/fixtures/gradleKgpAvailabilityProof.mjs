import {readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const kgpSlots=['libraries','snapshots','compilerClasspath','taskInputs'];
export const kgpAvailabilitySources=['src/test/fixtures/gradle-kgp-availability.init.gradle','src/test/fixtures/gradleKgpAvailabilityProof.mjs','src/test/fixtures/gradleKgpAvailabilityProof.d.mts','src/test/gradle/kgpAvailability.integration.test.ts'];
const fail=m=>{throw Error(m)};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export function verifyApiArtifact(expected,actual){
 if(!expected?.artifact||!sha(expected.sha256)||actual?.artifact!==expected.artifact||actual.sha256!==expected.sha256)fail('kgp_availability_api_artifact_mismatch');
 return actual;
}
export async function resolveGradleApiArtifact(lib,expected){
 const candidates=(await readdir(lib)).filter(n=>n.startsWith('gradle-core-api-')&&n.endsWith('.jar'));
 if(candidates.length!==1)fail('kgp_availability_api_artifact_mismatch');
 const artifact=await realpath(path.join(lib,candidates[0]));
 const actual={artifact,sha256:createHash('sha256').update(await readFile(artifact)).digest('hex')};
 return verifyApiArtifact(expected,actual);
}
const getterStarts=r=>r.events.filter(e=>kgpSlots.some(s=>e.event==='getter:'+s));
function verifyTrace(r){
 const events=r.events,mode=r.mode;
 if(events.some(e=>typeof e.event!=='string'||typeof e.phase!=='string'))fail('kgp_availability_event_invalid');
 const indices=name=>events.flatMap((e,i)=>e.event===name?[i]:[]);
 const exact=name=>{const found=indices(name);if(found.length!==1)fail('kgp_availability_event_invalid');return found[0]};
 const regStart=exact('registration:begin'),regEnd=exact('registration:end'),actionStart=exact('action:begin'),actionEnd=exact('action:end'),compileStart=exact('task:begin:compileKotlin'),compileEnd=exact('task:end:compileKotlin');
 if(!(regStart<regEnd&&regEnd<compileStart&&compileStart<actionStart&&actionStart<actionEnd&&actionEnd<compileEnd))fail('kgp_availability_event_invalid');
 const tasks=new Map();
 for(const e of events)if(e.event.startsWith('task:begin:')){
  const task=e.event.slice(11);const begin=exact('task:begin:'+task),end=exact('task:end:'+task);
  if(begin>=end)fail('kgp_availability_event_invalid');tasks.set(task,{begin,end});
 }
 const allowed=new Set(['registration:begin','registration:end','action:begin','action:end','resolution:before','resolution:after',...kgpSlots.flatMap(s=>['slot:begin:','slot:end:','getter:','getter:end:','gate:','supplier:'].map(p=>p+s)),...[...tasks.keys()].flatMap(t=>['task:begin:'+t,'task:end:'+t])]);
 const windows={};let last=compileEnd;
 for(const slot of kgpSlots){
  const begin=exact('slot:begin:'+slot),end=exact('slot:end:'+slot);
  const phase=(mode==='diagnostic'?'diagnostic:':mode==='control'?'control:':'gate:')+slot;
  if(!(last<begin&&begin<end)||events[begin].phase!==phase||events[end].phase!==phase)fail('kgp_availability_event_invalid');last=end;
  const starts=indices('getter:'+slot),ends=indices('getter:end:'+slot);
  if(starts.length>1||starts.length!==ends.length||r.getterCalls?.[slot]!==starts.length)fail('kgp_availability_getter_counter_invalid');
  if(starts.length&&!(begin<starts[0]&&starts[0]<ends[0]&&ends[0]<end))fail('kgp_availability_event_invalid');
  const gates=indices('gate:'+slot);
  if(gates.length!==(mode==='unsupported'?1:0)||gates.some(i=>i<=begin||i>=end||starts.length&&i<=ends[0]))fail('kgp_availability_event_invalid');
  windows[slot]={begin,end,start:starts[0],finish:ends[0],phase};
 }
 for(let i=0;i<events.length;i++){
  const e=events[i];if(!allowed.has(e.event))fail('kgp_availability_event_invalid');
  if(e.event.startsWith('registration:')){if(e.phase!=='configuration')fail('kgp_availability_trace_phase_invalid');continue;}
  if(e.phase==='configuration'){
   const firstTask=Math.min(...[...tasks.values()].map(t=>t.begin));
   if(!e.event.startsWith('supplier:')||i<=regEnd||i>=firstTask)fail('kgp_availability_trace_phase_invalid');
  }else if(e.phase.startsWith('natural:')){
   const t=tasks.get(e.phase.slice(8));
   if(!t||i<t.begin||i>t.end||!(e.event.startsWith('task:')||e.event.startsWith('supplier:')||e.event.startsWith('action:')||e.event.startsWith('resolution:')))fail('kgp_availability_trace_phase_invalid');
   if(e.event.startsWith('task:')&&!['task:begin:'+e.phase.slice(8),'task:end:'+e.phase.slice(8)].includes(e.event))fail('kgp_availability_trace_phase_invalid');
   if(e.event.startsWith('action:')&&e.phase!=='natural:compileKotlin')fail('kgp_availability_trace_phase_invalid');
  }else{
   const w=Object.values(windows).find(w=>w.phase===e.phase);
   if(!w)fail('kgp_availability_trace_phase_invalid');
   if(e.event.startsWith('supplier:')&&!(w.start<i&&i<w.finish))fail('kgp_availability_supplier_outside_getter');
   if(i<w.begin||i>w.end)fail('kgp_availability_trace_phase_invalid');
   const slot=kgpSlots.find(s=>windows[s]===w);
   if(e.event.startsWith('getter:')&&!['getter:'+slot,'getter:end:'+slot].includes(e.event))fail('kgp_availability_trace_phase_invalid');
   if(e.event.startsWith('gate:')&&e.event!=='gate:'+slot)fail('kgp_availability_trace_phase_invalid');
   if(e.event.startsWith('action:')||e.event.startsWith('task:'))fail('kgp_availability_trace_phase_invalid');
  }
 }
 // A supplier cannot be hidden in a different phase inside an actual getter.
 for(const w of Object.values(windows))if(w.start!==undefined)for(let i=w.start;i<=w.finish;i++)if(events[i].phase!==w.phase)fail('kgp_availability_trace_phase_invalid');
 if(events.slice(regStart,regEnd+1).some(e=>e.event.startsWith('supplier:')))fail('kgp_availability_early_evaluation');
 return windows;
}
export function verifyKgpAvailabilityCase(c,a){
 if(c?.schema!=='osv-mcp.kgp-availability-case-v2'||!Array.isArray(c.runs)||c.runs.length!==3)fail('kgp_availability_schema_invalid');
 if((c.faultSnapshotRead??false)!==(a.faultSnapshotRead??false)||c.gradleVersion!==a.gradleVersion||c.dsl!==a.dsl||!equal(c.sourcesSha256,a.sourcesSha256))fail('kgp_availability_identity_invalid');
 if(kgpAvailabilitySources.some(p=>!sha(c.sourcesSha256?.[p]))||Object.keys(c.fixtureInputsSha256??{}).length!==7)fail('kgp_availability_source_missing');
 const ids=new Set(),allWindows=[];let unexpectedRead=false;
 for(let i=0;i<3;i++){
  const r=c.runs[i],mode=['control','diagnostic','unsupported'][i];
  if(r.schema!=='osv-mcp.kgp-availability-run-v2'||r.mode!==mode||r.gradleVersion!==c.gradleVersion||!r.runId||ids.has(r.runId)||!equal(r.fixtureInputsSha256,c.fixtureInputsSha256))fail('kgp_availability_run_invalid');ids.add(r.runId);
  if(r.faultSnapshotRead!==(i===2&&(c.faultSnapshotRead??false)))fail('kgp_availability_run_invalid');
  if(r.adopted!==false||!equal(r.approvedRecipes,[])||r.maxWorkers!==1||r.parallel!==false)fail('kgp_availability_scope_invalid');
  if(!r.implementation?.artifact||!sha(r.implementation.sha256))fail('kgp_availability_implementation_missing');
  if(!equal(r.implementation,c.runs[0].implementation))fail('kgp_availability_implementation_changed');
  for(const [role,type]of [['gradle','org.gradle.api.tasks.TaskInputs'],['kgp','org.jetbrains.kotlin.gradle.tasks.KotlinCompileTool']]){
   const binding=r.apiArtifacts?.[role];if(binding?.type!==type||!binding.artifact||!sha(binding.sha256))fail('kgp_availability_api_binding_missing');
   if(!equal(binding,c.runs[0].apiArtifacts?.[role]))fail('kgp_availability_api_artifact_mismatch');
  }
  if(!equal(r.compileState,{executed:true,didWork:true,noSource:false,failed:false}))fail('kgp_availability_compile_invalid');
  if(!Array.isArray(r.events)||!Array.isArray(r.reads)||!Array.isArray(r.decisions))fail('kgp_availability_inventory_missing');
  const windows=verifyTrace(r);allWindows.push(windows);
  const getters=getterStarts(r);
  if(mode==='diagnostic'){
   if(r.reads.length!==4||r.decisions.length||!equal(getters.map(e=>e.event),kgpSlots.map(s=>'getter:'+s)))fail('kgp_availability_inventory_missing');
   for(let j=0;j<4;j++){
    const slot=kgpSlots[j],read=r.reads[j],w=windows[slot];
    if(read.slot!==slot||!read.files?.length||read.files.some(f=>!f.name||f.size!==null&&(!Number.isSafeInteger(f.size)||f.size<0||!sha(f.sha256))))fail('kgp_availability_read_invalid');
    for(const sensor of kgpSlots){
     const before=r.events.slice(0,w.start).filter(e=>e.event==='supplier:'+sensor).length;
     const after=before+r.events.slice(w.start+1,w.finish).filter(e=>e.event==='supplier:'+sensor).length;
     if(read.before?.[sensor]!==before||read.after?.[sensor]!==after)fail('kgp_availability_counter_invalid');
    }
   }
  }else{
   if(r.reads.length)fail('kgp_availability_inventory_missing');
   if(getters.length)unexpectedRead=true;
   if(mode==='unsupported'){
    if(!equal(r.decisions,kgpSlots.map(slot=>({slot,status:'unsupported',reason:'kgp_capture_recipe_unsupported',getterCalls:0}))))fail('kgp_availability_inventory_missing');
   }else if(r.decisions.length)fail('kgp_availability_inventory_missing');
  }
  for(const slot of kgpSlots)if(!r.events.some(e=>e.event==='supplier:'+slot&&e.phase.startsWith('natural:')))fail('kgp_availability_natural_evidence_missing');
  if(!Array.isArray(r.jarEntries)||!r.jarEntries.length||!sha(r.archiveSha256))fail('kgp_availability_artifact_missing');
 }
 const natural=r=>r.events.filter(e=>!['diagnostic:','gate:','control:'].some(p=>e.phase.startsWith(p)));
 if(!equal(natural(c.runs[0]),natural(c.runs[2])))fail('kgp_availability_noninterference_failed');
 if(c.runs.some(r=>!equal(r.jarEntries,c.runs[0].jarEntries)))fail('kgp_availability_artifact_changed');
 if(c.faultSnapshotRead){
  const r=c.runs[2],w=allWindows[2].snapshots;
  if(!equal(getterStarts(r).map(e=>e.event),['getter:snapshots']))fail('kgp_availability_fault_not_reproduced');
  if(r.events.slice(w.start+1,w.finish).some(e=>e.event.startsWith('supplier:')))fail('kgp_availability_fault_extra_evaluation');
 }
 if(unexpectedRead)fail('kgp_availability_no_read_violated');
 if(c.faultSnapshotRead)fail('kgp_availability_fault_not_reproduced');
 return {adopted:false,ownerReceiptSupported:false,stableRereadSupported:false,slots:c.runs[1].reads.map(r=>({slot:r.slot,extraEvaluations:Object.fromEntries(kgpSlots.map(s=>[s,r.after[s]-r.before[s]])),status:'unsupported'}))};
}
export function verifyKgpSnapshotFault(c,a){
 let reason,outcome;try{outcome=verifyKgpAvailabilityCase(c,{...a,faultSnapshotRead:true});}catch(e){reason=e.message;}
 if(outcome!==undefined||reason!=='kgp_availability_no_read_violated')fail(reason??'kgp_availability_fault_not_reproduced');
 const r=c.runs[2],start=r.events.findIndex(e=>e.event==='getter:snapshots'),end=r.events.findIndex(e=>e.event==='getter:end:snapshots');
 return {actualGetterCalls:r.getterCalls.snapshots,extraInstrumentedSuppliers:r.events.slice(start+1,end).filter(e=>e.event.startsWith('supplier:')).length,source:'validated getter interval'};
}

export const kgpAvailabilityRegressionTargets=[
 ['getter-phase','kgp_availability_trace_phase_invalid'],['getter-end-phase','kgp_availability_trace_phase_invalid'],
 ['supplier-unbound','kgp_availability_trace_phase_invalid'],['supplier-before-getter','kgp_availability_supplier_outside_getter'],
 ['supplier-after-getter','kgp_availability_supplier_outside_getter'],['supplier-before-slot','kgp_availability_supplier_outside_getter'],
 ['supplier-after-slot','kgp_availability_supplier_outside_getter'],['supplier-configuration-after-task','kgp_availability_trace_phase_invalid'],['supplier-natural','kgp_availability_noninterference_failed'],
 ['getter-end-missing','kgp_availability_getter_counter_invalid'],['slot-begin-missing','kgp_availability_event_invalid'],
 ['fault-artifact-missing','kgp_availability_artifact_missing'],['api-binding-mismatch','kgp_availability_api_artifact_mismatch'],
 ['supplier-inside-getter','kgp_availability_fault_extra_evaluation']
].map(([name,reason])=>({name,reason}));
export function mutateKgpAvailabilityFault(proof,name){
 const changed=structuredClone(proof),r=changed.runs[2],events=r.events;
 const index=n=>events.findIndex(e=>e.event===n);
 const supplier=phase=>({event:'supplier:snapshots',phase});
 if(name==='getter-phase')events[index('getter:snapshots')].phase='unbound-fault';
 else if(name==='getter-end-phase')events[index('getter:end:snapshots')].phase='unbound-fault';
 else if(name==='supplier-unbound')events.splice(index('getter:end:snapshots'),0,supplier('unbound-fault'));
 else if(name==='supplier-before-getter')events.splice(index('getter:snapshots'),0,supplier('gate:snapshots'));
 else if(name==='supplier-after-getter')events.splice(index('getter:end:snapshots')+1,0,supplier('gate:snapshots'));
 else if(name==='supplier-before-slot')events.splice(index('slot:begin:snapshots'),0,supplier('gate:snapshots'));
 else if(name==='supplier-after-slot')events.splice(index('slot:end:snapshots')+1,0,supplier('gate:snapshots'));
 else if(name==='supplier-configuration-after-task')events.splice(index('gate:snapshots'),0,supplier('configuration'));
 else if(name==='supplier-natural')events.splice(index('task:end:compileKotlin'),0,supplier('natural:compileKotlin'));
 else if(name==='getter-end-missing')events.splice(index('getter:end:snapshots'),1);
 else if(name==='slot-begin-missing')events.splice(index('slot:begin:snapshots'),1);
 else if(name==='fault-artifact-missing')r.jarEntries=[];
 else if(name==='api-binding-mismatch')r.apiArtifacts.gradle.sha256='b'.repeat(64);
 else if(name==='supplier-inside-getter')events.splice(index('getter:end:snapshots'),0,supplier('gate:snapshots'));
 else fail('unknown-regression-target');
 return changed;
}
export function kgpAvailabilityRegressions(proof,approval){
 return kgpAvailabilityRegressionTargets.map(target=>{
  let reason,outcome;
  try{outcome=verifyKgpAvailabilityCase(mutateKgpAvailabilityFault(proof,target.name),{...approval,faultSnapshotRead:true});}catch(e){reason=e.message;}
  if(outcome!==undefined||reason!==target.reason)fail('kgp_availability_regression_failed:'+target.name+':'+reason);
  return {name:target.name,accepted:outcome!==undefined,reason};
 });
}
