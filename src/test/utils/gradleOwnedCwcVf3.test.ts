import {validateVf3Row} from '../fixtures/gradleOwnedCwcVf3Validation.mjs';
import {it,expect} from 'vitest';
import {Vf0Clock,VfRealtimeClock,readOwnedClock,ownedClockKind} from '../fixtures/gradleOwnedCwcVf0Authority.js';
it('VF301: owned monotonic clock advances during synchronous work and cannot be advanced or forged',()=>{
 const c=new VfRealtimeClock(),start=readOwnedClock(c),until=performance.now()+3;while(performance.now()<until){};
 expect(readOwnedClock(c)).toBeGreaterThan(start);expect(ownedClockKind(c)).toBe('owned-monotonic');
 expect(()=>Vf0Clock.prototype.advance.call(c,999999999)).toThrow('clock_invalid');
 expect(()=>readOwnedClock(Object.create(VfRealtimeClock.prototype))).toThrow('codec_profile_unsupported');
 expect(readOwnedClock(new Vf0Clock())).toBe(0);
});

import {vf3Approvals,runVf3Attempt} from '../fixtures/gradleOwnedCwcVf3.js';
it('VF302: real signed session transfers all entries with a final client receipt and reclaimed private bytes',async()=>{
 const approval=vf3Approvals(),r=await runVf3Attempt('batch/fact-live','timed',approval);
 validateVf3Row(r);
 expect(r.status).toBe('complete');expect(r.audit.verified).toBe(true);expect(r.audit.held).toBe(0);expect(r.audit.calls).toBe(r.result.requests+2);
},30000);
it('VF303: all four arms use the same source approval and real clock in observed transfers',async()=>{
 const approval=vf3Approvals();for(const arm of ['scalar/full-verify','scalar/fact-live','batch/full-verify','batch/fact-live']){
 const r=await runVf3Attempt(arm,'counts',approval);validateVf3Row(r);
 expect(r.status).toBe('complete');expect(r.audit.logical).toBe(r.audit.fullChecks+r.audit.reused);
 }
},40000);
import {Vf1Owner} from '../fixtures/gradleOwnedCwcVf1Contract.js';
import {vf1Fixture} from '../fixtures/gradleOwnedCwcVf1Fixture.js';
import {classifyVf3Control,vf3Decision} from '../fixtures/gradleOwnedCwcVf3Validation.mjs';
it('VF304: fixed-clock approval rejects a real clock before a read owner can be constructed',()=>{
 const f=vf1Fixture({mode:'fact-live'});try{expect(()=>new Vf1Owner({mode:'fact-live',authority:f.authority,clock:new VfRealtimeClock(),approval:f.approval.view,approvalPin:f.approval.pin,registryPin:f.context.registryDigest})).toThrow('codec_profile_unsupported');}finally{f.close();}
});
for(const mode of ['full-verify','fact-live'] as const){
 it('VF305 '+mode+': authorization revocation cannot publish success, and cleanup drains private storage',async()=>{
  const a=vf3Approvals();let injected=0;const r=await runVf3Attempt('batch/'+mode,'counts',a,{caseOptions:{hook:()=>{if(!injected++){a.revoke();}}}});
  validateVf3Row(r);expect(r.status).toBe('failed');expect(r.audit.held).toBe(0);expect(r.calls.every(c=>c.control.metrics.publications===0)).toBe(true);expect(classifyVf3Control(r).kind).toBe('invalid');
 },20000);
 it('VF306 '+mode+': separately signed corrupt content fails before successful reconstruction',async()=>{
  const r=await runVf3Attempt('batch/'+mode,'quiet',vf3Approvals(),{caseOptions:{mutateResult:b=>{if(b.result?.metadata)b.result.entries--;}}});
  validateVf3Row(r);expect(r.status).toBe('failed');expect(r.audit.verified).toBe(false);expect(r.audit.held).toBe(0);expect(r.calls.every(c=>c.control.metrics.publications===0)).toBe(true);
 },20000);
 it('VF307 '+mode+': original deadline stops work and partial provider plan time cannot be understated',async()=>{
  const r=await runVf3Attempt('batch/'+mode,'quiet',vf3Approvals(),{caseOptions:{hook:async at=>{if(at==='plan-before')await new Promise(resolve=>setTimeout(resolve,4510));}}});
  validateVf3Row(r);expect(r.status).toBe('failed');expect(r.overDeadline).toBe(true);expect(r.audit.held).toBe(0);expect(r.audit.pending).toBe(0);expect(classifyVf3Control(r).kind).toBe('invalid'); // deliberately injected diagnostic, never performance evidence
  expect(r.planTiming.providerPlanMs).toBeGreaterThan(0);const reduced=structuredClone(r);reduced.planTiming.providerPlanMs=0;
  expect(()=>validateVf3Row(reduced)).toThrow();
 },15000);
}
it('VF308: deadline censoring requires original clock evidence, not a label or cleanup overrun',()=>{
 const r:any={status:'failed',failure:{reason:'request_expired',phase:'transfer',now:4500},overDeadline:true,deadline:4500,expiration:{observedNow:4501,originalDeadline:4500,injected:false,lowerBoundMs:4499.2},calls:[{control:{deadline:4500},actualControl:{deadline:4500}}]};
 expect(classifyVf3Control(r)).toEqual({kind:'original-deadline-censored',value:4499.2});
 for(const change of [()=>r.failure.now=4499,()=>r.calls[0].actualControl.deadline=4490,()=>r.failure.reason='permission_denied',()=>r.expiration.injected=true]){const before=structuredClone(r);change();expect(classifyVf3Control(r).kind).toBe('invalid');Object.assign(r,before);}
});
it('VF309: censoring can only yield a candidate with all candidate observations complete and a 5 percent lower-bound win',()=>{
 const rows:any[]=[];for(const arm of ['scalar/full-verify','scalar/fact-live','batch/full-verify','batch/fact-live'])for(const observation of ['quiet','counts','timed'])for(let round=0;round<3;round++)rows.push({arm,observation,round,status:'complete',totalMs:arm==='batch/fact-live'?1000:2000});
 expect(vf3Decision(rows)).toEqual({decision:'candidate-only',comparisonKind:'completed-controls'});
 const control=rows.find(r=>r.arm==='batch/full-verify'&&r.observation==='quiet');Object.assign(control,{status:'failed',failure:{reason:'request_expired',phase:'transfer',now:4500},overDeadline:true,deadline:4500,expiration:{observedNow:4501,originalDeadline:4500,injected:false,lowerBoundMs:4499.2},calls:[]});
 expect(vf3Decision(rows).comparisonKind).toBe('deadline-censored-controls');control.failure.reason='response_lost';expect(vf3Decision(rows).decision).toBe('defer');control.failure.reason='request_expired';rows.find(r=>r.arm==='batch/fact-live').status='failed';expect(vf3Decision(rows).decision).toBe('defer');
});
it('VF310: an invalid scalar/full control also blocks adoption even if the two speed comparators complete',()=>{
 const rows:any[]=[];for(const arm of ['scalar/full-verify','scalar/fact-live','batch/full-verify','batch/fact-live'])for(const observation of ['quiet','counts','timed'])for(let round=0;round<3;round++)rows.push({arm,observation,round,status:'complete',totalMs:arm==='batch/fact-live'?1000:2000});
 const c=rows.find(r=>r.arm==='scalar/full-verify');c.status='failed';c.failure={reason:'permission_denied'};expect(vf3Decision(rows).decision).toBe('defer');
});
import {validateVf3LiveCounts} from '../fixtures/gradleOwnedCwcVf3Validation.mjs';
it('VF311: original-deadline refusal allows only the single in-flight live frontier; completed checks stay exact',()=>{
 const base={liveChecks:100,purposeChecks:100,credentialChecks:200};expect(()=>validateVf3LiveCounts(base,false)).not.toThrow();
 for(const [purposeChecks,credentialChecks]of [[100,201],[100,202],[101,202]])expect(()=>validateVf3LiveCounts({...base,purposeChecks,credentialChecks},true)).not.toThrow();
 for(const [purposeChecks,credentialChecks]of [[100,199],[100,203],[101,201],[102,202]])expect(()=>validateVf3LiveCounts({...base,purposeChecks,credentialChecks},true)).toThrow();
 expect(()=>validateVf3LiveCounts({...base,purposeChecks:101,credentialChecks:202},false)).toThrow();
});
import {validateVf3Actual} from '../fixtures/gradleOwnedCwcVf3Validation.mjs';
it('VF312: deadline refusal during outcome decode retains started and completed phase counters separately',()=>{
 const a={generation:2,state:'invalid',deadline:4500,lookupPresent:false,readers:0,bytes:0,reclaimed:true,releases:1,checks:2,reads:2,outcomes:0,replyVerifications:0,authSignatures:0,phases:{dispatch:1,'dispatch-read':1,outcome:1,'outcome-decode':1}};
 expect(()=>validateVf3Actual(a,4500)).not.toThrow();expect(()=>validateVf3Actual({...a,outcomes:2},4500)).toThrow();expect(()=>validateVf3Actual({...a,checks:1},4500)).toThrow();
});
import {Vf3SpendWitness} from '../fixtures/gradleOwnedCwcVf3Spend.js';
import {CwcCWorkLedger} from '../fixtures/gradleOwnedCwcC.js';
it('VF313: failed prepayment retains the actual debit even if no provider phase or ticket was published',()=>{
 const original=CwcCWorkLedger.prototype.reserve,w=new Vf3SpendWitness(),key='a'.repeat(64);w.begin(key);let checks=0;const balance={work:0},ledger=new CwcCWorkLedger(balance,1048576,()=>{if(++checks===2)throw Error('deadline');});
 try{expect(()=>ledger.reserve({gate(){}} as any,'provider')).toThrow('deadline');expect(balance.work).toBe(156978);expect(w.end(key)).toEqual({schema:'cwc-vf3.source-spend.v1',operationKey:key,wireReceived:false,planFloor:156978,finished:false});}finally{w.close();}expect(CwcCWorkLedger.prototype.reserve).toBe(original);
});

for(const mode of ['full-verify','fact-live'] as const)it('VF314 '+mode+': refuses coordinated check and work reductions while the actual Session witness stays unchanged',async()=>{
 const original=await runVf3Attempt('batch/'+mode,'quiet',vf3Approvals(),{caseOptions:{hook:async phase=>{if(phase==='plan-before')await new Promise(resolve=>setTimeout(resolve,4510));}}});
 validateVf3Row(original);expect(original.status).toBe('failed');
 const last=original.calls.at(-1)!;
 expect(last.gateReceipt.after-last.gateReceipt.before).toBe(last.control.verification.logical);
 const gate=last.accounting.reservations.findLast((q:any)=>q.bytes===0&&q.initialization===0&&q.work===1&&q.wire===0&&!q.slot&&q.count>1);
 const maximum=Math.min(100,gate.count-1,last.control.verification.sites['connected-provider']-1);
 expect(maximum).toBeGreaterThan(0);
 for(const delta of new Set([1,maximum])){
  const row=structuredClone(original),c=row.calls.at(-1)!,v=c.control.verification,a=c.accounting;
  v.logical-=delta;v.sites['connected-provider']-=delta;row.audit.logical-=delta;
  const changes:Record<string,number>={liveChecks:1,purposeChecks:1,credentialChecks:2};
  if(mode==='full-verify')Object.assign(changes,{fullChecks:1,challengeChecks:1,channelChecks:1,ownerChecks:1});else{v.reused-=delta;row.audit.reused-=delta;}
  for(const [k,factor]of Object.entries(changes)){c.control.metrics[k]-=delta*factor;row.audit[k]-=delta*factor;}
  c.binding.checks-=delta;c.binding.elidedHashes-=delta;row.audit.elidedHashes-=delta;
  const index=a.reservations.findLastIndex((q:any)=>q.bytes===0&&q.initialization===0&&q.work===1&&q.wire===0&&!q.slot&&q.count>delta);
  a.reservations[index].count-=delta;a.reservations[index].after.work-=delta;
  for(const q of a.reservations.slice(index+1)){q.before.work-=delta;q.after.work-=delta;}
  a.after.work-=delta;for(const b of [c.budget,c.control.budget,c.binding.budget,c.binding.call.budget])b.work-=delta;
  c.binding.call=structuredClone(c.control);row.audit.callWork=Math.max(...row.calls.map(x=>x.budget.initialization+x.budget.work));
  expect(c.actualControl).toEqual(last.actualControl);
  expect(c.gateReceipt).toEqual(last.gateReceipt);
  expect(()=>validateVf3Row(row)).toThrow(/vf3_(gate_work|inspection_frontier)/);
 }
},20000);
