/** C3b-2 owner-local state and public record interchange. No imported live handles. */
import {z} from 'zod';
import {cid,chash,cn,cref,selectionSchema,currentBindingSchema,payloadSchemas,parsed,need,decodeCurrent,CURRENT_LIMITS} from './gradleOwnedCurrentSchema.js';
import {currentLineageSchema,auxiliaryPayloads} from './gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema} from './gradleOwnedServiceOwners.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from './gradleOwnedJson.js';
export const registryServiceAPIs=['control.BeginEnrollment','control.ActivateEnrollment','control.ReserveWriter','control.PublishSelection','control.AcquireReadPin','control.CheckLiveBinding','control.CancelWriter','control.ReleaseReadPin','control.BeginBarrier','control.ConfirmFenced','control.FinishBarrier','control.ResumeServing','control.QueryOperation','aux.ReadContext','aux.AbandonEnrollment'] as const;
export const registryAPISchema=z.enum(registryServiceAPIs);
export function registryPurpose(api:string):'read'|'publication'|'maintenance'|'enrollment'{if(['control.BeginEnrollment','control.ActivateEnrollment','aux.AbandonEnrollment'].includes(api))return 'enrollment';if(['control.ReserveWriter','control.PublishSelection','control.CancelWriter'].includes(api))return 'publication';if(['control.BeginBarrier','control.ConfirmFenced','control.FinishBarrier','control.ResumeServing'].includes(api))return 'maintenance';return 'read';}
export const anchorHeadSchema=z.object({revision:cn.max(CURRENT_LIMITS.records),record:cref('registry-record').nullable()}).strict().refine(v=>(v.revision===0)===(v.record===null));
export type AnchorHead=z.infer<typeof anchorHeadSchema>;
export const ownerEnvelopeSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.owner-envelope.v1'),identity:serviceIdentitySchema,keyId:cid,direction:z.enum(['request','reply']),domain:z.enum(['control','aux','stage','recovery','auth']),api:z.string().nullable(),body:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export type OwnerEnvelope=z.infer<typeof ownerEnvelopeSchema>;
const grant=z.object({ref:z.union([cref('provision'),cref('writer-fence'),cref('read-pin')]),owner:serviceIdentitySchema,expires:cn,incarnation:chash,revocationEpoch:cn,selectionRevision:cn,phase:z.enum(['active','consumed','cancelled']),operationId:cid,requestDigest:chash}).strict();
const entry=z.object({key:chash,digest:chash,api:registryAPISchema,operationId:cid,owner:serviceIdentitySchema,result:z.unknown(),applied:cn.positive(),incarnation:chash}).strict();
const barrier=z.object({ref:cref('barrier'),reason:z.enum(['revoke','freeze','cutover','gc','restart','rotation']),participants:z.array(cid).max(32),boots:z.record(cid,chash),confirmed:z.array(cid).max(32),completed:z.boolean(),resume:z.boolean()}).strict();
export const drainedProofSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.cooperative-drained.v1'),api:z.literal('ConfirmFenced'),barrier:cref('barrier'),subject:cid,boot:chash,inFlight:z.literal(0),effects:z.literal(0),scope:z.literal('cooperative-only')}).strict();
export const registryStateSchema=z.object({phase:z.enum(['uninitialized','provisioning','serving','draining','frozen','retired']),incarnation:chash,selectionRevision:cn,revocationEpoch:cn,writerFence:cn,selected:selectionSchema.nullable(),provision:grant.nullable(),writer:grant.nullable(),pins:z.array(grant).max(64),barrier:barrier.nullable(),ledger:z.array(entry).max(64)}).strict();
export type RegistryState=z.infer<typeof registryStateSchema>;
export const registryRecordSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.registry-record.v1'),api:z.string(),lineage:currentLineageSchema,ownerId:cid,storageEpoch:chash,revision:cn.positive().max(256),previous:cref('registry-record').nullable(),attemptId:chash,state:registryStateSchema}).strict();
export type RegistryRecord=z.infer<typeof registryRecordSchema>;
export const storedRegistryRecordSchema=z.object({ref:cref('registry-record'),wire:z.string().max(90000)}).strict();
// One record per stage: the chain is the owner's verified history, so history stays linear instead of repeating every record.
export const registryImageSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.registry-image.v2'),record:storedRegistryRecordSchema,transaction:z.object({api:z.string(),operationKey:chash,requestDigest:chash}).strict()}).strict();
export const preparedCheckpointSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.prepared-checkpoint.v1'),api:z.literal('PrepareCheckpoint'),lineage:currentLineageSchema,fence:z.union([cref('provision'),cref('writer-fence')]),mode:z.enum(['genesis','advance']),previous:cref('checkpoint-prepare').nullable(),snapshot:cref('snapshot'),head:selectionSchema.shape.head,inventoryDigest:chash}).strict();
export const commandSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.registry-command.v1'),api:registryAPISchema,operationId:cid,peer:serviceIdentitySchema,lineage:currentLineageSchema,binding:z.union([currentBindingSchema,currentLineageSchema]),payload:z.unknown(),requestDigest:chash}).strict();
export type RegistryCommand=z.infer<typeof commandSchema>;
const sourceLiveCheck=z.object({target:z.union([cref('read-pin'),cref('writer-fence'),cref('provision')]),purpose:z.enum(['checkpoint','handoff','source-read']),origin:serviceIdentitySchema,delegateInstance:cid,snapshot:cref('snapshot').nullable()}).strict();
export function registryIntent(r:Omit<RegistryCommand,'requestDigest'>|RegistryCommand){const {requestDigest,...rest}=r as RegistryCommand;return ownedDigest({domain:'osv-mcp.q2.c3b.registry-intent.v1',...rest});}
export const registryOperationKey=(r:RegistryCommand)=>ownedDigest({domain:'osv-mcp.q2.c3b.registry-operation.v1',peer:r.peer,api:r.api,operationId:r.operationId,lineage:r.lineage});
export function validateRegistryCommand(value:unknown){const r=parsed(commandSchema,value),[domain,...parts]=r.api.split('.'),api=parts.join('.');r.payload=api==='CheckLiveBinding'&&r.payload&&typeof r.payload==='object'&&'origin' in r.payload?parsed(sourceLiveCheck,r.payload):parsed(domain==='control'?payloadSchemas[api as keyof typeof payloadSchemas]:auxiliaryPayloads[api as keyof typeof auxiliaryPayloads],r.payload);need(r.requestDigest===registryIntent(r),'binding_mismatch');return r;}
export function makeRegistryCommand(value:Omit<RegistryCommand,'schema'|'requestDigest'>){const r={schema:'osv-mcp.q2.c3b.registry-command.v1' as const,...value};return validateRegistryCommand({...r,requestDigest:registryIntent(r as RegistryCommand)});}
export const anchorRequestSchema=z.discriminatedUnion('api',[
 z.object({api:z.literal('anchor.read'),requestId:chash,lineage:currentLineageSchema}).strict(),
 z.object({api:z.literal('anchor.cas'),requestId:chash,lineage:currentLineageSchema,expected:anchorHeadSchema,record:storedRegistryRecordSchema,attemptId:chash}).strict(),
 z.object({api:z.literal('anchor.query-operation'),requestId:chash,lineage:currentLineageSchema,attemptId:chash}).strict(),
]);
export type AnchorRequest=z.infer<typeof anchorRequestSchema>;
export const anchorResultSchema=z.object({api:z.enum(['anchor.read','anchor.cas','anchor.query-operation']),requestDigest:chash,head:anchorHeadSchema,applied:anchorHeadSchema.nullable(),attemptId:chash.nullable()}).strict();
export const anchorEntrySchema=z.object({expected:anchorHeadSchema,next:anchorHeadSchema,attemptId:chash,record:storedRegistryRecordSchema}).strict();
export type AnchorEntry=z.infer<typeof anchorEntrySchema>;
export const anchorImageSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.anchor-image.v2'),entry:anchorEntrySchema}).strict();
/** A two-stage transaction stores its one record in both stages. */
export function registryRecordsOf(images:readonly unknown[]){const out:z.infer<typeof storedRegistryRecordSchema>[]=[];for(const value of images){const {record}=parsed(registryImageSchema,value);if(out.at(-1)?.ref.id!==record.ref.id)out.push(record);}return out;}
export function decodeStoredRecord(value:z.infer<typeof storedRegistryRecordSchema>){const bytes=Buffer.from(value.wire,'base64');need(bytes.toString('base64')===value.wire&&bytes.length===value.ref.byteLength&&ownedSha256(bytes)===value.ref.sha256&&value.ref.id===value.ref.sha256,'integrity_invalid');return parsed(ownerEnvelopeSchema,decodeCurrent(bytes,CURRENT_LIMITS.record));}
export const publicRecordRef=(wire:Buffer)=>({role:'registry-record' as const,id:ownedSha256(wire),sha256:ownedSha256(wire),byteLength:wire.length});
export const sameRegistryValue=(a:unknown,b:unknown)=>canonicalOwnedJson(a,8*1024*1024)===canonicalOwnedJson(b,8*1024*1024);
