import {it,expect} from 'vitest';
import {readFile,writeFile,mkdir,mkdtemp,rm,realpath} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
import {validateCgpReport} from '../fixtures/gradleOwnedCgpReport.js';
import {CGP_CAPACITY_PROJECTION} from '../fixtures/gradleOwnedCgpBudget.js';
import {CGP_PARTIAL_SCHEMA} from '../fixtures/gradleOwnedCgpOutcome.js';
const recordPath='docs/validation/gradle-c3b-cgp-2026-11-04.json';
async function load(){const record=JSON.parse(await readFile(recordPath,'utf8')),bytes=await readFile(record.measurements.path);expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.measurements.sha256);return {record,raw:JSON.parse(bytes.toString())};}
const refused=(r:any)=>r.samples.find((s:any)=>s.outcome==='deadline-refused');
const owner=(r:any)=>r.samples[0].owners[0],category=(r:any)=>Object.values(owner(r).categories)[0] as any,span=(r:any)=>r.samples[0].rawSpans[0],trial=(r:any,mode:string)=>r.prototypeRuns[0].observations.find((o:any)=>o.mode===mode),write=(r:any)=>trial(r,'paged').writes[0];
it('keeps the measured counters and execution receipt consistent without promoting a page trial to native adoption',async()=>{const {raw,record}=await load();expect(validateCgpReport(raw).go).toBe(false);expect(record.sourceSha256).toEqual(raw.executionSources.files);expect(record.sourceClosureDigest).toBe(raw.executionSources.digest);expect(record.measuredAtCommit).toBe('426ab84');expect(record.decision.cg3Proceed).toBe(false);expect(record.decision.cg0Proceed).toBe(false);expect(record.decision.readsPerGenerationTarget).toBe(8);expect(record.decision.capacityProjection).toEqual(CGP_CAPACITY_PROJECTION);});
it.each<[string,(r:any)=>void,string]>([
 ['a refused reason that no longer matches its outcome',r=>{refused(r).reason='Error: current_control_grant_revoked';},'failure_classification'],
 ['a deadline reason relabelled as another refusal',r=>{refused(r).outcome='other-refused';},'failure_classification'],
 ['a completed read that carries a refusal reason',r=>{r.samples.find((s:any)=>s.outcome==='completed').reason='Error: current_control_request_expired';},'failure_classification'],
 ['an adoption claim',r=>{r.backendEligible=true;},'adoption_flag'],
 ['an altered publication count',r=>{r.samples[0].publishedThisRead=7;},'publication'],
 ['an altered call summary',r=>{r.samples[0].calls.groups[0].count++;},'call_summary'],
 ['an altered budget',r=>{r.budget.projectedMs=0;},'budget'],
 ['a shortened page trial',r=>{trial(r,'paged').writes.pop();},'trial_reads'],
 ['a partial report offered as a measurement',r=>{r.schema=CGP_PARTIAL_SCHEMA;},'schema'],
 ['a native isolation claim',r=>{r.nativeIsolationVerified=true;},'adoption_flag'],
 ['an independent registry claim',r=>{r.independentRegistryVerified=true;},'adoption_flag'],
 ['skipped original reads',r=>{r.originalReadsSkipped=1;},'read_skip'],
 ['no samples',r=>{r.samples=[];},'sample_bound'],
 ['too many samples',r=>{r.samples=Array.from({length:25},()=>r.samples[0]);},'sample_bound'],
 ['a missing SGA proxy',r=>{r.proxyMs.pop();},'sga_proxy_count'],
 ['a missing page trial',r=>{r.prototypeRuns.pop();},'prototype_count'],
 ['a negative read time',r=>{r.samples[0].elapsedMs=-1;},'read_time'],
 ['a negative drain time',r=>{r.samples[0].drainMs=-1;},'read_time'],
 ['an invented outcome',r=>{r.samples[0].outcome='invented';},'read_outcome'],
 ['a refusal with no reason',r=>{refused(r).reason=null;},'failure_classification'],
 ['a missing owner process',r=>{r.samples[0].ownerProcesses.pop();},'process_count'],
 ['a repeated owner process row',r=>{r.samples[0].ownerProcesses.push(r.samples[0].ownerProcesses[0]);},'process_count'],
 ['owners sharing a process',r=>{for(const p of r.samples[0].ownerProcesses)p.pid=1;},'process_count'],
 ['a duplicated owner role',r=>{r.samples[0].owners[1].role=owner(r).role;},'owner_count'],
 ['an extra owner row',r=>{r.samples[0].owners.push(owner(r));},'owner_count'],
 ['a negative owner CPU time',r=>{owner(r).totalCpuMs=-1;},'owner_binding'],
 ['a negative owner window',r=>{owner(r).windowMs=-1;},'owner_binding'],
 ['an owner from another boot',r=>{owner(r).boot='other';},'owner_binding'],
 ['a fractional category count',r=>{category(r).count=1.5;},'category'],
 ['a negative category count',r=>{category(r).count=-1;},'category'],
 ['a negative category time',r=>{category(r).inclusiveWallMs=-1;},'category'],
 ['fractional category bytes',r=>{category(r).bytes=1.5;},'category'],
 ['negative category bytes',r=>{category(r).bytes=-1;},'category'],
 ['a span from an unknown owner',r=>{span(r).role='stranger';},'span'],
 ['a negative span start',r=>{span(r).startMs=-1;},'span'],
 ['a negative span time',r=>{span(r).wallMs=-1;},'span'],
 ['a negative span CPU time',r=>{span(r).inclusiveCpuMs=-1;},'span'],
 ['a missing full trial',r=>{r.prototypeRuns[0].observations=[trial(r,'paged'),trial(r,'paged')];},'trial_modes'],
 ['a missing paged trial',r=>{r.prototypeRuns[0].observations=[trial(r,'full'),trial(r,'full')];},'trial_modes'],
 ['a third trial mode',r=>{r.prototypeRuns[0].observations.push(trial(r,'paged'));},'trial_modes'],
 ['a full trial that never hit its limit',r=>{trial(r,'full').stopped=null;},'trial_outcome'],
 ['a paged trial that stopped',r=>{trial(r,'paged').stopped={reason:'cgp_capacity_exhausted'};},'trial_outcome'],
 ['a negative trial time',r=>{trial(r,'paged').wallMs=-1;},'trial_capacity'],
 ['fractional trial entries',r=>{trial(r,'paged').entries=1.5;},'trial_capacity'],
 ['trial entries over the limit',r=>{trial(r,'paged').entries=8193;},'trial_capacity'],
 ['fractional trial bytes',r=>{trial(r,'paged').physicalBytes=1.5;},'trial_capacity'],
 ['trial bytes over the limit',r=>{trial(r,'paged').physicalBytes=512*1024*1024+1;},'trial_capacity'],
 ['a revision gap',r=>{write(r).revision=2;},'trial_write'],
 ['a negative write time',r=>{write(r).wallMs=-1;},'trial_write'],
 ['a negative verify time',r=>{write(r).verifyMs=-1;},'trial_write'],
 ['a CAS over the wire budget',r=>{write(r).casBytes=45537;},'trial_write'],
 ['an opened CG3 gate',r=>{r.budget.cg3Gate='open';},'budget'],
 ['an altered budget comparison',r=>{r.budgetComparisons[0].projectedMs=0;},'budget_comparisons'],
 ['a missing source receipt',r=>{r.executionSources=null;},'source_receipt'],
 ['an altered source digest',r=>{r.executionSources.digest='0'.repeat(64);},'source_receipt'],
])('rejects a rehashed measurement artifact with %s',async(_name,change,reason)=>{const {raw}=await load(),r=structuredClone(raw);change(r);expect(()=>validateCgpReport(r)).toThrow(new RegExp('^cgp_evidence_'+reason+'$'));});

const analyzerPath=path.resolve('scripts/analyze-c3b-cgp.mjs');
/** Runs the real script on altered raw evidence in a throwaway tree; the committed record stays untouched. */
async function analyze(change:(raw:any)=>void){const {raw,record}=await load(),root=await realpath(await mkdtemp(path.join(os.tmpdir(),'cgp-analyze-'))),rawPath=path.join(root,record.measurements.path),outPath=path.join(root,recordPath);try{await mkdir(path.dirname(rawPath),{recursive:true});change(raw);await writeFile(rawPath,JSON.stringify(raw));await writeFile(outPath,JSON.stringify(record));await promisify(execFile)(process.execPath,[analyzerPath],{cwd:root,timeout:60000});return JSON.parse(await readFile(outPath,'utf8'));}finally{await rm(root,{recursive:true,force:true});}}
const read=(r:any,sample:number,index:number)=>r.samples.find((s:any)=>s.sample===sample&&s.index===index);
const refuseFirst=(r:any,sample:number)=>{r.samples=r.samples.filter((s:any)=>!(s.sample===sample&&s.index===2));Object.assign(read(r,sample,1),{outcome:'deadline-refused',reason:'Error: current_control_request_expired',publishedThisRead:0});};
it('leaves a refused first read out of the growth comparison and records why',async()=>{const summary=await analyze(r=>refuseFirst(r,3));expect(summary.timeBudget.consecutiveReadGrowth.map((g:any)=>g.sample)).toEqual([1,2]);expect(summary.timeBudget.consecutiveReadGrowthExcluded).toEqual([{sample:3,reason:'first_read_deadline-refused'}]);expect(summary.readSummary.firstRead).toEqual({completed:2,attempts:3});},120000);
it('leaves a second read that stopped before a compared phase out of the growth comparison',async()=>{const summary=await analyze(r=>{delete read(r,2,2).phases.authority;});expect(summary.timeBudget.consecutiveReadGrowth.map((g:any)=>g.sample)).toEqual([1,3]);expect(summary.timeBudget.consecutiveReadGrowthExcluded).toEqual([{sample:2,reason:'second_read_stopped_before_authority'}]);},120000);
it('still refuses to summarize a run with no completed read',async()=>{await expect(analyze(r=>{for(const sample of [1,2,3])refuseFirst(r,sample);})).rejects.toThrow(/no completed baseline for phase budget/);},120000);
