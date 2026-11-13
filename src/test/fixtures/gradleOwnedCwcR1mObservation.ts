/** Fresh finite observations, with a separate canonical oracle for the R1-O view-byte split. No heap profiling. */
import {createHash} from 'node:crypto';
import {r0Matrix} from './gradleOwnedCwcR0Fixture.js';
import {r1oSuccess,r1oReviewMatrix} from './gradleOwnedCwcR1oFixture.js';
import {cprFixture} from './gradleOwnedCprAFixture.js';
import {capacityContext} from './gradleOwnedCwcLgCapacity.mjs';
import {planCore} from './gradleOwnedCprAPlanner.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {R0_CONTEXT,R0_COMMAND,R0_KEYS,type R0Spec} from './gradleOwnedCwcR0Grammar.js';
import {r1mR0Bytes} from './gradleOwnedCwcR1mLedger.mjs';
import {R1oRuntime,type R1oActor} from './gradleOwnedCwcR1o.js';
const sha=(x:string)=>createHash('sha256').update(x).digest('hex');
/** Reachability witness, not WeakRef/GC or a universal capture-graph size bound. */
export function r1mHookRetentionProbe(actor:R1oActor='provider'){
 let calls=0,observedViewBytes=0,byte=-1,contextMarker='',coreMarker='';
 const r=(()=>{const captured={context:{marker:'captured-context'},core:{marker:'captured-core'},payload:Buffer.alloc(2097152,7)};
  return new R1oRuntime({hook:()=>{calls++;observedViewBytes=captured.payload.length;byte=captured.payload[0]!;contextMarker=captured.context.marker;coreMarker=captured.core.marker;}});
 })();
 const execute=()=>{const call=r.createCall(actor),s=r.registerOwnedIntake(call,'source'),d=r.registerOwnedIntake(call,'destination');r.reserveDiagnostic(call);const w=r.constructOwnedState(call,s);r.moveOwnedState(call,w,d);r.publishOwnedWindow(call);r.close(call);return {call,stats:r.stats(call)};};
 const first=execute(),firstCalls=calls,firstObservation={observedViewBytes,byte,contextMarker,coreMarker};
 const second=execute(),select=(s:ReturnType<R1oRuntime['stats']>)=>({privateBuffers:s.privateBuffers,heldBytes:s.budget.heldBytes,zeroedBytes:s.zeroedBytes,publications:s.publications,released:s.released});
 return {actor,firstDrain:select(first.stats),secondDrain:select(second.stats),firstCalls,totalCalls:calls,callsAfterFirstDrain:calls-firstCalls,
  firstObservation,secondObservation:{observedViewBytes,byte,contextMarker,coreMarker},distinctCalls:first.call!==second.call,
  capturePath:'runtime.#hook -> [[Environment]] -> captured.context/core/payload',captureReleasedAtCallDrain:false,captureUpperBytes:null,physicalHeapUpperBytes:null,
  scope:{reachabilityWitness:true,rawGraphExported:false,gcMeasured:false,captureLayoutApproved:false,runtimeAdmitted:false}};
}
function oracle(role:'reader'|'authority-broker',boundary:string,workload:'small'|'stress'){
 const f=cprFixture({role,sizes:workload==='small'?[1,1,1,1,1]:[1,1,1,1,8288,8288,8288,8288,8304]});f.ctx.registryDigest=hash({schema:'r1o.synthetic-registry.v1'});const ctx=capacityContext(f.ctx,role,boundary);
 const range=(e:typeof f.entries[number],offset:number,length:number,ordinal=0)=>({ordinal,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
 const groups=[f.entries.slice(0,4).map((e,i)=>range(e,0,e.byteLength,i))];for(let i=4;i<f.entries.length;i++){const e=f.entries[i]!,parts=workload==='small'?1:i<7?4:3;let at=0;for(let j=0;j<parts;j++){const n=Math.ceil((e.byteLength-at)/(parts-j));groups.push([range(e,at,n)]);at+=n;}}
 const c=canonical(ctx),p=canonical(planCore(ctx,'r1o-seed','r1o-transfer',groups));return {contextViewBytes:Buffer.byteLength(c),coreViewBytes:Buffer.byteLength(p),contextDigest:sha(c),coreDigest:sha(p)};
}
export async function r1mObserve(){
 const r0=r0Matrix().rows.map(row=>{const s=row.before,z=row.after,formula=r1mR0Bytes({F:row.kind==='client'?2:1,K:s.contextWidth,C:s.coreWidth,W:s.width,n:row.n});
  if(row.error||formula.dedicatedRegisteredViewBytes!==z.clearedBytes||!z.zeroVerified)throw Error('r1m_r0_observation');
  return {role:row.role,boundary:row.boundary,workload:row.workload,kind:row.kind,n:row.n,formula,registeredBuffers:s.liveBuffers,
   zeroedDedicatedViewBytes:z.clearedBytes,zeroVerified:z.zeroVerified,managedBuffersAfterDrain:z.liveBuffers,logicalHeldBytes:s.budget.heldBytes,
   traceRowsBeforeDrain:s.trace.length,traceRowsAfterDrain:z.trace.length,retainedFinalDigestCount:z.finalRows.reduce((n,rs)=>n+rs.length,0),physicalHeapUpperBytes:null};
 });
 const r1o=[];for(const role of ['reader','authority-broker'] as const)for(const boundary of ['normal','registered-maximum','schema-upper'])for(const workload of ['small','stress'] as const)for(const actor of ['provider','client-initial','client-seal'] as const){
  const measured=r1oSuccess({role,boundary,workload,actor}),split=oracle(role,boundary,workload),a=measured.waiting,p=measured.published,z=measured.drained;
  if(split.contextDigest!==measured.before.context||split.coreDigest!==measured.before.core||split.contextViewBytes+split.coreViewBytes!==p.allocatedBytes||z.zeroedBytes!==p.allocatedBytes)throw Error('r1m_r1o_split');
  r1o.push({role,boundary,workload,actor,...split,splitEvidence:'independent recipe/digests plus actual aggregate buffer counters',allocatedViewBytes:p.allocatedBytes,zeroedViewBytes:z.zeroedBytes,
   actualBufferAllocations:p.bufferAllocations,sameStore:p.sameStore,sameMemoryLease:p.sameLease,directBorrowBufferFields:a.borrowReferences,
   borrowUsesPinnedStore:a.borrowUsesPinnedStore,sourceHolderRemoved:p.sourceRemoved,managedBuffersAfterDrain:z.privateBuffers,heldAfterDrain:z.budget.heldBytes,
   traceRowsAfterDrain:z.trace.length,handlesReportedAfterDrain:z.handleCapacity,boundDigestsRetained:z.contextDigest!==null&&z.coreDigest!==null,
   runtimeRegistryDeletionProved:false,physicalHeapUpperBytes:null});
 }
 const review=await r1oReviewMatrix(),pending=review.asyncCallbacks.map(r=>({actor:r.actor,site:r.site,outcome:r.outcome,pending:r.waiting.pendingCallbacks,
  pendingBuffers:r.waiting.privateBuffers,pendingMemoryBytes:r.waiting.budget.heldBytes,pendingZeroBytes:r.waiting.zeroedBytes,
  closePendingMemoryBytes:r.closed.budget.heldBytes,afterPending:r.after.pendingCallbacks,afterBuffers:r.after.privateBuffers,afterMemoryBytes:r.after.budget.heldBytes,
  afterZeroBytes:r.after.zeroedBytes,initialization:r.after.budget.initialization,work:r.after.budget.work,publications:r.after.publications,forcedReleaseTimeUpperMs:null}));
 const seen=new Set<R0Spec>();let tuples=0;function walk(s:R0Spec){if(seen.has(s))return;seen.add(s);for(const f of s.fields??[]){tuples++;walk(f[1]);}if(s.item)walk(s.item);}walk(R0_CONTEXT);walk(R0_COMMAND);
 const pooled=Buffer.from('x'),dedicated=Buffer.alloc(1);const bufferProbe={viewBytes:pooled.length,pooledBackingBytes:pooled.buffer.byteLength,poolSize:Buffer.poolSize,
  dedicatedViewBytes:dedicated.length,dedicatedBackingBytes:dedicated.buffer.byteLength,allocatorExtentUpperProved:false,probeOnly:true};dedicated.fill(0);pooled.fill(0);
 const hookRetention=(['provider','client-initial','client-seal'] as const).map(actor=>r1mHookRetentionProbe(actor));
 return {schema:'cwc-r1m.observation.v1',r0,r1o,pending,hookRetention,grammar:{reachableDescriptors:seen.size,fieldTuples:tuples,keyNames:R0_KEYS.length,representationUpperBytes:null},bufferProbe,
  scope:{finiteOnly:true,sameProcess:true,fixedClock:true,heapMeasured:false,nativeDeallocationObserved:false,fullReferenceGraphObserved:false,workUnitsProved:false,actualSession:false,productionAdopted:false}};
}
