/** Retention design arithmetic/catalogue only. No runtime helper, closure inspection or charge certificate. */
import {types} from 'node:util';
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const R1H_DESIGN=freeze({
 schema:'cwc-r1h.design.v1',profiles:['cwc.owned-retention-core.v1','cwc.owned-retention-summary.v1'],
 scope:{designOnly:true,runtimeImplemented:false,closureBoundProved:false,chargeCertificateVerified:false,actualParentLedgerVector:false,physicalHeapBound:false,r1mExit:false,r1Exit:false,productionAdopted:false,performanceMeasured:false},
 caps:{deploymentReads:4,attempts:2,referenceRoles:48,opaquePerAttempt:8,opaquePerRead:16,batches:19,clientFamilies:2,providerFamilies:1,pendingTransportPerRead:1,summaryRecordsPerRead:2,summaryRecordBytes:256},
 layout:{binary:3072,bridgeCandidate:1024,windowMetadataCandidate:4096,reservedWindowBodies:2,referenceCandidate:8,handleCandidate:32,containerCandidate:384,retirementIncludedInOldBridge:false,retiredIdentitiesIncludedInTwoWindows:true,extra32768Credit:false},
 batchCoverage:{minimumEntries:5,maximumRangesPerCommand:4,minimumNormalBatches:2},
 batchCases:[
  {n:1,arithmeticCheck:true,runtimeExpectation:'reject-incomplete-inventory',normalRuntime:false,runtimeExecuted:false},
  {n:2,arithmeticCheck:true,runtimeExpectation:'complete-inventory-required',normalRuntime:true,runtimeExecuted:false},
  {n:19,arithmeticCheck:true,runtimeExpectation:'complete-inventory-required',normalRuntime:true,runtimeExecuted:false},
 ],
 admission:{arbitraryHook:false,callerClosureProof:false,accessors:false,thenables:false,externalRawGraph:false,closedOwnedPortsRequired:true,sourceLoaderLayoutApprovalRequired:true,externalRetentionStillCharged:true},
 live:['authorization','purpose','pin','cancellation','originalDeadline','remainingBudget','content','independentPlan','transportFinal','outcome/use/ACK'],
 lifecycle:['reserve-before-copy/IO','fresh-attempt-identities','normal-window-local-close','fatal-read-first-revoke','remove-authority-lookup','retain-quarantined-capacity','drain-real-borrowers/frames/transport/consumers','zero-and-remove-holders','release-memory-once'],
 helpers:['preflightRetentionProfile','reserveRetentionRead','issueRetentionWindow','enterRetentionPhase','finishNormalWindow','revokeRetentionRead','emitTerminalSummary','releaseRetentionRead'],
 reservation:{allParentsBeforeCopyIO:true,retryKeepsKandD:true,retryKeepsDeadline:true,refundSpentWork:false,refundSpentInitialization:false,refundSpentWire:false,refundSpentAttempt:false,reuseRetiredIdentity:false,gcIsReleaseWitness:false,ackIsReleaseWitness:false},
 diagnostics:{coreExports:false,summarySchema:'cwc.retention-summary.v1',payloadReserve:512,rawObjects:false,newCanonicalOrHash:false,errorStringConversion:false,authorityEvidence:false,betweenFenceAndPublication:false,extraWrapperChargeRequired:true,ackReleasesConsumerCopy:false},
 certificate:['sourceClosure','runtimeImageAndFlags','schemaProfileLayout','actualOwnerNamespaces','objectReferenceContainerUpper','multiplicityAndResidency','releaseAndReuseRule','sourceLoaderAdmission','originalUnitWorkMapping'],
});
export const R1H_OWNERS=freeze([
 {id:'G',owner:'deployment/runtime',cap:'R=1..4 fixed read rows',end:'all retiring read debts drained; module residency separate',charge:'module + fixed registry/container/backing/root edges before load'},
 {id:'R',owner:'logical read',cap:'one read; two attempts and all retirement/export debts',end:'all child/consumer/transport debts drained',charge:'original real parent vector; no new memory/work limit'},
 {id:'W',owner:'attempt/window',cap:'two complete reserved bodies, each with 48 role slots and eight opaque identities',end:'normal local close plus last required use',charge:'two times (binary3072 + independently certified bridge); core handles alias windows'},
 {id:'T',owner:'retirement',cap:'sixteen unique opaque identities per read including current eight',end:'all approved holders relinquish references',charge:'all sixteen identities already reserved in two W bodies, counted once; retirement container separate'},
 {id:'D',owner:'summary export',cap:'two terminal records of 256 B per read; no unbounded copy',end:'sender/transport/approved consumer drains',charge:'512 B payload plus wrappers/queues/marshalling and work'},
 {id:'C',owner:'approved consumer/original root-fact owner',cap:'client: 76 facts + 76 length receipts + four roots per read; provider: 38 + 38 + two',end:'family/transport/use/ACK and all holder last uses',charge:'original region plus any additional holding cost; no automatic 8192 fit'},
 {id:'F',owner:'frame/scratch',cap:'source-certified maximum concurrent frame/alias count',end:'all frames including failure and cleanup return',charge:'explicit frame workspace; unknown until certificate'},
]);
export const R1H_REF_ROLES=freeze([
 'window owner','actual call','ReadScope','clock','window parent ledger','read parent ledger','authority port','source approval',
 'binding','channel','fresh snapshot','call lifecycle','first child claim','seal claim','first child window','seal window',
 'first root','seal root','first grant','seal grant','first A owner','seal A owner','first B codec','seal B codec',
 'owner context','first child context','seal context','first builder core','first A expected core','seal builder core','seal A expected core',
 'initial family','seal family','S0','S1','S2','chunk','codec overlay lease','binary metadata','fixed registry','drain handle','current receipt',
 'pending wire','existing drain owner','window reservation ticket','owner handle','scratch handle','certificate handle',
]);
export const R1H_SOURCE_ACTIONS=freeze([
 ['M15','W/F','enumerate owner/container/wrapper and frame edges'],['M16','G/R','replace retained call Map with fixed capacity; separate lookup from quarantine'],
 ['M17','W/T','eight per attempt; sixteen unique identities across retries'],['M18','W/F','end real borrows and preserve moved backing identity'],
 ['M19','R/F','no arbitrary Promise reaction; retain captured owners/debit until real drain'],['M20','G/R','bound budget registry, ticket rows and descriptor snapshots; release is not deletion'],
 ['M21','G','pre-load grammar/schema module residency approval'],['M22','F','include parser recursive frames, spans and helper closures'],
 ['M30','C/R','account original roots/facts/receipts/source and final use separately'],['M31','R','diagnostic ticket is not real whole-parent proof'],
 ['M32','D','remove unbounded trace from core; bounded summary only'],['M33','D/R','remove trace/digest registry tails after actual last use'],
 ['M34','D/C','no generic stats object copies'],['M35','D/C','no raw diagnosticRows copies'],['M36','D/F','no new terminal canonical/hash; count retained digest rows'],
 ['M37','C','include fixture/oracle caller graphs or isolate with charged boundary'],['M38','C/F','foreign error graph unsupported; no getter/string conversion'],
 ['M44','G','reject arbitrary stored hook before capture'],['M45','C','reject unknown closure graph; removal of edge is not caller release'],
].map(([id,owner,action])=>({id,owner,action,runtimeImplemented:false,approvedChargeRef:null})));
export const R1H_SUMMARY_LAYOUT=freeze([
 {name:'magic',offset:0,bytes:4},{name:'version',offset:4,bytes:2},{name:'flags',offset:6,bytes:2},
 {name:'fifteen-safe-u64',offset:8,bytes:120},{name:'sourceDigest',offset:128,bytes:32},
 {name:'profileDigest',offset:160,bytes:32},{name:'layoutDigest',offset:192,bytes:32},{name:'reserved-zero',offset:224,bytes:32},
]);
function object(v,keys){
 if(!v||typeof v!=='object'||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)throw Error('r1h_object');
 const own=Reflect.ownKeys(v);if(own.length!==keys.length||own.some(k=>!keys.includes(k)))throw Error('r1h_keys');
 const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);if(!d||!('value'in d)||!d.enumerable)throw Error('r1h_accessor');out[k]=d.value;}return out;
}
const int=n=>Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0);
const need=(v,r)=>{if(!v)throw Error('r1h_'+r);};
const add=a=>{if(a.includes(null))return null;const n=a.reduce((a,b)=>a+b,0);need(int(n),'overflow');return n;};
const mul=(a,b)=>a===null?null:add(Array.from({length:b},()=>a));
export function r1hCounts(input){
 const v=object(input,['readOwners','kind','actualAttempts','exportMode']);
 need(int(v.readOwners)&&v.readOwners>=1&&v.readOwners<=4,'read_capacity');need(['provider','client'].includes(v.kind),'role');
 need([1,2].includes(v.actualAttempts),'attempts');need(['none','summary-v1'].includes(v.exportMode),'export');
 const F=v.kind==='client'?2:1,D=v.exportMode==='summary-v1';return {...v,reservedAttempts:2,reservedWindowBodies:2,activeOpaquePerAttempt:8,reservedOpaquePerRead:16,issuedOpaque:8*v.actualAttempts,
 reservedFactsPerRead:19*F*2,reservedLengthReceiptsPerRead:19*F*2,reservedRootsPerRead:F*2,summaryReservedRecords:D?2:0,summaryPayloadReserve:D?512:0,runtimeAdmitted:false};
}
export function r1hBatchArithmetic(input){
 const v=object(input,['kind','batchCount']);need(['provider','client'].includes(v.kind),'role');need(int(v.batchCount)&&v.batchCount>=1&&v.batchCount<=19,'batch_count');
 const F=v.kind==='client'?2:1;return {...v,families:F,reservedRowsPerRead:19*F*2,arithmeticRowsPerAttempt:v.batchCount*F,
 runtimeExpectation:v.batchCount===1?'reject-incomplete-inventory':'complete-inventory-required',fullCoreValidated:false,runtimeExecuted:false,runtimeAdmitted:false};
}
export function r1hUpperExample(input){
 const keys=['referenceUpper','handleUpper','windowContainerUpper','retirementContainerUpper','summaryWrapperUpper','moduleShareUpper','frameUpper','exportMode'];
 const v=object(input,keys);for(const k of keys.slice(0,-1))need(v[k]===null||int(v[k]),'upper');need(['none','summary-v1'].includes(v.exportMode),'export');
 const bridgeUpper=add([mul(v.referenceUpper,48),mul(v.handleUpper,8),v.windowContainerUpper]),windowMetadataUpper=add([3072,bridgeUpper]);
 // Full two-attempt reservation: prior binary/table/container may still be retained.
 // The sixteen unique handle objects are already included; moving W -> T does not allocate another eight.
 const reservedWindowsUpper=mul(windowMetadataUpper,2),retirementExtraUpper=v.retirementContainerUpper,summaryPayloadUpper=v.exportMode==='summary-v1'?512:0;
 const additionalBeyondOldMetadataUpper=add([reservedWindowsUpper===null?null:Math.max(0,reservedWindowsUpper-4096),retirementExtraUpper,summaryPayloadUpper,v.exportMode==='summary-v1'?v.summaryWrapperUpper:0,v.moduleShareUpper,v.frameUpper]);
 return {bridgeUpper,windowMetadataUpper,windowCandidateFits:windowMetadataUpper===null?null:windowMetadataUpper<=4096,reservedWindowBodies:2,reservedWindowsUpper,retirementExtraUpper,summaryPayloadUpper,additionalBeyondOldMetadataUpper,retentionEnvelopeUpper:add([4096,additionalBeyondOldMetadataUpper]),
 status:'conditional-arithmetic-only',knownLowerBytes:0,readBudgetFits:null,physicalHeapUpperBytes:null,chargeVerified:false,runtimeAdmitted:false};
}
