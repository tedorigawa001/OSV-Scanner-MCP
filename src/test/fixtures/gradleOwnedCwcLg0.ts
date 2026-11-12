/** LG-0 fixture authority and call lifecycle. No existing provider, ReadScope or Session integration. */
import {LG0_POLICY,lgOwnedCopy,lgOwnedView,lgNormalize,lgFreeze,type Lg0Mode,type Lg0View,type Lg0Projection} from './gradleOwnedCwcLg0Contract.js';
import {Lg0Approval} from './gradleOwnedCwcLg0Approval.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Clock,ownedClockKind,readOwnedClock} from './gradleOwnedCwcVf0Authority.js';
import {cwcCMemory} from './gradleOwnedCwcC.js';
import {context,type CprContext} from './gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
import {CurrentControlError,need} from '../../utils/gradleOwnedCurrentSchema.js';
import {types} from 'node:util';

const secret=Symbol('lg0-private');
const token=(kind:string)=>Object.freeze({kind});
type Token=ReturnType<typeof token>;type Ticket=ReturnType<Lb0Budget['reserve']>;
const budgetPrototype=Lb0Budget.prototype;
const budgetMethods={check:budgetPrototype.check,reserve:budgetPrototype.reserve,release:budgetPrototype.release,endSlot:budgetPrototype.endSlot,stats:budgetPrototype.stats};
const budgetRequire=Lb0Budget.require;
/** Preserve the actual old ledger/private slots. Cleanup uses captured methods even after poisoning. */
function bindBudget(raw:Lb0Budget){
 const current=()=>{need(raw&&typeof raw==='object'&&!types.isProxy(raw)&&Object.getPrototypeOf(raw)===budgetPrototype,'codec_budget_exceeded');
  for(const [name,method]of Object.entries(budgetMethods))need(!Object.hasOwn(raw,name)&&Object.getOwnPropertyDescriptor(budgetPrototype,name)?.value===method,'codec_profile_unsupported');
  need(Object.getOwnPropertyDescriptor(Lb0Budget,'require')?.value===budgetRequire,'codec_profile_unsupported');};
 current();Reflect.apply(budgetRequire,Lb0Budget,[raw]);return Object.freeze({
  check(){current();Reflect.apply(budgetMethods.check,raw,[]);},
  reserve(...args:Parameters<Lb0Budget['reserve']>):Ticket{current();return Reflect.apply(budgetMethods.reserve,raw,args);},
  release(...args:Parameters<Lb0Budget['release']>){Reflect.apply(budgetMethods.release,raw,args);},
  endSlot(t:Ticket){Reflect.apply(budgetMethods.endSlot,raw,[t]);},
  stats():ReturnType<Lb0Budget['stats']>{return Reflect.apply(budgetMethods.stats,raw,[]);}
 });
}
type Budget=ReturnType<typeof bindBudget>;
type Port={owner:Lg0Authority;verification:object;clock:Vf0Clock;approval:Lg0Approval;generation:number};
const ports=new WeakMap<object,Port>(),owners=new WeakSet<object>(),calls=new WeakSet<object>();
const fail=(reason:string):never=>{throw new CurrentControlError(reason);};

export class Lg0Authority{
 #view:Lg0View|undefined;#epoch=1;#revision=0;#revocation=0;#updating=false;#closed=false;
 readonly #subscribers=new Set<(reason:string)=>void>();readonly #budget:Budget;
 constructor(key:symbol,input:unknown,budget:Budget){need(key===secret,'codec_profile_unsupported');this.#budget=budget;this.#view=lgOwnedView(input);owners.add(this);Object.freeze(this);}
 #invalidate(reason:string){
  need(this.#revision<Number.MAX_SAFE_INTEGER&&this.#revocation<Number.MAX_SAFE_INTEGER,'owner_closed');
  this.#revision++;this.#revocation++;for(const fn of [...this.#subscribers]){try{fn(reason);}catch{/* All subscribers must observe the sticky revocation. */}}
 }
 replace(input:unknown){
  need(!this.#closed,'owner_closed');if(this.#updating){this.#invalidate('reentrant');fail('reentrant');}
  this.#updating=true;this.#invalidate('permission_denied');let scratch:Ticket|undefined;
  try{scratch=this.#budget.reserve(131072,4096);const view=lgOwnedView(input);this.#view=view;this.#updating=false;}
  finally{if(scratch)this.#budget.release(scratch);}
  // If parsing/reservation fails, updating remains sticky; no old-ready or new admission.
 }
 restart(){need(!this.#closed&&this.#epoch<Number.MAX_SAFE_INTEGER,'owner_closed');this.#epoch++;this.#invalidate('owner_closed');}
 close(){if(this.#closed)return;this.#closed=true;this.#invalidate('owner_closed');this.#view=undefined;}
 snapshot(){return {epoch:this.#epoch,revision:this.#revision,revocation:this.#revocation,updating:this.#updating,closed:this.#closed};}
 /** Private-module friend access: no raw view is returned through an exported method. */
 static borrow(key:symbol,owner:Lg0Authority){need(key===secret&&owners.has(owner),'codec_profile_unsupported');need(!owner.#closed&&!owner.#updating&&owner.#view,'owner_closed');return owner.#view;}
 static subscribe(key:symbol,owner:Lg0Authority,fn:(reason:string)=>void){need(key===secret&&owners.has(owner),'codec_profile_unsupported');owner.#subscribers.add(fn);return ()=>owner.#subscribers.delete(fn);}
}

export type Lg0Options={mode:Lg0Mode;context:unknown;view:unknown;clock:Vf0Clock;approval:Lg0Approval;budget:Lb0Budget;
 /** Fault injection into the fixed approved fixture body; never an admitted external adapter. */
 hook?:(site:string,call:Lg0Call)=>void;register?:boolean};

export class Lg0Session{
 readonly authority:Lg0Authority;readonly verificationOwner=token('lg0-verification-owner');
 readonly #context:CprContext;readonly #o:Pick<Lg0Options,'mode'|'clock'|'approval'>&{budget:Budget};readonly #base:Ticket;readonly #all=new Set<Lg0Call>();
 #port?:Token;#started=false;#closed=false;#baseReleased=false;#opened=0;#hook:(site:string,call:Lg0Call)=>void;
 readonly #approvalUnsubscribe:()=>void;
 constructor(options:Lg0Options){
  need(options&&typeof options==='object'&&!types.isProxy(options)&&Object.getPrototypeOf(options)===Object.prototype,'schema_invalid');
  for(const key of Reflect.ownKeys(options))need(typeof key==='string'&&['mode','context','view','clock','approval','budget','hook','register'].includes(key)&&'value'in Object.getOwnPropertyDescriptor(options,key)!,'schema_invalid');
  need(['full-input','owned-input'].includes(options.mode),'codec_profile_unsupported');const budget=bindBudget(options.budget);Lg0Approval.require(options.approval);
  need(ownedClockKind(options.clock)==='fixed','codec_profile_unsupported');
  this.#o=Object.freeze({mode:options.mode,clock:options.clock,approval:options.approval,budget});this.#hook=options.hook??(()=>{});this.#base=budget.reserve(131072,4096);let scratch:Ticket|undefined;
  try{scratch=budget.reserve(131072);this.#context=lgFreeze(context(lgOwnedCopy(options.context,65536)));
   this.authority=new Lg0Authority(secret,options.view,budget);const v=Lg0Authority.borrow(secret,this.authority);
   need(v.registryPin===this.#context.registryDigest&&v.sourcePin===options.approval.pin&&v.profilePin===options.approval.pin,'codec_profile_unsupported');
   this.#approvalUnsubscribe=options.approval.subscribe(()=>{for(const call of this.#all)call.invalidate('codec_profile_unsupported');});
   if(options.register!==false)this.registerOwnedLivePort(this.authority,this.verificationOwner,options.clock,options.approval);
  }catch(e){budget.release(this.#base);throw e;}finally{if(scratch)budget.release(scratch);}
  Object.freeze(this);
 }
 registerOwnedLivePort(owner:Lg0Authority,verification:object,clock:Vf0Clock,approval:Lg0Approval){
  need(!this.#closed&&!this.#started&&!this.#port,'codec_profile_unsupported');
  need(owner===this.authority&&verification===this.verificationOwner&&clock===this.#o.clock&&approval===this.#o.approval,'codec_profile_unsupported');
  Lg0Approval.require(approval);Lg0Authority.borrow(secret,owner);const h=token('lg0-private-port');ports.set(h,{owner,verification,clock,approval,generation:1});this.#port=h;
 }
 open(){
  need(!this.#closed&&this.#port&&this.#opened++<256,'owner_closed');Lg0Approval.require(this.#o.approval);Lg0Authority.borrow(secret,this.authority);
  const c=new Lg0Call(secret,this,this.#port,this.#context,this.#o.mode,this.#o.budget,this.#hook);this.#all.add(c);return c;
 }
 static started(key:symbol,s:Lg0Session){need(key===secret,'source_binding');s.#started=true;}
 static drained(key:symbol,s:Lg0Session,c:Lg0Call){need(key===secret,'source_binding');s.#all.delete(c);s.#tryRelease();}
 #tryRelease(){if(!this.#closed||this.#baseReleased||[...this.#all].some(c=>!Lg0Call.drained(secret,c)))return;this.#o.budget.release(this.#base);this.#baseReleased=true;}
 stats(){return this.#o.budget.stats();}
 close(){if(this.#closed)return;this.#closed=true;for(const c of this.#all)c.invalidate('owner_closed');this.#approvalUnsubscribe();this.authority.close();this.#tryRelease();}
}

export class Lg0Call{
 readonly scope=token('lg0-scope');readonly association=token('lg0-actual-association');
 readonly #session:Lg0Session;readonly #port:Port;readonly #context:CprContext;readonly #mode:Lg0Mode;readonly #budget:Budget;
 readonly #hook:(site:string,call:Lg0Call)=>void;readonly #callTicket:Ticket;readonly #scopeTicket:Ticket;
 readonly #refs=Object.freeze({control:token('lg0-control'),channel:token('lg0-channel'),binding:token('lg0-binding'),row:token('lg0-row')});
 readonly #unsubscribe:()=>void;
 #state='new';#reason:string|null=null;#claimed=false;#busy=false;#scopeOpen=true;#scopeGeneration=1;#localGeneration=1;
 #sealed=false;#normalRelease=false;
 #actualOpen=true;#actualGeneration=1;#callLookup=true;#channelOpen=true;#readers=0;#handle?:Token;#projection?:Lg0Projection;#view?:Lg0View;
 #stamp?:ReturnType<Lg0Authority['snapshot']>;#ticket?:Ticket;#released=false;#drained=false;#pending=false;#last=0;#floor=4500;
 #bound?:Readonly<{scope:Token;association:Token;refs:Readonly<Record<'control'|'channel'|'binding'|'row',Token>>;scopeGeneration:number;actualGeneration:number;localGeneration:number;portGeneration:number}>;
 #metrics={captures:0,seals:0,logical:0,live:0,normalizations:0,fullPermissionCopies:0,matches:0,publications:0,use:0,ack:0,
  lgReleases:0,reads:0,signs:0,lateRejected:0,finalFull:0,privateReferences:0};
 #normalizer?:{work:Record<string,number>;poolBytes:number;temporaryBytes:number;rows:number};
 constructor(key:symbol,session:Lg0Session,port:Token,ctx:CprContext,mode:Lg0Mode,budget:Budget,hook:(site:string,call:Lg0Call)=>void){
  need(key===secret&&ports.has(port),'codec_profile_unsupported');this.#session=session;this.#port=ports.get(port)!;this.#context=ctx;this.#mode=mode;this.#budget=budget;this.#hook=hook;
  const memory=cwcCMemory(ctx),extra=memory.reserved-32768;
  // Distinct actual tickets: CWC root/fact/codec scope, call+binding+VF, then LG capture.
  // VF's 4096 B is occupied within the old call's 8192 B metadata, never reused by LG.
  this.#scopeTicket=budget.reserve(extra);try{this.#callTicket=budget.reserve(98304+8192,12288,57344,57344,true);}catch(e){budget.release(this.#scopeTicket);throw e;}
  this.#unsubscribe=Lg0Authority.subscribe(secret,this.#port.owner,reason=>this.invalidate(reason));calls.add(this);Object.freeze(this);
 }
 #live(){
  need(this.#actualOpen&&this.#callLookup&&this.#channelOpen,this.#reason??'owner_closed');
  if(this.#state==='ready'||this.#state==='checking'){const b=this.#bound;need(b&&this.#scopeOpen&&b.scope===this.scope&&b.association===this.association&&b.refs===this.#refs&&b.scopeGeneration===this.#scopeGeneration&&b.actualGeneration===this.#actualGeneration&&b.localGeneration===this.#localGeneration&&b.portGeneration===this.#port.generation,'codec_fact_binding_mismatch');}
  Lg0Approval.require(this.#port.approval);this.#budget.check();const v=Lg0Authority.borrow(secret,this.#port.owner),stamp=this.#port.owner.snapshot();
  if(this.#stamp)need(stamp.epoch===this.#stamp.epoch&&stamp.revision===this.#stamp.revision&&stamp.revocation===this.#stamp.revocation&&(this.#state==='released'||v===this.#view),'permission_denied');
  need(v.registryPin===this.#context.registryDigest&&v.sourcePin===this.#port.approval.pin&&v.profilePin===this.#port.approval.pin&&v.callbackPolicy===0,'codec_profile_unsupported');
  need(v.peer&&v.server&&v.peerKeyEpoch===this.#context.peer.keyEpoch&&v.serverKeyEpoch===this.#context.provider.keyEpoch&&v.purpose==='read','permission_denied');
  const now=readOwnedClock(this.#port.clock);need(now>=this.#last&&now<this.#floor,'request_expired');this.#last=now;this.#metrics.live++;return v;
 }
 #foreign(site:string){this.#hook(site,this);this.#live();}
 #operation<T>(fn:()=>T):T{
  if(this.#busy){this.invalidate('reentrant');fail('reentrant');}this.#busy=true;if(this.#state==='ready')this.#state='checking';
  try{this.#live();const result=fn();this.#live();if(this.#state==='checking')this.#state='ready';return result;}catch(e){this.invalidate(e instanceof CurrentControlError?e.reason:'validation_failure');throw e;}finally{this.#busy=false;}
 }
 capture(){
  if(!this.#actualOpen)fail(this.#reason??'owner_closed');
  if(this.#claimed||this.#state!=='new'){this.invalidate('call_reused');fail('call_reused');}this.#claimed=true;Lg0Session.started(secret,this.#session);
  return this.#operation(()=>{
   this.#state='claimed/capturing';this.#ticket=this.#budget.reserve(4096,4096);this.#foreign('capture-before');
   const view=this.#live();this.#stamp=this.#port.owner.snapshot();this.#view=view;
   const p=lgNormalize(view,this.#context.lineage);this.#projection=p;this.#metrics.normalizations++;
   this.#normalizer={work:{...p.work},poolBytes:p.poolBytes,temporaryBytes:p.temporaryBytes,rows:p.rows.length};
   this.#foreign('capture-after');this.#state='verified-unbound';this.#handle=token('lg0-private-handle');this.#metrics.privateReferences=1;this.#metrics.captures++;
   return this.#handle;
  });
 }
 seal(handle:Token,scope:Token,association=this.association){
  this.#operation(()=>{need(this.#state==='verified-unbound'&&handle===this.#handle&&scope===this.scope&&association===this.association&&this.#scopeOpen,'codec_fact_binding_mismatch');
   this.#foreign('seal');this.#fullPermission();this.#bound=Object.freeze({scope,association,refs:this.#refs,scopeGeneration:this.#scopeGeneration,actualGeneration:this.#actualGeneration,localGeneration:this.#localGeneration,portGeneration:this.#port.generation});this.#state='ready';this.#metrics.seals++;});
  // Only a seal that also passed its final live fence can authorize normal completion.
  this.#sealed=true;
 }
 #fullPermission(){const v=lgOwnedView(this.#live());need(v.permissions.some(p=>p.api==='aux.ReadSourceRanges'&&p.purpose==='read'&&canonical(p.lineage)===canonical(this.#context.lineage)&&(p.delegateInstance===null||p.delegateInstance===this.#context.provider.instanceId)),'permission_denied');}
 #inspect(){
  need(this.#state==='checking'&&this.#scopeOpen&&this.#projection,'codec_fact_binding_mismatch');
  need(++this.#metrics.logical<=4096,'codec_budget_exceeded');this.#budget.reserve(0,0,1);
  this.#foreign('permissions-before');let ok=false;const view=this.#live();
  if(this.#mode==='full-input'){
   const permissions=lgOwnedView(view).permissions;this.#metrics.fullPermissionCopies++;
   ok=permissions.some(p=>p.api==='aux.ReadSourceRanges'&&p.purpose==='read'&&canonical(p.lineage)===this.#projection!.expectedKey&&(p.delegateInstance===null||p.delegateInstance===this.#context.provider.instanceId));
  }else{
   this.#readers++;try{for(const [api,purpose,delegate,lineageKey]of this.#projection.rows){if(api==='aux.ReadSourceRanges'&&purpose==='read'&&lineageKey===this.#projection.expectedKey&&(delegate===null||delegate===this.#context.provider.instanceId)){ok=true;break;}}}
   finally{this.#readers--;this.#reclaim();}
  }
  this.#metrics.matches++;need(ok,'permission_denied');this.#foreign('permissions-after');
 }
 inspect(handle:Token){
  if(this.#busy){this.invalidate('reentrant');fail('reentrant');}
  if(this.#state==='released')fail('codec_fact_binding_mismatch');
  return this.#operation(()=>{need(handle===this.#handle,'codec_fact_binding_mismatch');this.#inspect();});
 }
 nested(handle:Token){return this.#operation(()=>{need(handle===this.#handle,'codec_fact_binding_mismatch');this.#inspect();this.#inspect();});}
 #reclaim(){
  if(this.#released||!['released','invalid'].includes(this.#state)||this.#readers)return;
  this.#projection=undefined;this.#view=undefined;this.#handle=undefined;this.#bound=undefined;this.#metrics.privateReferences=0;
  if(this.#ticket){this.#budget.release(this.#ticket);this.#metrics.lgReleases++;}this.#released=true;
 }
 closeScope(){
  if(this.#busy){this.invalidate('reentrant');fail('reentrant');}
  if(!this.#scopeOpen)return;
  if(this.#state!=='ready'||!this.#sealed||!this.#bound){this.invalidate('codec_fact_binding_mismatch');return;}
  this.#normalRelease=true;this.#scopeOpen=false;this.#scopeGeneration++;
  this.#state='released';this.#reason='normal-scope-end';this.#localGeneration++;this.#reclaim();
 }
 invalidate(reason:string){
  if(!this.#actualOpen)return;this.#actualOpen=false;this.#actualGeneration++;this.#callLookup=false;this.#channelOpen=false;
  this.#reason=reason;this.#state='invalid';this.#localGeneration++;this.#scopeOpen=false;this.#scopeGeneration++;this.#reclaim();this.#drain();
 }
 static drained(key:symbol,c:Lg0Call){need(key===secret&&calls.has(c),'source_binding');return c.#drained;}
 #drain(){if(this.#actualOpen||this.#pending||this.#readers||this.#drained)return;this.#drained=true;this.#budget.release(this.#scopeTicket);this.#budget.release(this.#callTicket);this.#budget.endSlot(this.#callTicket);this.#unsubscribe();Lg0Session.drained(secret,this.#session,this);}
 holdDispatch(){need(this.#actualOpen&&!this.#pending,'owner_closed');this.#pending=true;}
 settleDispatch(){this.#pending=false;if(!this.#actualOpen){this.#metrics.lateRejected++;this.#drain();return 'late-rejected';}return 'pending-call-open';}
 read(){return this.#operation(()=>{need(this.#state==='checking'&&this.#scopeOpen,'codec_fact_binding_mismatch');this.#metrics.reads++;});}
 finalize(){
  return this.#operation(()=>{
   need(this.#sealed&&this.#normalRelease&&this.#state==='released'&&this.#reason==='normal-scope-end','codec_fact_binding_mismatch');
   const view=lgOwnedView(this.#live());this.#metrics.finalFull++;
   need(view.permissions.some(p=>p.api==='aux.ReadSourceRanges'&&p.purpose==='read'&&canonical(p.lineage)===canonical(this.#context.lineage)&&(p.delegateInstance===null||p.delegateInstance===this.#context.provider.instanceId)),'permission_denied');
   this.#foreign('final-before');this.#live();
   // No callback, clock callback, await or caller data between this fence and model publication.
   this.#metrics.signs++;this.#metrics.publications++;this.#metrics.use++;this.#metrics.ack++;
   return 'complete' as const;
  })&&this.#finish();
 }
 #finish(){this.#actualOpen=false;this.#callLookup=false;this.#channelOpen=false;this.#drain();return 'complete' as const;}
 stats(){return structuredClone({mode:this.#mode,state:this.#state,reason:this.#reason,claimed:this.#claimed,localGeneration:this.#localGeneration,scopeGeneration:this.#scopeGeneration,
  lookup:!!this.#handle,readers:this.#readers,pendingDispatch:this.#pending,drained:this.#drained,
  actual:{open:this.#actualOpen,generation:this.#actualGeneration,lookup:this.#callLookup,channelOpen:this.#channelOpen},
  metrics:this.#metrics,normalizer:this.#normalizer??null,budget:this.#budget.stats()});}
}
for(const ctor of [Lg0Authority,Lg0Session,Lg0Call]){Object.freeze(ctor.prototype);Object.freeze(ctor);}
