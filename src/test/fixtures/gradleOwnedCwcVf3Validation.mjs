import {LB3_WORKLOADS,validateLb3Trace} from './gradleOwnedCwcLb3Validation.mjs';
export const VF3_WORKLOADS=LB3_WORKLOADS;
export const VF3_ARMS=['scalar/full-verify','scalar/fact-live','batch/full-verify','batch/fact-live'];
export const VF3_OBSERVATIONS=['quiet','counts','timed'];
export const VF3_CONDITIONS={schema:'cwc-vf3.conditions.v1',deadlineMs:4500,memory:1048576,work:67108864,providerWork:1048576,wire:67108864,variant:'combined',businessCallsPerChannel:1,referenceOracle:false,planEvents:false,minimumImprovementPercent:5,measuredRounds:3,warmupRounds:1,clock:'owned-monotonic'};

import {createHash,createPublicKey,verify} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex'),same=(a,b)=>canonical(a)===canonical(b),need=(b,r)=>{if(!b)throw Error('vf3_'+r);},n=x=>Number.isSafeInteger(x)&&x>=0,finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0,near=(a,b)=>Math.abs(a-b)<=1e-6;
const counters=['initialization','work','wire','attempts'],project=b=>Object.fromEntries(counters.map(k=>[k,b?.[k]]));
const phases=['admission','pre-before','pre-after','load-before','load-after','plan-before','plan-after','parts-after','post-before','post-after','sign-before','enqueue-before'];
function keys(v,k,r){need(v&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v).sort(),[...k].sort()),r);}
export function validateVf3Actual(a,parentDeadline){
 need(a&&['validated','invalid'].includes(a.state)&&a.generation===2&&n(a.deadline)&&a.deadline>=parentDeadline&&!a.lookupPresent&&a.readers===0&&a.bytes===0&&a.reclaimed&&a.releases===1,'actual_cleanup');
 for(const k of ['checks','reads','outcomes','replyVerifications','authSignatures'])need(n(a[k]),'actual_count');const p=a.phases,get=k=>p[k]??0;
 need(Object.keys(p).every(k=>['dispatch','dispatch-read','inspect','inspect-admission-live','inspect-hash','inspect-retained-live','outcome','outcome-decode','reply-verify','reply-read','reply-sign','reply-hash'].includes(k)&&n(p[k])&&p[k]>0),'actual_phase');
 need(a.reads===get('dispatch-read')+get('inspect-hash')+get('outcome-decode')+get('reply-read')+get('reply-hash')&&a.checks===get('dispatch')+get('inspect')+get('outcome')+get('reply-verify')+get('reply-sign')&&a.checks>=a.reads&&a.checks<=a.reads+1,'actual_count');
 need(get('dispatch')===get('dispatch-read')&&get('dispatch')===1&&get('inspect')===get('inspect-admission-live')&&get('inspect-hash')>=get('inspect-retained-live')&&get('inspect-hash')<=get('inspect-retained-live')+Number(a.state==='invalid')&&get('inspect')>=get('inspect-hash')&&get('inspect')<=get('inspect-hash')+1,'actual_phase');
 const frontier=(entry,read,done)=>need(done<=get(read)&&get(read)<=get(entry)&&get(entry)<=done+Number(a.state==='invalid')&&get(entry)<=1,'actual_terminal_frontier');
 frontier('outcome','outcome-decode',a.outcomes);frontier('reply-verify','reply-read',a.replyVerifications);frontier('reply-sign','reply-hash',a.authSignatures);
 need(a.state!=='validated'||a.authSignatures===1&&a.replyVerifications===1,'actual_signature');need(!a.authSignatures||a.replyVerifications===1,'actual_signature');
}
function accounting(rows,witnessRequired){
 const last=new Map();
 for(const r of rows){const a=r.accounting,i=a?.input,v=r.control.verification;need(a?.schema==='cwc-vf2.consumption.v1'&&/^[a-f0-9]{64}$/.test(a.budgetKey)&&n(a.reservationStart),'consumption');keys(i,['inner','outer','challengeRequest','challengeReply'],'consumption');need(Object.values(i).every(x=>n(x)&&x>0&&x<=8192),'consumption');for(const b of [a.before,a.captured,a.after]){keys(b,counters,'consumption');need(Object.values(b).every(n),'consumption');}
  const prior=last.get(a.budgetKey);need(same(a.before,prior?.after??{initialization:0,work:0,wire:0,attempts:0})&&a.reservationStart===(prior?.end??0),'consumption');const issued=r.control.events.filter(e=>e.name==='call-issued');need(issued.length===1&&issued[0].bytes===Object.values(i).reduce((x,y)=>x+y,0),'consumption');
  const claimed=r.control.events.some(e=>e.name==='claim'),expected=[{bytes:131072,initialization:4096},{bytes:131072},{bytes:98304,initialization:8192,slot:true},{bytes:0,work:i.inner,wire:i.inner+i.outer},...(claimed?[{bytes:8192,initialization:4096}]:[]),...(r.binding.scopeBytes?[{bytes:r.binding.scopeBytes-32768}]:[])];let index=0,logical=0,balance=a.before,receiveBalance;
  need(Array.isArray(a.reservations)&&a.reservations.length<=64,'consumption');for(const [j,q]of a.reservations.entries()){
   keys(q,['order','count','bytes','initialization','work','wire','slot','before','after'],'consumption');need(q.order===a.reservationStart+j+1&&n(q.count)&&q.count>0&&same(q.before,balance),'consumption');const gate=q.bytes===0&&q.initialization===0&&q.work===1&&q.wire===0&&q.slot===false;
   if(gate){need(index>=4,'consumption');logical+=q.count;}else{const e={initialization:0,work:0,wire:0,slot:false,...expected[index++]};need(q.count===1&&['bytes','initialization','work','wire','slot'].every(k=>q[k]===e[k]),'consumption');}
   balance={initialization:balance.initialization+q.initialization*q.count,work:balance.work+q.work*q.count,wire:balance.wire+q.wire*q.count,attempts:balance.attempts+Number(q.slot)*q.count};need(same(balance,q.after),'consumption');if(index===4&&!gate)receiveBalance={...balance,work:balance.work+1};
  }
  need(index===expected.length&&logical===v.logical&&same(a.after,balance)&&same(a.captured,receiveBalance)&&balance.attempts<=2,'consumption');let gatesAfter;if(witnessRequired){const g=r.gateReceipt;keys(g,['schema','budgetKey','before','after'],'gate_work');need(g.schema==='cwc-vf3.gate-work.v1'&&g.budgetKey===a.budgetKey&&n(g.before)&&n(g.after)&&g.before===(prior?.gatesAfter??0)&&g.after-g.before===v.logical&&a.after.work-a.before.work===i.inner+g.after-g.before,'gate_work');gatesAfter=g.after;}last.set(a.budgetKey,{after:balance,end:a.reservationStart+a.reservations.length,gatesAfter});
 }
 for(const r of rows){const final=last.get(r.accounting.budgetKey).after;for(const b of [r.budget,r.control.budget,r.binding.budget,r.binding.call.budget])need(same(project(b),final),'consumption');}
}
function sourceAccounting(r,parentDeadline,witnessRequired){
 const a=r.sourceAccounting;keys(a,['before','after','rowBefore','rowAfter','phases',...(witnessRequired?['spend']:[])],'source_accounting');
 need(Array.isArray(a.phases)&&a.phases.length<=12,'source_accounting');const ordered=phases.filter(p=>r.api==='aux.ReadSourceRanges'||!p.startsWith('plan-'));need(same(a.phases,ordered.slice(0,a.phases.length)),'source_phase');
 for(const k of ['calls','pre','post','loads','plans','validatedBytes','parts','replies'])need(n(a.before[k])&&n(a.after[k])&&a.after[k]>=a.before[k],'source_count');need(finite(a.before.planMs)&&finite(a.after.planMs)&&a.after.planMs>=a.before.planMs,'source_time');
 const s=witnessRequired?a.spend:{wireReceived:true,planFloor:r.api==='aux.ReadSourceRanges'?(a.rowBefore?.spent.work??0)+156978:null,finished:a.phases.includes('enqueue-before')};
 if(witnessRequired){keys(s,['schema','operationKey','wireReceived','planFloor','finished'],'source_spend');need(s.schema==='cwc-vf3.source-spend.v1'&&s.operationKey===r.operationKey&&typeof s.wireReceived==='boolean'&&typeof s.finished==='boolean'&&(s.planFloor===null||n(s.planFloor)&&s.planFloor>0),'source_spend');}
 const row=a.rowAfter;if(row===null){need(a.phases.length===0&&a.after.calls===a.before.calls&&(!witnessRequired||!s.wireReceived&&s.planFloor===null&&!s.finished),'source_accounting');return;}
 const prior=a.rowBefore;need(row.k===r.operationKey&&row.deadline===parentDeadline&&row.attempts===(prior?.attempts??0)+1&&row.attempts<=2,'source_accounting');
 const load=a.after.loads-a.before.loads,plan=s.planFloor!==null,finish=Number(s.finished),work=Number(plan)*156978+65536*load+finish;
 need(!plan||r.api==='aux.ReadSourceRanges'&&s.wireReceived&&s.planFloor===(prior?.spent.work??0)+156978,'source_prepayment');
 need(!a.phases.length||s.wireReceived&&(r.api!=='aux.ReadSourceRanges'||plan),'source_prepayment');need(!s.finished||s.wireReceived&&a.phases.includes('sign-before'),'source_finish');need(!a.phases.includes('enqueue-before')||s.finished,'source_finish');
 need(load<=1&&row.spent.work-(prior?.spent.work??0)===work&&a.after.calls-a.before.calls===1,'source_work');
 const wire=row.spent.wire-(prior?.spent.wire??0);need(n(wire)&&wire<=(s.wireReceived?r.accounting.input.inner+8192:0)&&wire>=(s.wireReceived?r.accounting.input.inner:0),'source_wire');if(r.providerReplyBytes>0||!finish)need(wire===(s.wireReceived?r.accounting.input.inner:0)+r.providerReplyBytes,'source_wire');if(a.phases.includes('enqueue-before'))need(wire>r.accounting.input.inner,'source_wire');
 if(r.control.metrics.publications===1)need(a.phases.length===ordered.length&&load===1&&finish===1&&row.state==='complete'&&a.after.pre-a.before.pre===1&&a.after.post-a.before.post===1&&a.after.replies-a.before.replies===1&&a.after.plans-a.before.plans===Number(r.api==='aux.ReadSourceRanges'),'fresh_source');
}
/** Entry counters advance before foreign permission callbacks; liveChecks advances only after
 * the final owned-clock check. A genuine original deadline may stop one live invocation. */
export function validateVf3LiveCounts(m,partial){
 const l=m.liveChecks,p=m.purposeChecks,c=m.credentialChecks;need(n(l)&&n(p)&&n(c),'live_counts');
 if(!partial)need(p===l&&c===2*l,'live_counts');
 else need(p>=l&&p<=l+1&&c>=2*l&&c<=2*l+2&&(p===l||c===2*l+2),'live_frontier');
}
function validateCalls(rows,mode,parentDeadline,deadlineRefusal=false,witnessRequired=false){
 need(Array.isArray(rows)&&rows.length<=128,'calls');const ids=new Set(),bindings=new Set();for(const r of rows){need(r.id===ids.size+1&&!ids.has(r.id),'calls');ids.add(r.id);const c=r.control,v=c.verification,b=r.budget;need(c.mode==='bound-live'&&c.state==='closed'&&c.generation===2&&!c.lookupPresent&&c.readers===0&&c.bytesHeld===0&&c.reclaimed&&!c.pendingDispatch&&c.scratchReleased&&c.slotReleased&&c.metrics.reclaims===1&&c.metrics.byteReleases===1&&r.ownedTransportBytes===0,'cleanup');validateVf3Actual(r.actualControl,parentDeadline);need(v.mode===mode&&v.factHeld===false&&v.metadataBytes===4096&&n(v.logical)&&v.logical<=4096&&n(v.reused)&&v.logical===c.metrics.fullChecks+v.reused&&v.logical===Object.values(v.sites).reduce((x,y)=>x+y,0),'verification');need(mode==='full-verify'?v.reused===0:c.metrics.fullChecks<=13,'elision');for(const x of Object.values(v.sites))need(n(x),'verification');need(c.deadline===parentDeadline&&c.issuedPurpose==='read'&&c.metrics.liveChecks>=v.logical&&c.metrics.liveChecks<=v.logical+3,'live');validateVf3LiveCounts(c.metrics,deadlineRefusal&&c.metrics.publications===0);
  need(counters.every(k=>n(b[k]))&&b.work+b.initialization<=156978&&b.wire<=163840&&b.peakBytes<=1048576&&b.peakBytes>=262144&&b.heldBytes===0&&b.occupiedSlots===0&&b.memoryLimit===1048576&&b.workLimit===156978,'budget');if(r.binding.scopeBytes)need(b.peakBytes===r.binding.scopeBytes+131072+98304+8192-32768&&r.binding.sharedFrameWorkspace===32768&&r.binding.sessionBytes===131072,'memory');
  need([0,1].includes(c.metrics.publications)&&[0,1].includes(r.clientChecks)&&[0,1].includes(r.finalChecks),'publication');if(r.finalChecks===1){need(typeof r.callBinding==='string'&&/^[a-f0-9]{64}$/.test(r.callBinding)&&!bindings.has(r.callBinding),'receipt_call_binding');bindings.add(r.callBinding);}else need(r.callBinding===null,'receipt_call_binding');if(c.metrics.publications){need(c.metrics.challengeChecks===c.metrics.fullChecks+1&&c.metrics.channelChecks===c.metrics.fullChecks&&c.metrics.ownerChecks===c.metrics.fullChecks,'static_counts');need(r.clientChecks===1&&r.clientState==='accepted'&&r.finalChecks===1&&r.bytesAtFinal>0&&r.outcome===null&&r.actualControl.state==='validated'&&r.actualControl.outcomes===0,'publication');const e=r.events;need(e.indexOf('transport-final')<e.indexOf('client-verified')&&e.indexOf('client-verified')<e.indexOf('transport-released')&&e.includes('await-client-verification'),'client_receipt');for(const k of ['receive','general','begin','general-inspect','ready','finish'])need(v.sites[k]===1,'verification_phase');need(c.metrics.liveChecks===v.logical+3&&c.metrics.fullChecks===(mode==='full-verify'?v.logical:13),'verification_phase');const a=r.actualControl,p=a.phases;need(p.inspect===v.logical&&p['inspect-hash']===v.logical&&p['inspect-retained-live']===v.logical&&a.reads===v.logical+3&&a.checks===a.reads,'actual_phase');}else if(r.clientChecks===1)need(r.clientState==='refused'&&r.events.includes('client-verified')&&r.finalChecks===1&&r.actualControl.state==='validated','client_receipt');if(r.outcome!==null)need(['refused','unknown'].includes(r.outcome)&&c.metrics.publications===0&&r.actualControl.outcomes===1,'outcome');// The Link's initial inspect balances receive's pre-binding logical check. While
  // the provider is active each logical live gate reaches the actual Session once.
  // One predicate may stop before that inspect, or the Server may start its final
  // inspect before CLB finish. More than one unpaired invocation is impossible.
  if(witnessRequired&&!c.metrics.publications){const inspections=r.actualControl.phases.inspect??0;need(Math.abs(inspections-v.logical)<=1,'inspection_frontier');}
  sourceAccounting(r,parentDeadline,witnessRequired);
 }accounting(rows,witnessRequired);
}

export function validateVf3Row(row){
 const r=row,t=r?.timeline,ts=['start','observerReady','constructed','transferEnd','auditEnd','cleanupEnd','end'],ds=['observerSetupMs','constructionMs','transferMs','auditMs','cleanupMs','observerFinishMs'];
 need(VF3_ARMS.includes(r?.arm)&&VF3_OBSERVATIONS.includes(r.observation)&&['reader','authority-broker'].includes(r.role)&&VF3_WORKLOADS.some(w=>w.id===r.workload)&&[-1,0,1,2].includes(r.round),'identity');
 need(r.clock==='owned-monotonic'&&r.conditionsDigest===hash(VF3_CONDITIONS)&&ts.every(k=>finite(t?.[k]))&&ts.every((k,i)=>!i||t[k]>=t[ts[i-1]]),'timeline');
 need(ds.every((k,i)=>finite(r[k])&&near(r[k],t[ts[i+1]]-t[ts[i]]))&&finite(r.totalMs)&&near(r.totalMs,t.end-t.start)&&near(ds.reduce((s,k)=>s+r[k],0),r.totalMs),'partition');
 need(r.startedAt===Math.floor(t.start)&&r.deadline===r.startedAt+4500&&r.overDeadline===(Math.floor(t.end)>=r.deadline),'deadline');
 const x=r.expiration;need(x&&x.clockDomain==='node-performance-timeOrigin'&&x.rounding==='floor'&&finite(x.origin)&&n(x.observedNow)&&x.observedNow>=Math.floor(t.end)&&x.originalDeadline===r.deadline&&near(x.lowerBoundMs,r.deadline-t.start)&&x.reason===(r.failure?.reason??null)&&x.phase===(r.failure?.phase??null)&&typeof x.injected==='boolean','expiration');
 need(['complete','failed'].includes(r.status)&&r.cleaned===true,'status');validateCalls(r.calls,r.arm.endsWith('fact-live')?'fact-live':'full-verify',r.deadline,r.status==='failed'&&r.failure?.reason==='request_expired'&&r.failure.now>=r.deadline,true);
 const a=r.audit,cs=r.calls,metrics={};for(const c of cs)for(const [k,v]of Object.entries(c.control.metrics))metrics[k]=(metrics[k]??0)+v;
 const agg={calls:cs.length,held:cs.reduce((s,c)=>s+c.control.bytesHeld+c.budget.heldBytes,0),pending:cs.filter(c=>c.control.pendingDispatch).length,lookup:cs.filter(c=>c.control.lookupPresent).length,transportBytes:cs.reduce((s,c)=>s+c.ownedTransportBytes,0),finalChecks:cs.reduce((s,c)=>s+c.finalChecks,0),...metrics,elidedHashes:cs.reduce((s,c)=>s+c.binding.elidedHashes,0),logical:cs.reduce((s,c)=>s+c.control.verification.logical,0),reused:cs.reduce((s,c)=>s+c.control.verification.reused,0),clientChecks:cs.reduce((s,c)=>s+c.clientChecks,0)};
 for(const [k,v]of Object.entries(agg))need(a[k]===v,'audit_'+k);need(a.held===0&&a.pending===0&&a.lookup===0&&a.transportBytes===0&&a.unfinished===0,'cleanup');
 const limits={peakBytes:1048576,callWork:156978,callWire:163840,providerWork:1048576,providerWire:163840,clientWork:67108864};for(const [k,l]of Object.entries(limits))need(n(a[k])&&a[k]<=l,'budget');
 for(const [k,v]of Object.entries({peakBytes:Math.max(0,...cs.map(c=>c.budget.peakBytes)),callWork:Math.max(0,...cs.map(c=>c.budget.work+c.budget.initialization)),callWire:Math.max(0,...cs.map(c=>c.budget.wire)),providerWork:Math.max(0,...r.providerRows.map(c=>c.spent.work)),providerWire:Math.max(0,...r.providerRows.map(c=>c.spent.wire))}))need(a[k]===v,'budget_aggregate');
 const sourceRows=new Map();let sourcePrevious;for(const c of cs){const x=c.sourceAccounting;if(sourcePrevious)need(same(x.before,sourcePrevious),'source_chain');sourcePrevious=x.after;if(x.rowAfter)sourceRows.set(x.rowAfter.k,x.rowAfter);}if(sourcePrevious)need(same(sourcePrevious,r.providerMetrics),'source_aggregate');need(same([...sourceRows.values()].sort((a,b)=>a.k.localeCompare(b.k)),[...r.providerRows].sort((a,b)=>a.k.localeCompare(b.k))),'source_rows');if(r.providerMetrics)need(a.loads===r.providerMetrics.loads,'source_loads');
 const frames=r.frames;need(Array.isArray(frames)&&frames.length<=2048,'frames');for(const f of frames){need(n(f.frame)&&f.frame>0&&f.frame<=16384&&n(f.inner)&&f.inner<=8192,'frame_budget');need(f.ttl===null||(n(f.ttl)&&f.ttl>0&&f.ttl<=4500),'ttl');need(f.normalizedBytes===f.frame+f.inner+(f.ttl===null?0:4-String(f.ttl).length),'wire_normalization');}
 need(a.wireBytes===frames.reduce((s,f)=>s+f.frame+f.inner,0)&&a.wireBytes<=VF3_CONDITIONS.wire&&a.handshakes===frames.filter(f=>f.kind==='client-hello').length,'wire_total');
 const p=r.planTiming;need(p&&Array.isArray(p.windows)&&p.windows.length<=130&&['clientPlanMs','sealMs','providerPlanMs'].every(k=>finite(p[k])),'plan_timing');let previous=t.constructed;const sums={'client-initial':0,'client-seal':0,provider:0},completedSums={'client-initial':0,'client-seal':0};
 for(const [i,w]of p.windows.entries()){need(w.id===i+1&&w.actor===(i===0?'client-initial':i===1?'client-seal':'provider')&&typeof w.complete==='boolean'&&finite(w.start)&&finite(w.end)&&w.start>=previous&&w.end>=w.start&&w.end<=t.cleanupEnd,'plan_window');previous=w.end;sums[w.actor]+=w.end-w.start;if(w.complete&&w.actor!=='provider')completedSums[w.actor]+=w.end-w.start;need(w.complete||i===p.windows.length-1,'partial_plan');}
 const clientWindows=p.windows.filter(w=>w.actor!=='provider');need([0,156978,313956].includes(a.clientWork)&&a.clientWork>=156978*clientWindows.length,'client_prepayment');if(r.arm.startsWith('scalar'))need(a.clientWork===0,'client_prepayment');if(clientWindows.length===2||r.status==='complete'&&!r.arm.startsWith('scalar'))need(a.clientWork===313956,'client_prepayment');
 // Client fields accumulate completed windows; provider capture includes the final
 // unfinished window using the same single end timestamp as the window snapshot.
 need(near(p.clientPlanMs,completedSums['client-initial'])&&near(p.sealMs,completedSums['client-seal'])&&near(p.providerPlanMs,sums.provider),'plan_sum');
 if(r.observation==='quiet')need(r.trace===null,'quiet');else validateLb3Trace(r.trace,{...r,arm:r.arm.startsWith('scalar')?'scalar':'bound-live'});
 if(r.status==='complete'){
  need(r.failure===null&&!r.overDeadline&&a.verified&&r.result&&a.calls===r.result.requests+2&&a.publications===a.calls&&a.finalChecks===a.calls&&a.clientChecks===a.calls&&a.loads===a.calls,'complete');
  const result=r.result,v=result.timing;need(v&&finite(v.start)&&v.start>=t.constructed&&v.planned>=v.start&&v.reconstructionStarted>=v.planned&&v.end>=v.reconstructionStarted&&v.end<=t.transferEnd,'transfer_timeline');
  for(const k of ['wallMs','setupAndClientPlanMs','dispatchAndReconstructionMs','finalizationMs','clientPlanMs','sealMs','providerPlanMs'])need(finite(result[k]),'result_time');
  need(near(result.wallMs,v.end-v.start)&&near(result.setupAndClientPlanMs,v.planned-v.start)&&near(result.dispatchAndReconstructionMs,v.end-v.planned)&&near(result.finalizationMs,v.end-v.reconstructionStarted),'result_partition');
  need(near(result.clientPlanMs,p.clientPlanMs)&&near(result.sealMs,p.sealMs)&&near(result.providerPlanMs,p.providerPlanMs)&&near(p.clientPlanMs,sums['client-initial'])&&near(p.sealMs,sums['client-seal']),'result_plan');
  need(p.windows.every(w=>w.complete&&w.start>=v.start&&(w.actor==='provider'?w.start>=v.planned&&w.end<=v.reconstructionStarted:w.end<=v.planned)),'result_plan_window');
  need(result.clientPlanMs+result.sealMs<=result.setupAndClientPlanMs+1e-6&&result.providerPlanMs<=v.reconstructionStarted-v.planned+1e-6,'result_plan_bound');
  const inv=r.inventory;need(inv&&hash(inv.rows)===result.inputDigest&&hash(inv.rows.map(e=>e.sha256))===result.outputDigest&&result.outputDigest===a.expectedDigest&&inv.digest===result.inventoryDigest&&hash({domain:'c3b-source-inventory-v1',metadata:r.metadata,entries:inv.rows})===inv.digest&&inv.size===inv.rows.reduce((s,e)=>s+e.byteLength,0),'inventory');
  need(result.wireBytes===a.wireBytes&&frames.length===8*a.calls,'complete_wire');need(a.logical===a.fullChecks+a.reused,'verification_total');
  need(r.arm.startsWith('scalar')?p.windows.length===0:p.windows.length===2+result.requests,'plan_count');
 }else need(r.failure&&finite(r.failure.at)&&n(r.failure.now)&&finite(r.failure.clockEnd)&&r.failure.clockEnd>=r.failure.at&&r.failure.now>=Math.floor(r.failure.at)&&r.failure.now<=Math.floor(r.failure.clockEnd)&&r.failure.at>=t.start&&r.failure.at<=t.end&&['construction','transfer','audit','cleanup','deadline'].includes(r.failure.phase)&&typeof r.failure.reason==='string'&&r.failure.reason.length>0,'failure');
 return r;
}
const median=xs=>{if(!xs.length)return null;const s=[...xs].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
export function classifyVf3Control(r){
 if(r.status==='complete')return {kind:'complete',value:r.totalMs};
 const e=r.expiration;
 // A timeout label alone is insufficient. The same owned clock must reach the original floor;
 // retained calls may not have a shorter expiry, and injected/safety faults never count as censoring.
 const genuine=r.failure?.reason==='request_expired'&&r.overDeadline&&e?.observedNow>=r.deadline&&r.failure.now>=r.deadline&&e.originalDeadline===r.deadline&&!e.injected&&r.calls.every(c=>c.control.deadline===r.deadline&&c.actualControl.deadline>=r.deadline)&&['transfer','audit','deadline'].includes(r.failure.phase);
 return genuine?{kind:'original-deadline-censored',value:e.lowerBoundMs}:{kind:'invalid',value:null};
}
export function vf3Decision(rows){
 const candidate=rows.filter(r=>r.arm==='batch/fact-live');
 if(candidate.length!==9||candidate.some(r=>r.status!=='complete'))return {decision:'defer',comparisonKind:null};
 const controlsAll=rows.filter(r=>r.arm!=='batch/fact-live');if(controlsAll.length!==27||controlsAll.some(r=>classifyVf3Control(r).kind==='invalid'))return {decision:'defer',comparisonKind:null};let censored=controlsAll.some(r=>classifyVf3Control(r).kind==='original-deadline-censored');for(const arm of ['scalar/fact-live','batch/full-verify']){
  const controls=rows.filter(r=>r.arm===arm);if(controls.length!==9||controls.some(r=>classifyVf3Control(r).kind==='invalid'))return {decision:'defer',comparisonKind:null};
  const values=[],bs=[];for(let round=0;round<3;round++){
   const b=candidate.find(r=>r.round===round&&r.observation==='quiet'),c=controls.find(r=>r.round===round&&r.observation==='quiet');if(!b||!c)return {decision:'defer',comparisonKind:null};const cl=classifyVf3Control(c);censored ||= cl.kind==='original-deadline-censored';
   if(!(b.totalMs<cl.value)&&(cl.kind==='complete')||cl.kind==='original-deadline-censored'&&b.totalMs>.95*cl.value)return {decision:'defer',comparisonKind:null};bs.push(b.totalMs);values.push(cl.value);
  }
  if(median(bs)>.95*median(values))return {decision:'defer',comparisonKind:null};
  censored ||= controls.some(r=>classifyVf3Control(r).kind==='original-deadline-censored');
 }
 return {decision:'candidate-only',comparisonKind:censored?'deadline-censored-controls':'completed-controls'};
}
export function summarizeVf3(rows){
 need(Array.isArray(rows)&&rows.length===288,'matrix');const seen=new Set();for(const r of rows){validateVf3Row(r);need(r.expiration.injected===false,'injected_primary');const k=[r.workload,r.role,r.round,r.arm,r.observation].join('/');need(!seen.has(k),'duplicate');seen.add(k);}
 for(const w of VF3_WORKLOADS)for(const role of ['reader','authority-broker'])for(let round=-1;round<3;round++){
  const group=rows.filter(r=>r.workload===w.id&&r.role===role&&r.round===round);need(group.length===12,'cohort');for(const k of ['approvalPin','bindingPin','codePin','conditionsDigest'])need(new Set(group.map(r=>r[k])).size===1,'common_'+k);
  const complete=group.filter(r=>r.status==='complete');for(const k of ['inputDigest','outputDigest','inventoryDigest'])need(new Set(complete.map(r=>r.result[k])).size<=1,'common_'+k);
  for(const transfer of ['scalar','batch']){
   const pair=complete.filter(r=>r.arm.startsWith(transfer));for(const k of ['contextManifest'])need(new Set(pair.map(r=>r[k])).size<=1,'paired_'+k);
   for(const k of ['planDigest','requests','clientPlans','providerPlans'])need(new Set(pair.map(r=>r.result[k])).size<=1,'paired_'+k);
   need(new Set(pair.map(r=>r.frames.reduce((s,f)=>s+f.normalizedBytes,0))).size<=1,'paired_wire');
   for(const k of ['logical','liveChecks','purposeChecks','credentialChecks','publications','peakBytes','providerWork','clientWork'])need(new Set(pair.map(r=>r.audit[k])).size<=1,'paired_'+k);
   for(const arm of VF3_ARMS.filter(a=>a.startsWith(transfer))){const obs=pair.filter(r=>r.arm===arm&&r.observation!=='quiet');if(obs.length===2)need(same(obs[0].trace.entries,obs[1].trace.entries),'observer_parity');}
  }
 }
 const summary=[];for(const workload of VF3_WORKLOADS.map(w=>w.id))for(const role of ['reader','authority-broker']){
  const rs=rows.filter(r=>r.workload===workload&&r.role===role&&r.round>=0),arms={};for(const arm of VF3_ARMS){const a=rs.filter(r=>r.arm===arm),q=a.filter(r=>r.observation==='quiet'),all=q.every(r=>r.status==='complete');arms[arm]={attempted:a.length,completed:a.filter(r=>r.status==='complete').length,completionRate:a.filter(r=>r.status==='complete').length/a.length,quietMedianMs:all?median(q.map(r=>r.totalMs)):null,quietAttemptMedianMs:median(q.map(r=>r.totalMs)),classifications:a.map(r=>({round:r.round,observation:r.observation,...classifyVf3Control(r)})),overhead:Object.fromEntries([['counts','quiet'],['timed','counts'],['timed','quiet']].map(([a,b])=>[a+'-'+b,median([0,1,2].map(round=>rs.find(r=>r.arm===arm&&r.round===round&&r.observation===a).totalMs-rs.find(r=>r.arm===arm&&r.round===round&&r.observation===b).totalMs))]))};}
  summary.push({workload,role,arms,...vf3Decision(rs),productionAdopted:false});
 }
 return {attempted:288,measured:216,warmup:72,completed:rows.filter(r=>r.status==='complete').length,measuredCompleted:rows.filter(r=>r.round>=0&&r.status==='complete').length,summary,decision:summary.every(s=>s.decision==='candidate-only')?'candidate-only':'defer',productionAdopted:false};
}
export function validateVf3Measurement(m,sources){
 need(m?.schema==='cwc-vf3.measurement.v2'&&same(m.conditions,VF3_CONDITIONS)&&m.approvals?.length===24,'scope');const summary=summarizeVf3(m.rows);need(m.functional?.kind==='fixed-clock-functional-oracle'&&m.functional.performanceEvidence===false&&m.functional.rows?.length===24,'functional_oracle');const fs=new Set();for(const o of m.functional.rows){const k=[o.workload,o.role,o.transferMode,o.verificationMode].join('/');need(!fs.has(k),'oracle_duplicate');fs.add(k);validateCalls(o.calls,o.verificationMode,4500);const live=m.rows.filter(r=>r.workload===o.workload&&r.role===o.role&&r.arm===(o.transferMode==='S-scoped'?'scalar/':'batch/')+o.verificationMode);need(live.length===12,'oracle_closure');for(const r of live){for(const [i,c]of r.calls.entries()){if(!c.control.metrics.publications)continue;const expected=o.calls[i];need(expected&&c.api===expected.api&&same(c.control.verification.sites,expected.control.verification.sites)&&c.control.verification.logical===expected.control.verification.logical&&c.control.metrics.liveChecks===expected.control.metrics.liveChecks,'oracle_live');}if(r.status==='complete')for(const k of ['outputDigest','inputDigest','inventoryDigest','requests','clientPlans','providerPlans'])need(r.result[k]===o.result[k],'oracle_output');}}if(m.summary)need(same(summary,m.summary),'summary');const seen=new Set();
 for(const a of m.approvals){const k=[a.workload,a.role,a.round].join('/');need(!seen.has(k),'approval_duplicate');seen.add(k);for(const part of [a.record,a.record.vf1,a.record.transport,a.record.transport.connected,a.code]){
  const man=part.envelope.manifest;need((man.node??man.runtime?.node)===process.version,'approval_runtime');need(hash(part.registry)===part.pin&&(part.registry.manifestDigest??part.registry.approvedManifest)===hash(man),'approval_digest');const key=createPublicKey({key:Buffer.from(part.registry.operatorSpki,'base64'),type:'spki',format:'der'});need(verify(null,Buffer.from(canonical(man)),key,Buffer.from(part.envelope.signature,'base64')),'signature');for(const [p,h]of Object.entries(man.sources??man.sourceClosure))need(sources[p]===h,'source_'+p);
 }
 const transportPolicy={stage:'CLB-2-real-session',businessCallsPerChannel:1,maximumOperations:64,maximumUnfinished:1,memoryPerActiveCall:1048576,workPerOperation:156978,originalDeadline:4500,transportFinalBeforeReclaim:true,readApisOnly:true,externalStorage:false,performance:false},connectedPolicy={profile:'cwc.session-owned-call-binding.v1',stage:'CLB-1-connected',memory:1048576,initialization:156978,sessionBytes:131072,constructorBytes:131072,registryBytes:57344,callBytes:98304,bindingBytes:8192,frameWorkspace:32768,fullChannelAndOwnerVerification:true,elision:['owned-inner-comparison-hash','repeated-identity-copy-and-projection']},codePolicy={schema:'cwc-c.connection-policy.v1',workAccounting:'cpr.request-bytes-ranges-probes.v1',planWork:156978,memoryBytes:1048576,fragments:4096,sourceWireBytes:65536,metadataBytes:4096,codecWorkspace:393216};
 need(a.record.transport.envelope.manifest.policyDigest===hash(transportPolicy)&&a.record.transport.connected.envelope.manifest.policyDigest===hash(connectedPolicy)&&a.code.envelope.manifest.policyDigest===hash(codePolicy),'nested_policy');
 const realOwnerPolicy={profile:'cwc.session-private-verification-facts.monotonic.v1',stage:'VF-3-real-session-comparison',modes:['full-verify','fact-live'],memory:1048576,work:156978,callBytes:98304,bindingBytes:8192,metadataBytes:4096,maxChecks:4096,authorityOwners:1,fixedClock:false,actualSession:true};need(a.record.vf1.envelope.manifest.policyDigest===hash(realOwnerPolicy),'owner_clock_policy');
 const policy={profile:'cwc.session-private-verification-facts.transport.v1',stage:'VF-3-real-session',conditionsDigest:hash(VF3_CONDITIONS),variant:'combined',referenceOracle:false,transferModes:['S-scoped','B-independent'],fixedClock:false,authorityOwners:1,businessCallsPerChannel:1,modes:['full-verify','fact-live'],memory:1048576,work:156978,originalDeadline:4500,logicalGateLimit:4096,externalStorage:false,nativeIsolation:false,performanceComparison:true,productionAdopted:false};need(a.record.envelope.manifest.policyDigest===hash(policy),'policy');
 need(a.record.envelope.manifest.schema==='cwc-vf3.approval.v1'&&a.record.envelope.manifest.transportPin===a.record.transport.pin&&a.record.envelope.manifest.vf1Pin===a.record.vf1.pin,'approval_binding');
 const group=m.rows.filter(r=>[r.workload,r.role,r.round].join('/')===k);need(group.length===12&&group.every(r=>r.approvalPin===a.record.pin&&r.bindingPin===a.record.transport.pin&&r.codePin===a.code.pin),'approval_rows');
 }
 return summary;
}
export function vf3Table(summary){const fmt=x=>x===null?'—':x.toFixed(1);return ['| 条件 | role | scalar/full ms | scalar/fact ms | batch/full ms | batch/fact ms | 完了／試行（計測3 mode） | 判断 |','| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',...summary.summary.map(s=>'| '+[s.workload,s.role,...VF3_ARMS.map(a=>fmt(s.arms[a].quietMedianMs)),VF3_ARMS.map(a=>s.arms[a].completed+'/'+s.arms[a].attempted).join(' · '),s.decision].join(' | ')+' |')].join('\n');}
