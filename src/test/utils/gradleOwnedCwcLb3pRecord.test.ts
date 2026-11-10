import {expect,it} from 'vitest';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {validateLb3pMeasurement,validateLb3pCost} from '../fixtures/gradleOwnedCwcLb3pValidation.mjs';
import {lb3pObserverSources} from '../fixtures/gradleOwnedCwcLb3pProfile.js';
const path=process.env.CWC_LB3P_RECORD_PATH??'docs/validation/gradle-cwc-lb3p-2026-11-10.json',methods=lb3pObserverSources();
const record=()=>JSON.parse(readFileSync(path,'utf8'));
const sample=()=>record().measurement.rows.find((r:any)=>r.status==='complete'&&r.arm==='bound-live'&&r.observation==='timed');
it('LBPR01: fresh sources, executed method bodies, signatures and the complete 216-trial matrix',()=>{const r=record();expect(r.schema).toBe('cwc-lb3p.validation.v1');for(const [p,h]of Object.entries(r.sourceBindings))expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(h);const s=validateLb3pMeasurement(r.measurement,r.sourceBindings,methods);expect(s.optimizationImplemented).toBe(false);});
it('LBPR02: actor/owner movement with unchanged operation totals is refused by entry witnesses',()=>{const r=sample(),k=Object.keys(r.profile.contexts).find(k=>r.profile.contexts[k].owner==='live-gate')!,c=r.profile.contexts[k];delete r.profile.contexts[k];c.owner='outside';r.profile.contexts[[c.actor,c.owner,c.operation].join('|')]=c;expect(()=>validateLb3pCost(r,methods)).toThrow();});
it('LBPR03: common operation/counter omission cannot remove full verification',()=>{const r=sample();delete r.profile.entries['signer.verifyOwnerValue'];delete r.profile.operations['signer.verifyOwnerValue'];expect(()=>validateLb3pCost(r,methods)).toThrow();});
it('LBPR04: counts, exclusive partition and child-consistent inclusive inflation stay bounded',()=>{const r=sample(),b=r.profile.operations['plan.provider'],limit=r.planTiming.providerPlanMs+1,delta=limit-b.inclusiveMs;b.inclusiveMs=limit;b.childMs+=delta;for(const c of Object.values<any>(r.profile.contexts))if(c.operation==='plan.provider'){c.inclusiveMs+=delta;c.childMs+=delta;break;}expect(()=>validateLb3pCost(r,methods)).toThrow('plan_cost');});
it('LBPR05: negative/non-finite costs and double counted exclusive totals are refused',()=>{for(const v of [-1,NaN,Infinity]){const r=sample();r.profile.operations['json.ownedDigest'].exclusiveMs=v;expect(()=>validateLb3pCost(r,methods)).toThrow();}const r=sample();r.profile.otherMs++;expect(()=>validateLb3pCost(r,methods)).toThrow('cost_partition');});
it('LBPR06: failed trials cannot bypass budgets or source-verification counters',()=>{const base=record().measurement.rows.find((r:any)=>r.status==='failed'&&r.observation==='timed');for(const change of [(r:any)=>r.audit.providerWork=1048577,(r:any)=>r.profile.entries['protocol.validateChannelFrame']=0]){const r=structuredClone(base);change(r);expect(()=>validateLb3pCost(r,methods)).toThrow();}});
it('LBPR07: source pin, method-body hash and profile summary substitution are refused',()=>{for(const change of [(r:any)=>r.measurement.rows[0].profilingPin='0'.repeat(64),(r:any)=>r.measurement.rows.find((x:any)=>x.observation==='timed').profile.sources.plan='0'.repeat(64),(r:any)=>r.measurement.profileSummary.optimizationImplemented=true]){const r=record();change(r);expect(()=>validateLb3pMeasurement(r.measurement,r.sourceBindings,methods)).toThrow();}});
it('LBPR08: failed/warmup omission and completion/adoption inflation cannot survive recomputation',()=>{for(const change of [(r:any)=>r.measurement.rows.pop(),(r:any)=>r.measurement.summary.completed++,(r:any)=>r.measurement.profileSummary.costs[0].complete++]){const r=record();change(r);expect(()=>validateLb3pMeasurement(r.measurement,r.sourceBindings,methods)).toThrow();}});

it('LBPR09: actual wire accounting and signed TTL pairing cannot be changed with stable cost counters',()=>{for(const change of [(r:any)=>r.wireFrames[0].frame++,(r:any)=>r.wireTtls[1].ttlMs--,(r:any)=>r.audit.callWire--]){const r=sample();change(r);expect(()=>validateLb3pCost(r,methods)).toThrow();}const failed=record().measurement.rows.find((r:any)=>r.status==='failed'&&r.observation==='timed');failed.wireFrames[0].frame++;expect(()=>validateLb3pCost(failed,methods)).toThrow('wire_actual_cost');});

// Change every local copy together: the independent execution witness must still refuse it.
it('LBPR10: reduced added real-call counts cannot survive consistent local and observer counters',()=>{
 for(const observations of [['timed'],['counts','timed']]){
  const r=record(),target=r.measurement.rows.find((x:any)=>x.round>=0&&x.arm==='bound-live'&&x.observation==='timed'&&x.status==='complete'&&r.measurement.rows.some((y:any)=>y.round===x.round&&y.workload===x.workload&&y.role===x.role&&y.arm===x.arm&&y.observation==='counts'&&y.status==='complete'));
  for(const row of r.measurement.rows.filter((x:any)=>x.round===target.round&&x.workload===target.workload&&x.role===target.role&&x.arm===target.arm&&observations.includes(x.observation))){const p=row.profile,k=Object.keys(p.contexts).find(k=>p.contexts[k].operation==='session.inspectAuthenticatedCall'&&p.contexts[k].calls>1)!;const delta=p.contexts[k].calls-1;p.contexts[k].calls-=delta;p.contextEntries[k]-=delta;p.entries['session.inspectAuthenticatedCall']-=delta;p.operations['session.inspectAuthenticatedCall'].calls-=delta;}
  expect(()=>validateLb3pMeasurement(r.measurement,r.sourceBindings,methods)).toThrow(observations.length===1?'profile_count_parity':'actual_call_witness');
 }
});
it('LBPR11: cross-actor cost movement with stable operation totals and time partition is refused',()=>{
 const r=record(),row=r.measurement.rows.find((x:any)=>x.round>=0&&x.arm==='bound-live'&&x.observation==='timed'&&x.status==='complete'),p=row.profile,a=p.contexts['client-initial|live-gate|json.ownedDigest'],b=p.contexts['provider|live-gate|json.ownedDigest'],delta=Math.min(10,b.exclusiveMs/2);
 expect(delta).toBeGreaterThan(0);const before=structuredClone(p.operations);for(const k of ['inclusiveMs','exclusiveMs']){a[k]+=delta;b[k]-=delta;}expect(p.operations).toEqual(before);
 expect(()=>validateLb3pMeasurement(r.measurement,r.sourceBindings,methods)).toThrow('actor_cost_closure');
});

it('LBPR12: added codec counters also retain successful counts/timed parity',()=>{
 const r=record(),row=r.measurement.rows.find((x:any)=>x.round>=0&&x.arm==='bound-live'&&x.observation==='timed'&&x.status==='complete'&&r.measurement.rows.some((y:any)=>y.round===x.round&&y.workload===x.workload&&y.role===x.role&&y.arm===x.arm&&y.observation==='counts'&&y.status==='complete')),p=row.profile,name='codecB.planProof',key=Object.keys(p.contexts).find(k=>p.contexts[k].operation===name&&p.contexts[k].calls>1)!;
 p.contexts[key].calls--;p.contextEntries[key]--;p.entries[name]--;p.operations[name].calls--;validateLb3pCost(row,methods);
 expect(()=>validateLb3pMeasurement(r.measurement,r.sourceBindings,methods)).toThrow('profile_count_parity');
});
