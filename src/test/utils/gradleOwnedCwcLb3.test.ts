import {afterAll,beforeAll,expect,it} from 'vitest';
import {writeFileSync,readFileSync} from 'node:fs';
import {runCwcLb3,runLb3Attempt} from '../fixtures/gradleOwnedCwcLb3.js';
import {lb3ApprovalFixture} from '../fixtures/gradleOwnedCwcLb3Approval.js';
import {LB3_ARMS,summarizeLb3,validateLb3Row,validateLb3Trace} from '../fixtures/gradleOwnedCwcLb3Validation.mjs';
import {cwcLb3Case} from '../fixtures/gradleOwnedCwcLb3Case.js';
import {CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
let m:any;
beforeAll(async()=>{m=await runCwcLb3(1,[{id:'tiny',sizes:[32,48,64,80,96]}]);},120000);
it('LB301: common approvals, policy, original deadline, all entries and resource cleanup in all arms',()=>{
 expect(m.rows).toHaveLength(36);expect(m.rows.every((r:any)=>r.status==='complete')).toBe(true);expect(m.summary.completed).toBe(18);expect(m.summary.productionAdopted).toBe(false);expect(m.summary.decision).toBe('defer');
});
it('LB302: total includes setup, construction, handshake/capture, reconstruction, audit and cleanup',()=>{
 for(const row of m.rows){validateLb3Row(row);expect(row.totalMs).toBeGreaterThan(row.result.wallMs);expect(row.cleanupMs).toBeGreaterThan(0);expect(row.constructionMs).toBeGreaterThan(0);}
 const r=structuredClone(m.rows[0]);r.totalMs=r.result.wallMs;expect(()=>validateLb3Row(r)).toThrow('total_partition');
});
it('LB303: observer counters and contained async spans never become a second additive cost',()=>{
 const row=m.rows.find((r:any)=>r.observation==='timed');validateLb3Trace(row.trace,row);expect(row.trace.handshakes).toHaveLength(3*row.audit.calls);const r=structuredClone(row);r.trace.buckets['json.ownedSha256'].inclusiveMs=r.trace.wallMs+1;expect(()=>validateLb3Row(r)).toThrow('trace_cost');
});
it('LB304: matrix omission/duplication, approval/context substitution, plan/wire mismatch fail closed',()=>{
 const check=(rows:any[])=>summarizeLb3(rows,1,['tiny'],'fixed');expect(()=>check(m.rows.slice(1))).toThrow('matrix_size');
 for(const mutate of [(r:any[])=>{r[1]=structuredClone(r[0]);},(r:any[])=>{r[0].approvalPin='wrong';},(r:any[])=>{r[0].contextManifest='wrong';},(r:any[])=>{r.find(x=>x.arm==='bound-live').result.planDigest='wrong';}]){const rows=structuredClone(m.rows);mutate(rows);expect(()=>check(rows)).toThrow();}
});
it('LB305: negative/non-finite timings, inflated partition and lost handshake/counter evidence are rejected',()=>{
 const base=m.rows.find((r:any)=>r.observation==='timed');for(const mutate of [(r:any)=>r.totalMs=NaN,(r:any)=>r.cleanupMs=-1,(r:any)=>r.trace.otherMs+=1,(r:any)=>r.trace.handshakes.splice(1,1),(r:any)=>r.trace.entries['control.receive']--,(r:any)=>r.trace.buckets['control.receive'].calls--,(r:any)=>{delete r.trace.entries['json.ownedSha256'];delete r.trace.buckets['json.ownedSha256'];}]){const r=structuredClone(base);mutate(r);expect(()=>validateLb3Row(r)).toThrow();}
});
it('LB306: failed trials remain in completion denominator and cannot authorize adoption',()=>{
 const rows=structuredClone(m.rows),r=rows.find((r:any)=>r.round===0&&r.observation==='quiet'&&r.arm==='bound-live');r.status='failed';r.failure={phase:'transfer',reason:'permission_denied'};const s=summarizeLb3(rows,1,['tiny'],'fixed');expect(s.attempted).toBe(18);expect(s.completed).toBe(17);expect(s.decision).toBe('defer');expect(s.summary[0].arms['bound-live'].completionRate).toBe(2/3);
});
it('LB307: construction and cleanup cannot rebase the original deadline or turn a refusal into timeout',async()=>{
 for(const arm of LB3_ARMS){let now=4500;const approvals=lb3ApprovalFixture().view;expect(()=>cwcLb3Case(arm==='scalar'?'S-scoped':'B-independent',{approvals,bindingMode:arm==='bound-live'?'bound-live':'full-reference',startedAt:0,clock:()=>now})).toThrow('request_expired');now=0;
 const row=await runLb3Attempt(arm,'quiet',approvals,{sizes:[32,48,64,80,96],clock:()=>now,beforeCleanup:()=>{now=4500;}});expect(row.status).toBe('failed');expect(row.failure).toMatchObject({phase:'deadline',reason:'request_expired'});expect(row.cleaned).toBe(true);
 now=0;const refused=await runLb3Attempt(arm,'quiet',approvals,{sizes:[32,48,64,80,96],clock:()=>now,caseOptions:{providerFault:'refused'},beforeCleanup:()=>{now=4500;}});expect(refused.status).toBe('failed');expect(refused.failure!.reason).not.toBe('request_expired');expect(refused.overDeadline).toBe(true);
 }
},60000);
it('LB308: independent approval revocation rejects before construction in all arms',async()=>{
 for(const arm of LB3_ARMS){const approval=lb3ApprovalFixture();approval.revoke();const r=await runLb3Attempt(arm,'quiet',approval.view);expect(r.status).toBe('failed');expect(r.audit.calls).toBe(0);expect(r.failure!.reason).toBe('codec_profile_unsupported');}
});
it('LB309: transport expiry cannot publish completed reconstruction in any arm',async()=>{
 for(const arm of LB3_ARMS){const a=lb3ApprovalFixture();let now=0,enabled=false;
 const f=cwcLb3Case(arm==='scalar'?'S-scoped':'B-independent',{approvals:a.view,bindingMode:arm==='bound-live'?'bound-live':'full-reference',startedAt:0,clock:()=>now,sizes:[32,48,64,80,96],variant:'combined',planEvents:false,afterTransport:()=>{if(enabled)now=4500;}});
 try{const commands=await f.commands();enabled=true;await expect(f.run(commands[0]!)).rejects.toThrow();await f.link.settle();expect(f.reconstructed).toBeUndefined();expect(f.link.diagnostics.slice(2).every(r=>r.control.metrics.publications===0)).toBe(true);}finally{f.close();}
 }
},60000);
it.runIf(process.env.CWC_LB3_EVIDENCE_PATH!==undefined)('LB310: native real-time matrix retains warmups, failures and all observer states',async()=>{
 const measured=await runCwcLb3(3,undefined,{realClock:true});writeFileSync(process.env.CWC_LB3_EVIDENCE_PATH!,JSON.stringify(measured));expect(measured.rows).toHaveLength(216);expect(measured.summary.attempted).toBe(162);
},1800000);
it('LB311: the outer source closure covers every nested approval including fs-loaded case roots',()=>{
 const a=lb3ApprovalFixture().view.record,outer=a.comparison.envelope.manifest.sources;
 for(const part of [a.binding,a.binding.connected,a.code])for(const [path,h]of Object.entries(part.envelope.manifest.sources??part.envelope.manifest.sourceClosure))expect(outer[path],path).toBe(h);
 expect(outer['src/test/fixtures/gradleOwnedCwcCCase.ts']).toBeDefined();expect(readFileSync('scripts/check-cwc-lb3.mjs','utf8')).toContain('...LB3_APPROVAL_ROOTS');
});
it('LB312: failed attempts reject every budget overrun and missing/invalid budget evidence',()=>{
 const limits={peakBytes:1048576,callWork:156978,callWire:163840,providerWork:1048576,providerWire:163840,clientWork:67108864};
 for(const [key,limit]of Object.entries(limits))for(const value of [limit+1,-1,NaN,Infinity,null,undefined]){
  const row=structuredClone(m.rows[0]);row.status='failed';row.failure={phase:'transfer',reason:'request_expired'};row.audit[key]=value;
  expect(()=>validateLb3Row(row),key+'='+value).toThrow();
 }
});
it('LB313: construction inclusive cost cannot exceed its own phase with unchanged calls/exclusive/partition',()=>{
 const row=structuredClone(m.rows.find((r:any)=>r.observation==='timed'));row.trace.buckets.construction.inclusiveMs=row.constructionMs+1;
 expect(()=>validateLb3Row(row)).toThrow();
});
it('LB314: reconstruction and all plan durations reject negative/non-finite/missing values and inflated costs',()=>{
 const keys=['wallMs','setupAndClientPlanMs','dispatchAndReconstructionMs','finalizationMs','clientPlanMs','sealMs','providerPlanMs'];
 for(const key of keys)for(const value of [-1,NaN,Infinity,null,undefined]){const row=structuredClone(m.rows.find((r:any)=>r.arm==='bound-live'));row.result[key]=value;expect(()=>validateLb3Row(row),key+'='+value).toThrow();}
 for(const key of keys){const row=structuredClone(m.rows.find((r:any)=>r.arm==='bound-live'));row.result[key]+=1;expect(()=>validateLb3Row(row),key).toThrow();}
});
it('LB315: plan window closure, phase containment and sums reject coherent aggregate inflation',()=>{
 const base=m.rows.find((r:any)=>r.arm==='bound-live'&&r.observation==='timed');
 for(const mutate of [(r:any)=>r.planTiming.windows.splice(0,1),(r:any)=>r.planTiming.windows[1].id=1,(r:any)=>r.planTiming.windows[0].end=r.result.timing.planned+1,(r:any)=>r.planTiming.windows[2].start=r.result.timing.planned-1,(r:any)=>{r.planTiming.clientPlanMs++;r.result.clientPlanMs++;},(r:any)=>{r.planTiming.providerPlanMs++;r.result.providerPlanMs++;},(r:any)=>r.planTiming.windows[0].complete=false]){const row=structuredClone(base);mutate(row);expect(()=>validateLb3Row(row)).toThrow();}
 // Exact phase/cost upper boundaries remain inclusive, not rejected by rounding.
 const row=structuredClone(base);row.trace.buckets.construction.inclusiveMs=row.constructionMs;expect(()=>validateLb3Row(row)).not.toThrow();
});
it('LB316: no-fixture failures and partial provider plan failures retain explicit zero/bounded evidence',async()=>{
 for(const arm of LB3_ARMS){const approval=lb3ApprovalFixture();approval.revoke();const early=await runLb3Attempt(arm,'quiet',approval.view);expect(()=>validateLb3Row(early)).not.toThrow();expect(early.planTiming.windows).toEqual([]);
 const partial=await runLb3Attempt(arm,'timed',lb3ApprovalFixture().view,{sizes:[32,48,64,80,96],caseOptions:{hook:phase=>{if(phase===(arm==='scalar'?'load-after':'plan-before'))throw new CurrentControlError('permission_denied');}}});
 expect(partial.status).toBe('failed');expect(partial.cleaned).toBe(true);expect(()=>validateLb3Row(partial)).not.toThrow();if(arm!=='scalar'){expect(partial.planTiming.windows.at(-1)).toMatchObject({actor:'provider',complete:false});expect(partial.planTiming.providerPlanMs).toBeGreaterThan(0);}
 }
},60000);
