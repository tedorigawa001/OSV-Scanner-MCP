import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const sha=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const r=JSON.parse(readFileSync(process.env.E2_P0_RUNNER_RECORD??'docs/validation/gradle-e2-p0-runner-2026-11-14.json','utf8'));
test('P0V01 record binds all inherited and new source bytes',()=>{
 const old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(Object.keys(old.sourceBindings)).toHaveLength(351);
 for(const [p,h]of Object.entries(old.sourceBindings))expect(r.sourceBindings[p],p).toBe(h);
 for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 for(const p of ['src/utils/gradleOwnedP0Runner.ts','src/utils/gradleOwnedP0Backend.ts','src/utils/gradleOwnedP0Socket.ts','src/cli/e2P0Preflight.ts','scripts/check-e2-p0-runner.mjs'])expect(r.sourceBindings[p]).toMatch(/^[a-f0-9]{64}$/);
});
test('P0V02 document and the regenerated baseline allow only the current-count correction',()=>{
 const text=readFileSync(r.document.path,'utf8'),old=JSON.parse(readFileSync(r.baseline.path,'utf8'));
 expect(sha(designSection(text,r.document.heading))).toBe(r.document.sha256);expect(sha(readFileSync(r.baseline.path))).toBe(r.baseline.sha256);
 expect(sha(designSection(text,old.document.heading))).toBe(old.document.sha256);
 expect(r.baseline).toMatchObject({commit:'59d5447',allowedChanges:['document.sha256'],oldCount:152,requestedHistoricalCount:178,currentCount:193});expect(old.verification.passed).toBe(193);
});
test('P0V03 real CLI diagnostic is unsupported without a backend and never starts a tool',()=>{
 expect(r.unconfiguredCLI.exitCode).toBe(2);expect(r.unconfiguredCLI.result).toEqual({schema:'cwc.e2-p0.runner-result.v1',status:'unsupported',reasons:['independent-backend-unconfigured'],calls:0,wireBytes:0,staticMetadataVerified:false,jobPermitIssued:false,runtimeAdmitted:false,candidateOperations:{reads:0,copies:0,execs:0,publications:0}});
 expect(r.compiler.purpose).toBe('local-cli-build-not-CBMC-or-Clang-proof');for(const h of Object.values(r.artifacts))expect(h).toMatch(/^[a-f0-9]{64}$/);
});
test('P0V04 native socket / separate process observations do not imply independent deployment',()=>{
 expect(r.scope).toEqual({metadataAcquisition:true,mutuallySignedProtocol:true,nativeUnixIPC:true,separateCliProcess:true,syntheticAuthorities:true,sameUID:true,independentlyDeployedBackend:false,actualToolsAcquired:false,toolImageBuilt:false,proofExecuted:false,workspaceEnforced:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0});
 expect(r.observations.restrictedNativeAttempt).toEqual({passed:3,failed:5,reason:'listen-EPERM'});expect(r.observations.authorizedNative).toEqual({passed:29,failed:0});
 const old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(r.observations.actualState).toEqual(old.expectations.actualState);expect(r.observations.missing).toEqual(old.expectations.missing);
});
test('P0V05 protocol retains bounded metadata and the original client deadline',()=>{
 expect(r.protocol).toEqual({apis:['ReadPins','ReadAcquisition','ReadPreflight','ReadLive'],maxCalls:8,totalWireLimit:8388608,frameLimit:1048576,originalClientDeadlineMs:5000,jobPermitIssued:false});
 expect(r.observations.preLookupRevocationRegression).toEqual({group:'P0B09',beforeFailed:1,afterPassed:1});
 expect(r.observations.cliAliasRegression).toEqual({group:'P0N08',beforeFailed:1,afterPassed:1});
 expect(r.observations.reviewRegressions).toEqual({finalGuard:{group:'P0B32',beforeFailed:4,afterPassed:4,afterResultFormatting:true,afterSynchronousCleanup:true,originalDeadlinePreserved:true},
  operatorFile:{groups:['P0N10','P0N11'],beforeFailed:10,beforePassed:6,afterPassed:16,roles:['config','key'],required:['regular-file','nonblocking-no-follow-open','pre-open-and-FD-identity','pre-read-and-post-read-path-identity','nanosecond-freshness','secret-zero-on-refusal']},
  nativeFinalGuard:{groups:['P0N09','P0N12'],passed:4,realUnixSocket:true,separateCliProcess:true},faultArtifact:'src/test/fixtures/gradleOwnedP0CliFault.mjs',faultsEnabledInProduction:false});
 expect(r.sourceBindings[r.observations.reviewRegressions.faultArtifact]).toMatch(/^[a-f0-9]{64}$/);
});
test('P0V06 executing Node and compiler images are distinct from unacquired verification tools',()=>{
 expect(r.runtime.node).toBe(process.version);expect(r.runtime.platform).toBe(process.platform);expect(r.runtime.arch).toBe(process.arch);expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));
 expect(r.compiler.imageDigest).toBe(sha(readFileSync(r.compiler.imagePath)));expect(r.status).toBe('backend-metadata-only-unsupported');
});
