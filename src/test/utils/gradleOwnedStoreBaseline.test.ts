/** Static replay of the published owned-store baseline. Never compares against a new measurement. */
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
const record=JSON.parse(readFileSync('docs/benchmarks/gradle-owned-store-baseline-2026-11-02.json','utf8'));
const design=readFileSync('docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md','utf8');
const lookup=(match:(r:any)=>boolean)=>{const rows=record.rows.filter((r:any)=>r.operation==='warm-lookup'&&match(r));expect(rows).toHaveLength(1);return rows[0];};

it('keeps the baseline marked as an unoptimized reference with complete samples',()=>{
 expect(record).toMatchObject({schema:'osv-mcp.owned-store-baseline-v1',baselineOnly:true,optimizedImplementation:false,repetitions:5,warmups:1});
 expect(record.rows).toHaveLength(54);
 for(const row of record.rows){
  const {samples,median,min,max}=row.elapsedMs,sorted=[...samples].sort((a:number,b:number)=>a-b);
  expect(samples).toHaveLength(record.repetitions);
  expect([median,min,max]).toEqual([sorted[Math.floor(sorted.length/2)],sorted[0],sorted.at(-1)]);
 }
 expect(Object.keys(record.sourceHashes).length).toBe(31);
});

it('matches every warm-lookup value published in the design table',()=>{
 const section=design.slice(design.indexOf('#### 9.68.3'),design.indexOf('#### 9.68.4'));
 const table=section.split('\n').filter(l=>l.startsWith('| ')&&!l.startsWith('| workload')&&!l.startsWith('| ---'));
 const expected=[
  lookup(r=>r.scenario.name==='fixed-1MiB-h8'),lookup(r=>r.scenario.name==='fixed-8MiB-h8'),lookup(r=>r.scenario.name==='fixed-8MiB-h64'),
  lookup(r=>r.storage==='native-rooted-files'&&r.scenario.bytes===1048576),lookup(r=>r.storage==='native-rooted-files'&&r.scenario.bytes===8388608),
  lookup(r=>r.layer==='A1-A2-kernel'&&r.scenario.scopes===1&&r.scenario.large),lookup(r=>r.layer==='A1-A2-kernel'&&r.scenario.scopes===64),
 ];
 expect(table).toHaveLength(expected.length);
 for(const [i,line] of table.entries()){
  const cells=line.split('|').slice(1,-1).map(c=>c.trim()),row=expected[i],c=row.boundaryCounters;
  expect(cells[2]).toBe(row.elapsedMs.median.toFixed(2));
  expect(cells[3]).toBe(c.store.readBytes.toLocaleString('en-US'));
  expect(cells[4]).toBe(c.checkpointCalls.read+'回／'+c.checkpoint.resyncPutCalls+'回');
  expect(cells[5]).toBe(c.nativeSync?c.nativeSync.files+'／'+c.nativeSync.directories:'未実行');
 }
});
