/** R1-HB design catalogue / typed conditional arithmetic only. No loader, signer, certificate or permission. */
import {types} from 'node:util';
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const R1HB_DESIGN=freeze({
 schema:'cwc-r1hb.design.v1',candidateProfile:'cwc.retention-boundary.v1',
 scope:{designOnly:true,sourceSplitImplemented:false,loaderGateImplemented:false,portRoleAuthorityProved:false,allocationUpperProved:false,chargeCertificateVerified:false,physicalHeapBound:false,originalUnitWorkMapping:false,actualParentLedgerVector:false,r1mExit:false,productionAdopted:false,performanceMeasured:false},
 boundaries:{core:['core','reader-port','pure-helper'],outsideCore:['controller','diagnostic','harness','record-validator'],sameArtifactObserverAllowed:false,observerFlagIsSeparation:false,declaredGraphIsLoadedClosureProof:false,portBrandIsAuthorization:false,callerFunctionsAllowed:false},
 limits:{activeReads:4,epochReads:64,entriesPerRead:256,cleanupEntriesPerRead:16,refusalsPerEpoch:64,modules:64,regions:32,edges:256,bootstrapMetadataBytes:65536},
 lifetimeClasses:['global-resident','read-reusable','read-epoch-debt','entry-epoch-debt','refusal-epoch-debt','frame-reusable','bootstrap-reusable'],
 units:['payload-byte','object-count','reference-count','logical-byte','physical-byte'],arithmeticUnit:'logical-byte',
 port:{roles:['reader','controller'],readerExportsMutation:false,readerConstructorEscapesAllowed:false,issuedForActualGOwner:true,callerRoleFlagAccepted:false,currentChecks:['authorization','purpose','pin','revision','approvalRevision','cancellation','originalDeadline','remainingOriginalBudget'],freshSnapshotIsCachedAuthority:false},
 certificate:{schema:'cwc.retention-charge.v1',hash:'sha256/canonical-body',signatureDomain:'cwc.retention-charge-signature.v1',selfDigestInBody:false,certificatePinEmbeddedInCore:false,maximumRegions:32,evidenceRefsPerRegion:8,unknownRegionPermitsLoad:false,currentApprovalCheckedPerEntry:true},
 helpers:['preflightRetentionLoad','instantiateRetentionOwner','reserveRetentionCharge','enterRetentionOperation','finishRetentionOperation','drainRetentionOwner'],
 evidence:['independentRegistryPin','actualSourceArtifactClosure','loaderResolutionWitness','runtimeImageAndFlags','portRoleIssuance','resourceAndEdgeInventory','representationUnitMapping','allocationAndLifetimeBound','reusableReleaseWitness','allOriginalParentReservations','originalUnitWorkMapping'],
 quota:{entryCapIsRpcBudget:false,entryCapIsWorkConversion:false,attemptsReduceReservations:false,retryResetsEpoch:false,failedEntryRefund:false,oldEpochDebtClearedByNewOwner:false,logicalDrainIsGcWitness:false,sourceHashIsAllocationProof:false},
 refusals:['source-boundary-unsupported','loader-evidence-unavailable','port-role-mismatch','binding-mismatch','charge-unit-mismatch','charge-evidence-unavailable','allocation-budget-exceeded','original-budget-exceeded','lifetime-witness-unavailable','revoked-or-expired'],
});
export const R1HB_REGIONS=freeze([
 ['HB01','G','global-resident','module / intrinsic / schema closure','all resident allocations before core evaluation'],
 ['HB02','G','global-resident','reader-port cell / issuance / role state','controller graph never reachable through reader'],
 ['HB03','G','global-resident','fixed registry / root edges / capacity rows','one global charge, no G/R division credit'],
 ['HB04','R','read-epoch-debt','Read row / persistent counters','one allocation per read until certified release'],
 ['HB05','R','read-epoch-debt','binding + scope / ownedView alias','one binding object, each alias edge separately'],
 ['HB06','W','read-epoch-debt','two binary backing stores / typed-array wrappers','6144 payload bytes do not include wrappers or allocator state'],
 ['HB07','W','read-epoch-debt','two 48-position reference tables','96 edges plus both table headers/backing'],
 ['HB08','W/T','read-epoch-debt','sixteen identities / two handle arrays','CoreHandle alias and read-control alias add no identity'],
 ['HB09','W','read-epoch-debt','two Body wrappers / body list','five persistent arrays across HB07/HB08/HB09'],
 ['HB10','T','read-epoch-debt','retirement containers / cleared lookups','moves do not reallocate sixteen identities'],
 ['HB11','F','read-epoch-debt','make/define descriptors and construction closures','114 descriptor literal evaluations per current read'],
 ['HB12','F','entry-epoch-debt','run callback / find predicate / helper temporaries','entry allocation must be reserved before construction'],
 ['HB13','F','frame-reusable','managed / JS / native frame and scratch','managed frames=0 is not physical release'],
 ['HB14','G-bootstrap','bootstrap-reusable','manifest / signature / closure validation workspace','before core load; no free verifier workspace'],
 ['HB15','F','refusal-epoch-debt','Error / stack / refusal formatting','candidate primitive refusal must still have independent bound'],
 ['HB16','D','global-resident','observer / snapshot / diagnostic queue','outside core; own parent or certified isolation boundary'],
 ['HB17','C','read-epoch-debt','caller-held opaque identities / copied results','closed consumer global quota and holder drain required'],
 ['HB18','R/C','read-epoch-debt','original CWC roots / facts / leases / source','retain original owner regions, no new baseline credit'],
].map(([id,owner,lifetime,resource,obligation])=>({id,owner,lifetime,resource,obligation,approvedUpper:null,actualParentBound:false})));
export const R1HB_SOURCE_FACTS=freeze({
 observerAndFaultsInCurrentArtifact:true,actualAdmittedArtifact:false,
 perRead:{binaryPayloadBytes:6144,binaryViews:2,referencePositions:96,opaqueIdentities:16,persistentArrays:5,bodyObjects:2,bindingObjects:1,scopeObjects:1,readObjects:1,descriptorLiteralEvaluations:114},
 descriptorFormula:{bodies:2,handleDescriptorsPerBody:8,referenceDescriptorsPerBody:48,bodyListDescriptorsPerBody:1},
 entryExample:{operation:'window',runCallbackLiterals:1,findPredicateLiterals:1,publicEntryCountBoundInCurrentFixture:null},
 countIsRepresentationCharge:false,sourceAuditIsAstCensus:false,physicalUpperBytes:null,
});
const need=(v,r)=>{if(!v)throw Error('r1hb_'+r);},integer=n=>Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0);
function data(root){let nodes=0;const active=new Set();function visit(v,depth){need(++nodes<=16384&&depth<=24,'data_budget');if(v===null||typeof v==='boolean')return;if(typeof v==='string'){need(v.length<=16384,'string');return;}if(typeof v==='number'){need(integer(v),'number');return;}
 need(v&&typeof v==='object'&&!types.isProxy(v)&&!active.has(v),'data');const array=Array.isArray(v);need(Object.getPrototypeOf(v)===(array?Array.prototype:Object.prototype),'prototype');const names=Reflect.ownKeys(v);if(array)need(names.length===Object.getOwnPropertyDescriptor(v,'length').value+1,'array');active.add(v);for(const k of names){need(typeof k==='string','key');const d=Object.getOwnPropertyDescriptor(v,k);need(d&&'value'in d,'accessor');if(array&&k==='length')continue;need(d.enumerable,'enumerable');visit(d.value,depth+1);}active.delete(v);}visit(root,0);}
function record(v,keys){need(v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype,'record');const names=Reflect.ownKeys(v);need(names.length===keys.length&&names.every(k=>keys.includes(k)),'keys');const out={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);need(d&&'value'in d&&d.enumerable,'accessor');out[k]=d.value;}return out;}
function quantity(q){const v=record(q,['unit','upper']);need(v.unit==='logical-byte','unit');need(v.upper===null||integer(v.upper),'upper');return v.upper;}
const sum=a=>{if(a.includes(null))return null;const s=a.reduce((x,y)=>x+y,0);need(integer(s),'overflow');return s;};
const times=(v,n)=>v===null?null:sum([v*n]);
export const R1HB_COMPONENTS=freeze(['globalResident','readReusable','readEpoch','entryEpoch','refusalEpoch','framesReusable','bootstrapReusable']);
export function r1hbEnvelope(input){
 data(input);
 const v=record(input,['activeReads','epochReadLimit','entryLimit','refusalLimit','parentLimit',...R1HB_COMPONENTS]);
 for(const [k,max,min]of [['activeReads',4,1],['epochReadLimit',64,1],['entryLimit',256,17],['refusalLimit',64,0]])need(integer(v[k])&&v[k]>=min&&v[k]<=max,'quota');need(v.epochReadLimit>=v.activeReads,'quota');
 const limit=quantity(v.parentLimit);need(limit!==null&&limit>0&&limit<=1048576,'parent_limit');const q=Object.fromEntries(R1HB_COMPONENTS.map(k=>[k,quantity(v[k])]));
 const terms={globalResident:q.globalResident,readReusable:times(q.readReusable,v.activeReads),readEpoch:times(q.readEpoch,v.epochReadLimit),entryEpoch:times(q.entryEpoch,v.epochReadLimit*v.entryLimit),refusalEpoch:times(q.refusalEpoch,v.refusalLimit),framesReusable:q.framesReusable,bootstrapReusable:q.bootstrapReusable},upper=sum(Object.values(terms));
 return {unit:'logical-byte',terms,upper,parentLimit:limit,reservedOrdinaryEntriesPerRead:v.entryLimit-16,reservedCleanupEntriesPerRead:16,conditionalFits:upper===null?null:upper<=limit,status:upper===null?'unsupported-uncovered':upper<=limit?'conditional-arithmetic-only':'conditional-upper-exceeds-parent',knownLower:0,fullReadBudgetFits:null,physicalUpperBytes:null,certificateVerified:false,runtimeAdmitted:false};
}
/** Declared topology shape only. This never proves actual imports, loader behavior or code evaluation safety. */
export function r1hbTopology(input){
 data(input);
 const v=record(input,['entry','modules']);need(typeof v.entry==='string'&&v.entry.length<=128&&Array.isArray(v.modules)&&v.modules.length>0&&v.modules.length<=64,'modules');const modules=new Map();
 for(const raw of v.modules){const m=record(raw,['id','role','artifact','edges']);need(typeof m.id==='string'&&m.id.length>0&&m.id.length<=128&&typeof m.artifact==='string'&&/^[a-f0-9]{64}$/.test(m.artifact)&&!modules.has(m.id),'module');need([...R1HB_DESIGN.boundaries.core,...R1HB_DESIGN.boundaries.outsideCore].includes(m.role),'role');need(Array.isArray(m.edges)&&m.edges.length<=256&&m.edges.every(x=>typeof x==='string'&&x.length<=128)&&new Set(m.edges).size===m.edges.length,'edges');modules.set(m.id,m);}
 need(modules.has(v.entry)&&modules.get(v.entry).role==='core','entry');let edges=0;for(const m of modules.values()){edges+=m.edges.length;need(edges<=256&&m.edges.every(e=>modules.has(e)),'edge_closure');}
 const visited=new Set(),stack=[v.entry];while(stack.length){const id=stack.pop();if(visited.has(id))continue;visited.add(id);const m=modules.get(id);need(R1HB_DESIGN.boundaries.core.includes(m.role),'boundary');need(![...modules.values()].some(other=>other.artifact===m.artifact&&R1HB_DESIGN.boundaries.outsideCore.includes(other.role)),'artifact_boundary');stack.push(...m.edges);}
 return {declaredCoreModules:visited.size,declaredEdges:edges,status:'metadata-shape-only',actualClosureProved:false,loaderPermitIssued:false,runtimeAdmitted:false};
}
