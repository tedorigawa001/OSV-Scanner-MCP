/** C3a data-only auxiliary wire contract. No IO, live grants or admission. */
import {verify, type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {CURRENT_LIMITS,cid,chash,cn,cref,currentBindingSchema,currentNamespaceSchema,currentHeadSchema,selectionSchema,parsed,need,decodeCurrent,type CurrentBinding,type CurrentRole} from './gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from './gradleOwnedJson.js';

const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
export const auxiliaryAPIs=['ReadContext','ResolveNamespace','ReadSealedSource','PrepareCandidate','MirrorSelection','PrepareAuthorityResult','RecordUse','AbandonEnrollment'] as const;
export type AuxiliaryAPI=typeof auxiliaryAPIs[number];
/** The lineage fields a grant pins. A context read binds only these and observes the mutable rest. */
const lineageKeys=['authorityId','lineageId','generation','storeEpoch','enrollmentDigest','profileDigest'] as const;
export const currentLineageSchema=z.object({authorityId:cid,lineageId:cid,generation:cn.positive(),storeEpoch:chash,enrollmentDigest:chash,profileDigest:chash}).strict();
export type CurrentLineage=z.infer<typeof currentLineageSchema>;
const contextFloor=z.object({controlRevision:cn,selectionRevision:cn,revocationEpoch:cn}).strict();
const content=z.object({sha256:chash,byteLength:cn.positive().max(8*1024*1024)}).strict();
const baseEvidence={snapshot:cref('snapshot'),namespace:currentNamespaceSchema,inventoryDigest:chash,head:currentHeadSchema};
const genesis=z.object({...baseEvidence,mode:z.literal('candidate-genesis'),fence:cref('provision')}).strict();
const advance=z.object({...baseEvidence,mode:z.literal('candidate-advance'),fence:cref('writer-fence'),expectedSelection:cn.positive(),previousCheckpoint:cref('checkpoint-prepare')}).strict();
export const selectedEvidence=z.object({...baseEvidence,mode:z.literal('selected'),pin:cref('read-pin'),selected:selectionSchema}).strict();
export const namespaceEvidence=z.discriminatedUnion('mode',[genesis,advance,selectedEvidence]);
export type NamespaceEvidence=z.infer<typeof namespaceEvidence>;
const candidate=z.discriminatedUnion('mode',[
 z.object({mode:z.literal('candidate-genesis'),fence:cref('provision'),input:content}).strict(),
 z.object({mode:z.literal('candidate-advance'),fence:cref('writer-fence'),expectedSelection:cn.positive(),previousCheckpoint:cref('checkpoint-prepare'),input:content}).strict(),
]);
const scope=z.object({sessionId:cid,project:cid,context:cid,invocation:cid,consumerId:cid,scanRunId:cid,projectRootId:cid,manifestDigest:chash,coreGraphDigest:chash,operationBinding:chash}).strict();
const resultBinding={evidence:selectedEvidence,witness:cref('checkpoint-witness'),scope,useId:cid,result:content};
export const auxiliaryPayloads:Record<AuxiliaryAPI,z.ZodType<any>>={
 ReadContext:z.object({purpose:z.enum(['read','publication','maintenance']),floor:contextFloor.nullable()}).strict(),
 ResolveNamespace:z.object({evidence:namespaceEvidence}).strict(),
 ReadSealedSource:z.object({evidence:selectedEvidence,transferId:cid,entry:content,offset:cn,maxBytes:cn.positive().max(4096)}).strict(),
 PrepareCandidate:candidate,
 MirrorSelection:z.object({evidence:selectedEvidence}).strict(),
 PrepareAuthorityResult:z.object({...resultBinding,input:content}).strict(),
 RecordUse:z.object({...resultBinding,delivery:cref('delivery'),receiptDigest:chash,completeDigest:chash}).strict(),
 AbandonEnrollment:z.object({provision:cref('provision'),beginOperationId:cid,beginRequestDigest:chash,registryIncarnation:chash}).strict(),
};
export const auxiliaryPolicy:Record<AuxiliaryAPI,{destination:'registry'|'provider'|'authority';roles:readonly CurrentRole[];permission:string}>={
 ReadContext:{destination:'registry',roles:['reader','writer','operator'],permission:'context.read'},
 ResolveNamespace:{destination:'provider',roles:['provider','checkpoint-issuer'],permission:'namespace.resolve'},
 ReadSealedSource:{destination:'provider',roles:['reader'],permission:'source.read-pinned'},
 PrepareCandidate:{destination:'provider',roles:['writer','operator'],permission:'source.stage'},
 MirrorSelection:{destination:'provider',roles:['reader'],permission:'selection.mirror'},
 PrepareAuthorityResult:{destination:'authority',roles:['reader'],permission:'authority.prepare-result'},
 RecordUse:{destination:'provider',roles:['authority-broker'],permission:'use.record'},
 AbandonEnrollment:{destination:'registry',roles:['operator'],permission:'enrollment.abandon'},
};
const peer=z.object({credentialId:cid,role:z.enum(['operator','manager','writer','provider','checkpoint-issuer','lineage-registry','control-anchor','authority-broker','reader']),instanceId:cid,boot:chash,keyEpoch:cn.positive()}).strict();
export const auxiliaryRequestSchema=z.object({schema:z.literal('osv-mcp.q2.current-aux.request.v1'),api:z.enum(auxiliaryAPIs),destination:z.enum(['registry','provider','authority']),
 peer,server:peer,deploymentDigest:chash,binding:z.unknown(),operationId:cid,requestId:chash,challenge:chash,sequence:cn.positive(),requestDigest:chash,payload:z.unknown()}).strict();
export type AuxiliaryRequest=Omit<z.infer<typeof auxiliaryRequestSchema>,'binding'>&{binding:CurrentBinding|CurrentLineage};
export function auxiliaryIntent(r:Omit<AuxiliaryRequest,'requestDigest'>|AuxiliaryRequest){return ownedDigest({domain:'osv-mcp.q2.current-aux.intent.v1',api:r.api,destination:r.destination,peer:r.peer,server:r.server,deploymentDigest:r.deploymentDigest,binding:r.binding,operationId:r.operationId,payload:r.payload});}
export const auxiliaryGrantSchema=z.object({peer,server:peer,deploymentDigest:chash,authorityId:cid,lineageId:cid,generation:cn.positive(),storeEpoch:chash,enrollmentDigest:chash,profileDigest:chash,api:z.enum(auxiliaryAPIs),permission:cid,
 payloadDigest:chash,purpose:z.enum(['read','publication','maintenance','checkpoint','handoff','enrollment']),target:cref('read-pin').or(cref('provision')).or(cref('writer-fence')).nullable(),snapshot:cref('snapshot').nullable(),operationBinding:chash.nullable()}).strict();
export type AuxiliaryGrant=z.infer<typeof auxiliaryGrantSchema>;
const roleForServer={registry:'lineage-registry',provider:'provider',authority:'authority-broker'} as const;

function checkEvidence(e:NamespaceEvidence,b:z.infer<typeof currentBindingSchema>){
 if(e.mode==='selected')need(b.mode==='serving'&&same(e.selected,b.selected)&&same(e.snapshot,e.selected.snapshot)&&same(e.head,e.selected.head),'binding_mismatch');
 else if(e.mode==='candidate-genesis')need(b.mode==='provision','binding_mismatch');
 else need(b.mode==='serving'&&e.expectedSelection===b.selectionRevision&&same(e.previousCheckpoint,b.selected.checkpoint),'binding_mismatch');
}
/** Checks static permission and exact delegation scope; does not claim the fence is live. */
export function validateAuxiliaryRequest(value:unknown,grantValue:unknown){
 const raw=parsed(auxiliaryRequestSchema,value),g=parsed(auxiliaryGrantSchema,grantValue),policy=auxiliaryPolicy[raw.api];
 const r:AuxiliaryRequest={...raw,binding:raw.api==='ReadContext'?parsed(currentLineageSchema,raw.binding):parsed(currentBindingSchema,raw.binding)};r.payload=parsed(auxiliaryPayloads[r.api],r.payload);
 need(policy.roles.includes(r.peer.role)&&r.destination===policy.destination&&r.server.role===roleForServer[policy.destination],'permission_denied');
 need(g.api===r.api&&g.permission===policy.permission&&same(g.peer,r.peer)&&same(g.server,r.server)&&g.deploymentDigest===r.deploymentDigest,'permission_denied');
 for(const key of lineageKeys)need(g[key]===r.binding[key],'binding_mismatch');
 need(r.requestDigest===auxiliaryIntent(r)&&g.payloadDigest===ownedDigest(r.payload),'binding_mismatch');
 const p:any=r.payload,e=p.evidence as NamespaceEvidence|undefined,b=r.binding as CurrentBinding;
 if(e){checkEvidence(e,b);need(same(g.snapshot,e.snapshot)&&same(g.target,e.mode==='selected'?e.pin:e.fence),'permission_denied');}
 if(r.api==='ReadContext')need(g.purpose===p.purpose&&g.target===null&&g.snapshot===null&&g.operationBinding===null,'permission_denied');
 if(r.api==='ResolveNamespace')need(g.purpose===(e!.mode==='selected'?'read':'checkpoint'),'permission_denied');
 if(r.api==='ReadSealedSource'){need(g.purpose==='read'&&p.offset<p.entry.byteLength&&p.maxBytes<=p.entry.byteLength-p.offset,'binding_mismatch');}
 if(r.api==='PrepareCandidate'){
  need(g.purpose==='publication'&&same(g.target,p.fence)&&g.snapshot===null&&((p.mode==='candidate-genesis'&&r.peer.role==='operator')||(p.mode==='candidate-advance'&&r.peer.role==='writer')),'permission_denied');
  if(p.mode==='candidate-genesis')need(b.mode==='provision','binding_mismatch');
  else need(b.mode==='serving'&&p.expectedSelection===b.selectionRevision&&same(p.previousCheckpoint,b.selected.checkpoint),'binding_mismatch');
 }
 if(r.api==='MirrorSelection')need(g.purpose==='maintenance','permission_denied');
 // Static scope only: whether the provision has expired and has no undecided activation is a registry runtime check.
 if(r.api==='AbandonEnrollment')need(g.purpose==='enrollment'&&same(g.target,p.provision)&&g.snapshot===null&&g.operationBinding===null&&b.mode==='provision'&&p.registryIncarnation===b.registryIncarnation,'permission_denied');
 if(r.api==='PrepareAuthorityResult'||r.api==='RecordUse')need(g.purpose==='handoff'&&g.operationBinding===p.scope.operationBinding,'permission_denied');
 return r;
}

export const auxiliaryValues:Record<AuxiliaryAPI,z.ZodType<any>>={
 ReadContext:z.object({binding:currentBindingSchema,controlRevision:cn,record:cref('registry-record').nullable(),anchorRevision:cn,anchorRecord:cref('registry-record').nullable()}).strict(),
 ResolveNamespace:namespaceEvidence,
 ReadSealedSource:z.object({transferId:cid,entry:content,offset:cn,totalBytes:cn.positive().max(8*1024*1024),bytes:z.string().max(5500),sha256:chash}).strict(),
 PrepareCandidate:namespaceEvidence,
 MirrorSelection:z.object({evidence:selectedEvidence,mirrorDigest:chash}).strict(),
 PrepareAuthorityResult:z.object({pin:cref('read-pin'),useId:cid,result:content,gate:cref('authority-gate'),candidate:cref('candidate-result'),terminalDigest:chash}).strict(),
 RecordUse:z.object({pin:cref('read-pin'),useId:cid,delivery:cref('delivery'),result:content,receiptDigest:chash,completeDigest:chash,savedReceipt:content}).strict(),
 AbandonEnrollment:z.object({provision:cref('provision'),retiredRecord:cref('registry-record'),controlRevision:cn.positive(),phase:z.literal('uninitialized')}).strict(),
};
const replySchema=z.object({schema:z.literal('osv-mcp.q2.current-aux.reply.v1'),requestWireDigest:chash,requestDigest:chash,requestId:chash,challenge:chash,sequence:cn.positive(),peer,server:peer,api:z.enum(auxiliaryAPIs),destination:z.enum(['registry','provider','authority']),deploymentDigest:chash,value:z.unknown(),backendEligible:z.literal(false),profileApproved:z.literal(false),independentRegistryVerified:z.literal(false),originalReadsSkipped:z.literal(0)}).strict();
const wire=z.object({schema:z.literal('osv-mcp.q2.current-aux.envelope.v1'),direction:z.enum(['request','reply']),keyId:cid,body:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export interface AuxiliaryPin {keyId:string;publicKey:KeyObject;identity:z.infer<typeof peer>;direction:'request'|'reply'}
function authenticate(bytes:Buffer,direction:'request'|'reply',pin:AuxiliaryPin){
 parsed(peer,pin.identity);need(pin.direction===direction,'peer_mismatch');
 const e=parsed(wire,decodeCurrent(bytes));need(e.direction===direction&&e.keyId===pin.keyId&&pin.publicKey.type==='public'&&pin.publicKey.asymmetricKeyType==='ed25519','peer_mismatch');
 const signature=Buffer.from(e.signature,'base64');need(signature.toString('base64')===e.signature&&verify(null,Buffer.from(canonicalOwnedJson({domain:e.schema,direction,keyId:e.keyId,body:e.body})),pin.publicKey,signature),'signature_invalid');return e.body;
}
export function verifyAuxiliaryRequest(bytes:Buffer,pin:AuxiliaryPin,grant:unknown){const r=validateAuxiliaryRequest(authenticate(bytes,'request',pin),grant);need(same(r.peer,pin.identity),'peer_mismatch');return r;}
/** Verifies a response against the exact accepted request. No historical token becomes live. */
export function verifyAuxiliaryReply(bytes:Buffer,pin:AuxiliaryPin,requestBytes:Buffer,r:AuxiliaryRequest){
 const v=parsed(replySchema,authenticate(bytes,'reply',pin));need(same(v.server,pin.identity),'peer_mismatch');
 need(v.requestWireDigest===ownedSha256(requestBytes)&&v.requestDigest===r.requestDigest,'binding_mismatch');
 for(const key of ['requestId','challenge','sequence','api','destination','deploymentDigest'] as const)need(v[key]===r[key],'binding_mismatch');
 need(same(v.peer,r.peer)&&same(v.server,r.server),'binding_mismatch');v.value=parsed(auxiliaryValues[r.api],v.value);const p:any=parsed(auxiliaryPayloads[r.api],r.payload),x:any=v.value;
 if(r.api==='ReadContext'){
  need(lineageKeys.every(k=>x.binding[k]===(r.binding as CurrentLineage)[k])&&x.controlRevision===x.anchorRevision&&same(x.record,x.anchorRecord)&&(x.controlRevision===0)===(x.record===null),'binding_mismatch');
  // The mutable context is observed, never pinned by the caller; an optional floor refuses a rolled-back view.
  if(p.floor)need(x.controlRevision>=p.floor.controlRevision&&x.binding.selectionRevision>=p.floor.selectionRevision&&x.binding.revocationEpoch>=p.floor.revocationEpoch,'binding_mismatch');
 }
 if(r.api==='ResolveNamespace')need(same(x,p.evidence),'binding_mismatch');
 if(r.api==='PrepareCandidate'){checkEvidence(x,r.binding as CurrentBinding);need(x.mode===p.mode&&same(x.fence,p.fence),'binding_mismatch');if(p.mode==='candidate-advance')need(x.expectedSelection===p.expectedSelection&&same(x.previousCheckpoint,p.previousCheckpoint),'binding_mismatch');}
 if(r.api==='ReadSealedSource'){
  const raw=Buffer.from(x.bytes,'base64');need(raw.toString('base64')===x.bytes&&raw.length===p.maxBytes&&x.sha256===ownedSha256(raw)&&x.transferId===p.transferId&&same(x.entry,p.entry)&&x.offset===p.offset&&x.totalBytes===p.entry.byteLength,'binding_mismatch');
 }
 if(r.api==='MirrorSelection')need(same(x.evidence,p.evidence),'binding_mismatch');
 if(r.api==='PrepareAuthorityResult'||r.api==='RecordUse')need(same(x.pin,p.evidence.pin)&&x.useId===p.useId&&same(x.result,p.result),'binding_mismatch');
 if(r.api==='RecordUse')need(same(x.delivery,p.delivery)&&x.receiptDigest===p.receiptDigest&&x.completeDigest===p.completeDigest,'binding_mismatch');
 if(r.api==='AbandonEnrollment')need(same(x.provision,p.provision),'binding_mismatch');
 return v;
}

/** One non-renewable read pin must cover every read phase. Fixed in the profile before any run. */
export const readBudgetPhases=['context','pin','checkpoint','transfer','verify','handoff','delivery','use','ack'] as const;
export const readBudgetSchema=z.object({schema:z.literal('osv-mcp.q2.c3a.read-budget.v1'),leaseMs:z.literal(CURRENT_LIMITS.lease),marginMs:cn.positive(),
 closureBytes:cn.positive().max(CURRENT_LIMITS.closure),minTransferBytesPerSecond:cn.positive(),minVerifyBytesPerSecond:cn.positive(),
 phases:z.object(Object.fromEntries(readBudgetPhases.map(k=>[k,cn.positive()])) as Record<typeof readBudgetPhases[number],typeof cn>).strict()}).strict();
export type ReadBudget=z.infer<typeof readBudgetSchema>;
export function validateReadBudget(value:unknown){
 const b=parsed(readBudgetSchema,value),total=readBudgetPhases.reduce((n,k)=>n+b.phases[k],0);
 need(b.marginMs*10>=b.leaseMs&&total+b.marginMs<=b.leaseMs,'budget_exceeded');
 // The declared transfer/verify time must cover the profile closure at the declared minimum rates.
 need(b.phases.transfer*b.minTransferBytesPerSecond>=b.closureBytes*1000&&b.phases.verify*b.minVerifyBytesPerSecond>=b.closureBytes*1000,'budget_exceeded');
 return b;
}
/** Refuses an over-budget closure before any pin or source IO; never extends or re-acquires a pin. */
export function admitReadClosure(budget:ReadBudget,closureBytes:number){need(Number.isSafeInteger(closureBytes)&&closureBytes>0&&closureBytes<=budget.closureBytes,'budget_exceeded');}
