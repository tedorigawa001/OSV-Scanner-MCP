// Published metadata replay. File bytes were verified only in the native harness.
import {readOwnedOffer,validateOwnedOffer,offerJdkProfile} from './btaOfferContract.mjs';
import {btaDriverProfiles} from './gradleBtaDriverRuntime.mjs';
import {hash} from './gradleBtaDriverProof.mjs';
export const offerSources=['src/test/fixtures/BtaOwnedDriver.java','src/test/fixtures/BtaOfferProbe.java','src/test/fixtures/gradle-bta-offer.gradle','src/test/fixtures/btaOfferContract.mjs','src/test/gradle/btaOffer.integration.test.ts','src/test/fixtures/gradleBtaDriverRuntime.mjs','src/test/fixtures/gradleSnapshotOwnerExpected.mjs'];
export const offerVerificationSources=['src/test/fixtures/btaOfferContract.d.mts','src/test/fixtures/btaOfferProof.mjs','src/test/fixtures/btaOfferProof.d.mts','src/test/gradle/btaOffer.test.ts','src/test/manual/gradleBtaOfferResults.mjs'];
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw Error('bta_offer_record_invalid');};
const modes=['completed','storage-failed','call-failed','post-failed','foreign-config','foreign-project','foreign-parameter','stale-precheck','source-changed','unsupported'];
const expectedCases={
 completed:{state:'completed'},
 'storage-failed':{state:'failed',phase:'seal',reason:'storage_failed'},
 'call-failed':{state:'failed',phase:'call',reason:'compile_failed'},
 'post-failed':{state:'failed',phase:'postcheck',reason:'stale'},
 'foreign-config':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'foreign-project':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'foreign-parameter':{state:'failed',phase:'precheck',reason:'binding_mismatch'},
 'stale-precheck':{state:'failed',phase:'precheck',reason:'stale'},
 'source-changed':{state:'failed',phase:'precheck',reason:'stale'},
 unsupported:{state:'unavailable',reason:'execution_unsupported',blockedBeforePhase:'registration'},
};
const faults={'post-failed':'stale','stale-precheck':'stale','source-changed':'stale','foreign-config':'binding_mismatch','foreign-project':'binding_mismatch','foreign-parameter':'binding_mismatch'};
export function verifyOfferCase(c){
 const profile=btaDriverProfiles[c.gradleVersion];if(!profile||!['Groovy','Kotlin'].includes(c.dsl)||!eq(Object.keys(c.sourceHashes),offerSources))fail();
 const registration={producerSha256:hash(c.sourceHashes[offerSources[0]]+c.sourceHashes[offerSources[1]]),runtimeSha256:hash(JSON.stringify(profile.runtime)),profileSha256:hash(JSON.stringify({version:c.gradleVersion,java:offerJdkProfile.java.sha256,strategy:'in-process'}))};
 if(!eq(c.registration,registration))fail();
 const r=c.report,g=c.gradle;
 if(r.schema!=='osv-mcp.bta-offer-probe-v2'||r.actualCompilerVersion!==profile.kotlinVersion||r.javaSha256!==offerJdkProfile.java.sha256||r.naturalContentBinding!==false||r.productionAdopted!==false||g.gradleVersion!==c.gradleVersion||g.javaSha256!==offerJdkProfile.java.sha256||g.javacSha256!==offerJdkProfile.javac.sha256||g.maxWorkers!==1||g.parallel!==false)fail();
 if(!eq(r.envelopes.map(e=>e.invocation),modes)||!eq(c.decisions.map(e=>e.invocation),modes))fail();
 if(!eq(r.rejections.map(e=>e.mode),['duplicate-begin','reentry','reuse','phase-after-completion','failed-reuse','late-registration'])||r.rejections.some(e=>!Number.isInteger(e.callsBefore)||e.callsBefore!==e.callsAfter))fail();
 const classes=['BtaOfferProbe$Broker.class','BtaOfferProbe$Handle.class','BtaOfferProbe$Rejected.class','BtaOfferProbe.class','BtaOwnedDriver$Binding.class','BtaOwnedDriver$ConfigurationRejected.class','BtaOwnedDriver.class'];
 if(!eq(r.driverClasses.map(x=>x.path),classes)||r.driverClasses.some(x=>!/^[a-f0-9]{64}$/.test(x.sha256)||x.size<=0))fail();
 // Native records describe the library call and each generated snapshot once, not once per offer.
 const lib=r.libraryCompilation,generation=r.snapshotGeneration;
 if(lib?.result!=='COMPILATION_SUCCESS'||lib.sourceSha256!==hash('package dep\nclass Library { fun message(): String = \"library-value\" }\n')||!Array.isArray(lib.outputs)||lib.outputs.length!==2||lib.outputs.some(x=>!/^[a-f0-9]{64}$/.test(x.sha256)||!Number.isSafeInteger(x.size)||x.size<=0)||!eq(lib.outputs.map(x=>x.path),['META-INF/offerLibrary.kotlin_module','dep/Library.class']))fail();
 const impl=profile.runtime.find(x=>x.coordinate.startsWith('org.jetbrains.kotlin:kotlin-build-tools-impl:'));
 const stdlib=profile.runtime.find(x=>x.coordinate.startsWith('org.jetbrains.kotlin:kotlin-stdlib:'));
 if(generation?.generatorSha256!==impl.sha256||!eq(generation.snapshots?.map(x=>[x.id,x.inputSha256]),[['library.snapshot',lib.jarSha256],['stdlib.snapshot',stdlib.sha256]]))fail();
 const scope={gradleBuilds:1,btaCalls:1,successfulBtaCalls:Number(lib.result==='COMPILATION_SUCCESS'),generatedSnapshots:generation.snapshots.length,completedOffers:0,failedOffers:0,unavailableOffers:0,handleRejections:0,integrityRejections:0,naturalReceipts:0,productionAdoptions:0};
 let exportId;const cumulativeCalls={};
 for(let i=0;i<modes.length;i++){
  const e=r.envelopes[i],d=c.decisions[i],expectedCase=expectedCases[e.invocation];
  if(e.producerState!==expectedCase.state)fail();
  if(expectedCase.state==='failed'&&(e.failurePhase!==expectedCase.phase||e.failureReason!==expectedCase.reason))fail();
  if(expectedCase.state==='unavailable'&&(e.unavailableReason!==expectedCase.reason||e.blockedBeforePhase!==expectedCase.blockedBeforePhase))fail();
  if(e.invocation==='call-failed'&&(e.phases.at(-1)?.evidence?.errorKind!=='result'||e.phases.at(-1)?.evidence?.detail!=='COMPILATION_ERROR'))fail();
  exportId??=e.exportId;if(e.exportId!==exportId||e.profileId!=='test-owned-'+c.gradleVersion)fail();
  const settings={trust:true,profiles:{[e.profileId]:{registration,strategy:'in-process'}},graphId:'graph',exportId};
  let evidence;try{evidence=validateOwnedOffer(e);if(faults[e.invocation])fail();}catch(error){if(error.message!=='owned_offer_'+faults[e.invocation])throw error;}
  if(evidence?.registration&&!eq(evidence.registration,registration))fail();
  const generated=e.phases.find(x=>x.phase==='generation'&&x.outcome==='success')?.evidence;
  if(generated&&(!eq(generated.snapshots,generation.snapshots)||generated.librarySha256!==lib.jarSha256||generated.generatorSha256!==generation.generatorSha256))fail();
  scope[e.producerState+'Offers']++;
  scope.btaCalls+=e.phases.filter(x=>x.phase==='call'&&x.outcome==='begin').length;
  scope.successfulBtaCalls+=e.phases.filter(x=>x.phase==='call'&&x.outcome==='success').length;
  if(faults[e.invocation])scope.integrityRejections++;
  cumulativeCalls[e.invocation]=scope.btaCalls-1;
  const gates=[{...settings,trust:false},{...settings,profiles:{}}].map(s=>{try{return readOwnedOffer(e,s,()=>{throw Error('unexpected-read');});}catch(error){return {rejected:error.message};}});
  if(!eq(gates,d.gates))fail();
  if(e.invocation==='completed'){
   const expected={producerState:'completed',importStatus:'accepted',reason:null,fileReads:4,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'bta-call-only',compilerWorkStatus:'unknown'};if(!eq(d.trusted,expected))fail();
  }else if(faults[e.invocation]){if(!eq(d.trusted,{rejected:'owned_offer_'+faults[e.invocation]}))fail();}
  else {if(!eq(d.trusted,readOwnedOffer(e,settings,()=>{throw Error('unexpected-read');})))fail();}
 }
 const rejectionReasons=['duplicate_begin','configuration_reused','configuration_reused','phase_invalid','configuration_reused','registration_closed'];
 const rejectionCounts=[0,0,cumulativeCalls.completed,cumulativeCalls.completed,cumulativeCalls['call-failed'],scope.btaCalls-1];
 for(let i=0;i<r.rejections.length;i++){const entry=r.rejections[i];if(entry.reason!==rejectionReasons[i]||entry.callsBefore!==rejectionCounts[i])fail();scope.handleRejections++;}
 if(r.btaConsumerCalls!==scope.btaCalls-1||r.libraryCalls!==1||r.generatedSnapshots!==scope.generatedSnapshots)fail();
 return scope;
}
