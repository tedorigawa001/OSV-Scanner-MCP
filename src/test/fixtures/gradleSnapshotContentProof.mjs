import {createHash} from 'node:crypto';
export const contentModes=['control','boundary','mutate-same-size','mutate-size','delete','blob-corrupt','no-receipt'];
export const contentSources=['src/test/fixtures/gradle-snapshot-content.gradle','src/test/fixtures/gradleSnapshotContentProof.mjs','src/test/fixtures/gradleSnapshotContentProof.d.mts','src/test/gradle/snapshotContent.integration.test.ts'];
const fail=m=>{throw Error(m)};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=b=>createHash('sha256').update(b).digest('hex');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const strip=items=>items.map(({bytes,...item})=>item);
export function verifySnapshotContentRun(r,a){
 if(r?.schema!=='osv-mcp.snapshot-content-run-v2'||!contentModes.includes(r.mode))fail('snapshot_content_schema_invalid');
 if(r.readFault!==(a.readFault??'none')||!['none','capture','no-receipt'].includes(r.readFault)||r.readFault==='capture'&&r.mode!=='boundary'||r.readFault==='no-receipt'&&r.mode!=='no-receipt')fail('snapshot_content_fault_identity_invalid');
 if(r.gradleVersion!==a.gradleVersion||!r.runId||!eq(r.fixtureInputsSha256,a.fixtureInputsSha256))fail('snapshot_content_identity_invalid');
 if(r.isolatedCache!==true||r.profileApproved!==true||r.maxWorkers!==1||r.parallel!==false||r.productionAdopted!==false||r.naturalContentBinding!==false||r.observationBoundary!=='Task.doFirst-before-KGP-action')fail('snapshot_content_scope_invalid');
 for(const role of ['gradle','kgp','implementation'])if(!r.api?.[role]?.artifact||r.api[role].sha256!==a.approvedApi[role]||!sha(r.api[role].sha256))fail('snapshot_content_api_invalid');
 if(!r.binding||['publicTaskType','propertyType','taskIdentity','propertyIdentity'].some(k=>r.binding[k]!==true)||r.binding.role!=='classpathSnapshotProperties.classpathSnapshot')fail('snapshot_content_binding_invalid');
 if(!r.stage||['executed','didWork','skipped','noSource','failed'].some(k=>typeof r.stage[k]!=='boolean')||!r.stage.executed||!r.stage.didWork||r.stage.skipped||r.stage.noSource||r.stage.failed)fail('snapshot_content_stage_invalid');
 if(!Array.isArray(r.events))fail('snapshot_content_events_invalid');
 const expected=[['registration:begin','configuration'],['registration:end','configuration']];
 // Natural suppliers can occur after registration or inside the task interval, never an observer window.
 const natural=r.events.filter(e=>e.event.startsWith('supplier:'));
 if(natural.length!==r.calls*2||!Number.isSafeInteger(r.calls)||r.calls<1)fail('snapshot_content_supplier_invalid');
 let open=false;
 for(const e of natural){if(!['configuration','natural','action'].includes(e.phase)||e.event!==(open?'supplier:end':'supplier:begin'))fail('snapshot_content_extra_evaluation');open=!open;}
 expected.push(['task:begin','natural'],['action:begin','action']);
 const observed=!['control','no-receipt'].includes(r.mode);
 if(observed)expected.push(['boundary:begin','boundary'],['getter:begin','boundary'],['getter:end','boundary'],['boundary:end','boundary']);
 expected.push(['action:end','action'],['task:end','natural']);
 if(observed)expected.push(['post-action:begin','post-action'],['post-action:end','post-action']);
 const mutation=!['control','boundary','no-receipt'].includes(r.mode),fileMutation=mutation&&r.mode!=='blob-corrupt';
 if(mutation)expected.push(['mutation:begin','mutation'],['mutation:end','mutation']);
 if(r.mode!=='control')expected.push(['capture:begin','capture'],['capture:end','capture']);
 if(fileMutation)expected.push(['restore:begin','restore'],['restore:end','restore']);
 const begins=r.events.flatMap((e,i)=>e.event==='getter:begin'?[i]:[]),ends=r.events.flatMap((e,i)=>e.event==='getter:end'?[i]:[]);
 if(begins.length!==ends.length||begins.length!==r.getterCalls)fail('snapshot_content_getter_counter_invalid');
 let illegalReads=0;
 for(let j=0;j<begins.length;j++){
  const begin=begins[j],end=ends[j],phase=r.events[begin].phase;
  if(begin>=end||j>0&&begin<ends[j-1]||r.events[end].phase!==phase)fail('snapshot_content_events_invalid');
  if(phase==='capture'){
   const start=r.events.findIndex(e=>e.event==='capture:begin'),stop=r.events.findIndex(e=>e.event==='capture:end');
   if(!(start<begin&&end<stop))fail('snapshot_content_events_invalid');illegalReads++;
  }else if(phase!=='boundary')fail('snapshot_content_events_invalid');
 }
 const core=r.events.filter(e=>!e.event.startsWith('supplier:')&&!(e.event.startsWith('getter:')&&e.phase==='capture')).map(e=>[e.event,e.phase]);
 if(!eq(core,expected)||r.getterCalls!==(observed?1:0)+illegalReads)fail('snapshot_content_events_invalid');
 // Classify supplier placement from event positions, independently of its declared phase.
 const index=name=>r.events.findIndex(e=>e.event===name);
 const reg=index('registration:end'),taskBegin=index('task:begin'),taskEnd=index('task:end'),actionBegin=index('action:begin'),actionEnd=index('action:end');
 const windows=['boundary','post-action','capture','mutation','restore'].map(name=>[index(name+':begin'),index(name+':end')]).filter(([b,e])=>b>=0&&e>b);
 for(let i=0;i<r.events.length;i++)if(r.events[i].event==='supplier:begin'){
  const e=r.events[i],finish=i+1;
  if(r.events[finish]?.event!=='supplier:end'||r.events[finish]?.phase!==e.phase)fail('snapshot_content_supplier_invalid');
  if(windows.some(([begin,end])=>i<end&&finish>begin))fail('snapshot_content_extra_evaluation');
  const correct=e.phase==='configuration'?reg<i&&finish<taskBegin:e.phase==='action'?actionBegin<i&&finish<actionEnd:e.phase==='natural'&&(taskBegin<i&&finish<actionBegin||actionEnd<i&&finish<taskEnd);
  if(!correct)fail('snapshot_content_supplier_phase_invalid');
 }
 for(const items of [r.receipt,r.postAction,r.current]){
  if(!Array.isArray(items)||new Set(items.map(f=>f.id)).size!==items.length)fail('snapshot_content_inventory_invalid');
  for(const f of items){if(typeof f.id!=='string'||!f.id||f.id.startsWith('/')||f.id.split('/').some(p=>!p||p==='.'||p==='..'))fail('snapshot_content_inventory_invalid');if(f.missing===true){if(Object.keys(f).sort().join(',')!=='id,missing')fail('snapshot_content_inventory_invalid');}else if(!Number.isSafeInteger(f.size)||f.size<0||!sha(f.sha256))fail('snapshot_content_inventory_invalid');}
 }
 if(observed){
  if(!r.receipt.length||!r.receipt.some(f=>f.size>0)||r.receipt.some(f=>f.missing||typeof f.bytes!=='string'||Buffer.from(f.bytes,'base64').toString('base64')!==f.bytes)||!eq(strip(r.receipt),r.postAction))fail('snapshot_content_receipt_invalid');
  if(!eq(r.receipt.map(f=>f.id),r.current.map(f=>f.id)))fail('snapshot_content_inventory_invalid');
 }else if(r.receipt.length||r.postAction.length||r.current.length)fail('snapshot_content_no_read_violated');
 let storageMismatch=false;
 if(observed)storageMismatch=r.receipt.some(f=>{const b=Buffer.from(f.bytes,'base64');return b.length!==f.size||hash(b)!==f.sha256;});
 const stale=observed&&!eq(strip(r.receipt),r.current);
 const reason=r.mode==='control'?'control':r.mode==='no-receipt'?'kgp_capture_content_evidence_unavailable':storageMismatch?'kotlin_pipeline_snapshot_storage_mismatch':stale?'kotlin_derived_snapshot_stale':null;
 const expectedReason=({'control':'control','boundary':null,'mutate-same-size':'kotlin_derived_snapshot_stale','mutate-size':'kotlin_derived_snapshot_stale','delete':'kotlin_derived_snapshot_stale','blob-corrupt':'kotlin_pipeline_snapshot_storage_mismatch','no-receipt':'kgp_capture_content_evidence_unavailable'})[r.mode];
 if(reason!==expectedReason||r.capture?.reason!==reason||r.capture?.accepted!==(reason===null))fail('snapshot_content_capture_invalid');
 if(mutation){
  const m=r.mutation,prior=r.postAction.find(f=>f.id===m?.id),current=r.current.find(f=>f.id===m?.id);
  if(!prior||m.before!==prior.sha256||m.before===m.after||fileMutation&&m.restored!==true)fail('snapshot_content_mutation_invalid');
  if(r.mode==='delete'?m.after!==null||current?.missing!==true:r.mode==='blob-corrupt'?m.after!==hash(Buffer.from(r.receipt.find(f=>f.id===m.id).bytes,'base64')):m.after!==current?.sha256)fail('snapshot_content_mutation_invalid');
  const changed=r.postAction.filter((f,i)=>!eq(f,r.current[i]));
  if(fileMutation&&(changed.length!==1||changed[0].id!==m.id))fail('snapshot_content_mutation_invalid');
  if(r.mode==='mutate-same-size'&&prior.size!==current.size||r.mode==='mutate-size'&&current.size!==prior.size+1||r.mode==='blob-corrupt'&&stale)fail('snapshot_content_mutation_invalid');
 }else if(r.mutation!==null)fail('snapshot_content_mutation_invalid');
 if(!sha(r.archiveSha256)||!Array.isArray(r.jarEntries)||!r.jarEntries.length)fail('snapshot_content_artifact_invalid');
 if(r.readFault!=='none'&&illegalReads!==1)fail('snapshot_content_fault_not_reproduced');
 if(illegalReads)fail('snapshot_content_no_read_violated');
 return {boundaryFreshness:reason===null,reason,additionalMeasuredEvaluations:0,naturalContentBinding:false,productionAdopted:false};
}
export function verifySnapshotContentCase(c,a){
 if(c?.schema!=='osv-mcp.snapshot-content-case-v2'||!['Groovy','Kotlin'].includes(c.dsl)||c.dsl!==a.dsl||c.gradleVersion!==a.gradleVersion||!eq(c.sourcesSha256,a.sourcesSha256)||contentSources.some(p=>!sha(c.sourcesSha256?.[p]))||c.fixtureInputsSha256?.['build-logic/snapshot-helper.gradle']!==c.sourcesSha256[contentSources[0]]||!Array.isArray(c.runs)||c.runs.length!==contentModes.length)fail('snapshot_content_case_invalid');
 const approval={...a,fixtureInputsSha256:c.fixtureInputsSha256};const ids=new Set();
 const decisions=c.runs.map((r,i)=>{if(r.mode!==contentModes[i]||ids.has(r.runId))fail('snapshot_content_case_invalid');ids.add(r.runId);return verifySnapshotContentRun(r,approval)});
 const trace=r=>r.events.filter(e=>['registration:begin','registration:end','supplier:begin','supplier:end','task:begin','task:end','action:begin','action:end'].includes(e.event));
 for(const r of c.runs.slice(1))if(!eq(trace(r),trace(c.runs[0]))||!eq(r.jarEntries,c.runs[0].jarEntries))fail('snapshot_content_noninterference_failed');
 const faults=verifySnapshotContentFaults(c,a);
 return {runs:decisions,faults,approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0};
}

export const contentTargets=[
 ...['executed','didWork','skipped','noSource','failed'].map(field=>({kind:'stage',field,reason:'snapshot_content_stage_invalid'})),
 ...['registration:begin','registration:end','task:begin','task:end','action:begin','action:end','boundary:begin','boundary:end','getter:begin','getter:end','post-action:begin','post-action:end','capture:begin','capture:end'].map(event=>({kind:'event',event,reason:event.startsWith('getter:')?'snapshot_content_getter_counter_invalid':'snapshot_content_events_invalid'})),
 ...['configuration','natural','action'].flatMap(phase=>['boundary:begin','getter:begin','getter:end','post-action:begin','capture:begin'].map(where=>({kind:'supplier-move',phase,where,reason:'snapshot_content_extra_evaluation'}))),
 {kind:'extra-evaluation',reason:'snapshot_content_extra_evaluation'},
 {kind:'missing-bytes',reason:'snapshot_content_receipt_invalid'},
 {kind:'inventory',reason:'snapshot_content_inventory_invalid'},
 {kind:'rebaseline',reason:'snapshot_content_receipt_invalid'},
 {kind:'fake-success',reason:'snapshot_content_capture_invalid'},
 {kind:'binding',reason:'snapshot_content_binding_invalid'},
 {kind:'adoption',reason:'snapshot_content_scope_invalid'},
 {kind:'api',reason:'snapshot_content_api_invalid'},
];
export function mutateSnapshotContent(r,target){
 const c=structuredClone(r);
 switch(target.kind){
  case 'supplier-move':{const index=c.events.findIndex(e=>e.event==='supplier:begin'),pair=c.events.splice(index,2);pair.forEach(e=>e.phase=target.phase);c.events.splice(c.events.findIndex(e=>e.event===target.where)+1,0,...pair);break;}
  case 'stage':delete c.stage[target.field];break;
  case 'event':c.events=c.events.filter(e=>e.event!==target.event);break;
  case 'extra-evaluation':{const index=c.events.findIndex(e=>e.event==='getter:end');c.events.splice(index,0,{event:'supplier:begin',phase:'boundary'},{event:'supplier:end',phase:'boundary'});c.calls++;break;}
  case 'missing-bytes':delete c.receipt[0].bytes;break;
  case 'inventory':c.current.pop();break;
  case 'rebaseline':c.receipt[0].sha256='0'.repeat(64);break;
  case 'fake-success':c.capture={accepted:false,reason:'made-up'};break;
  case 'binding':c.binding.propertyIdentity=false;break;
  case 'adoption':c.naturalContentBinding=true;break;
  case 'api':c.api.gradle.sha256='0'.repeat(64);break;
 }
 return c;
}
export function contentRegressions(c,a){
 const r=c.runs[1];return contentTargets.map(target=>{
  let reason;try{verifySnapshotContentRun(mutateSnapshotContent(r,target),{...a,fixtureInputsSha256:c.fixtureInputsSha256});}catch(e){reason=e.message;}
  if(reason!==target.reason)fail('snapshot_content_regression_failed:'+JSON.stringify(target)+':'+reason);
  return {...target,accepted:false};
 });
}

export function verifySnapshotContentFaults(c,a){
 if(!Array.isArray(c.faults)||c.faults.length!==2)fail('snapshot_content_fault_missing');
 const ids=new Set(c.runs.map(r=>r.runId));
 return ['capture','no-receipt'].map((readFault,i)=>{
  const r=c.faults[i],normal=c.runs.find(n=>n.mode===(readFault==='capture'?'boundary':'no-receipt'));
  if(r?.readFault!==readFault||ids.has(r.runId))fail('snapshot_content_fault_identity_invalid');ids.add(r.runId);
  let reason;try{verifySnapshotContentRun(r,{...a,fixtureInputsSha256:c.fixtureInputsSha256,readFault});}catch(e){reason=e.message;}
  if(reason!=='snapshot_content_no_read_violated')fail(reason??'snapshot_content_fault_not_reproduced');
  const remove=r=>{const copy=structuredClone(r);delete copy.runId;delete copy.readFault;delete copy.archiveSha256;copy.getterCalls--;copy.events=copy.events.filter(e=>!(e.phase==='capture'&&e.event.startsWith('getter:')));return copy;};
  const expected=structuredClone(normal);delete expected.runId;delete expected.readFault;delete expected.archiveSha256;
  if(!eq(remove(r),expected))fail('snapshot_content_fault_binding_invalid');
  const window=r.events.slice(r.events.findIndex(e=>e.event==='capture:begin')+1,r.events.findIndex(e=>e.event==='capture:end'));
  if(window.filter(e=>e.event==='getter:begin').length!==1||window.some(e=>e.event.startsWith('supplier:')))fail('snapshot_content_fault_not_reproduced');
  return {readFault,actualCachedReads:1,extraInstrumentedSuppliers:0,accepted:false,reason};
 });
}

export function contentCaseRegressions(c,a){
 return ['configuration','natural','action'].map(phase=>{
  const changed=structuredClone(c);
  for(const r of changed.runs){const index=r.events.findIndex(e=>e.event==='supplier:begin'),pair=r.events.splice(index,2);pair.forEach(e=>e.phase=phase);const where=['control','no-receipt'].includes(r.mode)?'action:begin':'getter:begin';r.events.splice(r.events.findIndex(e=>e.event===where)+1,0,...pair);}
  let reason;try{verifySnapshotContentCase(changed,a);}catch(e){reason=e.message;}
  if(!['snapshot_content_extra_evaluation','snapshot_content_supplier_phase_invalid'].includes(reason))fail('snapshot_content_case_regression_failed');
  return {kind:'coordinated-supplier-move',phase,accepted:false,reason};
 });
}
