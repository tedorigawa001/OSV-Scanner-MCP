/** CLB-3 comparison contract. No inference of native isolation or production adoption. */
import {createHash,createPublicKey,verify} from 'node:crypto';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
export const LB3_CONDITIONS=Object.freeze({schema:'cwc-lb3.conditions.v2',deadlineMs:4500,memory:1048576,work:67108864,providerWork:1048576,wire:67108864,variant:'combined',businessCallsPerChannel:1,referenceOracle:false,planEvents:false,timingEvidence:'contained-plan-windows.v1',minimumImprovementPercent:5,measuredRounds:3});
export const LB3_ARMS=['scalar','full-reference','bound-live'];
export const LB3_OBSERVATIONS=['quiet','counts','timed'];
/** Includes roots loaded by fs by the nested approval factories, not just imports. */
export const LB3_APPROVAL_ROOTS=['src/test/fixtures/gradleOwnedCwcLb3.ts','src/test/fixtures/gradleOwnedCwcLb2Case.ts','src/test/fixtures/gradleOwnedCwcLb1Fixture.ts','src/test/fixtures/gradleOwnedCwcCCase.ts','package-lock.json','tsconfig.json','vitest.config.ts'];
export const LB3_WORKLOADS=[{id:'small',sizes:[600,800,900,1100,1300]},{id:'h0',sizes:[3061,1250,20810,5057,949,635,2072,6745,881]},{id:'single-large',sizes:[41456,1,1,1,1]}];
const fail=label=>{throw Error('lb3_'+label);},need=(b,l)=>{if(!b)fail(l);},same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0,near=(a,b)=>Math.abs(a-b)<=1e-6,median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;};
export function validateLb3Trace(t,row){
 need(t&&['counts','timed'].includes(t.mode)&&t.mode===row.observation,'trace_mode');need(finite(t.start)&&finite(t.end)&&t.start>=row.timeline.start&&t.end<=row.timeline.end&&near(t.wallMs,t.end-t.start),'trace_window');
 need(t.entries&&t.buckets&&same(Object.keys(t.entries).sort(),Object.keys(t.buckets).sort()),'trace_closure');let exclusive=0;
 const allowed=['construction','control.prepareChallenge','control.receive','control.connected','control.dispatchConnected','binding.providerGate','binding.scopeGate','link.request','link.dispatch.entry','link.reply.entry','scope.load','root.open','fact.encode','fact.prove','endpoint.openPeer','endpoint.gate','endpoint.now','endpoint.permitAPI','json.canonicalOwnedJson','json.ownedDigest','json.ownedSha256','json.structuredClone'];need(Object.keys(t.entries).every(k=>allowed.includes(k))&&t.entries.construction===1,'trace_sources');
 for(const [name,b]of Object.entries(t.buckets)){need(Number.isSafeInteger(b.calls)&&b.calls>0&&b.calls===t.entries[name],'trace_calls');need(finite(b.inclusiveMs)&&finite(b.exclusiveMs)&&b.exclusiveMs<=b.inclusiveMs+1e-6&&b.inclusiveMs<=t.wallMs+1e-6,'trace_cost');if(t.mode==='counts')need(b.inclusiveMs===0&&b.exclusiveMs===0,'counter_clock');exclusive+=b.exclusiveMs;}
 need(finite(t.otherMs)&&near(exclusive+t.otherMs,t.wallMs),'trace_partition');
 need(t.start<=row.timeline.observerReady&&t.end>=row.timeline.cleanupEnd,'trace_phase_window');
 need(t.buckets.construction?.inclusiveMs<=row.constructionMs+1e-6,'construction_cost');
 need(Array.isArray(t.handshakes)&&t.handshakes.length<=768,'handshake_capacity');let end=t.start;
 for(const [i,h]of t.handshakes.entries()){need(h.id===i+1&&h.kind===(i%3===0?'handshake.open':'handshake.exchange'),'handshake_closure');if(t.mode==='counts')need(h.start===0&&h.end===0,'handshake_clock');else{need(finite(h.start)&&finite(h.end)&&h.start>=end&&h.end>=h.start&&h.end<=t.end,'handshake_time');end=h.end;}}
 if(row.status==='complete'){
  const required=allowed.filter(k=>row.arm!=='scalar'||!['root.open','fact.encode','fact.prove'].includes(k));need(required.every(k=>t.entries[k]>0),'trace_required');
  need(t.handshakes.length===3*row.audit.calls,'handshake_count');
  for(const name of ['control.prepareChallenge','control.receive','control.connected','control.dispatchConnected','link.dispatch.entry','scope.load','endpoint.openPeer'])need(t.entries[name]===row.audit.calls,'trace_witness');
  for(const name of ['link.request','link.reply.entry'])need(t.entries[name]===4*row.audit.calls,'trace_witness');
 }
}
function planTiming(row){
 const p=row.planTiming,t=row.timeline;need(p?.schema==='cwc-lb3.plan-timing.v1'&&Array.isArray(p.windows)&&p.windows.length<=130,'plan_timing');
 const actors=['client-initial','client-seal','provider'],sums=[0,0,0];let end=t.constructed;
 for(const [i,w]of p.windows.entries()){
  const expected=i===0?'client-initial':i===1?'client-seal':'provider';need(w&&w.id===i+1&&w.actor===expected&&typeof w.complete==='boolean'&&finite(w.start)&&finite(w.end)&&w.start>=end&&w.end>=w.start&&w.end<=t.cleanupEnd,'plan_window');
  need(w.complete||i===p.windows.length-1,'plan_partial');if(w.complete||w.actor!=='provider')need(w.end<=t.transferEnd,'plan_phase');
  sums[actors.indexOf(w.actor)]+=w.end-w.start;end=w.end;
 }
 const fields=['clientPlanMs','sealMs','providerPlanMs'];for(const [i,k]of fields.entries())need(finite(p[k])&&near(p[k],sums[i]),'plan_sum');
 if(row.arm==='scalar')need(p.windows.length===0&&sums.every(n=>n===0),'scalar_plan');
 if(row.result){
  const r=row.result,x=r.timing;
  for(const k of ['wallMs','setupAndClientPlanMs','dispatchAndReconstructionMs','finalizationMs',...fields])need(finite(r[k]),'result_time');
  need(x&&['start','planned','reconstructionStarted','end'].every(k=>finite(x[k]))&&x.start>=t.constructed&&x.planned>=x.start&&x.reconstructionStarted>=x.planned&&x.end>=x.reconstructionStarted&&x.end<=t.transferEnd,'transfer_window');
  need(near(r.wallMs,x.end-x.start)&&near(r.setupAndClientPlanMs,x.planned-x.start)&&near(r.dispatchAndReconstructionMs,x.end-x.planned)&&near(r.finalizationMs,x.end-x.reconstructionStarted),'result_partition');
  for(const k of fields)need(near(r[k],p[k]),'result_plan_sum');
  for(const w of p.windows)need(w.complete&&w.start>=x.start&&(w.actor==='provider'?w.start>=x.planned&&w.end<=x.reconstructionStarted:w.end<=x.planned),'result_plan_window');
  need(r.clientPlanMs+r.sealMs<=r.setupAndClientPlanMs+1e-6&&r.providerPlanMs<=x.reconstructionStarted-x.planned+1e-6,'result_plan_bound');
  const client=p.windows.filter(w=>w.actor!=='provider'),provider=p.windows.filter(w=>w.actor==='provider');need(r.clientPlans===client.length&&r.providerPlans===provider.length,'plan_count');
  if(row.arm!=='scalar')need(client.length===2&&provider.length===r.requests,'plan_closure');
 }
}
export function validateLb3Row(row){
 need(row&&LB3_ARMS.includes(row.arm)&&LB3_OBSERVATIONS.includes(row.observation)&&['reader','authority-broker'].includes(row.role),'row_identity');
 need(['complete','failed'].includes(row.status)&&Number.isInteger(row.round)&&row.round>=-1,'row_status');need(row.conditionsDigest&&row.approvalPin&&row.bindingPin&&row.codePin,'row_approval');
 const names=['start','observerReady','constructed','transferEnd','auditEnd','cleanupEnd','end'],t=row.timeline;need(t&&names.every(n=>finite(t[n]))&&names.every((n,i)=>i===0||t[n]>=t[names[i-1]]),'timeline');
 const ds=['observerSetupMs','constructionMs','transferMs','auditMs','cleanupMs','observerFinishMs'];need(ds.every(k=>finite(row[k]))&&ds.every((k,i)=>near(row[k],t[names[i+1]]-t[names[i]]))&&finite(row.totalMs)&&near(row.totalMs,t.end-t.start)&&near(ds.reduce((s,k)=>s+row[k],0),row.totalMs),'total_partition');
 need(Number.isSafeInteger(row.startedAt)&&row.deadline===row.startedAt+LB3_CONDITIONS.deadlineMs,'original_deadline');if(row.clock==='real')need(row.startedAt===Math.floor(t.start)&&row.overDeadline===(Math.floor(t.end)>=row.deadline),'original_clock');
 need(row.cleaned===true&&row.audit&&row.audit.held===0&&row.audit.unfinished===0&&row.audit.pending===0&&row.audit.lookup===0&&row.audit.transportBytes===0,'cleanup');
 need(Object.values(row.audit).filter(x=>typeof x==='number').every(x=>Number.isSafeInteger(x)&&x>=0),'audit_numbers');
 const limits={peakBytes:LB3_CONDITIONS.memory,callWork:156978,callWire:163840,providerWork:LB3_CONDITIONS.providerWork,providerWire:163840,clientWork:LB3_CONDITIONS.work};
 for(const [k,limit]of Object.entries(limits))need(Number.isSafeInteger(row.audit[k])&&row.audit[k]>=0&&row.audit[k]<=limit,'budgets');
 planTiming(row);
 if(row.observation==='quiet')need(row.trace===null,'quiet_trace');else validateLb3Trace(row.trace,row);
 if(row.status==='complete'){
  need(row.failure===null&&!row.overDeadline&&row.result&&row.audit.verified&&row.audit.calls===row.result.requests+2&&row.audit.publications===row.audit.calls&&row.audit.finalChecks===row.audit.calls,'complete');
  need(row.audit.handshakes===row.audit.calls&&row.audit.loads===row.audit.calls&&row.result.outputDigest===row.audit.expectedDigest&&row.result.wireBytes===row.audit.wireBytes,'complete_content');
  need(row.audit.challengeChecks===row.audit.fullChecks+row.audit.calls&&row.audit.channelChecks===row.audit.fullChecks&&row.audit.ownerChecks===row.audit.fullChecks,'security_checks');
  need(row.audit.fullChecks+2*row.audit.calls-row.audit.wireIdentityHashes===row.audit.elidedHashes,'hash_elision');need(row.arm==='bound-live'?row.audit.elidedHashes>0:row.audit.elidedHashes===0,'arm_elision');
 }else need(row.failure&&typeof row.failure.reason==='string'&&row.failure.reason.length>0&&['construction','transfer','audit','cleanup','deadline'].includes(row.failure.phase),'failure');
 return row;
}
export function summarizeLb3(rows,rounds,workloads,clock){
 need(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=3&&['real','fixed'].includes(clock),'matrix');need(rows.length===workloads.length*2*(rounds+1)*9,'matrix_size');const seen=new Set(),groups=new Map();
 for(const r of rows){validateLb3Row(r);need(r.conditionsDigest===hash(LB3_CONDITIONS)&&workloads.includes(r.workload)&&r.clock===clock&&r.round<rounds,'matrix_row');const key=[r.workload,r.role,r.round,r.observation,r.arm].join('/');need(!seen.has(key),'matrix_duplicate');seen.add(key);const g=[r.workload,r.role,r.round].join('/'),a=groups.get(g)??[];a.push(r);groups.set(g,a);}
 for(const group of groups.values()){
  need(group.length===9,'group_size');for(const key of ['approvalPin','bindingPin','codePin','conditionsDigest','contextManifest']){const values=group.map(r=>r[key]).filter(x=>x!==null);need(new Set(values).size===1||(key==='contextManifest'&&values.length===0&&group.every(r=>r.failure?.phase==='construction')),'common_'+key);}
  for(const observation of LB3_OBSERVATIONS){const pair=group.filter(r=>r.observation===observation&&r.arm!=='scalar');if(pair.every(r=>r.status==='complete')){for(const k of ['outputDigest','inputDigest','inventoryDigest','planDigest','requests','wireBytes','clientPlans','providerPlans'])need(same(pair[0].result[k],pair[1].result[k]),'paired_'+k);for(const k of ['fullChecks','channelChecks','ownerChecks','liveChecks','purposeChecks','credentialChecks','publications'])need(pair[0].audit[k]===pair[1].audit[k],'paired_'+k);}}
  const complete=group.filter(r=>r.status==='complete');if(complete.length)for(const k of ['outputDigest','inputDigest','inventoryDigest'])need(new Set(complete.map(r=>r.result[k])).size===1,'common_'+k);
  for(const arm of LB3_ARMS){const pair=group.filter(r=>r.arm===arm&&r.observation!=='quiet');if(pair.every(r=>r.status==='complete')){need(same(pair[0].trace.entries,pair[1].trace.entries),'observer_count_parity');need(same(pair[0].audit,pair[1].audit),'observer_audit_parity');}}
 }
 const summary=[];for(const workload of workloads)for(const role of ['reader','authority-broker']){
  const measured=rows.filter(r=>r.workload===workload&&r.role===role&&r.round>=0),arms=Object.fromEntries(LB3_ARMS.map(arm=>{const rs=measured.filter(r=>r.arm===arm),quiet=rs.filter(r=>r.observation==='quiet'),complete=quiet.filter(r=>r.status==='complete');return [arm,{completed:rs.filter(r=>r.status==='complete').length,attempted:rs.length,completionRate:rs.filter(r=>r.status==='complete').length/rs.length,quietMedianMs:median(complete.map(r=>r.totalMs)),quietAttemptMedianMs:median(quiet.map(r=>r.totalMs)),failures:rs.filter(r=>r.status==='failed').map(r=>({observation:r.observation,round:r.round,reason:r.failure.reason,overDeadline:r.overDeadline})),observationDeltaMs:Object.fromEntries([['counts','quiet'],['timed','counts'],['timed','quiet']].map(([a,b])=>[a+'-'+b,median(Array.from({length:rounds},(_,i)=>rs.find(r=>r.round===i&&r.observation===a).totalMs-rs.find(r=>r.round===i&&r.observation===b).totalMs))]))}];}));
  const wins=Array.from({length:rounds},(_,round)=>{const q=measured.filter(r=>r.round===round&&r.observation==='quiet'),bound=q.find(r=>r.arm==='bound-live');return q.every(r=>r.status==='complete')&&q.filter(r=>r.arm!=='bound-live').every(r=>bound.totalMs<r.totalMs);}).filter(Boolean).length;
  const candidate=clock==='real'&&rounds===3&&measured.every(r=>r.status==='complete')&&wins===rounds&&['scalar','full-reference'].every(a=>arms['bound-live'].quietMedianMs<=arms[a].quietMedianMs*(1-LB3_CONDITIONS.minimumImprovementPercent/100));summary.push({workload,role,arms,pairedQuietWins:wins,decision:candidate?'candidate-only':'defer',productionAdopted:false});
 }
 return {conditions:LB3_CONDITIONS,attempted:rows.filter(r=>r.round>=0).length,completed:rows.filter(r=>r.round>=0&&r.status==='complete').length,summary,decision:summary.every(r=>r.decision==='candidate-only')?'candidate-only':'defer',productionAdopted:false};
}
export function validateLb3Measurement(m,sources){
 need(m?.schema==='cwc-lb3.measurement.v2'&&m.clock==='real'&&m.rounds===3&&same(m.workloads,LB3_WORKLOADS),'measurement_scope');
 const summary=summarizeLb3(m.rows,m.rounds,m.workloads.map(w=>w.id),m.clock);need(same(m.summary,summary),'summary');need(m.approvals.length===24,'approval_closure');const seen=new Set();
 for(const a of m.approvals){const group=[a.workload,a.role,a.round].join('/');need(!seen.has(group),'approval_duplicate');seen.add(group);const rs=m.rows.filter(r=>[r.workload,r.role,r.round].join('/')===group);need(rs.length===9,'approval_group');
  for(const part of [a.record.comparison,a.record.binding,a.record.binding.connected,a.record.code]){
   const manifest=part.envelope.manifest,registry=part.registry;need(hash(registry)===part.pin&&(registry.manifestDigest??registry.approvedManifest)===hash(manifest),'approval_digest');
   const key=createPublicKey({key:Buffer.from(registry.operatorSpki,'base64'),type:'spki',format:'der'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(manifest)),key,Buffer.from(part.envelope.signature,'base64')),'approval_signature');
   const closure=manifest.sources??manifest.sourceClosure;need(closure&&Object.keys(closure).length>20,'approval_sources');for(const [p,h]of Object.entries(closure))need(sources[p]===h,'approval_source_'+p);
   for(const [p]of Object.entries(closure)){if(!p.startsWith('src/'))continue;need(Object.hasOwn(sources,p),'approval_source_missing');}
  }
  const comparison=a.record.comparison,binding=a.record.binding,code=a.record.code,manifest=comparison.envelope.manifest;
  need(manifest.schema==='cwc-lb3.approval.v1'&&manifest.conditionsDigest===hash(LB3_CONDITIONS)&&manifest.bindingPin===binding.pin&&manifest.codePin===code.pin&&binding.envelope.manifest.connectedPin===binding.connected.pin,'approval_binding');
  for(const root of ['gradleOwnedCwcLb3.ts','gradleOwnedCwcLb3Case.ts','gradleOwnedCwcLb3Profile.ts','gradleOwnedCwcLb3Approval.ts','gradleOwnedCwcLb3Validation.mjs','gradleOwnedCwcLb2Link.ts','gradleOwnedCwcLb1Fixture.ts','gradleOwnedCprBSession.ts'])need(Object.hasOwn(manifest.sources,'src/test/fixtures/'+root),'approval_roots');
  need(rs.every(r=>r.approvalPin===comparison.pin&&r.bindingPin===binding.pin&&r.codePin===code.pin),'approval_row');
 }
 return summary;
}
export function lb3Table(m){
 const fmt=n=>n===null?'—':n.toFixed(1),s=m.summary;
 return ['| 条件 | role | scalar総時間 ms | full-reference ms | bound-live ms | 完了／試行（全計測mode） | 判断 |','| --- | --- | ---: | ---: | ---: | --- | --- |',...s.summary.map(r=>`| ${r.workload} | ${r.role} | ${fmt(r.arms.scalar.quietMedianMs)} | ${fmt(r.arms['full-reference'].quietMedianMs)} | ${fmt(r.arms['bound-live'].quietMedianMs)} | ${LB3_ARMS.map(a=>r.arms[a].completed+'/'+r.arms[a].attempted).join(' · ')} | ${r.decision} |`)].join('\n');
}
