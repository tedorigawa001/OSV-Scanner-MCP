import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {PB0_LIMITS,PB0_PROFILE_DIGEST} from '../../utils/gradleOwnedP0StateContract.js';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const r=JSON.parse(readFileSync(process.env.PB0_RECORD??'docs/validation/gradle-e2-p0-pb0-2026-11-15.json','utf8'));
test('PBR01 inherited design record and source bytes remain unchanged',()=>{
 const old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(r.baseline.commit).toBe('fd82b26');expect(sha(readFileSync(r.baseline.path))).toBe(r.baseline.sha256);expect(Object.keys(old.sourceBindings)).toHaveLength(370);
 for(const [p,h]of Object.entries(old.sourceBindings))expect(r.sourceBindings[p],p).toBe(h);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
});
test('PBR02 record binds the new section without changing the historical design section',()=>{
 const text=readFileSync(r.document.path,'utf8'),old=JSON.parse(readFileSync(r.baseline.path,'utf8'));
 expect(sha(designSection(text,r.document.heading))).toBe(r.document.sha256);expect(sha(designSection(text,old.document.heading))).toBe(old.document.sha256);
 expect(r.document.heading).toContain('9.163');expect(designSection(text,r.document.heading)).toContain('PB1');
});
test('PBR03 static profile retains the approved proposal limits and explicit domains',()=>{
 expect(r.contract.profileDigest).toBe(PB0_PROFILE_DIGEST);expect(r.contract.limits).toEqual(PB0_LIMITS);
 expect(PB0_LIMITS).toMatchObject({request:16384,reply:1048576,queryReply:65536,header:4,parentWire:8388608,initCalls:2,metadataCalls:8,initWire:163856,metadataWire:8224752,worstMetadataWire:6553664,worstCombinedWire:6717520,deadlineMs:5000});
 expect(r.contract.domains).toEqual({readKey:'cwc.e2-p0.read-operation-key.v1',readIntent:'cwc.e2-p0.read-intent.v1',controlKey:'cwc.e2-p0.control-operation-key.v1',controlIntent:'cwc.e2-p0.control-intent.v1'});
 expect(r.contract.readAPIs).toHaveLength(4);expect(r.contract.controlAPIs).toHaveLength(13);expect(r.contract.recordKinds).toHaveLength(23);
});
test('PBR04 fixture success does not imply current authorization durability or IO admission',()=>{
 expect(r.status).toBe('PB0-static-fixture-only-unsupported');expect(r.scope).toEqual({strictFixtureContract:true,realEd25519Codec:true,memoryBudgetFixture:true,staticAPIAuthorization:true,fixedClock:true,sameProcess:true,currentAuthorityVerified:false,realParentReservation:false,durableStore:false,nativeBackendIntegration:false,dependencyClosureProved:false,physicalBoundProved:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0});
 expect(Object.values(r.actualState)).toEqual(Array(8).fill(null));expect(r.conditions).toHaveLength(48);expect(r.conditions.every((x:{executed:boolean})=>x.executed===false)).toBe(true);
 expect(r.reviewRegressions).toEqual({groups:['PBC18','PBC19','PBG11','PBG12','PBG13','PBG14','PBG15'],caseCounts:{PBC18:3,PBC19:3,PBG11:4,PBG12:1,PBG13:1,PBG14:1,PBG15:1},before:{passed:4,failed:10},after:{passed:14,failed:0},fixes:['api-specific-new-CAS-preconditions','bundle-local-workflow-init-ticket-and-grant-ownership'],historicalLookupPreserved:true,ownershipScope:'single-bundle-not-durable-or-cross-bundle'});
});
test('PBR05 exact signed codec measurements are reconciled with all ten prepaid calls',()=>{
 const o=r.codecObservation;expect(o.calls).toBe(10);expect(o.counts).toEqual({begin:1,initQuery:1,read:5,retry:1,audit:2});expect(o.heldWire).toEqual({init:163856,metadata:6553664});
 expect(o.actualWire).toBeGreaterThan(0);expect(o.actualWire).toBeLessThanOrEqual(o.worstCombinedWire);expect(o.worstCombinedWire).toBe(o.heldWire.init+o.heldWire.metadata);expect(o.worstCombinedWire).toBeLessThanOrEqual(o.parentWire);expect(o.largestReplyFrame).toBe(1048580);
 expect(o.workUpper).toBeNull();expect(o.memoryUpper).toBeNull();expect(o.realReservationVerified).toBe(false);expect(o.jobPermitIssued).toBe(false);expect(o.runtimeAdmitted).toBe(false);
});
test('PBR06 executing images and dependency entry pins are local verification evidence only',()=>{
 expect(r.runtime.node).toBe(process.version);expect(r.runtime.platform).toBe(process.platform);expect(r.runtime.arch).toBe(process.arch);expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));
 expect(sha(readFileSync(r.compiler.imagePath))).toBe(r.compiler.imageDigest);expect(r.compiler.purpose).toBe('local-TypeScript-build-not-verification-tool');expect(Object.keys(r.artifacts)).toHaveLength(5);
 for(const h of Object.values(r.artifacts))expect(h).toMatch(/^[a-f0-9]{64}$/);
 for(const e of r.dependencyEntryPins){expect(sha(readFileSync(e.packagePath))).toBe(e.packageDigest);expect(sha(readFileSync(e.entryPath))).toBe(e.entryDigest);}
});
