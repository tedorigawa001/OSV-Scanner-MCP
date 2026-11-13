import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {validateR1hEvidence,r1hHash,compareR1hReplay} from '../fixtures/gradleOwnedCwcR1hValidation.mjs';
import {r1hMatrix} from '../fixtures/gradleOwnedCwcR1hFixture.js';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync(process.env.CWC_R1H_RECORD_PATH??'docs/validation/gradle-cwc-r1h0-2026-11-13.json','utf8'));
const clone=()=>structuredClone(r.evidence),sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
it('R1HR01: binds the new section, immutable baseline, source closure and actual runtime image',()=>{
 expect(sha(designSection(readFileSync(r.document.path,'utf8'),r.document.heading))).toBe(r.document.sha256);expect(sha(readFileSync(r.baseline.path))).toBe(r.baseline.sha256);
 for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));expect(r.evidenceDigest).toBe(r1hHash(r.evidence));expect(r.summary).toEqual(validateR1hEvidence(r.evidence));
});
it('R1HR02: validates both mode branches and all finite lifecycle observations without adoption',()=>{
 const x=validateR1hEvidence(r.evidence);expect([x.normal,x.rejection,x.cleanup,x.modes]).toEqual([8,28,4,2]);expect(x.chargeProved||x.actualParentLedgerVector||x.r1mExit||x.productionAdopted).toBe(false);expect(r.runtimeTestsPassed).toBe(40);expect(r.recordTestsPassed).toBe(10);expect(r.performanceMeasured).toBe(false);
 expect(r.coverage).toHaveLength(48);for(const x of r.coverage){expect(x.fullContractExecuted).toBe(false);expect(['limited-fixture','planned']).toContain(x.status);}
});
it('R1HR03: rejects two-body, binary, table and identity undercounts despite updated self digests',()=>{
 for(const [field,value]of [['privateBodies',1],['binaryBytes',3072],['referenceSlots',48],['retainedIdentities',8],['distinctIdentities',8]] as const){const e=clone();e.normal[0].waiting.read[field]=value;expect(r1hHash(e)).not.toBe(r.evidenceDigest);expect(()=>validateR1hEvidence(e)).toThrow();}
});
it('R1HR04: rejects duplicate or relabelled cases while preserving the total row count',()=>{
 for(const bucket of ['normal','rejection','cleanup']){const e=clone();e[bucket][1]=structuredClone(e[bucket][0]);expect(()=>validateR1hEvidence(e)).toThrow();}
 const e=clone();e.normal[0].mode='owned-input';expect(()=>validateR1hEvidence(e)).toThrow();
});
it('R1HR05: rejects lingering authority and publication after fatal invalidation',()=>{
 for(const field of ['authorityLookups','publications']){const e=clone();e.rejection[0].waiting[field]=1;expect(()=>validateR1hEvidence(e)).toThrow();}
 const e=clone();e.rejection[0].waiting.read.reason='cancelled';expect(()=>validateR1hEvidence(e)).toThrow();
});
it('R1HR06: rejects early capacity release or hidden borrower/transport debts',()=>{
 const e=clone();e.normal[0].waiting.heldBodySlots=0;expect(()=>validateR1hEvidence(e)).toThrow();
 const f=clone();f.normal[0].waiting.read.borrows=0;expect(()=>validateR1hEvidence(f)).toThrow();
 const g=clone();g.normal[0].stillTransport.read.pendingTransport=0;expect(()=>validateR1hEvidence(g)).toThrow();
});
it('R1HR07: rejects caught reentry records that erase the active frame or retained body witness',()=>{
 for(const field of ['caughtReentries','reentryRefusals','faultFrameCount','faultHeldBodies']){const e=clone();e.rejection[0].waiting[field]=0;expect(()=>validateR1hEvidence(e)).toThrow();}
});
it('R1HR08: rejects partial-cleanup release, false zero completion and double recovery',()=>{
 for(const [field,value]of [['zeroedBytes',6144],['reclaims',1],['heldBodySlots',0]] as const){const e=clone();e.cleanup[0].partial[field]=value;expect(()=>validateR1hEvidence(e)).toThrow();}
 const e=clone();e.cleanup[0].final.reclaims=2;expect(()=>validateR1hEvidence(e)).toThrow();
});
it('R1HR09: preserves unknown charge and proof limits and never treats all RHC conditions as executed',()=>{
 const e=clone();e.scope.independentChargeApproved=true;expect(()=>validateR1hEvidence(e)).toThrow();const f=clone();f.unproved.physicalHeapUpperBytes=0;expect(()=>validateR1hEvidence(f)).toThrow();
 const g=clone();g.normal[0].waiting.read.deadline=4510;expect(()=>validateR1hEvidence(g)).toThrow();
});
it('R1HR10: freshly replays all observations and rejects otherwise-valid changed live-check counters',()=>{
 const fresh=r1hMatrix();expect(compareR1hReplay(r.evidence,fresh)).toBe(true);const e=clone();e.normal[0].waiting.read.fullChecks++;expect(()=>compareR1hReplay(e,fresh)).toThrow('fresh_replay');
});
