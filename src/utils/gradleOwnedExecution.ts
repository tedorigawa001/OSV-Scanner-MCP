/** G2 metadata contract. Only the trusted caller may supply lookup/session data.
 * No receipt-store backend, owned file reader, process launcher or Provider evaluation. */
import {z} from 'zod';
import {canonicalOwnedJson,parseOwnedJson,OWNED_LIMITS} from './gradleOwnedJson.js';
import {ownedStages,stateSchema,validateState,ownedRecordSchema,type OwnedRecord,type OwnedState} from './gradleOwnedSchema.js';
const id=z.string().min(1).max(1024);
const hash=z.string().regex(/^[a-f0-9]{64}$/).refine(x=>x!=='0'.repeat(64));
const count=z.number().int().min(0).max(8);
const sequence=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const leaseKind=z.enum(['jdk','node','platform','executor','loader']);
export const ownedAuthorizationSchema=z.object({authorityId:id,jdkImageProfileDigest:hash,nodeImageProfileDigest:hash,platformProfileDigest:hash,executorProfileDigest:hash,loaderProfileDigest:hash}).strict();
export type OwnedAuthorization=z.infer<typeof ownedAuthorizationSchema>;
const scopeSchema=z.object({project:id,context:id,invocation:id,taskId:id,actionId:id,brokerInstanceId:id,plannedCaptures:count,profileDigest:hash,recipeDigest:hash}).strict();
export const ownedSessionSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-session-v1'),authorityId:id,sessionId:id,nonce:id,graphId:id,exportId:id,executionId:id,coreGraphDigest:hash,rootRegistryDigest:hash,isolationEvidenceRef:hash,status:z.enum(['current','superseded','revoked']),scopes:z.array(scopeSchema).min(1).max(2000),leases:z.array(z.object({id,kind:leaseKind,profileDigest:hash,holderId:id,status:z.enum(['active','revoked'])}).strict()).max(256)}).strict().superRefine((s,ctx)=>{
 if(new Set(s.scopes.map(x=>JSON.stringify([x.project,x.context,x.invocation]))).size!==s.scopes.length||new Set(s.leases.map(x=>x.id)).size!==s.leases.length)ctx.addIssue({code:'custom',message:'duplicate scope or lease'});
});
const witnessBinding=z.object({authorityId:id,sessionId:id,nonce:id,graphId:id,exportId:id,executionId:id,coreGraphDigest:hash,rootRegistryDigest:hash,project:id,context:id,invocation:id,profileDigest:hash,recipeDigest:hash}).strict();
const taskSchema=z.object({taskId:id,actionId:id,actionCalls:z.number().int().min(0).max(1),executed:z.boolean(),didWork:z.boolean(),skipped:z.boolean(),noSource:z.boolean(),failed:z.boolean(),skipMessage:id.nullable()}).strict();
const processSchema=z.object({record:ownedRecordSchema.refine(r=>r.kind==='process'),begin:sequence,end:sequence,leases:z.object({jdk:id.optional(),node:id.optional(),platform:id,executor:id,loader:id.optional()}).strict()}).strict();
const stageSchema=z.object({stage:z.enum(ownedStages),outcome:z.enum(['success','failed','unavailable']),begin:sequence,end:sequence,processes:z.array(processSchema).max(1024)}).strict();
export const ownedWitnessSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-execution-witness-v1'),witnessId:id,binding:witnessBinding,task:taskSchema,brokerInstanceId:id,plannedCaptures:count,captures:count,state:stateSchema,bundleDigest:hash,envelopeDigest:hash,stageExecutions:z.array(stageSchema).max(5)}).strict();
const lookupSchema=z.union([
 z.object({status:z.literal('verified'),witness:ownedWitnessSchema}).strict(),
 z.object({status:z.literal('not-executed'),binding:witnessBinding,task:taskSchema,reason:z.enum(['SKIPPED','FROM-CACHE','UP-TO-DATE','NO-SOURCE'])}).strict(),
 z.object({status:z.literal('unavailable'),reason:z.enum(['receipt-missing','backend-unsupported','session-unavailable'])}).strict(),
 z.object({status:z.literal('unavailable'),reason:z.literal('execution-aborted'),binding:witnessBinding,task:taskSchema}).strict(),
 z.object({status:z.literal('invalid'),reason:z.literal('invalid-receipt')}).strict()
]);
export const ownedLookupSchema=lookupSchema;
export const unsupportedOwnedCaller=Object.freeze({backend:'unsupported'} as const);
export type OwnedExecutionReason='execution_invalid'|'claim_mismatch'|'configuration_invalid'|'witness_unavailable'|'action_not_executed'|'execution_aborted'|'capability_unsupported';
export interface OwnedExecutionClaim {
 profileId:string;recipeId:string;
 graphId:string;exportId:string;executionId:string;coreGraphDigest:string;project:string;context:string;invocation:string;
 profileDigest:string;recipeDigest:string;witnessId:string;bundleDigest:string;envelopeDigest:string;
 plannedCaptures:number;captures:number;state:OwnedState;
 stages:{stage:typeof ownedStages[number];outcome:'success'|'failed'|'unavailable'}[];
 optionalBlockedStage?:typeof ownedStages[number];
 processes:{stage:typeof ownedStages[number];record:OwnedRecord}[];
}
export interface OwnedLookupRequest {
 readonly authorityId:string;readonly sessionId:string;readonly nonce:string;readonly rootRegistryDigest:string;
 readonly graphId:string;readonly exportId:string;readonly executionId:string;readonly coreGraphDigest:string;
 readonly project:string;readonly context:string;readonly invocation:string;readonly witnessId:string;
}
/** An application-owned adapter, never an object decoded from the transport.
 * It must be a plain object whose own properties are exactly backend, session and lookup;
 * class instances (lookup on the prototype) and extra fields are rejected as execution_invalid.
 * lookup must return synchronously; a thrown error is treated as an unavailable receipt. */
export interface TrustedOwnedCaller {
 readonly backend:'caller-owned-receipt-store-v1';readonly session:unknown;
 lookup(request:Readonly<OwnedLookupRequest>):unknown;
}
function snapshot(value:unknown):unknown {return parseOwnedJson(canonicalOwnedJson(value,OWNED_LIMITS.objectBytes),OWNED_LIMITS.objectBytes);}
function same(a:unknown,b:unknown):boolean {return canonicalOwnedJson(a)===canonicalOwnedJson(b);}
function hasKeys(value:unknown,keys:string[]):value is Record<string,unknown> {
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
}
export function inspectOwnedExecution(claim:OwnedExecutionClaim,caller:unknown,authorization:OwnedAuthorization):OwnedExecutionReason {
 try {
  if(hasKeys(caller,['backend'])&&caller.backend==='unsupported')return 'witness_unavailable';
  if(!hasKeys(caller,['backend','session','lookup'])||caller.backend!=='caller-owned-receipt-store-v1'||typeof caller.lookup!=='function')return 'execution_invalid';
  const auth=ownedAuthorizationSchema.parse(authorization),session=ownedSessionSchema.parse(snapshot(caller.session));
  // Profile and caller session disagreeing on the authority is an operator configuration error, not a producer claim.
  if(session.authorityId!==auth.authorityId)return 'configuration_invalid';
  if(session.status!=='current')return 'witness_unavailable';
  // Scope is chosen by the independent current session, never by timestamps or exported hints.
  const scope=session.scopes.find(s=>s.project===claim.project&&s.context===claim.context&&s.invocation===claim.invocation);
  if(!scope)return 'claim_mismatch';
  if(scope.profileDigest!==claim.profileDigest||scope.recipeDigest!==claim.recipeDigest)return 'claim_mismatch';
  const request=Object.freeze({authorityId:session.authorityId,sessionId:session.sessionId,nonce:session.nonce,rootRegistryDigest:session.rootRegistryDigest,graphId:session.graphId,exportId:session.exportId,executionId:session.executionId,coreGraphDigest:session.coreGraphDigest,project:scope.project,context:scope.context,invocation:scope.invocation,witnessId:claim.witnessId});
  // A failing receipt store is unavailable evidence; its message is never surfaced.
  let response:unknown;try{response=caller.lookup(request);}catch{return 'witness_unavailable';}
  const result=lookupSchema.parse(snapshot(response));
  if(result.status==='invalid')return 'execution_invalid';
  if(result.status==='unavailable'&&result.reason!=='execution-aborted')return 'witness_unavailable';
  const expectedBinding={...request,profileDigest:scope.profileDigest,recipeDigest:scope.recipeDigest};
  const {witnessId:_,...binding}=expectedBinding;
  const actualBinding=result.status==='verified'?result.witness.binding:result.binding;
  if(!same(binding,actualBinding))return 'claim_mismatch';
  const task=result.status==='verified'?result.witness.task:result.task;
  if(task.taskId!==scope.taskId||task.actionId!==scope.actionId)return 'claim_mismatch';
  if(result.status==='not-executed'){
   if(task.actionCalls!==0||task.didWork||task.failed||(!task.skipped&&!task.noSource))return 'execution_invalid';
   if((result.reason==='NO-SOURCE'?!task.noSource:task.noSource)||task.skipMessage!==result.reason)return 'execution_invalid';
   return 'action_not_executed';
  }
  if(result.status==='unavailable'){
   if(!task.failed||task.skipped||task.noSource||!task.executed||task.actionCalls!==1||task.skipMessage!==null)return 'execution_invalid';
   return 'execution_aborted';
  }
  if(task.actionCalls!==1||!task.executed||!task.didWork||task.skipped||task.noSource||task.failed||task.skipMessage!==null)return 'execution_invalid';
  // Only an executed, sealed witness requires exported IDs and the final pair to match.
  for(const key of ['graphId','exportId','executionId','coreGraphDigest'] as const)if(claim[key]!==session[key])return 'claim_mismatch';
  const w=result.witness;validateState(w.state);
  if(w.brokerInstanceId!==scope.brokerInstanceId||w.witnessId!==claim.witnessId||w.bundleDigest!==claim.bundleDigest||w.envelopeDigest!==claim.envelopeDigest||w.plannedCaptures!==scope.plannedCaptures||w.plannedCaptures!==claim.plannedCaptures||w.captures!==claim.captures||!same(w.state,claim.state))return 'claim_mismatch';
  let expectedStages=claim.stages;
  const last=w.stageExecutions.at(-1);
  if(claim.optionalBlockedStage&&last?.stage===claim.optionalBlockedStage&&last.outcome==='unavailable')expectedStages=[...expectedStages,{stage:claim.optionalBlockedStage,outcome:'unavailable'}];
  if(!same(w.stageExecutions.map(s=>({stage:s.stage,outcome:s.outcome})),expectedStages))return 'claim_mismatch';
  const observed:{stage:typeof ownedStages[number];record:OwnedRecord}[]=[];
  let previous=0;
  for(const stage of w.stageExecutions){
   if(stage.begin<=previous||stage.end<=stage.begin)return 'execution_invalid';previous=stage.end;let end=stage.begin;
   for(const process of stage.processes){
    if(process.begin<=end||process.end<=process.begin||process.end>=stage.end)return 'execution_invalid';end=process.end;
    const r=process.record;if(r.kind!=='process')return 'execution_invalid';
    if(!process.leases.node||!process.leases.jdk||(['jvm-start','snapshot-generator','bta-call'].includes(r.operation)&&!process.leases.loader))return 'execution_invalid';
    for(const [kind,leaseId] of Object.entries(process.leases)){
     const lease=session.leases.find(l=>l.id===leaseId);
     const pin=({jdk:auth.jdkImageProfileDigest,node:auth.nodeImageProfileDigest,platform:auth.platformProfileDigest,executor:auth.executorProfileDigest,loader:auth.loaderProfileDigest} as Record<string,string>)[kind];
     if(!lease||lease.status!=='active')return 'witness_unavailable';
     const holder=kind==='jdk'||kind==='loader'?r.instanceId:scope.brokerInstanceId;
     if(lease.kind!==kind||lease.profileDigest!==pin||lease.holderId!==holder)return 'claim_mismatch';
    }
    observed.push({stage:stage.stage,record:r});
   }
  }
  if(!same(observed,claim.processes))return 'claim_mismatch';
  // G2 proves only correspondence to caller-supplied authority data. G3/G4 remain closed.
  return 'capability_unsupported';
 }catch{return 'execution_invalid';}
}
