import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {analyzeS0b} from '../fixtures/gradleOwnedS0bReport.mjs';
const base='docs/validation/gradle-c3b-cgp-s0b-2026-11-06';
const fresh=()=>JSON.parse(readFileSync(base+'.measurements.json','utf8'));
const result=(r:any)=>r.samples[0].observations[0].results[0];
it('replays complete alternating paired evidence with closed adoption gates',()=>{const a=analyzeS0b(fresh());expect(a.groups).toHaveLength(15);expect(a.decision.productionSpeedupEstablished).toBe(false);expect(a.decision.eightGraphReadsEstablished).toBe(false);});
const cases:[string,(r:any)=>void,string][]=[
 ['missing sample',r=>r.samples.pop(),'sample_count'],
 ['duplicate sample',r=>r.samples[1]=structuredClone(r.samples[0]),'identity'],
 ['order',r=>r.samples[0].observations[0].order.reverse(),'order'],
 ['head',r=>result(r).head.headDigest='0'.repeat(64),'head'],
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
