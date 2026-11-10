import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync('docs/validation/gradle-cwc-vf-design-2026-11-10.json','utf8'));
const section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const condition=(id:string)=>r.regressionConditions.find((x:any)=>x.id===id).condition;
it('binds the new section and the inspected implementations without modifying runtime sources',()=>{
 expect(sha(section)).toBe(r.document.sectionSha256);for(const [path,digest]of Object.entries(r.sourceBindings))expect(sha(readFileSync(path)),path).toBe(digest);
 expect(r.status).toBe('design-only');expect(Object.values(r.scope).every(v=>v===false)).toBe(true);
});
it('keeps forty-eight distinct runtime conditions and four implementation stages unexecuted',()=>{
 expect(r.regressionConditions.map((x:any)=>x.id)).toEqual(Array.from({length:48},(_,i)=>'CVF'+String(i+1).padStart(2,'0')));expect(r.stages.map((x:any)=>x.id)).toEqual(['VF-0','VF-1','VF-2','VF-3']);
 for(const x of [...r.regressionConditions,...r.stages]){expect(x.status).toBe('planned');expect(x.executed).toBe(false);expect(section).toContain('| '+x.id+' | '+x.condition+' |');}
});
it('limits static facts to owned bytes and actual call, scope, storage and generation membership',()=>{
 expect(r.contract.profile).toBe('cwc.session-private-verification-facts.v1');expect(r.contract.modes).toEqual(['full-verify','fact-live']);
 for(const name of r.contract.helperEntries)expect(section).toContain('| '+name+' |');for(const name of r.bindings)expect(section).toContain(name);
 for(const name of ['privateBytesMayEscape','arbitraryByteCallbackAllowed','callerValidFlagAllowed','postSealWritesAllowed','liveAuthorizationReceiptAllowed','readyFailureFallbackAllowed'])expect(r.contract[name]).toBe(false);
 for(const name of ['privateWireBeforeDecode','storageIdentityAndEpochRequired','transportAssociationRequired','staticPermissionIsHistoricalOnly'])expect(r.contract[name]).toBe(true);
 for(const text of r.excludedFromFacts)expect(section).toContain(text);
 for(const text of ['実参照','同じdigest','standalone association','一般API','fact-liveの任意書込検出成功と混同しない'])expect(section).toContain(text);
});
it('preserves live node positions and complete initial, session and transport final verification',()=>{
 for(const name of ['initialFullChecksRetained','readySealFullCheckRetained','sessionInspectRetained','linkCurrentInspectRetained','transportFinalFullChecksRetained','clbFinishFullCheckRetained','ordinaryInspectRetained'])expect(r.contract[name]).toBe(true);
 expect(r.contract.purposeSource).toBe('actual-server-permit-return-and-shared-current-policy');expect(condition('CVF19')).toContain('実server.permitAPIの返値');
 expect(r.contract.liveNodeMapping).toBe('one-to-one-position-and-count');expect(r.contract.unobservedRestoration).toBe('same-as-cfp10');
 for(const text of ['pre／postは新しい#liveを一律2回呼ぶという意味ではない','同じ位置・回数','currentPurpose = issuedPurpose = bindingPurpose = projectionPurpose','permissionのcopy・schema／canonical処理も残す','previousDeadlineFloor','実SessionServerのc.check・一般inspect・transport verifierは削減実装の変更対象へ含めない'])expect(section).toContain(text);
 for(const text of ['未観測対照','全live成功時だけ継続可能'])expect(condition('CVF21')).toContain(text);
 for(const text of ['CLB finish','独立counter'])expect(condition('CVF35')).toContain(text);
});
it('specifies sticky reentry and expiry, reader drain and late refusal independently of dispatch',()=>{
 for(const state of r.lifecycle.states)expect(section).toContain('| '+state+' |');
 expect(r.contract.sessionPreReadLifecycleGuardRequired).toBe(true);expect(condition('CVF38')).toContain('hash-before-check');
 expect(r.lifecycle.claimBeforeCallback).toBe(true);expect(r.lifecycle.externalReentryPoisonsOuter).toBe(true);expect(r.lifecycle.expireWaitsForDispatch).toBe(false);expect(r.lifecycle.scopeCloseWipesSessionStorage).toBe(false);
 expect(r.lifecycle.internalFrameCarriesAuthorization).toBe(false);expect(r.lifecycle.reclaim).toBe('terminal-and-privateReaders-zero');expect(r.lifecycle.lateReadOrPublicationAllowed).toBe(false);expect(r.lifecycle.spentRefundAllowed).toBe(false);expect(r.lifecycle.unfinishedDispatchRetainsCapacity).toBe(true);
 for(const text of ['内側例外を捕捉しても','finallyでreadyへ戻さない'])expect(condition('CVF26')).toContain(text);
 for(const text of ['control／generation','二重解放0','B取得・decode'])expect(condition('CVF38')).toContain(text);
 for(const text of ['強参照','zeroだけを解放済みと計上しない'])expect(condition('CVF40')).toContain(text);
});
it('requires a non-overlapping layout and advance reservations inside the old limits',()=>{
 const b=r.budgets;expect(b.wireStorageBytes+b.frameWorkspace+b.admissionCommandBytes).toBe(b.callBytes);expect(b.callBytes).toBe(98304);expect(b.bindingBytes).toBe(8192);expect(b.factMetadataCandidateBytes).toBe(4096);expect(b.memory).toBe(1048576);expect(b.logicalGateLimit).toBe(4096);expect(b.layoutProofRequired).toBe(true);expect(b.globalLimitsIncreased).toBe(false);
 for(const text of ['二重に割り当てない','copy／decode前','構造予算でありRSS上限の保証ではない'])expect(section).toContain(text);
 for(const text of ['消費・claim','論理gate上限4096'])expect(condition('CVF33')).toContain(text);
});
it('plans shape-matched scalar and batch controls with setup, observation and failures retained',()=>{
 const c=r.comparison;expect(c.arms).toEqual(['S/full-verify','S/fact-live','B/full-verify','B/fact-live']);expect(c.trials).toBe(c.workloads.length*c.roles.length*(c.warmupRounds+c.measuredRounds)*c.arms.length*c.observations.length);expect(c.measuredTrials).toBe(216);expect(c.deadlineMs).toBe(4500);expect(c.minimumImprovementPercent).toBe(5);
 for(const key of ['shadowFactsInFullVerify','totalIncludesConstructionThroughObserverRestore','legacyBridgeSeparate','failedTrialsRetained'])expect(c[key]).toBe(true);
 expect(c.ttlNormalization).toBe('comparison-only-actual-wire-budget-retained');
 for(const text of ['scalarも同じfact利用の候補','full-verifyでもshadow fact','元期限内に完了','各quiet roundでB/fact-liveをS/fact-liveとB/full-verify','288試行（実測216）','計測追加費用'])expect(section).toContain(text);
 for(const [id,text]of [['CVF42','全counterを整合させた検査件数削減'],['CVF43','operation合計／partitionを維持したactor費用移動'],['CVF45','別API対応付け'],['CVF48','本番・実storage・隔離・8 read・CG0／CG3']] as const)expect(condition(id)).toContain(text);
});

it('requires a complete authority revision fence after the final callback, independently of control generation',()=>{
 const f=r.authorizationFence;expect(f.owner).toBe('private-authority-owner');expect(f.captureBeforeFirstCallback).toBe(true);expect(f.compareAfterLastCallback).toBe(true);expect(f.controlGenerationOnlySufficient).toBe(false);expect(f.recordedRevocationSticky).toBe(true);expect(f.allMutationPathsCovered).toBe(true);expect(f.untrackedMutationAdapter).toBe('unsupported');expect(f.revisionRestorationAllowed).toBe(false);
 expect(f.finalClock).toBe('captured-trusted-monotonic-intrinsic');expect(f.finalWindow).toBe('bounded-synchronous-no-foreign-code');expect(f.finalRecheckIncludesRevisionAndGeneration).toBe(true);expect(f.authorizationReceiptReturned).toBe(false);expect(f.crossGateReuseAllowed).toBe(false);expect(f.bothModes).toBe(true);expect(f.budgetLayoutProofRequired).toBe(true);
 expect(f.mutationDomains).toEqual(['peer-credential','server-credential','key-epoch','permission-delegation-lineage','purpose-resolver','registry-pin','source-pin','profile-pin','policy-callback-slots']);
 for(const text of ['最後の時計callback','復元せず','control generationは不変','通知を迂回'])expect(condition('CVF22')).toContain(text);
 for(const text of ['最終clock intrinsic後','callbackなしの同期公開','fence後','公開前の認可変更','外側公開0'])expect(condition('CVF24')).toContain(text);
 for(const text of ['最終revision照合から','await・任意callback・時計callback・getter・Proxy','同値値への復元でもrevisionを戻さず','遠隔authorityの変更をローカルcellへ線形化できない場合も未対応','fence区間内のauthority mutationを未観測対照へ分類してはならない'])expect(section).toContain(text);
});
it('separates candidate completion and qualified deadline-censored controls without fabricating completion times',()=>{
 const p=r.candidatePolicy;expect(p.candidateAllNineMeasuredComplete).toBe(true);expect(p.allPrimaryCompleteRequired).toBe(false);expect(p.controlArms).toEqual(['S/full-verify','S/fact-live','B/full-verify']);expect(p.speedComparators).toEqual(['S/fact-live','B/full-verify']);expect(p.controlClasses).toEqual(['complete','deadline-censored','invalid']);expect(p.invalidControlDecision).toBe('defer');expect(p.censoredControlRequiresOriginalDeadlineWitness).toBe(true);expect(p.censorLowerBound).toBe('mapped-original-deadline-minus-total-start');expect(p.failureTotalUsedAsCompletion).toBe(false);expect(p.hardcodedDeadlineLowerBoundAllowed).toBe(false);expect(p.exactCensoredMedianAvailable).toBe(false);expect(p.semanticOracleRequired).toBe(true);expect(p.productionAdopted).toBe(false);
 expect(r.decisionExamples.map((x:any)=>x.id)).toEqual(Array.from({length:8},(_,i)=>'VFD'+String(i+1).padStart(2,'0')));
 expect(r.decisionExamples.map((x:any)=>x.expected)).toEqual(['candidate-only','candidate-only','candidate-only','defer','defer','defer','defer','record-rejected']);
 for(const e of r.decisionExamples){expect(e.status).toBe('illustrative-only');expect(e.executed).toBe(false);expect(section).toContain('| '+e.id+' | '+e.condition+' |');if(e.expected==='candidate-only'){expect(e.candidateMs).toBeLessThanOrEqual((e.scalarMs??e.scalarLowerBoundMs)*0.95);expect(e.candidateMs).toBeLessThanOrEqual((e.batchMs??e.batchLowerBoundMs)*0.95);}}
 expect(r.decisionExamples[3].candidateMs).toBeGreaterThan(r.decisionExamples[3].batchLowerBoundMs*0.95);
 for(const text of ['元期限到達証拠','request_expired','失敗totalMsの成功中央値への混入'])expect(condition('CVF46')).toContain(text);
 for(const text of ['全測定完了','正当な期限停止だけを理由にdeferしない','VFD01〜08','正確な速度比と下限証拠'])expect(condition('CVF47')).toContain(text);
 for(const text of ['開始時刻の丸め・clock domain対応','median(b)≤0.95×median(q)','固定clock等の機能対照は非性能証拠','candidate-onlyでもproductionAdoptedはfalse'])expect(section).toContain(text);
});
