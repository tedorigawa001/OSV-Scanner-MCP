import {it,expect,vi,afterAll} from 'vitest';
import {writeFileSync} from 'node:fs';
import {lb1Fixture,lb1ApprovalFixture} from '../fixtures/gradleOwnedCwcLb1Fixture.js';
import {LB0_MODES,Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {CwcCReadScope,CwcCWorkLedger} from '../fixtures/gradleOwnedCwcC.js';
import {CPR_WORK} from '../fixtures/gradleOwnedCprAAdmission.js';
import {lb0Fixture} from '../fixtures/gradleOwnedCwcLb0Fixture.js';
import {cwcCMemory} from '../fixtures/gradleOwnedCwcC.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {wireIntent} from '../fixtures/gradleOwnedCprASchema.js';
import * as protocol from '../fixtures/gradleOwnedCprBProtocol.js';
import * as signer from '../fixtures/gradleOwnedCprBSigner.js';
import {CwcCProvider} from '../fixtures/gradleOwnedCwcCProvider.js';
import {CwcAContract} from '../fixtures/gradleOwnedCwcA.js';
import {ClosedCwcBCodec} from '../fixtures/gradleOwnedCwcB.js';
import * as planner from '../fixtures/gradleOwnedCwcCPlanner.js';
it('LBC02: bounded frame workspace fits within the existing call reservation',()=>{const f=lb0Fixture();try{expect(Buffer.byteLength(canonical(f.registry))).toBeLessThanOrEqual(57344);expect(cwcCMemory(f.context).reserved+131072+98304+8192-32768).toBeLessThanOrEqual(1048576);}finally{f.close();}});
const samples:any[]=[],proofs:any[]=[];let sourceApproval:any;
const proof=async(id:string,mode:string,f:ReturnType<typeof lb1Fixture>,extra:Record<string,unknown>={})=>{for(let i=0;i<64&&f.session.stats(f.call!).pendingDispatch;i++)await Promise.resolve();expect(f.session.stats(f.call!).pendingDispatch).toBe(false);proofs.push({id,mode,after:f.session.stats(f.call!),metrics:{...f.provider.metrics},rows:f.provider.rows,budget:f.budget.stats(),...extra});};
afterAll(()=>{if(process.env.CWC_LB1_EVIDENCE_PATH){expect(samples).toHaveLength(12);expect(proofs).toHaveLength(30);writeFileSync(process.env.CWC_LB1_EVIDENCE_PATH,JSON.stringify({schema:'cwc-lb1.samples.v1',samples,proofs,sourceApproval}));}});
async function collectMatrix(){
 if(samples.length===12)return;const approval=lb1ApprovalFixture();
 sourceApproval={pin:approval.pin,envelope:approval.envelope,registry:approval.registry};
 for(const mode of LB0_MODES)for(const role of ['reader','authority-broker'] as const)for(const api of ['aux.ReadSourceDescriptor','aux.ReadSealedSource','aux.ReadSourceRanges'] as const){const f=lb1Fixture({mode,role,api,approval});try{const r=await f.run();expect(r.metrics.loads).toBe(1);expect(r.metrics.replies).toBe(1);expect(r.diagnostics.budget.peakBytes).toBeLessThanOrEqual(1048576);expect(r.diagnostics.internal).toBeGreaterThan(0);expect(r.diagnostics.call.metrics.publications).toBe(1);expect(r.diagnostics.call.metrics.reclaims).toBe(1);
  if(api==='aux.ReadSourceRanges'){expect(r.plans).toHaveLength(1);expect(r.plans[0].helper.roots).toBe(1);expect(r.plans[0].helper.proofs).toBe(f.reference.commands.length);expect(r.rows[0]!.spent.work).toBe(CPR_WORK.total);}else expect(r.plans).toHaveLength(0);
  expect(r.diagnostics.elidedHashes>0).toBe(mode==='bound-live');f.close();samples.push({mode,role,api,...r,closedBudget:f.budget.stats()});
 }finally{f.close();}}
}
it('LBC01: actual provider/ReadScope/root/facts retain live checks while only immutable checks differ',collectMatrix);

it('LBC03: modes have equal live/signature counts and outcomes, with only approved hash/identity omissions',async()=>{
 await collectMatrix();
 for(const role of ['reader','authority-broker'])for(const api of ['aux.ReadSourceDescriptor','aux.ReadSealedSource','aux.ReadSourceRanges']){const pair=samples.filter(s=>s.role===role&&s.api===api);expect(pair).toHaveLength(2);const [a,b]=pair;
  expect(a.outputDigest).toBe(b.outputDigest);expect(a.rows).toEqual(b.rows);expect(a.metrics).toMatchObject({loads:b.metrics.loads,plans:b.metrics.plans,pre:b.metrics.pre,post:b.metrics.post,parts:b.metrics.parts,replies:b.metrics.replies});
  for(const k of ['fullChecks','challengeChecks','channelChecks','ownerChecks','liveChecks','purposeChecks','credentialChecks','publications'])expect(a.diagnostics.call.metrics[k]).toBe(b.diagnostics.call.metrics[k]);
  for(const s of pair){const d=s.diagnostics;expect(d.call.metrics.fullChecks+2-d.call.metrics.wireIdentityHashes).toBe(d.elidedHashes);expect(d.identityCopies).toBe(2*(d.checks-d.elidedHashes));expect(d.identityComparisons).toBe(d.identityCopies);expect(d.budget.peakBytes).toBe(d.scopeBytes+131072+98304+8192-32768);expect(d.budget.heldBytes).toBe(131072);expect(d.budget.occupiedSlots).toBe(0);}
 }
});

it('LBC04: actual channel and owner verifier calls are retained in both modes',async()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode}),channels=vi.spyOn(protocol,'validateChannelFrame'),owners=vi.spyOn(signer,'verifyOwnerValue');try{const r=await f.run();expect(channels).toHaveBeenCalledTimes(r.diagnostics.call.metrics.channelChecks);expect(owners).toHaveBeenCalledTimes(r.diagnostics.call.metrics.ownerChecks+2);}finally{channels.mockRestore();owners.mockRestore();f.close();}}
});

it('LBC05: separately granted purpose changes refuse and restoration cannot revive the call',async()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after')f.setPurpose('publication');}});try{await expect(f.run()).rejects.toThrow('permission_denied');f.setPurpose('read');expect(f.provider.metrics.replies).toBe(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);expect(()=>f.session.finishCall(f.call!)).toThrow();await proof('purpose',mode,f);}finally{f.close();}}
});

it('LBC06: credential, permission/delegation/lineage and independent approval remain live',async()=>{
 for(const mode of LB0_MODES)for(const fault of ['peer','server','permission','delegation','lineage','approval','codeApproval']){const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after'){
  if(fault==='peer')f.revoke();if(fault==='server')f.revoke(f.server.credentialId);if(fault==='permission')f.setPermissions([]);if(fault==='delegation')f.setPermissions(f.permissions.map((p:any)=>({...p,delegateInstance:'other'})));if(fault==='lineage')f.setPermissions(f.permissions.map((p:any)=>({...p,lineage:{...p.lineage,lineageId:'other'}})));if(fault==='approval')f.approval.revoke();if(fault==='codeApproval')f.codeApproval.revoke();
 }}});try{await expect(f.run()).rejects.toThrow();expect(f.provider.metrics.replies).toBe(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);}finally{f.close();}}
},15000);

it('LBC07: original deadline at all provider boundaries refuses',async()=>{
 for(const mode of LB0_MODES)for(const phase of ['admission','pre-after','load-after','plan-before','plan-after','parts-after','post-after','sign-before','enqueue-before']){const f=lb1Fixture({mode,hook:at=>{if(at===phase)f.setNow(4500);}});try{await expect(f.run()).rejects.toThrow('request_expired');expect(f.provider.metrics.replies).toBe(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);}finally{f.close();}}
},15000);

it('LBC08: requested and unrequested corruption refuses after full fresh source validation',async()=>{
 for(const mode of LB0_MODES)for(const target of ['commit','unrequested']){const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-before'){if(target==='commit')f.source.commits[0]=Buffer.alloc(600,0).toString('base64');else f.source.payloads[3]=Buffer.from('changed').toString('base64');}}});try{await expect(f.run()).rejects.toThrow('source_integrity');expect(f.provider.metrics.plans).toBe(0);expect(f.provider.rows[0]!.spent.work).toBe(CPR_WORK.plan+CPR_WORK.source);await proof('corrupt-'+target,mode,f);}finally{f.close();}}
});

it('LBC09: fully resigned but independently mismatched plan is rejected before parts',async()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode,commandMutation:q=>{q.payload.plan.planDigest='0'.repeat(64);q.requestDigest=wireIntent(q);return q;}});try{await expect(f.run()).rejects.toThrow('plan_mismatch');expect(f.provider.metrics.parts).toBe(0);expect(f.provider.metrics.replies).toBe(0);expect(f.provider.rows[0]!.spent.work).toBe(CPR_WORK.plan+CPR_WORK.source);}finally{f.close();}}
});

it('LBC10: shared memory and actual work shortages refuse before source IO or planning',async()=>{
 for(const mode of LB0_MODES)for(const fault of ['memory','work']){const f=lb1Fixture({mode,...(fault==='memory'?{memory:800000}:{work:CPR_WORK.total-1})});try{await expect(f.run()).rejects.toThrow();expect(f.provider.metrics.loads).toBe(0);expect(f.provider.metrics.plans).toBe(0);expect(f.budget.stats().heldBytes).toBe(131072);await proof('budget-'+fault,mode,f);}finally{f.close();}}
});

it('LBC11: current callbacks cannot reenter the same bound scope even if the error is swallowed',async()=>{
 for(const mode of LB0_MODES){let scope:CwcCReadScope|undefined,attempts=0;const original=CwcCReadScope.prototype.load,spy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){scope=this;return original.apply(this,args);});
  const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after')f.setCurrentHook(()=>{if(!attempts++){try{scope!.gate();}catch{}}});}});try{await expect(f.run()).rejects.toThrow('source_binding');expect(attempts).toBeGreaterThan(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);await proof('current-reentry',mode,f);}finally{spy.mockRestore();f.close();}
 }
});

it('LBC12: source and phase callbacks have no internal frame or reentry privilege',async()=>{
 for(const mode of LB0_MODES)for(const boundary of ['source','phase']){let scope:CwcCReadScope|undefined;const original=CwcCReadScope.prototype.pre,spy=vi.spyOn(CwcCReadScope.prototype,'pre').mockImplementation(function(this:CwcCReadScope,...args){scope=this;return original.apply(this,args);});const reenter=()=>{try{scope!.gate();}catch{}};
  const f=lb1Fixture({mode,...(boundary==='source'?{readHook:reenter}:{hook:phase=>{if(phase==='pre-after')reenter();}})});try{await expect(f.run()).rejects.toThrow('source_binding');expect(f.provider.metrics.replies).toBe(0);await proof(boundary+'-reentry',mode,f);}finally{spy.mockRestore();f.close();}
 }
});

it('LBC13: a fake internal frame is refused and cannot rescue the outer current callback',async()=>{
 for(const mode of LB0_MODES){let scope:CwcCReadScope|undefined;const original=CwcCReadScope.prototype.load,spy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){scope=this;return original.apply(this,args);});const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after')f.setCurrentHook(()=>{try{scope!.gate({kind:'frame'});}catch{}});}});try{await expect(f.run()).rejects.toThrow('source_binding');expect(f.provider.metrics.replies).toBe(0);await proof('fake-frame',mode,f);}finally{spy.mockRestore();f.close();}}
});

it('LBC14: root/fact and source scopes close with the binding and cannot be reused',async()=>{
 for(const mode of LB0_MODES){let scope:CwcCReadScope|undefined,snapshot:any;const original=CwcCReadScope.prototype.load,spy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){scope=this;snapshot=original.apply(this,args);return snapshot;});const f=lb1Fixture({mode});try{await f.run();expect(()=>scope!.summary(snapshot)).toThrow();expect(()=>f.port!.command()).toThrow();expect(()=>f.port!.providerGate(f.provider)).toThrow();expect(()=>f.session.connected(f.call!)).toThrow();}finally{spy.mockRestore();f.close();}}
});

it('LBC15: ordinary inspect still rejects a changed dispatch copy after binding',async()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after'){const b=Buffer.from(f.inner);b[0]=0;try{f.session.inspectCall(f.call!,b);}catch{}}}});try{await expect(f.run()).rejects.toThrow();expect(f.provider.metrics.replies).toBe(0);expect(f.port!.diagnostics.call.metrics.publications).toBe(0);}finally{f.close();}}
});

it('LBC16: private source snapshot remains stable after caller storage mutation',async()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after')f.source.payloads[3]=Buffer.from('changed later').toString('base64');}});try{const r=await f.run();expect(r.metrics.replies).toBe(1);expect(r.plans[0].helper.roots).toBe(1);}finally{f.close();}}
});

it('LBC17: signed response content checks still reject modified descriptor or scalar data',async()=>{
 for(const mode of LB0_MODES)for(const api of ['aux.ReadSourceDescriptor','aux.ReadSealedSource'] as const){const f=lb1Fixture({mode,api,mutateResult:body=>{if(api==='aux.ReadSourceDescriptor')body.result.entries--;else body.result.bytes=Buffer.alloc(16,0).toString('base64');}});try{await expect(f.run()).rejects.toThrow();expect(f.session.stats(f.call!).metrics.publications).toBe(0);}finally{f.close();}}
});

it('LBC18: pin cancellation, environment stop and session close prevent successful replies',async()=>{
 for(const mode of LB0_MODES)for(const fault of ['pin','environment','session']){const f=lb1Fixture({mode,hook:phase=>{if(phase===(fault==='pin'?'post-before':'post-after')){if(fault==='pin')f.cancelPin();if(fault==='environment')f.stop();if(fault==='session')f.session.close();}}});try{await expect(f.run()).rejects.toThrow();expect(f.session.stats(f.call!).metrics.publications).toBe(0);expect(f.provider.metrics.replies).toBe(0);}finally{f.close();}}
});

it('LBC19: current callbacks cannot reenter the provider and swallow the inner rejection',async()=>{
 for(const mode of LB0_MODES){let nested:Promise<unknown>|undefined,once=false;const f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after')f.setCurrentHook(()=>{if(!once){once=true;nested=f.provider.execute(Buffer.from('{}'),f.call!).catch(e=>e);}});}});try{await expect(f.run()).rejects.toThrow('source_binding');expect(String(await nested)).toContain('source_binding');expect(f.provider.metrics.replies).toBe(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);}finally{f.close();}}
});

it('LBC20: H0 and large-entry plans retain root/facts and the same fixed budgets',async()=>{
 for(const mode of LB0_MODES)for(const sizes of [[3061,1250,20810,5057,949,635,2072,6745,881],[41456,1,1,1,1]]){const f=lb1Fixture({mode,sizes});try{const r=await f.run();expect(r.plans[0].helper.proofs).toBe(f.reference.commands.length);expect(r.diagnostics.budget.peakBytes).toBeLessThanOrEqual(1048576);expect(r.rows[0]!.spent.work).toBe(CPR_WORK.total);expect(r.diagnostics.call.metrics.fullChecks).toBeLessThanOrEqual(4096);}finally{f.close();}}
},15000);

it('LBC21: exact repetition uses a new call/root/snapshot while retaining K/D, deadline and spend',async()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode,work:2*CPR_WORK.total});try{const a=await f.run(),call=f.call,port=f.port,b=await f.run();expect(f.call).not.toBe(call);expect(f.port).not.toBe(port);expect(b.outputDigest).toBe(a.outputDigest);expect(b.rows).toHaveLength(1);expect(b.rows[0]).toMatchObject({k:a.rows[0]!.k,d:a.rows[0]!.d,deadline:a.rows[0]!.deadline,attempts:2,spent:{work:2*CPR_WORK.total}});expect(f.provider.metrics.loads).toBe(2);expect(b.plans[0].grant.scopeId).not.toBe(b.plans[1].grant.scopeId);expect(()=>port!.command()).toThrow();}finally{f.close();}}
});

it('LBC22: the CLB-0 profile alone cannot activate connection or hash elision',()=>{
 const f=lb0Fixture({mode:'bound-live'});try{const call=f.issue().call;expect(()=>f.session.connected(call)).toThrow('codec_profile_unsupported');expect(()=>f.session.dispatchConnected(call,async()=>({}))).toThrow('codec_profile_unsupported');f.bind(call);f.session.finishCall(call);expect(f.session.stats(call).metrics.fullChecks).toBe(f.session.stats(call).metrics.wireIdentityHashes);}finally{f.close();}
});

it('LBC23: early reservation rejection cannot hide callback reentry into the same scope',async()=>{
 for(const mode of LB0_MODES){let scope:CwcCReadScope|undefined;const original=CwcCReadScope.prototype.load,spy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){scope=this;return original.apply(this,args);});const ledger=new CwcCWorkLedger({work:0},CPR_WORK.plan,()=>{}),f=lb1Fixture({mode,hook:phase=>{if(phase==='load-after')f.setCurrentHook(()=>{try{scope!.reservePlan('provider',ledger);}catch{}});}});try{await expect(f.run()).rejects.toThrow('source_binding');expect(f.provider.metrics.replies).toBe(0);}finally{spy.mockRestore();f.close();}}
});

it('LBC24: watchdog reclaims private B while pending provider work retains its reservation',async()=>{
 for(const mode of LB0_MODES){vi.useFakeTimers();let resume!:()=>void;const pending=new Promise<void>(r=>resume=r),f=lb1Fixture({mode,hook:phase=>phase==='admission'?pending:undefined});
  try{const response=f.run().catch(e=>e);f.setNow(4500);await vi.advanceTimersByTimeAsync(4500);expect(String(await response)).toContain('request_expired');const expired=f.session.stats(f.call!);expect(expired.lookupPresent).toBe(false);expect(expired.bytesHeld).toBe(0);expect(expired.pendingDispatch).toBe(true);expect(expired.budget.occupiedSlots).toBe(1);expect(expired.budget.heldBytes).toBeGreaterThan(131072);
   resume();await vi.runAllTimersAsync();await proof('watchdog',mode,f);const after=f.session.stats(f.call!);expect(after.metrics.late).toBe(1);expect(after.metrics.ownerChecks).toBe(expired.metrics.ownerChecks);expect(after.metrics.channelChecks).toBe(expired.metrics.channelChecks);proofs.at(-1).expired=expired;
  }finally{resume();await vi.runAllTimersAsync();f.close();vi.useRealTimers();}
 }
});

it('LBC25: structural or prototype-spoofed adapter owners cannot register scope callbacks',()=>{
 for(const mode of LB0_MODES){const f=lb1Fixture({mode});try{const call=f.issue().call,b=f.session.connected(call);for(const owner of [{},Object.create(CwcCProvider.prototype),f.provider])expect(()=>b.start(owner,f.context,()=>{},()=>0,4500,f.inner)).toThrow('source_binding');for(const scope of [{},Object.create(CwcCReadScope.prototype)])expect(()=>b.attachScope(scope,f.context,()=>{})).toThrow('source_binding');expect(()=>f.session.finishCall(call)).toThrow('source_binding');expect(f.provider.metrics.loads).toBe(0);expect(f.session.stats(call).metrics.publications).toBe(0);}finally{f.close();}}
});

it('LBC26: reservation copies or mutable fields cannot release another call capacity',()=>{
 const budget=new Lb0Budget(undefined,1048576,156978,1),ticket=budget.reserve(1024,0,0,0,true),empty=budget.reserve(0);
 expect(()=>Object.defineProperty(ticket,'remaining',{value:1048576})).toThrow();
 expect(()=>budget.endSlot(empty)).toThrow('codec_budget_exceeded');expect(budget.stats().occupiedSlots).toBe(1);expect(budget.stats().heldBytes).toBe(1024);
 expect(()=>budget.release({...ticket})).toThrow('codec_budget_exceeded');budget.release(ticket,512);expect(budget.stats().heldBytes).toBe(512);budget.release(ticket);expect(budget.stats().heldBytes).toBe(0);budget.endSlot(ticket);expect(budget.stats().occupiedSlots).toBe(0);expect(()=>budget.endSlot(ticket)).toThrow('codec_budget_exceeded');
});

it('LBC27: source result getters cannot reenter the scope and rescue publication by swallowing rejection',async()=>{
 for(const mode of LB0_MODES)for(const field of ['commits','payloads','metadata'] as const){
  let scope:CwcCReadScope|undefined,attempts=0,innerError='';const original=CwcCReadScope.prototype.load,spy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){scope=this;return original.apply(this,args);});
  const f=lb1Fixture({mode}),value=f.source[field];Object.defineProperty(f.source,field,{enumerable:true,get(){if(attempts===0){attempts++;try{scope!.gate();}catch(e){innerError=String(e);}}return value;}});
  try{await expect(f.run()).rejects.toThrow('source_binding');expect(attempts).toBeGreaterThan(0);expect(innerError).toContain('source_binding');expect(f.provider.metrics.replies).toBe(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);await proof('source-getter-'+field,mode,f,{reentry:{boundary:'source-getter',field,attempts,innerError}});}finally{spy.mockRestore();f.close();}
 }
});

it('LBC28: owner and codec clock callbacks cannot rescue publication after swallowed scope reentry',async()=>{
 for(const mode of LB0_MODES)for(const target of ['owner','codec'] as const){
  let scope:CwcCReadScope|undefined,inTarget=false,inClock=false,attempts=0,innerError='';
  const load=CwcCReadScope.prototype.load,loadSpy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){scope=this;return load.apply(this,args);});
  // Call through the real owner/codec and the provider-supplied clock. Select only
  // their direct clock call, excluding the nested P/S live gates in the same method.
  const pack=planner.pack,packSpy=vi.spyOn(planner,'pack').mockImplementation((...args)=>{const connection=args[7]!;const next=[...args] as Parameters<typeof pack>;next[7]={...connection,now:()=>{inClock=true;try{return connection.now();}finally{inClock=false;}}};return pack(...next);});
  const open=CwcAContract.prototype.openScope,openSpy=vi.spyOn(CwcAContract.prototype,'openScope').mockImplementation(function(this:CwcAContract,...args){const previous=inTarget;inTarget=target==='owner';try{return open.apply(this,args);}finally{inTarget=previous;}});
  const prove=ClosedCwcBCodec.prototype.planProof,proofSpy=vi.spyOn(ClosedCwcBCodec.prototype,'planProof').mockImplementation(function(this:ClosedCwcBCodec,...args){const previous=inTarget;inTarget=target==='codec';try{return prove.apply(this,args);}finally{inTarget=previous;}});
  const f=lb1Fixture({mode});f.hooks.now=()=>{if(inTarget&&inClock&&attempts===0){attempts++;try{scope!.gate();}catch(e){innerError=String(e);}}};
  try{await expect(f.run()).rejects.toThrow('source_binding');expect(attempts).toBe(1);expect(innerError).toContain('source_binding');expect(f.provider.metrics.replies).toBe(0);expect(f.session.stats(f.call!).metrics.publications).toBe(0);await proof('clock-'+target+'-reentry',mode,f,{reentry:{boundary:'clock',target,attempts,innerError}});}finally{loadSpy.mockRestore();packSpy.mockRestore();openSpy.mockRestore();proofSpy.mockRestore();f.close();}
 }
});
