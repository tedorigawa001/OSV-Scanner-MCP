import {readFileSync} from 'node:fs';import {it,expect} from 'vitest';
import {analyzeCprBP,cprBPSources} from '../fixtures/gradleOwnedCprBPRecord.mjs';
const raw=JSON.parse(readFileSync('docs/validation/gradle-c3b-cpr-bp-2026-11-08.record.json','utf8'));
it('rechecks measured source closure, decomposition and complete comparison',async()=>{
 expect(raw.sources).toEqual(await cprBPSources());const a=analyzeCprBP(raw);expect(a.primaryTransfers).toBe(288);expect(a.originalBridgeTransfers).toBe(96);expect(a.diagnosticTransfers).toBe(64);expect(a.productionAdopted).toBe(false);
});
const changes:[string,(r:any)=>void][]=[
 ['missing block',r=>r.blocks.pop()],['duplicate block',r=>r.blocks[1]=structuredClone(r.blocks[0])],
 ['wrong order',r=>r.blocks[0].order.reverse()],['warmup failure',r=>r.warmups[0].arm.status='failed'],
 ['original bridge failure',r=>r.blocks[0].original.status='failed'],['native failure',r=>r.blocks[0].arms.combined.status='failed'],
 ['wrong output',r=>r.blocks[0].arms.combined.result.outputDigest='0'.repeat(64)],
 ['source not validated',r=>r.blocks[0].arms.combined.metrics.validatedBytes--],
 ['replan omitted',r=>r.blocks[0].arms.combined.result.providerPlans--],
 ['refunded work',r=>r.blocks[0].arms.combined.providerRows[2].spent.work--],
 ['wire total',r=>r.blocks[0].arms.combined.result.wireBytes--],
 ['wire operation swapped',r=>{const f=r.blocks[0].arms.combined.frames;f[5].operation=f[9].operation;}],
 ['coherent wall underreporting',r=>{const v=r.blocks[0].arms.combined.result;v.wallMs--;v.dispatchAndReconstructionMs--;}],
 ['missing diagnostic',r=>r.diagnostics.pop()],['duplicate diagnostic',r=>r.diagnostics[1]=structuredClone(r.diagnostics[0])],
 ['trace counter',r=>r.diagnostics[0].traces[2].buckets.command.calls--],
 ['codec check omitted',r=>r.diagnostics[0].traces[2].buckets.codec.calls--],
 ['schema counter preserved wall',r=>r.diagnostics[0].traces[2].buckets.schema.calls++],
 ['nested time double counted',r=>r.diagnostics[0].traces[2].buckets.gate.exclusiveMs++],
 ['missing hash cost',r=>delete r.diagnostics[0].traces[2].buckets['hash.digest']],
 ['reused provider event with retagged sequence',r=>{const ts=r.diagnostics[0].traces;ts[3]={...structuredClone(ts[2]),id:ts[3].id};}],
 ['foreign batch binding',r=>r.diagnostics[0].traces[2].witness.requestDigest='0'.repeat(64)],
 ['changed diagnostic order',r=>r.diagnostics[0].quietPosition='before'],
 ['quiet diagnostic failure',r=>r.diagnostics[0].quiet.status='failed'],
 ['unproven storage claim',r=>r.scope.realStorageVerified=true],['source changed',r=>r.sourceSnapshotStable=false],
];
for(const [label,mutate]of changes)it('rejects '+label,()=>{const r=structuredClone(raw);mutate(r);expect(()=>analyzeCprBP(r)).toThrow();});

for(const [actor,index]of [['client-initial',0],['client-seal',1],['provider',2]] as const)it('rejects partition-preserving '+actor+' time above its enclosing measurement',()=>{
 const r=structuredClone(raw),d=r.diagnostics[0],t=d.traces[index],outer=index===0?d.observed.result.clientPlanMs:index===1?d.observed.result.sealMs:d.observed.plans[index-2].ms;
 // Remain below the whole-transfer wall: that is not the correct parent bound.
 const target=Math.min(outer+1,(outer+d.observed.result.wallMs)/2),factor=target/t.wallMs;
 t.wallMs*=factor;t.otherMs*=factor;for(const b of Object.values(t.buckets) as any[]){b.inclusiveMs*=factor;b.exclusiveMs*=factor;}
 expect(t.wallMs).toBeGreaterThan(outer+0.01);expect(t.wallMs).toBeLessThan(d.observed.result.wallMs);
 expect(Math.abs(t.wallMs-t.otherMs-Object.values(t.buckets).reduce((n:number,b:any)=>n+b.exclusiveMs,0))).toBeLessThan(0.01);
 expect(()=>analyzeCprBP(r)).toThrow('trace_enclosing_time');
});

for(const [actor,index]of [['client-initial',0],['client-seal',1],['provider',2]] as const)it('allows only clock tolerance at the '+actor+' enclosing boundary',()=>{
 const r=structuredClone(raw),d=r.diagnostics[0],t=d.traces[index],outer=index===0?d.observed.result.clientPlanMs:index===1?d.observed.result.sealMs:d.observed.plans[index-2].ms;
 const rescale=(target:number)=>{const factor=target/t.wallMs;t.wallMs*=factor;t.otherMs*=factor;for(const b of Object.values(t.buckets) as any[]){b.inclusiveMs*=factor;b.exclusiveMs*=factor;}};
 rescale(outer+0.005);expect(()=>analyzeCprBP(r)).not.toThrow();rescale(outer+0.02);expect(()=>analyzeCprBP(r)).toThrow('trace_enclosing_time');
});
