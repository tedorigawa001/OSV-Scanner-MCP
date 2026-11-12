/** CCO-0: owned storage and a managed-cell protocol, not an A/B proof or full allocation bound.
 * Real CPR schemas/expected generation run under separately reserved diagnostic scratch.
 * Their internal temporaries and total work coverage remain deliberately unproved.
 */
import {types} from 'node:util';
import {Co0Approval} from './gradleOwnedCwcCo0Approval.js';
import {CO0_RECIPE,CO0_SCOPE,parseCo0Recipe,co0Budget} from './gradleOwnedCwcCo0Contract.js';
import {lgOwnedCopy,lgFreeze} from './gradleOwnedCwcLg0Contract.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Clock,readOwnedClock,ownedClockKind} from './gradleOwnedCwcVf0Authority.js';
import {context,command,checkCommand,makeCommand,validatePlanCore,type CprContext,type CprCommand} from './gradleOwnedCprASchema.js';
import {cwcCMemory} from './gradleOwnedCwcC.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';

export type Co0Actor='provider'|'client-initial'|'client-seal';
export type Co0Fault='none'|'retain-input'|'unreserved-scratch'|'expected-mismatch'|'row-tamper'|'capture-failure'|'row-after-normalize';
type Handle=Readonly<{kind:string}>;const token=(kind:string):Handle=>Object.freeze({kind});
type Identity=Readonly<{actor:Co0Actor;root:Handle;call:Handle;scope:Handle}>;
type Lease={id:number;label:string;value:object|string|undefined};
type Core=ReturnType<typeof validatePlanCore>;
type Child={identity:Identity;claim?:Handle;window?:Handle;core?:Core;builderCore?:Core;c?:CprContext;
 state:string;captured:number;next:number;slab?:Buffer;input?:Lease;q?:Lease;expected?:Lease;used:number;generation:number};
const instances=new WeakSet<object>(),claims=new WeakMap<Handle,{owner:Co0Owner;child:Child;used:boolean}>(),windows=new WeakMap<Handle,{owner:Co0Owner;child:Child}>();
const alloc=Buffer.alloc,write=Buffer.prototype.write,fill=Buffer.prototype.fill;
const subarray=Buffer.prototype.subarray;
const EVENT_KINDS=['claim','open','capture','decode','normalize','input-retired','expected','compare','ordinal-end','lease','release','fail','close','drain','scratch','scratch-end','frame-exit','input-retained'] as const;
export class Co0Owner{
 readonly #approval:Co0Approval;readonly #budget:ReturnType<typeof co0Budget>;readonly #clock:Vf0Clock;readonly #recipe:typeof CO0_RECIPE;
 readonly #hook:(site:string,o:Co0Owner)=>void;readonly #fault:Co0Fault;readonly #children:Child[];
 readonly #ctor:ReturnType<Lb0Budget['reserve']>;#ticket?:ReturnType<Lb0Budget['reserve']>;readonly #unsubscribe:()=>void;
 #c?:CprContext;#width=0;#metadata?:Buffer;#trace?:Buffer;#traceLength=0;#traceRows:any[]=[];#finalDigests:string[][]=[];
 #alive=true;#busy=false;#claimed=false;#released=false;#pending=false;#scratch=false;#familiesCompared=false;#entries=0;#last=0;#floor=4500;#active?:Child;
 #cells:Lease[]=[];#retired:Lease[]=[];#leaseId=0;#slotPeak=0;#reason:string|null=null;#capturedRows=0;#comparedRows=0;#sourceBytes=0;#comparedBytes=0;#allocations=0;#late=0;#managed=0;#scratchUses=0;#expectedBuilds=0;#dataBytes=0;
 constructor(o:{recipe:unknown;approval:Co0Approval;budget:Lb0Budget;clock:Vf0Clock;context:unknown;kind:'provider'|'client';fault?:Co0Fault;hook?:(site:string,owner:Co0Owner)=>void}){
  need(o&&!types.isProxy(o)&&Object.getPrototypeOf(o)===Object.prototype,'schema_invalid');
  for(const k of Reflect.ownKeys(o))need(typeof k==='string'&&['recipe','approval','budget','clock','context','kind','fault','hook'].includes(k)&&'value'in Object.getOwnPropertyDescriptor(o,k)!,'schema_invalid');
  this.#recipe=parseCo0Recipe(o.recipe);Co0Approval.require(o.approval);this.#approval=o.approval;this.#budget=co0Budget(o.budget);this.#clock=o.clock;
  need(ownedClockKind(o.clock)==='fixed'&&['provider','client'].includes(o.kind),'co0_profile_unsupported');
  this.#fault=o.fault??'none';need(['none','retain-input','unreserved-scratch','expected-mismatch','row-tamper','capture-failure','row-after-normalize'].includes(this.#fault),'schema_invalid');
  this.#hook=o.hook??(()=>{});need(typeof this.#hook==='function','schema_invalid');
  this.#children=(o.kind==='provider'?['provider']:['client-initial','client-seal']).map(actor=>({identity:lgFreeze({actor:actor as Co0Actor,root:token('co0-synthetic-root'),call:token('co0-synthetic-call'),scope:token('co0-synthetic-scope')}),state:'new',captured:0,next:0,used:0,generation:1}));
  this.#ctor=this.#budget.reserve(this.#recipe.ownedDataBytes,this.#recipe.initialization);
  try{this.#c=lgFreeze(context(lgOwnedCopy(o.context,65536)));this.#width=cwcCMemory(this.#c).commandBytes;
   this.#dataBytes=Buffer.byteLength(canonical(this.#c));this.#live();this.#unsubscribe=o.approval.subscribe(()=>this.invalidate('co0_profile_unsupported'));
  }catch(e){this.#budget.release(this.#ctor);throw e;}
  instances.add(this);Object.freeze(this);
 }
 #live(){need(this.#alive&&!this.#released,this.#reason??'owner_closed');Co0Approval.require(this.#approval);this.#budget.check();
  const n=readOwnedClock(this.#clock);need(n>=this.#last&&n<this.#floor,'request_expired');this.#last=n;}
 #event(kind:typeof EVENT_KINDS[number],child?:Child,extra=0){if(!this.#trace)return;need(this.#traceLength<4096,'codec_budget_exceeded');
  const offset=this.#traceLength*64,index=child?this.#children.indexOf(child):255;
  this.#trace.writeUInt32LE(this.#traceLength,offset);this.#trace.writeUInt8(EVENT_KINDS.indexOf(kind),offset+4);this.#trace.writeUInt8(index,offset+5);
  this.#trace.writeUInt16LE(child?(child.state==='capturing'?child.captured:child.next):0,offset+6);this.#trace.writeUInt32LE(this.#cells.length,offset+8);this.#trace.writeUInt32LE(extra,offset+12);
  this.#trace.writeUInt32LE(this.#managed,offset+16);this.#trace.writeBigUInt64LE(BigInt(child?.generation??0),offset+20);this.#traceLength++;
 }
 #tick(child?:Child){need(this.#managed<this.#recipe.initialization+(this.#ticket?this.#children.length*this.#recipe.actorWork:0),'codec_budget_exceeded');if(child){need(child.used<this.#recipe.actorWork,'codec_budget_exceeded');child.used++;}this.#managed++;}
 #foreign(site:string){this.#hook(site,this);this.#live();}
 #run<T>(fn:()=>T):T{if(this.#busy){this.invalidate('co0_reentrant');need(false,'co0_reentrant');}this.#busy=true;
  try{this.#live();need(++this.#entries<=256,'codec_budget_exceeded');this.#tick();const result=fn();this.#live();return result;}catch(e){this.invalidate(e instanceof Error?e.message:'validation_failure');throw e;}
  finally{this.#busy=false;this.#reclaim();}}
 #child(h:Handle){const row=windows.get(h);need(row?.owner===this,'co0_binding');return row.child;}
 #take(label:string,c:Child){this.#live();need(this.#cells.length<3,'co0_slot_exhausted');this.#tick(c);const l={id:++this.#leaseId,label,value:undefined};this.#cells.push(l);this.#slotPeak=Math.max(this.#slotPeak,this.#cells.length);this.#event('lease',c,l.id);return l as Lease;}
 #put(l:Lease,v:object|string){need(this.#cells.includes(l)&&l.value===undefined,'co0_binding');l.value=v;}
 #drop(l:Lease|undefined,c:Child){if(!l)return;const i=this.#cells.indexOf(l);if(i<0)return;l.value=undefined;this.#cells.splice(i,1);this.#tick(c);this.#event('release',c,l.id);}
 #retire(l:Lease|undefined){if(l&&this.#cells.includes(l)&&!this.#retired.includes(l))this.#retired.push(l);}
 #returned(c:Child,phase:number){this.#event('frame-exit',c,phase);for(const l of this.#retired.splice(0))this.#drop(l,c);}
 #withScratch<T>(c:Child,fn:()=>T){need(!this.#scratch,'co0_scratch_busy');this.#scratch=true;this.#scratchUses++;this.#event('scratch',c);
  try{return fn();}finally{this.#scratch=false;this.#event('scratch-end',c);}}
 #canonical(c:Child,v:unknown){need(this.#scratch,'co0_scratch_unreserved');return canonical(v,8192);}
 #rowOffset(c:Child,ordinal:number){return 512+this.#children.indexOf(c)*19*64+ordinal*64;}
 #writeState(c:Child,ordinal:number,state:number){const at=this.#rowOffset(c,ordinal);this.#metadata!.writeUInt8(state,at+11);this.#metadata!.writeBigUInt64LE(BigInt(c.generation),at+12);}
 #length(c:Child,ordinal:number){return this.#metadata!.readUInt32LE(this.#rowOffset(c,ordinal)+4);}
 identity(actor:Co0Actor){need(instances.has(this),'co0_binding');const c=this.#children.find(c=>c.identity.actor===actor);need(c,'co0_binding');return c.identity;}
 claim(){return this.#run(()=>{need(!this.#claimed,'co0_claim_reused');this.#claimed=true;
  const bytes=this.#recipe.metadataBytes+3*8192+this.#recipe.scratchBytes+this.#recipe.bridgeBytes+this.#children.length*19*this.#width;
  this.#ticket=this.#budget.reserve(bytes,0,this.#children.length*this.#recipe.actorWork);
  this.#metadata=alloc(4096);this.#trace=alloc(this.#recipe.bridgeBytes);this.#allocations+=2;
  const out=this.#children.map(c=>{c.slab=alloc(19*this.#width);this.#allocations++;c.state='claimed';const h=token('co0-budget-claim');c.claim=h;claims.set(h,{owner:this,child:c,used:false});return h;});
  this.#event('claim');this.#foreign('claim-after');return Object.freeze(out);
 });}
 open(claim:Handle,identity:Identity,input:unknown){return this.#run(()=>{const r=claims.get(claim);need(r?.owner===this&&!r.used&&r.child.identity===identity,'co0_binding');r.used=true;const c=r.child;
  need(c.state==='claimed','co0_state');if(c.identity.actor==='client-seal')need(this.#children[0]!.state==='storage-compared'&&!this.#active&&!this.#cells.length&&!this.#scratch,'co0_actor_busy');
  c.core=this.#withScratch(c,()=>lgFreeze(validatePlanCore(lgOwnedCopy(input,65536))));
  c.builderCore=this.#withScratch(c,()=>lgFreeze(validatePlanCore(lgOwnedCopy(input,65536))));c.c=lgFreeze(context(lgOwnedCopy(this.#c,65536)));
  const {domain,specDigest,seed,transferId,groups,...fields}=c.core;
  need(Object.entries(fields).every(([k,v])=>canonical(v)===canonical((this.#c as any)[k])),'co0_binding');
  this.#dataBytes+=Buffer.byteLength(canonical(c.core))*2+Buffer.byteLength(canonical(c.c));need(this.#dataBytes<=this.#recipe.ownedDataBytes,'codec_budget_exceeded');
  need(c.core.groups.length===19,'co0_profile_unsupported');c.generation=1;c.state='capturing';c.window=token('co0-window');windows.set(c.window,{owner:this,child:c});
  this.#sourceBytes=c.core.groups.flat().reduce((n,r)=>n+r.length,0);this.#event('open',c);this.#foreign('open-after');return c.window;
 });}
 #captureChild(c:Child){const l=this.#take('builder-command',c);let text:Lease|undefined;
  try{const p=c.builderCore!,q=this.#withScratch(c,()=>makeCommand(this.#c!,p.seed,p.transferId,c.captured,19,hash(p),p.groups[c.captured]!));this.#put(l,q);
   this.#withScratch(c,()=>checkCommand(this.#c!,q));text=this.#take('candidate-text',c);const s=this.#withScratch(c,()=>this.#canonical(c,q));this.#put(text,s);
   need(s.length===Buffer.byteLength(s)&&s.length<=this.#width,'co0_row_width');const at=this.#rowOffset(c,c.captured),offset=c.captured*this.#width;
   Reflect.apply(write,c.slab!,[s,offset,s.length,'utf8']);this.#metadata!.writeUInt32LE(offset,at);this.#metadata!.writeUInt32LE(s.length,at+4);this.#metadata!.writeUInt16LE(c.captured,at+8);this.#metadata!.writeUInt8(this.#children.indexOf(c),at+10);
   const d=Buffer.from(q.requestDigest,'hex');this.#metadata!.set(d,at+20);this.#writeState(c,c.captured,1);
   if(this.#fault==='capture-failure')need(false,'co0_capture_failure');
  }finally{this.#retire(text);this.#retire(l);}
 }
 capture(window:Handle){return this.#run(()=>{const c=this.#child(window);need(c.state==='capturing'&&c.captured<19&&!this.#active,'co0_state');
  this.#tick(c);this.#foreign('build-before');this.#captureChild(c);this.#returned(c,1);this.#foreign('build-after');this.#event('capture',c);c.captured++;this.#capturedRows++;
  if(c.captured===19){c.state='captured';if(this.#fault==='row-tamper')c.slab![10]=c.slab![10]!^1;}
 });}
 #decodeChild(c:Child){const text=this.#take('decode-text',c);const input=this.#take('input',c);let ok=false;
  try{const start=c.next*this.#width,s=c.slab!.toString('utf8',start,start+this.#length(c,c.next));this.#put(text,s);this.#put(input,JSON.parse(s));ok=true;c.input=input;}
  finally{this.#retire(text);if(!ok)this.#retire(input);}
 }
 #normalizeChild(c:Child){const q=this.#take('prepared-q',c);let ok=false;
  try{this.#put(q,this.#withScratch(c,()=>command(c.input!.value)));const check=this.#take('check-schema',c);
   try{this.#withScratch(c,()=>checkCommand(c.c!,q.value as CprCommand));}finally{this.#drop(check,c);}c.q=q;ok=true;
  }finally{if(!ok)this.#drop(q,c);}
 }
 #expectedChild(c:Child){const raw=this.#take('expected-raw-reservation',c);const parsed=this.#take('expected-parsed',c);let text:Lease|undefined,ok=false;
  try{const p=c.core!,seed=this.#fault==='expected-mismatch'?'other-seed':p.seed;
   this.#expectedBuilds++;const q=this.#withScratch(c,()=>makeCommand(c.c!,seed,p.transferId,c.next,19,hash(p),p.groups[c.next]!));this.#put(parsed,q);
   // makeCommand's raw frame has returned; its unobserved internal allocations are NOT proved bounded here.
   this.#drop(raw,c);text=this.#take('expected-text',c);this.#put(text,this.#withScratch(c,()=>this.#canonical(c,q)));c.expected=text;ok=true;
  }finally{this.#retire(raw);this.#retire(parsed);if(!ok)this.#retire(text);}
 }
 #compareChild(c:Child){const actual=this.#take('actual-text',c);
  try{const text=this.#withScratch(c,()=>this.#canonical(c,c.q!.value));this.#put(actual,text);need(text===c.expected!.value,'co0_expected_mismatch');
   const length=this.#length(c,c.next),offset=c.next*this.#width;need(text.length===length,'co0_candidate_mismatch');
   for(let i=0;i<length;i++)need(text.charCodeAt(i)<128&&text.charCodeAt(i)===c.slab![offset+i],'co0_candidate_mismatch');this.#comparedBytes+=length;
  }finally{this.#retire(actual);}
 }
 process(window:Handle){return this.#run(()=>{const c=this.#child(window);need(['captured','processing'].includes(c.state)&&c.next<19&&(!this.#active||this.#active===c),'co0_state');this.#active=c;c.state='processing';this.#tick(c);
  this.#foreign('normalize-before');this.#decodeChild(c);this.#returned(c,2);this.#event('decode',c);this.#normalizeChild(c);this.#returned(c,3);this.#event('normalize',c);
  if(this.#fault!=='retain-input'){this.#drop(c.input,c);c.input=undefined;this.#event('input-retired',c);}else this.#event('input-retained',c);
  if(this.#fault==='row-after-normalize'){const marker='"requestDigest":"',offset=c.next*this.#width,at=c.slab!.indexOf(marker,offset,'ascii')+marker.length;
   need(at>=offset+marker.length&&at<offset+this.#length(c,c.next),'co0_state');c.slab![at]=c.slab![at]===97?98:97;}
  this.#foreign('expected-before');if(this.#fault==='unreserved-scratch')this.#canonical(c,c.q!.value);
  this.#expectedChild(c);this.#returned(c,4);this.#event('expected',c);this.#compareChild(c);this.#returned(c,5);this.#event('compare',c);this.#drop(c.expected,c);c.expected=undefined;
  this.#foreign('compare-after');this.#writeState(c,c.next,2);this.#drop(c.q,c);c.q=undefined;
  // This is storage comparison, not encoded/proved. No B counter or successful fact is minted.
  c.next++;this.#comparedRows++;this.#event('ordinal-end',c);if(c.next===19){c.state='storage-compared';this.#active=undefined;}
 });}
 compareFamilies(){return this.#run(()=>{need(!this.#familiesCompared&&this.#children.length===2&&this.#children.every(c=>c.state==='storage-compared')&&!this.#cells.length,'co0_state');
  const [a,b]=this.#children;need(canonical(a!.core)===canonical(b!.core),'co0_family_mismatch');
  for(let i=0;i<19;i++){const n=this.#length(a!,i);need(n===this.#length(b!,i),'co0_family_mismatch');for(let j=0;j<n;j++)need(a!.slab![i*this.#width+j]===b!.slab![i*this.#width+j],'co0_family_mismatch');}
  this.#foreign('families-after');this.#familiesCompared=true;return 'storage-equal' as const;
 });}
 finish(window:Handle):never{return this.#run(()=>{this.#child(window);need(false,'co0_proof_unavailable');});}
 invalidate(reason:string){if(!this.#alive)return;this.#alive=false;this.#reason=reason;this.#active=undefined;for(const c of this.#children){c.state='failed';if(c.generation<Number.MAX_SAFE_INTEGER)c.generation++;}this.#event('fail');this.#reclaim();}
 holdDispatch(){return this.#run(()=>{need(!this.#pending,'co0_state');this.#pending=true;});}
 settleDispatch(){if(this.#busy){this.invalidate('co0_reentrant');need(false,'co0_reentrant');}need(this.#pending,'co0_state');this.#pending=false;if(!this.#alive){this.#late++;this.#reclaim();return 'late-rejected';}return 'no-production-dispatch';}
 close(){this.invalidate('owner_closed');this.#reclaim();}
 #reclaim(){if(this.#alive||this.#busy||this.#pending||this.#released)return;
  for(const l of this.#cells)l.value=undefined;this.#cells=[];this.#retired=[];this.#scratch=false;
  this.#finalDigests=this.#familyDigests();for(const c of this.#children){if(c.slab)Reflect.apply(fill,c.slab,[0]);c.slab=undefined;c.core=undefined;c.builderCore=undefined;c.c=undefined;c.input=undefined;c.q=undefined;c.expected=undefined;}
  this.#c=undefined;if(this.#metadata)Reflect.apply(fill,this.#metadata,[0]);this.#metadata=undefined;
  this.#event('drain');this.#traceRows=this.#readTrace();if(this.#trace)Reflect.apply(fill,this.#trace,[0]);this.#trace=undefined;
  if(this.#ticket)this.#budget.release(this.#ticket);this.#budget.release(this.#ctor);this.#unsubscribe?.();this.#released=true;
 }
 #readTrace(){if(!this.#trace)return this.#traceRows.map(r=>({...r}));return Array.from({length:this.#traceLength},(_,i)=>{const o=i*64;return {seq:this.#trace!.readUInt32LE(o),kind:EVENT_KINDS[this.#trace!.readUInt8(o+4)],actor:this.#trace!.readUInt8(o+5),ordinal:this.#trace!.readUInt16LE(o+6),active:this.#trace!.readUInt32LE(o+8),extra:this.#trace!.readUInt32LE(o+12),managed:this.#trace!.readUInt32LE(o+16),generation:Number(this.#trace!.readBigUInt64LE(o+20))};});}
 #familyDigests(){if(!this.#metadata)return this.#finalDigests.map(rows=>rows.slice());return this.#children.map(c=>Array.from({length:c.captured},(_,i)=>sha(Reflect.apply(subarray,c.slab!,[i*this.#width,i*this.#width+this.#length(c,i)]))));}
 stats(){return {claimed:this.#claimed,alive:this.#alive,released:this.#released,pending:this.#pending,reason:this.#reason,width:this.#width,familiesCompared:this.#familiesCompared,entries:this.#entries,
  capturedRows:this.#capturedRows,comparedRows:this.#comparedRows,sourceBytes:this.#sourceBytes,comparedBytes:this.#comparedBytes,
  slotPeak:this.#slotPeak,activeCells:this.#cells.length,scratchUses:this.#scratchUses,expectedBuilds:this.#expectedBuilds,slabAllocations:this.#allocations,managedOperations:this.#managed,
  children:this.#children.map(c=>({actor:c.identity.actor,state:c.state,captured:c.captured,compared:c.next,used:c.used,generation:c.generation})),
  publications:0,proofs:0,lateRejected:this.#late,budget:this.#budget.stats(),familyDigests:this.#familyDigests(),trace:this.#readTrace(),scope:CO0_SCOPE};}
}
Object.freeze(Co0Owner.prototype);Object.freeze(Co0Owner);
