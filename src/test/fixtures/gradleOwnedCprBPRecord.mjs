import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
const sha=b=>createHash('sha256').update(b).digest('hex'),need=(v,k)=>{if(!v)throw Error('cpr_bp_'+k);};
const workloads={default:[600,700,1600,2000,3000],small:[100,200,300,400,500,600,700,800,900],h0Sizes:[3061,1250,20810,5057,949,635,2072,6745,881],singleLarge:[41456,1,1,1,1]};
const variants=['reference','max-first','single-check','combined'];
const canon=v=>JSON.stringify(v,(_,o)=>o&&typeof o==='object'&&!Array.isArray(o)?Object.fromEntries(Object.entries(o).sort(([a],[b])=>a.localeCompare(b))):o);
const digest=v=>sha(canon(v)),median=xs=>{const v=[...xs].sort((a,b)=>a-b);return(v[Math.floor((v.length-1)/2)]+v[Math.ceil((v.length-1)/2)])/2;};
export async function cprBPSources(){const seen=new Map();async function visit(f){f=path.relative(process.cwd(),path.resolve(f)).split(path.sep).join('/');if(seen.has(f))return;need(!f.startsWith('../'),'path');const b=await readFile(f);seen.set(f,sha(b));if(!/\.(ts|mjs)$/.test(f))return;for(const m of b.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){let p=path.resolve(path.dirname(f),m[1]);if(p.endsWith('.js'))p=p.slice(0,-3)+'.ts';await visit(p);}}for(const f of ['src/test/utils/gradleOwnedCprBPBenchmark.test.ts','package.json','package-lock.json','tsconfig.json','vitest.config.ts'])await visit(f);return Object.fromEntries([...seen].sort(([a],[b])=>a.localeCompare(b)));}
export function primaryOrder(n){const a=['scalar','reference','combined'],o=[...a.slice(n%3),...a.slice(0,n%3)];return n>=3?o.reverse():o;}
function timing(v){const t=v?.timing;need(t&&['start','planned','reconstructionStarted','end'].every(k=>Number.isFinite(t[k]))&&t.start<=t.planned&&t.planned<=t.reconstructionStarted&&t.reconstructionStarted<=t.end,'time_boundary');for(const [k,n]of Object.entries({wallMs:t.end-t.start,setupAndClientPlanMs:t.planned-t.start,dispatchAndReconstructionMs:t.end-t.planned,finalizationMs:t.end-t.reconstructionStarted}))need(Number.isFinite(v[k])&&Math.abs(v[k]-n)<0.01,'time_accounting');}
function arm(a,workload,temperature,kind){
 need(a?.status==='complete','failed_arm');const r=a.result,m=a.metrics,scalar=kind==='scalar',sizes=workloads[workload];timing(r);
 need(r.mode===(scalar?'S-scoped':'B-independent')&&r.outputDigest===digest(sizes.map((n,i)=>sha(Buffer.alloc(n,65+i)))),'output');
 need(Number.isInteger(r.requests)&&r.requests>0&&r.clientPlans===(scalar?0:2)&&r.providerPlans===(scalar?0:r.requests)&&a.plans.length===r.providerPlans,'plans');
 need(['calls','pre','post','loads','replies'].every(k=>m[k]===r.requests+2)&&m.plans===r.providerPlans&&m.validatedBytes===m.loads*sizes.reduce((n,x)=>n+x,0),'fresh');
 need(a.frames.every(f=>Number.isInteger(f.frame)&&f.frame>0&&f.frame<=16384&&Number.isInteger(f.inner)&&f.inner>=0&&f.inner<=8192)&&r.wireBytes===a.frames.reduce((n,f)=>n+f.frame+f.inner,0)&&r.wireBytes<=67108864,'wire');
 const fs=a.frames.filter(f=>!['client-hello','server-hello','client-proof','ready'].includes(f.kind));need(fs.length===4*m.calls&&a.clientRows.length===m.calls&&a.providerRows.length===m.calls,'events');
 for(const [i,row]of a.clientRows.entries()){
  const messages=fs.slice(4*i,4*i+4),p=a.providerRows[i];
  need(canon(messages.map(f=>[f.direction,f.kind]))===canon([['request','challenge-request'],['reply','challenge'],['request','channel'],['reply','channel']])&&messages.every(f=>f.operation===row.k),'event_identity');
  need(row.state==='complete'&&row.attempts===1&&row.deadline===a.deadline&&row.wire===messages.reduce((n,f)=>n+f.frame+f.inner,0)&&row.wire<=163840,'client_row');
  need(p.k===row.k&&p.state==='complete'&&p.attempts===1&&p.deadline<=a.deadline&&p.spent.wire===messages.reduce((n,f)=>n+f.inner,0)&&p.spent.work===(scalar||i<2?65537:222515),'provider_row');
 }
 need(a.frames.filter(f=>['client-hello','client-proof'].includes(f.kind)).length===(temperature==='cold'?2:0),'temperature');
 need(a.plans.every((p,i)=>p.call===i+3&&p.commands===r.requests&&p.inputDigest===r.inputDigest&&p.planDigest===r.planDigest&&p.inventoryDigest===r.inventoryDigest&&p.work<=156978&&p.ms>=0)&&Math.abs(a.plans.reduce((n,p)=>n+p.ms,0)-r.providerPlanMs)<0.01,'provider_plan');
 need([r.clientPlanMs,r.sealMs,r.providerPlanMs].every(n=>Number.isFinite(n)&&n>=0)&&r.clientPlanMs+r.sealMs+r.providerPlanMs<=r.wallMs+0.01,'plan_time');
 return r;
}
export function analyzeCprBP(raw){
 need(raw.schema==='cpr-bp.native.v1'&&raw.sourceSnapshotStable===true&&raw.blocks?.length===96&&raw.warmups?.length===64&&raw.diagnostics?.length===32,'header');
 need(canon(raw.scope)===canon({inProcess:true,signedSessionRuntime:true,mockStorage:true,mockPin:true,independentPlans:true,realStorageVerified:false,nativeIsolationVerified:false,productionAdopted:false,eightReadsEstablished:false,originalReadsSkipped:0,readCommittedReduction:0}),'scope');
 const seen=new Set(),warm=new Set(),groups=new Map();
 for(const w of raw.warmups){const key=[w.workload,w.role,w.temperature,w.variant].join('/');need(!warm.has(key),'warmup_duplicate');warm.add(key);arm(w.arm,w.workload,w.temperature,w.variant==='scalar'?'scalar':'reference');}
 for(const b of raw.blocks){const key=[b.workload,b.role,b.temperature,b.repetition].join('/');need(workloads[b.workload]&&['reader','authority-broker'].includes(b.role)&&['cold','warm'].includes(b.temperature)&&Number.isInteger(b.repetition)&&b.repetition>=0&&b.repetition<6&&!seen.has(key),'identity');seen.add(key);need(canon(b.order)===canon(primaryOrder(b.repetition)),'order');
  for(const variant of ['scalar','reference','combined','original'])need(warm.has([b.workload,b.role,b.temperature,variant].join('/')),'warmup_closure');
  const s=arm(b.arms.scalar,b.workload,b.temperature,'scalar'),r=arm(b.arms.reference,b.workload,b.temperature,'reference'),c=arm(b.arms.combined,b.workload,b.temperature,'combined'),o=arm(b.original,b.workload,b.temperature,'reference');
  need([r,c,o].every(x=>x.planDigest===r.planDigest&&x.inventoryDigest===r.inventoryDigest&&x.inputDigest===r.inputDigest&&x.requests===r.requests&&x.wireBytes===r.wireBytes)&&s.inventoryDigest===r.inventoryDigest,'same_semantics');
  need(b.originalPosition===(b.repetition%2?'before':'after'),'bridge_order');
  const gkey=[b.workload,b.role,b.temperature].join('/'),g=groups.get(gkey)??[];g.push({scalar:s.wallMs,reference:r.wallMs,combined:c.wallMs,plan:c.clientPlanMs+c.sealMs+c.providerPlanMs,headroom:s.wallMs-(c.wallMs-c.clientPlanMs-c.sealMs-c.providerPlanMs),bridge:r.wallMs-o.wallMs});groups.set(gkey,g);
 }
 const diagSeen=new Set();for(const d of raw.diagnostics){const key=[d.workload,d.role,d.variant].join('/');need(!diagSeen.has(key)&&workloads[d.workload]&&['reader','authority-broker'].includes(d.role)&&variants.includes(d.variant),'diagnostic_identity');diagSeen.add(key);
  need(d.quietPosition===(variants.indexOf(d.variant)%2?'before':'after'),'diagnostic_order');
  const a=arm(d.observed,d.workload,'warm',d.variant),q=arm(d.quiet,d.workload,'warm',d.variant);need(a.planDigest===q.planDigest&&a.outputDigest===q.outputDigest&&a.requests===q.requests&&a.wireBytes===q.wireBytes,'diagnostic_bridge');
  need(d.traces.length===a.requests+2&&canon(d.traces.map(t=>t.actor))===canon(['client-initial','client-seal',...Array(a.requests).fill('provider')]),'trace_closure');
  for(const [i,t]of d.traces.entries()){
   if(i>=2){const p=d.observed.plans[i-2];need(t.witness&&t.witness.call===p.call&&t.witness.requestDigest===p.requestDigest&&t.witness.batchOrdinal===p.batchOrdinal&&p.batchOrdinal===i-2,'trace_binding');}else need(t.witness===undefined,'trace_binding');
   // A partition can be self-consistent yet exceed the independently timed
   // enclosing pack. Match the exact actor/call, never the whole transfer.
   const enclosingMs=i===0?a.clientPlanMs:i===1?a.sealMs:d.observed.plans[i-2].ms;
   need(Number.isFinite(t.wallMs)&&Number.isFinite(enclosingMs)&&t.wallMs<=enclosingMs+0.01,'trace_enclosing_time');
   need(t.id===i+1&&t.variant===d.variant&&t.failed===false&&t.commands===a.requests&&t.planDigest===a.planDigest&&t.wallMs>0&&t.otherMs>=-0.001,'trace');
   const keys=Object.keys(t.buckets);need(keys.length===7&&['command','codec','gate','schema','hash.digest','hash.bytes','codec.json'].every(k=>keys.includes(k)),'buckets');
   for(const v of Object.values(t.buckets))need(Number.isInteger(v.calls)&&v.calls>0&&Number.isFinite(v.inclusiveMs)&&Number.isFinite(v.exclusiveMs)&&v.exclusiveMs>=-0.001&&v.inclusiveMs>=v.exclusiveMs-0.001,'bucket');
   need(t.buckets.command.calls===t.commands&&t.buckets.codec.calls===t.commands+1&&Math.abs(t.wallMs-t.otherMs-Object.values(t.buckets).reduce((n,v)=>n+v.exclusiveMs,0))<0.01,'partition');
  }
 }
 for(const workload of Object.keys(workloads))for(const role of ['reader','authority-broker']){
  const variantsByName=Object.fromEntries(raw.diagnostics.filter(d=>d.workload===workload&&d.role===role).map(d=>[d.variant,d]));
  const ref=variantsByName.reference;
  for(let i=0;i<ref.traces.length;i++){
   const a=ref.traces[i],b=variantsByName['single-check'].traces[i],m=variantsByName['max-first'].traces[i],c=variantsByName.combined.traces[i];
   need([b,m,c].every(t=>t.commands===a.commands&&t.planDigest===a.planDigest),'variant_semantics');
   need(a.buckets.schema.calls-b.buckets.schema.calls===a.commands&&a.buckets['hash.digest'].calls-b.buckets['hash.digest'].calls===a.commands&&a.buckets.gate.calls===b.buckets.gate.calls,'duplicate_reduction');
   need(c.buckets.schema.calls===b.buckets.schema.calls&&c.buckets['hash.digest'].calls===b.buckets['hash.digest'].calls&&c.buckets.gate.calls===m.buckets.gate.calls&&m.buckets.gate.calls<a.buckets.gate.calls,'max_reduction');
   need([b,m,c].every(t=>t.buckets.codec.calls===a.buckets.codec.calls&&t.buckets.command.calls===a.buckets.command.calls),'final_checks');
   need(a.buckets['hash.bytes'].calls-m.buckets['hash.bytes'].calls===(a.actor==='provider'?a.buckets.gate.calls-m.buckets.gate.calls:0),'gate_binding_hashes');
  }
 }
 need(groups.size===16&&[...groups.values()].every(g=>g.length===6),'condition_closure');
 const comparisons=[...groups].map(([condition,g])=>({condition,scalarMs:median(g.map(x=>x.scalar)),referenceMs:median(g.map(x=>x.reference)),combinedMs:median(g.map(x=>x.combined)),planMs:median(g.map(x=>x.plan)),headroomMs:median(g.map(x=>x.headroom)),bridgeDeltaMs:median(g.map(x=>x.bridge)),combinedBeatsScalar:g.filter(x=>x.combined<x.scalar).length,combinedBeatsReference:g.filter(x=>x.combined<x.reference).length,proceedToCprC:median(g.map(x=>x.combined))<median(g.map(x=>x.scalar))&&median(g.map(x=>x.plan))<=median(g.map(x=>x.headroom))}));
 const profiles=raw.diagnostics.map(d=>({workload:d.workload,role:d.role,variant:d.variant,observedWallMs:d.observed.result.wallMs,quietWallMs:d.quiet.result.wallMs,plans:d.traces.length,providerPlans:d.traces.filter(x=>x.actor==='provider').length,exclusiveMs:Object.fromEntries(['command','codec','gate','schema','hash.digest','hash.bytes','codec.json'].map(k=>[k,d.traces.filter(t=>t.actor==='provider').reduce((n,t)=>n+t.buckets[k].exclusiveMs,0)])),calls:Object.fromEntries(['command','codec','gate','schema','hash.digest','hash.bytes','codec.json'].map(k=>[k,d.traces.filter(t=>t.actor==='provider').reduce((n,t)=>n+t.buckets[k].calls,0)]))}));
 return {blocks:96,primaryTransfers:288,originalBridgeTransfers:96,diagnosticTransfers:64,warmups:64,comparisons,profiles,proceedToCprC:comparisons.every(c=>c.proceedToCprC),productionAdopted:false,realStorageVerified:false};
}
