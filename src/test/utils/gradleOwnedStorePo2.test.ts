/** Historical comparison consistency; no environment-dependent timing threshold. */
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
const r=JSON.parse(readFileSync('docs/benchmarks/gradle-owned-store-po2-2026-11-02.json','utf8'));
it('keeps the PO1 reference and complete PO2 comparison samples',()=>{
 const po1=JSON.parse(readFileSync('docs/benchmarks/gradle-owned-store-po1-2026-11-02.json','utf8'));
 expect(r).toMatchObject({schema:'osv-mcp.owned-store-po2-comparison-v1',beforeCommit:'16bf69f',repetitions:5,warmups:1});expect(r.beforeHashes).toEqual(po1.afterHashes);expect(Object.keys(r.afterHashes)).toHaveLength(33);expect(r.rows).toHaveLength(18);
 for(const row of r.rows){expect(row).toMatchObject({equivalent:true,ioAndSyncEquivalent:true});
  for(const side of ['before','after']){const s=row[side].elapsedMs,sorted=[...s.samples].sort((a:number,b:number)=>a-b);expect(sorted).toHaveLength(5);expect(sorted.every((n:number)=>Number.isFinite(n)&&n>=0)).toBe(true);expect([s.min,s.median,s.max]).toEqual([sorted[0],sorted[2],sorted[4]]);}
  expect(row.speedupBeforeOverAfter).toBe(row.before.elapsedMs.median/row.after.elapsedMs.median);
 }
});
it('retains IO and sync while avoiding unchanged snapshot and metadata work',()=>{
 const design=readFileSync('docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md','utf8'),section=design.slice(design.indexOf('#### 9.71.4'));
 const table=section.split('\n').filter(l=>l.startsWith('| ')&&!l.startsWith('| workload')&&!l.startsWith('| ---'));expect(table).toHaveLength(r.rows.length);
 for(const [i,line]of table.entries()){const cells=line.split('|').slice(1,-1).map(c=>c.trim()),row=r.rows[i];expect(cells.slice(1)).toEqual([row.storage,row.operation,row.before.elapsedMs.median.toFixed(2),row.after.elapsedMs.median.toFixed(2),row.speedupBeforeOverAfter.toFixed(2)]);}
 const normalize=(c:any)=>({...c,store:{...c.store,assertOpenCalls:0},checkpoint:{...c.checkpoint,assertOpenCalls:0}});
 for(const row of r.rows){expect(normalize(row.after.boundaryCounters)).toEqual(normalize(row.before.boundaryCounters));expect(row.before.snapshotDelta).toBeNull();expect(row.before.sealDelta).toBeNull();
  const m=row.after.snapshotDelta,s=row.after.sealDelta;expect(m.metadataBytes).toBe(0);
  if(row.operation==='register-one'){expect(m.builds).toBe(1);expect(m.recordsCreated).toBe(2);expect(m.reusedRecords).toBeGreaterThan(0);expect(s.records).toBe(3);}
  else {expect(m.builds).toBe(0);expect(m.recordsCreated).toBe(0);expect(s.hashBytes).toBe(0);expect(s.copyBytes).toBe(0);}
 }
});
