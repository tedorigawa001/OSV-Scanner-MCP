/** C3b-4 read-only authority protocol. No wire value is a live process handle. */
import {z} from 'zod';
import {authorityTimeSchema} from './gradleOwnedAuthorityClock.js';
import {cid,chash,cn,cref,currentBindingSchema,currentHeadSchema,parsed,need,type CurrentRef} from './gradleOwnedCurrentSchema.js';
import {currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema} from './gradleOwnedServiceOwners.js';
import {ownedDigest,ownedSha256} from './gradleOwnedJson.js';
export const authorityOwnerAPIs=['aux.PrepareAuthorityResult','aux.RevokeAuthority'] as const;
export const authorityOwnerPurpose=(api:string):'handoff'|'maintenance'=>api==='aux.PrepareAuthorityResult'?'handoff':'maintenance';
const id=z.string().min(1).max(1024);
export const authorityReadScopeSchema=z.object({sessionId:id,project:id,context:id,invocation:id,consumerId:id,scanRunId:id,projectRootId:id,settingsDigest:chash,manifestDigest:chash,coreGraphDigest:chash,operationBinding:chash,profileId:id,recipeId:id,profileDigest:chash,recipeDigest:chash}).strict();
export const authorityOwnerPayloads={
 'aux.PrepareAuthorityResult':z.object({pin:cref('read-pin'),witness:cref('checkpoint-witness'),witnessWire:z.string().max(6000),scope:authorityReadScopeSchema,useId:cid,resultDigest:chash,effect:z.literal('read-only')}).strict(),
 'aux.RevokeAuthority':z.object({sessionId:id,scope:z.object({project:id,context:id,invocation:id}).strict().nullable(),reason:z.literal('operator-request')}).strict(),
};
export const authorityOwnerCommandSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.authority-command.v1'),api:z.enum(authorityOwnerAPIs),operationId:cid,peer:serviceIdentitySchema,lineage:currentLineageSchema,binding:currentBindingSchema,payload:z.unknown(),requestDigest:chash}).strict();
export type AuthorityOwnerCommand=z.infer<typeof authorityOwnerCommandSchema>;
export const authorityIntent=(value:Omit<AuthorityOwnerCommand,'requestDigest'>|AuthorityOwnerCommand)=>{const {requestDigest,...rest}=value as AuthorityOwnerCommand;return ownedDigest({domain:'c3b-authority-intent-v1',...rest});};
export const authorityOperationKey=(r:AuthorityOwnerCommand)=>ownedDigest({domain:'c3b-authority-operation-v1',peer:r.peer,api:r.api,operationId:r.operationId,lineage:r.lineage});
export function validateAuthorityCommand(value:unknown){const r=parsed(authorityOwnerCommandSchema,value);r.payload=parsed<unknown>(authorityOwnerPayloads[r.api],r.payload);need(r.requestDigest===authorityIntent(r),'binding_mismatch');return r;}
export function makeAuthorityCommand(value:Omit<AuthorityOwnerCommand,'schema'|'requestDigest'>){const r={schema:'osv-mcp.q2.c3b.authority-command.v1' as const,...value};return validateAuthorityCommand({...r,requestDigest:authorityIntent(r as AuthorityOwnerCommand)});}
export const authorityGateSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.authority-gate.v1'),api:z.literal('PrepareAuthorityResult'),lineage:currentLineageSchema,broker:serviceIdentitySchema,reader:serviceIdentitySchema,binding:currentBindingSchema,pin:cref('read-pin'),witness:cref('checkpoint-witness'),useId:cid,result:cref('candidate-result'),scope:authorityReadScopeSchema,terminalDigest:chash,sourceHead:currentHeadSchema,reservationKey:chash,authorityRevision:cn.positive(),authorityTime:authorityTimeSchema,effect:z.literal('read-only')}).strict();
export type AuthorityGate=z.infer<typeof authorityGateSchema>;
export const authorityOwnerResultSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.authority-result.v1'),api:z.enum(['PrepareAuthorityResult','RevokeAuthority']),lineage:currentLineageSchema,requestDigest:chash,operationKey:chash,mode:z.enum(['prepared','revoked','committed-historical','pending']),result:z.unknown(),live:z.literal(false)}).strict();
export function authorityRef(role:'authority-gate'|'candidate-result',bytes:Buffer):CurrentRef{const digest=ownedSha256(bytes);return {role,id:digest,sha256:digest,byteLength:bytes.length};}
/** Result/gate evidence is immutable and addressed by exact bytes, never a path. */
export interface AuthorityEvidencePort {readGate:(ref:CurrentRef)=>Promise<Buffer>}
