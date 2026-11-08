import {command as cprCommand,cprResultSchema} from './gradleOwnedCprASchema.js';
/** I2 TEST-ONLY API fork; production API registration unchanged. */
import {i0Command} from './gradleOwnedCgpI0Schema.js';
import {i2ReplySchema} from './gradleOwnedCgpI2Schema.js';
/** Own-role signer. The secret stays in this closure; only validated scoped intents are accepted. */
import {businessOutcomeSchema} from '../../utils/gradleOwnedBusinessOutcome.js';
import {ownerRecoverySchema} from '../../utils/gradleOwnedRecoverySchema.js';
import {providerUseSchema} from '../../utils/gradleOwnedDeliverySchema.js';
import {createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {currentLineageSchema} from '../../utils/gradleOwnedCurrentAuxiliary.js';
import {ownerPlanFacts,prepareOwnerSignature,readSigningIntent,readSigningScope,validateCredentialRegistry,publicCredentialKey,type OwnerPlan,type RoleSigner,type ServiceIdentity,type CredentialRegistry} from './gradleOwnedCprBOwners.js';
import {registryRecordSchema,preparedCheckpointSchema,drainedProofSchema,anchorRequestSchema,anchorResultSchema,ownerEnvelopeSchema,validateRegistryCommand,type OwnerEnvelope,sameRegistryValue as same} from '../../utils/gradleOwnedRegistrySchema.js';
import {stageRecordSchema} from '../../utils/gradleOwnedServiceStages.js';
import {chash,parsed,need,decodeCurrent} from '../../utils/gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {validateAuthorityCommand,authorityGateSchema,authorityOwnerResultSchema} from '../../utils/gradleOwnedAuthorityOwnerSchema.js';
import {validateSourceCommand,sourceSealSchema,sourceResultSchema,sourceWitnessSchema} from '../../utils/gradleOwnedSourceSchema.js';
export const registryResultSchema=z.object({api:z.string(),schema:z.literal('osv-mcp.q2.c3b.registry-result.v1'),lineage:currentLineageSchema,requestDigest:chash,operationKey:chash,mode:z.enum(['applied','existing-live-confirmed','committed-historical','observed','pending']),appliedRevision:z.number().int().nonnegative(),currentRevision:z.number().int().nonnegative(),result:z.unknown(),live:z.boolean()}).strict();
const unsigned=(v:Omit<OwnerEnvelope,'signature'>)=>v;
export function checkOwnerBody(body:any,direction:string,api:string|null,domain:string){
 if(domain==='stage'){parsed(stageRecordSchema,body);return;}
 need(api!==null&&api.startsWith(domain+'.'),'permission_denied');const bare=api.slice(domain.length+1);need(body.api===bare,'binding_mismatch');
 if(api==='aux.ReadSourceRanges'&&body.schema!=='osv-mcp.q2.c3b.business-outcome.v1'){if(direction==='request'){need(same(Object.keys(body).sort(),['api','command']),'schema_invalid');cprCommand(body.command);}else parsed(cprResultSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.business-outcome.v1'){need(direction==='reply','permission_denied');parsed(businessOutcomeSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.registry-record.v1'){need(direction==='reply','permission_denied');parsed(registryRecordSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.registry-result.v1'){need(direction==='reply','permission_denied');parsed(registryResultSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.source-result.v1'){need(direction==='reply','permission_denied');parsed(sourceResultSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.source-seal.v1'){need(direction==='reply'&&api==='aux.PrepareCandidate','permission_denied');parsed(sourceSealSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.source-witness.v1'){need(direction==='reply'&&api==='control.ReadCurrentCheckpoint','permission_denied');parsed(sourceWitnessSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.prepared-checkpoint.v1'){need(direction==='reply'&&api==='control.PrepareCheckpoint','permission_denied');parsed(preparedCheckpointSchema,body);return;}
 if(['osv-mcp.q2.c3b.cooperative-drained.v1','osv-mcp.q2.c3b.runtime-drained.v1'].includes(body.schema)){need(direction==='request'&&api==='control.ConfirmFenced','permission_denied');parsed(drainedProofSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.authority-gate.v1'){need(direction==='reply'&&api==='aux.PrepareAuthorityResult','permission_denied');parsed(authorityGateSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.authority-result.v1'){need(direction==='reply','permission_denied');parsed(authorityOwnerResultSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.provider-use.v1'){need(direction==='reply'&&api==='aux.RecordUse','permission_denied');parsed(providerUseSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.recovered-owner.v1'){need(direction==='request'&&api==='aux.ReportServiceRecovered','permission_denied');parsed(ownerRecoverySchema,body);return;}
 if(body.command){need(direction==='request','permission_denied');const command=body.command.schema==='osv-mcp.q2.c3b.authority-command.v1'?validateAuthorityCommand(body.command):body.command.schema==='osv-mcp.q2.c3b.source-command.v1'?validateSourceCommand(body.command):validateRegistryCommand(body.command);need(command.api===api&&same(Object.keys(body).sort(),['api','command']),'schema_invalid');return;}
 if(api.startsWith('control.anchor.')){direction==='request'?parsed(anchorRequestSchema,body):parsed(anchorResultSchema,body);return;}
 need(false,'permission_denied');
}
export function createRoleSigner(plan:OwnerPlan,registryValue:unknown,pins:Parameters<typeof validateCredentialRegistry>[1],credentialId:string,key:KeyObject,assertOpen:()=>void):RoleSigner{
 assertOpen();const c=ownerPlanFacts(plan),registry=validateCredentialRegistry(registryValue,pins),credential=registry.credentials.find(p=>p.identity.credentialId===credentialId);
 need(credential&&[c.clientCredentialId,c.serverCredentialId].includes(credentialId)&&credential.identity.boot===c.boot&&credential.identity.role===c.role&&credential.identity.instanceId===c.instanceId,'peer_mismatch');
 need(key.type==='private'&&key.asymmetricKeyType==='ed25519'&&createPublicKey(key).export({format:'der',type:'spki'}).toString('base64')===credential.spki,'peer_mismatch');
 const identity=structuredClone(credential.identity),direction=credential.direction,keyId=credential.keyId;
 return Object.freeze({get identity(){return structuredClone(identity);},direction,keyId,spki:credential.spki,async sign(intent:Parameters<RoleSigner['sign']>[0]){assertOpen();const bytes=readSigningIntent(intent,identity,direction),scope=readSigningScope(intent,identity,direction),body:any=decodeCurrent(bytes,65536);checkOwnerBody(body,direction,scope.api,scope.domain);
  if(body.schema==='osv-mcp.q2.c3b.registry-record.v1')need(body.ownerId===c.ownerId&&body.storageEpoch===c.storageEpoch&&same(body.lineage,c.lineage),'binding_mismatch');
  if(['osv-mcp.q2.c3b.source-seal.v1','osv-mcp.q2.c3b.source-result.v1','osv-mcp.q2.c3b.source-witness.v1','osv-mcp.q2.c3b.prepared-checkpoint.v1'].includes(body.schema))need(same(body.lineage,c.lineage),'binding_mismatch');
  if(body.schema==='osv-mcp.q2.c3b.source-seal.v1')need(c.role==='provider'&&same(body.provider,identity)&&same(body.namespace.root,{device:c.roots.store.device,inode:c.roots.store.inode}),'binding_mismatch');
  if(['osv-mcp.q2.c3b.authority-gate.v1','osv-mcp.q2.c3b.authority-result.v1'].includes(body.schema))need(c.role==='authority-broker'&&same(body.lineage,c.lineage),'binding_mismatch');
  if(body.schema==='osv-mcp.q2.c3b.authority-gate.v1')need(same(body.broker,identity),'peer_mismatch');
  if(['osv-mcp.q2.c3b.cooperative-drained.v1','osv-mcp.q2.c3b.runtime-drained.v1'].includes(body.schema))need(body.boot===identity.boot&&body.subject===identity.instanceId,'peer_mismatch');
  if(body.schema==='osv-mcp.q2.c3b.provider-use.v1')need(c.role==='provider'&&same(body.provider,identity)&&same(body.lineage,c.lineage),'binding_mismatch');
  if(body.schema==='osv-mcp.q2.c3b.recovered-owner.v1')need(body.ownerId===c.ownerId&&body.storageEpoch===c.storageEpoch&&body.rootsDigest===ownedDigest(c.roots)&&same(body.subject,identity)&&same(body.lineage,c.lineage),'binding_mismatch');
  if(body.command)need(same(body.command.peer,identity)&&same(body.command.lineage,c.lineage),'peer_mismatch');
  const payload={schema:'osv-mcp.q2.c3b.owner-envelope.v1' as const,identity,keyId,direction,domain:scope.domain as OwnerEnvelope['domain'],api:scope.api,body};const signature=sign(null,Buffer.from(canonicalOwnedJson(unsigned(payload),65536)),key);assertOpen();return signature;}});
}
export async function signOwnerValue(plan:OwnerPlan,signer:RoleSigner,domain:'control'|'aux'|'stage',api:string|null,body:unknown){
 const bytes=Buffer.from(canonicalOwnedJson(body,65536)),intent=prepareOwnerSignature(plan,signer.identity.credentialId,{domain,direction:signer.direction,api,bodyDigest:ownedDigest(body)},bytes),signature=await signer.sign(intent);
 const payload={schema:'osv-mcp.q2.c3b.owner-envelope.v1' as const,identity:signer.identity,keyId:signer.keyId,direction:signer.direction,domain,api,body};
 need(Buffer.isBuffer(signature)&&signature.length===64&&verify(null,Buffer.from(canonicalOwnedJson(payload,65536)),publicCredentialKey({spki:signer.spki} as any),signature),'signature_invalid');
 return Buffer.from(canonicalOwnedJson({...payload,signature:signature.toString('base64')},65536));
}
export function verifyOwnerValue(bytes:Buffer,registry:CredentialRegistry,expected:{role:string;instanceId:string;direction:'request'|'reply';domain:'control'|'aux'|'stage';api:string|null;historical?:boolean}){
 const envelope=parsed(ownerEnvelopeSchema,decodeCurrent(bytes,65536)),{signature,...body}=envelope,c=registry.credentials.find(c=>c.identity.credentialId===envelope.identity.credentialId);
 need(c&&c.keyId===envelope.keyId&&c.direction===expected.direction&&envelope.direction===expected.direction&&c.identity.role===expected.role&&envelope.identity.role===expected.role&&c.identity.instanceId===expected.instanceId&&envelope.identity.instanceId===expected.instanceId&&envelope.domain===expected.domain&&envelope.api===expected.api,'peer_mismatch');
 need(c.identity.keyEpoch===envelope.identity.keyEpoch&&(expected.historical||same(c.identity,envelope.identity)),'peer_mismatch');const sig=Buffer.from(signature,'base64');need(sig.toString('base64')===signature&&verify(null,Buffer.from(canonicalOwnedJson(body,65536)),publicCredentialKey(c),sig),'signature_invalid');checkOwnerBody(envelope.body,envelope.direction,envelope.api,envelope.domain);const content:any=envelope.body;if(content.schema==='osv-mcp.q2.c3b.source-seal.v1')need(same(content.provider,envelope.identity),'peer_mismatch');if(content.schema==='osv-mcp.q2.c3b.provider-use.v1')need(same(content.provider,envelope.identity),'peer_mismatch');if(content.schema==='osv-mcp.q2.c3b.authority-gate.v1')need(same(content.broker,envelope.identity),'peer_mismatch');return envelope;
}
