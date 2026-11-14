import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,test} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {P0_PLAN} from '../fixtures/gradleOwnedCwcHb2P0Design.mjs';
import {P0_CAPACITY,P0_VERIFIER_FLAGS,P0_COMPILER_FLAGS,P0_ROLES} from '../../utils/gradleOwnedP0Contract.js';
const r=JSON.parse(readFileSync(process.env.E2_P0_CONTRACT_RECORD??'docs/validation/gradle-e2-p0-contract-2026-11-14.json','utf8'));
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
test('P0R01 record binds inherited baseline source closure and all new sources',()=>{
 expect(r.schema).toBe('cwc.e2-p0.contract-record.v1');expect(sha(readFileSync(r.baseline.path))).toBe(r.baseline.sha256);
 const old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(Object.keys(old.sourceBindings)).toHaveLength(346);
 for(const [p,h]of Object.entries(old.sourceBindings))expect(r.sourceBindings[p],p).toBe(h);
 for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 for(const p of ['src/utils/gradleOwnedP0Contract.ts','src/test/fixtures/gradleOwnedP0Fixture.ts','src/test/utils/gradleOwnedP0Contract.test.ts','scripts/check-e2-p0-contract.mjs'])expect(r.sourceBindings[p]).toMatch(/^[a-f0-9]{64}$/);
});
test('P0R02 exact documentation section is bound without modifying the prior contract',()=>{
 const text=readFileSync(r.document.path,'utf8');expect(sha(designSection(text,r.document.heading))).toBe(r.document.sha256);
 const old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(sha(designSection(text,old.document.heading))).toBe(old.document.sha256);
});
test('P0R03 real test runtime is recorded separately from unacquired tool images',()=>{
 expect(r.runtime.node).toBe(process.version);expect(r.runtime.platform).toBe(process.platform);expect(r.runtime.arch).toBe(process.arch);
 expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));expect(r.scope.actualToolsAcquired).toBe(false);
});
test('P0R04 actual state and eight missing requirements stay unsupported despite synthetic metadata success',()=>{
 expect(r.expectations.actualState).toEqual(P0_PLAN.actualState);expect(r.expectations.missing).toEqual(P0_PLAN.missing);
 expect(r.status).toBe('static-contract-only-unsupported');expect(r.scope).toEqual({metadataOnly:true,syntheticKeysAndEvidence:true,actualToolsAcquired:false,imagesBuilt:false,proofExecuted:false,workspaceEnforced:false,independentAuthorityDeployed:false,nativeConditionsExecuted:[],jobPermitIssued:false,runtimeAdmitted:false,physicalBoundProved:false,credit:0});
 expect(r.expectations.candidateOperations).toEqual({candidateReads:0,copies:0,execs:0,publications:0});
});
test('P0R05 schema profile constants retain design flags roles and original resource policy',()=>{
 expect(P0_VERIFIER_FLAGS).toEqual(P0_PLAN.configuration.verifierPrefix);expect(P0_COMPILER_FLAGS).toEqual(P0_PLAN.configuration.compilerPrefix);
 expect(P0_ROLES).toEqual(P0_PLAN.authorities.map((a:any)=>a.role));const w=P0_PLAN.workspace;
 expect(P0_CAPACITY.runnerMemory).toBe(w.job.memoryMaxBytes);expect(P0_CAPACITY.bootstrap).toBe(w.job.metadataBootstrapBytes);
 expect(P0_CAPACITY.disk).toBe(w.job.totalDiskReservationBytes);expect(P0_CAPACITY.store).toBe(w.store.reservedBytes);
 expect(P0_CAPACITY.watchdog).toBe(w.controller.watchdogReservationBytes);expect(w.originalCallBudget.memory).toBe(1048576);
 expect(w.originalCallBudget.verificationWork).toBe(156978);expect(w.originalCallBudget.globalUnit).toBeNull();
});
test('P0R06 record distinguishes regressions from planned native deployment conditions',()=>{
 expect(r.expectations.testGroups).toBe(48);expect(r.expectations.metadataTests).toBe(187);expect(r.expectations.recordTests).toBe(6);
 expect(r.expectations.redGreen).toEqual({tests:['P0S41','P0S42'],before:{passed:144,failed:2},after:{passed:146,failed:0}});
 expect(r.expectations.reviewRegressions).toEqual({negativeDeadline:{group:'P0S43',beforeFailed:2,afterPassed:2,effectiveDeadline:null,status:'revoked-or-expired',latched:true},
  failedPhase:{group:'P0S44',beforeFailed:10,afterPassed:10,allPhases:5,allGates:3},
  phaseEvidence:{reserved:['absent','absent','absent'],copied:['absent','absent','absent'],'result-validated':['success','absent','absent'],drained:['success','required','absent'],sealed:['success','required','required']},
  phaseEvidenceColumns:['result','drainWitness','sealWitness'],contradictionCases:8,normalPhaseCases:5,malformedFailureCases:1,
  gatePhase:{group:'P0S48',cases:15,accepted:{reserved:'pre-copy',copied:'pre-exec',sealed:'pre-publish'},beforeFailed:6,afterPassed:15,adjusted:['P0S35','P0S46'],adjustedBeforeFailed:4}});
 expect(r.scope.nativeConditionsExecuted).toEqual([]);expect(P0_PLAN.scope.jobPermitIssued).toBe(false);
});
