import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';
const sha=b=>createHash('sha256').update(b).digest('hex'),need=(v,k)=>{if(!v)throw Error('cpr_b_record_'+k);};
const workloads={default:[600,700,1600,2000,3000],small:[100,200,300,400,500,600,700,800,900],h0Sizes:[3061,1250,20810,5057,949,635,2072,6745,881],singleLarge:[41456,1,1,1,1]},canon=v=>JSON.stringify(v,(_,o)=>o&&typeof o==='object'&&!Array.isArray(o)?Object.fromEntries(Object.entries(o).sort(([a],[b])=>a.localeCompare(b))):o),digest=v=>sha(canon(v));
export async function cprBSources(){const seen=new Map();async function visit(f){f=path.relative(process.cwd(),path.resolve(f)).split(path.sep).join('/');if(seen.has(f))return;need(!f.startsWith('../'),'path');const b=await readFile(f);seen.set(f,sha(b));if(!/\.(ts|mjs)$/.test(f))return;for(const m of b.toString().matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){let p=path.resolve(path.dirname(f),m[1]);if(p.endsWith('.js'))p=p.slice(0,-3)+'.ts';await visit(p);}}for(const f of ['src/test/utils/gradleOwnedCprBBenchmark.test.ts','package.json','package-lock.json','tsconfig.json','vitest.config.ts'])await visit(f);return Object.fromEntries([...seen].sort(([a],[b])=>a.localeCompare(b)));}
const median=xs=>{const v=[...xs].sort((a,b)=>a-b);return(v[Math.floor((v.length-1)/2)]+v[Math.ceil((v.length-1)/2)])/2;};
function checkTiming(v){
 const t=v?.timing;need(t&&['start','planned','reconstructionStarted','end'].every(k=>Number.isFinite(t[k]))&&t.start<=t.planned&&t.planned<=t.reconstructionStarted&&t.reconstructionStarted<=t.end,'timing_boundaries');
 need(Number.isFinite(v.finalizationMs)&&Math.abs(v.wallMs-(t.end-t.start))<0.01&&Math.abs(v.setupAndClientPlanMs-(t.planned-t.start))<0.01&&Math.abs(v.dispatchAndReconstructionMs-(t.end-t.planned))<0.01&&Math.abs(v.finalizationMs-(t.end-t.reconstructionStarted))<0.01,'timing_accounting');
}
export function analyzeCprB(r){
 need(r.sourceSnapshotStable===true,'source_changed');
 need(r.warmups?.length===32&&r.warmups.every(w=>w.arm.status==='complete'),'warmups');
 r.warmups.forEach(w=>checkTiming(w.arm.result));
 const warms=new Set(r.warmups.map(w=>[w.workload,w.role,w.temperature,w.mode].join('/')));need(warms.size===32,'warmup_identity');
 need(r.schema==='cpr-b.native-record.v1'&&r.repetitions===6&&r.pairs?.length===96,'header');
 need(canon(r.scope)===canon({signedSessionRuntime:true,inProcess:true,mockStorage:true,mockLivePin:true,independentAuthority:true,nativeIsolationVerified:false,realStorageVerified:false,productionAdopted:false,eightReadsEstablished:false,originalReadsSkipped:0,readCommittedReduction:0}),'scope');
 const seen=new Set(),groups=new Map();
 for(const p of r.pairs){const key=[p.workload,p.role,p.temperature,p.repetition].join('/');need(!seen.has(key)&&workloads[p.workload]&&['reader','authority-broker'].includes(p.role)&&['cold','warm'].includes(p.temperature)&&Number.isInteger(p.repetition)&&p.repetition>=0&&p.repetition<6,'identity');seen.add(key);
 need(canon(p.order)===canon(p.repetition%2?['B-independent','S-scoped']:['S-scoped','B-independent']),'order');
 const output=digest(workloads[p.workload].map((n,i)=>sha(Buffer.alloc(n,65+i))));
 for(const mode of ['S-scoped','B-independent']){const a=p.arms[mode];need(a?.status==='complete','failed_arm');const v=a.result,m=a.metrics;checkTiming(v);need(warms.has([p.workload,p.role,p.temperature,mode].join('/')),'warmup_identity');
 need(v.mode===mode&&v.outputDigest===output&&Number.isFinite(v.wallMs)&&v.wallMs>0&&Math.abs(v.wallMs-v.setupAndClientPlanMs-v.dispatchAndReconstructionMs)<0.01,'time_output');
 need([v.clientPlanMs,v.sealMs,v.providerPlanMs].every(x=>Number.isFinite(x)&&x>=0)&&v.clientPlanMs+v.sealMs+v.providerPlanMs<=v.wallMs+0.01,'plan_time');
 need(v.clientPlans===(mode==='B-independent'?2:0)&&v.providerPlans===(mode==='B-independent'?v.requests:0)&&a.plans.length===v.providerPlans,'plans');
 need(m.calls===v.requests+2&&m.loads===m.calls&&m.pre===m.calls&&m.post===m.calls&&m.replies===m.calls&&m.plans===v.providerPlans,'fresh');
 need(m.validatedBytes===workloads[p.workload].reduce((a,b)=>a+b,0)*m.calls,'all_bytes');
 need(a.frames.length>0&&a.frames.every(f=>Number.isInteger(f.frame)&&f.frame>0&&f.frame<=16384&&Number.isInteger(f.inner)&&f.inner>=0&&f.inner<=8192)&&v.wireBytes===a.frames.reduce((n,f)=>n+f.frame+f.inner,0)&&v.wireBytes<=67108864,'wire');
 const requests=a.frames.filter(f=>f.direction==='request'&&f.kind==='channel'),replies=a.frames.filter(f=>f.direction==='reply'&&f.kind==='channel');
 need(requests.length===m.calls&&replies.length===m.calls,'channel_count');
 const business=a.frames.filter(f=>!['client-hello','server-hello','client-proof','ready'].includes(f.kind));
 need(business.length===4*m.calls,'message_count');
 for(const [i,row] of a.clientRows.entries()){
  const fs=business.slice(4*i,4*i+4),pr=a.providerRows[i];
  need(canon(fs.map(f=>[f.direction,f.kind]))===canon([['request','challenge-request'],['reply','challenge'],['request','channel'],['reply','channel']])&&fs.every(f=>f.operation===row.k),'message_order');
  need(row.wire===fs.reduce((n,f)=>n+f.frame+f.inner,0)&&pr.k===row.k&&pr.spent.wire===fs.reduce((n,f)=>n+f.inner,0),'row_wire');
  need(pr.spent.work===(mode==='B-independent'&&i>=2?222515:65537),'work_charge');
 }
 need(a.clientRows.length===m.calls&&a.providerRows.length===m.calls&&a.clientRows.every(x=>x.state==='complete'&&x.attempts===1&&x.deadline===a.deadline&&x.wire>0&&x.wire<=163840)&&a.providerRows.every(x=>x.state==='complete'&&x.attempts===1&&x.deadline<=a.deadline&&x.spent.work>0&&x.spent.wire>0),'rows');
 need(a.plans.every((x,i)=>x.call===i+3&&x.inventoryDigest===v.inventoryDigest&&x.inputDigest===v.inputDigest&&x.planDigest===v.planDigest&&x.commands===v.requests&&x.work<=156978&&x.ms>=0&&/^[a-f0-9]{64}$/.test(x.inputDigest))&&new Set(a.plans.map(x=>x.planDigest)).size===(v.providerPlans?1:0),'provider_plan');
 need(Math.abs(a.plans.reduce((n,x)=>n+x.ms,0)-v.providerPlanMs)<0.01,'plan_total');
 need(a.frames.filter(f=>['client-hello','client-proof'].includes(f.kind)).length===(p.temperature==='cold'?2:0),'temperature');
 }
 const quiet=p.planEventBridge?.quiet,q=quiet?.result,bm=p.arms['B-independent'];
 need(quiet?.status==='complete','failed_bridge');checkTiming(q);
 need(p.planEventBridge?.order===(p.repetition%2?'quiet-before-primary':'quiet-after-primary')&&q?.mode==='B-independent'&&q.wallMs>0&&Math.abs(q.wallMs-q.setupAndClientPlanMs-q.dispatchAndReconstructionMs)<0.01,'bridge');
 need(q.outputDigest===bm.result.outputDigest&&q.planDigest===bm.result.planDigest&&q.inventoryDigest===bm.result.inventoryDigest&&q.requests===bm.result.requests&&q.clientPlans===2&&q.providerPlans===q.requests&&quiet.plans.length===0,'bridge_semantics');
 for(const k of ['calls','pre','post','loads','plans','validatedBytes','parts','replies'])need(quiet.metrics[k]===bm.metrics[k],'bridge_counters');
 need(quiet.clientRows.length===bm.clientRows.length&&quiet.providerRows.every(x=>x.state==='complete'&&x.attempts===1)&&q.wireBytes===quiet.frames.reduce((n,f)=>n+f.frame+f.inner,0),'bridge_rows');
 const s=p.arms['S-scoped'].result,b=p.arms['B-independent'].result;need(s.inventoryDigest===b.inventoryDigest,'inventory_pair');
 const groupKey=[p.workload,p.role,p.temperature].join('/'),g=groups.get(groupKey)??[];g.push({scalar:s.wallMs,batch:b.wallMs,plan:b.clientPlanMs+b.sealMs+b.providerPlanMs,headroom:s.wallMs-(b.wallMs-b.clientPlanMs-b.sealMs-b.providerPlanMs),quiet:q.wallMs});groups.set(groupKey,g);
 }
 need(groups.size===16&&[...groups.values()].every(g=>g.length===6),'groups');
 const comparison=[...groups].map(([condition,g])=>({condition,pairs:g.length,scalarMedianMs:median(g.map(x=>x.scalar)),batchMedianMs:median(g.map(x=>x.batch)),planMedianMs:median(g.map(x=>x.plan)),headroomMedianMs:median(g.map(x=>x.headroom)),quietPlanEventMedianMs:median(g.map(x=>x.quiet)),observedMinusQuietMedianMs:median(g.map(x=>x.batch-x.quiet)),fasterPairs:g.filter(x=>x.batch<x.scalar).length,proceedToCprC:median(g.map(x=>x.batch))<median(g.map(x=>x.scalar))&&median(g.map(x=>x.plan))<=median(g.map(x=>x.headroom))}));
 return {pairs:r.pairs.length,primaryTransfers:2*r.pairs.length,planEventBridgeTransfers:r.pairs.length,transfers:3*r.pairs.length,comparison,proceedToCprC:comparison.every(x=>x.proceedToCprC),productionAdopted:false,realStorageVerified:false};
}
