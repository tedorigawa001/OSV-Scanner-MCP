/** Real signed codec and a memory-only transport-budget fixture. Never dispatches, reserves a real parent, or admits IO. */
import {createPublicKey,sign,verify,type KeyObject} from 'node:crypto';
import {types} from 'node:util';
import {z} from 'zod';
import {canonicalOwnedJson as canonical,ownedDigest as digest,ownedSha256} from './gradleOwnedJson.js';
import {PB0ContractError,PB0_LIMITS,PB0_PROFILE_DIGEST,pb0Need,pb0Decode,pb0RefSchema as ref,pb0OriginSchema,pb0RequestSchema,pb0ParseRequest,pb0ParsePolicy,pb0Authorize,type PB0Request} from './gradleOwnedP0StateContract.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const signature=z.string().regex(/^[A-Za-z0-9+/]{86}==$/),sigPlaceholder='A'.repeat(86)+'==';
const refs=z.array(ref).max(128).refine(a=>new Set(a.map(r=>r.id)).size===a.length,'duplicate-ref');
const requestEnvelope=z.object({payload:pb0RequestSchema,signature}).strict();
const pinSchema=z.object({principal:id,keyEpoch:uint.positive(),owner:z.enum(['registry','custodian','controller','epoch-anchor']),boot:hash,spki:z.string().min(1).max(128)}).strict();
const controlResult=z.object({kind:z.literal('control'),outcome:z.enum(['committed','historical','pending','absent']),origin:pb0OriginSchema.nullable(),receiptRef:ref.nullable(),anchorRef:ref.nullable(),adoptionRef:ref.nullable(),tombstoneRef:ref.nullable(),issuedRef:ref.nullable(),historicalIssuedRef:ref.optional()}).strict();
const resultSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('metadata'),sourceRefs:refs,bodyWire:z.string().max(1048576),bodyDigest:hash,responseReadyRef:ref,escapeRef:ref}).strict(),controlResult,
 z.object({kind:z.literal('rejected'),reason:z.enum(['unsupported','invalid','permission-denied','revoked-or-expired','operation-conflict','budget-exceeded','blocked-recovery-required']),jobPermitIssued:z.literal(false),runtimeAdmitted:z.literal(false)}).strict()
]);
const replyPayload=z.object({domain:z.literal('cwc.e2-p0.backend-reply.v2'),profileDigest:z.literal(PB0_PROFILE_DIGEST),realmId:id,server:id,keyEpoch:uint.positive(),owner:pinSchema.shape.owner,serverBoot:hash,requestDigest:hash,operationKey:hash,intentDigest:hash,nonce:hash,sequence:uint.positive().max(256),result:resultSchema}).strict();
const replyEnvelope=z.object({payload:replyPayload,signature}).strict();
const typed=Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter=Object.getOwnPropertyDescriptor(typed,'buffer')!.get!,lengthGetter=Object.getOwnPropertyDescriptor(typed,'byteLength')!.get!,byteSet=Uint8Array.prototype.set;
function copy(frame:Buffer,cap:number){
 pb0Need(types.isUint8Array(frame),'frame-type');const buffer=bufferGetter.call(frame),length=lengthGetter.call(frame) as number;
 pb0Need(!types.isSharedArrayBuffer(buffer)&&length>=4&&length<=cap+4,'frame-budget');const own=Buffer.alloc(length);byteSet.call(own,frame);return own;
}
function unframe(input:Buffer,cap:number){const b=copy(input,cap),n=b[0]!*16777216+b[1]!*65536+b[2]!*256+b[3]!;pb0Need(n===b.length-4&&n<=cap,'frame-length');
 try{return new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(bufferGetter.call(b),b.byteOffset+4,n));}catch{throw new PB0ContractError('frame-utf8');}}
function frame(wire:string,cap:number){const n=Buffer.byteLength(wire);pb0Need(n<=cap,'codec-budget');const b=Buffer.alloc(n+4);b.writeUInt32BE(n);b.write(wire,4,'utf8');return b;}
function key(spki:string){try{const k=createPublicKey({key:Buffer.from(spki,'base64'),type:'spki',format:'der'});pb0Need(k.asymmetricKeyType==='ed25519'&&k.export({format:'der',type:'spki'}).toString('base64')===spki,'codec-key');return k;}catch{throw new PB0ContractError('codec-key');}}
function signed(payload:unknown,k:KeyObject,cap:number){
 pb0Need(k.type==='private'&&k.asymmetricKeyType==='ed25519','codec-private-key');
 // Ed25519 signatures have fixed canonical base64 length. Refuse before signing if the complete envelope cannot fit.
 const measured=Buffer.byteLength(canonical({payload,signature:sigPlaceholder},1048576));pb0Need(measured<=cap,'codec-budget');
 const s=sign(null,Buffer.from(canonical(payload,1048576)),k).toString('base64'),wire=canonical({payload,signature:s},1048576);
 pb0Need(Buffer.byteLength(wire)===measured,'codec-estimate');return frame(wire,cap);
}
function authentic(payload:unknown,s:string,spki:string){pb0Need(Buffer.from(s,'base64').toString('base64')===s&&verify(null,Buffer.from(canonical(payload,1048576)),key(spki),Buffer.from(s,'base64')),'codec-signature');}
function parseRequestFrame(frame:Buffer){const wire=unframe(frame,16384),e=pb0Decode(requestEnvelope,wire,16384);pb0Need(canonical(e,16384)===wire,'codec-canonical');pb0ParseRequest(canonical(e.payload,16384));return e;}
export function pb0EncodeRequest(wire:string,k:KeyObject){return signed(pb0ParseRequest(wire),k,16384);}
export function pb0DecodeRequest(frame:Buffer,policyWire:string,now:number){const e=parseRequestFrame(frame),p=pb0ParsePolicy(policyWire);authentic(e.payload,e.signature,p.spki);
 const check=pb0Authorize(canonical(e.payload,16384),policyWire,now);return {...check,request:e.payload};}
function replyCap(r:PB0Request){return r.domain==='cwc.e2-p0.backend-request.v2'?1048576:65536;}
function checkResult(r:PB0Request,v:z.infer<typeof resultSchema>){
 if(v.kind==='rejected')return;
 if(r.domain==='cwc.e2-p0.backend-request.v2'){
  pb0Need(v.kind==='metadata','reply-result-kind');
  const sorted=(xs:z.infer<typeof refs>)=>[...xs].sort((a,b)=>a.id.localeCompare(b.id));pb0Need(canonical(sorted(v.sourceRefs))===canonical(sorted(r.exactSourceRefs)),'reply-source-refs');
  const body=pb0Decode(z.unknown(),v.bodyWire);pb0Need(canonical(body,1048576)===v.bodyWire&&ownedSha256(v.bodyWire)===v.bodyDigest,'reply-body');
  pb0Need(v.responseReadyRef.id!==v.escapeRef.id&&v.responseReadyRef.sha256!==v.escapeRef.sha256,'reply-separate-escape');return;
 }
 pb0Need(v.kind==='control','reply-result-kind');
 if(r.api==='QueryOperation')pb0Need(v.outcome!=='committed'&&canonical(v.origin)===canonical(r.payload.origin)&&v.issuedRef===null,'query-result');
 else pb0Need(v.origin===null&&v.outcome!=='absent','control-result-origin');
 if(v.outcome==='committed'||v.outcome==='historical')pb0Need(v.receiptRef&&v.anchorRef&&v.adoptionRef&&v.tombstoneRef===null,'reply-durable-refs');
 if(v.outcome==='pending')pb0Need(v.receiptRef===null&&v.issuedRef===null&&v.tombstoneRef===null,'pending-result');
 if(v.outcome==='absent')pb0Need(v.receiptRef===null&&v.tombstoneRef&&v.anchorRef&&v.adoptionRef&&v.issuedRef===null,'absent-tombstone');
 // A query never issues; it may only report the ref an earlier committed Begin / grant already issued.
 pb0Need(v.historicalIssuedRef===undefined||(r.api==='QueryOperation'&&v.outcome==='historical'),'historical-issued-ref');
 if(r.api==='BeginWorkflow'||r.api==='IssueReaderGrant')pb0Need(v.outcome==='committed'?v.issuedRef!==null:v.issuedRef===null,'reply-issued-ref');
 else pb0Need(v.issuedRef===null,'unexpected-issued-ref');
}
export function pb0EncodeReply(requestWire:string,resultWire:string,pinWire:string,k:KeyObject){
 const r=pb0ParseRequest(requestWire),p=pb0Decode(pinSchema,pinWire),result=pb0Decode(resultSchema,resultWire);checkResult(r,result);
 pb0Need(p.owner===r.targetOwner&&p.boot===r.serverBoot&&createPublicKey(k).export({format:'der',type:'spki'}).toString('base64')===p.spki,'reply-signer');
 const payload=replyPayload.parse({domain:'cwc.e2-p0.backend-reply.v2',profileDigest:PB0_PROFILE_DIGEST,realmId:r.realmId,server:p.principal,keyEpoch:p.keyEpoch,owner:p.owner,serverBoot:p.boot,requestDigest:digest(r),operationKey:r.operationKey,intentDigest:r.intentDigest,nonce:r.nonce,sequence:r.sequence,result});
 return signed(payload,k,replyCap(r));
}
export function pb0DecodeReply(frame:Buffer,requestWire:string,pinWire:string){
 const r=pb0ParseRequest(requestWire),p=pb0Decode(pinSchema,pinWire),wire=unframe(frame,replyCap(r)),e=pb0Decode(replyEnvelope,wire,replyCap(r));
 pb0Need(canonical(e,1048576)===wire,'codec-canonical');authentic(e.payload,e.signature,p.spki);const v=e.payload;
 pb0Need(p.owner===r.targetOwner&&p.boot===r.serverBoot&&v.profileDigest===r.profileDigest&&v.realmId===r.realmId&&v.owner===r.targetOwner&&v.server===p.principal&&v.keyEpoch===p.keyEpoch&&v.serverBoot===p.boot&&v.requestDigest===digest(r)&&v.operationKey===r.operationKey&&v.intentDigest===r.intentDigest&&v.nonce===r.nonce&&v.sequence===r.sequence,'reply-binding');
 checkResult(r,v.result);return v;
}
const budgetSchema=z.object({schema:z.literal('cwc.e2-p0.pb0-budget.v1'),profileDigest:z.literal(PB0_PROFILE_DIGEST),initId:id,realmId:id,jobDigest:hash,credentialId:id,credentialKeyEpoch:uint.positive(),beginControlKey:hash,beginControlIntent:hash,
 t0:uint.max(Number.MAX_SAFE_INTEGER-5000),originalDeadline:uint,jobDeadline:uint,grantDeadline:uint,approvalDeadline:uint,reservationDeadline:uint,
 prepaidRefs:z.object({wire:ref,memory:ref,work:ref,store:ref,cleanup:ref}).strict(),sliceDigests:z.object({initControl:hash,metadataRead:hash,metadataRetry:hash,metadataAudit:hash}).strict(),
 parentWire:z.literal(8388608),initWire:z.literal(163856),metadataWire:z.literal(8224752),initCalls:z.literal(2),metadataCalls:z.literal(8),workUpper:z.null(),memoryUpper:z.null()
}).strict();
export type PB0FixtureTicket=Readonly<{kind:'pb0-fixture-ticket'}>;
type Group='begin'|'initQuery'|'read'|'retry'|'audit';
type Ticket={owner:PB0BudgetFixture;requestWire:string;reserved:number;active:boolean;replyCap:number;group:Group;operationKey:string;intent:string;targetOwner:string};
const tickets=new WeakMap<PB0FixtureTicket,Ticket>();
/** Transport accounting simulation ONLY: supplied prepaid refs are never verified as real parent reservations. */
export class PB0BudgetFixture{
 #plan:z.infer<typeof budgetSchema>;#last:number;#closed=false;#counts={begin:0,initQuery:0,read:0,retry:0,audit:0};#held={init:0,metadata:0};#observed=0;#unknown=0;#seen=new Map<string,{intent:string;domain:string;owner:string}>();#workflow:string|null=null;#beginUnresolved=false;#lost=new Map<string,{intent:string;owner:string}>();#retryable=0;
 constructor(wire:string){this.#plan=pb0Decode(budgetSchema,wire);const p=this.#plan;
  pb0Need(p.originalDeadline===Math.min(p.t0+5000,p.jobDeadline,p.grantDeadline,p.approvalDeadline,p.reservationDeadline)&&p.originalDeadline>p.t0,'budget-original-deadline');this.#last=p.t0;
 }
 #current(now:number){if(!(uint.safeParse(now).success&&now>=this.#last&&now<this.#plan.originalDeadline&&!this.#closed)){this.#closed=true;throw new PB0ContractError('budget-expired-or-closed');}this.#last=now;}
 reserve(requestWire:string,now:number):PB0FixtureTicket{
  this.#current(now);const r=pb0ParseRequest(requestWire),p=this.#plan;
  pb0Need(r.realmId===p.realmId&&r.clientCredentialId===p.credentialId&&r.clientKeyEpoch===p.credentialKeyEpoch,'budget-call-scope');
  const prior=this.#seen.get(r.operationKey);pb0Need(!prior,prior?.intent===r.intentDigest?'budget-repeat-operation':'operation-conflict');
  let group:Group,init=false,cap=1048576;
  if(r.domain==='cwc.e2-p0.backend-request.v2'){
   pb0Need(r.jobDigest===p.jobDigest&&r.originalDeadline===p.originalDeadline,'budget-read-binding');
   // Metadata starts only on the workflow ref issued by a committed Begin or reported by its bounded historical query.
   pb0Need(this.#workflow!==null,'budget-workflow-unestablished');pb0Need(r.workflowId===this.#workflow,'budget-workflow-change');
   group=r.budgetSliceRef.kind==='metadata-retry'?'retry':'read';
   pb0Need(r.budgetSliceRef.sha256===(group==='retry'?p.sliceDigests.metadataRetry:p.sliceDigests.metadataRead),'budget-slice-binding');
   pb0Need(this.#counts[group]<(group==='retry'?1:5),'budget-call-count');if(group==='retry')pb0Need(this.#retryable>0,'budget-retry-without-loss');
  }else{
   pb0Need(r.targetSubject.kind==='job'&&r.targetSubject.jobDigest===p.jobDigest&&r.originalControlDeadline===p.originalDeadline,'budget-control-binding');cap=65536;
   if(r.api==='BeginWorkflow'){
    pb0Need(r.operationKey===p.beginControlKey&&r.intentDigest===p.beginControlIntent,'budget-begin-binding');group='begin';init=true;pb0Need(this.#counts.begin===0,'budget-begin-repeat');
   }else{
    pb0Need(r.api==='QueryOperation','budget-maintenance-excluded');const origin=r.payload.origin;
    if(r.controlBudgetSliceRef.kind==='init-control'){
     pb0Need(origin.domain==='control'&&origin.owner==='registry'&&origin.operationKey===p.beginControlKey&&origin.intentDigest===p.beginControlIntent&&this.#counts.begin===1,'budget-init-query-origin');pb0Need(this.#beginUnresolved,'budget-init-query-without-loss');group='initQuery';init=true;pb0Need(this.#counts.initQuery===0,'budget-init-query-count');
    }else{
     // Audit is only for a metadata read whose reply was lost; a completed read has nothing unresolved to query.
     const saved=this.#lost.get(origin.operationKey);pb0Need(r.controlBudgetSliceRef.kind==='metadata-audit'&&origin.domain==='metadata-read'&&saved?.intent===origin.intentDigest&&saved.owner===origin.owner,'budget-audit-origin');group='audit';pb0Need(this.#counts.audit<2,'budget-audit-count');
    }
   }
   pb0Need(r.controlBudgetSliceRef.sha256===(init?p.sliceDigests.initControl:p.sliceDigests.metadataAudit),'budget-slice-binding');
  }
  const reserved=16384+cap+8,side=init?'init':'metadata';
  pb0Need(this.#held[side]+reserved<=(init?p.initWire:p.metadataWire)&&this.#held.init+this.#held.metadata+reserved<=p.parentWire,'budget-wire');
  // All bounded slot/parent charges precede signing or accepting a result. They survive loss and failure.
  this.#counts[group]++;this.#held[side]+=reserved;if(group==='retry')this.#retryable--;this.#seen.set(r.operationKey,{intent:r.intentDigest,domain:r.domain,owner:r.targetOwner});
  const h=Object.freeze({kind:'pb0-fixture-ticket' as const});tickets.set(h,{owner:this,requestWire:canonical(r,16384),reserved,active:true,replyCap:cap,group,operationKey:r.operationKey,intent:r.intentDigest,targetOwner:r.targetOwner});return h;
 }
 complete(h:PB0FixtureTicket,requestFrame:Buffer,replyFrame:Buffer,pinWire:string,now:number){
  const t=tickets.get(h);pb0Need(t&&t.owner===this&&t.active,'budget-ticket');t.active=false;
  try{const req=copy(requestFrame,16384),rep=copy(replyFrame,t.replyCap);this.#observed+=req.length+rep.length;this.#current(now);
   pb0Need(canonical(parseRequestFrame(req).payload,16384)===t.requestWire,'budget-request-swap');
   pb0Need(req.length+rep.length<=t.reserved&&this.#observed<=this.#plan.parentWire,'budget-actual-wire');
   const result=pb0DecodeReply(rep,t.requestWire,pinWire);this.#current(now);const v=result.result;
   if(t.group==='begin'){if(v.kind==='control'&&v.outcome==='committed')this.#workflow=v.issuedRef!.id;else if(v.kind==='control')this.#beginUnresolved=true;}
   if(t.group==='initQuery'&&v.kind==='control'&&v.outcome==='historical'&&v.historicalIssuedRef)this.#workflow=v.historicalIssuedRef.id;
   return result;
  }catch(e){this.#closed=true;this.#unknown++;throw e;}
 }
 lose(h:PB0FixtureTicket,now:number){const t=tickets.get(h);pb0Need(t&&t.owner===this&&t.active,'budget-ticket');t.active=false;this.#unknown++;
  if(t.group==='begin')this.#beginUnresolved=true;
  if(t.group==='read'||t.group==='retry'){this.#lost.set(t.operationKey,{intent:t.intent,owner:t.targetOwner});if(t.group==='read')this.#retryable++;}
  this.#current(now);}
 close(){this.#closed=true;}
 inspect(){return {counts:{...this.#counts},heldWire:{...this.#held},wireBytesObserved:this.#observed,unknownAttempts:this.#unknown,closed:this.#closed,originalDeadline:this.#plan.originalDeadline,jobPermitIssued:false as const,runtimeAdmitted:false as const,realReservationVerified:false as const,workUpper:this.#plan.workUpper,memoryUpper:this.#plan.memoryUpper};}
}
