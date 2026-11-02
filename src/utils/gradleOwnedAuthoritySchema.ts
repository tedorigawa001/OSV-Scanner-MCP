/** Stage A1 logical operations only. No IPC authentication or persistence claims. */
import {z} from 'zod';
import {ownedLookupSchema,ownedSessionSchema} from './gradleOwnedExecution.js';
import {carrierSchema,entrySchema} from './gradleOwnedSchema.js';
export const authorityId=z.string().min(1).max(1024);
export const authorityHash=z.string().regex(/^[a-f0-9]{64}$/).refine(s=>s!=='0'.repeat(64));
const id=authorityId,hash=authorityHash;
export const authorityScope=z.object({project:id,context:id,invocation:id}).strict();
export type AuthorityScope=z.infer<typeof authorityScope>;
export const authorityPlan=authorityScope.extend({taskId:id,actionId:id,brokerInstanceId:id,plannedCaptures:z.number().int().min(0).max(8),profileId:id,recipeId:id,profileDigest:hash,recipeDigest:hash}).strict();
export type AuthorityPlan=z.infer<typeof authorityPlan>;
export const authorityMetadataRef=z.object({uploadId:id,purpose:z.enum(['core','seal']),byteLength:z.number().int().positive().max(64*1024*1024),rawSha256:hash}).strict();
export type AuthorityMetadataRef=z.infer<typeof authorityMetadataRef>;
export const authorityProjection=z.object({schema:z.literal('osv-mcp.gradle-graph'),schemaVersion:z.literal(4),graphId:id,exportId:id,coreMetadataRef:authorityMetadataRef.refine(r=>r.purpose==='core'),ownedOfferBundles:z.array(entrySchema).length(1),ownedOfferObjects:z.array(carrierSchema).min(1).max(1024)}).strict();
const base={schema:z.literal('osv-mcp.gradle-owned-authority-operation-v1'),schemaVersion:z.literal(1),operationId:id,expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)};
const session={...base,sessionId:id};
const chunk={...session,operation:z.literal('put-metadata-chunk'),uploadId:id,totalBytes:z.number().int().positive().max(64*1024*1024),totalSha256:hash,ordinal:z.number().int().nonnegative().max(63),chunkSha256:hash,base64:z.string().min(4).max(4*Math.ceil(1024*1024/3))};
export const authorityOperation=z.union([
 z.object({...base,operation:z.literal('begin'),expectedRevision:z.literal(0),consumerId:id,scanRunId:id,projectRootId:id,settingsDigest:hash,scopeRequestsDigest:hash}).strict(),
 z.object({...chunk,purpose:z.literal('core')}).strict(),
 z.object({...chunk,purpose:z.literal('seal'),scope:authorityScope,witnessId:id}).strict(),
 z.object({...session,operation:z.literal('bind-core'),coreMetadataRef:authorityMetadataRef,coreGraphDigest:hash,rootRegistryDigest:hash,scopes:z.array(authorityPlan).min(1).max(2000)}).strict(),
 z.object({...session,operation:z.literal('activate'),expectedCurrentRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict(),
 z.object({...session,operation:z.literal('register-scope'),scope:authorityScope}).strict(),
 z.object({...session,operation:z.literal('append-event'),scope:authorityScope,sequence:z.number().int().positive().max(16384),previousDigest:hash,event:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('action-start'),capability:id}).strict(),
  z.object({kind:z.literal('execution-observation'),lookup:ownedLookupSchema,leases:ownedSessionSchema.shape.leases}).strict()
 ])}).strict(),
 z.object({...session,operation:z.literal('seal-scope'),scope:authorityScope,phase:z.literal('prepare'),ledgerHead:hash}).strict(),
 z.object({...session,operation:z.literal('seal-scope'),scope:authorityScope,phase:z.literal('commit'),ledgerHead:hash,sealMetadataRef:authorityMetadataRef.optional(),pair:z.object({bundleDigest:hash,envelopeDigest:hash}).strict().optional()}).strict(),
 z.object({...session,operation:z.enum(['abort','revoke']),scope:authorityScope.optional(),reason:z.enum(['operator-request','execution-unavailable'])}).strict(),
 z.object({...session,operation:z.literal('lookup'),scope:authorityScope}).strict()
]);
export type AuthorityOperation=z.infer<typeof authorityOperation>;
export const AUTHORITY_LIMITS=Object.freeze({coreBytes:16*1024*1024,projectionBytes:48*1024*1024,metadataBytes:64*1024*1024,chunkBytes:1024*1024,pendingUploads:32,sessions:32,operations:16384,events:16384,ledgerBytes:64*1024*1024,sessionMilliseconds:600000,chunkMilliseconds:5000});
