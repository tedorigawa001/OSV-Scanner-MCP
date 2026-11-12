import {it,expect,beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {r0Matrix} from '../fixtures/gradleOwnedCwcR0Fixture.js';
import {r0Differential} from '../fixtures/gradleOwnedCwcR0Differential.js';
import {validateR0Evidence,validateR0Differential,validateR0Review,compareR0Replay,r0SourceAudit} from '../fixtures/gradleOwnedCwcR0Validation.mjs';
import {r0FailureCases} from '../fixtures/gradleOwnedCwcR0FailureCases.js';
let saved:any,fresh:any;
beforeAll(()=>{const r=JSON.parse(readFileSync(process.env.CWC_R0_RECORD_PATH??'docs/validation/gradle-cwc-r0-2026-11-12.json','utf8'));saved={evidence:r.evidence,differential:r.differential,audit:r.audit,review:r.review};fresh={evidence:r0Matrix(),differential:r0Differential(),audit:r0SourceAudit(),review:r0FailureCases()};},60000);
function verify(e:any){validateR0Evidence(e.evidence);validateR0Differential(e.differential);validateR0Review(e.review);compareR0Replay(e,fresh);}
function reject(edit:(e:any)=>void){const e=structuredClone(saved);edit(e);expect(()=>verify(e)).toThrow();}
it('R0R01: saved evidence matches independent lifecycle/budget rules and exact fresh source-bound replay',()=>{verify(saved);});
it('R0R02: frame phase or actor movement preserving all event totals is rejected',()=>{reject(e=>{const t=e.evidence.rows.at(-1).before.trace,a=t.find((x:any)=>x.kind==='enter:normalize'),b=t.find((x:any)=>x.kind==='enter:expected');[a.kind,b.kind]=[b.kind,a.kind];});});
it('R0R03: duplicate/missing events with restored sequence and unchanged totals are rejected',()=>{reject(e=>{const t=e.evidence.rows[0].before.trace,i=t.findIndex((x:any)=>x.kind==='captured'),j=t.findIndex((x:any)=>x.kind==='compared');t[j]={...t[i],seq:j};});});
it('R0R04: coordinated consumption reduction cannot shrink maximum reservations or prepaid work',()=>{for(const k of ['heldBytes','work','initialization'])reject(e=>{const r=e.evidence.rows[0];r.before.budget[k]--;if(k!=='heldBytes')r.after.budget[k]--;});});
it('R0R05: changing n/ordinal recipe or issuing a ninth distinct core handle is rejected',()=>{reject(e=>{e.evidence.rows[0].n=19;});reject(e=>{e.evidence.rows[0].before.coreHandleAllocations=1;});reject(e=>{e.evidence.rows[0].alias=false;});});
it('R0R06: coordinated oracle/retained-row replacement requires independent fresh replay',()=>{reject(e=>{const r=e.evidence.rows[0];r.oracle[0][0]='a'.repeat(64);r.after.finalRows[0][0]='a'.repeat(64);});});
it('R0R07: zeroed counters cannot hide an active frame, token source or registered buffer',()=>{reject(e=>{e.evidence.rows[0].after.liveBuffers=1;});reject(e=>{e.evidence.rows[0].after.zeroVerified=false;});reject(e=>{const r=e.evidence.rows[0];r.before.slotPeak=2;r.after.slotPeak=2;});});
it('R0R08: duplicate differential cases and coordinated oracle acceptance changes are rejected',()=>{reject(e=>{e.differential.rows[1]={...e.differential.rows[0]};});reject(e=>{const r=e.differential.rows.find((r:any)=>r.id==='semantic:ordinal');r.legacy=r.owned=true;});});
it('R0R09: changing a lifetime anchor and its digest cannot promote an unsupported memory claim',()=>{reject(e=>{e.audit.sites[0].line++;e.audit.sites[0].sha256='a'.repeat(64);});reject(e=>{e.evidence.rows[0].before.scope.metadataChargeProved=true;});});
it('R0R10: negative/nonfinite counters and native-hash/work/adoption promotions are rejected',()=>{for(const value of [-1,NaN,Infinity])reject(e=>{e.evidence.rows[0].before.native.hashBytes=value;});for(const k of ['nativeHashUpperBoundProved','completeWorkCoverage','actualAB','productionAdopted'])reject(e=>{e.evidence.rows[0].before.scope[k]=true;});});
it('R0R11: review evidence cannot hide a live owner, refund consumption or retain a previous parser source',()=>{
 reject(e=>{e.review.rows[0].lookup=true;});reject(e=>{e.review.rows[0].work=e.review.rows[0].prepaidWork=0;});reject(e=>{e.review.rows[6].sourceBound=true;});reject(e=>{e.review.rows[6].prior--;});
});
