import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {r1oMatrix,r1oReviewMatrix} from '../fixtures/gradleOwnedCwcR1oFixture.js';
import {compareR1oReplay,validateR1oEvidence,r1oHash,validateR1oReview,compareR1oReview} from '../fixtures/gradleOwnedCwcR1oValidation.mjs';
const fresh=r1oMatrix(),clone=()=>structuredClone(fresh),reject=(fn:(e:typeof fresh)=>void)=>{const x=clone();fn(x);expect(()=>validateR1oEvidence(x)).toThrow('r1o_record');};
it('R1OR01: the stored evidence replays all cases with independent lifecycle checks',()=>{
 const path=process.env.CWC_R1O_RECORD_PATH??'docs/validation/gradle-cwc-r1o-2026-11-13.json',r=JSON.parse(readFileSync(path,'utf8'));
 expect(r.schema).toBe('cwc-r1o.record.v1');expect(r.status).toBe('ownership-only');expect(r.evidenceDigest).toBe(r1oHash(r.evidence));expect(r.summary).toEqual(validateR1oEvidence(r.evidence));compareR1oReplay(r.evidence,fresh);
});
it('R1OR02: duplicate/missing cases are refused with total count maintained',()=>reject(e=>{e.successes[1]=e.successes[0]!;}));
it('R1OR03: validation cannot move before an existing borrow drains',()=>reject(e=>{const t=e.successes[0]!.published.trace,a=t.findIndex(x=>x.kind==='borrow-close'),b=t.findIndex(x=>x.kind==='enter:complete-validation');[t[a]!.kind,t[b]!.kind]=[t[b]!.kind,t[a]!.kind];}));
it('R1OR04: retained references cannot be removed from a waiting observation',()=>reject(e=>{e.successes[0]!.waiting.borrowReferences=0;e.successes[0]!.waiting.borrowUsesPinnedStore=false;}));
it('R1OR05: store/ticket custody and shell identity cannot be asserted with false identity',()=>{for(const key of ['sameStore','sameLease','sameDestinationScope'] as const)reject(e=>{e.successes[0]!.published[key]=false;});});
it('R1OR06: coordinated zero consumption cannot erase refused work or initialization',()=>reject(e=>{for(const x of [e.refusals[0]!.after,e.refusals[0]!.inside!])x.budget.work=x.budget.initialization=0;}));
it('R1OR07: zeroing inside the callback and early release are refused',()=>{reject(e=>{e.refusals[0]!.inside!.zeroedBytes=1;});reject(e=>{e.refusals[0]!.inside!.released=true;});});
it('R1OR08: modified digests still fail fresh replay after coordinated saved updates',()=>{
 const x=clone(),r=x.successes[0]!,d='f'.repeat(64);r.before.core=r.after.core=d;for(const s of [r.published,r.drained,r.secondClose])s.coreDigest=d;
 expect(()=>compareR1oReplay(x,fresh)).toThrow('r1o_record');
});
it('R1OR09: ownership evidence cannot promote unproved production/budget/layout assertions',()=>{for(const key of ['productionAdopted','wholeBudgetCoexistenceProved','actualParentLedgerVector','handleRoleLayoutProved','nativeHashBoundProved'] as const)reject(e=>{e.successes[0]!.published.scope={...e.successes[0]!.published.scope,[key]:true};});});
it('R1OR10: phase counts and release counts cannot hide repeated publication or cleanup',()=>{reject(e=>{e.successes[0]!.published.publications=2;});reject(e=>{e.successes[0]!.drained.releases=2;});reject(e=>{e.refusals[0]!.after.deniedWrites=0;});});
it('R1OR11: review records reject replacement execution, hidden pending lifetime, early zero and publication',()=>{
 const path=process.env.CWC_R1O_RECORD_PATH??'docs/validation/gradle-cwc-r1o-2026-11-13.json',r=JSON.parse(readFileSync(path,'utf8'));expect(r.reviewDigest).toBe(r1oHash(r.review));expect(r.reviewSummary).toEqual(validateR1oReview(r.review));
 for(const mutate of [(x:any)=>x.operationBudgets[0].operationCalls=1,(x:any)=>x.constructorBudgets[0].refused=false,(x:any)=>x.asyncCallbacks[0].waiting.pendingCallbacks=0,(x:any)=>x.asyncCallbacks[0].waiting.zeroedBytes=1,(x:any)=>x.asyncCallbacks[0].after.publications=1,(x:any)=>{for(const s of ['waiting','closed','after','late'])x.asyncCallbacks[0][s].budget.work=0;}]){
  const x=structuredClone(r.review);mutate(x);expect(()=>validateR1oReview(x)).toThrow('r1o_record');
 }
});
it('R1OR12: review cases are freshly replayed and coordinated byte accounting cannot replace observation',async()=>{
 const path=process.env.CWC_R1O_RECORD_PATH??'docs/validation/gradle-cwc-r1o-2026-11-13.json',r=JSON.parse(readFileSync(path,'utf8')),fresh=await r1oReviewMatrix();compareR1oReview(r.review,fresh);
 const x=structuredClone(r.review);for(const key of ['waiting','closed','after','late']){const s=x.asyncCallbacks[0][key];s.allocatedBytes++;if(s.released)s.zeroedBytes++;}expect(()=>validateR1oReview(x)).not.toThrow();expect(()=>compareR1oReview(x,fresh)).toThrow('r1o_record');
});
