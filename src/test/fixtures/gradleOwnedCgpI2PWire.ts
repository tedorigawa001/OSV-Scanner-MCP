import {plannerWireCap} from './gradleOwnedCgpI2PProfile.js';
/** I2 planner experiment fork; original I0 behavior remains the baseline. */
import {z} from 'zod';
import {cref,chash,cid,cn,decodeCurrent} from '../../utils/gradleOwnedCurrentSchema.js';
import {serviceIdentitySchema} from '../../utils/gradleOwnedServiceOwners.js';
/** Exact fixture layout, deliberately not registered in the production session API. */
import {sign,verify,type KeyObject} from 'node:crypto';
import {canonicalOwnedJson,ownedSha256,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {i0Intent,i0DispatchIntent,type I0Authorized} from './gradleOwnedCgpI2PAuthority.js';
import {i0Need,i0Parse,i0Same,i0RangeSchema,type I0Range} from './gradleOwnedCgpI0Schema.js';
const zero='0'.repeat(64),signature=Buffer.alloc(64).toString('base64');
const bytes=(v:unknown)=>Buffer.from(canonicalOwnedJson(v));
export function i0WireLimits(request:number,reply:number,frames:number[]){i0Need(Number.isSafeInteger(request)&&request>0&&request<=8192&&Number.isSafeInteger(reply)&&reply>0&&reply<=8192&&frames.length===4&&frames.every(n=>Number.isSafeInteger(n)&&n>0&&n<=16384),'wire_budget');}
export function i0Wire(intent:I0Authorized,parts?:Buffer[],keys?:{request:KeyObject;reply:KeyObject}){
 const f=i0Intent(intent),q=f.command;i0Need(q.api==='aux.ReadSourceRanges','wire_api_invalid');const ranges=q.payload.ranges;
 if(parts)i0Need(parts.length===ranges.length&&parts.every((b,i)=>b.length===ranges[i]!.length),'reply_parts_invalid');
 const seal=(schema:string,direction:'request'|'reply',body:unknown,owner=false)=>{const keyId=direction==='request'?f.peer.credentialId:f.server.credentialId,payload=owner?{schema,identity:direction==='request'?f.peer:f.server,keyId,direction,domain:'aux',api:'ReadSourceRanges',body}:{schema,direction,keyId,body};
  const sig=keys?sign(null,bytes(owner?payload:{domain:schema,direction,keyId,body}),keys[direction]).toString('base64'):signature;return bytes({...payload,signature:sig});};
 const request=seal('osv-mcp.q2.c3b.owner-envelope.v1','request',q,true),reply=seal('osv-mcp.q2.c3b.owner-envelope.v1','reply',{schema:'cgp.i0.range-reply.v1',api:'ReadSourceRanges',requestDigest:q.requestDigest,snapshot:q.payload.snapshot,inventoryDigest:f.inventoryDigest,transferId:q.payload.transferId,planDigest:q.payload.planDigest,parts:ranges.map((r,i)=>{const b=parts?.[i]??Buffer.alloc(r.length);return {ordinal:r.ordinal,kind:r.kind,index:r.index,entry:r.entry,offset:r.offset,totalBytes:r.entry.byteLength,bytes:b.toString('base64'),sha256:ownedSha256(b)};})},true);
 const common={clientCredentialId:f.peer.credentialId,serverCredentialId:f.server.credentialId,deploymentDigest:zero,enrollmentDigest:q.lineage.enrollmentDigest,profileDigest:q.lineage.profileDigest,registryDigest:zero,endpointId:'provider',clientBoot:f.peer.boot,serverBoot:f.server.boot,clientKeyEpoch:f.peer.keyEpoch,serverKeyEpoch:f.server.keyEpoch,clientNonce:zero,serverNonce:zero,sessionId:zero,transcriptDigest:zero,api:q.api,originDigest:ownedDigest(f.peer),ttlMs:4500};
 const frames=[seal('osv-mcp.q2.c3b.auth.v1','request',{...common,kind:'challenge-request',sequence:511,requestId:q.requestDigest}),seal('osv-mcp.q2.c3b.auth.v1','reply',{...common,kind:'challenge',sequence:511,requestId:q.requestDigest,challenge:zero}),seal('osv-mcp.q2.c3b.auth.v1','request',{...common,kind:'channel',sequence:512,challenge:zero,innerWireDigest:ownedSha256(request)}),seal('osv-mcp.q2.c3b.auth.v1','reply',{...common,kind:'channel',sequence:512,challenge:zero,innerWireDigest:ownedSha256(reply)})];
 plannerWireCap(request.length,reply.length);i0WireLimits(request.length,reply.length,frames.map(b=>b.length));i0ValidateReplyBody(intent,JSON.parse(reply.toString('utf8')).body);return {request,reply,frames,total:request.length+reply.length+frames.reduce((n,b)=>n+b.length,0)};
}

const partSchema=i0RangeSchema.omit({length:true}).extend({totalBytes:cn.positive().max(192*1024),bytes:z.string().min(4).max(5464).regex(/^[A-Za-z0-9+/]+={0,2}$/),sha256:chash}).strict();
export const i0ReplySchema=z.object({schema:z.literal('cgp.i0.range-reply.v1'),api:z.literal('ReadSourceRanges'),requestDigest:chash,snapshot:cref('snapshot'),inventoryDigest:chash,transferId:cid,planDigest:chash,parts:z.array(partSchema).min(1).max(4)}).strict();
const replyEnvelopeSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.owner-envelope.v1'),identity:serviceIdentitySchema,keyId:cid,direction:z.literal('reply'),domain:z.literal('aux'),api:z.literal('ReadSourceRanges'),body:i0ReplySchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
/** Trusted expected intent and public key are supplied by the fixture, never derived from the reply. */
export function i0ValidateReply(intent:I0Authorized,wire:Buffer,publicKey:KeyObject){
 const f=i0DispatchIntent(intent),q=f.command;i0Need(q.api==='aux.ReadSourceRanges','wire_api_invalid');
 const envelope=i0Parse(replyEnvelopeSchema,decodeCurrent(wire,8192)),{signature:sig,...unsigned}=envelope;
 i0Need(i0Same(envelope.identity,f.server)&&envelope.keyId===f.server.credentialId,'reply_identity_mismatch');
 i0Need(verify(null,bytes(unsigned),publicKey,Buffer.from(sig,'base64')),'reply_signature_invalid');
 return i0ValidateReplyBody(intent,envelope.body);
}
function i0ValidateReplyBody(intent:I0Authorized,input:unknown){
 const f=i0Intent(intent),q=f.command;i0Need(q.api==='aux.ReadSourceRanges','wire_api_invalid');const body=i0Parse(i0ReplySchema,input);
 i0Need(body.requestDigest===q.requestDigest&&i0Same(body.snapshot,q.payload.snapshot)&&body.inventoryDigest===f.inventoryDigest&&body.transferId===q.payload.transferId&&body.planDigest===q.payload.planDigest,'reply_context_mismatch');
 i0Need(body.parts.length===q.payload.ranges.length,'reply_parts_invalid');let total=0;const parts=body.parts.map((p,i)=>{const r=q.payload.ranges[i]!,data=Buffer.from(p.bytes,'base64');
 i0Need(p.ordinal===r.ordinal&&p.kind===r.kind&&p.index===r.index&&p.offset===r.offset&&p.totalBytes===r.entry.byteLength&&i0Same(p.entry,r.entry),'reply_range_mismatch');
 i0Need(data.toString('base64')===p.bytes&&data.length===r.length&&ownedSha256(data)===p.sha256,'reply_bytes_invalid');total+=data.length;return data;});
 i0Need(total===q.payload.byteBudget&&total<=4096,'reply_budget_invalid');return parts;
}
