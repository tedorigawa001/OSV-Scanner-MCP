import {readFileSync} from 'node:fs';import {it,expect} from 'vitest';
import {cprBSources,analyzeCprB} from '../fixtures/gradleOwnedCprBRecord.mjs';
const raw=JSON.parse(readFileSync('docs/validation/gradle-c3b-cpr-b-2026-11-08.record.json','utf8'));
it('recomputes comparison, source closure and scoped claims from saved evidence',async()=>{
 expect(raw.sources).toEqual(await cprBSources());const a=analyzeCprB(raw);expect(a.transfers).toBe(288);expect(a.productionAdopted).toBe(false);
});
const mutations:[string,(r:any)=>void][]=[
 ['bridge with no provider plans',r=>r.pairs[0].planEventBridge.quiet.result.providerPlans=0],
 ['bridge output',r=>r.pairs[0].planEventBridge.quiet.result.outputDigest='0'.repeat(64)],
 ['failed primary arm',r=>r.pairs[0].arms['B-independent'].status='failed'],
 ['failed bridge arm',r=>r.pairs[0].planEventBridge.quiet.status='failed'],
 ['failed warmup',r=>r.warmups[0].arm.status='failed'],
 ['source changed during run',r=>r.sourceSnapshotStable=false],
 ['missing pair',r=>r.pairs.pop()],['duplicate pair',r=>r.pairs[1]=structuredClone(r.pairs[0])],
 ['order',r=>r.pairs[0].order.reverse()],['real storage claim',r=>r.scope.mockStorage=false],['adoption claim',r=>r.scope.productionAdopted=true],
 ['coherent wall and partition underreporting',r=>{const v=r.pairs[0].arms['B-independent'].result;v.wallMs-=0.5;v.dispatchAndReconstructionMs-=0.5;}],
 ['missing final timing boundary',r=>delete r.pairs[0].arms['B-independent'].result.timing],
 ['hidden finalization work',r=>r.pairs[0].arms['B-independent'].result.finalizationMs=0],
 ['quiet coherent underreporting',r=>{const v=r.pairs[0].planEventBridge.quiet.result;v.wallMs-=0.5;v.dispatchAndReconstructionMs-=0.5;}],
 ['underreported wall',r=>r.pairs[0].arms['B-independent'].result.wallMs--],
 ['omitted provider time',r=>r.pairs[0].arms['B-independent'].result.providerPlanMs=0],
 ['missing replan',r=>r.pairs[0].arms['B-independent'].result.providerPlans--],
 ['shared foreign plan',r=>r.pairs[0].arms['B-independent'].plans[0].planDigest='1'.repeat(64)],
 ['foreign inventory',r=>r.pairs[0].arms['B-independent'].plans[0].inputDigest='1'.repeat(64)],
 ['missing fresh load',r=>r.pairs[0].arms['B-independent'].metrics.loads--],
 ['partial source validation',r=>r.pairs[0].arms['B-independent'].metrics.validatedBytes--],
 ['wire capacity',r=>r.pairs[0].arms['B-independent'].frames[0].frame=16385],
 ['wire total',r=>r.pairs[0].arms['B-independent'].result.wireBytes--],
 ['wire reassignment',r=>{const a=r.pairs[0].arms['B-independent'];a.frames[5].operation=a.frames[9].operation;}],
 ['reordered frames',r=>{const a=r.pairs[0].arms['B-independent'];[a.frames[4],a.frames[5]]=[a.frames[5],a.frames[4]];}],
 ['refunded work',r=>r.pairs[0].arms['B-independent'].providerRows[2].spent.work--],
 ['wrong state',r=>r.pairs[0].arms['B-independent'].providerRows[2].state='admitted'],
 ['changed deadline',r=>r.pairs[0].arms['B-independent'].clientRows[2].deadline++],
 ['warm handshake',r=>r.pairs.find((p:any)=>p.temperature==='warm').temperature='cold'],
 ['output repin',r=>r.pairs[0].arms['B-independent'].result.outputDigest='1'.repeat(64)],
];
for(const [name,mutate]of mutations)it('rejects '+name,()=>{const r=structuredClone(raw);mutate(r);expect(()=>analyzeCprB(r)).toThrow();});
