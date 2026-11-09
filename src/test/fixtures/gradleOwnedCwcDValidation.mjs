const need=(ok,reason)=>{if(!ok)throw Error(reason);};
const arms=['scalar','reference','composed','bp-bridge'];
const median=(a         )=>{const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)] ;};
const finiteNonnegative=value=>Number.isFinite(value)&&value>=0;
// Millisecond differences use the same timestamp boundaries; allow only floating-point rounding.
const TIME_EPSILON=0.000001;
function validateTiming(r){
 const t=r.timing;
 need(t&&['start','planned','reconstructionStarted','end'].every(k=>finiteNonnegative(t[k]))&&
  ['wallMs','setupAndClientPlanMs','dispatchAndReconstructionMs','finalizationMs','clientPlanMs','sealMs','providerPlanMs'].every(k=>finiteNonnegative(r[k])),'cwc_d_timing');
 need(t.start<=t.planned&&t.planned<=t.reconstructionStarted&&t.reconstructionStarted<=t.end,'cwc_d_timing');
 const setup=t.planned-t.start,dispatch=t.end-t.planned,finalization=t.end-t.reconstructionStarted,providerInterval=t.reconstructionStarted-t.planned;
 need(Math.abs(r.wallMs-(t.end-t.start))<=TIME_EPSILON&&
  Math.abs(r.setupAndClientPlanMs-setup)<=TIME_EPSILON&&
  Math.abs(r.dispatchAndReconstructionMs-dispatch)<=TIME_EPSILON&&
  Math.abs(r.finalizationMs-finalization)<=TIME_EPSILON&&
  r.clientPlanMs+r.sealMs<=setup+TIME_EPSILON&&r.providerPlanMs<=providerInterval+TIME_EPSILON&&
  r.outerMs>=r.wallMs&&r.outerMs<4500,'cwc_d_timing');
}
export function validateCwcD(rows      ,rounds       ,workloads                  ){
 const groups=new Map              ();for(const r of rows){need(workloads.includes(r.workload)&&['reader','authority-broker'].includes(r.role)&&Number.isInteger(r.round)&&r.round>=-1&&r.round<rounds&&typeof r.observed==='boolean'&&arms.includes(r.arm)&&r.deadlineMs===4500&&r.memoryLimit===(r.arm==='bp-bridge'?null:1048576)&&r.referenceScratchBytes===(r.arm==='bp-bridge'?null:81920)&&Number.isFinite(r.outerMs)&&r.outerMs>=0&&Number.isFinite(r.assemblyMs)&&r.assemblyMs>=0,'cwc_d_row');
  const key=[r.workload,r.role,r.round,r.observed].join(':');const g=groups.get(key)??[];need(!g.some(x=>x.arm===r.arm),'cwc_d_duplicate');g.push(r);groups.set(key,g);
  need(['complete','failed'].includes(r.status),'cwc_d_status');if(r.status==='complete'){validateTiming(r);need(/^[a-f0-9]{64}$/.test(r.outputDigest),'cwc_d_timing');need(Array.isArray(r.traces)&&(!r.observed?r.traces.length===0:r.traces.length===(r.arm==='scalar'?0:r.requests+2)),'cwc_d_trace');if(r.observed&&r.arm!=='scalar'){need(r.traces[0].actor==='client-initial'&&r.traces[1].actor==='client-seal','cwc_d_trace_identity');const providers=r.traces.slice(2);need(providers.length===r.requests&&new Set(providers.map(t=>t.witness?.call)).size===r.requests&&new Set(providers.map(t=>t.witness?.requestDigest)).size===r.requests&&providers.every((t,i)=>t.actor==='provider'&&t.witness?.batchOrdinal===i&&Number.isInteger(t.witness.call)&&t.witness.call>0&&/^[a-f0-9]{64}$/.test(t.witness.requestDigest)),'cwc_d_trace_identity');need(r.traces.every((t,i)=>t.id===i+1&&t.planDigest===r.planDigest),'cwc_d_trace_identity');}for(const t of r.traces){need(finiteNonnegative(t.wallMs)&&finiteNonnegative(t.otherMs)&&Object.values(t.buckets).every(b=>finiteNonnegative(b.inclusiveMs)&&finiteNonnegative(b.exclusiveMs)),'cwc_d_trace');const exclusive=Object.values(t.buckets).reduce((n       ,b    )=>n+b.exclusiveMs,0);need(!t.failed&&Number.isFinite(t.wallMs)&&t.wallMs>=0&&t.otherMs>=-0.01&&Math.abs(exclusive+t.otherMs-t.wallMs)<=0.01,'cwc_d_trace');}if(r.observed){for(const actor of ['client-initial','client-seal','provider']){const total=r.traces.filter((t    )=>t.actor===actor).reduce((n       ,t    )=>n+t.wallMs,0),outer=actor==='client-initial'?r.clientPlanMs:actor==='client-seal'?r.sealMs:r.providerPlanMs;need(total<=outer+0.01,'cwc_d_trace_outer');}}if(r.arm==='reference')need(r.referenceOracleCalls===r.requests*(r.requests+2),'cwc_d_oracle');if(r.arm==='composed')need(r.referenceOracleCalls===0,'cwc_d_oracle');}
 }
 need(groups.size===workloads.length*2*(rounds+1)*2,'cwc_d_closure');
 for(const g of groups.values()){need(g.length===4,'cwc_d_closure');const primary=g.filter(x=>x.arm!=='bp-bridge');need(new Set(primary.map(x=>x.approvalPin)).size===1&&primary[0].approvalPin,'cwc_d_approval');const success=g.filter(x=>x.status==='complete');need(new Set(success.map(x=>x.outputDigest)).size<=1,'cwc_d_output');const batch=success.filter(x=>x.arm!=='scalar');need(new Set(batch.map(x=>x.planDigest)).size<=1&&new Set(batch.map(x=>x.wireBytes)).size<=1,'cwc_d_batch');}
 const summary=[];for(const workload of workloads)for(const role of ['reader','authority-broker']){
  const measured=rows.filter(r=>r.workload===workload&&r.role===role&&r.round>=0),quiet=measured.filter(r=>!r.observed),complete=(arm    )=>quiet.filter(r=>r.arm===arm&&r.status==='complete'),med=(arm    )=>complete(arm).length===rounds?median(complete(arm).map(r=>r.outerMs)):null;
  const scalar=med('scalar'),reference=med('reference'),composed=med('composed'),bridge=med('bp-bridge');const observer=arms.map(arm=>{const deltas=[];for(let round=0;round<rounds;round++){const pair=measured.filter(r=>r.arm===arm&&r.round===round);if(pair.every(r=>r.status==='complete'))deltas.push(pair.find(r=>r.observed).outerMs-pair.find(r=>!r.observed).outerMs);}return {arm,pairedSamples:deltas.length,medianDeltaMs:deltas.length?median(deltas):null};});
  const paired=([other,observed]              )=>{const deltas         =[],plans         =[],allowances         =[];let wins=0;for(let round=0;round<rounds;round++){const c=measured.find(r=>r.arm==='composed'&&r.round===round&&r.observed===observed),o=measured.find(r=>r.arm===other&&r.round===round&&r.observed===observed);if(c.status!=='complete'||o.status!=='complete')continue;const delta=o.outerMs-c.outerMs;deltas.push(delta);if(delta>0)wins++;if(observed){const plan=c.clientPlanMs+c.sealMs+c.providerPlanMs;plans.push(plan);allowances.push(o.outerMs-(c.outerMs-plan));}}return {other,observed,pairs:deltas.length,wins,medianDeltaMs:deltas.length?median(deltas):null,medianPlanMs:plans.length?median(plans):null,medianAllowanceMs:allowances.length?median(allowances):null};};
  const pairs=[paired(['scalar',false]),paired(['reference',false]),paired(['bp-bridge',false]),paired(['scalar',true])];
  const primaryComplete=measured.filter(r=>r.arm!=='bp-bridge'&&r.status==='complete').length,total=rounds*2*3;
  summary.push({workload,role,attempts:total,completed:primaryComplete,completionRate:primaryComplete/total,quietMedianMs:{scalar,reference,composed},bridgeMedianMs:bridge,observer,pairs,decision:primaryComplete===total&&scalar!==null&&reference!==null&&composed!==null&&composed<scalar&&composed<reference&&pairs[0] .wins===rounds&&pairs[1] .wins===rounds?'candidate-only':'defer',productionAdopted:false});
 }
 return summary;
}
