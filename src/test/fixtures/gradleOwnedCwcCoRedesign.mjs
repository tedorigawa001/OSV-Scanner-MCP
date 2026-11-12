/** CCO-R design arithmetic only. No producer, consumer, approval gate or runtime helper. */
import {capacityCandidate} from './gradleOwnedCwcLgCapacity.mjs';
export const CO_RED_DESIGN={
 profile:'cwc.owned-command-window.v3',recipe:'cwc.command-projection-scratch.v1',status:'proposed-not-admitted',
 window:{slots:3,bytesPerSlot:8192,tokenRecords:512,tokenRecordBytes:16,depth:32,externalChunkBytes:4096,codecOverlayBytes:16384,codecBytes:393216},
 metadata:{header:128,rows:2*19*64,bridge:1024,leases:3*128,alignment:128,binaryArenaBytes:3072,total:4096},
 bridge:{referenceSlots:48,referenceCharge:8,handles:8,handleCharge:32,containerCharge:384,total:1024,physicalHeapBound:false,chargeCertificateRequired:true},
 coreHandle:{aliasOf:'window-handle',runtimeIdentity:'same-object',additionalHandles:0,additionalReferenceSlots:0,separateGeneration:false,
  lookupLifetime:'same-window-registry-entry',binding:{provider:{window:14,builderCore:27,expectedCore:28},'client-initial':{window:14,builderCore:27,expectedCore:28},'client-seal':{window:15,builderCore:29,expectedCore:30}}},
 batch:{reservedRows:19,minimum:1,maximum:19,actualCount:'validated-core.groups.length=command.batchCount',completion:'exact-ordinals-0-through-n-minus-one',
  unusedRows:'zero-unused-no-capture-or-proof',smallerPlanRefund:false,countMutableAfterOpen:false,independentCountsPerActor:true},
 cores:{client:4,providerFloor:3,callerGraphMustBeOwnedConsumedOrSeparatelyCharged:true,externalGraphDefaultCovered:false},
 helpers:['reserveOwnedRead','openOwnedProducer','captureCanonicalFamily','validateOwnedRow','emitIndependentExpected','compareAndBindFact','proveOwnedFact','closeOwnedWindow'],
 sinks:['family-row','expected-slot','hash-state','byte-comparator'],
 approvalRequired:['sourceClosure','semanticEquivalence','schemaMaximum','representationCharge','coreOwnership','residencyDAG','bridgeCharge','scratchOverlap','costCoverage','ownerLedgerBinding','liveSiteMap'],
 work:{planTicket:156978,callLimit:156978,providerLimit:1048576,globalWorkLimit:67108864,globalWireLimit:67108864,logicalChecks:4096,
  unit:'cpr.request-bytes-ranges-probes.v1',unknownSite:'unsupported-before-read',primitiveQuantityConversionAllowed:false,historicalStandaloneTwoAttemptSpent:151554},
 forbidden:['shallow-preimage-object','recursive-canonical-map-join','unbounded-object-parse','unapproved-native-hash','raw-core-export','candidate-command-handle','unbounded-registry','runtime-diagnostic-trace'],
 preserved:['full-schema-and-semantics','independent-initial-seal-provider-plan','full-canonical-and-byte-comparison','every-original-live-site','purpose-credentials-and-current-pins','original-deadline-and-K/D','transport-final-outcome-use-ACK','failure-consumption-and-drain'],
 scope:{designOnly:true,runtimeImplemented:false,threeSlotProved:false,metadata4096Proved:false,scratchBoundProved:false,costCoverageProved:false,
  wholeBudgetCoexistenceProved:false,co0Exit:false,co1Admitted:false,productionAdopted:false}
};
const need=(v,r)=>{if(!v)throw Error('co_redesign_'+r);};
function sum(values){need(values.every(v=>Number.isSafeInteger(v)&&v>=0),'quantity');const total=values.reduce((a,b)=>a+b,0);need(Number.isSafeInteger(total),'overflow');return total;}
/** Conditional ledger floor. Caller graphs=0 is an unproved ownership obligation, not a default runtime grant. */
export function coRedesignCapacity(c,role,{callerClientCores=0,callerProviderCores=0,outsideScratch=4096,bridgeOverTarget=0,otherUncoveredBytes=0}={}){
 for(const n of [callerClientCores,callerProviderCores,outsideScratch,bridgeOverTarget,otherUncoveredBytes])sum([n]);
 const prior=capacityCandidate(c,role,'window-3-with-4096-metadata'),C=prior.widths.coreBytes;
 const extra=[outsideScratch,bridgeOverTarget,otherUncoveredBytes],clientCores=sum([4,callerClientCores]),providerCores=sum([3,callerProviderCores]);
 const client=sum([prior.client.combinedPeak,(clientCores-3)*C,...extra]),provider=sum([prior.provider.combinedPeak,(providerCores-3)*C,...extra]);
 return {role,widths:prior.widths,oldClient:prior.client.combinedPeak,oldProvider:prior.provider.combinedPeak,clientCores,providerCores,
  outsideScratch,bridgeOverTarget,otherUncoveredBytes,client,provider,clientSlack:1048576-client,providerSlack:1048576-provider,
  arithmeticFits:client<=1048576&&provider<=1048576,metadataTargetMet:bridgeOverTarget===0,ownershipAndOverlayProved:false,runtimeAdmitted:false};
}
export function coRedesignWork({work,initialization,extraWork,extraInitialization,attempts=2}){
 const spent=sum([work,initialization]),requested=sum([extraWork,extraInitialization]),total=sum([spent,requested]);need(Number.isSafeInteger(attempts)&&attempts>0,'attempts');
 return {limit:156978,spent,requested,total,remaining:156978-spent,maximumEqualPerAttempt:Math.floor(Math.max(0,156978-spent)/attempts),arithmeticFits:total<=156978,
  unitAndOwnerMappingProved:false,runtimeAdmitted:false};
}
/** Count/layout consistency only. This does not validate a core, run a producer or mint a proof. */
export function coRedesignBatch({batchCount:n,coreGroups,width,capturedOrdinals,provedOrdinals,commandBatchCounts}){
 need(Number.isSafeInteger(n)&&n>=1&&n<=19,'batch_count');need(coreGroups===n,'batch_binding');need(Number.isSafeInteger(width)&&width>0&&width<=8192,'width');
 const sequence=a=>{need(Array.isArray(a)&&a.length===n,'row_count');for(let i=0;i<n;i++)need(Object.hasOwn(a,i)&&a[i]===i,'ordinal');};
 sequence(capturedOrdinals);sequence(provedOrdinals);
 const counts=commandBatchCounts??Array(n).fill(n);need(Array.isArray(counts)&&counts.length===n,'batch_binding');for(let i=0;i<n;i++)need(Object.hasOwn(counts,i)&&counts[i]===n,'batch_binding');
 return {batchCount:n,reservedRows:19,reservedFamilyBytes:19*width,processedRows:n,unusedRows:19-n,completedMask:2**n-1,
  fullCoreValidated:false,runtimeAdmitted:false};
}
