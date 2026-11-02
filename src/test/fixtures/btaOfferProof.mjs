// Published metadata replay. File bytes were verified only in the native harness.
import {readOwnedOffer,validateOwnedOffer,offerJdkProfile,classifyOfferExecution} from './btaOfferContract.mjs';
import {btaDriverProfiles} from './gradleBtaDriverRuntime.mjs';
import {hash} from './gradleBtaDriverProof.mjs';
import {verifyStorageAudit} from './btaOfferStorageProof.mjs';
export const offerSources=['src/test/fixtures/BtaOwnedDriver.java','src/test/fixtures/BtaOfferProbe.java','src/test/fixtures/gradle-bta-offer.gradle','src/test/fixtures/btaOfferContract.mjs','src/test/gradle/btaOffer.integration.test.ts','src/test/fixtures/gradleBtaDriverRuntime.mjs','src/test/fixtures/gradleSnapshotOwnerExpected.mjs','src/test/fixtures/BtaOfferStorage.java'];
export const offerVerificationSources=['src/test/fixtures/btaOfferContract.d.mts','src/test/fixtures/btaOfferProof.mjs','src/test/fixtures/btaOfferProof.d.mts','src/test/gradle/btaOffer.test.ts','src/test/manual/gradleBtaOfferResults.mjs','src/test/fixtures/btaOfferStorageProof.mjs'];
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw Error('bta_offer_record_invalid');};
// Published IC identities are run-local tokens, never device/inode values.
const fileKeyToken=/^key-[1-9][0-9]*$/;
export const storageCases={
 'staging-file-symlink':'path_invalid','staging-root-symlink':'path_invalid','staging-file-replaced':'storage_identity_mismatch','staging-root-replaced':'storage_identity_mismatch','staging-extra-file':'storage_inventory_mismatch','staging-file-budget':'budget_exceeded',
 'evidence-file-symlink':'path_invalid','evidence-root-symlink':'path_invalid','evidence-file-replaced':'storage_identity_mismatch','evidence-root-replaced':'storage_identity_mismatch','evidence-extra-file':'storage_inventory_mismatch','evidence-file-budget':'budget_exceeded',
 'staging-before-write-symlink':'path_invalid','evidence-before-write-symlink':'path_invalid','parent-before-write-symlink':'path_invalid','staging-many-entries':'budget_exceeded','evidence-many-entries':'budget_exceeded',
 'storage-total-budget':'budget_exceeded','storage-entry-budget':'budget_exceeded',
 'capture-before-change':'stale','capture-after-change':'stale','capture-evidence-before':'stale','capture-evidence-after':'stale','capture-path-after':'storage_identity_mismatch','capture-extra-after':'storage_inventory_mismatch',
};
export const storagePhase=name=>name.startsWith('capture-')?'capture':name.includes('before-write')||name==='storage-total-budget'||name==='storage-entry-budget'?'seal':'precheck';
const priorModes=['completed','unchanged','ic-delete-seed','ic-delete','ic-modify-seed','ic-modify','ic-reset-seed','ic-reset','storage-failed','call-failed','post-failed','capture-failed','foreign-config','foreign-project','foreign-parameter','foreign-paths','stale-precheck','source-changed'];
const modes=[...priorModes,...Object.keys(storageCases),'unsupported'];
const expectedCases={
 ...Object.fromEntries(Object.entries(storageCases).map(([name,reason])=>[name,{state:'failed',phase:storagePhase(name),reason}])),
 completed:{state:'completed'},
 unchanged:{state:'completed'},
 'ic-delete-seed':{state:'completed'},'ic-modify-seed':{state:'completed'},'ic-reset-seed':{state:'completed'},
 'ic-delete':{state:'failed',phase:'precheck',reason:'ic_state_mismatch'},'ic-modify':{state:'failed',phase:'precheck',reason:'ic_state_mismatch'},'ic-reset':{state:'failed',phase:'precheck',reason:'ic_state_mismatch'},
 'storage-failed':{state:'failed',phase:'seal',reason:'storage_failed'},
 'call-failed':{state:'failed',phase:'call',reason:'compile_failed'},
 'post-failed':{state:'failed',phase:'postcheck',reason:'stale'},
 'capture-failed':{state:'failed',phase:'capture',reason:'stale'},
 'foreign-config':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'foreign-project':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'foreign-parameter':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'foreign-paths':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'stale-precheck':{state:'failed',phase:'precheck',reason:'stale'},
 'source-changed':{state:'failed',phase:'precheck',reason:'stale'},
 unsupported:{state:'unavailable',reason:'execution_unsupported',blockedBeforePhase:'registration'},
};
const repeatSeeds={unchanged:'completed','ic-delete':'ic-delete-seed','ic-modify':'ic-modify-seed','ic-reset':'ic-reset-seed'};
const planned={completed:1,'capture-failed':1,...Object.fromEntries(Object.keys(storageCases).filter(x=>x.startsWith('capture-')).map(x=>[x,1]))};
// Producer-recorded refusals are accepted as producer_failed; only content claims are re-read (4 snapshot files + source).
const decision=(e,importStatus,fileReads)=>({producerState:e.producerState,importStatus,reason:null,producerReason:e.failureReason??null,fileReads,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'bta-call-only',compilerWorkStatus:'unknown'});
export function verifyOfferCase(c){
 const profile=btaDriverProfiles[c.gradleVersion];if(!profile||!['Groovy','Kotlin'].includes(c.dsl)||!eq(Object.keys(c.sourceHashes),offerSources))fail();
 const registration={producerSha256:hash(c.sourceHashes[offerSources[0]]+c.sourceHashes[offerSources[1]]+c.sourceHashes['src/test/fixtures/BtaOfferStorage.java']),runtimeSha256:hash(JSON.stringify(profile.runtime)),profileSha256:hash(JSON.stringify({version:c.gradleVersion,java:offerJdkProfile.java.sha256,strategy:'in-process'}))};
 if(!eq(c.registration,registration))fail();
 const r=c.report,g=c.gradle;
 if(!Array.isArray(r.storageSeals)||!Array.isArray(r.storageChecks))fail();
 if(r.schema!=='osv-mcp.bta-offer-probe-v7'||r.actualCompilerVersion!==profile.kotlinVersion||r.javaSha256!==offerJdkProfile.java.sha256||r.naturalContentBinding!==false||r.productionAdopted!==false||g.gradleVersion!==c.gradleVersion||g.javaSha256!==offerJdkProfile.java.sha256||g.javacSha256!==offerJdkProfile.javac.sha256||g.maxWorkers!==1||g.parallel!==false)fail();
 if(!eq(r.envelopes.map(e=>e.invocation),modes)||!eq(c.decisions.map(e=>e.invocation),modes))fail();
 if(!eq(r.rejections.map(e=>e.mode),['duplicate-begin','reentry','reuse','phase-after-completion','failed-reuse','late-registration'])||r.rejections.some(e=>!Number.isInteger(e.callsBefore)||e.callsBefore!==e.callsAfter))fail();
 const classes=['BtaOfferProbe$Broker.class','BtaOfferProbe$Handle.class','BtaOfferProbe$Rejected.class','BtaOfferProbe.class','BtaOfferStorage$Failure.class','BtaOfferStorage.class','BtaOwnedDriver$Binding.class','BtaOwnedDriver$ConfigurationRejected.class','BtaOwnedDriver.class'];
 if(!eq(r.driverClasses.map(x=>x.path),classes)||r.driverClasses.some(x=>!/^[a-f0-9]{64}$/.test(x.sha256)||x.size<=0))fail();
 // Native records describe the library call and each generated snapshot once, not once per offer.
 const lib=r.libraryCompilation,generation=r.snapshotGeneration;
 if(lib?.result!=='COMPILATION_SUCCESS'||lib.sourceSha256!==hash('package dep\nclass Library { fun message(): String = \"library-value\" }\n')||!Array.isArray(lib.outputs)||lib.outputs.length!==2||lib.outputs.some(x=>!/^[a-f0-9]{64}$/.test(x.sha256)||!Number.isSafeInteger(x.size)||x.size<=0)||!eq(lib.outputs.map(x=>x.path),['META-INF/offerLibrary.kotlin_module','dep/Library.class']))fail();
 const impl=profile.runtime.find(x=>x.coordinate.startsWith('org.jetbrains.kotlin:kotlin-build-tools-impl:'));
 const stdlib=profile.runtime.find(x=>x.coordinate.startsWith('org.jetbrains.kotlin:kotlin-stdlib:'));
 if(generation?.generatorSha256!==impl.sha256||!eq(generation.snapshots?.map(x=>[x.id,x.inputSha256]),[['library.snapshot',lib.jarSha256],['stdlib.snapshot',stdlib.sha256]]))fail();
 const scope={gradleBuilds:0,unchangedRepeatCalls:0,skippedExecutions:0,cacheRestorations:0,blockedSuccessAdoptions:0,icStateRejections:0,storageBoundaryRejections:0,btaCalls:1,successfulBtaCalls:Number(lib.result==='COMPILATION_SUCCESS'),generatedSnapshots:generation.snapshots.length,completedOffers:0,failedOffers:0,unavailableOffers:0,handleRejections:0,producerRecordedRejections:0,reverifiedContentFailures:0,readerIntegrityRejections:0,naturalReceipts:0,productionAdoptions:0};
 let exportId;const cumulativeCalls={};
 for(let i=0;i<modes.length;i++){
  const e=r.envelopes[i],d=c.decisions[i],expectedCase=expectedCases[e.invocation];
  if(e.producerState!==expectedCase.state||e.plannedCaptures!==(planned[e.invocation]??0))fail();
  if(expectedCase.state==='failed'&&(e.failurePhase!==expectedCase.phase||e.failureReason!==expectedCase.reason))fail();
  if(expectedCase.state==='unavailable'&&(e.unavailableReason!==expectedCase.reason||e.blockedBeforePhase!==expectedCase.blockedBeforePhase))fail();
  if(e.invocation==='call-failed'&&(e.phases.at(-1)?.evidence?.errorKind!=='result'||e.phases.at(-1)?.evidence?.detail!=='COMPILATION_ERROR'))fail();
  exportId??=e.exportId;if(e.exportId!==exportId||e.profileId!=='test-owned-'+c.gradleVersion)fail();
  if(e.executionId!==r.executionId||r.executionId!==c.executionEvidence?.[0]?.witness?.executionId)fail();
  const settings={executionId:r.executionId,executionWitness:c.executionEvidence[0].witness,trust:true,profiles:{[e.profileId]:{registration,strategy:'in-process'}},graphId:'graph',exportId};
  const evidence=validateOwnedOffer(e);
  if(evidence?.registration&&!eq(evidence.registration,registration))fail();
  const generated=e.phases.find(x=>x.phase==='generation'&&x.outcome==='success')?.evidence;
  if(generated&&(!eq(generated.snapshots,generation.snapshots)||generated.librarySha256!==lib.jarSha256||generated.generatorSha256!==generation.generatorSha256))fail();
  scope[e.producerState+'Offers']++;
  scope.btaCalls+=e.phases.filter(x=>x.phase==='call'&&x.outcome==='begin').length;
  scope.successfulBtaCalls+=e.phases.filter(x=>x.phase==='call'&&x.outcome==='success').length;
  if(expectedCase.state==='failed'&&!['storage_failed','compile_failed'].includes(expectedCase.reason))scope.producerRecordedRejections++;
  if(expectedCase.reason==='stale')scope.reverifiedContentFailures++;
  if(d.trusted?.rejected)scope.readerIntegrityRejections++;
  cumulativeCalls[e.invocation]=scope.btaCalls-1;
  const gates=[{...settings,trust:false},{...settings,profiles:{}}].map(s=>{try{return readOwnedOffer(e,s,()=>{throw Error('unexpected-read');});}catch(error){return {rejected:error.message};}});
  if(!eq(gates,d.gates))fail();
  if(expectedCase.state==='completed'){if(!eq(d.trusted,decision(e,'accepted',4)))fail();}
  else if(expectedCase.reason==='stale'){if(!eq(d.trusted,decision(e,'producer_failed',5)))fail();}
  else {const replayed=readOwnedOffer(e,settings,()=>{throw Error('unexpected-read');});if(!eq(d.trusted,replayed)||replayed.importStatus!==(expectedCase.state==='failed'?'producer_failed':'producer_unavailable'))fail();}
 }
 const rejectionReasons=['duplicate_begin','configuration_reused','configuration_reused','phase_invalid','configuration_reused','registration_closed'];
 const rejectionCounts=[0,0,cumulativeCalls.completed,cumulativeCalls.completed,cumulativeCalls['call-failed'],scope.btaCalls-1];
 for(let i=0;i<r.rejections.length;i++){const entry=r.rejections[i];if(entry.reason!==rejectionReasons[i]||entry.callsBefore!==rejectionCounts[i])fail();scope.handleRejections++;}
 if(r.btaConsumerCalls!==scope.btaCalls-1||r.libraryCalls!==1||r.generatedSnapshots!==scope.generatedSnapshots)fail();
 const first=r.envelopes.find(e=>e.invocation==='completed'),repeat=r.envelopes.find(e=>e.invocation==='unchanged');
 const phase=(e,name)=>e.phases.find(x=>x.phase===name&&x.outcome==='success')?.evidence;
 const a=phase(first,'binding'),b=phase(repeat,'binding');
 if(a.sourceChanges!=='unknown'||b.sourceChanges!=='known-empty'||a.configurationId===b.configurationId||a.parameterId===b.parameterId||!eq(phase(first,'seal'),phase(repeat,'seal')))fail();
 for(const key of ['serviceId','projectId','sourcePath','sourceSha256','argumentsSha256','outputPath','incrementalStatePath'])if(a[key]!==b[key])fail();
 for(const e of r.envelopes)if(!repeatSeeds[e.invocation]&&phase(e,'binding')?.sourceChanges&&phase(e,'binding').sourceChanges!=='unknown')fail();
 const unchanged=r.unchangedEvidence,flags=['sameService','sameProject','sameSourcePath','sameSourceBytes','sameSnapshots','sameIcPath','sameIcContents','sameArguments','distinctHandle','distinctConfiguration','distinctParameter'];
 if(!unchanged||unchanged.firstInvocation!==first.invocation||unchanged.repeatInvocation!==repeat.invocation||flags.some(k=>unchanged[k]!==true)||unchanged.callsBefore!==cumulativeCalls.completed||unchanged.callsAfter!==cumulativeCalls.unchanged||unchanged.callsAfter!==unchanged.callsBefore+1||!eq(unchanged.outputsBefore,phase(first,'call').outputs)||!eq(unchanged.outputsAfter,phase(repeat,'call').outputs)||!eq(unchanged.outputsBefore,unchanged.outputsAfter))fail();
 scope.unchangedRepeatCalls=repeat.phases.filter(x=>x.phase==='call'&&x.outcome==='begin').length;
 // Compare the complete post-seed IC snapshot with the snapshot immediately before each retry.
 const snapshot=s=>{
  if(s?.exists!==true||!fileKeyToken.test(s.rootKey)||!Array.isArray(s.entries)||s.entries.length>4096)fail();
  let total=0;const paths=[];for(const f of s.entries){
   if(typeof f.path!=='string'||!f.path||f.path.startsWith('/')||f.path.split('/').some(x=>!x||x==='.'||x==='..')||!['file','directory'].includes(f.kind)||!fileKeyToken.test(f.fileKey)||!Number.isSafeInteger(f.size)||f.size<0)fail();
   if(f.kind==='file'){if(f.size>32*1024**2||!/^[a-f0-9]{64}$/.test(f.sha256))fail();total+=f.size;}else if(f.size!==0||f.sha256!==null)fail();paths.push(f.path);
  }
  if(total>128*1024**2||new Set(paths).size!==paths.length||!eq(paths,[...paths].sort()))fail();
 };
 if(!eq(r.icBaselines?.map(x=>x.invocation),Object.values(repeatSeeds).sort())||!eq(r.icChecks?.map(x=>x.invocation),Object.keys(repeatSeeds)))fail();
 for(const check of r.icChecks){
  const seed=repeatSeeds[check.invocation],base=r.icBaselines.find(x=>x.invocation===seed)?.snapshot;
  snapshot(base);snapshot(check.beforeCall);
  if(check.seedInvocation!==seed||Object.hasOwn(check,'baseline')||!base.entries.some(x=>x.path==='shrunk-classpath-snapshot.bin'&&x.kind==='file'))fail();
  const same=eq(base,check.beforeCall),positive=check.invocation==='unchanged',e=r.envelopes.find(e=>e.invocation===check.invocation),parent=r.envelopes.find(e=>e.invocation===seed);
  if(check.matched!==same||same!==positive||check.callsAfterCheck!==check.callsBefore||check.callsBefore!==cumulativeCalls[check.invocation]-(positive?1:0))fail();
  const from=phase(parent,'binding'),to=phase(e,'binding');
  if(to.sourceChanges!=='known-empty'||to.configurationId===from.configurationId||to.parameterId===from.parameterId||!eq(phase(parent,'seal'),phase(e,'seal')))fail();
  for(const k of ['sourcePath','sourceSha256','argumentsSha256','outputPath','incrementalStatePath','projectId','serviceId'])if(from[k]!==to[k])fail();
  if(!positive){if(e.phases.some(x=>x.phase==='call')||e.failureReason!=='ic_state_mismatch')fail();scope.icStateRejections++;}
  const target='shrunk-classpath-snapshot.bin',original=base.entries.find(x=>x.path===target),current=check.beforeCall.entries.find(x=>x.path===target);
  if(check.invocation==='ic-delete'&&(base.rootKey!==check.beforeCall.rootKey||current||!eq(base.entries.filter(x=>x.path!==target),check.beforeCall.entries)))fail();
  if(check.invocation==='ic-modify'&&(base.rootKey!==check.beforeCall.rootKey||!current||current.sha256===original.sha256||current.size!==original.size||current.fileKey!==original.fileKey||!eq(base.entries.filter(x=>x.path!==target),check.beforeCall.entries.filter(x=>x.path!==target))))fail();
  if(check.invocation==='ic-reset'&&check.beforeCall.entries.length!==0)fail();
 }
 const executions=c.executionEvidence;
 if(!Array.isArray(executions)||!eq(executions.map(x=>x.mode),['seed','skip','cache'])||new Set(executions.map(x=>x.witness.executionId)).size!==executions.length)fail();
 const seedId=executions[0].witness.executionId,reportSha256=hash(JSON.stringify(r));
 for(const execution of executions){
  const w=execution.witness,result=classifyOfferExecution(w);
  if(!eq(execution.classification,result)||!eq(execution.actionExecutions,[seedId])||execution.reportSha256!==reportSha256||execution.envelopeExecutionId!==seedId)fail();
  if(execution.mode==='seed'){if(!result.btaTaskActionExecuted||w.skipMessage!==null||!eq(execution.adoption,c.decisions[0].trusted)||execution.adoptionFileReads!==4)fail();}
  else {if(!eq(execution.adoption,{producerState:'completed',importStatus:'unavailable',reason:'owned_offer_action_not_executed',producerReason:null,fileReads:0,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'not-called',compilerWorkStatus:'unknown'})||result.reason!=='owned_offer_action_not_executed'||execution.adoptionFileReads!==0)fail();scope.blockedSuccessAdoptions++;if(result.btaTaskActionExecuted||result.importStatus!=='unavailable'||w.skipMessage!==(execution.mode==='cache'?'FROM-CACHE':'SKIPPED'))fail();if(execution.mode==='cache')scope.cacheRestorations++;else scope.skippedExecutions++;}
  scope.gradleBuilds++;
 }
 Object.assign(scope,verifyStorageAudit(r,repeatSeeds));
 // Import-time tampering of completed storage is refused by the bounded reader; the control is accepted unchanged.
 const probes=c.readerProbes,expectedProbes=[['reader-file-symlink','owned_offer_path_invalid'],['reader-root-escape','owned_offer_path_invalid'],['reader-extra-file','owned_offer_inventory_mismatch'],['reader-control',null]];
 if(!Array.isArray(probes)||!eq(probes.map(x=>x.mode),expectedProbes.map(x=>x[0])))fail();
 scope.readerBoundaryRejections=0;
 for(const [i,[mode,reason]] of expectedProbes.entries()){
  const x=probes[i];if(!Number.isInteger(x.readerCalls)||x.readerCalls<1||x.readerCalls>4)fail();
  if(reason){if(!eq(x.result,{rejected:reason}))fail();scope.readerBoundaryRejections++;}
  else if(!eq(x.result,c.decisions[0].trusted)||x.readerCalls!==4)fail();
 }
 return scope;
}
