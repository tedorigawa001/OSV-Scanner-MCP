/** Documentation contract only: never executes LG helpers or planned runtime tests. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {LG_SCHEDULE_VERSION,lgDesignSchedule,assertLgDesignSchedule} from '../src/test/fixtures/gradleOwnedCwcLgSchedule.mjs';
const path='docs/validation/gradle-cwc-lg-design-2026-11-12.json',sha=b=>createHash('sha256').update(b).digest('hex');
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.138 CWC-LG：所有live入力の正規化と毎回認可の分離契約（設計）'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sectionSha256=sha(section);
const rows=p=>[...section.matchAll(new RegExp('^\\| ('+p+') \\| (.*) \\|$','gm'))].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
const regressionConditions=rows('CLG\\d{2}'),stages=rows('LG-[0-3]');
if(JSON.stringify(regressionConditions.map(x=>x.id))!==JSON.stringify(Array.from({length:48},(_,i)=>'CLG'+String(i+1).padStart(2,'0')))||JSON.stringify(stages.map(x=>x.id))!==JSON.stringify(['LG-0','LG-1','LG-2','LG-3']))throw Error('lg_conditions');
const sourceBindings={};for(const p of [
 'src/test/fixtures/gradleOwnedCwcVf0Authority.ts','src/test/fixtures/gradleOwnedCwcVf1Contract.ts','src/test/fixtures/gradleOwnedCwcVf1Approval.ts',
 'src/test/fixtures/gradleOwnedCwcLb0.ts','src/test/fixtures/gradleOwnedCwcLb0Contract.ts','src/test/fixtures/gradleOwnedCwcLb1Approval.ts',
 'src/test/fixtures/gradleOwnedCwcC.ts','src/test/fixtures/gradleOwnedCwcCProvider.ts','src/test/fixtures/gradleOwnedCwcA.ts','src/test/fixtures/gradleOwnedCwcCPlanner.ts',
 'src/test/fixtures/gradleOwnedCwcVf3Case.ts','src/test/fixtures/gradleOwnedCwcVf3Link.ts','src/test/fixtures/gradleOwnedCwcVf3Validation.mjs',
 'src/test/fixtures/gradleOwnedCwcVf3pProgress.ts','src/test/fixtures/gradleOwnedCwcVf3pProfile.ts','src/test/fixtures/gradleOwnedCwcVf3pValidation.mjs',
 'src/test/fixtures/gradleOwnedCprBSession.ts','src/test/fixtures/gradleOwnedCprBOwners.ts','src/utils/gradleOwnedCurrentAuxiliary.ts','src/utils/gradleOwnedJson.ts',
 'src/test/fixtures/gradleOwnedCwcLgSchedule.mjs','src/test/fixtures/gradleOwnedCwcLgSchedule.d.mts',
 'scripts/check-cwc-lg-design.mjs','src/test/utils/gradleOwnedCwcLiveGateDesign.test.ts'])sourceBindings[p]=sha(await readFile(p));
const baselinePath='docs/validation/gradle-cwc-vf3p-2026-11-12.json',baselineBytes=await readFile(baselinePath),prior=JSON.parse(baselineBytes);
if(prior.schema!=='cwc-vf3p.validation.v2'||prior.measurement.schema!=='cwc-vf3p.measurement.v2'||sha(JSON.stringify({measurement:prior.measurement,methods:prior.methods}))!==prior.measurementOrigin.rawDigest)throw Error('lg_baseline');
for(const [p,h]of Object.entries(sourceBindings))if(p in prior.sourceBindings&&prior.sourceBindings[p]!==h)throw Error('lg_baseline_source_'+p);
const baseline={path:baselinePath,sha256:sha(baselineBytes),rawDigest:prior.measurementOrigin.rawDigest,measurementSchema:prior.measurement.schema,completed:prior.measurement.comparison.completed,measuredCompleted:prior.measurement.comparison.measuredCompleted,decision:prior.measurement.comparison.decision,performanceEvidenceForLg:false};
const contract={profile:'cwc.owned-live-permission-input.v1',status:'proposed-not-admitted',helperEntries:['registerOwnedLivePort','captureLiveInput','sealLiveInput','matchCurrentPermission','invalidateLiveInput'],inputModes:['full-input','owned-input'],verificationModes:['full-verify','fact-live'],registrationDeadline:'before-first-call-capture',target:'ready-connected-provider-and-scope-permission-normalization-only',rawOwnerCallbackUnsupported:true,sourceApprovalRequired:true,privateViewOwnedParsedAndDeepFrozen:true,callerValidFlagAllowed:false,sharedAuthorizationAllowed:false,permissionEvaluation:'fresh-each-original-live-site',shortCircuit:'original-row-order-and-some-predicate',normalizationDelta:['owner-permission-copy','clb-permission-copy-and-schema','lineage-canonical-comparison'],excluded:['current.context-hash','grant.assert','command-wire-source-plan-K/D-content-digests','initial-ready-ordinary-final-verification'],fullPaths:['prepare-receive','ordinary-inspect','ready-seal','clb-finish','session-final','transport-and-client-final'],readyFailureFallbackAllowed:false};
const bindings=['authorityRef','authorityEpoch','authorityRevision','revocationEpoch','verificationOwnerRef','portRef','portGeneration','clockRef','controlRef','clbCallRef','actualCallRef','transportAssociationRef','channelRef','channelGeneration','bindingRef','bindingGeneration','scopeRef','scopeGeneration','rowRef','expectedProjectionRef','policyViewRef','profilePin','registryPin','sourcePin','issuedPurpose','originalDeadline','budgetRef'];
const forbiddenFacts=['allowed=true','現在purpose','pinCurrent','remainingWork','deadlineValid','matched row'];
const live={originalNodeMapping:'one-to-one-site-order-and-count',originalPermissionsHookRetained:true,credentialChecksEveryGate:true,actualServerPermitResultCompared:true,purposeEquality:['current','issued','binding','expected-projection'],currentPinsEveryGate:true,rowKdStateAndConsumptionEveryGate:true,ledgerAndRemainingBudgetEveryGate:true,monotonicClockEveryGate:true,logicalGateDebit:1,logicalGateLimit:4096,deadlineFloorCanIncrease:false,tightening:'accept-future-shortening-reject-expired',callbackPostChecksRetained:true,afterFinalClockCallbackFence:true,finalPublish:'bounded-synchronous-no-foreign-code',fenceSuccessCrossGateReuse:false,contentAndIndependentPlanRetained:true};
const lifecycle={claimBeforeCallback:true,states:['claimed／capturing','verified-unbound','ready','checking','invalid／released'],sealOnce:true,handlesPerCall:1,scopeBoundHandles:1,cloneRebindAndCrossCallReuse:false,internalFrameCarriesAuthorization:false,externalReentryPoisonsOuter:true,mutationInvalidatesBeforePreparation:true,failedMutationRestoresOldReady:false,recordedRestorationRevivesOldCall:false,untrackedMutationAdapter:'unsupported',unobservedExternalHistoryDetection:false,unnotifiedPrimaryMutation:'unsupported-not-unobserved-control',scopeCloseRevivesForFinal:false,expiryWaitsForDispatch:false,borrow:'bounded-synchronous-no-callback-or-await',reclaim:'terminal-and-borrow-readers-zero-and-no-strong-references',memoryReleasedOnce:true,lateReadOrPublication:false,spentRefund:false,retry:'new-call-handle-same-K/D-deadline-spent'};
lifecycle.terminalActions={
 reasonSelectedByCaller:false,fatalWinsRace:true,finallyMayOverwriteFatal:false,
 normalRelease:{reason:'normal-scope-end',target:'LG-local-only',terminalHandle:true,invalidateFrames:true,
  incrementLocalGeneration:true,removeLocalLookup:true,newLgBorrow:false,
  alterActualCallOrAuthorityEpoch:false,alterBindingOrChannelGeneration:false,removeCallLookup:false,stopChannel:false,
  release:'LG-ticket-once-after-local-reader-drain',retainSessionFinalWire:true,retainCallReservations:true,
  finalPath:'fixed-full-input-with-fresh-live-and-content-checks',successOutcomeUseAckAllowed:true,reviveHandle:false},
 fatalInvalidation:{target:'LG-and-existing-actual-call-lifecycle',beforeAwait:true,
  reasons:['timeout','cancel','pin-or-revision-mismatch','reentry','validation-failure','call-close'],
  actualCallTerminal:true,actualGenerationAndLookup:'existing-call-rules',stopChannel:true,
  newReadDecodeSignSuccessUseAck:false,retainWireUntilExistingDrain:true,
  lateContinuationChecksActualLatchFirst:true,releaseLocalTicketOnce:true,refundSpent:false,
  outcome:'existing-lifecycle-refused-or-unknown-never-derived-from-LG-release'}
};
const budgets={memoryLimit:1048576,arena:{rowReferenceSlots:2048,lineagePool:1024,metadata:1024,total:4096},maximumRows:64,rawCanonicalBytes:32768,sourceDepth:12,initializationWork:4096,normalizer:{nodeVisits:2048,freezeNodes:256,tupleWrites:256,canonicalCalls:65,fixedOperations:512},callWorkLimit:156978,providerWorkLimit:1048576,totalWorkAndWireLimit:67108864,shadowCaptureInFullInput:true,existingConstructorWorkspace:131072,existingBindingBytes:8192,oldFactBytes:4096,oldRegionsMayBeReusedWithoutDisjointProof:false,maximumLayoutProofStatus:'planned',globalLimitIncrease:false,physicalHeapBound:false};
budgets.normalizerWorkBound=Object.values(budgets.normalizer).reduce((a,b)=>a+b,0);
if(budgets.normalizerWorkBound>budgets.initializationWork||Object.entries(budgets.arena).filter(([k])=>k!=='total').reduce((s,[,n])=>s+n,0)!==budgets.arena.total)throw Error('lg_budget');
const layoutExamples=['reader','authority-broker'].map(role=>{const existingPeak=Math.max(...prior.measurement.rows.filter(r=>r.role===role).map(r=>r.audit.peakBytes));return {role,existingPeak,observedSlack:budgets.memoryLimit-existingPeak,withCandidateArena:existingPeak+budgets.arena.total,status:'arithmetic-only',maximumLayoutProved:false};});
const comparison={shapes:['scalar','batch'],verificationModes:contract.verificationModes,inputModes:contract.inputModes,arms:['S/full-verify/full-input','S/full-verify/owned-input','S/fact-live/full-input','S/fact-live/owned-input','B/full-verify/full-input','B/full-verify/owned-input','B/fact-live/full-input','B/fact-live/owned-input'],workloads:['small','h0','single-large'],roles:['reader','authority-broker'],observations:['quiet','counts','timed'],warmupRounds:1,measuredRounds:3,trials:576,warmupTrials:144,measuredTrials:432,deadlineMs:4500,minimumImprovementPercent:5,commonOwnedAuthorityAndMutation:true,commonShadowCaptureAndBudget:true,totalIncludesRegistrationCaptureThroughCleanupAndRestore:true,allFailedTrialsRetained:true,observerCosts:'completed-pairs-only-noncompleted-attempt-deltas-separate',ttlNormalization:'comparison-only',sourcePerformanceReused:false};
const candidatePolicy={candidate:'B/fact-live/owned-input',candidateAllNineMeasuredComplete:true,comparators:['B/fact-live/full-input','S/fact-live/owned-input','S/fact-live/full-input','B/full-verify/owned-input'],controlClasses:['complete','original-deadline-censored','invalid'],invalidControlDecision:'defer',censorLowerBound:'original-clock-mapped-deadline-minus-total-start',exactCensoredMedianAvailable:false,eachQuietRoundWins:true,medianMaximumRatio:0.95,censoredPairMaximumRatio:0.95,allSixConditionsRequired:true,semanticOracleRequired:true,productionAdopted:false};
const bridge={arms:['old-VF-3P-v2','new-full-input'],shape:'batch',verificationMode:'fact-live',trials:144,warmupTrials:36,measuredTrials:108,separateFromPrimary:true,freshMeasurementRequired:true,strengtheningDifferencesExplicit:true,normalizationSpeedupInferred:false};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const primaryRows=lgDesignSchedule('primary'),bridgeRows=lgDesignSchedule('bridge');
assertLgDesignSchedule(primaryRows,'primary');assertLgDesignSchedule(bridgeRows,'bridge');
const schedule={version:LG_SCHEDULE_VERSION,status:'planned-order-only',executed:false,randomSeed:null,
 phaseOrder:['primary','bridge'],singleWorkerAtATime:true,freshWorkerPerPhase:true,
 ordering:'cohort-round-observationSlot-groupSlot-armSlot',
 observationIndex:'(o+c+t)%3',primaryGroupIndex:'(g+c+t+o)%4',pairReverse:'(c+t+groupIndex+observationIndex)%2',
 warmupBeforeMeasuredWithinCohort:true,completeLatinSquareClaimed:false,
 rawValidation:'field-and-type-at-exact-position-not-set-equality',
 executionWitnessRequired:['run-id','trial-spec-digest','actual-arm','worker-id','controller-start-end','cleanup-before-next-start','primary-before-bridge'],
 witnessValidationImplemented:false,failedAttemptsRetained:true,postHocSortAllowed:false,
 pairing:{normalization:'pairId',adoption:'comparisonKey-plus-specified-arm',observer:'observationKey-completed-pairs-only'},
 primaryRows,bridgeRows,canonicalDigest:sha(canonical({version:LG_SCHEDULE_VERSION,rows:[...primaryRows,...bridgeRows]}))};
const scope={runtimeChanged:false,portImplemented:false,projectionImplemented:false,runtimeRegressionsExecuted:false,newPerformanceRunExecuted:false,performanceImprovementEstablished:false,productionAdopted:false,storageIntegrationEstablished:false,nativeIsolationEstablished:false,continuousEightReadsEstablished:false};
const record={schema:'cwc-lg.design-record.v2',date:'2026-11-12',status:'design-only',document,sourceBindings,baseline,contract,bindings,forbiddenFacts,live,lifecycle,budgets,layoutExamples,comparison,candidatePolicy,bridge,schedule,scope,regressionConditions,stages};
if(process.argv.includes('--check')){if(JSON.stringify(JSON.parse(await readFile(path,'utf8')))!==JSON.stringify(record))throw Error('lg_design_mismatch');}else await writeFile(path,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({status:record.status,plannedRegressions:regressionConditions.length,stages:stages.length,plannedTrials:comparison.trials,plannedBridgeTrials:bridge.trials,runtimeChanged:false}));
