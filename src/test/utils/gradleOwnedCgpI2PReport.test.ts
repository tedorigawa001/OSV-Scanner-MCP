import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {analyzeI2P} from '../fixtures/gradleOwnedCgpI2PReport.mjs';
const fresh=()=>JSON.parse(readFileSync('docs/validation/gradle-c3b-cgp-i2p-2026-11-07.measurements.json','utf8')),first=(r:any)=>r.samples[0].rounds[0].results.find((x:any)=>x.variant==='B-max'),plan=(r:any)=>first(r).planner.plans[0];
it('replays 216 matched rounds including unmodified baseline and rejects production adoption',()=>{const a=analyzeI2P(fresh());expect(a.groups).toHaveLength(36);expect(a.transfers).toBe(864);expect(a.decision.productionAdopted).toBe(false);});
for(const [name,change,key] of [
 ['adoption',(r:any)=>r.productionAdopted=true,'adoption'],['profile',(r:any)=>r.profile.wireCap++,'profile'],
 ['runs',(r:any)=>r.profile.plannerRuns=1,'profile'],['duplicate',(r:any)=>r.samples[1]=structuredClone(r.samples[0]),'identity'],
 ['manifest',(r:any)=>r.samples[0].manifests[2].guard.maxAttempts++,'manifest'],
 ['order',(r:any)=>r.samples[0].rounds[0].order.reverse(),'order'],['time missing',(r:any)=>first(r).planMs=0.001,'time'],
 ['wire digest',(r:any)=>first(r).wireDigests[0]='0'.repeat(64),'exact_wire'],['wire +1',(r:any)=>first(r).frames[3].inner=8193,'wire'],
 ['source skip',(r:any)=>first(r).counters.fresh--,'boundaries'],['gate missing',(r:any)=>first(r).events[3]=structuredClone(first(r).events[2]),'events'],
 ['budget',(r:any)=>first(r).workUnits=67108865,'budget'],['attempt',(r:any)=>first(r).guardRows.server[0].remaining=2,'guard'],
 ['no profile',(r:any)=>first(r).planner=null,'planner'],['second run removed',(r:any)=>first(r).planner.plans.pop(),'planner'],
 ['strategy',(r:any)=>first(r).planner.strategy='binary','planner'],['seal stage',(r:any)=>first(r).planner.stages.seal.ms=0.001,'seal'],
 ['inventory omitted',(r:any)=>delete first(r).planner.stages.inventory,'stages'],['failed',(r:any)=>plan(r).status='failed','plan'],
 ['cost omitted',(r:any)=>delete plan(r).costs.wire,'costs'],['cost overlap',(r:any)=>plan(r).costs.wire.ms+=100,'cost_partition'],
 ['cost undercount',(r:any)=>plan(r).costs.wire.ms=0,'cost_partition'],['cost partition +0.02',(r:any)=>plan(r).costs.wire.ms+=0.02,'cost_partition'],['cost partition -0.02',(r:any)=>plan(r).costs.wire.ms-=0.02,'cost_partition'],['gate count',(r:any)=>plan(r).costs.gate.count--,'cost_counts'],
 ['wire count',(r:any)=>plan(r).costs.wire.count--,'cost_counts'],['max branch',(r:any)=>plan(r).probes[0].kind='binary','strategy'],
 ['probe duplicate',(r:any)=>plan(r).probes[1]=structuredClone(plan(r).probes[0]),'probes'],
 ['false fit',(r:any)=>plan(r).probes[0].fit=false,'probes'],['probe range',(r:any)=>plan(r).probes[0].length=4097,'probes'],
 ['final replay missing',(r:any)=>plan(r).probes.at(-1).kind='max','strategy'],
 ['plan not equivalent',(r:any)=>{for(const p of first(r).planner.plans)p.outputDigest='1'.repeat(64);},'equivalent_plan'],['seal mismatch',(r:any)=>first(r).planner.plans[1].outputDigest='0'.repeat(64),'seal'],
 ['baseline instrumentation',(r:any)=>r.samples[0].rounds[0].results.find((x:any)=>x.variant==='B-ref').planner=structuredClone(first(r).planner),'unexpected_planner'],
 ['output',(r:any)=>first(r).outputDigest='0'.repeat(64),'output'],['original reads',(r:any)=>r.originalReadsSkipped=1,'adoption'],
] as const)it('rejects altered planner evidence: '+name,()=>{const r=fresh();change(r);expect(()=>analyzeI2P(r)).toThrow('i2_evidence_'+key);});

for(const variant of ['B-binary','B-max'])for(const run of [0,1])for(const phase of ['search','final'])it(`rejects same-count duplicate/missing candidate: ${variant} run ${run} ${phase}`,()=>{const raw=fresh(),result=raw.samples[0].rounds[0].results.find((x:any)=>x.variant===variant),p=result.planner.plans[run],before=structuredClone({total:p.probes.length,ordinals:p.probes.map((e:any)=>e.ordinal),costs:p.costs,counters:result.counters}),indices=p.probes.map((e:any,i:number)=>({e,i})).filter(({e}:any)=>phase==='final'?e.kind==='final':e.kind!=='final'),from=indices[0].i,to=indices[1].i;p.probes[to]={...structuredClone(p.probes[from]),ordinal:p.probes[to].ordinal};expect({total:p.probes.length,ordinals:p.probes.map((e:any)=>e.ordinal),costs:p.costs,counters:result.counters}).toEqual(before);expect(()=>analyzeI2P(raw)).toThrow('i2_evidence_probe_duplicate');});
it('allows the same candidates to be independently recomputed by seal',()=>{const raw=fresh();for(const s of raw.samples)for(const r of s.rounds)for(const x of r.results.filter((x:any)=>x.planner)){const [initial,seal]=x.planner.plans;expect(seal.probes.map((p:any)=>p.commandDigest)).toEqual(initial.probes.map((p:any)=>p.commandDigest));}expect(analyzeI2P(raw).matchedRounds).toBe(216);});
