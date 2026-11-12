import {it,expect} from 'vitest';
import {writeFileSync,readFileSync} from 'node:fs';
import {traceCo0b,runCo0bMatrix} from '../fixtures/gradleOwnedCwcCo0b.js';
import {co0bSourceAudit,co0bEligibility} from '../fixtures/gradleOwnedCwcCo0bAudit.mjs';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import * as schema from '../fixtures/gradleOwnedCprASchema.js';
import * as json from '../../utils/gradleOwnedJson.js';
import {validateCo0bEvidence} from '../fixtures/gradleOwnedCwcCo0bValidation.mjs';

it('COB01: expected identities distinguish conservative frame retention from original source holders',()=>{
 const r=traceCo0b({ordinals:1});
 expect(r.error).toBeNull();expect(r.compared).toBe(1);
 expect(r.witnesses.some(w=>w.phase==='expected'&&w.distinctRoots===4)).toBe(true);
 expect(r.witnesses.find(w=>w.phase==='expected')?.sourceSupportedRoots).toBe(3);
 expect(r.witnesses.find(w=>w.phase==='expected')?.observerExtendedRaw).toBe(true);
 expect(r.witnesses.find(w=>w.phase==='normalize')?.sourceSupportedRoots).toBe(4);
 expect(r.scope.threeSlotEstablished).toBe(false);
});
it('COB06: every intrinsic and module spy is restored after an observed refusal',()=>{
 const before=[Object.keys,Array.prototype.map,Array.prototype.join,JSON.stringify,String.prototype.charCodeAt,schema.cprCommandSchema.parse,schema.makeCommand,json.ownedDigest,json.canonicalOwnedJson];
 traceCo0b({rootLimit:3});
 expect([Object.keys,Array.prototype.map,Array.prototype.join,JSON.stringify,String.prototype.charCodeAt,schema.cprCommandSchema.parse,schema.makeCommand,json.ownedDigest,json.canonicalOwnedJson]).toEqual(before);
});
it('COB07: diagnostic refusal retains the same parent initialization and work across new owners',()=>{
 const budget=new Lb0Budget(undefined,1048576,20479);
 for(let n=1;n<=2;n++){const r=traceCo0b({budget,rootLimit:3});expect(r.finalBudget.initialization).toBe(4096*n);expect(r.finalBudget.work).toBe(4096*n);expect(r.finalBudget.heldBytes).toBe(0);}
 expect(()=>traceCo0b({budget})).toThrow('codec_budget_exceeded');expect(traceCo0b({ordinals:1}).error).toBeNull();
});
it('COB08: unchanged full-byte validation still refuses post-normalization candidate mutation',()=>{
 const r=traceCo0b({fault:'row-after-normalize'});expect(r.error).toContain('co0_candidate_mismatch');expect(r.compared).toBe(0);
 expect(r.protocol.proofs).toBe(0);expect(r.protocol.publications).toBe(0);expect(r.finalBudget.heldBytes).toBe(0);
});
it('COB09: deadline, owned revocation and caught external reentry still refuse before expected generation',()=>{
 for(const stop of ['deadline','revocation','reentry'] as const){const r=traceCo0b({stop});expect(r.error).not.toBeNull();
  expect(r.protocol.expectedBuilds).toBe(0);expect(r.protocol.proofs).toBe(0);expect(r.protocol.publications).toBe(0);expect(r.finalBudget.work).toBe(4096);expect(r.finalBudget.heldBytes).toBe(0);}
});
it('COB10: the expected-only guard records actual allocated roots, not a pre-allocation upper bound',()=>{
 const r=traceCo0b({rootLimit:3,guardPhase:'expected'});expect(r.denied?.phase).toBe('expected');expect(r.denied?.allocationAlreadyOccurred).toBe(true);
 expect(r.protocol.expectedBuilds).toBe(1);expect(r.compared).toBe(0);expect(r.scope.fullHeapUpperBound).toBe(false);
});
it('COB11: moving or removing a required lifetime anchor cannot silently preserve the source audit',()=>{
 expect(()=>co0bSourceAudit(p=>readFileSync(p,'utf8').replace('const {requestDigest,...q}=input','const {requestDigest,...other}=input'))).toThrow('anchor_hash-shallow-copy');
});
it('COB12: source audit cannot promote primitive quantities or reference targets to complete coverage',()=>{
 const a=co0bSourceAudit();a.work.productionUnitsComparable=true;expect(()=>co0bEligibility(a)).toThrow();
 const b=co0bSourceAudit();b.layout.referenceTableImplemented=true;expect(()=>co0bEligibility(b)).toThrow();
 expect(co0bSourceAudit().retention.client).toEqual({contexts:3,planCores:4});
});
it('COB13: both roles, three context boundaries and independent client/provider families preserve the original protocol',()=>{
 const evidence=runCo0bMatrix();expect(evidence.rows).toHaveLength(12);let total=0;
 for(const r of evidence.rows){expect(r.observed.error).toBeNull();expect(r.observed.protocol).toEqual(r.control);total+=r.observed.compared;
  for(const g of r.guards){expect(g.result.error).toContain('co0b_root_limit');expect(g.result.finalBudget.heldBytes).toBe(0);}}
 expect(total).toBe(342);if(process.env.CWC_CO0B_EVIDENCE_PATH)writeFileSync(process.env.CWC_CO0B_EVIDENCE_PATH,JSON.stringify(evidence));
 expect(validateCo0bEvidence(evidence).decision.co0Exit).toBe(false);
},60000);
it('COB05: the current packed metadata plus mandatory trace buffers cannot fit the 4096-byte target',()=>{
 const audit=co0bSourceAudit();expect(audit.layout.explicitBuffers).toBe(266240);
 expect(audit.layout.traceCapacity).toBe(262144);expect(co0bEligibility(audit).eligible).toBe(false);
 expect(co0bEligibility(audit).reasons).toContain('metadata-bridge-over-target');
});
it('COB04: the observation control preserves all nineteen results, protocol events and prepaid spending',()=>{
 const a=traceCo0b(),b=traceCo0b({observe:false});
 expect(a.error).toBeNull();expect(a.compared).toBe(19);expect(a.protocol).toEqual(b.protocol);
 expect(a.parses).toHaveLength(95);expect(a.work.directCharReads).toBe(2*a.protocol.comparedBytes);
 expect(a.witnesses).toHaveLength(38);
 for(const w of a.witnesses){expect(w.distinctRoots).toBe(4);expect(w.shallowAlias).toBe(true);}
});
it('COB03: a three-root diagnostic limit refuses before the observed hash consumer and releases protocol bytes',()=>{
 const r=traceCo0b({rootLimit:3});
 expect(r.error).toContain('co0b_root_limit');expect(r.denied?.beforeHashUpdate).toBe(true);
 expect(r.compared).toBe(0);expect(r.finalBudget.heldBytes).toBe(0);expect(r.finalBudget.work).toBe(4096);
});
it('COB02: real canonical and hash consumers expose scratch and additional primitive work',()=>{
 const r=traceCo0b({ordinals:1});
 expect(r.work.hashUpdates).toBeGreaterThan(0);expect(r.work.hashInputBytes).toBeGreaterThan(4096);
 expect(r.work.canonicalRoots).toBeGreaterThan(0);expect(r.work.joinInputUnits).toBeGreaterThan(0);
 expect(r.scratch.some(w=>w.partUnits>0&&w.joinedUnits>0&&w.logicalUnits===w.partUnits+w.joinedUnits)).toBe(true);
 for(const p of r.primitives){expect(p.work).toEqual(p.model.work);expect(p.scratch).toEqual(p.model.scratch);
  expect(p.digest).toBe(p.model.digest);expect(p.hashInputDigest).toBe(p.kind==='hash'?p.model.preimageDigest:null);}
});
