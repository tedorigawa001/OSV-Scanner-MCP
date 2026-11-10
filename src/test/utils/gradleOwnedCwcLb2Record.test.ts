import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateLb2Record} from '../fixtures/gradleOwnedCwcLb2Validation.mjs';
const input=()=>JSON.parse(readFileSync(process.env.CWC_LB2_RECORD_PATH??'docs/validation/gradle-cwc-lb2-2026-11-10.json','utf8'));
function check(r:any){const sources:Record<string,string>={};for(const p of Object.keys(r.sourceBindings)){expect((p.startsWith('src/')||p.startsWith('scripts/')||['package-lock.json','tsconfig.json','vitest.config.ts'].includes(p))&&!p.split('/').includes('..')).toBe(true);sources[p]=createHash('sha256').update(readFileSync(p)).digest('hex');}return validateLb2Record(r,sources);}
it('LB2R01: real transport, reconstruction, lifecycle and use/ACK evidence revalidates',()=>{expect(check(input())).toEqual({testsPassed:14,recordTestsPassed:8,samples:6,proofs:26,performanceComparison:false,productionAdopted:false});});
it('LB2R02: duplicate or missing transfers, entries and per-batch facts reject',()=>{for(const kind of ['duplicate','entry','fact','dispatch']){const r=input(),s=r.measurement.samples[0];if(kind==='duplicate')r.measurement.samples[1]=structuredClone(s);if(kind==='entry')s.inventory.rows.pop();if(kind==='fact')s.plans[0].helper.proofs--;if(kind==='dispatch')s.server.dispatches--;expect(()=>check(r)).toThrow();}});
it('LB2R03: final validation omission and reclaim before final verification reject',()=>{for(const kind of ['count','bytes','order']){const r=input(),c=r.measurement.samples[0].calls[0];if(kind==='count')c.finalChecks=0;if(kind==='bytes')c.bytesAtFinal=0;if(kind==='order'){const i=c.events.indexOf('transport-final'),j=c.events.indexOf('binding-settled');[c.events[i],c.events[j]]=[c.events[j],c.events[i]];}expect(()=>check(r)).toThrow();}});
it('LB2R04: pending dispatch capacity release, late success and consumption refund reject',()=>{for(const kind of ['slot','late','success','spend']){const r=input(),p=r.measurement.proofs.find((p:any)=>p.id==='cancel-pending'),c=p.calls.at(-1);if(kind==='slot')p.expired.control.budget.occupiedSlots=0;if(kind==='late')c.control.metrics.late=0;if(kind==='success')c.control.metrics.publications=1;if(kind==='spend')c.budget.work=-1;expect(()=>check(r)).toThrow();}});
it('LB2R05: lost proof, outcome promotion, forged receipt or premature ACK evidence rejects',()=>{for(const kind of ['missing','outcome','receipt','ack']){const r=input();if(kind==='missing')r.measurement.proofs.pop();if(kind==='outcome')r.measurement.proofs.find((p:any)=>p.id==='signed-unknown').outcome.outcome='refused';const p=r.measurement.proofs.find((p:any)=>p.id==='use-ack');if(kind==='receipt')p.useReceiptDigest='0'.repeat(64);if(kind==='ack')p.forgedAckRejected=false;expect(()=>check(r)).toThrow();}});
it('LB2R06: native, performance, storage or production claims and source replacement reject',()=>{for(const kind of ['nativeIsolation','externalStorageService','performanceComparison','productionAdopted','source']){const r=input();if(kind==='source')r.sourceBindings['src/test/fixtures/gradleOwnedCwcLb2Link.ts']='0'.repeat(64);else r.scope[kind]=true;expect(()=>check(r)).toThrow();}});
it('LB2R07: nonnegative initialization/work/wire reductions on retry reject in both modes even when budget copies agree',()=>{
 // Hold the saved source map fixed so source-file edits cannot mask a ledger-validation failure.
 const baseline=input();validateLb2Record(baseline,baseline.sourceBindings);
 for(const mode of ['full-reference','bound-live'])for(const field of ['initialization','work','wire'])for(const reduction of ['zero','one']){
  const r=input(),p=r.measurement.proofs.find((p:any)=>p.id==='response-lost'&&p.mode===mode);
  for(const c of p.calls.slice(-2))for(const b of [c.budget,c.control.budget,c.binding.budget,c.binding.call.budget]){expect(b[field]).toBeGreaterThan(1);b[field]=reduction==='zero'?0:b[field]-1;}
  expect(()=>validateLb2Record(r,r.sourceBindings)).toThrow('lb2_record_consumption');
 }
});
it('LB2R08: coherent snapshot/reservation reductions, retry resets and advanced commit omissions reject',()=>{
 const baseline=input();validateLb2Record(baseline,baseline.sourceBindings);
 const keys=['initialization','work','wire','attempts'];
 for(const mode of ['full-reference','bound-live'])for(const field of ['initialization','work','wire'])for(const fault of ['zero','one','reset']){
  const r=input(),p=r.measurement.proofs.find((p:any)=>p.id==='response-lost'&&p.mode===mode),pair=p.calls.slice(-2);let previous:any={initialization:0,work:0,wire:0,attempts:0};
  for(const [index,c]of pair.entries()){
   const a=c.accounting;a.before={...previous};if(fault==='reset'&&index===1)a.before[field]=0;
   let balance={...a.before},reduced=false;
   for(const [at,charge]of a.reservations.entries()){
    if(fault==='zero')charge[field]=0;
    if(fault==='one'&&!reduced&&charge[field]>0){charge[field]--;reduced=true;}
    charge.before={...balance};balance={initialization:balance.initialization+charge.initialization,work:balance.work+charge.work,wire:balance.wire+charge.wire,attempts:balance.attempts+(charge.slot?1:0)};charge.after={...balance};if(at===3)a.captured={...balance};
   }
   a.after={...balance};previous=balance;
  }
  for(const c of pair)for(const b of [c.budget,c.control.budget,c.binding.budget,c.binding.call.budget])for(const key of keys)b[key]=previous[key];
  expect(()=>validateLb2Record(r,r.sourceBindings)).toThrow('lb2_record_consumption');
 }
 for(const mode of ['full-reference','bound-live'])for(const fault of ['commit','partition','missing-ledger']){
  const r=input(),p=r.measurement.proofs.find((p:any)=>p.id==='advanced-snapshot'&&p.mode===mode);
  if(fault==='commit')p.reconstructed.commits.pop();if(fault==='partition')p.reconstructed.payloads.unshift(p.reconstructed.commits.pop());if(fault==='missing-ledger')delete p.calls[0].accounting;
  expect(()=>validateLb2Record(r,r.sourceBindings)).toThrow();
 }
});
