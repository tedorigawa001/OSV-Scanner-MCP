import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {PB1_PROFILE,PB1_LIMITS} from '../../utils/gradleOwnedP1Contract.js';
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const r=JSON.parse(readFileSync(process.env.PB1_RECORD??'docs/validation/gradle-e2-p0-pb1-2026-11-16.json','utf8'));
it('PBDR01 baseline and all inherited source bytes remain unchanged',()=>{
 expect(r.baseline.commit).toBe('486af1e');const b=readFileSync(r.baseline.path);expect(sha(b)).toBe(r.baseline.sha256);const old=JSON.parse(b.toString());expect(Object.keys(old.sourceBindings)).toHaveLength(380);
 for(const [p,h]of Object.entries(old.sourceBindings))expect(r.sourceBindings[p],p).toBe(h);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
});
it('PBDR02 document and historical section digests bind the implemented scope',()=>{
 const doc=readFileSync(r.document.path,'utf8'),old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(r.document.heading).toContain('9.164');expect(sha(designSection(doc,r.document.heading))).toBe(r.document.sha256);expect(sha(designSection(doc,old.document.heading))).toBe(old.document.sha256);
});
it('PBDR03 same-UID local disk evidence grants no runtime or independent rollback credit',()=>{
 expect(r.status).toBe('PB1-local-disk-only-unsupported');expect(r.scope).toEqual({localDisk:true,authenticatedJournal:true,localCheckpoint:true,externalAnchorPort:true,anchorAdapter:'test-only-same-UID-disk',realSIGKILL:true,nativeKillBoundaries:4,strictStageReplay:true,separateDurableEscape:true,originTombstone:true,fixedClock:true,currentAuthorizer:'trusted-fixture-port',independentAnchorVerified:false,OSIsolationVerified:false,realParentReservation:false,physicalMemoryUpper:null,workUpper:null,fullEpochRecovery:false,v2IPCConnected:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0});
 expect(Object.values(r.actualState)).toEqual(Array(8).fill(null));expect(r.conditions).toHaveLength(48);expect(r.conditions.every((c:{executed:boolean})=>!c.executed)).toBe(true);
});
it('PBDR04 local quotas retain the 64 MiB partition without physical/work equivalence',()=>{
 expect(r.profileDigest).toBe(PB1_PROFILE);expect(r.limits).toEqual(PB1_LIMITS);const l=r.limits;expect(l.payload+l.journal+l.checkpoint+l.adoption+l.scratch).toBe(64*1024*1024);expect(l.normal+l.cleanup).toBe(l.stages);expect(l.stages).toBe(256);expect(r.scope.workUpper).toBeNull();
});
it('PBDR05 all disk cases and four actual SIGKILL boundaries are mandatory and unskipped',()=>{
 const v=r.verification;expect(v.passed).toBe(66);expect(v.failed).toBe(0);expect(v.skipped).toBe(0);expect(v.names).toHaveLength(66);expect(new Set(v.names).size).toBe(66);expect(v.groups).toEqual(Array.from({length:34},(_,i)=>'PBD'+String(i+1).padStart(2,'0')));expect(v.nativeSIGKILLCaseNames).toEqual(v.names.filter((n:string)=>n.startsWith('PBD20 ')));expect(v.nativeSIGKILLCaseNames).toHaveLength(4);expect(v.fullEBRuntimeConditionsCompleted).toBe(0);
 expect(r.reviewRegressions).toEqual({groups:['PBD30','PBD31','PBD32'],caseCounts:{PBD30:2,PBD31:4,PBD32:1},before:{passed:1,failed:6},after:{passed:7,failed:0},fixes:['audit-stream-binding-before-history-and-file-read','reentry-guard-before-commit-and-audit-parsing'],auditMismatch:{historyReads:0,fileReads:0,anchorCalls:0},caughtMalformedReentry:{outerACK:0,blocked:true,durableEffectsRetained:true},idleMalformedInputRemainsNonfatal:true,scope:'same-UID-real-disk-and-trusted-callback-fixture'});
 expect(r.secondReviewRegressions).toEqual({groups:['PBD33','PBD34'],adjusted:['PBD30'],caseCounts:{PBD33:3,PBD34:4},before:{passed:0,failed:7},after:{passed:7,failed:0},fixes:['cleanup-stage-uses-recovery-grant-not-original-deadline','pre-write-refusal-does-not-block'],preWriteRefusal:{blocked:false,anchorWrites:0},postWriteFailureBlocks:true,concurrentCallsTreatedAsReentry:true});
 for(const [group,count]of Object.entries({...r.reviewRegressions.caseCounts,...r.secondReviewRegressions.caseCounts}))expect(v.names.filter((n:string)=>n.startsWith(group+' ')),group).toHaveLength(count as number);
});
it('PBDR06 Node compiler native adapter and dependency entries bind the executing images',()=>{
 expect(r.runtime.node).toBe(process.version);expect(r.runtime.platform).toBe(process.platform);expect(r.runtime.arch).toBe(process.arch);expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));expect(r.compiler.imageDigest).toBe(sha(readFileSync(r.compiler.imagePath)));expect(r.nativeImage.sha256).toBe(sha(readFileSync(r.nativeImage.path)));expect(r.nativeImage.purpose).toContain('not-isolation-proof');
 expect(Object.keys(r.artifacts)).toHaveLength(6);for(const h of Object.values(r.artifacts))expect(h).toMatch(/^[a-f0-9]{64}$/);for(const e of r.dependencyEntryPins){expect(sha(readFileSync(e.packagePath))).toBe(e.packageDigest);expect(sha(readFileSync(e.entryPath))).toBe(e.entryDigest);}
});
