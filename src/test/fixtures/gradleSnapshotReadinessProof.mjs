export const snapshotModes=['control','observe','skipped','unknown-source','freeze-diagnostic'];
export const snapshotSources=['src/test/fixtures/gradle-snapshot-readiness.gradle','src/test/fixtures/gradleSnapshotReadinessProof.mjs','src/test/fixtures/gradleSnapshotReadinessProof.d.mts','src/test/gradle/snapshotReadiness.integration.test.ts'];
const fail=m=>{throw Error(m)};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function verifySnapshotReadinessCase(c,a){
 if(c?.schema!=='osv-mcp.snapshot-readiness-case-v2'||!Array.isArray(c.runs)||c.runs.length!==5)fail('snapshot_readiness_schema_invalid');
 if(c.gradleVersion!==a.gradleVersion||c.dsl!==a.dsl||!eq(c.sourcesSha256,a.sourcesSha256)||!eq(c.approvedApi,a.approvedApi))fail('snapshot_readiness_identity_invalid');
 if(snapshotSources.some(p=>!sha(c.sourcesSha256?.[p]))||c.fixtureInputsSha256?.['build-logic/snapshot-helper.gradle']!==c.sourcesSha256[snapshotSources[0]])fail('snapshot_readiness_source_missing');
 if((c.preflightReadFault??false)!==(a.preflightReadFault??false))fail('snapshot_readiness_identity_invalid');
 const ids=new Set();let preflightReadCount=0;
 for(let i=0;i<5;i++){
  const r=c.runs[i],mode=snapshotModes[i];
  if(r.schema!=='osv-mcp.snapshot-readiness-run-v2'||r.mode!==mode||r.gradleVersion!==c.gradleVersion||!r.runId||ids.has(r.runId)||!eq(r.fixtureInputsSha256,c.fixtureInputsSha256))fail('snapshot_readiness_run_invalid');ids.add(r.runId);
  if(r.preflightReadFault!==(i===1&&(c.preflightReadFault??false)))fail('snapshot_readiness_run_invalid');
  if(r.productionAdopted!==false||!r.profileApproved||r.maxWorkers!==1||r.parallel!==false)fail('snapshot_readiness_scope_invalid');
  for(const role of ['gradle','kgp','implementation'])if(!r.api?.[role]?.artifact||r.api[role].sha256!==a.approvedApi[role]||!sha(r.api[role].sha256))fail('snapshot_readiness_api_mismatch');
  if(!Array.isArray(r.events)||!Array.isArray(r.checks)||!Array.isArray(r.files))fail('snapshot_readiness_inventory_missing');
  const all=name=>r.events.flatMap((e,j)=>e.event===name?[j]:[]);
  const one=name=>{const found=all(name);if(found.length!==1)fail('snapshot_readiness_event_invalid');return found[0]};
  const regBegin=one('registration:begin'),regEnd=one('registration:end'),taskBegin=one('task:begin'),taskEnd=one('task:end');
  if(!(regBegin<regEnd&&regEnd<taskBegin&&taskBegin<taskEnd)||r.events[regBegin].phase!=='configuration'||r.events[regEnd].phase!=='configuration')fail('snapshot_readiness_event_invalid');
  const starts=all('supplier:begin'),ends=all('supplier:end');
  if(starts.length!==ends.length||starts.length!==r.calls)fail('snapshot_readiness_supplier_invalid');
  for(let j=0;j<starts.length;j++){
   const start=starts[j],end=ends[j],phase=r.events[start].phase;
   if(!(regEnd<start&&start<end&&end<taskEnd)||j>0&&start<ends[j-1]||r.events[end].phase!==phase||!['configuration','natural','action'].includes(phase)||phase==='configuration'&&end>=taskBegin||phase!=='configuration'&&start<=taskBegin)fail('snapshot_readiness_supplier_invalid');
  }
  const checkNames=['early','wrong-task','wrong-property','capture','refusal'];
  const allowed=new Set([...checkNames.flatMap(n=>['preflight:begin:'+n,'preflight:end:'+n]),'registration:begin','registration:end','supplier:begin','supplier:end','task:begin','task:end','action:begin','action:end','gate:early','gate:wrong-task','gate:wrong-property','gate:capture','gate:refusal','binding:recheck','getter:begin','getter:end','mutation:begin','mutation:end']);
  if(r.events.some(e=>!allowed.has(e.event)))fail('snapshot_readiness_event_invalid');
  for(const e of r.events){if((e.event.startsWith('getter:')||e.event==='binding:recheck')&&e.phase!=='capture'&&!e.phase.startsWith('preflight:')||e.event.startsWith('mutation:')&&e.phase!=='mutation-diagnostic'||e.event.startsWith('action:')&&e.phase!=='action'||e.event.startsWith('task:')&&e.phase!=='natural')fail('snapshot_readiness_event_invalid');}
  if(r.binding?.publicTaskType!==true||r.binding.propertyType!==true||r.binding.role!=='classpathSnapshotProperties.classpathSnapshot'||r.binding.taskIdentityAfterExecution!==true)fail('snapshot_readiness_binding_invalid');
  const sourceKind=mode==='unknown-source'?'live-tree':'reviewed-default-plus-empty-concrete-sensor';
  if(r.binding.sourceKind!==sourceKind)fail('snapshot_readiness_binding_invalid');
  const expectedCompleted=mode!=='skipped';
  const stageFlags=['observed','executed','didWork','skipped','noSource','failed','completed'];
  if(stageFlags.some(f=>typeof r.stage?.[f]!=='boolean'))fail('snapshot_readiness_stage_flags_invalid');
  const actionComplete=all('action:begin').length===1&&all('action:end').length===1&&taskBegin<all('action:begin')[0]&&all('action:begin')[0]<all('action:end')[0]&&all('action:end')[0]<taskEnd;
  const derivedComplete=r.stage.observed&&r.stage.executed&&r.stage.didWork&&!r.stage.skipped&&!r.stage.noSource&&!r.stage.failed&&actionComplete;
  if(r.stage.completed!==derivedComplete||r.stage.observed!==true||r.stage.completed!==expectedCompleted||r.stage.failed!==false||r.stage.executed!==true||r.stage.didWork!==expectedCompleted||r.stage.skipped!==!expectedCompleted||r.stage.noSource!==false)fail('snapshot_readiness_stage_invalid');
  if(expectedCompleted){if(r.calls<1||!(taskBegin<one('action:begin')&&one('action:begin')<one('action:end')&&one('action:end')<taskEnd))fail('snapshot_readiness_stage_invalid');}
  else if(all('action:begin').length||all('action:end').length)fail('snapshot_readiness_stage_invalid');
  const expectedChecks=mode==='observe'?[['early','task_not_complete'],['wrong-task','task_binding_mismatch'],['wrong-property','property_binding_mismatch'],['capture',null]]:mode==='skipped'?[['refusal','stage_not_executed']]:mode==='unknown-source'?[['refusal','source_kind_unsupported']]:[];
  if(r.checks.length!==expectedChecks.length)fail('snapshot_readiness_inventory_missing');
  const expectedNames=expectedChecks.map(x=>x[0]);
  for(const name of checkNames)if(!expectedNames.includes(name)&&['preflight:begin:','preflight:end:','gate:'].some(prefix=>all(prefix+name).length))fail('snapshot_readiness_event_invalid');
  const getterBegins=all('getter:begin'),getterEnds=all('getter:end');
  if(getterBegins.length!==getterEnds.length||getterBegins.length!==r.getterCalls)fail('snapshot_readiness_getter_counter_invalid');
  const preflightReads=[];let capturePair=null;
  for(let j=0;j<getterBegins.length;j++){
   const begin=getterBegins[j],end=getterEnds[j],phase=r.events[begin].phase;
   if(begin>=end||j>0&&begin<getterEnds[j-1]||r.events[end].phase!==phase)fail('snapshot_readiness_event_invalid');
   if(phase==='capture'){if(capturePair)fail('snapshot_readiness_capture_invalid');capturePair={begin,end};}
   else{
    const name=phase.slice('preflight:'.length);
    if(!phase.startsWith('preflight:')||!expectedNames.includes(name)||!(one('preflight:begin:'+name)<begin&&end<one('gate:'+name)&&one('gate:'+name)<one('preflight:end:'+name)))fail('snapshot_readiness_event_invalid');
    if(r.events.slice(begin,end+1).some(e=>e.event.startsWith('supplier:')))fail('snapshot_readiness_fault_extra_evaluation');
    preflightReads.push({name,begin,end});
   }
  }
  preflightReadCount+=preflightReads.length;
  for(let j=0;j<expectedChecks.length;j++){
   const [name,reason]=expectedChecks[j],check=r.checks[j],gate=one('gate:'+name);
   if(check.naturalCalls!==r.events.slice(0,gate).filter(e=>e.event==='supplier:end').length)fail('snapshot_readiness_witness_invalid');
   if(r.events[gate].phase!=='preflight:'+name&&!(name==='refusal'&&r.events[gate].phase==='preflight:refusal'))fail('snapshot_readiness_event_invalid');
   const open=one('preflight:begin:'+name),close=one('preflight:end:'+name);
   if(!(open<gate&&gate<close)||r.events[open].phase!=='preflight:'+name||r.events[close].phase!=='preflight:'+name)fail('snapshot_readiness_event_invalid');
   const counted=preflightReads.filter(x=>x.name===name).length;
   const facts={profileApproved:true,taskIdentity:name!=='wrong-task',propertyIdentity:name!=='wrong-property',sourceKnown:mode!=='unknown-source',stageObserved:name!=='early',stageComplete:name==='early'?false:expectedCompleted,naturalCalls:check.naturalCalls};
   if(!eq(check.facts,facts))fail('snapshot_readiness_facts_invalid');
   if(check.name!==name||check.reason!==reason||check.accepted!==(reason===null)||check.getterCalls!==counted)fail('snapshot_readiness_gate_invalid');
   const expectedTask=name!=='wrong-task',expectedProperty=name!=='wrong-property';
   if(check.taskIdentity!==expectedTask||check.propertyIdentity!==expectedProperty||check.stageComplete!==(name==='early'?false:expectedCompleted))fail('snapshot_readiness_gate_invalid');
   if(name==='early'?!(one('action:begin')<gate&&gate<one('action:end')):gate<=taskEnd)fail('snapshot_readiness_event_invalid');
  }
  if(mode==='observe'){
   const gate=one('preflight:end:capture'),recheck=one('binding:recheck'),begin=capturePair?.begin,end=capturePair?.end;
   if(!(gate<recheck&&recheck<begin&&begin<end)||r.getterCalls!==1+preflightReads.length||r.metadataReadsAfterGate!==1||r.binding.propertyIdentityAfterGate!==true||!r.files.length||r.files.some(f=>!f.name||!Number.isSafeInteger(f.size)||f.size<0||!sha(f.sha256)))fail('snapshot_readiness_capture_invalid');
   if(r.events.slice(begin,end+1).some(e=>e.event.startsWith('supplier:')))fail('snapshot_readiness_extra_evaluation');
  }else if(r.getterCalls!==preflightReads.length||r.metadataReadsAfterGate!==0||r.files.length||capturePair||all('binding:recheck').length)fail('snapshot_readiness_no_read_violated');
  if(mode==='freeze-diagnostic'){
   if(!(taskEnd<one('mutation:begin')&&one('mutation:begin')<one('mutation:end'))||r.freeze?.attempts!==1||typeof r.freeze.rejected!=='boolean'||r.freeze.rejected&&!r.freeze.errorType)fail('snapshot_readiness_mutation_invalid');
  }else if(r.freeze!==null||all('mutation:begin').length||all('mutation:end').length)fail('snapshot_readiness_mutation_invalid');
  if(!sha(r.archiveSha256)||!Array.isArray(r.jarEntries)||!r.jarEntries.length)fail('snapshot_readiness_artifact_invalid');
 }
 const natural=r=>r.events.filter(e=>!e.phase.startsWith('preflight:')&&e.phase!=='capture'&&e.phase!=='mutation-diagnostic');
 if(!eq(natural(c.runs[0]),natural(c.runs[1])))fail('snapshot_readiness_noninterference_failed');
 for(const i of [1,3,4])if(!eq(c.runs[i].jarEntries,c.runs[0].jarEntries))fail('snapshot_readiness_artifact_invalid');
 if(c.preflightReadFault&&preflightReadCount!==1)fail('snapshot_readiness_fault_not_reproduced');
 if(preflightReadCount)fail('snapshot_readiness_preflight_read');
 return {conditionalRereadWitness:c.runs[4].freeze.rejected,productionAdopted:false,fullPipelineCandidate:false,naturalContentBinding:false,
  note:'Cooperative producer binding and closed source profile; only the snapshot reread is observed.'};
}

export function verifySnapshotReadinessFault(c,a){
 let outcome,reason;try{outcome=verifySnapshotReadinessCase(c,{...a,preflightReadFault:true});}catch(e){reason=e.message;}
 if(outcome!==undefined||reason!=='snapshot_readiness_preflight_read')fail(reason??'snapshot_readiness_fault_not_reproduced');
 const r=c.runs[1],open=r.events.findIndex(e=>e.event==='preflight:begin:wrong-task'),close=r.events.findIndex(e=>e.event==='preflight:end:wrong-task');
 const window=r.events.slice(open+1,close),starts=window.filter(e=>e.event==='getter:begin');
 if(starts.length!==1||starts[0].phase!=='preflight:wrong-task'||window.some(e=>e.event.startsWith('supplier:')))fail('snapshot_readiness_fault_not_reproduced');
 return {actualPreflightReads:1,extraInstrumentedSuppliers:0,gate:'wrong-task'};
}
export const snapshotStateTargets=snapshotModes.flatMap(mode=>['noSource','skipped'].flatMap(field=>['missing','null','string','zero','one','object','array','flip'].map(action=>({mode,field,action,reason:action==='flip'?'snapshot_readiness_stage_invalid':'snapshot_readiness_stage_flags_invalid'}))));
export function mutateSnapshotState(c,target){
 const copy=structuredClone(c),stage=copy.runs.find(r=>r.mode===target.mode).stage;
 if(target.action==='missing')delete stage[target.field];
 else if(target.action==='flip')stage[target.field]=!stage[target.field];
 else stage[target.field]=({null:null,string:'false',zero:0,one:1,object:{},array:[]})[target.action];
 return copy;
}
export function snapshotStateRegressions(c,a){
 return snapshotStateTargets.map(target=>{
  let reason,outcome;try{outcome=verifySnapshotReadinessCase(mutateSnapshotState(c,target),a);}catch(e){reason=e.message;}
  if(outcome!==undefined||reason!==target.reason)fail('snapshot_state_regression_failed:'+JSON.stringify(target)+':'+reason);
  return {...target,accepted:outcome!==undefined};
 });
}
