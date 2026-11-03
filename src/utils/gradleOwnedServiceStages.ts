/** C3b-0 pure stage contract. A receipt validated here is not a durability or live-grant proof. */
import {z} from 'zod';
import {cid,chash,cn,parsed,need,decodeCurrent,CURRENT_LIMITS} from './gradleOwnedCurrentSchema.js';
import {ownerPlanFacts,type OwnerPlan} from './gradleOwnedServiceOwners.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from './gradleOwnedJson.js';
export const stageTable={
 'aux.PrepareCandidate':{role:'provider',stages:['namespace-reserved','namespace-sealed']},
 'aux.MirrorSelection':{role:'provider',stages:['mirror-saved']},
 'aux.RecordUse':{role:'provider',stages:['use-saved']},
 'control.PrepareCheckpoint':{role:'checkpoint-issuer',stages:['checkpoint-prepared']},
 'control.ReadCurrentCheckpoint':{role:'checkpoint-issuer',stages:['checkpoint-synced']},
 'control.BeginEnrollment':{role:'lineage-registry',stages:['enrollment-begun']},
 'control.ActivateEnrollment':{role:'lineage-registry',stages:['selection-recorded','selection-adopted']},
 'control.PublishSelection':{role:'lineage-registry',stages:['selection-recorded','selection-adopted']},
 'control.ReserveWriter':{role:'lineage-registry',stages:['writer-reserved']},
 'control.AcquireReadPin':{role:'lineage-registry',stages:['pin-acquired']},
 'control.PrepareHandoff':{role:'lineage-registry',stages:['handoff-completing','handoff-decision-recorded']},
 'control.DeliverResult':{role:'lineage-registry',stages:['delivery-recorded']},
 'control.AcknowledgeDelivery':{role:'lineage-registry',stages:['delivery-acknowledged']},
 'control.CancelWriter':{role:'lineage-registry',stages:['writer-cancelled']},
 'control.ReleaseReadPin':{role:'lineage-registry',stages:['pin-released']},
 'control.BeginBarrier':{role:'lineage-registry',stages:['barrier-begun']},
 'control.ConfirmFenced':{role:'lineage-registry',stages:['participant-fenced']},
 'control.FinishBarrier':{role:'lineage-registry',stages:['barrier-finished']},
 'control.ResumeServing':{role:'lineage-registry',stages:['lineage-resumed']},
 'aux.AbandonEnrollment':{role:'lineage-registry',stages:['enrollment-abandoned']},
 'aux.PrepareAuthorityResult':{role:'authority-broker',stages:['result-reserved','result-prepared']},
 'internal.RevokeAuthority':{role:'authority-broker',stages:['authority-revoking','authority-revoked']},
 'internal.InvalidateBoot':{role:'lineage-registry',stages:['boot-invalidated']},
 'control.anchor.cas':{role:'control-anchor',stages:['anchor-adopted']},
} as const;
export type StageAPI=keyof typeof stageTable;
const apiSchema=z.string().refine(v=>Object.hasOwn(stageTable,v)).transform(v=>v as StageAPI);
export const stageHeadSchema=z.object({revision:cn.positive().max(CURRENT_LIMITS.records),sha256:chash}).strict();
const ref=z.object({sha256:chash,byteLength:cn.positive().max(CURRENT_LIMITS.record)}).strict();
const metadata={api:apiSchema,operationKey:chash,requestDigest:chash,stageId:cid,transitionKey:chash,transitionDigest:chash,expectedHead:stageHeadSchema.nullable(),previousStageReceipt:ref.nullable()};
export const stageCommitSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.stage-commit.v1'),...metadata,nextImage:z.string().max(12*1024*1024)}).strict();
export const stageRecordSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.stage-record.v1'),ownerId:cid,storageEpoch:chash,...metadata,nextImageDigest:chash,nextImageBytes:cn.positive().max(8*1024*1024),outcome:z.enum(['pending','committed'])}).strict();
export const stageReceiptSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.stage-receipt.v1'),record:stageRecordSchema,recordRef:ref,appliedHead:stageHeadSchema}).strict();
export type StageCommit=z.infer<typeof stageCommitSchema>;
export type StageReceipt=z.infer<typeof stageReceiptSchema>;
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
const objectRef=(value:unknown)=>{const b=Buffer.from(canonicalOwnedJson(value,CURRENT_LIMITS.record));return {sha256:ownedSha256(b),byteLength:b.length};};
export const stageReceiptRef=(receipt:StageReceipt)=>objectRef(receipt);
function transitions(plan:OwnerPlan,api:StageAPI,stageId:string){const c=ownerPlanFacts(plan),entry=stageTable[api];need(entry.role===c.role,'permission_denied');const position=(entry.stages as readonly string[]).indexOf(stageId);need(position>=0,'stage_invalid');return {config:c,position,final:position===entry.stages.length-1,stages:entry.stages as readonly string[]};}
export function stageTransitionKey(plan:OwnerPlan,operationKey:string,stageId:string){const c=ownerPlanFacts(plan);return ownedDigest({domain:'osv-mcp.q2.c3b.transition-key.v1',ownerId:c.ownerId,storageEpoch:c.storageEpoch,operationKey,stageId});}
function digest(fields:{api:StageAPI;operationKey:string;requestDigest:string;stageId:string;expectedHead:unknown;previousStageReceipt:unknown},nextImageDigest:string){return ownedDigest({domain:'osv-mcp.q2.c3b.transition.v1',api:fields.api,operationKey:fields.operationKey,requestDigest:fields.requestDigest,stageId:fields.stageId,expectedHead:fields.expectedHead,previousStageReceipt:fields.previousStageReceipt,nextImageDigest});}
export function makeStageCommit(plan:OwnerPlan,value:Omit<StageCommit,'schema'|'transitionKey'|'transitionDigest'>){
 const bytes=Buffer.from(value.nextImage,'base64');need(bytes.toString('base64')===value.nextImage,'schema_invalid');decodeCurrent(bytes,8*1024*1024);
 const request=parsed(stageCommitSchema,{schema:'osv-mcp.q2.c3b.stage-commit.v1',...value,transitionKey:stageTransitionKey(plan,value.operationKey,value.stageId),transitionDigest:digest(value,ownedSha256(bytes))});return request;
}
export function validateStageReceipt(plan:OwnerPlan,value:unknown):StageReceipt{
 const r=parsed(stageReceiptSchema,value),b=r.record,{config:c,position,final}=transitions(plan,b.api,b.stageId);
 need(b.ownerId===c.ownerId&&b.storageEpoch===c.storageEpoch&&b.transitionKey===stageTransitionKey(plan,b.operationKey,b.stageId),'binding_mismatch');
 need(b.transitionDigest===digest(b,b.nextImageDigest)&&same(r.recordRef,objectRef(b))&&r.appliedHead.revision===(b.expectedHead?.revision??0)+1,'binding_mismatch');
 need((position===0)===(b.previousStageReceipt===null)&&b.outcome===(final?'committed':'pending'),'stage_invalid');return r;
}
export function validateStageCommit(plan:OwnerPlan,value:unknown,currentHead:unknown,previous:unknown=null){
 const q=parsed(stageCommitSchema,value),{config:c,position,final,stages}=transitions(plan,q.api,q.stageId),bytes=Buffer.from(q.nextImage,'base64');need(bytes.toString('base64')===q.nextImage,'schema_invalid');decodeCurrent(bytes,8*1024*1024);
 need(q.transitionKey===stageTransitionKey(plan,q.operationKey,q.stageId)&&q.transitionDigest===digest(q,ownedSha256(bytes)),'binding_mismatch');
 need(same(q.expectedHead,parsed(stageHeadSchema.nullable(),currentHead)),'control_conflict');
 if(position===0)need(q.previousStageReceipt===null&&previous===null,'stage_invalid');else{
  const p=validateStageReceipt(plan,previous);need(p.record.api===q.api&&p.record.operationKey===q.operationKey&&p.record.requestDigest===q.requestDigest&&p.record.stageId===stages[position-1]&&same(q.previousStageReceipt,stageReceiptRef(p))&&q.expectedHead&&q.expectedHead.revision>=p.appliedHead.revision,'stage_invalid');
 }
 return parsed(stageRecordSchema,{schema:'osv-mcp.q2.c3b.stage-record.v1',ownerId:c.ownerId,storageEpoch:c.storageEpoch,...Object.fromEntries(Object.keys(metadata).map(k=>[k,(q as any)[k]])),nextImageDigest:ownedSha256(bytes),nextImageBytes:bytes.length,outcome:final?'committed':'pending'});
}
/** Derivation after a hypothetical commit. Does not perform or certify a commit. */
export function deriveStageReceipt(plan:OwnerPlan,record:unknown,appliedHead:unknown){const r=parsed(stageRecordSchema,record);return validateStageReceipt(plan,{schema:'osv-mcp.q2.c3b.stage-receipt.v1',record:r,recordRef:objectRef(r),appliedHead});}
/** Ledger-first pure resolution: saved stages never rebuild a request from the current head. */
export function resolveStageRetry(plan:OwnerPlan,target:unknown,ledger:unknown,inFlight:unknown=[]){
 const t=parsed(z.object({api:apiSchema,operationKey:chash,requestDigest:chash,stageId:cid}).strict(),target);transitions(plan,t.api,t.stageId);
 const entries=parsed(z.array(stageReceiptSchema).max(CURRENT_LIMITS.operations),ledger).map(r=>validateStageReceipt(plan,r));
 need(new Set(entries.map(r=>r.record.transitionKey)).size===entries.length,'integrity_invalid');
 for(const r of entries)if(r.record.previousStageReceipt){const p=entries.find(p=>same(stageReceiptRef(p),r.record.previousStageReceipt)),stages=stageTable[r.record.api].stages as readonly string[];need(p&&p.record.operationKey===r.record.operationKey&&p.record.requestDigest===r.record.requestDigest&&p.record.api===r.record.api&&p.record.stageId===stages[stages.indexOf(r.record.stageId)-1]&&r.record.expectedHead&&r.record.expectedHead.revision>=p.appliedHead.revision,'integrity_invalid');}
 for(const p of entries.filter(r=>r.record.operationKey===t.operationKey))need(p.record.requestDigest===t.requestDigest&&p.record.api===t.api,'idempotency_conflict');
 const saved=entries.find(r=>r.record.operationKey===t.operationKey&&r.record.stageId===t.stageId);if(saved)return {kind:'saved' as const,receipt:structuredClone(saved)};
 const pending=parsed(z.array(z.object({api:apiSchema,operationKey:chash,requestDigest:chash,stageId:cid}).strict()).max(CURRENT_LIMITS.pending),inFlight);
 for(const p of pending.filter(r=>r.operationKey===t.operationKey))need(p.requestDigest===t.requestDigest&&p.api===t.api,'idempotency_conflict');
 return {kind:pending.some(p=>same(p,t))?'in-flight' as const:'assemble' as const};
}
/** Exact retries can be resolved after later commits, without checking the old expected head as current. */
export function resolveExactStage(plan:OwnerPlan,value:unknown,ledger:unknown){const q=parsed(stageCommitSchema,value),r=resolveStageRetry(plan,{api:q.api,operationKey:q.operationKey,requestDigest:q.requestDigest,stageId:q.stageId},ledger);
 if(r.kind==='saved'){const raw=Buffer.from(q.nextImage,'base64');need(raw.toString('base64')===q.nextImage,'schema_invalid');decodeCurrent(raw,8*1024*1024);const b=r.receipt.record;need(q.transitionKey===b.transitionKey&&q.transitionDigest===b.transitionDigest&&same(q.expectedHead,b.expectedHead)&&same(q.previousStageReceipt,b.previousStageReceipt)&&ownedSha256(raw)===b.nextImageDigest&&raw.length===b.nextImageBytes,'idempotency_conflict');}return r;}
