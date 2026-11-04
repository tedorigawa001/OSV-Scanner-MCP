import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {validateCgpReport} from '../fixtures/gradleOwnedCgpReport.js';
import {CGP_CAPACITY_PROJECTION} from '../fixtures/gradleOwnedCgpBudget.js';
const recordPath='docs/validation/gradle-c3b-cgp-2026-11-04.json';
async function load(){const record=JSON.parse(await readFile(recordPath,'utf8')),bytes=await readFile(record.measurements.path);expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.measurements.sha256);return {record,raw:JSON.parse(bytes.toString())};}
const refused=(r:any)=>r.samples.find((s:any)=>s.outcome==='deadline-refused');
it('keeps the measured counters and execution receipt consistent without promoting a page trial to native adoption',async()=>{const {raw,record}=await load();expect(validateCgpReport(raw).go).toBe(false);expect(record.sourceSha256).toEqual(raw.executionSources.files);expect(record.sourceClosureDigest).toBe(raw.executionSources.digest);expect(record.measuredAtCommit).toBe('426ab84');expect(record.decision.cg3Proceed).toBe(false);expect(record.decision.cg0Proceed).toBe(false);expect(record.decision.readsPerGenerationTarget).toBe(8);expect(record.decision.capacityProjection).toEqual(CGP_CAPACITY_PROJECTION);});
it.each<[string,(r:any)=>void,string]>([
 ['a refused reason that no longer matches its outcome',r=>{refused(r).reason='Error: current_control_grant_revoked';},'failure_classification'],
 ['a deadline reason relabelled as another refusal',r=>{refused(r).outcome='other-refused';},'failure_classification'],
 ['a completed read that carries a refusal reason',r=>{r.samples.find((s:any)=>s.outcome==='completed').reason='Error: current_control_request_expired';},'failure_classification'],
 ['an adoption claim',r=>{r.backendEligible=true;},'adoption_flag'],
 ['an altered publication count',r=>{r.samples[0].publishedThisRead=7;},'publication'],
 ['an altered call summary',r=>{r.samples[0].calls.groups[0].count++;},'call_summary'],
 ['an altered budget',r=>{r.budget.projectedMs=0;},'budget'],
 ['a shortened page trial',r=>{r.prototypeRuns[0].observations.find((o:any)=>o.mode==='paged').writes.pop();},'trial_reads'],
])('rejects a rehashed measurement artifact with %s',async(_name,change,reason)=>{const {raw}=await load(),r=structuredClone(raw);change(r);expect(()=>validateCgpReport(r)).toThrow(new RegExp('^cgp_evidence_'+reason+'$'));});
