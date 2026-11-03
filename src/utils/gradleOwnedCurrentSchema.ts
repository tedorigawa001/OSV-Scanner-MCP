/** Shared bounded currentness contract. No transport, principal provisioning or native admission. */
import {z} from 'zod';
import {canonicalOwnedJson,ownedDigest,parseOwnedJson} from './gradleOwnedJson.js';
export const CURRENT_LIMITS=Object.freeze({frame:16384,record:65536,closure:64*1024*1024,pins:16,retainedPins:64,operations:64,prepares:8,records:256,objects:1024,requests:256,pending:64,peerPending:16,lease:5000});
export class CurrentControlError extends Error{constructor(readonly reason:string){super('current_control_'+reason);}}
export function need(ok:unknown,reason:string):asserts ok{if(!ok)throw new CurrentControlError(reason);}
export function parsed<T>(schema:z.ZodType<T>,value:unknown):T{try{return schema.parse(value);}catch{throw new CurrentControlError('schema_invalid');}}
export const cid=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),chash=z.string().regex(/^[a-f0-9]{64}$/),cn=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const currentRoles=['operator','manager','writer','provider','checkpoint-issuer','lineage-registry','control-anchor','authority-broker','reader'] as const;
export type CurrentRole=typeof currentRoles[number];
export const registryAPIs=['BeginEnrollment','ActivateEnrollment','ReserveWriter','PrepareCheckpoint','ReadForCheckpoint','PublishSelection','AcquireReadPin','ReadCurrentCheckpoint','CheckLiveBinding','PrepareHandoff','DeliverResult','AcknowledgeDelivery','BeginBarrier','ConfirmFenced','FinishBarrier','ResumeServing','QueryOperation','CancelWriter','ReleaseReadPin'] as const;
export const anchorAPIs=['anchor.read','anchor.cas','anchor.query-operation'] as const;
export const currentAPIs=[...registryAPIs,...anchorAPIs] as const;
export type CurrentAPI=typeof currentAPIs[number];
export const destinations=['registry','issuer','provider','anchor'] as const;
export type Destination=typeof destinations[number];
export const refRoles=['snapshot','provision','writer-fence','checkpoint-prepare','read-pin','checkpoint-witness','authority-gate','candidate-result','delivery','barrier','fence-evidence','registry-record','semantic-result'] as const;
export const currentRefSchema=z.object({role:z.enum(refRoles),id:cid,sha256:chash,byteLength:cn.positive().max(CURRENT_LIMITS.record)}).strict();
export type CurrentRef=z.infer<typeof currentRefSchema>;
export const cref=(role:typeof refRoles[number])=>currentRefSchema.extend({role:z.literal(role)});
export const currentHeadSchema=z.object({format:z.literal('v2'),revision:cn.positive().max(256),commitDigest:chash,stateRoot:chash,baseDigest:chash}).strict();
export type CurrentHead=z.infer<typeof currentHeadSchema>;
export const selectionSchema=z.object({snapshot:cref('snapshot'),checkpoint:cref('checkpoint-prepare'),head:currentHeadSchema}).strict();
const context={authorityId:cid,lineageId:cid,generation:cn.positive(),storeEpoch:chash,format:z.enum(['v1','v2']),storeRootId:cid,checkpointRootId:cid,rootPairId:cid,storageInstanceId:cid,
 providerBoot:chash,namespaceGeneration:cn,writerFence:cn,registryIncarnation:chash,selectionRevision:cn,revocationEpoch:cn,
 checkpointIssuer:cid,checkpointKeyEpoch:cn.positive(),enrollmentDigest:chash,schemaDigest:chash,parserDigest:chash,policyDigest:chash,profileDigest:chash};
export const currentBindingSchema=z.discriminatedUnion('mode',[
 z.object({...context,mode:z.literal('provision'),selected:z.null()}).strict(),
 z.object({...context,mode:z.literal('serving'),selected:selectionSchema}).strict(),
]);
export type CurrentBinding=z.infer<typeof currentBindingSchema>;
export const barrierReasons=['revoke','freeze','cutover','gc','restart','rotation'] as const;
export const payloadSchemas:Record<CurrentAPI,z.ZodType<any>>={
 BeginEnrollment:z.object({approvedBase:chash}).strict(),
 ActivateEnrollment:z.object({provision:cref('provision'),checkpoint:cref('checkpoint-prepare')}).strict(),
 ReserveWriter:z.object({expectedSelection:cn}).strict(),
 PrepareCheckpoint:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('genesis'),fence:cref('provision'),snapshot:cref('snapshot')}).strict(),
  z.object({mode:z.literal('advance'),fence:cref('writer-fence'),snapshot:cref('snapshot')}).strict()]),
 ReadForCheckpoint:z.object({fence:z.union([cref('provision'),cref('writer-fence')]),snapshot:cref('snapshot'),kind:z.enum(['commit','payload']),index:cn.max(8191),offset:cn,maxBytes:cn.positive().max(4096)}).strict(),
 PublishSelection:z.object({fence:cref('writer-fence'),checkpoint:cref('checkpoint-prepare')}).strict(),
 AcquireReadPin:z.object({operationBinding:chash}).strict(),
 ReadCurrentCheckpoint:z.object({pin:cref('read-pin'),checkpoint:cref('checkpoint-prepare')}).strict(),
 CheckLiveBinding:z.object({target:z.union([cref('read-pin'),cref('writer-fence'),cref('provision')]),purpose:z.enum(['checkpoint','handoff','source-read'])}).strict(),
 PrepareHandoff:z.object({pin:cref('read-pin'),witness:cref('checkpoint-witness'),gate:cref('authority-gate'),result:cref('candidate-result'),useId:cid}).strict(),
 DeliverResult:z.object({pin:cref('read-pin'),useId:cid}).strict(),
 AcknowledgeDelivery:z.object({pin:cref('read-pin'),delivery:cref('delivery'),effect:cref('fence-evidence').nullable()}).strict(),
 BeginBarrier:z.object({reason:z.enum(barrierReasons),participants:z.array(cid).max(32)}).strict(),
 ConfirmFenced:z.object({barrier:cref('barrier'),evidence:cref('fence-evidence')}).strict(),
 FinishBarrier:z.object({barrier:cref('barrier')}).strict(),
 ResumeServing:z.object({barrier:cref('barrier')}).strict(),
 QueryOperation:z.object({originalAPI:z.enum(registryAPIs),operationId:cid,originalRequestDigest:chash}).strict(),
 CancelWriter:z.object({fence:cref('writer-fence')}).strict(),
 ReleaseReadPin:z.object({pin:cref('read-pin')}).strict(),
 'anchor.read':z.object({}).strict(),
 'anchor.cas':z.object({expected:cref('registry-record').nullable(),next:cref('registry-record'),attemptId:chash}).strict(),
 'anchor.query-operation':z.object({attemptId:chash}).strict(),
};
export const apiPolicy:Record<CurrentAPI,{destination:Destination;roles:readonly CurrentRole[];permission:string}>={
 BeginEnrollment:{destination:'registry',roles:['operator'],permission:'enrollment.begin'},ActivateEnrollment:{destination:'registry',roles:['operator'],permission:'enrollment.activate'},
 ReserveWriter:{destination:'registry',roles:['writer'],permission:'writer.reserve'},PrepareCheckpoint:{destination:'issuer',roles:['provider'],permission:'checkpoint.prepare'},
 ReadForCheckpoint:{destination:'provider',roles:['checkpoint-issuer'],permission:'source.read-for-checkpoint'},PublishSelection:{destination:'registry',roles:['writer'],permission:'writer.publish'},
 AcquireReadPin:{destination:'registry',roles:['reader'],permission:'pin.acquire'},ReadCurrentCheckpoint:{destination:'issuer',roles:['reader','provider'],permission:'checkpoint.read-current'},
 CheckLiveBinding:{destination:'registry',roles:['provider','checkpoint-issuer','authority-broker'],permission:'binding.inspect'},
 PrepareHandoff:{destination:'registry',roles:['authority-broker'],permission:'handoff.prepare'},DeliverResult:{destination:'registry',roles:['authority-broker'],permission:'handoff.deliver'},
 AcknowledgeDelivery:{destination:'registry',roles:['reader'],permission:'handoff.ack'},BeginBarrier:{destination:'registry',roles:['operator','authority-broker'],permission:'barrier.begin'},
 ConfirmFenced:{destination:'registry',roles:['provider','checkpoint-issuer','authority-broker','reader','writer','manager'],permission:'barrier.confirm-own'},
 FinishBarrier:{destination:'registry',roles:['operator'],permission:'barrier.finish'},ResumeServing:{destination:'registry',roles:['operator'],permission:'lineage.resume'},
 QueryOperation:{destination:'registry',roles:currentRoles,permission:'operation.query-own'},CancelWriter:{destination:'registry',roles:['writer'],permission:'writer.cancel'},ReleaseReadPin:{destination:'registry',roles:['reader'],permission:'pin.release'},
 'anchor.read':{destination:'anchor',roles:['lineage-registry'],permission:'anchor.read'},'anchor.cas':{destination:'anchor',roles:['lineage-registry'],permission:'anchor.cas'},'anchor.query-operation':{destination:'anchor',roles:['lineage-registry'],permission:'anchor.query-own'},
};
export const requestSchema=z.object({schema:z.literal('osv-mcp.q2.current-control.body.v1'),api:z.enum(currentAPIs),direction:z.literal('request'),destination:z.enum(destinations),
 credentialId:cid,role:z.enum(currentRoles),peerId:cid,peerBoot:chash,keyEpoch:cn.positive(),requestId:chash,challenge:chash,sequence:cn.positive(),operationId:cid,
 binding:currentBindingSchema,requestDigest:chash,payload:z.unknown()}).strict();
export type CurrentRequest=z.infer<typeof requestSchema>;
export function validateRequest(value:unknown):CurrentRequest{
 const r=parsed(requestSchema,value);const payload=parsed(payloadSchemas[r.api],r.payload);return {...r,payload};
}
export function semanticDigest(r:Pick<CurrentRequest,'api'|'destination'|'credentialId'|'role'|'peerId'|'peerBoot'|'keyEpoch'|'operationId'|'binding'|'payload'>){
 return ownedDigest({domain:'osv-mcp.q2.current-control.intent.v1',api:r.api,destination:r.destination,credentialId:r.credentialId,role:r.role,peerId:r.peerId,peerBoot:r.peerBoot,keyEpoch:r.keyEpoch,operationId:r.operationId,binding:r.binding,payload:r.payload});
}
export function operationKey(r:Pick<CurrentRequest,'api'|'destination'|'credentialId'|'role'|'peerId'|'peerBoot'|'operationId'>){return ownedDigest({role:r.role,credentialId:r.credentialId,peerId:r.peerId,peerBoot:r.peerBoot,destination:r.destination,api:r.api,operationId:r.operationId});}
export const wireSchema=z.object({schema:z.literal('osv-mcp.q2.current-control.envelope.v1'),keyId:cid,keyEpoch:cn.positive(),role:z.enum(currentRoles),direction:z.enum(['request','reply']),body:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export function decodeCurrent(bytes:Buffer,max:number=CURRENT_LIMITS.frame):unknown{
 try{need(Buffer.isBuffer(bytes)&&bytes.length<=max,'budget_exceeded');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),value=parseOwnedJson(text,max);need(canonicalOwnedJson(value,max)===text,'canonical_invalid');return value;}
 catch(e){if(e instanceof CurrentControlError)throw e;throw new CurrentControlError('schema_invalid');}
}
const anyRef=currentRefSchema,phase=z.enum(['active','completing','decision-recorded','delivering','released','cancelling','cancelled','expired','reserved','consumed','provisioning']);
export const responseValues:Record<CurrentAPI,z.ZodType<any>>={
 BeginEnrollment:z.object({provision:cref('provision'),expires:cn}).strict(),ActivateEnrollment:z.object({selected:selectionSchema,selectionRevision:cn.positive()}).strict(),
 ReserveWriter:z.object({fence:cref('writer-fence'),expires:cn}).strict(),PrepareCheckpoint:z.object({checkpoint:cref('checkpoint-prepare'),head:currentHeadSchema}).strict(),
 ReadForCheckpoint:z.object({snapshot:cref('snapshot'),bytes:z.string().max(5500),sha256:chash,offset:cn}).strict(),PublishSelection:z.object({selected:selectionSchema,selectionRevision:cn.positive()}).strict(),
 AcquireReadPin:z.object({pin:cref('read-pin'),expires:cn}).strict(),ReadCurrentCheckpoint:z.object({witness:cref('checkpoint-witness'),head:currentHeadSchema}).strict(),
 CheckLiveBinding:z.object({target:anyRef,phase,selectionRevision:cn}).strict(),PrepareHandoff:z.object({pin:cref('read-pin'),useId:cid,phase:z.literal('decision-recorded')}).strict(),
 DeliverResult:z.object({pin:cref('read-pin'),delivery:cref('delivery'),useId:cid}).strict(),AcknowledgeDelivery:z.object({target:cref('read-pin'),phase:z.literal('released')}).strict(),
 BeginBarrier:z.object({barrier:cref('barrier'),participants:z.array(cid).max(32)}).strict(),ConfirmFenced:z.object({barrier:cref('barrier'),subject:cid}).strict(),
 FinishBarrier:z.object({barrier:cref('barrier'),phase:z.enum(['frozen','retired'])}).strict(),ResumeServing:z.object({phase:z.literal('serving'),registryIncarnation:chash}).strict(),
 QueryOperation:z.object({status:z.enum(['committed-historical','pending','unknown']),originalAPI:z.enum(registryAPIs),result:anyRef.nullable(),appliedControlRevision:cn.nullable()}).strict(),
 CancelWriter:z.object({target:cref('writer-fence'),phase:z.literal('cancelled')}).strict(),ReleaseReadPin:z.object({target:cref('read-pin'),phase:z.literal('cancelled')}).strict(),
 'anchor.read':z.object({revision:cn,record:cref('registry-record').nullable()}).strict(),
 'anchor.cas':z.object({revision:cn.positive(),record:cref('registry-record')}).strict(),
 'anchor.query-operation':z.object({attemptId:chash,status:z.enum(['committed-historical','unknown']),record:cref('registry-record').nullable()}).strict(),
};
export const replySchema=z.object({schema:z.literal('osv-mcp.q2.current-control.reply.v1'),api:z.enum(currentAPIs),direction:z.literal('reply'),destination:z.enum(destinations),
 requestId:chash,challenge:chash,requestWireDigest:chash,originalRequestDigest:chash,peerId:cid,peerBoot:chash,
 appliedControlRevision:cn.nullable(),appliedRecordRef:cref('registry-record').nullable(),currentControlRevision:cn,currentRecordRef:cref('registry-record').nullable(),
 resolutionMode:z.enum(['applied','existing-live-confirmed','committed-historical','pending','unknown']),semanticResultRef:cref('semantic-result').nullable(),value:z.unknown(),
 independentRegistryVerified:z.literal(false),profileApproved:z.literal(false),backendEligible:z.literal(false),originalReadsSkipped:z.literal(0)}).strict();

export const currentNamespaceSchema=z.object({namespaceId:chash,markerDigest:chash,generation:cn.positive(),fence:cn.positive(),root:z.object({device:z.string().regex(/^[0-9]+$/),inode:z.string().regex(/^[0-9]+$/)}).strict()}).strict();
export type CurrentNamespace=z.infer<typeof currentNamespaceSchema>;
