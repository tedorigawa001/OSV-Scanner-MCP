/** Own-role signer. The secret stays in this closure; only validated scoped intents are accepted. */
import {createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {ownerPlanFacts,prepareOwnerSignature,readSigningIntent,readSigningScope,validateCredentialRegistry,publicCredentialKey,type OwnerPlan,type RoleSigner,type ServiceIdentity,type CredentialRegistry} from './gradleOwnedServiceOwners.js';
import {registryRecordSchema,preparedCheckpointSchema,drainedProofSchema,anchorRequestSchema,anchorResultSchema,ownerEnvelopeSchema,validateRegistryCommand,type OwnerEnvelope,sameRegistryValue as same} from './gradleOwnedRegistrySchema.js';
import {stageRecordSchema} from './gradleOwnedServiceStages.js';
import {chash,parsed,need,decodeCurrent} from './gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson,ownedDigest} from './gradleOwnedJson.js';
export const registryResultSchema=z.object({api:z.string(),schema:z.literal('osv-mcp.q2.c3b.registry-result.v1'),lineage:currentLineageSchema,requestDigest:chash,operationKey:chash,mode:z.enum(['applied','existing-live-confirmed','committed-historical','observed']),appliedRevision:z.number().int().nonnegative(),currentRevision:z.number().int().nonnegative(),result:z.unknown(),live:z.boolean()}).strict();
const unsigned=(v:Omit<OwnerEnvelope,'signature'>)=>v;
function checkBody(body:any,direction:string,api:string|null,domain:string){
 if(domain==='stage'){parsed(stageRecordSchema,body);return;}
 need(api!==null&&api.startsWith(domain+'.'),'permission_denied');const bare=api.slice(domain.length+1);need(body.api===bare,'binding_mismatch');
 if(body.schema==='osv-mcp.q2.c3b.registry-record.v1'){need(direction==='reply','permission_denied');parsed(registryRecordSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.registry-result.v1'){need(direction==='reply','permission_denied');parsed(registryResultSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.prepared-checkpoint.v1'){need(direction==='reply'&&api==='control.PrepareCheckpoint','permission_denied');parsed(preparedCheckpointSchema,body);return;}
 if(body.schema==='osv-mcp.q2.c3b.cooperative-drained.v1'){need(direction==='request'&&api==='control.ConfirmFenced','permission_denied');parsed(drainedProofSchema,body);return;}
 if(body.command){need(direction==='request','permission_denied');const command=validateRegistryCommand(body.command);need(command.api===api&&same(Object.keys(body).sort(),['api','command']),'schema_invalid');return;}
 if(api.startsWith('control.anchor.')){direction==='request'?parsed(anchorRequestSchema,body):parsed(anchorResultSchema,body);return;}
 need(false,'permission_denied');
}
export function createRoleSigner(plan:OwnerPlan,registryValue:unknown,pins:Parameters<typeof validateCredentialRegistry>[1],credentialId:string,key:KeyObject,assertOpen:()=>void):RoleSigner{
 assertOpen();const c=ownerPlanFacts(plan),registry=validateCredentialRegistry(registryValue,pins),credential=registry.credentials.find(p=>p.identity.credentialId===credentialId);
 need(credential&&[c.clientCredentialId,c.serverCredentialId].includes(credentialId)&&credential.identity.boot===c.boot&&credential.identity.role===c.role&&credential.identity.instanceId===c.instanceId,'peer_mismatch');
 need(key.type==='private'&&key.asymmetricKeyType==='ed25519'&&createPublicKey(key).export({format:'der',type:'spki'}).toString('base64')===credential.spki,'peer_mismatch');
 const identity=structuredClone(credential.identity),direction=credential.direction,keyId=credential.keyId;
 return Object.freeze({get identity(){return structuredClone(identity);},direction,keyId,spki:credential.spki,async sign(intent:Parameters<RoleSigner['sign']>[0]){assertOpen();const bytes=readSigningIntent(intent,identity,direction),scope=readSigningScope(intent,identity,direction),body:any=decodeCurrent(bytes,65536);checkBody(body,direction,scope.api,scope.domain);
  if(body.schema==='osv-mcp.q2.c3b.registry-record.v1')need(body.ownerId===c.ownerId&&body.storageEpoch===c.storageEpoch&&same(body.lineage,c.lineage),'binding_mismatch');
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
 need(c.identity.keyEpoch===envelope.identity.keyEpoch&&(expected.historical||same(c.identity,envelope.identity)),'peer_mismatch');const sig=Buffer.from(signature,'base64');need(sig.toString('base64')===signature&&verify(null,Buffer.from(canonicalOwnedJson(body,65536)),publicCredentialKey(c),sig),'signature_invalid');checkBody(envelope.body,envelope.direction,envelope.api,envelope.domain);return envelope;
}
