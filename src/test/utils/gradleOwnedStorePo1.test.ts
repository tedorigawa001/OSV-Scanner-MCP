/** Historical comparison consistency; never asserts a wall-clock performance threshold. */
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
const record=JSON.parse(readFileSync('docs/benchmarks/gradle-owned-store-po1-2026-11-02.json','utf8'));
it('preserves a complete fingerprinted comparison with correct sample statistics',()=>{
 expect(record).toMatchObject({schema:'osv-mcp.owned-store-po1-comparison-v1',beforeCommit:'7e00ee4',repetitions:5,warmups:1});
 expect(record.publishedBaselineSha256).toBe(ownedSha256(readFileSync('docs/benchmarks/gradle-owned-store-baseline-2026-11-02.json')));
 expect(Object.keys(record.beforeHashes)).toHaveLength(31);expect(Object.keys(record.afterHashes)).toHaveLength(32);
 const baseline=JSON.parse(readFileSync('docs/benchmarks/gradle-owned-store-baseline-2026-11-02.json','utf8'));expect(record.beforeHashes).toEqual(baseline.sourceHashes);
 expect(record.rows).toHaveLength(66);
 for(const r of record.rows){
  expect(r).toMatchObject({equivalent:true,ioAndSyncEquivalent:true});
  for(const side of ['before','after']){const s=r[side].elapsedMs,sorted=[...s.samples].sort((a:number,b:number)=>a-b);expect(sorted).toHaveLength(5);expect(sorted.every((n:number)=>Number.isFinite(n)&&n>=0)).toBe(true);expect([s.min,s.median,s.max]).toEqual([sorted[0],sorted[2],sorted[4]]);}
  expect(r.speedupBeforeOverAfter).toBe(r.before.elapsedMs.median/r.after.elapsedMs.median);
 }
});
it('preserves read/sync boundaries while avoiding repeated record hash and head output',()=>{
 for(const r of record.rows){
  const normalize=(m:any)=>({...m,store:{...m.store,assertOpenCalls:0},checkpoint:{...m.checkpoint,assertOpenCalls:0}});
  expect(normalize(r.after.boundaryCounters)).toEqual(normalize(r.before.boundaryCounters));
  expect(r.after.lastRecovery).toBeDefined();
  if(r.operation==='warm-verify-head'){expect(r.after.lastRecovery.returnedRecordBytes).toBe(0);expect(r.before.lastRecovery.returnedRecordBytes).toBeGreaterThan(0);}
  if(r.layer==='journal'&&r.scenario.name?.startsWith('fixed-'))expect(r.after.lastRecovery.recordHashBytes).toBeLessThan(r.before.lastRecovery.recordHashBytes);
  expect(r.after.lastRecovery.peakMemoEntries).toBeLessThanOrEqual(4096);expect(r.after.lastRecovery.peakMemoKeyBytes).toBeLessThanOrEqual(8*1024*1024);
 }
});
