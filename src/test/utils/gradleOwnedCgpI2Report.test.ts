import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {analyzeI2,checkI2Instruments} from '../fixtures/gradleOwnedCgpI2Report.mjs';import {ownedDigest} from '../../utils/gradleOwnedJson.js';
const fresh=()=>JSON.parse(readFileSync('docs/validation/gradle-c3b-cgp-i2-2026-11-07.measurements.json','utf8')),first=(r:any)=>r.samples[0].rounds[0].results[0];
it('replays 216 matched transfer pairs without claiming production throughput',()=>{const r=analyzeI2(fresh());expect(r.groups).toHaveLength(36);expect(r.pairs).toBe(216);expect(r.decision.productionAdopted).toBe(false);});
for(const [name,mutate,key] of [
 ['adoption',(r:any)=>r.productionAdopted=true,'adoption'],['sample',(r:any)=>r.samples.pop(),'samples'],
 ['identity',(r:any)=>r.samples[1]=structuredClone(r.samples[0]),'identity'],['workload',(r:any)=>r.samples[0].sizes[0]++,'identity'],
 ['mode',(r:any)=>r.samples[0].manifests[1].mode='AB*','manifest'],
 ['repinned coverage',(r:any)=>{for(const m of r.samples[0].manifests){m.guard.coverage='unknown';m.guardDigest=ownedDigest(m.guard);}},'manifest'],
 ['repinned budget',(r:any)=>{for(const m of r.samples[0].manifests){m.guard.maxSerializedBytes=1;m.guardDigest=ownedDigest(m.guard);}},'manifest'],
 ['profile',(r:any)=>{for(const m of r.samples[0].manifests)m.serviceProfile='0'.repeat(64);},'manifest'],
 ['output',(r:any)=>{for(const x of r.samples[0].rounds[0].results)x.outputDigest='0'.repeat(64);},'output'],
 ['order',(r:any)=>r.samples[0].rounds[0].order.reverse(),'order'],['source',(r:any)=>first(r).counters.fresh++,'boundaries'],
 ['pre',(r:any)=>first(r).counters.pre--,'boundaries'],['post',(r:any)=>first(r).counters.post--,'boundaries'],
 ['bytes',(r:any)=>first(r).counters.validatedBytes--,'boundaries'],['signature',(r:any)=>first(r).counters.ownerSignatureChecks--,'boundaries'],
 ['duplicate event',(r:any)=>first(r).events[1]=structuredClone(first(r).events[0]),'events'],
 ['phase move',(r:any)=>{const es=first(r).events;[es[2].phase,es[3].phase]=[es[3].phase,es[2].phase];},'events'],
 ['event missing',(r:any)=>first(r).events.pop(),'events'],['frame missing',(r:any)=>first(r).frames.pop(),'frames'],
 ['reply +1',(r:any)=>first(r).frames[3].inner=8193,'wire'],['frame +1',(r:any)=>first(r).frames[3].frame=16385,'wire'],
 ['observed kind',(r:any)=>first(r).frames[1].kind='challenge-request','wire'],['wire total',(r:any)=>first(r).wireBytes--,'budget'],
 ['work budget',(r:any)=>first(r).workUnits=67108865,'budget'],['deadline',(r:any)=>first(r).wallMs=4500,'time'],
 ['guard attempts',(r:any)=>first(r).guardRows.client[0].remaining=2,'guard'],
 ['same output',(r:any)=>{r.samples[0].rounds[0].results.find((x:any)=>x.mode==='B*').outputDigest='0'.repeat(64);},'output'],
 ['scalar requests',(r:any)=>r.samples[0].rounds[0].results.find((x:any)=>x.mode==='S*').requests++,'requests'],['batch requests',(r:any)=>r.samples[0].rounds[0].results.find((x:any)=>x.mode==='B*').requests++,'requests'],
 ['parts',(r:any)=>first(r).counters.parts=0,'boundaries'],['extra counter',(r:any)=>first(r).counters.extra=1,'boundaries'],
 ['frame direction',(r:any)=>first(r).frames[0].direction='reply','wire'],['challenge inner',(r:any)=>first(r).frames[0].inner=1,'wire'],
 ['guard state',(r:any)=>first(r).guardRows.server[0].state='unknown','guard'],['guard attempt',(r:any)=>first(r).guardRows.client[0].attempt=2,'guard'],
 ['guard wire',(r:any)=>first(r).guardRows.client[0].wireBytes=0,'guard'],['guard work',(r:any)=>first(r).guardRows.server[0].workUnits=65536,'guard'],
 ['skipped reads',(r:any)=>r.originalReadsSkipped=1,'adoption'],['readCommitted reduction',(r:any)=>r.readCommittedReduction=1,'adoption'],
 ['source hash',(r:any)=>r.sources.files['package.json']='0'.repeat(64),'sources'],
] as const)it('rejects corrupt I2 evidence: '+name,()=>{const r=fresh();mutate(r);expect(()=>analyzeI2(r)).toThrow('i2_evidence_'+key);});

for(const mode of ['S*','B*'])for(const component of ['planMs','dispatchMs'])it('rejects undercounted '+mode+' '+component+' with unchanged whole wall',()=>{const r=fresh();for(const s of r.samples)for(const round of s.rounds)round.results.find((x:any)=>x.mode===mode)[component]=0.001;expect(()=>analyzeI2(r)).toThrow('i2_evidence_time');});
it('rejects an unaccounted whole-wall interval',()=>{const r=fresh();first(r).wallMs+=10;expect(()=>analyzeI2(r)).toThrow('i2_evidence_time');});

for(const file of ['gradleOwnedCgpI0Planner','gradleOwnedCgpI0Guard','gradleOwnedCgpI0Authority','gradleOwnedCgpI0Case','gradleOwnedCgpI0Schema','gradleOwnedCgpI0Wire','gradleOwnedServiceContract','gradleOwnedRegistryFixture','gradleOwnedCgpI2'])it('detects a changed measured instrument: '+file,async()=>{const r=fresh(),path='src/test/fixtures/'+file+'.ts',read=async()=>'changed';expect(Object.hasOwn(r.sources.files,path)).toBe(true);await expect(checkI2Instruments({[path]:r.sources.files[path]},read)).rejects.toThrow('i2_instrument_changed:'+path);});
