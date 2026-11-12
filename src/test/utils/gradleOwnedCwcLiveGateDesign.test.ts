import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {LG_SCHEDULE_VERSION,lgDesignSchedule,assertLgDesignSchedule,type LgSchedulePhase} from '../fixtures/gradleOwnedCwcLgSchedule.mjs';
const r=JSON.parse(readFileSync('docs/validation/gradle-cwc-lg-design-2026-11-12.json','utf8'));
const section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const condition=(id:string)=>r.regressionConditions.find((x:any)=>x.id===id).condition;
// The schedule permits warmup round -1; production OwnedManifest's unsigned numbers do not.
const canonicalSchedule=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
it('binds the owned-live-input design, inspected sources and original VF-3P evidence',()=>{
 expect(sha(section)).toBe(r.document.sectionSha256);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 const bytes=readFileSync(r.baseline.path),prior=JSON.parse(bytes.toString());expect(sha(bytes)).toBe(r.baseline.sha256);
 expect(sha(JSON.stringify({measurement:prior.measurement,methods:prior.methods}))).toBe(r.baseline.rawDigest);expect(prior.measurementOrigin.rawDigest).toBe(r.baseline.rawDigest);
 expect(r.baseline.measuredCompleted).toBe(149);expect(r.baseline.performanceEvidenceForLg).toBe(false);
});
it('keeps all forty-eight runtime conditions and four stages explicitly planned',()=>{
 expect(r.regressionConditions.map((x:any)=>x.id)).toEqual(Array.from({length:48},(_,i)=>'CLG'+String(i+1).padStart(2,'0')));expect(r.stages.map((x:any)=>x.id)).toEqual(['LG-0','LG-1','LG-2','LG-3']);
 for(const x of [...r.regressionConditions,...r.stages]){expect(x.status).toBe('planned');expect(x.executed).toBe(false);expect(section).toContain('| '+x.id+' | '+x.condition+' |');}
});
it('limits substitution to ready permission representation without caching live authorization',()=>{
 expect(r.contract.target).toBe('ready-connected-provider-and-scope-permission-normalization-only');expect(r.contract.permissionEvaluation).toBe('fresh-each-original-live-site');expect(r.contract.sharedAuthorizationAllowed).toBe(false);
 for(const text of r.forbiddenFacts)expect(section).toContain(text);
 expect(r.contract.excluded).toContain('current.context-hash');expect(r.contract.excluded).toContain('grant.assert');expect(r.contract.readyFailureFallbackAllowed).toBe(false);
 for(const text of ['CFP-0','置換対象外','初回prepare／receive','別の固定full-input経路','事前に定めた最終完全経路'])expect(section).toContain(text);
});
it('specifies private helper entry points, actual-reference binding and nontransferable lifetime',()=>{
 for(const h of r.contract.helperEntries)expect(section).toContain('| '+h+' |');for(const b of r.bindings)expect(section).toContain(b);
 expect(new Set(r.bindings).size).toBe(r.bindings.length);expect(r.contract.registrationDeadline).toBe('before-first-call-capture');expect(r.contract.callerValidFlagAllowed).toBe(false);
 expect(r.lifecycle.handlesPerCall).toBe(1);expect(r.lifecycle.scopeBoundHandles).toBe(1);expect(r.lifecycle.sealOnce).toBe(true);expect(r.lifecycle.cloneRebindAndCrossCallReuse).toBe(false);
 for(const text of ['別batch・別RPC・exact retry','client initial→seal','文字列ID','同じcanonical値だけ'])expect(section).toContain(text);
});
it('requires full ownership, deep freezing and exact canonical lineage with original predicate order',()=>{
 expect(r.contract.privateViewOwnedParsedAndDeepFrozen).toBe(true);expect(r.contract.rawOwnerCallbackUnsupported).toBe(true);expect(r.contract.shortCircuit).toBe('original-row-order-and-some-predicate');
 for(const text of ['currentLineageSchemaの全field','選択fieldや短縮hash','キー挿入順','元のsome述語','captureでは短絡せず全row','parser出力alias','旧versionの履歴'])expect(section).toContain(text);
 for(const id of ['CLG02','CLG03','CLG04','CLG05','CLG06','CLG07'])expect(condition(id).length).toBeGreaterThan(20);
});
it('preserves every credential, purpose, pin, row, budget and original-clock check',()=>{
 const l=r.live;expect(l.originalNodeMapping).toBe('one-to-one-site-order-and-count');
 for(const key of ['originalPermissionsHookRetained','credentialChecksEveryGate','actualServerPermitResultCompared','currentPinsEveryGate','rowKdStateAndConsumptionEveryGate','ledgerAndRemainingBudgetEveryGate','monotonicClockEveryGate','callbackPostChecksRetained','afterFinalClockCallbackFence','contentAndIndependentPlanRetained'])expect(l[key],key).toBe(true);
 expect(l.purposeEquality).toEqual(['current','issued','binding','expected-projection']);expect(l.deadlineFloorCanIncrease).toBe(false);expect(l.tightening).toBe('accept-future-shortening-reject-expired');expect(l.fenceSuccessCrossGateReuse).toBe(false);expect(l.logicalGateDebit).toBe(1);expect(l.logicalGateLimit).toBe(4096);
 for(const text of ['previousDeadlineFloor','最後のclock callback後','最終clock intrinsic','source pre／post','outcome／use／ACK','同じ順序・回数','この1は既存#inspectのlogical試行','有効な期限短縮は受理'])expect(section).toContain(text);
});
it('requires sticky revocation before mutation work and distinguishes unsupported external history',()=>{
 const l=r.lifecycle;expect(l.mutationInvalidatesBeforePreparation).toBe(true);expect(l.failedMutationRestoresOldReady).toBe(false);expect(l.recordedRestorationRevivesOldCall).toBe(false);expect(l.untrackedMutationAdapter).toBe('unsupported');expect(l.unobservedExternalHistoryDetection).toBe(false);expect(l.unnotifiedPrimaryMutation).toBe('unsupported-not-unobserved-control');
 for(const text of ['旧call／projectionを先に失効','失敗・容量不足・不正schemaでも旧Readyへ戻さず','現行Vf0Authority.changeが','管理外で検査前に変更と復元','同値への復元でもrevisionを戻さず','呼ぶだけではLG登録資格にならない','primary内の未通知変化'])expect(section).toContain(text);
 for(const id of ['CLG16','CLG17','CLG18','CLG19','CLG20'])expect(condition(id).length).toBeGreaterThan(20);
});
it('retains sticky reentry, independent timeout, reader drain and retry consumption',()=>{
 const l=r.lifecycle;expect(l.claimBeforeCallback).toBe(true);expect(l.externalReentryPoisonsOuter).toBe(true);expect(l.internalFrameCarriesAuthorization).toBe(false);expect(l.expiryWaitsForDispatch).toBe(false);expect(l.lateReadOrPublication).toBe(false);expect(l.spentRefund).toBe(false);expect(l.memoryReleasedOnce).toBe(true);expect(l.scopeCloseRevivesForFinal).toBe(false);
 for(const state of l.states)expect(section).toContain('| '+state+' |');expect(l.borrow).toBe('bounded-synchronous-no-callback-or-await');expect(l.retry).toBe('new-call-handle-same-K/D-deadline-spent');
 for(const text of ['内側例外が捕捉されても','全強参照を外し','後着','別callの正規処理'])expect(section).toContain(text);
});
it('bounds new allocation and capture work without claiming the maximum layout is already proven',()=>{
 const b=r.budgets;expect(b.arena.rowReferenceSlots+b.arena.lineagePool+b.arena.metadata).toBe(b.arena.total);expect(b.arena.total).toBe(4096);expect(b.memoryLimit).toBe(1048576);expect(b.maximumRows).toBe(64);expect(b.rawCanonicalBytes).toBe(32768);
 expect(Object.values<number>(b.normalizer).reduce((s,n)=>s+n,0)).toBe(b.normalizerWorkBound);expect(b.normalizerWorkBound).toBe(3137);expect(b.normalizerWorkBound).toBeLessThanOrEqual(b.initializationWork);expect(b.callWorkLimit).toBe(156978);
 expect(b.oldRegionsMayBeReusedWithoutDisjointProof).toBe(false);expect(b.globalLimitIncrease).toBe(false);expect(b.physicalHeapBound).toBe(false);expect(b.maximumLayoutProofStatus).toBe('planned');
 for(const e of r.layoutExamples){expect(e.existingPeak+b.arena.total).toBe(e.withCandidateArena);expect(e.withCandidateArena).toBeLessThanOrEqual(b.memoryLimit);expect(e.maximumLayoutProved).toBe(false);expect(e.status).toBe('arithmetic-only');}
 for(const text of ['既存binding 8192 BやVF metadata 4096 Bを再び空きと見なさず','構造unitはCPU時間ではない','shadow構築'])expect(section).toContain(text);
});
it('defines an equal-count 576-trial primary and separate 144-trial fresh bridge',()=>{
 const c=r.comparison;expect(c.arms).toHaveLength(8);expect(new Set(c.arms).size).toBe(8);expect(c.trials).toBe(c.arms.length*c.workloads.length*c.roles.length*(c.warmupRounds+c.measuredRounds)*c.observations.length);expect(c.measuredTrials).toBe(432);expect(c.warmupTrials).toBe(144);expect(c.deadlineMs).toBe(4500);
 for(const key of ['commonOwnedAuthorityAndMutation','commonShadowCaptureAndBudget','totalIncludesRegistrationCaptureThroughCleanupAndRestore','allFailedTrialsRetained'])expect(c[key]).toBe(true);expect(c.sourcePerformanceReused).toBe(false);expect(c.observerCosts).toBe('completed-pairs-only-noncompleted-attempt-deltas-separate');
 const b=r.bridge;expect(b.trials).toBe(b.arms.length*c.workloads.length*c.roles.length*(c.warmupRounds+c.measuredRounds)*c.observations.length);expect(b.measuredTrials).toBe(108);expect(b.warmupTrials).toBe(36);expect(b.separateFromPrimary).toBe(true);expect(b.freshMeasurementRequired).toBe(true);expect(b.normalizationSpeedupInferred).toBe(false);
});
it('separates normal LG-local release from fatal actual-call invalidation',()=>{
 const a=r.lifecycle.terminalActions,n=a.normalRelease,f=a.fatalInvalidation;
 expect(a.reasonSelectedByCaller).toBe(false);expect(a.fatalWinsRace).toBe(true);expect(a.finallyMayOverwriteFatal).toBe(false);
 expect(n.target).toBe('LG-local-only');expect(n.reason).toBe('normal-scope-end');
 for(const key of ['terminalHandle','invalidateFrames','incrementLocalGeneration','removeLocalLookup','retainSessionFinalWire','retainCallReservations','successOutcomeUseAckAllowed'])expect(n[key],key).toBe(true);
 for(const key of ['newLgBorrow','alterActualCallOrAuthorityEpoch','alterBindingOrChannelGeneration','removeCallLookup','stopChannel','reviveHandle'])expect(n[key],key).toBe(false);
 expect(n.release).toBe('LG-ticket-once-after-local-reader-drain');expect(n.finalPath).toBe('fixed-full-input-with-fresh-live-and-content-checks');
 expect(f.target).toBe('LG-and-existing-actual-call-lifecycle');for(const key of ['beforeAwait','actualCallTerminal','stopChannel','retainWireUntilExistingDrain','lateContinuationChecksActualLatchFirst','releaseLocalTicketOnce'])expect(f[key],key).toBe(true);
 expect(f.newReadDecodeSignSuccessUseAck).toBe(false);expect(f.refundSpent).toBe(false);
 for(const text of ['LG-local generationとは別物','実callの取消しや失効を意味しない','fatal latchが優先','固定full-input経路も公開前に停止','Session最終wireをLG ticketとして解放しない'])expect(section).toContain(text);
 for(const text of ['await前','後着no-read／no-publication／no-use／no-ACK','fatal理由を上書きしない'])expect(condition('CLG32')).toContain(text);
 for(const text of ['LG-local generation','channel停止0','outcome／use／ACK','最終wireを保持','release後のfatal事象'])expect(condition('CLG33')).toContain(text);
});
it('binds the planned 720-position schedule without claiming execution evidence',()=>{
 const s=r.schedule;expect(s.version).toBe(LG_SCHEDULE_VERSION);expect(s.executed).toBe(false);expect(s.status).toBe('planned-order-only');expect(s.witnessValidationImplemented).toBe(false);
 expect(s.phaseOrder).toEqual(['primary','bridge']);expect(s.singleWorkerAtATime).toBe(true);expect(s.freshWorkerPerPhase).toBe(true);expect(s.randomSeed).toBeNull();expect(s.completeLatinSquareClaimed).toBe(false);expect(s.postHocSortAllowed).toBe(false);
 const rows=[...s.primaryRows,...s.bridgeRows];expect(rows).toHaveLength(720);expect(rows.map(x=>x.runOrdinal)).toEqual(Array.from({length:720},(_,i)=>i));
 expect(sha(canonicalSchedule({version:s.version,rows}))).toBe(s.canonicalDigest);
 for(const phase of ['primary','bridge'] as const){expect(assertLgDesignSchedule(s[phase+'Rows'],phase)).toBe(true);expect(s[phase+'Rows']).toEqual(lgDesignSchedule(phase));}
 for(const text of ['開始／終了witness','rawだけを事後sort','controller側の同一単調clock','後日の部分測定を継ぎ足さない','Latin squareとは主張せず'])expect(section).toContain(text);
});
it('rotates observations and groups and alternates adjacent pairs by the specified indices',()=>{
 for(const phase of ['primary','bridge'] as const){
  const rows=r.schedule[phase+'Rows'];for(let i=0;i<rows.length;i+=2){
   const a=rows[i],b=rows[i+1],t=a.round+1;expect(a.pairId).toBe(b.pairId);expect(a.armSlot).toBe(0);expect(b.armSlot).toBe(1);
   expect(a.observation).toBe(['quiet','counts','timed'][(a.observationSlot+a.cohort+t)%3]);expect(a.stage).toBe(a.round===-1?'warmup':'measured');
   const group=phase==='primary'?['S/full-verify','S/fact-live','B/full-verify','B/fact-live'][(a.groupSlot+a.cohort+t+a.observationSlot)%4]:'B/fact-live';expect(a.group).toBe(group);
   const groupIndex=phase==='primary'?['S/full-verify','S/fact-live','B/full-verify','B/fact-live'].indexOf(group!):0,observationIndex=['quiet','counts','timed'].indexOf(a.observation);
   const arms=phase==='primary'?[group+'/full-input',group+'/owned-input']:['old-VF-3P-v2','new-full-input'];if((a.cohort+t+groupIndex+observationIndex)%2)arms.reverse();expect([a.arm,b.arm]).toEqual(arms);
  }
  for(let c=0;c<6;c++){const cohort=rows.filter((x:any)=>x.cohort===c);expect(cohort.filter((x:any)=>x.stage==='warmup')).toHaveLength(phase==='primary'?24:6);expect(cohort.map((x:any)=>x.round)).toEqual([...cohort.map((x:any)=>x.round)].sort((a,b)=>a-b));}
 }
});
it('uses both pair directions in measured rounds for every cohort, group and observation',()=>{
 for(const phase of ['primary','bridge'] as const){
  const first=lgDesignSchedule(phase).filter(x=>x.stage==='measured'&&x.armSlot===0),groups=new Map<string,typeof first>();
  for(const row of first){const key=`${row.cohort}:${row.group}:${row.observation}`;groups.set(key,[...(groups.get(key)??[]),row]);}
  expect(groups.size).toBe(phase==='primary'?72:18);
  for(const rows of groups.values()){expect(rows.map(x=>x.round)).toEqual([0,1,2]);expect(rows[0]!.arm).not.toBe(rows[1]!.arm);expect(rows[1]!.arm).not.toBe(rows[2]!.arm);expect(rows[0]!.arm).toBe(rows[2]!.arm);}
 }
});
it('rejects reordered schedules with unchanged sets, counts and repaired ordinals in both phases',()=>{
 for(const phase of ['primary','bridge'] as const){
  const rows=lgDesignSchedule(phase),swapped=structuredClone(rows);[swapped[0],swapped[1]]=[swapped[1]!,swapped[0]!];
  expect(new Set(swapped.map(x=>canonicalSchedule(x)))).toEqual(new Set(rows.map(x=>canonicalSchedule(x))));expect(()=>assertLgDesignSchedule(swapped,phase)).toThrow('lg_schedule_row');
  swapped.forEach((x,i)=>{x.trialOrdinal=i;x.runOrdinal=i+(phase==='bridge'?576:0);x.armSlot=i%2;});expect(()=>assertLgDesignSchedule(swapped,phase)).toThrow('lg_schedule_row');
 }
});
it('rejects altered pair labels, phases, types, extra fields and missing failed positions',()=>{
 for(const phase of ['primary','bridge'] as const){
  for(const [key,value] of [['pairId','another-pair'],['comparisonKey','another-condition'],['observationKey','another-round'],['phase',phase==='primary'?'bridge':'primary'],['stage','measured'],['round','-1'],['scheduleVersion','old'],['unexpected',true]] as const){
   const rows:any[]=lgDesignSchedule(phase);rows[0][key]=value;expect(()=>assertLgDesignSchedule(rows,phase),key).toThrow('lg_schedule_row');
  }
  const rows=lgDesignSchedule(phase);rows.splice(1,1);expect(()=>assertLgDesignSchedule(rows,phase)).toThrow('lg_schedule_length');
  const duplicate=lgDesignSchedule(phase);duplicate[1]={...duplicate[0]!,trialOrdinal:1,runOrdinal:phase==='bridge'?577:1,armSlot:1};expect(()=>assertLgDesignSchedule(duplicate,phase)).toThrow('lg_schedule_row');
 }
});
it('accepts object insertion-order changes without changing the canonical schedule digest',()=>{
 for(const phase of ['primary','bridge'] as const){const rows=lgDesignSchedule(phase),reordered=rows.map(row=>Object.fromEntries(Object.entries(row).reverse()));expect(assertLgDesignSchedule(reordered,phase)).toBe(true);expect(canonicalSchedule(reordered)).toBe(canonicalSchedule(rows));}
});
it('uses explicit normalization, adoption and observer pairing and keeps bridge chronology separate',()=>{
 for(const phase of ['primary','bridge'] as LgSchedulePhase[]){
  const rows=lgDesignSchedule(phase);for(const [key,width] of [['pairId',2],['comparisonKey',phase==='primary'?8:2],['observationKey',3]] as const){
   const grouped=new Map<string,typeof rows>();for(const row of rows){const id=row[key];grouped.set(id,[...(grouped.get(id)??[]),row]);}
   for(const group of grouped.values()){expect(group).toHaveLength(width);expect(new Set(group.map(x=>`${x.cohort}:${x.round}`)).size).toBe(1);if(key==='observationKey')expect(new Set(group.map(x=>x.observation)).size).toBe(3);}
  }
 }
 expect(r.schedule.pairing).toEqual({normalization:'pairId',adoption:'comparisonKey-plus-specified-arm',observer:'observationKey-completed-pairs-only'});
 for(const text of ['位置ごと','AB／BA','実開始witness'])expect(condition('CLG44')).toContain(text);
 for(const text of ['新worker','global ordinal','phase混在','純粋正規化短縮'])expect(condition('CLG46')).toContain(text);
 expect(r.schedule.executionWitnessRequired).toContain('cleanup-before-next-start');expect(r.schedule.executionWitnessRequired).toContain('primary-before-bridge');
});
it('keeps qualified censoring and whole-candidate completion in the adoption gate',()=>{
 const p=r.candidatePolicy;expect(p.candidate).toBe('B/fact-live/owned-input');expect(p.candidateAllNineMeasuredComplete).toBe(true);expect(p.comparators).toEqual(['B/fact-live/full-input','S/fact-live/owned-input','S/fact-live/full-input','B/full-verify/owned-input']);expect(p.invalidControlDecision).toBe('defer');expect(p.eachQuietRoundWins).toBe(true);expect(p.medianMaximumRatio).toBe(0.95);expect(p.censoredPairMaximumRatio).toBe(0.95);expect(p.allSixConditionsRequired).toBe(true);expect(p.productionAdopted).toBe(false);
 for(const text of ['4500固定値','保守vector','正当な打切り対照','不完了pair','source承認・shadow capture','機能oracle'])expect(section).toContain(text);
});
it('does not turn design checks or historical VF-3P measurements into runtime or adoption evidence',()=>{
 expect(r.status).toBe('design-only');expect(r.contract.status).toBe('proposed-not-admitted');expect(Object.values(r.scope).every(x=>x===false)).toBe(true);
 for(const text of ['planned・未実行','全て未実装','計測器込みの打切り観測を削減可能量へ変換しない','CG0／CG3・本番採用の保留を解除しない'])expect(section).toContain(text);
});
