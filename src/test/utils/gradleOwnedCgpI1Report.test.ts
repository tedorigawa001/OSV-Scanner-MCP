import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {analyzeI1} from '../fixtures/gradleOwnedCgpI1Report.mjs';
const fresh=()=>JSON.parse(readFileSync('docs/validation/gradle-c3b-cgp-i1-2026-11-06.measurements.json','utf8')),first=(r:any)=>r.samples[0].observations[0].results[0],shared=(r:any)=>r.samples[0].observations[0].results.find((x:any)=>x.mode==='A*');
it('replays 18 matched comparisons and preserves readCommitted in every projection',()=>{const a=analyzeI1(fresh());expect(a.groups).toHaveLength(18);expect(a.estimates).toHaveLength(9);for(const e of a.estimates){expect(e.fewerEnvelopeParses).toBe(68);expect(e.fewerRequestSignatureChecks).toBe(34);expect(e.readCommittedReduction).toBe(0);expect(e.referenceReadCommitted).toBe(238);}expect(a.decision.eightReadsEstablished).toBe(false);});
const cases:[string,(r:any)=>void,string][]=[
 ['schema',r=>r.schema='other','schema'],['coverage',r=>r.coverage='all-apis','schema'],['adoption',r=>r.backendEligible=true,'adoption'],['reads',r=>r.readCommittedReduction=1,'adoption'],
 ['sources',r=>r.executionSources.files['package.json']='0'.repeat(64),'sources'],['sample missing',r=>r.samples.pop(),'sample_count'],['sample duplicate',r=>r.samples[1]=structuredClone(r.samples[0]),'sample_identity'],
 ['reference count',r=>r.reference.samples[0].referenceReadCommitted=237,'reference'],['reference duplicate',r=>r.reference.samples[1]=structuredClone(r.reference.samples[0]),'reference'],
 ['mode policy',r=>r.samples[0].manifests[1].guard.maxSlots++,'manifest'],['shared guard off',r=>{for(const m of r.samples[0].manifests)m.guard.enabled=false;},'guard_policy'],
 ['order',r=>r.samples[0].observations[0].order.reverse(),'order'],['wire',r=>first(r).wireDigest='0'.repeat(64),'exact_input_output'],['output',r=>first(r).logicalDigest='0'.repeat(64),'exact_input_output'],
 ['signature omitted',r=>first(r).metrics.serverSignatures=0,'verification_count'],['owner payload skipped',r=>shared(r).metrics.ownerCommandValidations=0,'verification_count'],['shared owner reparse',r=>shared(r).metrics.ownerParses=1,'verification_count'],['facts read omitted',r=>shared(r).metrics.factsReads=0,'verification_count'],
 ['pre omitted',r=>first(r).metrics.preLive=0,'live_boundaries'],['post omitted',r=>first(r).metrics.postLive=0,'live_boundaries'],['source skipped',r=>first(r).metrics.sourceAcquisitions=0,'live_boundaries'],['local gate omitted',r=>first(r).metrics.localGates--,'live_boundaries'],['client result missing',r=>first(r).metrics.clientResults=0,'live_boundaries'],
 ['counter',r=>first(r).metrics.serverParses=-1,'counter'],['time',r=>first(r).metrics.serverCodecMs=-1,'time'],['deadline',r=>first(r).metrics.wallMs=4500,'wall_time'],['overlapping time',r=>first(r).metrics.serverCodecMs=first(r).metrics.wallMs+1,'wall_time'],
 ['wire cap',r=>first(r).metrics.wireBytes=8193,'wire_size'],['facts cost hidden',r=>shared(r).metrics.factsCreateMs=0,'phase_time'],['flag',r=>first(r).flags.profileApproved=true,'flags'],
 ['guard mismatch',r=>first(r).guards.clientEntries++,'guard_equivalence'],['slots lost',r=>{for(const x of r.samples[0].observations[0].results)x.guards.clientEntries++;},'guard_slots'],['retry budget reset',r=>{for(const x of r.samples[0].observations[0].results)x.guards.client[0].remaining=2;},'guard_budget'],
];
it.each(cases)('rejects corrupt I1 evidence: %s',(_name,change,reason)=>{const r=fresh();change(r);expect(()=>analyzeI1(r)).toThrow('cgp_i1_evidence_'+reason);});

const repin=(m:any)=>{m.guardDigest=ownedDigest(m.guard);};
import {ownedDigest} from '../../utils/gradleOwnedJson.js';
for(const [label,mutate] of [
 ['coverage',(m:any)=>m.guard.coverage='unknown'],['implementation',(m:any)=>m.guard.implementation='unknown'],
 ['guard schema',(m:any)=>m.guard.schema='unknown'],['serialized budget',(m:any)=>m.guard.maxSerializedBytes=1],
 ['profile',(m:any)=>m.serviceProfile='0'.repeat(64)],['producer',(m:any)=>m.producerPolicy='0'.repeat(64)],
 ['observer',(m:any)=>m.observerDigest='0'.repeat(64)],['read budget',(m:any)=>m.readPlan.maxWorkUnits=1],
 ['unknown field',(m:any)=>m.extra=true],
] as const)it('rejects independently unapproved manifests after digest update: '+label,()=>{const r=fresh();for(const m of r.samples[0].manifests){mutate(m);repin(m);}expect(()=>analyzeI1(r)).toThrow('cgp_i1_evidence_guard_policy');});
