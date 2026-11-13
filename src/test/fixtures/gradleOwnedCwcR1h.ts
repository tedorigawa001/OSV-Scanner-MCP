/** R1-H0 lifecycle fixture. No production profile, full charge, original-unit work or service connection. */
import {types} from 'node:util';
const isProxy=types.isProxy,prototype=Object.getPrototypeOf,descriptor=Object.getOwnPropertyDescriptor,ownKeys=Reflect.ownKeys,freeze=Object.freeze,isFrozen=Object.isFrozen,hasOwn=Object.hasOwn,create=Object.create,objectPrototype=Object.prototype,define=Object.defineProperty;
const NativeError=Error,NativeArray=Array,NativeBytes=Uint8Array,fill=Uint8Array.prototype.fill,apply=Reflect.apply,isSafe=Number.isSafeInteger,is=Object.is;
// Indexed loops avoid replaced prototype methods, iterators and Array species callbacks.
function make<T>(n:number,fn:(i:number)=>T){const out=new NativeArray<T>(n);for(let i=0;i<n;i++)define(out,i,{value:fn(i),writable:true,enumerable:true,configurable:true});return out;}
function find<T>(a:readonly T[],fn:(x:T)=>boolean){for(let i=0;i<a.length;i++)if(fn(a[i]!))return a[i];return undefined;}
function count<T>(a:readonly T[],fn:(x:T)=>unknown){let n=0;for(let i=0;i<a.length;i++)if(fn(a[i]!))n++;return n;}
function at<T>(a:readonly T[],x:T){for(let i=0;i<a.length;i++)if(a[i]===x)return i;return -1;}
function some<T>(a:readonly T[],fn:(x:T)=>unknown){return count(a,fn)>0;}
function all<T>(a:readonly T[],fn:(x:T)=>unknown){return count(a,fn)===a.length;}
function need(v:unknown,reason:string):asserts v{if(!v)throw NativeError('r1h_'+reason);}
const integer=(n:unknown):n is number=>typeof n==='number'&&isSafe(n)&&n>=0&&!is(n,-0);
function fields(input:unknown,allowed:readonly string[],required:readonly string[]){
 need(input&&typeof input==='object'&&!isProxy(input)&&prototype(input)===objectPrototype,'input');
 const keys=ownKeys(input);need(keys.length<=allowed.length&&all(keys,k=>typeof k==='string'&&at(allowed,k)>=0),'input');
 const out=create(null) as Record<string,unknown>;for(let i=0;i<keys.length;i++){const k=keys[i]!;const d=descriptor(input,k)!;need('value'in d&&d.enumerable,'input');out[k as string]=d.value;}
 need(all(required,k=>hasOwn(out,k)),'input');return out;
}
const portToken=freeze({});
type Fault='reenter-publish'|'reenter-reclaim'|'reenter-open'|'cancel-before-publication'|'expire-before-publication'|'revoke-before-publication'|'pin-restore-before-publication'|'cleanup-after-first';
const faults:readonly Fault[]=freeze(['reenter-publish','reenter-reclaim','reenter-open','cancel-before-publication','expire-before-publication','revoke-before-publication','pin-restore-before-publication','cleanup-after-first']);
class OwnedPorts {
 readonly #brand=portToken;#now=0;#revision=1;#pin=1;#purpose:'read'|'other'='read';#revoked=false;#fault?:Fault;
 constructor(token:object){need(token===portToken&&new.target===OwnedPorts,'port_binding');freeze(this);}
 static require(p:unknown):asserts p is OwnedPorts {need(p&&typeof p==='object'&&!isProxy(p)&&prototype(p)===OwnedPorts.prototype&&#brand in p&&p.#brand===portToken,'port_binding');}
 static now(p:OwnedPorts){return p.#now;}
 static revision(p:OwnedPorts){return p.#revision;}
 static pin(p:OwnedPorts){return p.#pin;}
 static purpose(p:OwnedPorts){return p.#purpose;}
 static revoked(p:OwnedPorts){return p.#revoked;}
 static take(p:OwnedPorts,site:'publication'|'cleanup'){const fault=p.#fault;if(fault&&(site==='cleanup'?(fault==='cleanup-after-first'):(fault!=='cleanup-after-first'))){p.#fault=undefined;return fault;}return undefined;}
 arm(fault:Fault){need(at(faults,fault)>=0&&this.#fault===undefined,'fault');this.#fault=fault;}
 advance(ms:number){need(integer(ms)&&integer(this.#now+ms),'clock');this.#now+=ms;}
 setPin(pin:number){need(integer(pin)&&pin>0&&this.#revision<Number.MAX_SAFE_INTEGER,'pin');this.#pin=pin;this.#revision++;}
 setPurpose(purpose:'read'|'other'){need((purpose==='read'||purpose==='other')&&this.#revision<Number.MAX_SAFE_INTEGER,'purpose');this.#purpose=purpose;this.#revision++;}
 revoke(){need(this.#revision<Number.MAX_SAFE_INTEGER,'generation');this.#revoked=true;this.#revision++;}
}
freeze(OwnedPorts.prototype);freeze(OwnedPorts);
export function createR1hPorts(){return new OwnedPorts(portToken);}
export type R1hMode='full-input'|'owned-input';
export type R1hActor='provider'|'client';
export type R1hHandle=Readonly<{kind:'r1h-opaque'}>;
type Body={handles:readonly R1hHandle[];refs:unknown[];buffer?:Uint8Array;issued:boolean;first:boolean;seal:boolean;closed:boolean;zeroed:boolean;borrowIssued:boolean;transportIssued:boolean;firstPublished:boolean;sealPublished:boolean;borrow?:Uint8Array;transport?:Uint8Array};
type Binding=Readonly<{owner:R1hHandle;scope:object;ports:OwnedPorts;sequence:number;actor:R1hActor}>;
type Read={owner:R1hHandle;authorityOwner:R1hHandle|undefined;sequence:number;actor:R1hActor;state:'active'|'closing'|'retiring';reason:string|null;attempt:number;frames:number;readyRelease:boolean;last:number;deadline:number;revision:number;pin:number;binding:Binding;ownedView:Binding;bodies:Body[];publications:number;fullChecks:number;ownedChecks:number};
export const R1H_RUNTIME_SCOPE=freeze({limitedLifecycleFixture:true,closedOwnedPorts:true,fixedClock:true,sameProcess:true,realBinaryBuffers:true,twoCompleteWindowBodiesReserved:true,sixteenPrivateIdentities:true,
 bothFixtureModeBranches:true,oneBorrowAndTransportPerAttempt:true,arbitraryCallbacksSupported:false,diagnosticObserverOutsideAdmittedPath:true,diagnosticCallerChargeProved:false,actualAuthenticatedCall:false,actualReadScope:false,cwcRootFactConnected:false,freshSnapshot:false,
 fullRoleLayoutProved:false,independentChargeApproved:false,physicalHeapBound:false,actualParentLedgerVector:false,originalUnitWorkCoverage:false,summaryExportImplemented:false,r1mExit:false,r1Exit:false,productionAdopted:false,performanceMeasured:false});
export class R1hRuntime {
 readonly #ports:OwnedPorts;readonly #mode:R1hMode;readonly #registry:(Read|undefined)[];
 #busy=false;#active?:Read;#sequence=0;#held=0;#allocations=0;#allocated=0;#zeroed=0;#reclaims=0;#publications=0;#reentry=0;#caught=0;#faultFrames=0;#faultBodies=0;
 constructor(input:{ports:ReturnType<typeof createR1hPorts>;mode:R1hMode;capacity?:number}){
  need(new.target===R1hRuntime,'runtime_binding');const o=fields(input,['ports','mode','capacity'],['ports','mode']);OwnedPorts.require(o.ports);need(o.mode==='full-input'||o.mode==='owned-input','mode');const capacity=hasOwn(o,'capacity')?o.capacity:1;need(integer(capacity)&&capacity>=1&&capacity<=4,'capacity');
  this.#ports=o.ports;this.#mode=o.mode;this.#registry=make(capacity,()=>undefined);freeze(this);
 }
 #fatal(r:Read,reason:string){r.authorityOwner=undefined;if(r.state!=='retiring'){r.state='retiring';r.reason=reason;for(let i=0;i<r.bodies.length;i++){const b=r.bodies[i]!;b.first=false;b.seal=false;b.closed=true;}}}
 #guard(){if(this.#busy){if(this.#active)this.#fatal(this.#active,'reentry');this.#reentry++;throw NativeError('r1h_reentry');}}
 #find(h:R1hHandle,completion=false){need(h&&typeof h==='object'&&!isProxy(h),'binding');const r=find(this.#registry,x=>completion?x?.owner===h:x?.authorityOwner===h);need(r,'binding');return r;}
 #live(r:Read){
  need(r.state==='active',r.reason??'closed');const now=OwnedPorts.now(this.#ports);
  if(now<r.last||now>=r.deadline){this.#fatal(r,now<r.last?'clock':'expired');throw NativeError('r1h_'+r.reason);}r.last=now;
  if(OwnedPorts.revoked(this.#ports)){this.#fatal(r,'authority');throw NativeError('r1h_authority');}
  if(OwnedPorts.purpose(this.#ports)!=='read'){this.#fatal(r,'purpose');throw NativeError('r1h_purpose');}
  if(OwnedPorts.pin(this.#ports)!==r.pin||OwnedPorts.revision(this.#ports)!==r.revision){this.#fatal(r,'revision');throw NativeError('r1h_revision');}
  if(this.#mode==='full-input'){r.fullChecks++;need(isFrozen(r.binding)&&r.binding.owner===r.owner&&r.binding.ports===this.#ports&&r.binding.sequence===r.sequence&&r.binding.actor===r.actor,'full_binding');}
  else{r.ownedChecks++;need(r.ownedView===r.binding&&r.binding.ports===this.#ports,'owned_binding');}
 }
 #run<T>(h:R1hHandle,fn:(r:Read)=>T,completion=false){this.#guard();const r=this.#find(h,completion);this.#busy=true;this.#active=r;r.frames++;
  try{if(!completion)this.#live(r);const result=fn(r);if(!completion)this.#live(r);return result;}
  catch(e){if(!completion)this.#fatal(r,'operation');throw e;}
  finally{r.frames--;this.#active=undefined;this.#busy=false;if(r.readyRelease&&r.frames===0)this.#release(r);}
 }
 beginRead(actor:R1hActor='provider'){
  this.#guard();need(actor==='provider'||actor==='client','actor');need(!OwnedPorts.revoked(this.#ports)&&OwnedPorts.purpose(this.#ports)==='read','authority');const index=at(this.#registry,undefined);need(index>=0,'registry_full');need(this.#sequence<Number.MAX_SAFE_INTEGER,'generation');const now=OwnedPorts.now(this.#ports);need(integer(now+4500),'deadline');
  // Only a known-body capacity hold, not a representationCharge/parent ledger approval.
  this.#held+=2;const bodies:Body[]=[];
  try{for(let i=0;i<2;i++){
   const handles=freeze(make(8,()=>freeze({kind:'r1h-opaque' as const}))),buffer=new NativeBytes(3072);apply(fill,buffer,[i+1]);
   this.#allocations++;this.#allocated+=3072;define(bodies,bodies.length,{value:{handles,buffer,refs:make(48,()=>null),issued:false,first:false,seal:false,closed:false,zeroed:false,borrowIssued:false,transportIssued:false,firstPublished:false,sealPublished:false,borrow:undefined,transport:undefined},writable:true,enumerable:true,configurable:true});
  }}catch(e){for(let i=0;i<bodies.length;i++){const b=bodies[i]!;if(b.buffer){apply(fill,b.buffer,[0]);this.#zeroed+=3072;}}this.#held-=2;throw e;}
  const owner=bodies[0]!.handles[0]!,sequence=++this.#sequence,binding=freeze({owner,scope:freeze({sequence}),ports:this.#ports,sequence,actor});
  const r:Read={owner,authorityOwner:owner,sequence,actor,state:'active',reason:null,attempt:0,frames:0,readyRelease:false,last:now,deadline:now+4500,revision:OwnedPorts.revision(this.#ports),pin:OwnedPorts.pin(this.#ports),binding,ownedView:binding,bodies,publications:0,fullChecks:0,ownedChecks:0};
  for(let i=0;i<bodies.length;i++){const b=bodies[i]!;b.refs[0]=this;b.refs[1]=owner;b.refs[2]=binding.scope;b.refs[3]=this.#ports;b.refs[6]=this.#ports;b.refs[11]=r;b.refs[14]=b.handles[3];b.refs[15]=actor==='client'?b.handles[4]:null;b.refs[38]=b.buffer;b.refs[39]=this.#registry;b.refs[45]=b.handles[0];b.refs[46]=b.handles[5];b.refs[47]=b.handles[7];}
  this.#registry[index]=r;return owner;
 }
 openAttempt(h:R1hHandle){return this.#run(h,r=>{need(r.attempt<2&&(r.attempt===0||r.bodies[r.attempt-1]!.closed),'attempt');const b=r.bodies[r.attempt++]!;b.issued=true;b.first=true;b.seal=r.actor==='client';return b.handles[0]!;});}
 #body(r:Read,w:R1hHandle){const b=r.bodies[r.attempt-1];need(b&&b.issued&&!b.closed&&(b.handles[3]===w&&b.first||b.handles[4]===w&&b.seal),'window');return b;}
 window(h:R1hHandle,which:'first'|'seal'){return this.#run(h,r=>{need(which==='first'||which==='seal','window');const b=r.bodies[r.attempt-1];need(b?.issued&&!b.closed&&(which==='first'?b.first:b.seal),'window');return b.handles[which==='first'?3:4]!;});}
 beginBorrow(h:R1hHandle,w:R1hHandle){return this.#run(h,r=>{const b=this.#body(r,w);need(!b.borrowIssued&&b.buffer,'borrow');b.borrowIssued=true;b.borrow=b.buffer;return b.handles[5]!;});}
 endBorrow(h:R1hHandle,lease:R1hHandle){return this.#run(h,r=>{const b=find(r.bodies,b=>b.handles[5]===lease);need(b?.borrow,'borrow');b.borrow=undefined;},true);}
 beginTransport(h:R1hHandle,w:R1hHandle){return this.#run(h,r=>{const b=this.#body(r,w);need(!b.transportIssued&&b.buffer&&!some(r.bodies,b=>b.transport),'transport');b.transportIssued=true;b.transport=b.buffer;return b.handles[6]!;});}
 endTransport(h:R1hHandle,drain:R1hHandle){return this.#run(h,r=>{const b=find(r.bodies,b=>b.handles[6]===drain);need(b?.transport,'transport');b.transport=undefined;},true);}
 #publicationFault(r:Read,w:R1hHandle){const fault=OwnedPorts.take(this.#ports,'publication');if(!fault)return;
  if(fault==='reenter-publish'||fault==='reenter-reclaim'||fault==='reenter-open'){
   // Closed fault program makes an actual nested public entry and deliberately catches it.
   // No caller callback/function/Promise is accepted or retained.
   try{if(fault==='reenter-publish')this.publish(r.owner,w);else if(fault==='reenter-reclaim')this.reclaim(r.owner);else this.openAttempt(r.owner);}catch{this.#caught++;}
   this.#faultFrames=r.frames;this.#faultBodies=count(r.bodies,b=>b.buffer);
  }
  else if(fault==='cancel-before-publication')this.#fatal(r,'cancelled');
  else if(fault==='expire-before-publication')this.#ports.advance(r.deadline-OwnedPorts.now(this.#ports));
  else if(fault==='revoke-before-publication')this.#ports.revoke();
  else if(fault==='pin-restore-before-publication'){const pin=OwnedPorts.pin(this.#ports);this.#ports.setPin(pin+1);this.#ports.setPin(pin);}
 }
 publish(h:R1hHandle,w:R1hHandle){return this.#run(h,r=>{const b=this.#body(r,w);need(w===b.handles[3]?!b.firstPublished:!b.sealPublished,'published');this.#publicationFault(r,w);this.#live(r);if(w===b.handles[3])b.firstPublished=true;else b.sealPublished=true;r.publications++;this.#publications++;});}
 closeWindow(h:R1hHandle,w:R1hHandle){return this.#run(h,r=>{const b=this.#body(r,w);if(w===b.handles[3])b.first=false;else b.seal=false;b.closed=!b.first&&!b.seal;});}
 closeRead(h:R1hHandle){return this.#run(h,r=>{if(r.state==='active'){r.authorityOwner=undefined;r.state='closing';for(let i=0;i<r.bodies.length;i++){const b=r.bodies[i]!;b.first=false;b.seal=false;b.closed=true;}}},true);}
 cancel(h:R1hHandle){return this.#run(h,r=>this.#fatal(r,'cancelled'),true);}
 adoptProduction():never{this.#guard();throw NativeError('r1h_profile_unsupported');}
 exportSummary():never{this.#guard();throw NativeError('r1h_summary_unsupported');}
 reclaim(h:R1hHandle){return this.#run(h,r=>{
  need(r.state!=='active'&&r.frames===1&&!some(r.bodies,b=>b.borrow||b.transport),'early_reclaim');
  const fault=OwnedPorts.take(this.#ports,'cleanup');for(let ordinal=0;ordinal<r.bodies.length;ordinal++){const b=r.bodies[ordinal]!;need(b.buffer,'buffer');if(!b.zeroed)apply(fill,b.buffer,[0]);for(let i=0;i<3072;i++)need(b.buffer[i]===0,'zero');if(!b.zeroed)this.#zeroed+=3072;b.zeroed=true;if(fault==='cleanup-after-first'&&ordinal===0){this.#fatal(r,'cleanup');throw NativeError('r1h_cleanup');}}
  for(let i=0;i<r.bodies.length;i++){const b=r.bodies[i]!;for(let j=0;j<b.refs.length;j++)b.refs[j]=null;b.buffer=undefined;}
  r.readyRelease=true;
 },true);}
 #release(r:Read){need(r.readyRelease&&r.frames===0&&!some(r.bodies,b=>b.buffer||b.borrow||b.transport||some(b.refs,x=>x!==null)),'drain');const index=at(this.#registry,r);need(index>=0,'registry');this.#registry[index]=undefined;this.#held-=2;this.#reclaims++;}
 static observe(value:R1hRuntime,h?:R1hHandle){need(value&&typeof value==='object'&&!isProxy(value)&&prototype(value)===R1hRuntime.prototype,'runtime_binding');
  const r=h===undefined?undefined:find(value.#registry,x=>x?.owner===h),handles=r?make(16,i=>r.bodies[i>>3]!.handles[i%8]!):[];let distinct=0;for(let i=0;i<handles.length;i++)if(at(handles,handles[i]!)===i)distinct++;
  return {mode:value.#mode,capacity:value.#registry.length,readRows:count(value.#registry,r=>r!==undefined),authorityLookups:count(value.#registry,r=>r?.authorityOwner!==undefined),heldBodySlots:value.#held,bufferAllocations:value.#allocations,allocatedBytes:value.#allocated,zeroedBytes:value.#zeroed,reclaims:value.#reclaims,publications:value.#publications,reentryRefusals:value.#reentry,caughtReentries:value.#caught,faultFrameCount:value.#faultFrames,faultHeldBodies:value.#faultBodies,
   read:r?{sequence:r.sequence,actor:r.actor,state:r.state,authorityKeyPresent:r.authorityOwner!==undefined,reason:r.reason,attempt:r.attempt,deadline:r.deadline,frames:r.frames,privateBodies:count(r.bodies,b=>b.buffer),binaryBytes:3072*count(r.bodies,b=>b.buffer),referenceSlots:48*r.bodies.length,retainedIdentities:handles.length,distinctIdentities:distinct,borrows:count(r.bodies,b=>b.borrow),borrowUsesFirstBody:!!r.bodies[0]?.borrow&&r.bodies[0].borrow===r.bodies[0].buffer,bodyBuffersDistinct:r.bodies[0]?.buffer!==r.bodies[1]?.buffer,pendingTransport:count(r.bodies,b=>b.transport),transportUsesBody:some(r.bodies,b=>!!b.transport&&b.transport===b.buffer),publications:r.publications,fullChecks:r.fullChecks,ownedChecks:r.ownedChecks}:null,scope:R1H_RUNTIME_SCOPE};
 }
}
freeze(R1hRuntime.prototype);freeze(R1hRuntime);
/** Harness-only copying observer. Its caller graphs are outside, and never charged as zero inside the fixture. */
export function observeR1h(r:R1hRuntime,h?:R1hHandle){return R1hRuntime.observe(r,h);}
