import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {P0_BACKEND_PLAN as p,P0_BACKEND_CONDITIONS as conditions} from '../fixtures/gradleOwnedP0BackendDesign.mjs';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const r=JSON.parse(readFileSync(process.env.E2_P0_BACKEND_DESIGN_RECORD??'docs/validation/gradle-e2-p0-backend-design-2026-11-15.json','utf8'));
const doc=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);

test('EBD01 design and deployment are explicitly separate',()=>{
 expect(p.status).toBe('design-only-unsupported');expect(p.scope).toEqual({designOnly:true,jobAuthorizerImplemented:false,durableStoreImplemented:false,epochAnchorDeployed:false,independentAuthorityBound:false,nativeConditionsExecuted:false,actualToolsAcquired:false,workspaceEnforced:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0});
 expect(Object.values(p.actualState)).toEqual(Array(8).fill(null));expect(doc).toContain('PB0〜PB5は本節では未実装');
});
test('EBD02 persistent access has an explicit new domain and no legacy fallback',()=>{
 expect(p.domains.profile).toBe('cwc.e2-p0.backend-state.v2');expect(p.domains.request).toBe('cwc.e2-p0.backend-request.v2');expect(p.domains.reply).toBe('cwc.e2-p0.backend-reply.v2');expect(p.domains.fallback).toBe(false);expect(p.domains.legacy).toBe('v1-diagnostic-only-no-persistent-job-access');
 expect(new Set(Object.values(p.domains).filter(x=>typeof x==='string')).size).toBe(Object.values(p.domains).filter(x=>typeof x==='string').length);
});
test('EBD03 job identity is immutable and independent of future refs and mutable epochs',()=>{
 expect(p.identities.jobId).toEqual(['realmId','controllerJobId','randomNonce']);expect(p.identities.axes).toEqual(['jobDigest','authRevision','selectionRevision','ownerHeadRevision','bootEpoch','storageEpoch','keyEpoch']);
 expect(p.identities.jobDescriptor).toContain('initialEpochVector');for(const x of p.identities.jobDigestExcludes)expect(p.identities.jobDescriptor).not.toContain(x);
 expect(p.identities.restartKeepsStorageEpoch).toBe(true);expect(p.identities.jobResumedAcrossRestart).toBe(false);expect(p.identities.deadlineMayOnlyShorten).toBe(true);
});
test('EBD04 trust roots and reader keys do not substitute for independent approval or rollback',()=>{
 expect(p.trust.approvalKinds).toEqual(['method','environment']);expect(p.trust.readerKeyMustDifferFrom).toHaveLength(6);expect(p.trust.actualPrincipals).toBeNull();expect(p.trust.actualKeys).toBeNull();expect(p.trust.actualACLs).toBeNull();expect(p.trust.actualAnchor).toBeNull();
 expect(p.trust.existingC3bIsApproval).toBe(false);expect(p.trust.localCheckpointIsIndependentRollbackProtection).toBe(false);expect(p.trust.epochAnchor).toContain('separate key/root/rollback domain');
});
test('EBD05 all read APIs have distinct exact-job purposes and role-owned sources',()=>{
 expect(p.readPolicy.map((x:any)=>[x.api,x.owner,x.purpose])).toEqual([['ReadPins','registry','job-pins'],['ReadAcquisition','custodian','job-acquisition'],['ReadPreflight','controller','job-preflight'],['ReadLive','registry','job-live']]);
 for(const x of p.readPolicy){expect(x.grant).toBe('exact-job-reader');expect(x.states.every((s:string)=>['metadata-ready','preflight-ready'].includes(s))).toBe(true);expect(doc).toContain(x.purpose);}
 expect(p.readPolicy[2].states).toEqual(['preflight-ready']);expect(p.readPolicy[3].source).toContain('never cached now');
});
test('EBD06 all management APIs require a bounded role and purpose',()=>{
 expect(p.management.map((x:any)=>x.api)).toEqual(['RegisterJob','InstallApproval','RecordReservation','PublishCurrentPin','IssueReaderGrant','BeginWorkflow','RevokeReaderGrant','RevokeJob','QueryOperation','ReconcileDebt','ReportBootPrepared','ActivateEpoch','ReadRecoveryStatus']);
 for(const x of p.management){expect(x.caller).toBeTruthy();expect(x.owner).toBeTruthy();expect(x.purpose).toBeTruthy();expect(doc).toContain(x.api);expect(doc).toContain(x.purpose);}
 expect(p.management.find((x:any)=>x.api==='QueryOperation').effect).toContain('historical/pending refs only');expect(doc).toContain('別のcontrol／maintenance予約');
});
test('EBD07 grant and v2 request bind the complete job and delivery context',()=>{
 for(const f of ['jobDigest','authenticatedCredentialId','apiSet','purposeSet','sourceRefSet','authRevision','selectionRevision','epochVectorDigest','originalDeadline'])expect(p.grantFields).toContain(f);
 for(const f of ['profileDigest','realmId','jobDigest','grantRef','workflowRef','operationKey','intentDigest','currentPinRef','authRevision','expectedEpochVector','budgetSliceRef','originalDeadline','clientCredentialId','clientKeyEpoch','serverBoot','session','sequence','nonce'])expect(p.requestFields).toContain(f);
});
test('EBD08 authorization and durable intent precede job IO with a fresh gate after persistence',()=>{
 expect(p.gateOrder).toEqual(['bounded-bootstrap-frame','authenticate-client-and-api','fresh-global-epoch-and-routing-ACL','exact-job-grant-and-purpose','reserve-intent-replay-budget-cleanup','durable-intent-and-anchor-head','fresh-after-persistence-before-job-IO','bounded-source-capture','post-capture-auth-epoch-deadline','persist-response-ready-and-anchor-head','format-and-sign-delivery-context','final-local-admission-and-original-deadline','enqueue-or-refuse']);
 expect(p.gate.jobReadsBeforeAuthorization).toBe(0);expect(p.gate.jobReadsAfterReservationRevocation).toBe(0);expect(p.gate.perJobIOBeforeIntentDurable).toBe(0);expect(p.gate.callbacksBetweenLocalGateAndIO).toBe(false);expect(p.gate.asyncGapRequiresNewGate).toBe(true);expect(p.gate.finalClientAnchorReadRequired).toBe(true);
 expect(doc).toContain('認可に必要なfieldを得るためにjob payloadを先読みしない');
});
test('EBD09 terminal job states do not restore grants or resume after boot',()=>{
 expect(p.state.job.settled).toEqual([]);expect(p.state.job.revoking).toEqual(['fenced']);expect(p.state.job.fenced).toEqual(['quarantined','settled']);expect(p.state.job.quarantined).toEqual(['settled']);
 for(const [state,next] of Object.entries(p.state.job))for(const x of next as string[])expect(p.state.job).toHaveProperty(x);
 expect(p.state.grantRestore).toContain('no deadline or quota reset');expect(p.state.oldJobAfterRestart).toBe('terminal-old-epoch-historical-only');
});
test('EBD10 service recovery and realm admission have separate barriers',()=>{
 expect(p.state.service.recovering).toEqual(['control-ready','blocked']);expect(p.state.service.blocked).toEqual([]);expect(p.state.realmServingRequires).toEqual(['all-owner-local-recovery','old-epoch-invalidation-durable','manager-old-process-fence','new-epoch-anchor-selected','all-adoption-receipts-durable','current-bootstrap-pin-installed']);
 expect(p.restart.recoveryPortNeedsNormalJobGrant).toBe(false);expect(doc).toContain('通常job grantを要求して循環させない');
});
test('EBD11 independent heads and synced local adoption precede every normal ACK',()=>{
 expect(p.persistence.ackOrder).toEqual(['exact-CAS-and-capacity-reservation','write-exclusive-temp','sync-payload-and-journal-files','publish-immutable-files-and-sync-directories','sync-local-checkpoint-and-directory','independent-anchor-CAS-or-origin-query','persist-and-sync-local-adoption','fresh-auth-epoch-deadline-check','sign-and-send']);
 expect(p.persistence.checkpointResyncRequired).toBe(true);expect(p.persistence.successBeforeAdoption).toBe(false);expect(p.persistence.failureAfterWrite).toBe('blocked-with-debt-and-query-origin-before-retry');expect(p.persistence.independentAnchorAxes).toHaveLength(4);
 expect(doc).toContain('最初のenqueueより前にresponse-may-have-escapedの保守的状態をdurable確定');
});
test('EBD12 digest DAG excludes future preflight and outer delivery signatures',()=>{
 expect(p.persistence.digestOrder).toEqual(['job-and-source-facts','approval-and-reservation-descriptors','current-pin-payload','preflight-record','response-semantic-body','response-ready-receipt','outer-delivery-signature']);
 expect(p.persistence.noCycle).toEqual(['job contains no current pin','current pin contains no future preflight','response-ready contains no outer signature or delivery receipt']);expect(p.persistence.frozenPredecessorRetry).toContain('never reapply after later transaction');
});
test('EBD13 semantic operation identity excludes envelope nonce but preserves original deadlines',()=>{
 expect(p.replay.operationKey).toEqual(['realmId','jobDigest','clientCredentialId','clientKeyEpoch','workflowId','api','operationId']);expect(p.replay.frameKey).toEqual(['clientCredentialId','clientKeyEpoch','serverBoot','session','sequence','nonce']);
 expect(p.replay.intentIncludes).toEqual(['purpose','exactSourceRefs','currentPinRef','authRevision','originalEpochVector','originalDeadline','budgetSliceRef']);expect(p.replay.intentExcludes).toEqual(['session','sequence','nonce','maxWaitMs','transportSignature']);expect(p.replay.sameKeyDifferentIntent).toBe('conflict-no-source-read');
});
test('EBD14 replay recovery returns historical state without inventing fresh live observations',()=>{
 expect(p.replay.sameKeySameIntent).toContain('no automatic fresh reply');expect(p.replay.liveBodyReuse).toBe(false);expect(p.replay.originalTimerPreserved).toBe(true);expect(p.replay.newHandleResetsWorkflowBudget).toBe(false);expect(p.replay.unknownIsNoEffect).toBe(false);expect(p.replay.lostReply).toContain('SAME workflow deadline/budget');
});
test('EBD15 revocation request and effective owner-local fences are different boundaries',()=>{
 expect(p.revocation.order).toEqual(['persist-and-anchor-revoking','stop-new-central-admissions','install-owner-local-fences','persist-owner-fence-acks','drain-or-quarantine-in-flight','persist-and-anchor-effective-revocation','fresh-control-ACK']);
 expect(p.revocation.requestedIsEffective).toBe(false);expect(p.revocation.zeroNewOwnerReadsAfter).toBe('owner-local-fence-installed');expect(p.revocation.effectiveACKRequiresAllOwners).toBe(true);expect(p.revocation.unknownOwner).toBe('revoking-not-serving-no-complete-ACK');expect(p.revocation.restoreSameRevision).toBe(false);
});
test('EBD16 old epoch invalidation is durable before new job admission',()=>{
 expect(p.restart.order).toEqual(['close-normal-admission-and-fence-old-endpoints','acquire-own-writer-lock-and-bootstrap','verify-journal-checkpoint-and-independent-anchor','resolve-unknown-origin-transactions','persist-old-epoch-invalidation-and-debt','prepare-manager-approved-new-boots','independent-epoch-vector-CAS','persist-all-local-adoptions','install-approved-root-pin','enable-only-new-job-workflows']);
 for(const k of ['restoreOldMonotonicDeadline','oldRequestsAccepted','oldRepliesAccepted','oldGrantRewrapped','newStorageEpochOnEveryBoot','newBootAloneClearsDebt'])expect(p.restart[k],k).toBe(false);
});
test('EBD17 all retry query and frame header capacity is prepaid within metadata wire limits',()=>{
 const b=p.budget;expect(b.slots).toEqual({ordinary:5,retry:1,query:2});expect(b.maxRPC).toBe(8);expect(b.deadlineMs).toBe(5000);expect(b.frameHeaderBytes).toBe(4);
 const total=(b.slots.ordinary+b.slots.retry)*(b.requestCap+b.replyCap+2*b.frameHeaderBytes)+b.slots.query*(b.requestCap+b.queryReplyCap+2*b.frameHeaderBytes);
 expect(total).toBe(6553664);expect(b.worstWorkflowWire).toBe(total);expect(total).toBeLessThanOrEqual(b.totalWireBytes);expect(b.totalWireBytes).toBe(8388608);
 expect(doc).toContain('grant／approval／reservation期限の最小値に固定');expect(doc).toContain('monotonic値を直接比較しない');
});
test('EBD18 proposed storage partitions do not imply sufficient recovery space or raise old limits',()=>{
 const b=p.budget;expect(Object.entries(b.ownerDisk).filter(([k])=>k!=='total').reduce((s,[,v])=>s+(v as number),0)).toBe(b.ownerDisk.total);expect(b.ownerDisk.total).toBe(64*1024*1024);
 expect(b.ownerStages).toEqual({total:256,normal:192,cleanup:64});expect(b.capacityCertificateBeforeAdmission).toBe(true);expect(b.cleanupCapIsSufficiencyProof).toBe(false);expect(b.existingC3bLimitsRaised).toBe(false);expect(b.automaticGC).toBe(false);
 expect(doc).toContain('cleanup64は十分性の証明ではない');
});
test('EBD19 debt reconciliation requires every owner and does not refund spent counters',()=>{
 expect(p.debt.mayNotReleaseOn).toEqual(['timeout','transport-close','retry','new-session','new-boot','TTL','zero','GC-time']);expect(p.debt.releaseRequires).toEqual(['current-control-authorization','all-owner-exact-debt-join','drain-and-fence-evidence','allocator-and-store-release-evidence','durable-reconciliation-and-anchor']);
 for(const x of ['heldCapacity','spentCounters','unknownEffectFloor','pendingWrites','fenceRefs','drainRefs','reconciliationRef'])expect(p.debt.fields).toContain(x);expect(p.debt.refundSpent).toBe(false);expect(p.debt.tombstoneRetained).toBe(true);
});
test('EBD20 metadata budgets never fill unknown original memory work or global units',()=>{
 expect(p.budget.proposedOnly).toBe(true);expect(p.budget.crossUnitOffset).toBe(false);expect(p.budget.proofCreationPaysForConsumption).toBe(false);expect(p.budget.originalCall).toEqual({memory:1048576,verificationWork:156978,providerLimit:1048576,providerUnit:'cpr.request-bytes-ranges-probes.v1',globalLimit:67108864,globalUnit:null});
 expect(p.refusal.permit).toBe(false);expect(p.gate.metadataReplyIsExecutionPermit).toBe(false);
});
test('EBD21 PB0 through PB5 preserve their implementation and deployment limits',()=>{
 expect(p.steps.map((s:any)=>s.id)).toEqual(['PB0','PB1','PB2','PB3','PB4','PB5']);for(const s of p.steps){expect(doc).toContain('| '+s.id+' |');expect(s.task).toBeTruthy();expect(s.exit).toBeTruthy();}expect(p.next).toContain('PB0');
});
test('EBD22 all 48 runtime conditions are present once and remain planned unexecuted',()=>{
 expect(conditions.map(x=>x.id)).toEqual(Array.from({length:48},(_,i)=>'EB'+String(i+1).padStart(2,'0')));
 for(const x of conditions){expect(x.status).toBe('planned');expect(x.executed).toBe(false);expect(doc.split('| '+x.id+' | '+x.condition+' |')).toHaveLength(2);}expect(doc).toContain('すべてplanned・未実行');
});
test('EBD23 record binds all unchanged baseline sources and new design bytes',()=>{
 const old=JSON.parse(readFileSync(r.baseline.path,'utf8'));expect(r.baseline.commit).toBe('7f32ab1');expect(sha(readFileSync(r.baseline.path))).toBe(r.baseline.sha256);expect(Object.keys(old.sourceBindings)).toHaveLength(366);
 for(const [path,h] of Object.entries(old.sourceBindings))expect(r.sourceBindings[path],path).toBe(h);for(const [path,h] of Object.entries(r.sourceBindings))expect(sha(readFileSync(path)),path).toBe(h);
 expect(sha(doc)).toBe(r.document.sha256);expect(sha(designSection(readFileSync(old.document.path,'utf8'),old.document.heading))).toBe(old.document.sha256);
});
test('EBD24 record preserves actual unsupported state and executing image without claiming native proof',()=>{
 expect(r.plan).toEqual(p);expect(r.conditions).toEqual(conditions);expect(r.scope).toEqual(p.scope);expect(r.actualState).toEqual(p.actualState);expect(r.status).toBe('design-only-unsupported');expect(r.runtime.node).toBe(process.version);expect(r.runtime.platform).toBe(process.platform);expect(r.runtime.arch).toBe(process.arch);expect(r.runtime.nodeBinaryDigest).toBe(sha(readFileSync(process.execPath)));
});
test('EBD25 management operation identity is independent of read job workflow identity',()=>{
 expect(p.control.keyDomain).toBe('cwc.e2-p0.control-operation-key.v1');expect(p.control.intentDomain).toBe('cwc.e2-p0.control-intent.v1');
 expect(p.control.operationKey).toEqual(['profileDigest','realmId','targetOwner','targetSubject','clientCredentialId','clientKeyEpoch','api','operationId']);
 for(const x of ['jobDigest','workflowId','serverBoot','session','sequence','nonce'])expect(p.control.operationKey).not.toContain(x);
 expect(p.control.intentIncludes).toEqual(['operationKeyDigest','purpose','controlGrantRef','apiPayloadCanonicalDigest','expectedState','expectedOwnerHead','originalEpochVector','originalControlDeadline','controlBudgetSliceRef']);
 expect(p.control.sameKeyDifferentIntent).toBe('conflict-before-mutation');expect(p.control.sameKeySameIntent).toBe('fresh-authorized-historical-receipt-no-reapply');
});
test('EBD26 jobless control APIs have realm subjects and no artificial job revisions',()=>{
 expect(p.control.subjects).toEqual({RegisterJob:'job',InstallApproval:'job',RecordReservation:'job',PublishCurrentPin:'job',IssueReaderGrant:'job',BeginWorkflow:'job',RevokeReaderGrant:'job',RevokeJob:'job',QueryOperation:'origin-subject',ReconcileDebt:'job',ReportBootPrepared:'realm',ActivateEpoch:'realm',ReadRecoveryStatus:'realm'});
 expect(p.control.expectedState).toEqual({RegisterJob:'job-absent',job:'job-exact-revision',realm:'realm-exact-revision',QueryOperation:'current-audit-state-not-origin-revision'});
 expect(p.control.subjects.BeginWorkflow).toBe('job');expect(p.control.beginRequiresExistingWorkflow).toBe(false);
 expect(p.control.journalSubject).toBe('tagged-job-or-realm-no-fabricated-job-or-workflow');expect(p.control.debtSubject).toBe('control-origin-key-before-workflow-creation');
});
test('EBD27 query identity and current authorization never replace the original K D or CAS receipt',()=>{
 expect(p.control.originFields).toEqual(['domain','owner','subject','operationKey','intentDigest']);expect(p.control.queryOwnIdentitySeparate).toBe(true);expect(p.control.originDomains).toEqual(['metadata-read','control']);
 expect(p.control.originIsCurrentCAS).toBe(false);expect(p.control.originLookupBeforeNewCAS).toBe(true);expect(p.control.queryMayReapply).toBe(false);expect(p.control.queryMayIssueGrant).toBe(false);expect(p.control.queryMayResetDeadline).toBe(false);
 expect(p.control.queryBudgetRouting).toEqual({initialBegin:'init-control',metadataRead:'metadata-audit',otherControl:'separately-reserved-maintenance'});
 expect(doc).toContain('query自身のcontrol K／Dとorigin K／Dを別field');
});
test('EBD28 BeginWorkflow and its recovery query have a prepaid separate slice within the original parent',()=>{
 const b=p.budget,c=b.initControl;expect(c.maxRPC).toBe(2);expect(c.slots).toEqual({begin:1,originQuery:1});expect(c.requestCap).toBe(16384);expect(c.replyCap).toBe(65536);expect(c.frameHeaderBytes).toBe(4);
 const control=c.maxRPC*(c.requestCap+c.replyCap+2*c.frameHeaderBytes);expect(control).toBe(163856);expect(c.wireBytes).toBe(control);expect(c.metadataWireSliceBytes).toBe(b.totalWireBytes-control);
 expect(c.metadataWireSliceBytes).toBe(8224752);expect(b.worstWorkflowWire).toBeLessThanOrEqual(c.metadataWireSliceBytes);expect(c.combinedWorstWire).toBe(b.worstWorkflowWire+control);expect(c.combinedWorstWire).toBe(6717520);expect(c.combinedWorstWire).toBeLessThanOrEqual(b.totalWireBytes);
 expect(c.combinedMaxRPC).toBe(b.maxRPC+c.maxRPC);expect(c.combinedMaxRPC).toBe(10);expect(c.sameWireUnit).toBe(b.metadataUnit);expect(c.beginUsesMetadataTicket).toBe(false);
});
test('EBD29 initialization and lost-reply recovery preserve the start deadline and all parent consumption',()=>{
 const c=p.budget.initControl;expect(c.reserveBeforeFirstControlIO).toBe(true);expect(c.deadlineOrigin).toBe('before-initialization-reservation');expect(c.deadlineMs).toBe(p.budget.deadlineMs);expect(c.beginOrQueryResetsDeadline).toBe(false);expect(c.repeatedBeginAllowed).toBe(false);expect(c.unknownKeepsReservation).toBe(true);expect(c.lateQueryIsAuditOnly).toBe(true);
 expect(c.workUnit).toBeNull();expect(c.workUpper).toBeNull();expect(c.memoryUpper).toBeNull();expect(c.capacityCertificateRequired).toBe(true);expect(c.controlIsFree).toBe(false);
 expect(p.budget.initBinding).toEqual({descriptorIncludes:['initId','beginControlKey','t0','originalDeadline','reservationRefs'],descriptorExcludes:['controlIntentDigest','workflowRef'],seal:'bind-control-D-once-before-dispatch-no-future-ref-in-request'});
 expect(doc).not.toContain('BeginWorkflow以外の管理call');expect(doc).toContain('t0は初期化予約の前');
});
test('EBD30 review conditions explicitly cover control origin and initialization accounting',()=>{
 for(const id of ['EB14','EB15','EB22'])expect(conditions.find(x=>x.id===id)?.condition).toContain('control');
 expect(conditions.find(x=>x.id==='EB14')?.condition).toContain('origin');expect(conditions.find(x=>x.id==='EB15')?.condition).toContain('後続transaction');expect(conditions.find(x=>x.id==='EB22')?.condition).toContain('payload');
 const wire=conditions.find(x=>x.id==='EB28')?.condition;expect(wire).toContain('BeginWorkflow');expect(wire).toContain('10 RPC');expect(wire).toContain('8 MiB');
 expect(r.reviewRegressions).toEqual({groups:['EBD25','EBD26','EBD27','EBD28','EBD29','EBD30'],before:{passed:0,failed:6},after:{passed:6,failed:0},kind:'design-consistency-not-runtime',fixes:['separate-control-K-D-and-query-origin','prepaid-init-control-slice-within-original-wire-parent'],nativeConditionsExecuted:0});
});
