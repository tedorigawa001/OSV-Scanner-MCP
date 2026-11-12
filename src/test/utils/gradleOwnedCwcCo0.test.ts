import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {CO0_RECIPE,parseCo0Recipe} from '../fixtures/gradleOwnedCwcCo0Contract.js';
import {co0Fixture,runCo0Matrix} from '../fixtures/gradleOwnedCwcCo0Fixture.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {Co0Approval} from '../fixtures/gradleOwnedCwcCo0Approval.js';
const capture=(f:ReturnType<typeof co0Fixture>,w:ReturnType<ReturnType<typeof co0Fixture>['owner']['open']>)=>{for(let i=0;i<19;i++)f.owner.capture(w);};

it('COF01: strict fixture recipe rejects unknown fields and claimed complete coverage',()=>{
 expect(parseCo0Recipe(CO0_RECIPE)).toEqual(CO0_RECIPE);
 expect(()=>parseCo0Recipe({...CO0_RECIPE,extra:true})).toThrow();
 expect(()=>parseCo0Recipe({...CO0_RECIPE,coverage:'complete'})).toThrow();
 let getterReads=0;const input={...CO0_RECIPE};Object.defineProperty(input,'profile',{enumerable:true,get(){getterReads++;return CO0_RECIPE.profile;}});
 expect(()=>parseCo0Recipe(input)).toThrow();expect(getterReads).toBe(0);
});
it('COF20: same-length stored-byte mutation after normalization fails the full candidate comparison',()=>{
 const f=co0Fixture({fault:'row-after-normalize'}),[claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
 capture(f,w);expect(()=>f.owner.process(w)).toThrow('co0_candidate_mismatch');const s=f.owner.stats();
 expect(s.expectedBuilds).toBe(1);expect(s.comparedRows).toBe(0);expect(s.proofs).toBe(0);expect(s.budget.heldBytes).toBe(0);
});
it('COF17: the independent recipe/source pin refuses replacements and revocation is sticky',()=>{
 const f=co0Fixture(),a=f.approval,sources={...a.sources,'src/test/fixtures/gradleOwnedCwcCo0.ts':Buffer.from('replacement')};
 expect(()=>new Co0Approval(a.envelope,a.registry,a.pin,sources)).toThrow('co0_profile_unsupported');
 const changed=structuredClone(a.envelope);changed.manifest.recipeDigest='f'.repeat(64);
 expect(()=>new Co0Approval(changed,a.registry,a.pin,a.sources)).toThrow('co0_profile_unsupported');
 a.view.revoke();expect(()=>f.owner.claim()).toThrow('co0_profile_unsupported');expect(f.budget.stats().heldBytes).toBe(0);
});
it('COF18: new fixture owners retain the same parent managed spending after failures',()=>{
 const budget=new Lb0Budget(undefined,1048576,20479);
 for(let i=0;i<2;i++){const f=co0Fixture({budget,fault:'retain-input'}),[claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
  capture(f,w);expect(()=>f.owner.process(w)).toThrow('co0_slot_exhausted');expect(budget.stats().initialization).toBe((i+1)*4096);expect(budget.stats().work).toBe((i+1)*4096);expect(budget.stats().heldBytes).toBe(0);
 }
 expect(()=>co0Fixture({budget})).toThrow('codec_budget_exceeded');expect(budget.stats().initialization+budget.stats().work).toBe(16384);
});
it('COF19: two internally valid families with different private plans cannot compare equal',()=>{
 const f=co0Fixture({kind:'client'}),claims=f.owner.claim();
 for(const [i,actor]of (['client-initial','client-seal'] as const).entries()){
  if(i===1)f.core.seed='x'.repeat(128);const w=f.owner.open(claims[i]!,f.owner.identity(actor),f.core);capture(f,w);for(let n=0;n<19;n++)f.owner.process(w);
 }
 expect(f.owner.stats().comparedRows).toBe(38);expect(()=>f.owner.compareFamilies()).toThrow('co0_family_mismatch');expect(f.budget.stats().heldBytes).toBe(0);
});
it('COF16: repeated protocol entries cannot run outside the prepaid managed budget',()=>{
 const f=co0Fixture();f.owner.claim();expect(()=>{for(let i=0;i<1000;i++){f.owner.holdDispatch();f.owner.settleDispatch();}}).toThrow('codec_budget_exceeded');
 const s=f.owner.stats();expect(s.alive).toBe(false);expect(s.budget.heldBytes).toBe(0);expect(s.budget.work).toBe(4096);expect(s.managedOperations).toBeLessThanOrEqual(8192);
});
it('COF15: client equality is one-shot and cannot be reused as another completion',()=>{
 const f=co0Fixture({kind:'client'}),claims=f.owner.claim();for(const [i,actor]of (['client-initial','client-seal'] as const).entries()){
  const w=f.owner.open(claims[i]!,f.owner.identity(actor),f.core);capture(f,w);for(let n=0;n<19;n++)f.owner.process(w);
 }
 expect(f.owner.compareFamilies()).toBe('storage-equal');expect(()=>f.owner.compareFamilies()).toThrow('co0_state');expect(f.budget.stats().heldBytes).toBe(0);
});
it('COF14: terminal owners retain pending storage until one late continuation drains it',()=>{
 const f=co0Fixture(),[claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
 f.owner.holdDispatch();f.owner.invalidate('cancelled');const held=f.budget.stats().heldBytes;expect(held).toBeGreaterThan(0);
 expect(()=>f.owner.capture(w)).toThrow();expect(f.budget.stats().heldBytes).toBe(held);
 expect(f.owner.settleDispatch()).toBe('late-rejected');expect(f.budget.stats().heldBytes).toBe(0);expect(f.owner.stats().lateRejected).toBe(1);
 expect(()=>f.owner.settleDispatch()).toThrow('co0_state');f.owner.close();expect(f.budget.stats().heldBytes).toBe(0);
});
it('COF08: unreserved scratch, expected mismatch, row tampering and capture failure stop without a fact',()=>{
 for(const fault of ['unreserved-scratch','expected-mismatch','row-tamper','capture-failure'] as const){
  const f=co0Fixture({fault}),[claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
  expect(()=>{capture(f,w);f.owner.process(w);}).toThrow();const s=f.owner.stats();expect(s.alive).toBe(false);expect(s.comparedRows).toBe(0);
  expect(s.proofs).toBe(0);expect(s.publications).toBe(0);expect(s.budget.work).toBe(4096);expect(s.budget.initialization).toBe(4096);expect(s.budget.heldBytes).toBe(0);
  if(fault==='unreserved-scratch')expect(s.expectedBuilds).toBe(0);f.owner.close();
 }
});
it('COF09: forged or copied identity/claim is rejected before reading the supplied core',()=>{
 for(const wrong of ['identity','claim'] as const){const f=co0Fixture(),[claim]=f.owner.claim();let reads=0;
  const core={get groups(){reads++;throw Error('must not read');}};
  expect(()=>f.owner.open(wrong==='claim'?{...claim!}:claim!,wrong==='identity'?{...f.owner.identity('provider')}:f.owner.identity('provider'),core)).toThrow('co0_binding');
  expect(reads).toBe(0);expect(f.owner.stats().capturedRows).toBe(0);expect(f.budget.stats().heldBytes).toBe(0);
 }
});
it('COF10: caller context/core mutation cannot change already owned candidate and expected values',()=>{
 const f=co0Fixture(),[claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
 f.context.peer.instanceId='changed';f.core.seed='changed';f.core.groups[0]![0]!.length=4096;
 capture(f,w);for(let i=0;i<19;i++)f.owner.process(w);expect(f.owner.stats().comparedRows).toBe(19);f.owner.close();
});
it('COF11: client seal cannot enter before initial storage completion or reuse another claim',()=>{
 const f=co0Fixture({kind:'client'}),claims=f.owner.claim();
 expect(()=>f.owner.open(claims[1]!,f.owner.identity('client-seal'),f.core)).toThrow('co0_actor_busy');
 expect(()=>f.owner.open(claims[0]!,f.owner.identity('client-initial'),f.core)).toThrow();expect(f.budget.stats().heldBytes).toBe(0);
 const other=co0Fixture(),[claim]=other.owner.claim();other.owner.open(claim!,other.owner.identity('provider'),other.core);
 expect(()=>other.owner.open(claim!,other.owner.identity('provider'),other.core)).toThrow('co0_binding');expect(other.budget.stats().heldBytes).toBe(0);
});
it('COF12: caught callback reentry poisons the outer operation at every storage boundary',()=>{
 for(const target of ['build-before','build-after','normalize-before','expected-before','compare-after']){
  let w:any,hit=0;const f=co0Fixture({hook:(site,owner)=>{if(site===target&&!hit++){try{owner.process(w);}catch{}}}}),[claim]=f.owner.claim();w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
  expect(()=>{capture(f,w);f.owner.process(w);}).toThrow('co0_reentrant');expect(hit).toBeGreaterThan(0);expect(f.owner.stats().comparedRows).toBe(0);
  expect(f.budget.stats().heldBytes).toBe(0);expect(f.budget.stats().work).toBe(4096);f.owner.close();
 }
});
it('COF13: original fixed deadline and owned source revocation stop the next operation and preserve spending',()=>{
 for(const reason of ['deadline','revoke'] as const){const f=co0Fixture(),[claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
  capture(f,w);if(reason==='deadline')f.clock.advance(4500);else f.approval.view.revoke();
  expect(()=>f.owner.process(w)).toThrow();const s=f.owner.stats();expect(s.comparedRows).toBe(0);expect(s.budget.heldBytes).toBe(0);expect(s.budget.work).toBe(4096);
  expect(()=>f.owner.capture(w)).toThrow();f.owner.close();
 }
});
it('COF07: a retained input denies the fourth lease before expected construction',()=>{
 const f=co0Fixture({fault:'retain-input'});const [claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
 for(let i=0;i<19;i++)f.owner.capture(w);expect(()=>f.owner.process(w)).toThrow('co0_slot_exhausted');
 const s=f.owner.stats();expect(s.slotPeak).toBe(3);expect(s.comparedRows).toBe(0);expect(s.budget.heldBytes).toBe(0);
 expect(s.trace.some((r:any)=>r.kind==='input-retired')).toBe(false);expect(s.trace.some((r:any)=>r.kind==='expected')).toBe(false);
 expect(s.expectedBuilds).toBe(0);expect(s.budget.work).toBe(4096);
});
it('COF06: cell retirement follows child frame return before the next phase',()=>{
 const f=co0Fixture();try{const [claim]=f.owner.claim(),w=f.owner.open(claim!,f.owner.identity('provider'),f.core);
  for(let i=0;i<19;i++)f.owner.capture(w);f.owner.process(w);
  const t=f.owner.stats().trace;
  const captureExit=t.findIndex((r:any)=>r.kind==='frame-exit'&&r.extra===1);
  expect(captureExit).toBeGreaterThan(0);expect(t.findIndex((r:any)=>r.kind==='release')).toBeGreaterThan(captureExit);
  const normalizeExit=t.findIndex((r:any)=>r.kind==='frame-exit'&&r.extra===3);
  expect(t.findIndex((r:any)=>r.kind==='input-retired')).toBeGreaterThan(normalizeExit);
  expect(t.find((r:any)=>r.kind==='frame-exit'&&r.extra===4)?.active).toBe(3);
 }finally{f.owner.close();}
});
it('COF05: diagnostic copies cannot change retained trace or private storage',()=>{
 const f=co0Fixture();const claims=f.owner.claim(),w=f.owner.open(claims[0]!,f.owner.identity('provider'),f.core);
 for(let i=0;i<19;i++)f.owner.capture(w);for(let i=0;i<19;i++)f.owner.process(w);f.owner.close();
 const b=structuredClone(f.owner.stats()),a=f.owner.stats();a.trace[0]!.kind='forged' as any;
 expect(f.owner.stats().trace).toEqual(b.trace);a.children[0]!.state='forged';expect(f.owner.stats().children[0]!.state).toBe('failed');
});
it('COF04: reservations fail before candidate allocation and retain constructor initialization',()=>{
 const f=co0Fixture({kind:'client'});f.owner.claim();const peak=f.budget.stats().peakBytes;f.owner.close();
 for(const budget of [new Lb0Budget(undefined,peak-1),new Lb0Budget(undefined,1048576,4096)]){
  const failed=co0Fixture({kind:'client',budget});expect(()=>failed.owner.claim()).toThrow('codec_budget_exceeded');
  const s=failed.owner.stats();expect(s.slabAllocations).toBe(0);expect(s.capturedRows).toBe(0);expect(s.budget.heldBytes).toBe(0);
  expect(s.budget.initialization).toBe(4096);expect(s.budget.work).toBe(0);failed.owner.close();
 }
});
it('COF03: role/boundary/client-provider matrix compares private families with independent cells',()=>{
 const evidence=runCo0Matrix();expect(evidence.rows).toHaveLength(24);
 for(const r of evidence.rows){expect(r.error).toBeNull();expect(r.beforeClose.comparedRows).toBe(r.kind==='provider'?19:38);
  expect(r.beforeClose.slotPeak).toBe(3);expect(r.afterClose.budget.heldBytes).toBe(0);
  expect(r.afterClose.budget.initialization).toBe(4096);expect(r.afterClose.budget.work).toBe(r.kind==='provider'?4096:8192);
  expect(r.equality).toBe(r.kind==='provider'?null:'storage-equal');
 }
 if(process.env.CWC_CO0_EVIDENCE_PATH)writeFileSync(process.env.CWC_CO0_EVIDENCE_PATH,JSON.stringify(evidence));
},60000);
it('COF02: private candidate slabs preserve nineteen commands without issuing proof or publication',()=>{
 const f=co0Fixture();try{const claims=f.owner.claim(),w=f.owner.open(claims[0]!,f.owner.identity('provider'),f.core);
  for(let i=0;i<19;i++)expect(f.owner.capture(w)).toBeUndefined();
  for(let i=0;i<19;i++)expect(f.owner.process(w)).toBeUndefined();
  const s=f.owner.stats();expect(s.comparedRows).toBe(19);expect(s.sourceBytes).toBe(41460);expect(s.slotPeak).toBe(3);
  expect(s.publications).toBe(0);expect(s.scope.realAandB).toBe(false);expect(s.scope.threeSlotBoundEstablished).toBe(false);
  expect(()=>f.owner.finish(w)).toThrow('co0_proof_unavailable');
 }finally{f.owner.close();}expect(f.budget.stats().heldBytes).toBe(0);
});
