import {createHash,createPublicKey,verify} from 'node:crypto';
import {VF3_CONDITIONS,VF3_ARMS,VF3_WORKLOADS,VF3_OBSERVATIONS,validateVf3Row,summarizeVf3,validateVf3Measurement,classifyVf3Control} from './gradleOwnedCwcVf3Validation.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
export const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b),need=(b,k)=>{if(!b)throw Error('vf3p_'+k);},finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0,n=x=>Number.isSafeInteger(x)&&x>=0,near=(a,b)=>Math.abs(a-b)<=1e-6;
export const VF3P_GROUPS=['actual-session','wire-verification','live-gate','planner','codec','canonical-hash','copy','source','transport','construction'];
export const VF3P_POLICY={schema:'cwc-vf3p.policy.v2',conditions:VF3_CONDITIONS,groups:VF3P_GROUPS,progress:'after-original-client-accept',responseWitness:'original-transport-reply-digest-and-client-accept',deadlineSplit:'exclusive-at-original-deadline',observer:'call-through-export-prototype',stackLimit:128,contextLimit:1024,optimization:false,productionAdopted:false};
export function profileGroup(name){
 if(name==='construction')return 'construction';if(name==='session.inspectAuthenticatedCall')return 'actual-session';if(name.startsWith('protocol.')||name.startsWith('signer.'))return 'wire-verification';
 if(name==='json.structuredClone')return 'copy';if(name.startsWith('json.'))return 'canonical-hash';if(name.startsWith('plan.'))return 'planner';
 if(name.startsWith('codec')||name.startsWith('root.')||name.startsWith('fact.'))return 'codec';
 if(name.startsWith('binding.')||name.startsWith('grant.')||name.startsWith('registry.')||name.startsWith('ledger.')||name.startsWith('owner.')||name==='scope.gate'||['endpoint.gate','endpoint.now','endpoint.permitAPI'].includes(name))return 'live-gate';
 if(['scope.load','scope.pre','scope.parts','scope.scalarPart'].includes(name))return 'source';if(name.startsWith('link.')||name.startsWith('control.')||name==='endpoint.openPeer')return 'transport';throw Error('vf3p_operation');
}
function receiptParts(record,call){
 try{
  need(typeof record.verifiedReply==='string'&&record.verifiedReply.length<=10924,'progress_receipt');const wire=Buffer.from(record.verifiedReply,'base64');
  need(wire.length>0&&wire.length<=8192&&wire.toString('base64')===record.verifiedReply&&wire.length===call.providerReplyBytes&&createHash('sha256').update(wire).digest('hex')===call.replyDigest,'progress_receipt');
  const envelope=JSON.parse(wire.toString('utf8')),body=envelope.body;
  need(envelope.schema==='osv-mcp.q2.c3b.owner-envelope.v1'&&envelope.direction==='reply'&&envelope.domain==='aux'&&envelope.api==='aux.'+record.api&&body.api===record.api&&body.requestDigest===record.requestDigest,'progress_receipt');
  const parts=record.api==='ReadSourceRanges'?body.parts:record.api==='ReadSealedSource'?[body.result]:[];
  need(Array.isArray(parts)&&parts.length<=4,'progress_receipt');
  return parts.map(p=>{need(typeof p.bytes==='string','progress_receipt');const bytes=Buffer.from(p.bytes,'base64');need(bytes.toString('base64')===p.bytes,'progress_receipt');const range=record.api==='ReadSourceRanges';return {kind:range?p.kind:p.entry.kind,index:range?p.index:p.entry.index,offset:p.offset,length:bytes.length,entryBytes:p.entry.byteLength,entrySha256:p.entry.sha256};});
 }catch{need(false,'progress_receipt');}
}
export function validateProgress(row){
 const p=row.progress;need(p?.schema==='cwc-vf3p.progress.v2'&&p.point==='after-original-client-accept'&&Array.isArray(p.records)&&p.records.length<=128&&typeof p.reconstructed==='boolean','progress_schema');
 const accepted=row.calls.filter(c=>c.control.metrics.publications===1);need(p.records.length===accepted.length,'progress_calls');const offsets=new Map(),entries=new Map();let sourceBytes=0,inventoryBytes=0;
 for(const [i,r]of p.records.entries()){
  need(r.order===i+1&&r.api===accepted[i].api.slice(4)&&r.requestDigest===accepted[i].accounting.budgetKey&&Array.isArray(r.parts)&&r.parts.length<=(r.api==='ReadSourceRanges'?4:1)&&(r.api==='ReadSourceDescriptor'?r.parts.length===0:r.parts.length>0)&&r.parts.length===accepted[i].sourceAccounting.after.parts-accepted[i].sourceAccounting.before.parts,'progress_call');
  need(same(r.parts,receiptParts(r,accepted[i])),'progress_receipt');
  for(const q of r.parts){need(['inventory','commit','payload'].includes(q.kind)&&n(q.index)&&n(q.offset)&&n(q.length)&&q.length>0&&q.length<=4096&&n(q.entryBytes)&&q.entryBytes>0&&q.entryBytes<=41460&&q.offset+q.length<=q.entryBytes&&/^[a-f0-9]{64}$/.test(q.entrySha256),'progress_part');const key=q.kind+':'+q.index,prior=entries.get(key);need(!prior||same(prior,{byteLength:q.entryBytes,sha256:q.entrySha256}),'progress_entry');entries.set(key,{byteLength:q.entryBytes,sha256:q.entrySha256});need(q.offset===(offsets.get(key)??0),'progress_contiguous');offsets.set(key,q.offset+q.length);if(q.kind==='inventory')inventoryBytes+=q.length;else sourceBytes+=q.length;}
 }
 need(typeof row.audit.verified==='boolean'&&p.reconstructed===row.audit.verified,'progress_reconstruction');
 if(p.reconstructed){
  const inv=row.inventory,result=row.result;
  need(inv&&Array.isArray(inv.rows)&&n(inv.size)&&result&&hash(inv.rows)===result.inputDigest&&hash(inv.rows.map(e=>e.sha256))===result.outputDigest&&result.outputDigest===row.audit.expectedDigest&&inv.digest===result.inventoryDigest&&hash({domain:'c3b-source-inventory-v1',metadata:row.metadata,entries:inv.rows})===inv.digest&&inv.size===inv.rows.reduce((s,e)=>s+e.byteLength,0),'progress_reconstruction_evidence');
  need(sourceBytes===inv.size&&inv.rows.every(e=>offsets.get(e.kind+':'+e.index)===e.byteLength&&same(entries.get(e.kind+':'+e.index),{byteLength:e.byteLength,sha256:e.sha256})),'progress_complete');
 }
 return {acceptedCalls:accepted.length,sourceBytes,inventoryBytes,coveredEntries:[...entries].filter(([k,e])=>!k.startsWith('inventory:')&&offsets.get(k)===e.byteLength).length,reconstructed:p.reconstructed,lastApi:row.calls.at(-1)?.api??null,lastSourcePhase:row.calls.at(-1)?.sourceAccounting.phases.at(-1)??null,planWindows:row.planTiming.windows.length,completedPlanWindows:row.planTiming.windows.filter(w=>w.complete).length,sourceLoads:row.audit.loads,validatedSourceBytes:row.providerMetrics?.validatedBytes??0,providerPlansAttempted:row.providerMetrics?.plans??0,partsProduced:row.providerMetrics?.parts??0,providerReplies:row.providerMetrics?.replies??0,actualSessionInspections:row.calls.reduce((s,c)=>s+(c.actualControl.phases.inspect??0),0),logicalChecks:row.audit.logical,recordedCallWork:row.calls.reduce((s,c)=>s+c.accounting.after.work-c.accounting.before.work+c.accounting.after.initialization-c.accounting.before.initialization,0),unregisteredDispatches:row.profile?row.profile.inspectionWitness.length-row.calls.length:null};
}
export function validateVf3pRow(row,methods){validateVf3Row(row);const progress=validateProgress(row);if(row.observation==='quiet')need(row.profile===null,'quiet');else validateVf3pCost(row,methods??row.profile?.sources);return progress;}
const costFields=['inclusiveMs','exclusiveMs','childMs','beforeMs','afterMs','inclusiveBeforeMs','inclusiveAfterMs'];
export function costBreakdown(p){
 const groups=Object.fromEntries(VF3P_GROUPS.map(g=>[g,{exclusiveMs:0,beforeMs:0,afterMs:0}])),canonicalByOwner={};
 for(const [name,b]of Object.entries(p.operations))for(const k of ['exclusiveMs','beforeMs','afterMs'])groups[profileGroup(name)][k]+=b[k];
 for(const c of Object.values(p.contexts))if(profileGroup(c.operation)==='canonical-hash')canonicalByOwner[c.owner]=(canonicalByOwner[c.owner]??0)+c.exclusiveMs;
 return {groups,canonicalByOwner,otherMs:p.otherMs,otherBeforeMs:p.otherBeforeMs,otherAfterMs:p.otherAfterMs};
}
export function validateVf3pCost(row,methods){
 const p=row.profile,t=row.trace;need(p?.schema==='cwc-vf3p.cost.v1'&&p.mode===row.observation&&same(p.sources,methods),'cost_sources');
 need(p.start===t.start&&p.end===t.end&&p.wallMs===t.wallMs&&p.deadline===row.deadline&&finite(p.wallMs)&&near(p.wallMs,p.end-p.start),'cost_window');
 need(['wallBeforeMs','wallAfterMs','otherMs','otherBeforeMs','otherAfterMs'].every(k=>finite(p[k]))&&near(p.wallBeforeMs,Math.max(0,Math.min(p.end,p.deadline)-p.start))&&near(p.wallAfterMs,p.wallMs-p.wallBeforeMs)&&near(p.otherMs,p.otherBeforeMs+p.otherAfterMs),'deadline_partition');
 const names=new Set([...Object.keys(methods).filter(k=>k!=='plan'),'construction','plan.client-initial','plan.client-seal','plan.provider']);
 need(p.entries&&p.operations&&same(Object.keys(p.entries).sort(),Object.keys(p.operations).sort())&&Object.keys(p.operations).length<=128,'operation_closure');
 const sums={};let total=0,before=0,after=0;
 for(const [name,b]of Object.entries(p.operations)){
  need(names.has(name)&&n(b.calls)&&b.calls>0&&p.entries[name]===b.calls,'operation_calls');profileGroup(name);
  need(costFields.every(k=>finite(b[k]))&&near(b.inclusiveMs,b.exclusiveMs+b.childMs)&&near(b.exclusiveMs,b.beforeMs+b.afterMs)&&near(b.inclusiveMs,b.inclusiveBeforeMs+b.inclusiveAfterMs)&&b.beforeMs<=b.inclusiveBeforeMs+1e-6&&b.afterMs<=b.inclusiveAfterMs+1e-6,'operation_partition');
  if(p.mode==='counts')need(costFields.every(k=>b[k]===0),'counter_clock');
  if(['construction','session.inspectAuthenticatedCall','json.ownedSha256'].includes(name)||name.startsWith('plan.'))need(b.inclusiveMs<=p.wallMs+1e-6&&b.inclusiveBeforeMs<=p.wallBeforeMs+1e-6&&b.inclusiveAfterMs<=p.wallAfterMs+1e-6,'nonreentrant_bound');
  if(name==='json.ownedSha256')need(b.childMs===0,'sha_leaf');
  sums[name]=Object.fromEntries(['calls',...costFields].map(k=>[k,0]));total+=b.exclusiveMs;before+=b.beforeMs;after+=b.afterMs;
 }
 need(near(total+p.otherMs,p.wallMs)&&near(before+p.otherBeforeMs,p.wallBeforeMs)&&near(after+p.otherAfterMs,p.wallAfterMs),'cost_partition');
 need(p.contexts&&p.contextEntries&&same(Object.keys(p.contexts).sort(),Object.keys(p.contextEntries).sort())&&Object.keys(p.contexts).length<=1024,'context_closure');
 for(const [key,c]of Object.entries(p.contexts)){
  need(key===[c.actor,c.owner,c.operation].join('|')&&['outside','client-initial','client-seal','provider'].includes(c.actor)&&['outside',...VF3P_GROUPS].includes(c.owner)&&sums[c.operation]&&n(c.calls)&&c.calls>0&&p.contextEntries[key]===c.calls,'context_identity');
  need(costFields.every(k=>finite(c[k]))&&near(c.inclusiveMs,c.exclusiveMs+c.childMs)&&near(c.exclusiveMs,c.beforeMs+c.afterMs)&&near(c.inclusiveMs,c.inclusiveBeforeMs+c.inclusiveAfterMs),'context_partition');
  for(const k of ['calls',...costFields])sums[c.operation][k]+=c[k];
 }
 for(const [name,s]of Object.entries(sums))for(const k of ['calls',...costFields])need(near(s[k],p.operations[name][k]),'context_sum');
 for(const [name,b]of Object.entries(t.buckets))need(same(b,{calls:p.operations[name]?.calls,inclusiveMs:p.operations[name]?.inclusiveMs,exclusiveMs:p.operations[name]?.exclusiveMs})&&t.entries[name]===p.entries[name],'base_projection');
 need(same(t.handshakes,p.handshakes),'handshake_projection');
 need(Array.isArray(p.inspectionWitness)&&p.inspectionWitness.length===(p.entries['link.dispatch.entry']??0)&&p.inspectionWitness.length>=row.calls.length&&p.inspectionWitness.length<=row.calls.length+1,'inspection_witness');
 let inspected=0;for(const [i,w]of p.inspectionWitness.entries()){
  need(w.id===i+1&&n(w.exports),'inspection_witness');inspected+=w.exports;const c=row.calls[i];
  if(c){const actual=c.actualControl.phases.inspect??0;need(c.control.metrics.publications?w.exports+1===actual:Math.abs(w.exports-actual)<=1,'actual_inspection_witness');}
 }
 need(inspected===(p.entries['session.inspectAuthenticatedCall']??0),'inspection_count');
 need(Array.isArray(p.planWitness)&&p.planWitness.length<=130,'plan_witness');let previous=p.start;
 for(const [i,w]of p.planWitness.entries()){
  need(w.id===i+1&&['client-initial','client-seal','provider'].includes(w.actor)&&typeof w.returned==='boolean','plan_witness');
  if(p.mode==='counts')need(w.start===0&&w.end===0,'plan_clock');else{need(finite(w.start)&&finite(w.end)&&w.start>=previous&&w.end>=w.start&&w.end<=p.end,'plan_clock');previous=w.end;}
 }
 for(const actor of ['client-initial','client-seal','provider']){
  const windows=row.planTiming.windows.filter(w=>w.actor===actor),ws=p.planWitness.filter(w=>w.actor===actor),root=p.operations['plan.'+actor];need(ws.length===(root?.calls??0)&&ws.length>=windows.filter(w=>w.complete).length&&ws.length<=windows.length,'plan_count');
  const ms=ws.reduce((s,w)=>s+w.end-w.start,0),pre=ws.reduce((s,w)=>s+Math.max(0,Math.min(w.end,p.deadline)-w.start),0);
  need(near(root?.inclusiveMs??0,ms)&&near(root?.inclusiveBeforeMs??0,pre)&&near(root?.inclusiveAfterMs??0,ms-pre),'plan_span');
  if(p.mode==='timed')for(const [i,w]of ws.entries())need(w.start>=windows[i].start&&w.end<=windows[i].end,'plan_containment');
  const cs=Object.values(p.contexts).filter(c=>c.actor===actor);for(const [field,target]of [['exclusiveMs',ms],['beforeMs',pre],['afterMs',ms-pre]])need(near(cs.reduce((s,c)=>s+c[field],0),target),'actor_partition');
 }
 if(row.status==='complete'){
  for(const k of ['session.inspectAuthenticatedCall','protocol.validateChallengeExchange','protocol.validateChannelFrame','signer.verifyOwnerValue','owner.check','owner.current','owner.assertStamp','binding.providerGate','binding.scopeGate','scope.gate','registry.assertCurrent','endpoint.gate','endpoint.now','endpoint.permitAPI','json.canonicalOwnedJson','json.ownedDigest','json.ownedSha256','json.structuredClone'])need(p.entries[k]>0,'required_operation');
  need(inspected+row.audit.calls===row.audit.logical,'actual_inspection_complete');
 }
 need((p.entries['protocol.validateChallengeExchange']??0)>=row.audit.challengeChecks&&(p.entries['protocol.validateChannelFrame']??0)>=row.audit.channelChecks&&(p.entries['signer.verifyOwnerValue']??0)>=row.audit.ownerChecks,'predicate_count');
 return costBreakdown(p);
}
const median=xs=>{if(!xs.length)return null;const x=[...xs].sort((a,b)=>a-b),i=Math.floor(x.length/2);return x.length%2?x[i]:(x[i-1]+x[i])/2;};
export function comparisonProjection(c){return {...c,summary:c.summary.map(g=>({...g,arms:Object.fromEntries(Object.entries(g.arms).map(([a,v])=>{const {overhead,...rest}=v;return [a,rest];}))}))};}
export function summarizeVf3p(rows){
 const comparison=summarizeVf3(rows),costs=[],observerCosts=[],progress=[];
 for(const workload of VF3_WORKLOADS.map(w=>w.id))for(const role of ['reader','authority-broker'])for(const arm of VF3_ARMS){
  const rs=rows.filter(r=>r.workload===workload&&r.role===role&&r.arm===arm&&r.round>=0),timed=rs.filter(r=>r.observation==='timed');
  for(const kind of ['complete','original-deadline-censored','invalid']){
   const subset=timed.filter(r=>classifyVf3Control(r).kind===kind);if(!subset.length)continue;
   const ds=subset.map(r=>costBreakdown(r.profile));costs.push({workload,role,arm,kind,observations:subset.length,groups:Object.fromEntries(VF3P_GROUPS.map(g=>[g,Object.fromEntries(['exclusiveMs','beforeMs','afterMs'].map(k=>[k,median(ds.map(d=>d.groups[g][k]))]))])),canonicalByOwner:Object.fromEntries(['outside',...VF3P_GROUPS].map(g=>[g,median(ds.map(d=>d.canonicalByOwner[g]??0))])),operations:Object.fromEntries([...new Set(subset.flatMap(r=>Object.keys(r.profile.operations)))].sort().map(k=>[k,{calls:median(subset.map(r=>r.profile.entries[k]??0)),exclusiveMs:median(subset.map(r=>r.profile.operations[k]?.exclusiveMs??0))}])),observerBeforeMs:median(subset.map(r=>r.profile.wallBeforeMs)),observerAfterMs:median(subset.map(r=>r.profile.wallAfterMs)),acceptedSourceBytes:median(subset.map(r=>validateProgress(r).sourceBytes)),coveredEntries:median(subset.map(r=>validateProgress(r).coveredEntries)),otherMs:median(ds.map(d=>d.otherMs)),otherBeforeMs:median(ds.map(d=>d.otherBeforeMs)),otherAfterMs:median(ds.map(d=>d.otherAfterMs)),planWindowMs:median(subset.map(r=>r.planTiming.clientPlanMs+r.planTiming.sealMs+r.planTiming.providerPlanMs)),packMs:median(subset.map(r=>Object.entries(r.profile.operations).filter(([k])=>k.startsWith('plan.')).reduce((s,[,b])=>s+b.inclusiveMs,0))),interpretation:kind==='complete'?'completed-observed-wall':'partial-observed-work-not-recoverable-cost'});
  }
  for(const [a,b]of [['counts','quiet'],['timed','counts'],['timed','quiet']]){
   const pairs=[0,1,2].map(round=>{const x=rs.find(r=>r.round===round&&r.observation===a),y=rs.find(r=>r.round===round&&r.observation===b);return {round,kind:x.status==='complete'&&y.status==='complete'?'completed-pair':'noncompleted-pair',attemptDeltaMs:x.totalMs-y.totalMs,first:x.status,second:y.status};});
   const complete=pairs.filter(p=>p.kind==='completed-pair');observerCosts.push({workload,role,arm,delta:a+'-'+b,pairs,completedPairs:complete.length,medianCompletedDeltaMs:median(complete.map(p=>p.attemptDeltaMs)),noncompletedPairs:pairs.length-complete.length});
  }
  for(const observation of VF3_OBSERVATIONS){const samples=rs.filter(r=>r.observation===observation);progress.push({workload,role,arm,observation,samples:samples.map(r=>({round:r.round,status:r.status,kind:classifyVf3Control(r).kind,totalMs:r.totalMs,...validateProgress(r)}))});}
 }
 return {comparisonDecision:comparison.decision,costs,observerCosts,progress,optimizationImplemented:false,productionAdopted:false,scope:'same-process; owned authority; one RPC/channel; original deadline and budgets'};
}
export function validateVf3pMeasurement(m,sources,methods){
 need(m?.schema==='cwc-vf3p.measurement.v2','measurement');const comparison=validateVf3Measurement({...m,schema:'cwc-vf3.measurement.v2',summary:undefined},sources);need(same(comparisonProjection(comparison),m.comparison),'comparison');
 for(const row of m.rows){validateVf3pRow(row,methods);const oracle=m.functional.rows.find(o=>o.workload===row.workload&&o.role===row.role&&o.transferMode===(row.arm.startsWith('scalar')?'S-scoped':'B-independent')&&o.verificationMode===(row.arm.endsWith('fact-live')?'fact-live':'full-verify'));need(oracle?.expectedInventory&&n(oracle.inventoryByteLength)&&oracle.inventoryByteLength>0,'progress_oracle');
  const expected=new Map(oracle.expectedInventory.rows.map(e=>[e.kind+':'+e.index,e]));let bytes=0,inventory=0;for(const r of row.progress.records)for(const p of r.parts){if(p.kind==='inventory'){need(p.entryBytes===oracle.inventoryByteLength,'inventory_progress');inventory+=p.length;}else{const e=expected.get(p.kind+':'+p.index);need(e&&e.byteLength===p.entryBytes&&e.sha256===p.entrySha256,'source_progress');bytes+=p.length;}}
  need(bytes<=oracle.expectedInventory.size&&inventory<=oracle.inventoryByteLength,'progress_bound');
  if(row.progress.reconstructed){need(same(row.inventory,oracle.expectedInventory),'progress_reconstruction_oracle');for(const k of ['inputDigest','outputDigest','inventoryDigest','requests','clientPlans','providerPlans'])need(row.result[k]===oracle.result[k],'progress_reconstruction_oracle');}
 }
 for(const a of m.approvals){const p=a.profilingApproval,man=p?.envelope?.manifest;need(man?.schema==='cwc-vf3p.approval.v2'&&man.node===process.version&&man.basePin===a.record.pin&&man.policyDigest===hash(VF3P_POLICY)&&same(man.methods,methods)&&hash(p.registry)===p.pin&&hash(man)===p.registry.manifestDigest,'approval');const key=createPublicKey({key:Buffer.from(p.registry.operatorSpki,'base64'),type:'spki',format:'der'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(man)),key,Buffer.from(p.envelope.signature,'base64')),'signature');for(const [path,h]of Object.entries(man.sources))need(sources[path]===h,'source_'+path);for(const root of ['gradleOwnedCwcVf3p.ts','gradleOwnedCwcVf3pProfile.ts','gradleOwnedCwcVf3pProgress.ts','gradleOwnedCwcVf3pApproval.ts','gradleOwnedCwcVf3pValidation.mjs'])need(man.sources['src/test/fixtures/'+root],'approval_root');need(m.rows.filter(r=>r.workload===a.workload&&r.role===a.role&&r.round===a.round).every(r=>r.profilingPin===p.pin),'profiling_pin');}
 const ps=summarizeVf3p(m.rows);need(same(ps,m.profileSummary),'profile_summary');return ps;
}
export function vf3pTables(m){
 const fmt=n=>n===null?'—':n.toFixed(1),lines=['| 条件 | role | scalar/full ms | scalar/fact ms | batch/full ms | batch/fact ms | 完了／測定 | 判断 |','| --- | --- | ---: | ---: | ---: | ---: | --- | --- |'];
 for(const g of m.comparison.summary)lines.push('| '+[g.workload,g.role,...VF3_ARMS.map(a=>fmt(g.arms[a].quietMedianMs)),VF3_ARMS.map(a=>g.arms[a].completed+'/'+g.arms[a].attempted).join(' · '),g.decision].join(' | ')+' |');
 lines.push('','| 条件 | role | batch mode | timed分類／件数 | 実Session ms | live gate ms | canonical/hash ms | pack包含 ms | 期限後observer ms | 受理済みsource B |','| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
 for(const c of m.profileSummary.costs.filter(c=>c.arm.startsWith('batch')))lines.push('| '+[c.workload,c.role,c.arm,c.kind+'/'+c.observations,fmt(c.groups['actual-session'].beforeMs),fmt(c.groups['live-gate'].beforeMs),fmt(c.groups['canonical-hash'].beforeMs),fmt(c.packMs),fmt(c.observerAfterMs),fmt(c.acceptedSourceBytes)].join(' | ')+' |');
 return lines.join('\n');
}
