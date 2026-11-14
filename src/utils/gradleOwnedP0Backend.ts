/** Independently pinned, mutually signed read-only metadata backend protocol. No job admission. */
import {createPublicKey,randomBytes,sign,verify,type KeyObject} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {visit} from 'jsonc-parser';
import {canonicalOwnedJson as canonical,ownedDigest as digest,parseOwnedJson} from './gradleOwnedJson.js';
import {p0UnixExchange,P0_FRAME_MAX} from './gradleOwnedP0Socket.js';
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),hash=z.string().regex(/^[a-f0-9]{64}$/),uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const peer=z.object({principal:id,keyId:id,spki:z.string().max(128),boot:hash,socket:z.string().min(1).max(100).regex(/^\//)}).strict();
export const p0BackendConfigSchema=z.object({schema:z.literal('cwc.e2-p0.backend-config.v1'),scope:z.literal('metadata-only'),
 client:z.object({principal:id,keyId:id,spki:z.string().max(128)}).strict(),peers:z.object({registry:peer,custodian:peer,controller:peer}).strict()}).strict();
export type P0BackendConfig=z.infer<typeof p0BackendConfigSchema>;
export const P0_BACKEND_APIS=['ReadPins','ReadAcquisition','ReadPreflight','ReadLive'] as const;
export type P0BackendAPI=typeof P0_BACKEND_APIS[number];
const apiRole={ReadPins:'registry',ReadAcquisition:'custodian',ReadPreflight:'controller',ReadLive:'registry'} as const;
const requestSchema=z.object({domain:z.literal('cwc.e2-p0.backend-request.v1'),api:z.enum(P0_BACKEND_APIS),
 client:id,keyId:id,server:id,serverBoot:hash,session:hash,nonce:hash,sequence:uint.positive().max(8),jobDigest:hash,maxWaitMs:uint.positive().max(5000)}).strict();
export const p0BackendRequestSchema=z.object({payload:requestSchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export type P0BackendRequest=z.infer<typeof p0BackendRequestSchema>['payload'];
const replySchema=z.object({domain:z.literal('cwc.e2-p0.backend-reply.v1'),api:z.enum(P0_BACKEND_APIS),server:id,keyId:id,serverBoot:hash,
 requestDigest:hash,jobDigest:hash,nonce:hash,sequence:uint.positive().max(8),
 result:z.discriminatedUnion('status',[
  z.object({status:z.literal('available'),wire:z.string().max(P0_FRAME_MAX)}).strict(),
  z.object({status:z.literal('unavailable'),reason:z.enum(['evidence-unavailable','approval-unavailable','reservation-unavailable','backend-recovering'])}).strict()
 ])}).strict();
export const p0BackendReplySchema=z.object({payload:replySchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export class P0BackendError extends Error{constructor(readonly reason:string){super(reason);}}
const need=(ok:unknown,reason:string):void=>{if(!ok)throw new P0BackendError(reason);};
export function p0Decode<T>(schema:z.ZodType<T>,wire:string):T{
 need(typeof wire==='string'&&Buffer.byteLength(wire)<=P0_FRAME_MAX,'backend-metadata-budget');
 let depth=0,nodes=0;const enter=()=>{if(++depth>24||++nodes>65536)throw new P0BackendError('backend-metadata-budget');};
 visit(wire,{onObjectBegin:enter,onArrayBegin:enter,onObjectEnd:()=>{depth--;},onArrayEnd:()=>{depth--;},onLiteralValue:()=>{if(++nodes>65536)throw new P0BackendError('backend-metadata-budget');}});
 try{return schema.parse(parseOwnedJson(wire,P0_FRAME_MAX));}catch(e){if(e instanceof P0BackendError)throw e;throw new P0BackendError('backend-schema-invalid');}
}
function publicKey(spki:string){const key=createPublicKey({key:Buffer.from(spki,'base64'),type:'spki',format:'der'});need(key.asymmetricKeyType==='ed25519'&&key.export({format:'der',type:'spki'}).toString('base64')===spki,'backend-key-invalid');return key;}
function signed(payload:unknown,key:KeyObject){return {payload,signature:sign(null,Buffer.from(canonical(payload,P0_FRAME_MAX)),key).toString('base64')};}
function authentic(payload:unknown,signature:string,spki:string){need(Buffer.from(signature,'base64').toString('base64')===signature&&verify(null,Buffer.from(canonical(payload,P0_FRAME_MAX)),publicKey(spki),Buffer.from(signature,'base64')),'backend-signature-invalid');}
export interface P0BackendOptions{exchange?:(path:string,wire:Buffer,timeoutMs:number,signal:AbortSignal)=>Promise<Buffer>;now?:()=>number}
export type P0Backend=Readonly<{kind:'p0-backend'}>;
type Facts={config:P0BackendConfig;key:KeyObject;exchange:NonNullable<P0BackendOptions['exchange']>;now:()=>number;deadline:number;last:number;session:string;calls:number;bytes:number;closed:boolean;closeEpoch:number;busy:boolean;abort:AbortController};
const clients=new WeakMap<P0Backend,Facts>();
export function connectP0Backend(configWire:string,privateKey:KeyObject,options:P0BackendOptions={}):P0Backend{
 const config=p0Decode(p0BackendConfigSchema,configWire),owners=[config.client,...Object.values(config.peers)];
 for(const k of ['principal','keyId','spki'] as const)need(new Set(owners.map(o=>o[k])).size===4,'backend-owner-separation');
 owners.forEach(o=>publicKey(o.spki));need(privateKey.type==='private'&&privateKey.asymmetricKeyType==='ed25519'&&createPublicKey(privateKey).export({format:'der',type:'spki'}).toString('base64')===config.client.spki,'backend-client-key-mismatch');
 const now=options.now??(()=>Math.floor(performance.now())),started=now();need(Number.isSafeInteger(started)&&started>=0&&Number.isSafeInteger(started+5000),'backend-clock-invalid');
 const handle=Object.freeze({kind:'p0-backend' as const});clients.set(handle,{config,key:privateKey,exchange:options.exchange??p0UnixExchange,now,deadline:started+5000,last:started,
  session:randomBytes(32).toString('hex'),calls:0,bytes:0,closed:false,closeEpoch:0,busy:false,abort:new AbortController()});return handle;
}
function facts(h:P0Backend){const f=clients.get(h);if(!f)throw new P0BackendError('backend-handle-invalid');return f;}
function current(f:Facts){const now=f.now();need(!f.closed&&!f.abort.signal.aborted&&Number.isSafeInteger(now)&&now>=f.last&&now<f.deadline,'backend-expired-or-closed');f.last=now;return f.deadline-now;}
export function closeP0Backend(h:P0Backend){const f=facts(h);f.closeEpoch++;f.closed=true;f.abort.abort();}
/** Last action before returning an already formatted verified result. Cleanup callbacks run BEFORE the final clock/fence check. */
export function finishP0Backend(h:P0Backend){
 const f=facts(h);current(f);need(!f.busy,'backend-reentry');
 const expectedClose=f.closeEpoch+1;closeP0Backend(h);
 const now=f.now();
 need(f.closed&&f.closeEpoch===expectedClose&&Number.isSafeInteger(now)&&now>=f.last&&now<f.deadline,'backend-expired-or-closed');f.last=now;
}
export function inspectP0Backend(h:P0Backend){const f=facts(h);return {calls:f.calls,wireBytes:f.bytes,closed:f.closed,deadline:f.deadline};}
export function p0BackendOwners(h:P0Backend){return structuredClone(facts(h).config);}
export async function readP0Backend(h:P0Backend,api:P0BackendAPI,jobDigest:string):Promise<z.infer<typeof replySchema>['result']>{
 const f=facts(h);if(f.busy){closeP0Backend(h);throw new P0BackendError('backend-reentry');}f.busy=true;
 try{
  const wait=current(f);need(P0_BACKEND_APIS.includes(api)&&hash.safeParse(jobDigest).success,'backend-request-invalid');need(f.calls<8&&f.bytes+2*(P0_FRAME_MAX+4)<=8*P0_FRAME_MAX,'backend-budget-exceeded');
  const server=f.config.peers[apiRole[api]],payload: P0BackendRequest={domain:'cwc.e2-p0.backend-request.v1',api,client:f.config.client.principal,keyId:f.config.client.keyId,server:server.principal,serverBoot:server.boot,
   session:f.session,nonce:randomBytes(32).toString('hex'),sequence:++f.calls,jobDigest,maxWaitMs:wait};
  const request=signed(payload,f.key),wire=Buffer.from(canonical(request,P0_FRAME_MAX));f.bytes+=wire.length+4;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{closeP0Backend(h);reject(new P0BackendError('backend-timeout'));},wait);});
  let bytes:Buffer;
  try{bytes=await Promise.race([f.exchange(server.socket,wire,wait,f.abort.signal),timeout]);}finally{clearTimeout(timer);}
  current(f);need(Buffer.isBuffer(bytes)&&bytes.length<=P0_FRAME_MAX,'backend-frame-budget');f.bytes+=bytes.length+4;need(f.bytes<=8*P0_FRAME_MAX,'backend-budget-exceeded');
  const reply=p0Decode(p0BackendReplySchema,new TextDecoder('utf-8',{fatal:true}).decode(bytes)),r=reply.payload;authentic(r,reply.signature,server.spki);
  need(r.api===api&&r.server===server.principal&&r.keyId===server.keyId&&r.serverBoot===server.boot&&r.jobDigest===jobDigest&&r.requestDigest===digest(request)&&r.nonce===payload.nonce&&r.sequence===payload.sequence,'backend-reply-binding');
  current(f);return r.result;
 }catch(e){closeP0Backend(h);throw e instanceof P0BackendError?e:new P0BackendError('backend-unavailable');}finally{f.busy=false;}
}
/** Service-side read-only adapter. Its source port must be bound to a separately provisioned owner. */
export class P0MetadataServer{
 #seen=new Set<string>();#closed=false;#active=0;#config:P0BackendConfig;#role:'registry'|'custodian'|'controller';#key:KeyObject;
 #lookup:(api:P0BackendAPI,jobDigest:string)=>Promise<z.infer<typeof replySchema>['result']>;
 constructor(config:P0BackendConfig,role:'registry'|'custodian'|'controller',key:KeyObject,
  lookup:(api:P0BackendAPI,jobDigest:string)=>Promise<z.infer<typeof replySchema>['result']>){
  this.#config=p0Decode(p0BackendConfigSchema,JSON.stringify(config));this.#role=role;this.#key=key;this.#lookup=lookup;
  need(key.type==='private'&&key.asymmetricKeyType==='ed25519'&&createPublicKey(key).export({format:'der',type:'spki'}).toString('base64')===this.#config.peers[role].spki,'backend-server-key-mismatch');
 }
 close(){this.#closed=true;}
 async respond(bytes:Buffer):Promise<Buffer>{
  need(!this.#closed&&this.#active<4&&Buffer.isBuffer(bytes)&&bytes.length<=P0_FRAME_MAX,'backend-service-unavailable');
  const e=p0Decode(p0BackendRequestSchema,new TextDecoder('utf-8',{fatal:true}).decode(bytes)),p=e.payload,peer=this.#config.peers[this.#role];
  authentic(p,e.signature,this.#config.client.spki);
  need(p.client===this.#config.client.principal&&p.keyId===this.#config.client.keyId&&p.server===peer.principal&&p.serverBoot===peer.boot&&apiRole[p.api]===this.#role,'backend-api-denied');
  const key=digest(e);need(!this.#seen.has(key)&&this.#seen.size<256,'backend-replay-or-budget');this.#seen.add(key);this.#active++;
  const started=performance.now();
  try{const result=await this.#lookup(p.api,p.jobDigest);need(!this.#closed&&performance.now()-started<p.maxWaitMs,'backend-service-expired');
   const payload=replySchema.parse({domain:'cwc.e2-p0.backend-reply.v1',api:p.api,server:peer.principal,keyId:peer.keyId,serverBoot:peer.boot,requestDigest:key,jobDigest:p.jobDigest,nonce:p.nonce,sequence:p.sequence,result});
   const wire=Buffer.from(canonical(signed(payload,this.#key),P0_FRAME_MAX));need(!this.#closed&&performance.now()-started<p.maxWaitMs,'backend-service-expired');return wire;
  }finally{this.#active--;}
 }
}
