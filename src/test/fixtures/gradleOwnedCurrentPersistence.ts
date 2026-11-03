/** C1 disk interchange only. No Ed25519 private keys, live actor handles or admission flags. */
import {z} from 'zod';
import {cid,chash,cn,currentRefSchema as ref,cref,currentBindingSchema,currentHeadSchema,currentRoles,currentAPIs,CURRENT_LIMITS as L} from './gradleOwnedCurrentSchema.js';
const lease=z.object({ref:z.union([cref('provision'),cref('writer-fence')]),owner:cid,expires:cn,selectionRevision:cn,revocationEpoch:cn,incarnation:chash,providerBoot:chash,issuerBoot:chash,phase:z.enum(['reserved','consumed','cancelled','expired']),operationId:cid}).strict();
const pin=lease.extend({ref:cref('read-pin'),phase:z.enum(['active','completing','decision-recorded','delivering','released','cancelling','cancelled','expired']),createdControlRevision:cn,operationBinding:chash,checkpoint:cref('checkpoint-prepare'),snapshot:cref('snapshot'),broker:cid.nullable(),useId:cid.nullable(),gate:cref('authority-gate').nullable(),delivery:cref('delivery').nullable(),hold:z.boolean(),effect:z.boolean()}).strict();
const ledger=z.object({digest:chash,api:z.enum(currentAPIs),owner:cid,status:z.enum(['pending','committed']),applied:cn,result:cref('semantic-result'),started:cn,localStarted:cn,binding:currentBindingSchema}).strict();
const barrier=z.object({ref:cref('barrier'),reason:z.enum(['revoke','freeze','cutover','gc','restart','rotation']),participants:z.array(cid).max(32),boots:z.record(cid,chash),confirmed:z.array(cid).max(32),resume:z.boolean(),completed:z.boolean()}).strict();
export const durableStateSchema=z.object({phase:z.enum(['uninitialized','provisioning','serving','draining','frozen','retired']),selectionRevision:cn,revocationEpoch:cn,writerFence:cn,incarnation:chash,selected:z.object({snapshot:cref('snapshot'),checkpoint:cref('checkpoint-prepare'),head:currentHeadSchema}).strict().nullable(),provision:lease.nullable(),writer:lease.nullable(),pins:z.record(cid,pin),barrier:barrier.nullable(),operations:z.record(chash,ledger)}).strict();
export const durableRecordSchema=z.object({schema:z.literal('osv-mcp.q2.c0.registry-record.v1'),identity:z.record(z.string(),z.union([z.string(),cn])),revision:cn.positive(),previous:cref('registry-record').nullable(),state:durableStateSchema,auditNonce:chash.optional()}).strict();
const b64=z.string().max(12*1024*1024).regex(/^[A-Za-z0-9+/]*={0,2}$/);
const stored=z.object({ref,raw:b64}).strict();
const object=stored.extend({role:z.enum(currentRoles)}).strict();
export const durableRegistrySchema=z.object({schema:z.literal('osv-mcp.q2.c1.registry.v1'),identityDigest:chash,records:z.array(stored.extend({ref:cref('registry-record')}).strict()).max(L.records),objects:z.array(object).max(L.objects)}).strict();
const source=z.object({ref:cref('snapshot'),metadata:z.object({binding:z.object({authorityId:cid,lineageId:cid,storeEpoch:chash,generation:cn.positive(),profileDigest:chash}).strict(),baseRef:z.object({role:z.literal('compacted-base'),id:cid,sha256:chash,byteLength:cn}).strict(),keyId:cid,approvedBaseDigest:chash,checkpoint:z.object({revision:cn,commitDigest:chash}).strict(),auditAuthoritySnapshot:z.boolean().optional()}).strict(),key:b64,commits:z.array(b64).max(256),payloads:z.array(b64).max(8192)}).strict();
const prepared=z.object({ref:cref('checkpoint-prepare'),snapshot:cref('snapshot'),head:currentHeadSchema,fence:z.union([cref('provision'),cref('writer-fence')]),previous:cref('checkpoint-prepare').nullable(),mode:z.enum(['genesis','advance'])}).strict();
export const durableIssuerSchema=z.object({schema:z.literal('osv-mcp.q2.c1.issuer.v1'),identityDigest:chash,objects:z.array(object).max(L.objects),sources:z.array(source).max(L.objects),prepares:z.array(prepared).max(L.prepares),operations:z.array(z.object({key:chash,entry:ledger.extend({fence:z.union([cref('provision'),cref('writer-fence')])}).strict()}).strict()).max(L.operations)}).strict();
export type DurableRegistry=z.infer<typeof durableRegistrySchema>;
export type DurableIssuer=z.infer<typeof durableIssuerSchema>;
export const durableAnchorSchema=z.object({revision:cn.max(L.records),record:cref('registry-record').nullable()}).strict().refine(v=>(v.revision===0)===(v.record===null));
export type DurableAnchor=z.infer<typeof durableAnchorSchema>;
export interface CurrentPersistence {
 /** Synchronous owner-lifecycle check; performs no IO. */
 assertOpen():void;
 saveIssuer(image:DurableIssuer):Promise<void>;
 saveRegistry(image:DurableRegistry):Promise<void>;
 readAnchor():Promise<DurableAnchor>;
 cas(expected:DurableAnchor,next:DurableAnchor,attemptId:string):Promise<void>;
 verify(expected:DurableAnchor):Promise<void>;
}
