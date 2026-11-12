/** CCO-R0 standalone owned producer. No A/B proof, IO permit, authority or production admission. */
import {read16,write16,read32,write32,r0DiagnosticSha as sha} from './gradleOwnedCwcR0Memory.js';
import {types} from 'node:util';
import {R0Core,R0Sink,emitCore,emitOperation,emitCommand,checkOwnedCommand} from './gradleOwnedCwcR0Engine.js';
import {R0Tokens} from './gradleOwnedCwcR0Tokens.js';
import {R0_COMMAND} from './gradleOwnedCwcR0Grammar.js';
import {context} from './gradleOwnedCprASchema.js';
import {lgOwnedCopy} from './gradleOwnedCwcLg0Contract.js';
import {cwcCMemory} from './gradleOwnedCwcC.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Clock,readOwnedClock,ownedClockKind} from './gradleOwnedCwcVf0Authority.js';
import {canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
const need=(v:unknown,r='state')=>{if(!v)throw Error('r0_'+r);};
const alloc=Buffer.alloc,from=Buffer.from,copy=Buffer.prototype.copy,fill=Buffer.prototype.fill;
type Handle=Readonly<{kind:'r0-opaque'}>;
type Actor='provider'|'client-initial'|'client-seal';
type Child={actor:Actor;state:string;generation:number;claimed:boolean;n:number;captured:number;processed:number;slab:Buffer;builder:R0Core;expected:R0Core};
type Event={seq:number;kind:string;actor:number;ordinal:number;frame:number;depth:number;slot:number;active:number};
export type R0Fault='expected-seed'|'retained-index'|'row-after-normalize';
export const R0_SCOPE=Object.freeze({standalone:true,fixedClock:true,ownedPackedCores:true,boundedCommandParser:true,streamingProjection:true,originalOracleInHarness:true,
 bootstrapGenericContextValidation:true,nativeHash:true,managedFrameTrace:true,wholeVmReferenceUpperBound:false,metadataChargeProved:false,coreRepresentationChargeProved:false,
 nativeHashUpperBoundProved:false,completeWorkCoverage:false,codecOverlayCoexistence:false,actualAB:false,actualReadScope:false,actualSession:false,lgModesConnected:false,co0Exit:false,productionAdopted:false});
export class R0Owner {
 readonly #clock:Vf0Clock;readonly #budget:Lb0Budget;readonly #hook:(site:string,owner:R0Owner)=>void;readonly #ctor:ReturnType<Lb0Budget['reserve']>;
 #reservation?:ReturnType<Lb0Budget['reserve']>;#children:Child[]=[];#handles:Handle[]=[];#lookup=true;#alive=true;#released=false;#busy=false;#reason:string|null=null;
 #metadata?:Buffer;#chunk?:Buffer;#slots:Buffer[]=[];#buffers:Buffer[]=[];#parser?:R0Tokens;#sink?:R0Sink;#slotLive=[false,false,false];#slotPeak=0;#frame=0;#stack:number[]=[];#trace:Event[]=[];
 #ordinal=0;#actor=-1;#deadline=4500;#last=0;#compared=0;#comparedBytes=0;#width=0;#coreWidth=0;#contextWidth=0;#equal=false;#encoded:number[][]=[];
 #finalRows:string[][]=[];#framesPeak=0;#tokenPeak=0;#nativeMetrics={hashes:0,hashBytes:0,chunks:0,viewPeak:0};
 readonly #fault?:R0Fault;#clearedBuffers=0;#clearedBytes=0;#zeroVerified=false;
 constructor(o:{context:unknown;groups:unknown;seed:string;transferId:string;kind:'provider'|'client';budget:Lb0Budget;clock:Vf0Clock;hook?:(site:string,owner:R0Owner)=>void;fault?:R0Fault}){
  need(o&&!types.isProxy(o)&&Object.getPrototypeOf(o)===Object.prototype,'input');for(const k of Reflect.ownKeys(o))need(typeof k==='string'&&['context','groups','seed','transferId','kind','budget','clock','hook','fault'].includes(k)&&'value'in Object.getOwnPropertyDescriptor(o,k)!,'input');
  need(['context','groups','seed','transferId','kind','budget','clock'].every(k=>Object.hasOwn(o,k))&&typeof o.seed==='string'&&typeof o.transferId==='string'&&(o.hook===undefined||typeof o.hook==='function'),'input');
  need(o.fault===undefined||['expected-seed','retained-index','row-after-normalize'].includes(o.fault),'fault');this.#fault=o.fault;
  Lb0Budget.require(o.budget);need(ownedClockKind(o.clock)==='fixed'&&['provider','client'].includes(o.kind),'unsupported');this.#budget=o.budget;this.#clock=o.clock;this.#hook=o.hook??(()=>{});
  this.#ctor=this.#budget.reserve(131072,4096);
  try{
   // Bootstrap is independently disclosed, not part of a claimed fully bounded R1 recipe.
   const c=context(lgOwnedCopy(o.context,65536)),ctx=Reflect.apply(from,Buffer,[canonical(c)]) as Buffer;this.#buffers.push(ctx);
   const groups=lgOwnedCopy(o.groups,65536),bounds=cwcCMemory(c);
   this.#width=bounds.commandBytes;this.#coreWidth=bounds.coreBytes;this.#contextWidth=ctx.length;
   const F=o.kind==='provider'?1:2,coreCount=o.kind==='provider'?3:4;
   this.#reservation=this.#budget.reserve(19*F*this.#width+coreCount*this.#coreWidth+3*ctx.length+3*8192+4096+16384+4096,0,F*4096);
   this.#metadata=this.#alloc(3072);this.#chunk=this.#alloc(4096);this.#slots=[this.#alloc(8192),this.#alloc(8192),this.#alloc(8192)];this.#parser=new R0Tokens(this.#slots[2]!);
   this.#sink=new R0Sink(this.#chunk,()=>this.#live());this.#handles=Array.from({length:8},()=>Object.freeze({kind:'r0-opaque'}));
   this.#event('bootstrap-enter');
   for(let i=0;i<F;i++){
    this.#actor=i;const builder=new R0Core(this.#alloc(this.#coreWidth),ctx.length,ctx,groups,o.seed,o.transferId),expected=new R0Core(this.#alloc(this.#coreWidth),ctx.length,ctx,groups,this.#fault==='expected-seed'?'independent-fault':o.seed,o.transferId);
    this.#frameRun('core-builder',()=>{this.#sink!.begin();emitCore(this.#sink!,builder);builder.setDigest(this.#sink!.end() as string);});
    this.#frameRun('core-expected',()=>{this.#sink!.begin();emitCore(this.#sink!,expected);expected.setDigest(this.#sink!.end() as string);});
    this.#children.push({actor:F===1?'provider':i===0?'client-initial':'client-seal',state:'ready',generation:1,claimed:false,n:builder.n,captured:0,processed:0,slab:this.#alloc(19*this.#width),builder,expected});this.#metadata[8+i]=builder.n;this.#encoded.push([]);
   }
   Reflect.apply(fill,ctx,[0]);this.#buffers.splice(this.#buffers.indexOf(ctx),1);this.#actor=-1;this.#event('bootstrap-exit');this.#live();Object.freeze(this);
  }catch(e){try{this.#reject(e);}finally{this.#cleanup();}throw e;}
 }
 #alloc(n:number){const b=alloc(n);this.#buffers.push(b);return b;}
 #event(kind:string,slot=-1){need(this.#trace.length<(['failed','drained'].includes(kind)?16384:16382),'trace_limit');this.#trace.push({seq:this.#trace.length,kind,actor:this.#actor,ordinal:this.#ordinal,frame:this.#stack.at(-1)??0,depth:this.#stack.length,slot,active:this.#slotLive.filter(Boolean).length});}
 #live(){need(this.#alive&&!this.#released,this.#reason??'closed');this.#budget.check();const t=readOwnedClock(this.#clock);need(t>=this.#last&&t<this.#deadline,'expired');this.#last=t;}
 #foreign(site:string){this.#hook(site,this);this.#live();}
 #run<T>(fn:()=>T):T{if(this.#busy){this.#fail('reentry');throw Error('r0_reentry');}this.#busy=true;
  try{this.#live();const out=fn();this.#live();return out;}catch(e){this.#reject(e);throw e;}finally{this.#busy=false;this.#cleanup();}}
 #frameRun<T>(label:string,fn:()=>T):T{need(this.#trace.length<16380,'trace_limit');const id=++this.#frame;this.#stack.push(id);this.#framesPeak=Math.max(this.#framesPeak,this.#stack.length);this.#event('enter:'+label);
  try{this.#live();const v=fn();this.#live();return v;}finally{this.#event('exit:'+label);need(this.#stack.pop()===id,'frame');}}
 #lease(slot:number){this.#live();need(!this.#slotLive[slot],'slot_busy');this.#slotLive[slot]=true;this.#slotPeak=Math.max(this.#slotPeak,this.#slotLive.filter(Boolean).length);this.#event('lease',slot);}
 #release(slot:number){need(this.#stack.length===0,'frame_live');need(this.#slotLive[slot],'slot_state');if(slot===2)this.#parser!.clear();else Reflect.apply(fill,this.#slots[slot]!,[0]);this.#slotLive[slot]=false;this.#event('release',slot);}
 #child(h:Handle){need(this.#lookup,'lookup');let index=-1;for(let i=0;i<this.#children.length;i++)if(this.#handles[3+i]===h)index=i;need(index>=0,'binding');const c=this.#children[index]!;need(c.claimed&&c.state!=='closed','binding');this.#actor=index;return c;}
 claim(actor:Actor){return this.#run(()=>{const i=this.#children.findIndex(c=>c.actor===actor);need(i>=0,'actor');const c=this.#children[i]!;need(!c.claimed,'claim_reused');c.claimed=true;this.#actor=i;this.#event('claim');this.#foreign('claim-after');return this.#handles[1+i]!;});}
 open(claim:Handle){return this.#run(()=>{let i=-1;for(let k=0;k<this.#children.length;k++)if(claim===this.#handles[1+k])i=k;need(i>=0,'binding');const c=this.#children[i]!;need(c.claimed&&c.state==='ready','state');
  if(i===1)need(this.#children[0]!.state==='compared','initial_incomplete');this.#actor=i;c.state='capturing';this.#event('open');this.#foreign('open-after');return this.#handles[3+i]!;});}
 coreHandle(h:Handle){return this.#run(()=>{const c=this.#child(h);need(['capturing','captured','processing','compared'].includes(c.state),'state');this.#event('core-alias');return h;});}
 #make(c:R0Core,ordinal:number,target:Buffer,offset:number){const s=this.#sink!;s.begin();emitOperation(s,c,ordinal);const operation=s.end() as string;
  s.begin();s.literal('{"command":');emitCommand(s,c,ordinal,operation);s.literal(',"domain":"cpr.wire-intent.v3"}');const digest=s.end() as string;
  s.begin(target,offset,this.#width);emitCommand(s,c,ordinal,operation,digest);return s.end() as number;}
 #parseCheck(source:Buffer,length:number,offset:number,core:R0Core){const p=this.#parser!;p.parse(source,length,R0_COMMAND,offset);this.#tokenPeak=Math.max(this.#tokenPeak,p.count);checkOwnedCommand(p,core,this.#sink!);}
 capture(h:Handle){return this.#run(()=>{const c=this.#child(h);need(c.state==='capturing'&&c.captured<c.n,'ordinal');this.#ordinal=c.captured;this.#foreign('capture-before');
  const length=this.#frameRun('capture',()=>this.#make(c.builder,c.captured,c.slab,c.captured*this.#width));
  this.#lease(2);this.#frameRun('capture-check',()=>this.#parseCheck(c.slab,length,c.captured*this.#width,c.builder));this.#release(2);
  write32(this.#metadata!,length,128+this.#actor*19*64+c.captured*64+4);this.#encoded[this.#actor]!.push(length);this.#foreign('capture-after');c.captured++;this.#event('captured');if(c.captured===c.n)c.state='captured';
 });}
 process(h:Handle){return this.#run(()=>{const c=this.#child(h);need(['captured','processing'].includes(c.state)&&c.captured===c.n&&c.processed<c.n,'ordinal');c.state='processing';this.#ordinal=c.processed;
  const n=read32(this.#metadata!,128+this.#actor*19*64+c.processed*64+4),offset=c.processed*this.#width;
  this.#foreign('normalize-before');this.#lease(0);this.#lease(2);
  this.#frameRun('normalize',()=>{need(n>0&&n<=this.#width,'row_width');Reflect.apply(copy,c.slab,[this.#slots[0]!,0,offset,offset+n]);this.#parseCheck(this.#slots[0]!,n,0,c.expected);});if(this.#fault!=='retained-index')this.#release(2);
  need(!this.#slotLive[2],'index_borrow_live');if(this.#fault==='row-after-normalize')c.slab[offset]=c.slab[offset]!^1;
  this.#foreign('expected-before');this.#lease(1);
  const m=this.#frameRun('expected',()=>this.#make(c.expected,c.processed,this.#slots[1]!,0));this.#lease(2);
  this.#frameRun('expected-check',()=>this.#parseCheck(this.#slots[1]!,m,0,c.expected));this.#release(2);this.#foreign('compare-before');
  this.#frameRun('compare',()=>{need(n===m,'expected_mismatch');for(let i=0;i<n;i++)need(this.#slots[0]![i]===this.#slots[1]![i]&&this.#slots[0]![i]===c.slab[offset+i],'expected_mismatch');});
  this.#foreign('compare-after');this.#release(1);this.#release(0);c.processed++;this.#compared++;this.#comparedBytes+=n;this.#event('compared');if(c.processed===c.n)c.state='compared';
 });}
 compareFamilies(){return this.#run(()=>{need(this.#children.length===2&&!this.#equal&&this.#children.every(c=>c.state==='compared'),'state');const [a,b]=this.#children;need(a!.n===b!.n,'family_count');
  this.#frameRun('family-compare',()=>{for(let i=0;i<a!.n;i++){const n=this.#encoded[0]![i]!;need(n===this.#encoded[1]![i],'family_mismatch');for(let j=0;j<n;j++)need(a!.slab[i*this.#width+j]===b!.slab[i*this.#width+j],'family_mismatch');}});
  this.#foreign('families-after');this.#equal=true;return 'storage-equal' as const;
 });}
 /** Diagnostic export is a copy outside the claimed command path; it is NOT a fact or dispatch permit. */
 diagnosticRows(h:Handle){return this.#run(()=>{const c=this.#child(h);need(c.state==='compared','state');return Array.from({length:c.n},(_,i)=>{
  const n=this.#encoded[this.#actor]![i]!,out=alloc(n);Reflect.apply(copy,c.slab,[out,0,i*this.#width,i*this.#width+n]);return out;});});}
 /** Negative-test ingress only. Original oracle runs in the harness, never here. */
 diagnosticValidate(bytes:Buffer,h:Handle){return this.#run(()=>{const c=this.#child(h);need(!types.isProxy(bytes)&&Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=this.#width,'input');
  this.#lease(0);this.#lease(2);this.#frameRun('diagnostic-validate',()=>{Reflect.apply(copy,bytes,[this.#slots[0]!,0]);this.#parseCheck(this.#slots[0]!,bytes.length,0,c.expected);});this.#release(2);this.#release(0);return true;
 });}
 finish():never{return this.#run(()=>{throw Error('r0_proof_unavailable');});}
 /** Revoke first. Exception diagnostics must never invoke foreign getters/coercion or replace the first failure. */
 #reject(error:unknown){const first=this.#alive;this.#fail('operation_failed');if(!first)return;
  try{if(typeof error==='string')this.#reason=error;else if(error!==null&&typeof error==='object'&&!types.isProxy(error)){
   const message=Object.getOwnPropertyDescriptor(error,'message');if(message&&'value'in message&&typeof message.value==='string')this.#reason=message.value;
  }}catch{/* Diagnostic failure cannot stop invalidation or the caller's finally cleanup. */}
 }
 #fail(reason:string){if(!this.#alive)return;this.#alive=false;this.#lookup=false;this.#reason=reason;for(const c of this.#children){c.state='closed';c.generation++;}this.#event('failed');}
 close(){this.#fail('owner_closed');this.#cleanup();}
 #cleanup(){if(this.#alive||this.#busy||this.#stack.length||this.#released)return;
  this.#sink?.abort();try{this.#finalRows=this.#children.map((c,i)=>Array.from({length:c.captured},(_,j)=>{const n=this.#encoded[i]![j]!,out=alloc(n);try{Reflect.apply(copy,c.slab,[out,0,j*this.#width,j*this.#width+n]);return sha(out);}finally{Reflect.apply(fill,out,[0]);}}));}finally{
  this.#parser?.clear();for(const c of this.#children){c.builder.clear();c.expected.clear();}
  for(const b of this.#buffers){Reflect.apply(fill,b,[0]);for(let i=0;i<b.length;i++)need(b[i]===0,'zero_failed');this.#clearedBuffers++;this.#clearedBytes+=b.length;}this.#zeroVerified=true;this.#buffers=[];
  if(this.#sink)this.#nativeMetrics={hashes:this.#sink.hashes,hashBytes:this.#sink.hashBytes,chunks:this.#sink.chunks,viewPeak:this.#sink.viewPeak};
  this.#children=[];this.#slots=[];this.#slotLive=[false,false,false];this.#handles=[];this.#parser=undefined;this.#sink=undefined;this.#chunk=undefined;this.#metadata=undefined;this.#encoded=[];this.#event('drained');
  if(this.#reservation)this.#budget.release(this.#reservation);this.#budget.release(this.#ctor);this.#released=true;}
 }
 stats(){return {alive:this.#alive,released:this.#released,lookup:this.#lookup,reason:this.#reason,width:this.#width,coreWidth:this.#coreWidth,contextWidth:this.#contextWidth,
  compared:this.#compared,comparedBytes:this.#comparedBytes,familiesEqual:this.#equal,handleCapacity:8,coreHandleAllocations:0,slotPeak:this.#slotPeak,slotLive:this.#slotLive.filter(Boolean).length,
  liveFrames:this.#stack.length,framePeak:this.#framesPeak,tokenPeak:this.#tokenPeak,liveBuffers:this.#buffers.length,clearedBuffers:this.#clearedBuffers,clearedBytes:this.#clearedBytes,zeroVerified:this.#zeroVerified,sinkActive:this.#sink?.active??false,nativeViewLive:this.#sink?.viewLive??0,
  native:this.#sink?{hashes:this.#sink.hashes,hashBytes:this.#sink.hashBytes,chunks:this.#sink.chunks,viewPeak:this.#sink.viewPeak}:this.#nativeMetrics,
  children:this.#children.map(c=>({actor:c.actor,state:c.state,n:c.n,captured:c.captured,processed:c.processed,generation:c.generation,reservedRows:19,reservedBytes:19*this.#width})),
  budget:this.#budget.stats(),publications:0,proofs:0,finalRows:this.#finalRows.map(x=>x.slice()),trace:this.#trace.map(x=>({...x})),scope:R0_SCOPE};}
}
Object.freeze(R0Owner.prototype);Object.freeze(R0Owner);
