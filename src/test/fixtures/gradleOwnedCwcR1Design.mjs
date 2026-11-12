/** R1 design inventory and conditional arithmetic. No ownership transfer, reservation or read gate implementation. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const need=(v,r)=>{if(!v)throw Error('r1_design_'+r);};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const sum=xs=>{need(xs.every(integer),'quantity');const n=xs.reduce((a,b)=>a+b,0);need(integer(n),'overflow');return n;};
export const R1_DESIGN={
 schema:'cwc-r1.design.v1',status:'design-only',profile:'cwc.owned-command-window.v3',recipe:'cwc.command-projection-scratch.v1',
 ownership:{inputs:'producer-created-private-handle-only',rawGraphTransferSupported:false,callerFlagAccepted:false,copyIsTransfer:false,
  modes:['construct-private','internal-move'],phases:['unregistered','registered','capacity-reserved','constructing','owned-ready','borrowed','retiring','drained'],
  binding:['actual-call','ReadScope','actor','root','generation','snapshot','clock','original-deadline','K/D','ledger-vector'],coreFloor:{client:4,provider:3},contextFloor:3,
  coreHandleAlias:'existing-window-same-object',externalAliasRequiresAdditionalCharge:true,oldOwnerInvalidatedBeforePublication:true,frameAndBorrowDrainBeforeReuse:true,
  handoff:{order:['pin-and-stop-source','drain-existing-borrows','acquire-exclusive-handoff','final-complete-validation','bind-destination','publish-window'],
   sourceStopBeforeFinalValidation:true,lifetimePinBeforeDrain:true,exclusiveThroughBind:true,rawAliasAccepted:false,additionalPublicHandles:0,memoryReleaseDuringMove:false,
   writesAllowedAfterFinalValidation:false,zeroAllowedBeforeDestinationDrain:false,caughtMutationAttemptIsFatal:true,revisionRestoreAccepted:false,callbackBetweenFinalFenceAndBind:false,runtimeImplemented:false}},
 layout:{slots:3,slotBytes:8192,metadataBinary:3072,bridgeCandidate:1024,referenceSlots:48,handles:8,chunk:4096,overlayCandidate:16384,codec:393216,memoryLimit:1048576,
  packedHeader:512,contextTokens:256,tokenBytes:16,packedRanges:76,rangeBytes:64,traceInAdmittedPath:false,physicalHeapBound:false},
 reservation:{unit:'cpr.request-bytes-ranges-probes.v1',plan:156978,call:156978,providerWork:1048576,globalWork:67108864,globalWire:67108864,lbWire:163840,lbAttempts:256,logicalChecks:4096,
  namespaces:['Lb0.call','CwcC.plan-parent','provider.read-row','global-work-wire'],allParentsBeforeCopyIO:true,childTicketIsParentReceipt:true,aliasDebitedOncePerNamespace:true,
  partialFailureConsumptionRefund:false,memoryReleaseRequiresDrain:true,callbackDuringCommit:false,commitFailureAdmission:false,permitIsDispatchPermit:false,deadlineExtension:false},
 requiredEvidence:['sourceClosure','semanticEquivalence','schemaMaximum','representationCharge','coreOwnership','residencyDAG','bridgeCharge','scratchOverlap','costCoverage','ownerLedgerBinding','liveSiteMap'],
 unknowns:['bootstrap-graph-charge','caller-and-escaped-graph-custody','core-context-representation-charge','bridge-control-and-closures','codec-residency-overlap','native-hash-bound-and-release','primitive-unit-coverage','actual-ledger-vector','diagnostic-and-terminal-overlap'],
 scope:{designOnly:true,runtimeTransferImplemented:false,runtimeGateImplemented:false,nativeHashApproved:false,bridgeChargeProved:false,costCoverageProved:false,wholeBudgetCoexistenceProved:false,co0Exit:false,productionAdopted:false}
};
export const R1_REGIONS=[
 ['R01','external input/core/context graphs','caller/source owner','unknown until custody/charge proof','from acquisition through last external holder'],
 ['R02','bootstrap clone, validation and canonical strings','bounded intake owner','131072 reservation is not a graph bound','entry through constructor return and escaped exceptions'],
 ['R03','standalone canonical context bytes','context owner','K bytes plus unproved wrappers/string/graph','bootstrap plus any retained holder'],
 ['R04','builder/expected packed cores and context token caches','producer children','2F allocated C; client4/provider3 floor; occupied=9472+K','construct through last borrow and drain'],
 ['R05','candidate family slabs','per-actor producer','19FW bytes, never nFW reservation','before capture through family/transport drain'],
 ['R06','S0/S1/S2','window','3*8192; S2 is a representation','per-phase exclusive leases through frame return'],
 ['R07','stream chunk and Buffer view wrappers','stream owner','4096 backing bytes plus unproved view charge','hash update and final zero'],
 ['R08','binary metadata','window','3072 bytes; 4096 whole target not an extra arena','reservation through drain'],
 ['R09','bridge, containers, handles, aliases, control arrays/closures','window/registered ports','48*8+8*32+384=1024 is a certificate candidate','module/call/scope/frame lifetimes individually'],
 ['R10','grammar/key descriptors, recursive parser frames and spans','codec/cursor owner','unproved JS/header/stack charges','module residency and parse frames'],
 ['R11','projection fragments, digit conversion, hash hex and local cursors','codec/hash owner','unproved; overlay candidate 16384','core/capture/normalize/expected/proof and failures'],
 ['R12','native hash state/allocator/stack and module capture hash','hash backend/runtime owner','unknown for R0 Node/OpenSSL backend','creation through proven deallocation, not GC assumption'],
 ['R13','existing codec, A/B roots/facts, source/call/binding/frame regions','original owners','preserve approved baseline; no duplicated 32768 credit','all concurrent owners, including initial/seal overlap'],
 ['R14','trace/stats/oracle/diagnostic export and cleanup digest copies','diagnostic owner','outside proof or explicitly reserved concurrent overhead','including constructor/cleanup overlap and persisted trace'],
 ['R15','exceptions, terminal zero/drain, late-response control','call/drain owner','maximum pre-reserved; foreign error graphs separately charged','fatal invalidation through final borrow/IO completion']
].map(([id,region,owner,capacity,lifetime])=>({id,region,owner,capacity,lifetime,runtimeChargeComplete:false}));
const sites=[
 ['bootstrap-context','gradleOwnedCwcR0.ts','const c=context(lgOwnedCopy(o.context,65536))','input nodes/strings, canonical output, graph/header charge'],
 ['bootstrap-groups','gradleOwnedCwcR0.ts','const groups=lgOwnedCopy(o.groups,65536)','group nodes/ranges and temporary graph custody'],
 ['bootstrap-reservation','gradleOwnedCwcR0.ts','this.#ctor=this.#budget.reserve(131072,4096)','initialization units have no primitive conversion proof'],
 ['private-cores','gradleOwnedCwcR0.ts','const builder=new R0Core(','allocated arenas and owner/token wrapper charge'],
 ['parser-recursion','gradleOwnedCwcR0Tokens.ts','const add=(c:number)=>','frames, closures, descriptor/key comparisons, token writes'],
 ['parser-spans','gradleOwnedCwcR0Tokens.ts','return {start,length};','small span allocation and lifetime'],
 ['field-scans','gradleOwnedCwcR0Tokens.ts','const tag=r0Key(key);for(let n=','repeated key and sibling scans, not a single linear pass'],
 ['number-encoding','gradleOwnedCwcR0Engine.ts','this.literal(String(n));','bounded digit strings plus conversion work'],
 ['native-state','gradleOwnedCwcR0Engine.ts',"nativeCreateHash('sha256')",'module and per-operation native state/stack/allocation'],
 ['native-view','gradleOwnedCwcR0Engine.ts','view=Reflect.apply(subarray,this.chunk','view wrapper, synchronous update, release evidence'],
 ['digest-encoding','gradleOwnedCwcR0Engine.ts',"Reflect.apply(nativeDigest,this.#hash,['hex'])",'digest hex string and native finalization'],
 ['diagnostic-export','gradleOwnedCwcR0.ts','const n=this.#encoded[this.#actor]![i]!,out=alloc(n)','copied row outside command budget proof'],
 ['event-recording','gradleOwnedCwcR0.ts','this.#trace.push(','per-event object/array growth and retained trace'],
 ['stats-copies','gradleOwnedCwcR0.ts','trace:this.#trace.map(','diagnostic array/object copies'],
 ['terminal-digests','gradleOwnedCwcR0.ts','this.#finalRows=this.#children.map(','row copies/native digests while families still resident'],
 ['terminal-zero','gradleOwnedCwcR0.ts','for(const b of this.#buffers)','all buffer zero and verification, not zero only once per call'],
 ['core-projection','gradleOwnedCwcR0Engine.ts','export function emitCore(','all core fields, context token scans, groups and range encoding'],
 ['operation-projection','gradleOwnedCwcR0Engine.ts','export function emitOperation(','every operation preimage and digest check'],
 ['command-encoder','gradleOwnedCwcR0Engine.ts','export function emitCommand(','whole canonical command emission and byte budget scans'],
 ['wire-projection','gradleOwnedCwcR0Engine.ts','export function emitProjection(','fixed field loops, repeated field lookup and hash preimage bytes'],
 ['literal-scanning','gradleOwnedCwcR0Engine.ts','literal(s:string)','every literal byte/char scan and transient string'],
 ['normalize-copy','gradleOwnedCwcR0.ts','Reflect.apply(copy,c.slab,[this.#slots[0]!','retained row copy to S0 and full validation'],
 ['three-way-compare','gradleOwnedCwcR0.ts','this.#slots[0]![i]===this.#slots[1]![i]','both complete byte comparisons, per ordinal and family'],
 ['metadata-row','gradleOwnedCwcR0.ts','write32(this.#metadata!,length','fixed metadata writes, ordinal state and length registry'],
 ['lease-registry','gradleOwnedCwcR0.ts','#lease(slot:number)','lease checks, slot arrays, live gates and matching release'],
 ['diagnostic-hash','gradleOwnedCwcR0Memory.ts','export function r0DiagnosticSha(','cleanup native create/update/digest and temporary row lifetime']
];
export function r1SourceAudit(){return sites.map(([id,file,anchor,quantity])=>{const path='src/test/fixtures/'+file,b=readFileSync(path),s=b.toString(),positions=[];let at=-1;while((at=s.indexOf(anchor,at+1))>=0)positions.push(s.slice(0,at).split('\n').length);need(positions.length>0,'source_anchor_'+id);
 return {id,path,anchor,lines:positions,sourceDigest:createHash('sha256').update(b).digest('hex'),quantity,coverageClass:'uncovered',originalUnitMapping:null,approvedDebit:null};});}
export function r1BufferAudit(e){need(e.schema==='cwc-r0.evidence.v1'&&e.rows.length===24,'r0_matrix');return e.rows.map(r=>{
 const s=r.before,F=r.kind==='client'?2:1,explicit=3072+4096+3*8192+F*(2*s.coreWidth+19*s.width),occupied=9472+s.contextWidth;
 need(explicit===r.after.clearedBytes&&s.liveBuffers===5+3*F&&r.after.zeroVerified&&occupied<=s.coreWidth,'r0_buffer_account');
 return {role:r.role,boundary:r.boundary,kind:r.kind,n:r.n,contextBytes:s.contextWidth,coreBytes:s.coreWidth,commandBytes:s.width,packedOccupiedBytes:occupied,
  actualCoreArenas:2*F,requiredCoreFloor:F===2?4:3,explicitRegisteredBufferBytes:explicit,logicalHeldBytes:s.budget.heldBytes,bootstrapTicketBytes:131072,
  retiredBootstrapContextBytes:s.contextWidth,wholeMemoryUpperBound:null,actualParentLedgerBinding:false,runtimeAdmitted:false};
});}
export const R1_ADDITIONS=['callerCoreBytes','callerContextBytes','bridgeExcessBytes','outsideOverlayBytes','bootstrapBytes','diagnosticBytes','otherBytes'];
/** Conditional deltas to the historical floor; null stays unknown, never silently zero. */
export function r1CapacityExample(floor,additions){need(integer(floor),'quantity');need(additions&&Object.keys(additions).sort().join(',')===[...R1_ADDITIONS].sort().join(','),'regions');
 const values=R1_ADDITIONS.map(k=>additions[k]);need(values.every(n=>n===null||integer(n)),'quantity');const lowerBound=sum([floor,...values.filter(n=>n!==null)]),unknown=R1_ADDITIONS.filter(k=>additions[k]===null),upperBound=unknown.length?null:lowerBound;
 return {limit:1048576,lowerBound,upperBound,unknown,arithmeticFits:upperBound===null?null:upperBound<=1048576,status:lowerBound>1048576?'rejected-known-lower-bound':unknown.length?'unsupported-unbounded-regions':'conditional-arithmetic-only',runtimeAdmitted:false};}
/** Work example only. No plan ticket, actual debit, or approval is produced. */
export function r1WorkExample(rows){need(Array.isArray(rows)&&rows.length>0,'ledgers');const ids=new Set();const result=rows.map(r=>{
 need(r&&Object.keys(r).sort().join(',')==='additional,limit,namespace,spent,unit','ledger_schema');
 need(R1_DESIGN.reservation.namespaces.includes(r.namespace)&&!ids.has(r.namespace),'namespace');ids.add(r.namespace);
 const limit=r.namespace==='Lb0.call'?156978:r.namespace==='provider.read-row'?1048576:67108864;
 need(r.unit==='cpr.request-bytes-ranges-probes.v1'&&[r.limit,r.spent].every(integer)&&(r.additional===null||integer(r.additional))&&r.limit>0&&r.limit<=limit,'unit_or_quantity');
 const lowerBound=sum([r.spent,...(r.additional===null?[]:[r.additional])]),total=r.additional===null?null:lowerBound;
 return {...r,lowerBound,total,arithmeticFits:lowerBound>r.limit?false:total===null?null:total<=r.limit,actualOwnerBound:false,unitCoverageApproved:false};
 });return {rows:result,arithmeticFits:result.some(r=>r.arithmeticFits===false)?false:result.some(r=>r.arithmeticFits===null)?null:true,runtimeAdmitted:false};}
