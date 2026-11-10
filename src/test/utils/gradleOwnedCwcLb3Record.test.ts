import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateLb3Measurement,validateLb3Row,summarizeLb3} from '../fixtures/gradleOwnedCwcLb3Validation.mjs';
const path=process.env.CWC_LB3_RECORD_PATH??'docs/validation/gradle-cwc-lb3-2026-11-10.json';
const record=()=>JSON.parse(readFileSync(path,'utf8'));
function validate(r:any){expect(r.schema).toBe('cwc-lb3.validation.v2');for(const [p,h]of Object.entries(r.sourceBindings))expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(h);return validateLb3Measurement(r.measurement,r.sourceBindings);}
it('LBR301: fresh sources, signed approval closure, complete real-time matrix and recomputed adoption',()=>{const r=record();const s=validate(r);expect(s.attempted).toBe(162);expect(s.productionAdopted).toBe(false);});
it('LBR302: dropped/duplicated failed or warm-up rows cannot improve completion rate',()=>{for(const duplicate of [false,true]){const r=record();if(duplicate)r.measurement.rows[1]=structuredClone(r.measurement.rows[0]);else r.measurement.rows.splice(0,1);expect(()=>validateLb3Measurement(r.measurement,r.sourceBindings)).toThrow();}});
it('LBR303: setup/cleanup omission and total/phase overstatement are rejected',()=>{for(const change of [(r:any)=>r.totalMs=r.result?.wallMs??0,(r:any)=>r.cleanupMs=0,(r:any)=>r.constructionMs+=1]){const r=record().measurement.rows.find((r:any)=>r.status==='complete');change(r);expect(()=>validateLb3Row(r)).toThrow();}});
it('LBR304: counter/bucket common omissions and duplicated handshake ids are rejected',()=>{for(const change of [(r:any)=>{delete r.trace.entries['scope.load'];delete r.trace.buckets['scope.load'];},(r:any)=>{r.trace.entries['control.receive']--;r.trace.buckets['control.receive'].calls--;},(r:any)=>r.trace.handshakes[1].id=r.trace.handshakes[0].id]){const r=record().measurement.rows.find((r:any)=>r.status==='complete'&&r.observation==='timed');change(r);expect(()=>validateLb3Row(r)).toThrow();}});
it('LBR305: observer cost partition, non-finite values and inclusive inflation fail closed',()=>{for(const change of [(r:any)=>r.trace.otherMs+=1,(r:any)=>r.totalMs=Infinity,(r:any)=>r.trace.buckets['json.ownedSha256'].inclusiveMs=r.trace.wallMs+1,(r:any)=>r.trace.buckets['json.ownedSha256'].exclusiveMs=-1]){const r=record().measurement.rows.find((r:any)=>r.status==='complete'&&r.observation==='timed');change(r);expect(()=>validateLb3Row(r)).toThrow();}});
it('LBR306: a changed profile/approval or missing source is rejected independently of summary',()=>{for(const change of [(r:any)=>r.measurement.approvals[0].record.comparison.envelope.manifest.conditionsDigest='0'.repeat(64),(r:any)=>delete r.sourceBindings['src/test/fixtures/gradleOwnedCwcLb3Case.ts'],(r:any)=>r.measurement.rows[0].codePin='0'.repeat(64)]){const r=record();change(r);expect(()=>validateLb3Measurement(r.measurement,r.sourceBindings)).toThrow();}});
it('LBR307: full-reference/bound-live plan and wire drift are rejected',()=>{for(const key of ['planDigest','wireBytes']){const r=record(),row=r.measurement.rows.find((r:any)=>r.arm==='bound-live'&&r.status==='complete');row.result[key]=key==='planDigest'?'0'.repeat(64):row.result[key]+1;expect(()=>summarizeLb3(r.measurement.rows,3,r.measurement.workloads.map((w:any)=>w.id),'real')).toThrow();}});
it('LBR308: inflated completion, adoption and rebased deadlines cannot survive recomputation',()=>{for(const change of [(r:any)=>r.measurement.summary.completed++,(r:any)=>r.measurement.summary.productionAdopted=true,(r:any)=>r.measurement.rows[0].deadline++]){const r=record();change(r);expect(()=>validateLb3Measurement(r.measurement,r.sourceBindings)).toThrow();}});
it('LBR309: every failed trial rejects budget overruns, missing limits and non-numeric values',()=>{
 const base=record().measurement.rows.find((r:any)=>r.status==='failed'),limits={peakBytes:1048576,callWork:156978,callWire:163840,providerWork:1048576,providerWire:163840,clientWork:67108864};
 expect(()=>validateLb3Row(base)).not.toThrow();for(const [k,limit]of Object.entries(limits))for(const value of [limit+1,-1,NaN,Infinity,null,undefined]){const row=structuredClone(base);row.audit[k]=value;expect(()=>validateLb3Row(row),k+'='+value).toThrow();}
 for(const [k,limit]of Object.entries(limits)){const row=structuredClone(base);row.audit[k]=limit;expect(()=>validateLb3Row(row),k).not.toThrow();}
});
it('LBR310: unchanged counts/exclusive/partition cannot mask construction inclusive inflation',()=>{
 const row=record().measurement.rows.find((r:any)=>r.status==='complete'&&r.observation==='timed');row.trace.buckets.construction.inclusiveMs=row.constructionMs+1;expect(()=>validateLb3Row(row)).toThrow('construction_cost');
});
it('LBR311: invalid reconstruction/plan times and inflated result/plan aggregates are rejected',()=>{
 const base=record().measurement.rows.find((r:any)=>r.status==='complete'&&r.arm==='bound-live');
 for(const k of ['setupAndClientPlanMs','dispatchAndReconstructionMs','finalizationMs','clientPlanMs','sealMs','providerPlanMs'])for(const value of [-1,NaN,Infinity,null,undefined,base.result[k]+1]){const row=structuredClone(base);row.result[k]=value;expect(()=>validateLb3Row(row),k+'='+value).toThrow();}
 for(const k of ['clientPlanMs','sealMs','providerPlanMs']){const row=structuredClone(base);row.result[k]++;row.planTiming[k]++;expect(()=>validateLb3Row(row)).toThrow('plan_sum');}
 const omitted=structuredClone(base);delete omitted.planTiming;expect(()=>validateLb3Row(omitted)).toThrow('plan_timing');
 const failed=record().measurement.rows.find((r:any)=>r.status==='failed');failed.planTiming.providerPlanMs++;expect(()=>validateLb3Row(failed)).toThrow('plan_sum');
});
