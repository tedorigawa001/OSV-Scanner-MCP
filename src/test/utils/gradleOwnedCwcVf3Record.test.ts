import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {validateVf3Row,validateVf3Measurement,summarizeVf3} from '../fixtures/gradleOwnedCwcVf3Validation.mjs';
const load=()=>JSON.parse(readFileSync(process.env.CWC_VF3_RECORD_PATH??'docs/validation/gradle-cwc-vf3-2026-11-11.json','utf8'));
it('VF3 evidence binds all 288 attempts to signed source approvals and recomputes the complete decision',()=>{const r=load();expect(validateVf3Measurement(r.measurement,r.sourceBindings)).toEqual(r.measurement.summary);});
const complete=()=>structuredClone(load().measurement.rows.find((r:any)=>r.status==='complete'&&r.observation==='timed'&&r.arm==='batch/fact-live'));
for(const field of ['constructionMs','totalMs'])it('rejects inflated or nonfinite '+field,()=>{for(const value of [-1,NaN,Infinity,99999]){const r=complete();r[field]=value;expect(()=>validateVf3Row(r)).toThrow();}});
it('rejects plan inflation even if plan sums and result claims are changed together',()=>{const r=complete();r.planTiming.clientPlanMs+=10000;r.result.clientPlanMs+=10000;expect(()=>validateVf3Row(r)).toThrow();});
it('rejects a reduced exclusive time partition and negative buckets',()=>{const r=complete();r.trace.buckets['endpoint.now'].exclusiveMs=-1;expect(()=>validateVf3Row(r)).toThrow();const s=complete();s.trace.otherMs=0;expect(()=>validateVf3Row(s)).toThrow();});
it('rejects whole observation counters reduced without changing call evidence',()=>{const r=complete();r.trace.entries['control.receive']--;r.trace.buckets['control.receive'].calls--;expect(()=>validateVf3Row(r)).toThrow();});
it('rejects reduced logical checks and work consumption even when aggregate values are reduced together',()=>{const r=complete(),c=r.calls[0];c.control.verification.logical--;c.control.verification.sites.finish--;c.control.metrics.fullChecks--;r.audit.logical--;r.audit.fullChecks--;expect(()=>validateVf3Row(r)).toThrow();});
it('rejects failures whose budget audit exceeds its limit',()=>{const r=structuredClone(load().measurement.rows.find((r:any)=>r.status==='failed')??complete());r.audit.callWork=156979;expect(()=>validateVf3Row(r)).toThrow();});
it('rejects altered actual wire and a claimed normalization that is not exactly a TTL digit change',()=>{const r=complete();r.frames[0].frame--;expect(()=>validateVf3Row(r)).toThrow();});
it('rejects missing or duplicated trials without silently excluding a failure or warmup',()=>{const r=load();r.measurement.rows[0]=r.measurement.rows[1];expect(()=>summarizeVf3(r.measurement.rows)).toThrow();});
it('rejects changed source digests even when the record summary is unchanged',()=>{const r=load();r.sourceBindings['src/test/fixtures/gradleOwnedCwcVf0Authority.ts']='0'.repeat(64);expect(()=>validateVf3Measurement(r.measurement,r.sourceBindings)).toThrow();});
it('rejects shortened or renewed original deadline with the elapsed total left unchanged',()=>{const r=complete();r.deadline++;expect(()=>validateVf3Row(r)).toThrow();});
it('rejects zeroed client prepayment and a reduced provider row despite unchanged aggregate upper bounds',()=>{for(const kind of ['client','provider']){const r=complete();if(kind==='client')r.audit.clientWork=0;else r.providerRows[0].spent.work=0;expect(()=>validateVf3Row(r)).toThrow();}});
it('rejects a removed prepayment receipt even when row work is coordinated downward',()=>{const r=complete(),c=r.calls.find((c:any)=>c.api==='aux.ReadSourceRanges');c.sourceAccounting.spend.planFloor=null;c.sourceAccounting.rowAfter.spent.work-=156978;expect(()=>validateVf3Row(r)).toThrow();});

for(const mode of ['full-verify','fact-live'])it('VF3R15 '+mode+': rejects understated provider plan time even when both claims are reduced together',()=>{
 const original=load().measurement.rows.find((r:any)=>r.status==='complete'&&r.arm==='batch/'+mode);
 validateVf3Row(original);expect(original.planTiming.providerPlanMs).toBeGreaterThan(0);
 for(const value of [0,original.planTiming.providerPlanMs/2]){
  const row=structuredClone(original);row.planTiming.providerPlanMs=value;row.result.providerPlanMs=value;
  expect(row.planTiming.windows).toEqual(original.planTiming.windows);
  expect(()=>validateVf3Row(row)).toThrow();
 }
});
