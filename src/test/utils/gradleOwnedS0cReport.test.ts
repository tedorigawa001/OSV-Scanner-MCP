import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {analyzeS0c} from '../fixtures/gradleOwnedS0cReport.mjs';
const fresh=()=>JSON.parse(readFileSync('docs/validation/gradle-c3b-cgp-s0c-2026-11-06.measurements.json','utf8'));
const first=(r:any)=>r.samples[0].modes[0].observations[0];
it('replays all native rotating-order comparisons without adopting a production backend',()=>{const a=analyzeS0c(fresh());expect(a.groups).toHaveLength(36);expect(a.decision.productionSpeedupEstablished).toBe(false);expect(a.decision.eightReadsEstablished).toBe(false);});
const changes:[string,(r:any)=>void,string][]=[
 ['schema',r=>r.schema='other','schema'],['profile',r=>r.profile.rowsPerPage=17,'profile'],['profile digest',r=>r.profileDigest='0'.repeat(64),'profile'],['adoption',r=>r.productionApproved=true,'adoption'],['IO skip',r=>r.originalReadsSkipped=1,'adoption'],
 ['source',r=>r.executionSources.files['package.json']='0'.repeat(64),'source_receipt'],['missing sample',r=>r.samples.pop(),'sample_count'],
 ['duplicate sample',r=>r.samples[1]=structuredClone(r.samples[0]),'sample_identity'],['modes',r=>r.samples[0].modes.reverse(),'modes'],
 ['order',r=>r.samples[0].orders[0].modes.reverse(),'order'],['logical',r=>first(r).logicalDigest='0'.repeat(64),'round'],
 ['logical capacity',r=>first(r).metrics.logicalBytes=8388609,'logical_capacity'],['bytes',r=>first(r).metrics.freshBytes--,'all_bytes'],['read count',r=>first(r).metrics.reads--,'all_bytes'],
 ['parse count',r=>first(r).metrics.parsedObjects--,'all_bytes'],['namespace scans',r=>first(r).metrics.lists--,'all_bytes'],
 ['negative count',r=>first(r).metrics.bytes=-1,'counter'],['budget',r=>first(r).metrics.wallMs=4500,'time'],
 ['exclusive parse',r=>first(r).metrics.materializeMs=first(r).metrics.wallMs+1,'time'],
 ['checkpoint claim',r=>first(r).metrics.checkpointSyncIncluded=true,'metric_adoption'],
 ['new-reader-only',r=>r.samples[0].modes[2].oldReaders.anchor=false,'legacy'],
 ['capacity misclassification',r=>{const s=r.samples[0];s.modes[1]={mode:'W',status:'capacity',reason:'permission_denied'};s.orders=s.orders.map((o:any)=>{const live=['F','P'],offset=(o.round+s.cohort)%2;return {...o,modes:[...live.slice(offset),...live.slice(0,offset)]};});},'capacity'],['owner-copy accounting',r=>first(r).metrics.ownerBytesWithCopies++,'owner_copies'],
];
it.each(changes)('rejects corrupt comparison evidence: %s',(_name,change,reason)=>{const r=fresh();change(r);expect(()=>analyzeS0c(r)).toThrow('s0c_evidence_'+reason);});

it.each(['ownerBytesWithCopies','registryClosureBytes','anchorClosureBytes','ownerObjectCopies'])('rejects warm-up-only corruption of %s',field=>{const r=fresh(),m=r.samples[0].modes[2];m.metrics[field]++;expect(()=>analyzeS0c(r)).toThrow('s0c_evidence_stable_workload');});
it('rejects per-round owner-copy drift even when its internal sum remains valid',()=>{const r=fresh(),x=r.samples[0].modes[2].observations[1].metrics;x.registryClosureBytes++;x.ownerBytesWithCopies++;expect(()=>analyzeS0c(r)).toThrow('s0c_evidence_stable_workload');});
