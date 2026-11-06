import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {analyzeS0b,s0bRule3} from '../fixtures/gradleOwnedS0bReport.mjs';import {ownedDigest} from '../../utils/gradleOwnedJson.js';
const base='docs/validation/gradle-c3b-cgp-s0b-2026-11-06';
const fresh=()=>JSON.parse(readFileSync(base+'.measurements.json','utf8'));
const result=(r:any)=>r.samples[0].observations[0].results[0];
it('replays complete alternating paired evidence with closed adoption gates',()=>{const a=analyzeS0b(fresh());expect(a.groups).toHaveLength(15);expect(a.decision.productionSpeedupEstablished).toBe(false);expect(a.decision.eightGraphReadsEstablished).toBe(false);});
const cases:[string,(r:any)=>void,string][]=[
 ['missing sample',r=>r.samples.pop(),'sample_count'],
 ['duplicate sample',r=>r.samples[1]=structuredClone(r.samples[0]),'identity'],
 ['order',r=>r.samples[0].observations[0].order.reverse(),'order'],
 ['head',r=>result(r).head.headDigest='0'.repeat(64),'head'],
 ['another lease',r=>r.leaseMs=6000,'schema'],
 ['another batch size, digest recomputed',r=>{r.profile.batchSize=32;r.profileDigest=ownedDigest(r.profile);},'profile'],
 ['no checkpoint bytes',r=>r.samples[0].checkpointBytes=0,'bytes'],
 ['a reference head of another revision',r=>r.samples[0].referenceHead.revision++,'reference'],
 ['a missing round',r=>r.samples[0].observations.pop(),'rounds'],
 ['a repeated round number',r=>r.samples[0].observations[1].round=1,'sequence'],
 ['more than two file FDs',r=>result(r).metrics.peakFileFDs=3,'fds'],
 ['missing production round',r=>r.samples[0].production.pop(),'production_control'],
 ['production head',r=>r.samples[0].production[0].head.headDigest='0'.repeat(64),'production_control'],
 ['production file sync',r=>r.samples[0].production[0].filesSynced--,'production_control'],
 ['production directory sync',r=>r.samples[0].production[0].directoriesSynced--,'production_control'],
 ['production listing',r=>r.samples[0].production[0].entriesEnumerated--,'production_control'],
 ['production time',r=>r.samples[0].production[0].wallMs=4500,'production_control'],
 ['all auth bytes',r=>result(r).metrics.authBytes--,'all_bytes'],
 ['all reread bytes',r=>result(r).metrics.resyncBytes--,'all_bytes'],
 ['auth count',r=>result(r).metrics.authReads--,'all_bytes'],
 ['read count',r=>result(r).metrics.readCalls--,'all_bytes'],
 ['file sync',r=>result(r).metrics.filesSynced--,'all_sync'],
 ['directory sync',r=>result(r).metrics.directoriesSynced--,'all_sync'],
 ['FD leak',r=>result(r).metrics.activeFileFDs++,'fds'],
 ['FD cap',r=>result(r).metrics.peakFileFDs=65,'fds'],
 ['write',r=>result(r).metrics.bytesWritten++,'no_write'],
 ['repair',r=>result(r).metrics.recoveredPairs++,'no_write'],
 ['inventory',r=>result(r).metrics.listCalls--,'inventory_boundaries'],
 ['boundary',r=>result(r).metrics.boundaryChecks--,'inventory_boundaries'],
 ['batch',r=>result(r).metrics.batches++,'inventory_boundaries'],
 ['enumeration',r=>result(r).metrics.entriesEnumerated--,'entry_count'],
 ['deadline',r=>result(r).metrics.wallMs=4500,'time'],
 ['nonfinite',r=>result(r).metrics.wallMs=NaN,'time'],
 ['negative count',r=>result(r).metrics.authReads=-1,'counter'],
 ['adoption',r=>r.cg3Proceed=true,'adoption'],
 ['skip flag',r=>r.profile.syncSkipping=true,'profile'],
 ['profile digest',r=>r.profileDigest='0'.repeat(64),'profile_digest'],
 ['source receipt',r=>r.executionSources.files['package.json']='0'.repeat(64),'sources'],
];
it.each(cases)('rejects altered evidence: %s',(_name,change,reason)=>{const r=fresh();change(r);expect(()=>analyzeS0b(r)).toThrow('s0b_evidence_'+reason);});
it.each(['F','D'])('rejects lost synchronization in %s even when the peer mode is complete',mode=>{const r=fresh();r.samples[0].observations[0].results.find((x:any)=>x.metrics.mode===mode).metrics.directoriesSynced=0;expect(()=>analyzeS0b(r)).toThrow('s0b_evidence_all_sync');});
const rule3Inputs=(reuseAt:(rows:number)=>number,saved:number,budget:number)=>{const groups=[1,65].map(files=>({files,productionMedianMs:saved+1,batchMedianMs:1})),s0a={groups:['control-anchor','lineage-registry'].flatMap(role=>[2,10].map(historyRows=>({role,historyRows,reuseMedianMs:reuseAt(historyRows)})))},h0={projectedGrowth:[{fromDepth:0,toDepth:1,terms:['control-anchor','lineage-registry','provider'].map(role=>({role,readCommittedCount:10,historyRowsBefore:2,historyRowsAfter:7}))}]},design={feasibilityBound:{time:{samples:[{replayBudgetMs:budget}]}}};return [groups,s0a,h0,design] as const;};
it('rule 3 sums reuse cost less the saving for the two owners, extending the last segment',()=>{const r=s0bRule3(...rule3Inputs(rows=>rows,1,100000));expect(r.depths[0]).toEqual({read:1,replayMs:20,replayWithHalfReuseCostMs:0});expect(r.depths[7]).toEqual({read:8,replayMs:720,replayWithHalfReuseCostMs:350});expect(r.productIntegrationOfS0mAndS0d).toBe(true);expect(r.next).toContain('rule 3 not met');});
it('rule 3 refuses integration when the last read exceeds the largest budget, and counts the reads within it',()=>{const r=s0bRule3(...rule3Inputs(rows=>rows,1,200));expect(r.productIntegrationOfS0mAndS0d).toBe(false);expect(r.readsWithinLargestBudget).toBe(2);expect(r.readsWithinLargestBudgetWithHalfReuseCost).toBe(5);expect(r.next).toContain('do not integrate');});
it('rule 3 refuses inputs it cannot use',()=>{const [g,s,h,d]=rule3Inputs(rows=>rows,1,200);expect(()=>s0bRule3(g,s,{projectedGrowth:[]},d)).toThrow('s0b_evidence_rule3_terms');expect(()=>s0bRule3(g,s,h,{feasibilityBound:{time:{samples:[]}}})).toThrow('s0b_evidence_rule3_budget');expect(()=>s0bRule3(g.slice(1),s,h,d)).toThrow('s0b_evidence_rule3_points');});
