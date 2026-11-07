import {it,expect} from 'vitest';import {readFileSync} from 'node:fs';import {analyzeS0c} from '../fixtures/gradleOwnedS0cReport.mjs';
const fresh=()=>JSON.parse(readFileSync('docs/validation/gradle-c3b-cgp-s0c-2026-11-06.measurements.json','utf8'));
const first=(r:any)=>r.samples[0].modes[0].observations[0];
it('replays all native rotating-order comparisons without adopting a production backend',()=>{const a=analyzeS0c(fresh());expect(a.groups).toHaveLength(63);expect(a.baselines).toHaveLength(21);expect(a.ratios).toHaveLength(7);expect(a.decision.productionSpeedupEstablished).toBe(false);expect(a.decision.eightReadsEstablished).toBe(false);});
const deep=(r:any)=>r.samples.find((s:any)=>s.cycles===20);
const rotate=(s:any)=>{const live=[...s.modes.filter((m:any)=>m.status==='success').map((m:any)=>m.mode),'B'];s.orders=s.orders.map((o:any)=>{const offset=(o.round+s.cohort)%live.length;return {...o,modes:[...live.slice(offset),...live.slice(0,offset)]};});};
const changes:[string,(r:any)=>void,string][]=[
 ['records bound to cycles',r=>{for(const s of r.samples)s.records=999;},'records'],['host',r=>{r.host.platform='linux';},'host'],['input digest',r=>r.samples[0].inputDigest='x','input'],
 ['P capacity',r=>{const s=deep(r);s.modes[2]={mode:'P',status:'capacity',reason:'capacity_exhausted'};rotate(s);},'required_modes'],
 ['shallow F capacity',r=>{const s=r.samples[0];s.modes[0]={mode:'F',status:'capacity',reason:'capacity_exhausted'};rotate(s);},'required_modes'],
 ['build time',r=>{r.samples[0].modes[0].buildMs=0;},'build_time'],['round index',r=>{first(r).round=9;},'round'],
 ['owner copy below distinct',r=>{const x=first(r).metrics;x.registryClosureBytes=1;x.anchorClosureBytes=1;x.ownerBytesWithCopies=2;},'owner_copies'],
 ['F closure claimed self-verifying',r=>{first(r).metrics.registryClosureSelfVerifying=true;},'owner_copies'],
 ['logical bytes differ across modes',r=>{const m=r.samples[0].modes[1];m.metrics.logicalBytes++;for(const o of m.observations)o.metrics.logicalBytes++;},'stable_workload'],
 ['mode digest',r=>{r.samples[0].modes[1].logicalDigest='0'.repeat(64);},'logical'],['observation count',r=>{r.samples[0].modes[1].observations.pop();},'logical'],
 ['lease',r=>{r.leaseMs=9000;},'schema'],['CG0',r=>{r.cg0Proceed=true;},'adoption'],['CG3',r=>{r.cg3Proceed=true;},'adoption'],['backend claim',r=>{first(r).metrics.backendEligible=true;},'metric_adoption'],['profile claim',r=>{first(r).metrics.profileApproved=true;},'metric_adoption'],['isolation claim',r=>{first(r).metrics.nativeIsolationVerified=true;},'metric_adoption'],
 ['order count',r=>{r.samples[0].orders.pop();},'orders'],
 ['baseline missing',r=>{delete r.samples[0].production;},'baseline_bytes'],['baseline total',r=>{r.samples[0].production.imageBytes++;},'baseline_bytes'],['baseline disk below image',r=>{r.samples[0].production.diskBytes=1;},'baseline_bytes'],['baseline image count',r=>{r.samples[0].production.anchorImages++;},'baseline_images'],['baseline logical',r=>{r.samples[0].production.logicalDigest='0'.repeat(64);},'baseline_logical'],['baseline rounds',r=>{r.samples[0].production.observations.pop();},'baseline_logical'],['baseline round',r=>{r.samples[0].production.observations[0].round=9;},'baseline_round'],['baseline time',r=>{r.samples[0].production.observations[0].metrics.wallMs=4500;},'baseline_time'],
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
 ['capacity misclassification',r=>{const s=r.samples.find((x:any)=>x.cycles===8);s.modes[1]={mode:'W',status:'capacity',reason:'permission_denied'};s.orders=s.orders.map((o:any)=>{const live=['F','P','B'],offset=(o.round+s.cohort)%3;return {...o,modes:[...live.slice(offset),...live.slice(0,offset)]};});},'capacity'],['owner-copy accounting',r=>first(r).metrics.ownerBytesWithCopies++,'owner_copies'],
];
it.each(changes)('rejects corrupt comparison evidence: %s',(_name,change,reason)=>{const r=fresh();change(r);expect(()=>analyzeS0c(r)).toThrow('s0c_evidence_'+reason);});

it.each(['ownerBytesWithCopies','registryClosureBytes','anchorClosureBytes','ownerObjectCopies'])('rejects warm-up-only corruption of %s',field=>{const r=fresh(),m=r.samples[0].modes[2];m.metrics[field]++;expect(()=>analyzeS0c(r)).toThrow('s0c_evidence_stable_workload');});
it('rejects per-round owner-copy drift even when its internal sum remains valid',()=>{const r=fresh(),x=r.samples[0].modes[2].observations[1].metrics;x.registryClosureBytes++;x.ownerBytesWithCopies++;expect(()=>analyzeS0c(r)).toThrow('s0c_evidence_stable_workload');});
