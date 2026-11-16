/** PB1 local durability contract. Anchor signatures authenticate a configured port, not its isolation. */
import {z} from 'zod';
import {createPublicKey,verify} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as digest,ownedSha256,parseOwnedJson} from './gradleOwnedJson.js';
import {pb0Decode,pb0Need as need,pb0OriginSchema,pb0ParseRequest,PB0_PROFILE_DIGEST} from './gradleOwnedP0StateContract.js';
import {journalHeadSchema,journalGenesis,type JournalHead} from './gradleOwnedStoreJournal.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const PB1_LIMITS=Object.freeze({stages:256,normal:192,cleanup:64,payload:32*1024*1024,journal:16*1024*1024,checkpoint:8*1024*1024,adoption:4*1024*1024,scratch:4*1024*1024,command:2*1024*1024,data:1024*1024,anchorWire:32768});
export const PB1_PROFILE=digest({domain:'cwc.e2-p0.pb1-local-store.v1',pb0Profile:PB0_PROFILE_DIGEST,limits:PB1_LIMITS});
export const PB1_COMMAND_SCHEMA='cwc.e2-p0.pb1-command.v1';
export const pb1StreamSchema=z.object({realmId:id,owner:z.enum(['registry','custodian','controller','epoch-anchor']),authorityId:id,storeEpoch:hash,keyId:id}).strict();
export type PB1Stream=z.infer<typeof pb1StreamSchema>;
export type PB1Origin=z.infer<typeof pb0OriginSchema>;
const ref=z.object({sha256:hash,byteLength:z.number().int().positive().max(PB1_LIMITS.anchorWire)}).strict();
export const pb1Stages=['intent-reserved','source-captured','response-ready','response-may-have-escaped','failed-or-unknown','mutation-committed'] as const;
const common={schema:z.literal(PB1_COMMAND_SCHEMA),expectedHead:journalHeadSchema,previousStageRef:ref.nullable()};
export const pb1CommandSchema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('stage'),requestWire:z.string().max(16384),stage:z.enum(pb1Stages),dataWire:z.string().max(PB1_LIMITS.data)}).strict(),
 z.object({...common,kind:z.literal('tombstone'),queryWire:z.string().max(16384),origin:pb0OriginSchema}).strict()
]);
export function pb1OriginKey(origin:PB1Origin){const {intentDigest:_,...key}=pb0OriginSchema.parse(origin);return digest({schema:'cwc.e2-p0.pb1-origin.v1',...key});}
export function pb1Command(wire:string){
 const command=pb0Decode(pb1CommandSchema,wire,PB1_LIMITS.command),request=pb0ParseRequest(command.kind==='stage'?command.requestWire:command.queryWire);
 const origin:PB1Origin=command.kind==='tombstone'?command.origin:request.domain==='cwc.e2-p0.backend-request.v2'?{domain:'metadata-read',owner:request.targetOwner,subject:{kind:'job',jobDigest:request.jobDigest},operationKey:request.operationKey,intentDigest:request.intentDigest}:{domain:'control',owner:request.targetOwner,subject:request.targetSubject,operationKey:request.operationKey,intentDigest:request.intentDigest};
 if(command.kind==='tombstone'){
  need(request.domain==='cwc.e2-p0.backend-control.v1'&&request.api==='QueryOperation'&&canonical(request.payload.origin)===canonical(origin),'pb1-tombstone-query');
  need(command.previousStageRef===null,'pb1-tombstone-previous');
 }else{
  need(command.dataWire===canonical(parseOwnedJson(command.dataWire,PB1_LIMITS.data),PB1_LIMITS.data),'pb1-data-canonical');
  need(request.domain==='cwc.e2-p0.backend-request.v2'?command.stage!=='mutation-committed':command.stage==='mutation-committed','pb1-domain-stage');
  need(request.api!=='QueryOperation'&&request.api!=='ReadRecoveryStatus','pb1-query-not-mutation');
 }
 const canonicalWire=canonical(command,PB1_LIMITS.command),originKey=pb1OriginKey(origin),stage=command.kind==='tombstone'?'absent-tombstoned':command.stage;
 return {command,request,origin,originKey,stage,wire:canonicalWire,transactionKey:digest({domain:'cwc.e2-p0.pb1-stage-key.v1',originKey,stage}),intentDigest:ownedSha256(canonicalWire)};
}
export type PB1Command=ReturnType<typeof pb1Command>;
/** Local byte/stage admission arithmetic only; not a physical memory/work certificate. */
export function pb1Reserve(committed:readonly PB1Command[],incoming:PB1Command){
 const cleanup=(e:PB1Command)=>e.command.kind==='tombstone'||e.stage==='failed-or-unknown',normal=committed.filter(e=>!cleanup(e)).length,heldCleanup=committed.length-normal;
 need(committed.length<PB1_LIMITS.stages&&(cleanup(incoming)?heldCleanup<PB1_LIMITS.cleanup:normal<PB1_LIMITS.normal),'pb1-budget-stage');
 const count=committed.length+1,payload=[...committed,incoming].reduce((n,e)=>n+Buffer.byteLength(e.wire),0);
 const held={normal:normal+(cleanup(incoming)?0:1),cleanup:heldCleanup+(cleanup(incoming)?1:0),payload,journal:count*32768,checkpoint:count*8192*2,adoption:count*16384,scratch:Buffer.byteLength(incoming.wire)+65536};
 need(held.payload<=PB1_LIMITS.payload&&held.journal<=PB1_LIMITS.journal&&held.checkpoint<=PB1_LIMITS.checkpoint&&held.adoption<=PB1_LIMITS.adoption&&held.scratch<=PB1_LIMITS.scratch,'pb1-budget-bytes');return held;
}
export const pb1ProposalSchema=z.object({schema:z.literal('cwc.e2-p0.pb1-anchor-cas.v1'),profileDigest:z.literal(PB1_PROFILE),stream:pb1StreamSchema,transactionKey:hash,intentDigest:hash,previousHead:journalHeadSchema,head:journalHeadSchema}).strict();
export type PB1Proposal=z.infer<typeof pb1ProposalSchema>;
export const pb1AnchorValueSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('head'),stream:pb1StreamSchema,challenge:hash,head:journalHeadSchema}).strict(),
 z.object({kind:z.literal('receipt'),proposal:pb1ProposalSchema}).strict(),
 z.object({kind:z.literal('origin'),stream:pb1StreamSchema,challenge:hash,transactionKey:hash,receiptWire:z.string().max(PB1_LIMITS.anchorWire).nullable()}).strict()
]);
const signedSchema=z.object({schema:z.literal('cwc.e2-p0.pb1-anchor-signed.v1'),anchorId:id,keyId:id,value:pb1AnchorValueSchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export const pb1AnchorPinSchema=z.object({anchorId:id,keyId:id,spki:z.string().max(1024),spkiDigest:hash}).strict();
export type PB1AnchorPin=z.infer<typeof pb1AnchorPinSchema>;
/** Must be implemented by an independently pinned authority before runtime adoption. */
export interface PB1AnchorPort {
 head(streamWire:string,challenge:string):Promise<string>;
 compareAndSwap(proposalWire:string):Promise<string>;
 query(streamWire:string,transactionKey:string,challenge:string):Promise<string>;
}
export function pb1VerifyAnchor(wire:string,pin:PB1AnchorPin){
 const s=pb0Decode(signedSchema,wire,PB1_LIMITS.anchorWire);const {signature,...body}=s;
 need(wire===canonical(s,PB1_LIMITS.anchorWire)&&s.anchorId===pin.anchorId&&s.keyId===pin.keyId,'pb1-anchor-pin');
 const bytes=Buffer.from(pin.spki,'base64');need(bytes.toString('base64')===pin.spki&&ownedSha256(bytes)===pin.spkiDigest,'pb1-anchor-key');
 const key=createPublicKey({key:bytes,format:'der',type:'spki'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(body,PB1_LIMITS.anchorWire)),key,Buffer.from(signature,'base64')),'pb1-anchor-signature');return s.value;
}
export function pb1VerifyReceipt(wire:string,pin:PB1AnchorPin,proposal:PB1Proposal){const v=pb1VerifyAnchor(wire,pin);need(v.kind==='receipt'&&canonical(v.proposal)===canonical(proposal),'pb1-anchor-receipt');return {sha256:ownedSha256(wire),byteLength:Buffer.byteLength(wire)};}
export function pb1Genesis(stream:PB1Stream):JournalHead{return journalGenesis({authorityId:stream.authorityId,storeEpoch:stream.storeEpoch,keyId:stream.keyId});}
export const pb1Same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
