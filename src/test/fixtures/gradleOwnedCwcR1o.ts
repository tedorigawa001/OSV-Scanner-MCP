/** R1-O closed, diagnostic-only ownership runtime. Not an approved R1-M/W/G backend or service adapter. */
import {types} from 'node:util';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {createR1oBudget,requireR1oBudget,checkR1oBudget,reserveR1oBudget,releaseR1oBudget,statsR1oBudget} from './gradleOwnedCwcR1oBudget.js';
import {Vf0Clock,ownedClockKind,readOwnedClock} from './gradleOwnedCwcVf0Authority.js';
import {r0DiagnosticSha as sha} from './gradleOwnedCwcR0Memory.js';
import {cprFixture} from './gradleOwnedCprAFixture.js';
import {capacityContext} from './gradleOwnedCwcLgCapacity.mjs';
import {planCore} from './gradleOwnedCprAPlanner.js';
import {context,validatePlanCore} from './gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
function need(v:unknown,r='state'):asserts v{if(!v)throw Error('r1o_'+r);}
const alloc=Buffer.alloc,write=Buffer.prototype.write,fill=Buffer.prototype.fill,text=Buffer.prototype.toString,byteLength=Buffer.byteLength,parse=JSON.parse;
const isPromise=types.isPromise,promisePrototype=Promise.prototype,promiseThen=Promise.prototype.then,promiseConstructor=Promise,promiseSpecies=Object.getOwnPropertyDescriptor(Promise,Symbol.species)!.get;
export type R1oHandle=Readonly<{kind:'r1o-opaque'}>;
export type R1oActor='provider'|'client-initial'|'client-seal';
export type R1oPart='context'|'core';
export type R1oMutation='touch'|'corrupt'|'restore'|'core-schema'|'core-inventory'|'context-binding';
export type R1oSite='source-built'|'source-stopped'|'before-validation'|'after-validation'|'before-bind';
type Store={id:number;context:Buffer;core:Buffer};
type Scope={claim:R1oHandle;window:R1oHandle;role:'source'|'destination';state:string;store?:Store};
type Borrow={handle:R1oHandle;store:Store;context?:Buffer;core?:Buffer;open:boolean};
type Event={seq:number;kind:string;borrows:number;frames:number;revision:number;epoch:number};
type Call={id:number;handles:R1oHandle[];actor:R1oActor;alive:boolean;released:boolean;reason:string|null;phase:string;busy:boolean;frames:number;pendingCallbacks:number;source?:Scope;destination?:Scope;
 ticket?:ReturnType<Lb0Budget['reserve']>;buffers:Buffer[];borrow?:Borrow;borrowUsed:boolean;pin?:Store;exclusive?:Store;stamp?:{store:Store;revision:number;epoch:number;certificate:R1oHandle};
 revision:number;epoch:number;portEpoch:number;last:number;deadline:number;sourcePin?:string;corePin?:string;entriesPin?:string;contextSeed?:string;
 traces:Event[];constructs:number;bufferAllocations:number;allocatedBytes:number;validations:number;schemaChecks:number;inventoryChecks:number;binds:number;publications:number;writes:number;zeroWrites:number;deniedWrites:number;
 zeroed:number;zeroVerified:boolean;releasedCount:number;reservations:number;scopeAllocations:number;sameSourceScope:boolean;sameDestinationScope:boolean;sameStore:boolean;sameLease:boolean;sourceRemoved:boolean;lateSourceRetired:boolean;
 boundContextDigest?:string;boundCoreDigest?:string;custodian:string};
export const R1O_SCOPE=Object.freeze({diagnosticOnly:true,closedLocalProducer:true,realPrivateBuffers:true,realRetainedBorrow:true,fixedClock:true,sameProcess:true,oneBorrowPerCall:true,
 ownedBudgetFactoryOnly:true,fixedBudgetOperations:true,synchronousCallbacksOnly:true,ordinaryPromiseRejectionDrain:true,
 originalFullSchemaValidator:true,unboundedOracleWorkspace:true,nativeHash:true,diagnosticCapacityOnly:true,actualAuthenticatedCall:false,actualReadScope:false,freshSourceIO:false,
 independentApproval:false,bridgeChargeProved:false,codecOverlayProved:false,nativeHashBoundProved:false,completeWorkCoverage:false,actualParentLedgerVector:false,
 handleRoleLayoutProved:false,wholeBudgetCoexistenceProved:false,r1Exit:false,productionAdopted:false});
export const R1O_DIAGNOSTIC_CAPACITY=Object.freeze({bytes:196608,initialization:4096,work:4096,handles:8,maxCalls:8,maxEvents:4096,maxWrites:32,contextBytes:8192,coreBytes:65536});
export class R1oRuntime {
 readonly #budget:Lb0Budget;readonly #clock:Vf0Clock;readonly #hook:(site:R1oSite,r:R1oRuntime,c:R1oHandle,s:R1oHandle,d:R1oHandle)=>void;
 readonly #role:'reader'|'authority-broker';readonly #boundary:string;readonly #workload:'small'|'stress';readonly #calls=new Map<R1oHandle,Call>();#active?:Call;#next=0;
 constructor(o:{budget?:Lb0Budget;clock?:Vf0Clock;role?:'reader'|'authority-broker';boundary?:string;workload?:'small'|'stress';hook?:(site:R1oSite,r:R1oRuntime,c:R1oHandle,s:R1oHandle,d:R1oHandle)=>void}={}){
  need(o&&!types.isProxy(o)&&Object.getPrototypeOf(o)===Object.prototype,'input');for(const k of Reflect.ownKeys(o))need(typeof k==='string'&&['budget','clock','role','boundary','workload','hook'].includes(k)&&'value'in Object.getOwnPropertyDescriptor(o,k)!,'input');
  this.#role=o.role??'reader';this.#boundary=o.boundary??'normal';this.#workload=o.workload??'small';need(['reader','authority-broker'].includes(this.#role)&&['normal','registered-maximum','schema-upper'].includes(this.#boundary)&&['small','stress'].includes(this.#workload)&&(o.hook===undefined||typeof o.hook==='function'),'recipe');
  this.#budget=o.budget??createR1oBudget();requireR1oBudget(this.#budget);this.#clock=o.clock??new Vf0Clock();need(ownedClockKind(this.#clock)==='fixed','clock');this.#hook=o.hook??(()=>{});Object.freeze(this);
 }
 #call(h:R1oHandle){const c=this.#calls.get(h);need(c,'binding');return c;}
 #event(c:Call,kind:string){need(c.traces.length<4096,'event_capacity');c.traces.push({seq:c.traces.length,kind,borrows:c.borrow?.open?1:0,frames:c.frames,revision:c.revision,epoch:c.epoch});}
 #live(c:Call){need(c.alive&&!c.released,c.reason??'closed');checkR1oBudget(this.#budget);const now=readOwnedClock(this.#clock);if(now<c.last||now>=c.deadline){this.#fail(c,now<c.last?'clock_invalid':'expired');throw Error('r1o_'+c.reason);}c.last=now;}
 #fail(c:Call,reason:string){if(!c.alive)return;c.alive=false;c.reason=reason;c.phase='retiring';c.epoch++;if(c.source)c.source.state='retired';if(c.destination)c.destination.state='retired';this.#event(c,'fatal:'+reason);}
 #invoke<T>(h:R1oHandle,fn:(c:Call)=>T,completion=false):T{const c=this.#call(h);if(this.#active){this.#fail(this.#active,'reentry');throw Error('r1o_reentry');}this.#active=c;c.busy=true;
  try{if(!completion)this.#live(c);const result=fn(c);if(!completion)this.#live(c);return result;}catch(e){this.#fail(c,'operation_failed');throw e;}finally{c.busy=false;this.#active=undefined;if(!c.alive){c.exclusive=undefined;c.stamp=undefined;}this.#drain(c);}}
 #foreign(c:Call,site:R1oSite){const result:unknown=this.#hook(site,this,c.handles[0]!,c.source!.window,c.destination!.claim);
  if(result!==undefined){this.#fail(c,'async_callback_unsupported');this.#observeRejectedPromise(c,result);throw Error('r1o_async_callback_unsupported');}this.#live(c);}
 #observeRejectedPromise(c:Call,result:unknown){
  // No then getter, caller .then, Promise.resolve assimilation or subclass/species callback is invoked.
  if(!isPromise(result)||Object.getPrototypeOf(result)!==promisePrototype||Object.getOwnPropertyDescriptor(result,'constructor'))return;
  const ctor=Object.getOwnPropertyDescriptor(promisePrototype,'constructor'),species=Object.getOwnPropertyDescriptor(promiseConstructor,Symbol.species);
  if(!ctor||!('value'in ctor)||ctor.value!==promiseConstructor||species?.get!==promiseSpecies)return;
  c.pendingCallbacks++;this.#event(c,'callback-pending');
  const settled=()=>{c.pendingCallbacks--;this.#event(c,'callback-settled');this.#drain(c);};Reflect.apply(promiseThen,result,[settled,settled]);
 }
 #scope(c:Call,h:R1oHandle,role:'source'|'destination',claim=false){const s=role==='source'?c.source:c.destination;need(s&&(claim?s.claim:s.window)===h,'binding');return s;}
 #frame<T>(c:Call,kind:string,fn:()=>T){need(c.traces.length<4088,'event_capacity');c.frames++;this.#event(c,'enter:'+kind);try{this.#live(c);const out=fn();this.#live(c);return out;}finally{this.#event(c,'exit:'+kind);c.frames--;}}
 createCall(actor:R1oActor='provider'){if(this.#active){this.#fail(this.#active,'reentry');throw Error('r1o_reentry');}need(['provider','client-initial','client-seal'].includes(actor)&&this.#next<8,'call_capacity');
  const handles=Array.from({length:8},()=>Object.freeze({kind:'r1o-opaque' as const})),c:Call={id:++this.#next,handles,actor,alive:true,released:false,reason:null,phase:'entry',busy:false,frames:0,pendingCallbacks:0,buffers:[],borrowUsed:false,revision:0,epoch:1,portEpoch:1,last:0,deadline:4500,traces:[],constructs:0,bufferAllocations:0,allocatedBytes:0,validations:0,schemaChecks:0,inventoryChecks:0,binds:0,publications:0,writes:0,zeroWrites:0,deniedWrites:0,zeroed:0,zeroVerified:false,releasedCount:0,reservations:0,scopeAllocations:0,sameSourceScope:false,sameDestinationScope:false,sameStore:false,sameLease:false,sourceRemoved:false,lateSourceRetired:false,custodian:'none'};
  this.#calls.set(handles[0]!,c);this.#event(c,'call');return handles[0]!;
 }
 registerOwnedIntake(h:R1oHandle,role:'source'|'destination',raw?:unknown){return this.#invoke(h,c=>{need(raw===undefined&&['source','destination'].includes(role),'raw_input_unsupported');need(c.phase==='entry'&&!c[role],'registration');const i=role==='source'?1:2,w=role==='source'?3:4;
  c[role]={claim:c.handles[i]!,window:c.handles[w]!,role,state:'registered'};c.scopeAllocations++;this.#event(c,'register:'+role);return c[role]!.claim;});}
 /** This actual Lb0 reservation is a diagnostic capacity exercise, NOT the R1-W all-parent vector. */
 reserveDiagnostic(h:R1oHandle){return this.#invoke(h,c=>{need(c.phase==='entry'&&c.source&&c.destination&&!c.ticket,'reservation');c.ticket=reserveR1oBudget(this.#budget);c.reservations++;c.phase='reserved';c.source.state=c.destination.state='reserved';this.#event(c,'diagnostic-reserve');});}
 #buffer(c:Call,s:string,max:number){const n=byteLength(s);need(n>0&&n<=max,'size');const b=alloc(n);c.buffers.push(b);c.bufferAllocations++;c.allocatedBytes+=n;Reflect.apply(write,b,[s,0,n,'utf8']);return b;}
 #produce(c:Call){c.constructs++;const sizes=this.#workload==='small'?[1,1,1,1,1]:[1,1,1,1,8288,8288,8288,8288,8304],f=cprFixture({role:this.#role,sizes});
  f.ctx.registryDigest=hash({schema:'r1o.synthetic-registry.v1'});const ctx=capacityContext(f.ctx,this.#role,this.#boundary),range=(e:typeof f.entries[number],offset:number,length:number,ordinal=0)=>({ordinal,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
  const groups=[f.entries.slice(0,4).map((e,i)=>range(e,0,e.byteLength,i))];for(let i=4;i<f.entries.length;i++){const e=f.entries[i]!,parts=this.#workload==='small'?1:i<7?4:3;let at=0;for(let j=0;j<parts;j++){const length=Math.ceil((e.byteLength-at)/(parts-j));groups.push([range(e,at,length)]);at+=length;}}
  const core=planCore(ctx,'r1o-seed','r1o-transfer',groups),cb=this.#buffer(c,canonical(ctx),8192),pb=this.#buffer(c,canonical(core),65536);
  c.sourcePin=sha(cb);c.corePin=sha(pb);c.entriesPin=hash(f.entries);return {id:c.id,context:cb,core:pb};
 }
 constructOwnedState(h:R1oHandle,claim:R1oHandle,raw?:unknown){return this.#invoke(h,c=>{const s=this.#scope(c,claim,'source',true);need(raw===undefined,'raw_input_unsupported');need(c.phase==='reserved'&&c.ticket&&s.state==='reserved','capacity_required');const identity=s;
  c.phase='constructing';s.store=this.#frame(c,'producer',()=>this.#produce(c));c.sameSourceScope=c.source===identity;s.state='ready';c.phase='ready';c.custodian='source';this.#event(c,'hydrate-source');this.#foreign(c,'source-built');return s.window;});}
 coreHandle(h:R1oHandle,window:R1oHandle){return this.#invoke(h,c=>{const s=window===c.source?.window?this.#scope(c,window,'source'):this.#scope(c,window,'destination');need(s.state==='ready'||s.state==='published','not_hydrated');return window;});}
 inspectScope(h:R1oHandle,claim:R1oHandle){return this.#invoke(h,c=>{const s=claim===c.source?.claim?this.#scope(c,claim,'source',true):this.#scope(c,claim,'destination',true);need(s.store&&(s.state==='ready'||s.state==='published'),'not_hydrated');return {context:sha(s.store.context),core:sha(s.store.core)};});}
 beginBorrow(h:R1oHandle,window:R1oHandle){return this.#invoke(h,c=>{const s=this.#scope(c,window,'source');need(c.phase==='ready'&&s.state==='ready'&&s.store&&!c.borrowUsed,'borrow_state');c.borrowUsed=true;c.borrow={handle:c.handles[6]!,store:s.store,context:s.store.context,core:s.store.core,open:true};this.#event(c,'borrow-open');return c.borrow.handle;});}
 completeBorrow(h:R1oHandle,borrow:R1oHandle){return this.#invoke(h,c=>{need(c.borrow?.open&&c.borrow.handle===borrow,'borrow_state');c.borrow.open=false;c.borrow.context=undefined;c.borrow.core=undefined;c.borrow=undefined;this.#event(c,'borrow-close');},true);}
 #denied(c:Call){c.deniedWrites++;this.#fail(c,'mutation_blocked');if(!this.#active)this.#drain(c);throw Error('r1o_mutation_blocked');}
 #mutate(h:R1oHandle,window:R1oHandle,part:R1oPart,mutation:R1oMutation| 'zero',borrow=false){const c=this.#call(h);if(this.#active&&this.#active!==c){this.#fail(this.#active,'reentry');throw Error('r1o_reentry');}
  if(!c.alive||c.exclusive||c.phase==='validated'||c.phase==='published'||(!borrow&&c.epoch!==c.portEpoch))return this.#denied(c);
  return this.#invoke(h,row=>{need(['context','core'].includes(part)&&['touch','corrupt','restore','zero','core-schema','core-inventory','context-binding'].includes(mutation),'mutation_input');need(row.writes+row.zeroWrites<32,'write_capacity');
   let store:Store;if(borrow){need(row.borrow?.open&&row.borrow.handle===window&&['ready','quiescing'].includes(row.phase),'borrow_state');store=row.borrow.store;}else{const s=this.#scope(row,window,'source');need(row.phase==='ready'&&s.state==='ready'&&s.store,'source_stopped');store=s.store;}
   need(row.revision<Number.MAX_SAFE_INTEGER,'generation');const b=store[part];if(mutation==='zero'){Reflect.apply(fill,b,[0]);row.zeroWrites++;}else{
    if(['core-schema','core-inventory','context-binding'].includes(mutation)){need(part===(mutation==='context-binding'?'context':'core'),'mutation_input');const s=Reflect.apply(text,b,['utf8']) as string,needle=mutation==='core-schema'?'"domain":"cpr.plan-core.v3':mutation==='core-inventory'?'"sha256":"':'"manifest":"',start=mutation==='core-inventory'?s.indexOf('"groups":'):0,at=s.indexOf(needle,start);need(start>=0&&at>=0,'mutation_target');const index=at+needle.length-(mutation==='core-schema'?1:0);b[index]=mutation==='core-schema'?52:b[index]===97?98:97;
    }else b[0]=mutation==='corrupt'?33:mutation==='restore'?123:b[0]!;row.writes++;
   }row.revision++;this.#event(row,'write:'+mutation);
  });
 }
 sourceUpdate(h:R1oHandle,window:R1oHandle,part:R1oPart,mutation:R1oMutation='touch'){return this.#mutate(h,window,part,mutation);}
 sourceZero(h:R1oHandle,window:R1oHandle,part:R1oPart){return this.#mutate(h,window,part,'zero');}
 borrowUpdate(h:R1oHandle,borrow:R1oHandle,part:R1oPart,mutation:R1oMutation='touch'){return this.#mutate(h,borrow,part,mutation,true);}
 moveOwnedState(h:R1oHandle,window:R1oHandle,destination:R1oHandle){return this.#invoke(h,c=>{const s=this.#scope(c,window,'source'),d=this.#scope(c,destination,'destination',true);need(c.phase==='ready'&&s.store&&d.state==='reserved','handoff_state');
  c.pin=s.store;c.custodian='pin';c.epoch++;s.state='stopped';d.state='pending';c.phase='quiescing';this.#event(c,'pin-and-stop-source');this.#foreign(c,'source-stopped');});}
 #validate(c:Call,store:Store){c.validations++;const cs=Reflect.apply(text,store.context,['utf8']) as string,ps=Reflect.apply(text,store.core,['utf8']) as string;
  const ctx=context(parse(cs));c.schemaChecks++;const p=validatePlanCore(parse(ps));c.schemaChecks++;need(canonical(ctx)===cs&&canonical(p)===ps,'canonical');
  for(const k of ['catalog','peer','provider','origin','lineage','binding','snapshot','checkpoint','pin','metadataDigest','inventoryDigest'] as const){const a=p[k],b=ctx[k];need(a===undefined||b===undefined?a===b:canonical(a)===canonical(b),'context_binding');}
  const entries:{kind:string;index:number;sha256:string;byteLength:number}[]=[];for(const group of p.groups)for(const r of group)if(!entries.some(e=>e.kind===r.kind&&e.index===r.index))entries.push({kind:r.kind,index:r.index,...r.entry});
  c.inventoryChecks++;need(hash(entries)===c.entriesPin,'snapshot_binding');need(sha(store.context)===c.sourcePin&&sha(store.core)===c.corePin,'content_binding');
 }
 #fence(c:Call,store:Store){this.#live(c);need(c.pin===store&&c.exclusive===store&&c.stamp?.store===store&&c.stamp.certificate===c.handles[7]&&c.stamp.revision===c.revision&&c.stamp.epoch===c.epoch&&!c.borrow&&c.frames===0&&c.source?.store===store&&!c.destination?.store,'lease_binding');}
 publishOwnedWindow(h:R1oHandle){return this.#invoke(h,c=>{need(c.phase==='quiescing'&&c.pin&&c.source?.store===c.pin&&c.destination?.state==='pending'&&!c.borrow&&c.frames===0,'borrow_active');const store=c.pin,d=c.destination,identity=d,ticket=c.ticket;
  this.#event(c,'drain-existing-borrows');c.exclusive=store;c.phase='exclusive';this.#event(c,'acquire-exclusive-handoff');this.#foreign(c,'before-validation');
  this.#frame(c,'complete-validation',()=>this.#validate(c,store));c.stamp={store,revision:c.revision,epoch:c.epoch,certificate:c.handles[7]!};c.phase='validated';this.#event(c,'final-complete-validation');this.#foreign(c,'after-validation');this.#foreign(c,'before-bind');
  this.#fence(c,store);this.#event(c,'final-fence');
  // Fixed synchronous custody move: no caller callback/await or byte copy between the fence and publication.
  d.store=store;c.source!.store=undefined;c.source!.state='moved';c.sourceRemoved=c.source!.store===undefined;c.sameStore=d.store===store;c.sameLease=c.ticket===ticket;c.sameDestinationScope=c.destination===identity;c.custodian='destination';d.state='published';c.binds++;this.#event(c,'bind-destination');
  c.pin=undefined;c.exclusive=undefined;c.stamp=undefined;c.phase='published';c.boundContextDigest=sha(store.context);c.boundCoreDigest=sha(store.core);c.publications++;this.#event(c,'publish-window');return d.window;
 });}
 retireOwnedState(h:R1oHandle,window:R1oHandle){return this.#invoke(h,c=>{this.#scope(c,window,'source');if(c.phase==='published'&&c.source!.state==='moved'){need(!c.source!.store,'source_holder');c.lateSourceRetired=true;this.#event(c,'retire-old-source');return;}this.#fail(c,'source_retired');});}
 adoptProduction(h:R1oHandle):never{return this.#invoke(h,()=>{throw Error('r1o_profile_unsupported');});}
 close(h:R1oHandle){const c=this.#call(h);if(this.#active&&this.#active!==c){this.#fail(this.#active,'reentry');throw Error('r1o_reentry');}this.#fail(c,'closed');this.#drain(c);}
 #drain(c:Call){if(c.alive||c.busy||c.frames||c.pendingCallbacks||c.borrow?.open||c.exclusive||c.released)return;
  for(const b of c.buffers){Reflect.apply(fill,b,[0]);for(let i=0;i<b.length;i++)need(b[i]===0,'zero_failed');c.zeroed+=b.length;}c.zeroVerified=true;c.buffers=[];
  if(c.source)c.source.store=undefined;if(c.destination)c.destination.store=undefined;c.pin=undefined;c.stamp=undefined;c.custodian='none';if(c.ticket){releaseR1oBudget(this.#budget,c.ticket);c.ticket=undefined;c.releasedCount++;}c.released=true;c.phase='drained';this.#event(c,'drained');
 }
 stats(h:R1oHandle){const c=this.#call(h);return {actor:c.actor,phase:c.phase,alive:c.alive,released:c.released,reason:c.reason,revision:c.revision,epoch:c.epoch,custodian:c.custodian,
  constructs:c.constructs,bufferAllocations:c.bufferAllocations,allocatedBytes:c.allocatedBytes,freshSourceReads:0,validations:c.validations,schemaChecks:c.schemaChecks,inventoryChecks:c.inventoryChecks,binds:c.binds,publications:c.publications,
  writes:c.writes,zeroWrites:c.zeroWrites,deniedWrites:c.deniedWrites,borrows:c.borrow?.open?1:0,borrowReferences:c.borrow?.open?2:0,borrowUsesPinnedStore:!!c.borrow?.open&&c.borrow.store===c.pin,frames:c.frames,pendingCallbacks:c.pendingCallbacks,privateBuffers:c.buffers.length,pinned:!!c.pin,exclusive:!!c.exclusive,
  sourceBuffers:c.source?.store?2:0,destinationBuffers:c.destination?.store?2:0,zeroedBytes:c.zeroed,zeroVerified:c.zeroVerified,reservations:c.reservations,releases:c.releasedCount,handleCapacity:c.handles.length,
  scopeAllocations:c.scopeAllocations,sameSourceScope:c.sameSourceScope,sameDestinationScope:c.sameDestinationScope,sameStore:c.sameStore,sameLease:c.sameLease,sourceRemoved:c.sourceRemoved,lateSourceRetired:c.lateSourceRetired,
  contextDigest:c.boundContextDigest??null,coreDigest:c.boundCoreDigest??null,budget:statsR1oBudget(this.#budget),trace:c.traces.map(x=>({...x})),scope:R1O_SCOPE};}
}
Object.freeze(R1oRuntime.prototype);Object.freeze(R1oRuntime);
