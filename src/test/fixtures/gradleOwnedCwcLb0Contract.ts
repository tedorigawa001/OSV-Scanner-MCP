/** CLB-0 fixture primitives. No production admission, planner wiring or hash elision. */
import {z} from 'zod';
import {types} from 'node:util';
import {createPublicKey,verify} from 'node:crypto';
import {posix} from 'node:path';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,chash} from '../../utils/gradleOwnedCurrentSchema.js';

export const LB0_POLICY=Object.freeze({profile:'cwc.session-owned-call-binding.v1',stage:'CLB-0-full-verification',memory:1048576,work:156978,inner:8192,outer:16384,baseBytes:393216,callBytes:98304,bindingBytes:8192,maxChecks:4096});
export const LB0_MODES=['full-reference','bound-live'] as const;
export type Lb0Mode=typeof LB0_MODES[number];
export const LB0_APIS=['aux.ReadSourceDescriptor','aux.ReadSealedSource','aux.ReadSourceRanges'] as const;
export function freezeData<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freezeData(x);Object.freeze(v);}return v;}
/** Reject getters/proxies before cloning. Inputs come from the approved in-process fixture boundary. */
export function copyData<T>(value:T,max=65536):T{
 let nodes=0,strings=0;const active=new Set<object>();
 function plain(v:unknown,depth:number){
  need(++nodes<=8192&&depth<=24,'codec_budget_exceeded');
  if(v===null||typeof v==='boolean')return;
  if(typeof v==='string'){strings+=Buffer.byteLength(v);need(strings<=max,'codec_budget_exceeded');return;}
  if(typeof v==='number'){need(Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0),'schema_invalid');return;}
  need(typeof v==='object'&&!types.isProxy(v)&&!active.has(v),'schema_invalid');
  need([Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),'schema_invalid');
  active.add(v);for(const key of Reflect.ownKeys(v)){need(typeof key==='string','schema_invalid');strings+=Buffer.byteLength(key);need(strings<=max,'codec_budget_exceeded');const d=Object.getOwnPropertyDescriptor(v,key)!;need('value'in d,'schema_invalid');if(Array.isArray(v)&&key==='length')continue;plain(d.value,depth+1);}active.delete(v);
 }
 plain(value,0);need(Buffer.byteLength(canonical(value,max))<=max,'codec_budget_exceeded');return structuredClone(value);
}
// Use the trusted intrinsics on the real TypedArray slots, never input accessors or methods.
const typedArrayPrototype=Object.getPrototypeOf(Uint8Array.prototype);
const backingGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'buffer')!.get!;
const lengthGetter=Object.getOwnPropertyDescriptor(typedArrayPrototype,'length')!.get!;
const typedArraySet=Uint8Array.prototype.set;
const bufferLength=(value:Buffer)=>Reflect.apply(lengthGetter,value,[]) as number;
export function ordinaryBuffer(value:unknown,max:number):asserts value is Buffer{
 need(value!==null&&typeof value==='object'&&!types.isProxy(value)&&types.isUint8Array(value)&&Object.getPrototypeOf(value)===Buffer.prototype,'schema_invalid');
 for(const key of ['buffer','length','byteLength','byteOffset','copy'])need(!Object.hasOwn(value,key),'schema_invalid');
 const backing=Reflect.apply(backingGetter,value,[]),length=bufferLength(value as Buffer);
 need(types.isArrayBuffer(backing)&&length>0&&length<=max,'codec_budget_exceeded');
}
export function dedicated(value:Buffer){
 ordinaryBuffer(value,LB0_POLICY.outer);const b=Buffer.alloc(bufferLength(value));
 Reflect.apply(typedArraySet,b,[value]);return b;
}

const approvalSchema=z.object({schema:z.literal('cwc-lb0.approval.v1'),policyDigest:chash,node:z.string(),sources:z.record(z.string(),chash)}).strict();
const envelopeSchema=z.object({manifest:approvalSchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
const registrySchema=z.object({schema:z.literal('cwc-lb0.registry.v1'),manifestDigest:chash,operatorSpki:z.string().max(128)}).strict();
const approvals=new WeakSet<object>();
export class Lb0Approval{
 readonly #pin:string;readonly #current:()=>string;#open=true;
 constructor(envelopeInput:unknown,registryInput:unknown,pin:string,sources:Record<string,Buffer>,current:()=>string){
  const r=parsed(registrySchema,copyData(registryInput)),e=parsed(envelopeSchema,copyData(envelopeInput));
  need(hash(r)===pin&&hash(e.manifest)===r.manifestDigest&&e.manifest.policyDigest===hash(LB0_POLICY)&&e.manifest.node===process.version,'codec_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.operatorSpki,'base64'),format:'der',type:'spki'});
  need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(e.manifest)),key,Buffer.from(e.signature,'base64')),'codec_profile_unsupported');
  const names=Object.keys(e.manifest.sources);need(names.length>0&&names.length<=256&&canonical(names.sort())===canonical(Object.keys(sources).sort()),'codec_profile_unsupported');
  for(const root of ['src/test/fixtures/gradleOwnedCwcLb0.ts','src/test/fixtures/gradleOwnedCwcLb0Contract.ts','src/test/fixtures/gradleOwnedCwcLb0Fixture.ts'])need(Object.hasOwn(sources,root),'codec_profile_unsupported');
  let bytes=0;for(const [p,digest]of Object.entries(e.manifest.sources)){
   need(p.startsWith('src/')||['package-lock.json','tsconfig.json','vitest.config.ts'].includes(p),'codec_profile_unsupported');
   const source=sources[p];need(!p.split('/').includes('..')&&Buffer.isBuffer(source)&&(bytes+=source.length)<=8388608&&sha(source)===digest,'codec_profile_unsupported');
   for(const m of source.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let target=posix.normalize(posix.join(posix.dirname(p),m[1]!));if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';need(Object.hasOwn(sources,target),'codec_profile_unsupported');}
  }
  this.#pin=pin;this.#current=current;approvals.add(this);this.assertCurrent();Object.freeze(this);
 }
 assertCurrent(){try{need(this.#open&&this.#current()===this.#pin,'codec_profile_unsupported');}catch(e){this.#open=false;throw e;}}
 close(){this.#open=false;}
 static require(value:Lb0Approval){need(approvals.has(value),'codec_profile_unsupported');value.assertCurrent();}
}

export type Lb0Balance={work:number;initialization:number;wire:number;attempts:number};
type MemoryTicket=Readonly<{kind:'lb0-memory-reservation'}>;
const budgets=new WeakSet<object>();
/** Actual shared mutable balance, not a caller-provided prepaid flag. Initialization is separately labelled. */
export class Lb0Budget{
 readonly #balance:Lb0Balance;readonly #memory:number;readonly #work:number;readonly #slots:number;
 #held=0;#active=0;#peak=0;#last={work:0,initialization:0,wire:0,attempts:0};readonly #tickets=new WeakMap<MemoryTicket,{remaining:number;slotOpen:boolean}>();
 constructor(balance:Lb0Balance={work:0,initialization:0,wire:0,attempts:0},memory=1048576,work=156978,slots=4){
  need(balance&&typeof balance==='object'&&!types.isProxy(balance)&&Object.getPrototypeOf(balance)===Object.prototype,'codec_budget_exceeded');
  need(Number.isSafeInteger(memory)&&memory>=0&&memory<=LB0_POLICY.memory&&Number.isSafeInteger(work)&&work>=0&&work<=LB0_POLICY.work&&Number.isSafeInteger(slots)&&slots>0&&slots<=64,'codec_budget_exceeded');
  this.#balance=balance;this.#memory=memory;this.#work=work;this.#slots=slots;this.check();budgets.add(this);Object.freeze(this);
 }
 check(){
  for(const key of ['work','initialization','wire','attempts'] as const){const d=Object.getOwnPropertyDescriptor(this.#balance,key);need(d&&'value'in d&&d.writable===true&&Number.isSafeInteger(d.value)&&d.value>=this.#last[key],'codec_budget_exceeded');this.#last[key]=d.value;}
  need(this.#balance.work+this.#balance.initialization<=this.#work&&this.#balance.wire<=163840&&this.#balance.attempts<=256,'codec_budget_exceeded');
 }
 reserve(bytes:number,initialization=0,requestBytes=0,wireBytes=0,slot=false):MemoryTicket{
  this.check();for(const n of [bytes,initialization,requestBytes,wireBytes])need(Number.isSafeInteger(n)&&n>=0,'codec_budget_exceeded');
  need(this.#held+bytes<=this.#memory&&this.#balance.work+this.#balance.initialization+initialization+requestBytes<=this.#work&&this.#balance.wire+wireBytes<=163840&&(!slot||this.#active<this.#slots&&this.#balance.attempts<256),'codec_budget_exceeded');
  this.#held+=bytes;this.#peak=Math.max(this.#peak,this.#held);this.#balance.initialization+=initialization;this.#balance.work+=requestBytes;this.#balance.wire+=wireBytes;
  if(slot){this.#active++;this.#balance.attempts++;}this.check();const t=Object.freeze({kind:'lb0-memory-reservation' as const});this.#tickets.set(t,{remaining:bytes,slotOpen:slot});return t;
 }
 release(t:MemoryTicket,bytes?:number){const row=this.#tickets.get(t);need(row,'codec_budget_exceeded');const amount=bytes===undefined?row.remaining:bytes;need(Number.isSafeInteger(amount)&&amount>=0&&amount<=row.remaining&&amount<=this.#held,'codec_budget_exceeded');row.remaining-=amount;this.#held-=amount;}
 endSlot(t:MemoryTicket){const row=this.#tickets.get(t);need(row?.slotOpen&&this.#active>0,'codec_budget_exceeded');row.slotOpen=false;this.#active--;}
 stats(){return {...this.#balance,heldBytes:this.#held,peakBytes:this.#peak,occupiedSlots:this.#active,memoryLimit:this.#memory,workLimit:this.#work};}
 static require(value:Lb0Budget){need(budgets.has(value),'codec_budget_exceeded');value.check();}
}
