import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';
import {vf3pObserverSources} from '../fixtures/gradleOwnedCwcVf3pProfile.js';
import {validateVf3pMeasurement,validateVf3pRow,summarizeVf3p,comparisonProjection} from '../fixtures/gradleOwnedCwcVf3pValidation.mjs';
import {summarizeVf3} from '../fixtures/gradleOwnedCwcVf3Validation.mjs';
const load=()=>JSON.parse(readFileSync(process.env.CWC_VF3P_RECORD_PATH??'docs/validation/gradle-cwc-vf3p-2026-11-12.json','utf8'));
const sample=()=>structuredClone(load().measurement.rows.find((r:any)=>r.status==='complete'&&r.observation==='timed'&&r.arm==='batch/fact-live'));
it('VFPR01: all attempts, current method sources, signed approvals and summaries remain bound',()=>{const r=load();expect(validateVf3pMeasurement(r.measurement,r.sourceBindings,vf3pObserverSources())).toEqual(r.measurement.profileSummary);});
it('VFPR02: missing and duplicate attempts cannot silently erase a failure',()=>{const r=load();r.measurement.rows[0]=r.measurement.rows[1];expect(()=>summarizeVf3p(r.measurement.rows)).toThrow();});
it('VFPR03: incomplete-pair deltas cannot be relabelled as completed observer expense',()=>{const r=load(),o=r.measurement.profileSummary.observerCosts.find((o:any)=>o.noncompletedPairs>0);if(o){o.completedPairs++;expect(()=>validateVf3pMeasurement(r.measurement,r.sourceBindings,vf3pObserverSources())).toThrow();}else expect(r.measurement.rows.every((r:any)=>r.status==='complete')).toBe(true);});
it('VFPR04: failed attempts and progress cannot be excluded from the diagnostic summary',()=>{const r=load();r.measurement.profileSummary.progress.pop();expect(()=>validateVf3pMeasurement(r.measurement,r.sourceBindings,vf3pObserverSources())).toThrow();});
it('VFPR05: method source edits cannot be accepted by updating only the expected record copy',()=>{const r=load(),name='session.inspectAuthenticatedCall';for(const row of r.measurement.rows)if(row.profile)row.profile.sources[name]='0'.repeat(64);expect(()=>validateVf3pMeasurement(r.measurement,r.sourceBindings,{...vf3pObserverSources(),[name]:'0'.repeat(64)})).toThrow();});
it('VFPR06: source closure substitutions remain refused even if summaries are unchanged',()=>{const r=load();r.sourceBindings['src/test/fixtures/gradleOwnedCwcVf3pProgress.ts']='0'.repeat(64);expect(()=>validateVf3pMeasurement(r.measurement,r.sourceBindings,vf3pObserverSources())).toThrow();});
it('VFPR07: source-byte progress cannot advance beyond the validated entry or omit an accepted call',()=>{for(const change of [(r:any)=>r.progress.records.pop(),(r:any)=>{const p=r.progress.records.find((x:any)=>x.parts.length).parts[0];p.length=p.entryBytes+1;}]){const r=sample();change(r);expect(()=>validateVf3pRow(r)).toThrow();}});
it('VFPR08: shortening original deadlines, reduced work and overstated memory remain rejected',()=>{for(const change of [(r:any)=>r.deadline++,(r:any)=>r.audit.callWork=0,(r:any)=>r.audit.peakBytes=1048577]){const r=sample();change(r);expect(()=>validateVf3pRow(r)).toThrow();}});
it('VFPR09: inclusive and exclusive values cannot be NaN, infinite or negative',()=>{for(const value of [NaN,Infinity,-1]){const r=sample();r.profile.operations['json.ownedSha256'].inclusiveMs=value;expect(()=>validateVf3pRow(r)).toThrow();}});
it('VFPR10: pack cost inflation cannot preserve a false actor partition',()=>{const r=sample(),p=r.profile;p.operations['plan.provider'].inclusiveMs++;expect(()=>validateVf3pRow(r)).toThrow();});
it('VFPR11: before-deadline cost cannot move after the deadline while other and total stay unchanged',()=>{const r=sample(),p=r.profile,b=p.operations['json.ownedSha256'];b.afterMs+=b.beforeMs;b.beforeMs=0;expect(()=>validateVf3pRow(r)).toThrow();});
it('VFPR12: transferred observation totals cannot replace original actual Session inspection witnesses',()=>{const r=sample(),p=r.profile,name='session.inspectAuthenticatedCall',c=Object.values<any>(p.contexts).find(c=>c.operation===name&&c.calls>1)!;c.calls--;p.contextEntries[[c.actor,c.owner,c.operation].join('|')]--;p.entries[name]--;p.operations[name].calls--;expect(()=>validateVf3pRow(r)).toThrow('inspection_count');});
it('VFPR13: source part counts stay tied to original provider and published-call accounting',()=>{const r=sample(),x=r.progress.records.find((x:any)=>x.parts.length>0);x.parts.push({...x.parts[0]});expect(()=>validateVf3pRow(r)).toThrow();});
it('VFPR14: recomputation cannot turn the diagnostic profile into production adoption',()=>{const r=load();expect(comparisonProjection(summarizeVf3(r.measurement.rows))).toEqual(r.measurement.comparison);expect(r.measurement.profileSummary.productionAdopted).toBe(false);expect(r.measurement.profileSummary.optimizationImplemented).toBe(false);});
function stopped(record:any,mode:string){
 const r=record.measurement.rows.find((r:any)=>{
  if(r.round<0||r.arm!=='batch/'+mode||r.observation!=='timed'||r.status!=='failed')return false;
  const parts=r.progress.records.flatMap((p:any)=>p.parts),last=parts.at(-1),seen=new Set(parts.map((p:any)=>p.kind+':'+p.index));
  const oracle=record.measurement.functional.rows.find((o:any)=>o.workload===r.workload&&o.role===r.role&&o.transferMode==='B-independent'&&o.verificationMode===mode);
  return last?.kind!=='inventory'&&last?.length>1&&oracle.expectedInventory.rows.some((e:any)=>e.byteLength<=4096&&!seen.has(e.kind+':'+e.index));
 });expect(r).toBeDefined();return r;
}
for(const mode of ['full-verify','fact-live']){
 it('VFPR15 '+mode+': reducing accepted part length cannot survive full summary recomputation',()=>{
  const record=load(),r=stopped(record,mode),last=r.progress.records.flatMap((p:any)=>p.parts).at(-1);expect(last.length).toBeGreaterThan(1);last.length=1;
  expect(()=>summarizeVf3p(record.measurement.rows)).toThrow('progress_receipt');
  expect(()=>validateVf3pMeasurement(record.measurement,record.sourceBindings,vf3pObserverSources())).toThrow('progress_receipt');
 });
 it('VFPR16 '+mode+': an unreceived oracle entry cannot replace an accepted part',()=>{
  const record=load(),r=stopped(record,mode),parts=r.progress.records.flatMap((p:any)=>p.parts),seen=new Set(parts.map((p:any)=>p.kind+':'+p.index)),oracle=record.measurement.functional.rows.find((o:any)=>o.workload===r.workload&&o.role===r.role&&o.transferMode==='B-independent'&&o.verificationMode===mode),entry=oracle.expectedInventory.rows.find((e:any)=>e.byteLength<=4096&&!seen.has(e.kind+':'+e.index));
  expect(entry).toBeDefined();Object.assign(parts.at(-1),{kind:entry.kind,index:entry.index,offset:0,length:entry.byteLength,entryBytes:entry.byteLength,entrySha256:entry.sha256});
  expect(()=>validateVf3pMeasurement(record.measurement,record.sourceBindings,vf3pObserverSources())).toThrow('progress_receipt');
 });
 it('VFPR17 '+mode+': a missing or changed response witness cannot become accepted progress',()=>{
  for(const value of [undefined,'e30=']){const record=load(),r=stopped(record,mode);r.progress.records.at(-1).verifiedReply=value;expect(()=>validateVf3pMeasurement(record.measurement,record.sourceBindings,vf3pObserverSources())).toThrow('progress_receipt');}
 });
}
it('VFPR18: v1 measurement and progress records cannot masquerade as the receipt-bound v2 contract',()=>{
 const record=load();record.measurement.schema='cwc-vf3p.measurement.v1';expect(()=>validateVf3pMeasurement(record.measurement,record.sourceBindings,vf3pObserverSources())).toThrow('measurement');
 const r=sample();r.progress.schema='cwc-vf3p.progress.v1';expect(()=>validateVf3pRow(r)).toThrow('progress_schema');
});
