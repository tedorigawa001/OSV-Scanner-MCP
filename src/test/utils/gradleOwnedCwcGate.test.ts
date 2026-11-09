import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {runCwcGate,validateGateRows,validateGateTrace} from '../fixtures/gradleOwnedCwcGate.js';
import {installGateObserver} from '../fixtures/gradleOwnedCwcGateProfile.js';
import {cwcCApprovalFixture} from '../fixtures/gradleOwnedCwcCApprovalFixture.js';
import {cwcCCase} from '../fixtures/gradleOwnedCwcCCase.js';

let pending:ReturnType<typeof runCwcGate>|undefined;
const small=[{id:'small',sizes:[600,800,900,1100,1300]}] as const;
function prepare(){const path=process.env.CWC_GATE_EVIDENCE_PATH;return pending??=runCwcGate(path?3:1,path?undefined:small,!!path||process.env.OSV_REALTIME_PROCESS==='1');}
const check=(r:Awaited<ReturnType<typeof runCwcGate>>)=>validateGateRows(r.rows,r.rounds,[...new Set(r.rows.map(x=>x.workload))],r.clock as 'real'|'fixed');
it('CWG01: isolates gate costs without stack capture or changing output, plan, wire or work',async()=>{
 const r=await prepare();if(process.env.CWC_GATE_EVIDENCE_PATH)writeFileSync(process.env.CWC_GATE_EVIDENCE_PATH,JSON.stringify(r));
 else expect(r.rows.every(x=>x.status==='complete')).toBe(true);
 expect(check(r)).toEqual(r.summary);
},180000);
it('CWG02: duplicate or missing arms fail comparison closure',async()=>{
 const r=structuredClone(await prepare());r.rows[1]=structuredClone(r.rows[0]);expect(()=>check(r)).toThrow('cwc_gate_duplicate');
 const missing=structuredClone(await prepare());missing.rows.pop();expect(()=>check(missing)).toThrow('cwc_gate_closure');
});
it('CWG03: tracing cannot exceed outer time while preserving its partition',async()=>{
 const r=structuredClone(await prepare()),row=r.rows.find(x=>x.arm==='profiled');row.trace.wallMs+=100000;row.trace.otherMs+=100000;
 expect(()=>check(r)).toThrow('cwc_gate_trace');
});
it('CWG04: unmatched calls or missing gate observations reject the count-only control',async()=>{
 for(const operation of ['scope.gate','ledger.check','session.inspectAuthenticatedCall','endpoint.permitAPI']){
  const r=structuredClone(await prepare()),row=r.rows.find(x=>x.arm==='counts');row.trace.operations[operation].calls++;
  expect(()=>check(r)).toThrow('cwc_gate_count_witness');
 }
 const r=structuredClone(await prepare()),t=r.rows.find(x=>x.arm==='profiled').trace;t.otherMs+=t.operations['ledger.check'].exclusiveMs;delete t.operations['ledger.check'];expect(()=>check(r)).toThrow('cwc_gate_missing');
});
it('CWG05: count-only time, unknown operations and invalid durations are rejected',async()=>{
 for(const value of [NaN,Infinity,-1]){const r=structuredClone(await prepare());r.rows.find(x=>x.arm==='profiled').trace.operations['scope.gate'].exclusiveMs=value;expect(()=>check(r)).toThrow();}
 const r=structuredClone(await prepare());r.rows.find(x=>x.arm==='counts').trace.operations['scope.gate'].inclusiveMs=1;expect(()=>check(r)).toThrow('cwc_gate_count_only');
 const extra=structuredClone(await prepare());extra.rows.find(x=>x.arm==='profiled').trace.operations.fake={calls:1,inclusiveMs:0,exclusiveMs:0};expect(()=>check(extra)).toThrow('cwc_gate_operation');
});
it('CWG06: failures stay in denominators and cannot become adoption evidence',async()=>{
 const r=structuredClone(await prepare()),row=r.rows.find(x=>x.arm==='composed'&&x.round===0);row.status='failed';row.error='request_expired';
 const summary=check(r).find(x=>x.workload===row.workload&&x.role===row.role)!;
 expect(summary.times.composed!.completed).toBe(summary.times.composed!.attempts-1);expect(summary.times.composed!.medianMs).toBe(null);expect(summary.productionAdopted).toBe(false);
});
it('CWG07: original identity, falsy errors, closed state and method restoration are preserved',async()=>{
 const before=structuredClone,o=installGateObserver(),handle=Object.freeze({kind:'opaque'});
 try{
  expect(()=>installGateObserver()).toThrow('cwc_gate_busy');
  const success=await o.measure(async()=>handle);expect(success.ok).toBe(true);expect(success.result).toBe(handle);
  for(const error of [undefined,null,false,0,'']){const failure=await o.measure(async()=>{throw error;});expect(failure.ok).toBe(false);expect(failure.error).toBe(error);}
 }finally{o.close();}expect(structuredClone).toBe(before);await expect(o.measure(async()=>handle)).rejects.toThrow('cwc_gate_closed_or_busy');
});
it('CWG08: both observers retain source, permission, deadline and content fault rejection',async()=>{
 for(const timed of [false,true])for(const fault of ['source','permission','deadline','content']){
  const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,comparisonProfile:true,variant:'combined',hook:phase=>{
   if(phase==='load-after'){if(fault==='permission')f.revoke();if(fault==='deadline')f.setNow(4500);}
   if(phase==='load-before'&&fault==='content')f.source.payloads[3]=Buffer.from('changed').toString('base64');
  }}),o=installGateObserver(timed);if(fault==='source')a.revoke();
  try{const m=await o.measure(()=>f.transfer());expect(m.ok).toBe(false);}finally{o.close();f.close();}
 }
});
it('CWG09: altered bytes, plans, work and budget profiles cannot pass semantic comparison',async()=>{
 for(const [key,value]of [['outputDigest','0'.repeat(64)],['planDigest','0'.repeat(64)],['wireBytes',0],['clientWork',0],['memoryLimit',2097152],['deadlineMs',9000]] as const){
  const r=structuredClone(await prepare());r.rows.find(x=>x.arm==='profiled')[key]=value;expect(()=>check(r)).toThrow();
 }
});
it('CWG10: BP plan, wire and request mismatches reject the bridge comparison',async()=>{
 for(const field of ['planDigest','wireBytes','requests']){
  const r=structuredClone(await prepare()),row=r.rows.find(x=>x.arm==='bp-bridge');
  row[field]=field==='planDigest'?'0'.repeat(64):0;
  if(field==='requests')row.loads=2;
  expect(()=>check(r)).toThrow('cwc_gate_semantics');
 }
});
it('CWG11: matching losses in both observer arms cannot hide missing inspections',async()=>{
 const r=structuredClone(await prepare());
 for(const row of r.rows.filter(x=>['counts','profiled'].includes(x.arm)))row.trace.operations['session.inspectAuthenticatedCall'].calls=1;
 expect(()=>check(r)).toThrow();
});
it('CWG12: non-reentrant SHA inclusive inflation rejects unchanged count and partition',async()=>{
 for(const operation of ['gate.ownedSha256','outside.ownedSha256']){
  const r=structuredClone(await prepare()),row=r.rows.find(x=>x.arm==='profiled'),b=row.trace.operations[operation];
  const before={calls:b.calls,exclusiveMs:b.exclusiveMs,otherMs:row.trace.otherMs};
  b.inclusiveMs=row.trace.wallMs*2;
  expect({calls:b.calls,exclusiveMs:b.exclusiveMs,otherMs:row.trace.otherMs}).toEqual(before);
  expect(()=>check(r)).toThrow('cwc_gate_operation');
 }
});
it('CWG13: changing both counters cannot bypass inspection SHA, clone or permission relationships',async()=>{
 for(const operation of ['session.inspectAuthenticatedCall','gate.ownedSha256','gate.structuredClone','endpoint.permitAPI']){
  const r=structuredClone(await prepare());
  for(const row of r.rows.filter(x=>['counts','profiled'].includes(x.arm))){row.trace.operations[operation].calls--;row.trace.entryCalls[operation]--;}
  expect(()=>check(r)).toThrow('cwc_gate_count_binding');
 }
});
it('CWG14: common observation losses and absent or malformed entry witnesses are rejected',async()=>{
 const original=await prepare(),names=Object.keys(original.rows.find(x=>x.arm==='counts').trace.operations);
 for(const operation of names){
  const r=structuredClone(original);
  for(const row of r.rows.filter(x=>['counts','profiled'].includes(x.arm)))row.trace.operations[operation].calls--;
  expect(()=>check(r)).toThrow();
 }
 for(const value of [undefined,[],{},null]){const r=structuredClone(original);r.rows.find(x=>x.arm==='profiled').trace.entryCalls=value;expect(()=>check(r)).toThrow('cwc_gate_count_witness');}
});
it('CWG15: SHA leaf wall boundary is accepted but excess or hidden children are refused',async()=>{
 const r=structuredClone(await prepare()),row=r.rows.find(x=>x.arm==='profiled'),t=row.trace;
 for(const b of Object.values(t.operations) as any[]){b.inclusiveMs=0;b.exclusiveMs=0;}
 t.wallMs=1;t.otherMs=0;t.operations['gate.ownedSha256'].inclusiveMs=1;t.operations['gate.ownedSha256'].exclusiveMs=1;
 expect(()=>validateGateTrace(t,2,true,row.requests)).not.toThrow();
 t.operations['gate.ownedSha256'].inclusiveMs=1.01;
 expect(()=>validateGateTrace(t,2,true,row.requests)).toThrow('cwc_gate_operation');
 t.operations['gate.ownedSha256'].inclusiveMs=1;t.operations['gate.ownedSha256'].exclusiveMs=0.5;t.otherMs=0.5;
 expect(()=>validateGateTrace(t,2,true,row.requests)).toThrow('cwc_gate_operation');
});
