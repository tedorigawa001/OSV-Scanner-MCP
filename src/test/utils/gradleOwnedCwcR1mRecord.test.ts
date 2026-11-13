import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {r1mBuildLedger,validateR1mLedger,verifyR1mSourceInventory,validateR1mObservation,compareR1mObservation,validateR1mArithmetic} from '../fixtures/gradleOwnedCwcR1mLedger.mjs';
import {r1mObserve} from '../fixtures/gradleOwnedCwcR1mObservation.js';
import {co0Hash as hash} from '../fixtures/gradleOwnedCwcCo0Validation.mjs';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const path=process.env.CWC_R1M_RECORD_PATH??'docs/validation/gradle-cwc-r1m-2026-11-13.json',r=JSON.parse(readFileSync(path,'utf8'));
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
it('R1MR01: binds all source/baseline bytes, new section, ledger and actual runtime binary',()=>{
 expect(r.schema).toBe('cwc-r1m.record.v1');expect(r.status).toBe('inventory-only');for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 for(const b of r.baselines)expect(sha(readFileSync(b.path))).toBe(b.sha256);expect(sha(designSection(readFileSync(r.document.path,'utf8'),r.document.heading))).toBe(r.document.sha256);
 expect(r.runtime.node).toBe(process.version);expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));expect(r.ledger).toEqual(r1mBuildLedger());expect(r.ledgerDigest).toBe(hash(r.ledger));expect(r.ledgerSummary).toEqual(validateR1mLedger(r.ledger));
});
it('R1MR02: native/JS unknowns and ownership lifetime cannot be changed with a new self digest',()=>{for(const change of [(x:any)=>x.rows[24].physicalHeapUpperBytes=0,(x:any)=>x.rows[15].lifetime.retainedUntil='call drain',(x:any)=>x.rows[18].lifetime.wallTimeUpperMs=4500]){const x=structuredClone(r.ledger);change(x);expect(hash(x)).not.toBe(r.ledgerDigest);expect(()=>validateR1mLedger(x)).toThrow('r1m_');}});
it('R1MR03: same-count source/row duplication and coordinated line/hash updates fail fresh source binding',()=>{const x=structuredClone(r.ledger);x.rows[1]=x.rows[0];expect(()=>validateR1mLedger(x)).toThrow();const s=structuredClone(r.ledger.sourceInventory);s[0].occurrences[0].offset++;s[0].occurrences[0].line++;s[0].occurrences[0].fragmentDigest=sha(s[0].anchor);expect(()=>verifyR1mSourceInventory(s)).toThrow();});
it('R1MR04: observations bind all old finite byte/lifecycle evidence and retain unknown whole-memory upper',()=>{expect(r.observationDigest).toBe(hash(r.observation));expect(r.observationSummary).toEqual(validateR1mObservation(r.observation));expect(r.observationSummary.wholeMemoryUpperBytes).toBeNull();expect(r.observation.scope.productionAdopted).toBe(false);});
it('R1MR05: reducing owned bytes or erasing retained diagnostics is rejected',()=>{for(const change of [(x:any)=>x.r0[0].zeroedDedicatedViewBytes--,(x:any)=>x.r1o[0].allocatedViewBytes--,(x:any)=>x.r1o[0].handlesReportedAfterDrain=0,(x:any)=>x.r1o[0].boundDigestsRetained=false]){const x=structuredClone(r.observation);change(x);expect(()=>validateR1mObservation(x)).toThrow('r1m_');}});
it('R1MR06: pending memory cannot be released early or turned into a deadline-bounded lifecycle',()=>{for(const change of [(x:any)=>x.pending[0].pendingMemoryBytes=0,(x:any)=>x.pending[0].pendingBuffers=0,(x:any)=>x.pending[0].closePendingMemoryBytes=0,(x:any)=>x.pending[0].forcedReleaseTimeUpperMs=4500]){const x=structuredClone(r.observation);change(x);expect(()=>validateR1mObservation(x)).toThrow('r1m_');}});
it('R1MR07: independent recipe widths and grammar counts require fresh replay even after balanced edits',async()=>{const fresh=await r1mObserve();compareR1mObservation(r.observation,fresh);const x=structuredClone(r.observation);x.r1o[0].contextViewBytes++;x.r1o[0].coreViewBytes--;expect(()=>validateR1mObservation(x)).not.toThrow();expect(()=>compareR1mObservation(x,fresh)).toThrow('r1m_');x.r1o[0]=fresh.r1o[0];x.grammar.reachableDescriptors++;expect(()=>compareR1mObservation(x,fresh)).toThrow('r1m_');},120000);
it('R1MR08: records actual inventory check IDs while leaving runtime/native/bridge exits unproved',()=>{
 expect(r.conditions.map((c:any)=>c.id)).toEqual(Array.from({length:30},(_,i)=>'R1M'+String(i+1).padStart(2,'0')));for(const c of r.conditions){expect(c.executed).toBe(true);expect(c.scope).toBe('inventory-check');expect(c.runtimeAdmissionProved).toBe(false);}
 expect(r.tests).toEqual({inventory:30,record:11});expect(r.performanceMeasured).toBe(false);expect(r.ledger.scope.r1mRuntimeExit||r.ledger.scope.productionAdopted).toBe(false);
});
it('R1MR09: arithmetic evidence cannot promote an upper cap to a known lower after a digest update',()=>{
 expect(r.arithmeticDigest).toBe(hash(r.arithmetic));expect(r.arithmeticSummary).toEqual(validateR1mArithmetic(r.arithmetic));expect(r.arithmetic.unknown.base).toEqual({lowerBytes:0,upperBytes:73728});expect(r.arithmetic.unknown.lowerBound).toBe(0);
 expect(r.arithmetic.upperOnly.status).toBe('unsupported-uncovered');expect(r.arithmetic.upperOnly.lowerBound).toBe(1048576);expect(r.arithmetic.upperExceeds.status).toBe('conditional-upper-bound-exceeds-limit');expect(r.arithmetic.overflow.status).toBe('rejected-known-lower-bound');
 for(const mutate of [(x:any)=>x.upperOnly.lowerBound++,(x:any)=>x.unknown.lowerBound=73728,(x:any)=>x.upperOnly.status='rejected-known-lower-bound',(x:any)=>x.conditional.runtimeAdmitted=true]){const x=structuredClone(r.arithmetic);mutate(x);expect(hash(x)).not.toBe(r.arithmeticDigest);expect(()=>validateR1mArithmetic(x)).toThrow('r1m_');}
});
it('R1MR10: hook closure/capture owners and retained lifetime cannot be omitted or marked freed at drain',()=>{
 for(const mutate of [(x:any)=>x.rows.find((r:any)=>r.id==='M44').quantity.callDrainClearsHook=true,(x:any)=>x.rows.find((r:any)=>r.id==='M44').holders=[],(x:any)=>x.rows.find((r:any)=>r.id==='M45').lifetime.retainedUntil='call drain',(x:any)=>x.rows.find((r:any)=>r.id==='M45').physicalHeapUpperBytes=2097152]){const x=structuredClone(r.ledger);mutate(x);expect(()=>validateR1mLedger(x)).toThrow('r1m_');}
});
it('R1MR11: post-drain hook reachability is freshly replayed and cannot be erased or promoted to an upper bound',async()=>{
 const fresh=await r1mObserve();compareR1mObservation(r.observation,fresh);expect(r.observation.hookRetention).toHaveLength(3);
 for(const mutate of [(x:any)=>x.hookRetention[0].captureReleasedAtCallDrain=true,(x:any)=>x.hookRetention[0].secondObservation.observedViewBytes=0,(x:any)=>x.hookRetention[0].callsAfterFirstDrain=0,(x:any)=>x.hookRetention[0].captureUpperBytes=2097152]){const x=structuredClone(r.observation);mutate(x);expect(()=>validateR1mObservation(x)).toThrow('r1m_');}
},120000);
