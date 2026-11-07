import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {cprSources,validateCprRecord} from '../fixtures/gradleOwnedCprARecord.mjs';
const raw=JSON.parse(readFileSync('docs/validation/gradle-c3b-cpr-a-2026-11-07.record.json','utf8'));
describe('CPR-A saved evidence',()=>{
 it('checks measured source closure and all sixteen cases',async()=>{
  expect(raw.sources).toEqual(await cprSources());
  expect(validateCprRecord(raw).zeroTrialCases).toBe(16);
 });
 const mutations:[string,(r:any)=>void][]=[
  ['trial command',r=>r.samples[0].stats.packingCommands++],
  ['trial authorization',r=>r.samples[0].stats.packingAuthorization++],
  ['trial owner wire',r=>r.samples[0].stats.packingOwners++],
  ['trial frame',r=>r.samples[0].stats.packingFrames++],
  ['missing final check',r=>r.samples[0].stats.finalAuthorization--],
  ['spec repin',r=>{r.spec.dataBytes++;r.specDigest='a'.repeat(64);}],
  ['wire capacity',r=>r.samples[0].wires[0].request=8193],
  ['wire upper bound',r=>r.samples[0].wires[0].bound.reply=1],
  ['work policy repin',r=>r.workBudget.plan--],
  ['work refund with consistent arithmetic',r=>{r.samples[0].rows[0].spent.work--;r.samples[0].rows[0].remaining.work++;}],
  ['budget reset',r=>r.samples[0].rows[0].remaining.work++],
  ['original deadline',r=>r.samples[0].rows[0].deadline++],
  ['unpromoted state',r=>r.samples[0].rows[0].state='admitted'],
  ['source read omitted',r=>r.samples[0].sourceReads--],
  ['provider plan omitted',r=>r.samples[0].metrics.plans--],
  ['missing case',r=>r.samples.pop()],
  ['duplicate case',r=>r.samples[1]=structuredClone(r.samples[0])],
  ['real session claim',r=>r.scope.realSessionRuntimeVerified=true],
  ['real storage claim',r=>r.scope.realStorageVerified=true],
  ['adoption claim',r=>r.scope.productionAdopted=true],
  ['joint output repin',r=>{r.samples[0].entryHashes[0]='a'.repeat(64);r.samples[0].outputHashes[0]='a'.repeat(64);}],
  ['repeat plan changed',r=>r.samples[0].repeatedPlanDigest='a'.repeat(64)],
 ];
 for(const [name,mutate] of mutations)it('rejects '+name,()=>{const r=structuredClone(raw);mutate(r);expect(()=>validateCprRecord(r)).toThrow();});
});
