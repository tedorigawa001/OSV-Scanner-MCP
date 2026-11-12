/** LG-M1 diagnostic only: wraps the unchanged A/B consumer. A four-object witness
 * is a lower bound, never a heap measurement or an approved command-window implementation.
 * Vitest module spies are restored synchronously; this probe must not run concurrently.
 */
import {vi} from 'vitest';
import * as schema from './gradleOwnedCprASchema.js';
import {CwcAContract} from './gradleOwnedCwcA.js';
import {ClosedCwcBCodec} from './gradleOwnedCwcB.js';
import {CwcCReadScope,CwcCWorkLedger} from './gradleOwnedCwcC.js';
import {cwcCCase} from './gradleOwnedCwcCCase.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {planCore,CPR_PLAN_WORK_BOUND} from './gradleOwnedCprAPlanner.js';
import {exact,newStats} from './gradleOwnedCprAWire.js';
import {sourceInventory} from '../../utils/gradleOwnedSourceSchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {capacityContext} from './gradleOwnedCwcLgCapacity.mjs';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export {WINDOW_SITES} from './gradleOwnedCwcLgWindowValidation.mjs';

export const WINDOW_SCOPE=Object.freeze({actualUnmodifiedABConsumer:true,actualConnectedGrant:true,
 fixedClock:true,sameProcess:true,diagnosticSpies:true,lowerBoundOnly:true,separateDiagnosticBudget:true,lgModeRuntimeConnected:false,
 originalPipelineChanged:false,providerSessionConnected:false,threeSlotBoundEstablished:false,
 metadataLayoutProved:false,extraWorkBoundProved:false,budgetCoexistenceProved:false,lg0ExitEstablished:false,productionAdopted:false});
type Lease={id:number;site:string;value?:object;fact?:boolean};
type Event={seq:number;ordinal:number;kind:string;id:number;site:string;object:number|null;active:number;bytes:number;live:number[]};
type Fault='none'|'parse-failure'|'reentry'|'deadline'|'revocation';
/** Deliberately over-observes method-local values until method return. The decisive
 * witness occurs INSIDE schema.parse, while all four references are demonstrably live. */
class AllocationProbe {
 readonly events:Event[]=[];readonly #active=new Map<number,Lease>();readonly #ids=new WeakMap<object,number>();
 readonly #budget:Lb0Budget;readonly #ticket:ReturnType<Lb0Budget['reserve']>;
 #next=0;#object=0;#busy=false;#fatal=false;ordinal=-1;peak=0;denied=false;deniedParseCalls=0;parseCalls=0;copies=0;decodes=0;builds=0;
 constructor(readonly capacity:number,budget=new Lb0Budget()){
  need(capacity===3||capacity===8,'window_configuration');this.#budget=budget;
  // A separate diagnostic reservation. This does NOT establish coexistence with real CWC memory.
  this.#ticket=budget.reserve(capacity*8192+4096,4096);
 }
 #event(kind:string,l:Lease,bytes=0){this.events.push({seq:this.events.length,ordinal:this.ordinal,kind,id:l.id,site:l.site,
  object:l.value?this.#ids.get(l.value)!:null,active:this.#active.size,bytes,live:[...this.#active.keys()]});}
 acquire(site:string){need(!this.#fatal,'window_closed');const l={id:++this.#next,site};
  if(this.#active.size>=this.capacity){this.denied=true;this.#fatal=true;this.#event('denied',l);throw Error('command_window_exhausted');}
  this.#active.set(l.id,l);this.peak=Math.max(this.peak,this.#active.size);this.#event('reserve',l);return l;
 }
 bind(l:Lease,value:object){need(this.#active.get(l.id)===l&&!l.value,'window_binding');
  need(!this.#ids.has(value),'window_alias');this.#ids.set(value,++this.#object);l.value=value;
  const bytes=Buffer.byteLength(canonical(value));need(bytes>0&&bytes<=8192,'window_width');this.#event('allocated',l,bytes);
 }
 release(l:Lease){if(this.#active.delete(l.id)){this.#event('release',l);l.value=undefined;}}
 run<T>(fn:()=>T){if(this.#busy){this.#fatal=true;throw Error('window_reentry');}need(!this.#fatal,'window_closed');this.#busy=true;
  try{const out=fn();need(!this.#fatal,'window_closed');return out;}catch(e){this.#fatal=true;throw e;}finally{this.#busy=false;}}
 cleanup(){for(const l of [...this.#active.values()].reverse())this.release(l);this.#fatal=true;this.#budget.release(this.#ticket);}
 get final(){return this.#budget.stats();}
 get liveObjects(){return [...this.#active.values()].filter(x=>x.value).map(x=>({id:x.id,object:this.#ids.get(x.value!)!,site:x.site}));}
}
type Frame={kind:'encode'|'proof'|'inspect'|'check'|'command'|'expected';leases:Lease[]};
const sizes=[1,1,1,1,8288,8288,8288,8288,8304];
const ledgers=new WeakMap<object,CwcCWorkLedger>();
export function windowInput(role:'reader'|'authority-broker',boundary:string){
 const approval=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:approval.view,role,sizes});
 try{return {approval,context:capacityContext(f.ctx,role,boundary),metadata:structuredClone(f.source.metadata),entries:sourceInventory(f.source).rows};}finally{f.close();}
}
/** The workload has 19 complete commands, one four-range group and every one of 41,460 bytes.
 * Packing is deliberately NOT optimized here; these valid groups are a fixed consumer stress input. */
function inputCore(c:schema.CprContext,entries:ReturnType<typeof sourceInventory>['rows']){
 const range=(e:typeof entries[number],offset:number,length:number,ordinal=0)=>({ordinal,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
 const groups:schema.CprRange[][]=[entries.slice(0,4).map((e,i)=>range(e,0,e.byteLength,i))];
 for(let i=4;i<entries.length;i++){const e=entries[i]!,count=i<7?4:3;let offset=0;for(let j=0;j<count;j++){
  const length=Math.ceil((e.byteLength-offset)/(count-j));groups.push([range(e,offset,length)]);offset+=length;}}
 return planCore(c,'s'.repeat(128),'t'.repeat(128),groups);
}
export function windowAttempt(input:ReturnType<typeof windowInput>,options:{capacity:3|8;mode:'full-input'|'owned-input';balance?:{work:number};diagnosticBudget?:Lb0Budget;fault?:Fault} ){
 need(options.mode==='full-input'||options.mode==='owned-input','window_configuration');
 const c=schema.context(input.context),core=inputCore(c,input.entries),balance=options.balance??{work:0},fault=options.fault??'none';
 const diagnostic=new AllocationProbe(options.capacity,options.diagnosticBudget),frames:Frame[]=[],spies:{mockRestore:()=>void}[]=[];
 const realClone=globalThis.structuredClone,realParse=schema.cprCommandSchema.parse,realCommand=schema.command,realCheck=schema.checkCommand,realMake=schema.makeCommand;
 let now=0,current=true,scope:CwcCReadScope|undefined,owner:CwcAContract|undefined,codec:ClosedCwcBCodec|undefined,grant:ReturnType<CwcCReadScope['grant']>|undefined;
 const commandWidths:number[]=[];
 let active=false,completed=0,oracleChecks=0,witness:ReturnType<AllocationProbe['liveObjects']['slice']>|null=null,error:string|null=null,
  deniedAt:string|null=null,deniedBeforeParse=false,injected=false,retained:Lease|undefined;
 const factLeases:Lease[]=[];
 const step=<T>(kind:Frame['kind'],fn:()=>T,keep=false):T=>{const frame:Frame={kind,leases:[]};frames.push(frame);
  try{return fn();}finally{need(frames.pop()===frame,'window_stack');for(const l of frame.leases){
   if(kind==='encode'&&l.fact&&l.value)factLeases.push(l);
   else if(keep&&l.site==='schema-result'&&l.value){const parent=frames.at(-1);need(parent,'window_stack');parent.leases.push(l);}else diagnostic.release(l);}}};
 const allocate=(site:string,fn:()=>object)=>{const lease=diagnostic.acquire(site);frames.at(-1)?.leases.push(lease);
  try{const value=fn();diagnostic.bind(lease,value);return value;}catch(e){diagnostic.release(lease);throw e;}};
 const isCommand=(v:unknown)=>!!v&&typeof v==='object'&&Object.getOwnPropertyDescriptor(v,'schema')?.value==='osv-mcp.cgp.source-command.v3';
 try{
  scope=new CwcCReadScope({registry:input.approval.view,context:c,now:()=>now,deadline:4500,gate:()=>need(current,'permission_denied')});scope.clientSnapshot(input.metadata,input.entries);
  let ledger=ledgers.get(balance);if(!ledger){ledger=new CwcCWorkLedger(balance,2*CPR_PLAN_WORK_BOUND,()=>{});ledgers.set(balance,ledger);}
  grant=scope.grant('client-initial',scope.reservePlan('client-initial',ledger));const approval=scope.approval('client-initial');
  codec=new ClosedCwcBCodec({context:c,gate:()=>scope!.gate(),now:()=>now,deadline:4500,budget:{bytes:1048576,fragments:4096,work:156978},connected:grant});
  owner=new CwcAContract({context:c,...{approval:approval.approval,approvalPin:approval.pin},actor:'client-initial',now:()=>now,
   current:()=>{scope!.gate();return {context:c,approvalPin:approval.pin};},parentReservation:{bytes:1048576,fragments:4096,work:156978},connected:grant,codec});
  const aScope=owner.openScope(grant.identity,{bytes:1048576,fragments:4096,work:156978}),root=owner.openCodecRoot(aScope,core),layout=owner.compilePlanLayout(root);
  const encode=owner.encodeCheckedCommand.bind(owner),prove=owner.provePlannedOwnerAndAuth.bind(owner),planProof=codec.planProof.bind(codec),inspect=codec.inspectProof.bind(codec);
  spies.push(vi.spyOn(owner,'encodeCheckedCommand').mockImplementation((...args)=>step('encode',()=>encode(...args))));
  spies.push(vi.spyOn(codec,'planProof').mockImplementation((...args)=>step('proof',()=>planProof(...args))));
  spies.push(vi.spyOn(codec,'inspectProof').mockImplementation((...args)=>step('inspect',()=>inspect(...args))));
  spies.push(vi.spyOn(schema,'command').mockImplementation(v=>{
   if(!active)return realCommand(v);const parent=frames.at(-1),copied=parent?.leases.find(l=>l.site==='data-copy'&&l.value===v);
   try{return step('command',()=>{const out=realCommand(v);if(parent?.kind==='encode')frames.at(-1)!.leases.find(l=>l.value===out)!.fact=true;return out;},true);}
   finally{if(copied)diagnostic.release(copied);} // The copy(input) temporary ends with command(copy(input)).
  }));
  spies.push(vi.spyOn(schema,'checkCommand').mockImplementation((...args)=>!active?realCheck(...args):step('check',()=>realCheck(...args))));
  spies.push(vi.spyOn(schema,'makeCommand').mockImplementation((...args)=>!active?realMake(...args):step('expected',()=>{
   // Before entering the unchanged makeCommand body, reserve the raw expected construction.
   const l=diagnostic.acquire('expected-build');frames.at(-1)!.leases.push(l);diagnostic.builds++;
   return realMake(...args);
  },true)));
  spies.push(vi.spyOn(globalThis,'structuredClone').mockImplementation((v:any,...rest:any[])=>{
   if(!active||!isCommand(v))return (realClone as any)(v,...rest);
   return allocate('data-copy',()=>{diagnostic.copies++;return (realClone as any)(v,...rest);}) as any;
  }));
  spies.push(vi.spyOn(schema.cprCommandSchema,'parse').mockImplementation((v:any,...rest:any[])=>{
   if(!active)return (realParse as any).call(schema.cprCommandSchema,v,...rest);
   const frame=frames.at(-1)!;
   if(frame.kind==='expected'){const l=frame.leases.find(x=>x.site==='expected-build')!;diagnostic.bind(l,v);}
   const calls=diagnostic.parseCalls;
   try{return allocate('schema-result',()=>{
    diagnostic.parseCalls++;const out=(realParse as any).call(schema.cprCommandSchema,v,...rest);
    return out;
   });}catch(e){if(diagnostic.denied){deniedAt=frame.kind;deniedBeforeParse=diagnostic.parseCalls===calls;diagnostic.deniedParseCalls=diagnostic.parseCalls-calls;}throw e;}
  }));
  for(let ordinal=0;ordinal<core.groups.length;ordinal++){
   // Oracle generation is outside the observed interval. It never lends command objects to A/B.
   const text=canonical(realMake(c,core.seed,core.transferId,ordinal,core.groups.length,hash(core),core.groups[ordinal]!));
   commandWidths.push(Buffer.byteLength(text));
   diagnostic.ordinal=ordinal;active=true;
   let decoded:schema.CprCommand|undefined;
   try{diagnostic.run(()=>{
    retained=diagnostic.acquire('caller-decode');diagnostic.decodes++;decoded=JSON.parse(text);diagnostic.bind(retained,decoded!);
    // The caller really holds decoded through proof and oracle comparison below.
    if(fault==='parse-failure'&&!injected){injected=true;decoded!.payload.byteBudget=0;}
    const beforeParse=diagnostic.parseCalls;
    // Capture all four actual identities immediately after the real parser returns.
    const old=diagnostic.bind.bind(diagnostic);
    diagnostic.bind=(l,value)=>{old(l,value);if(diagnostic.liveObjects.length===4&&!witness)witness=diagnostic.liveObjects;
     if(l.site==='schema-result'&&!injected){injected=true;
      if(fault==='reentry'){try{diagnostic.run(()=>owner!.encodeCheckedCommand(root,layout,decoded!));}catch{} }
      if(fault==='deadline')now=4500;if(fault==='revocation')current=false;
     }};
    try{const fact=owner!.encodeCheckedCommand(root,layout,decoded!);
     let receipt:ReturnType<CwcAContract['provePlannedOwnerAndAuth']>;
     try{receipt=prove(root,layout,fact);}finally{for(const l of factLeases.splice(0))diagnostic.release(l);}
     const widths=owner!.connectedWidths(root,receipt,grant!);
     active=false;const oracle=exact(c,decoded!,newStats());oracleChecks++;need(widths.request===oracle.request&&widths.reply===oracle.reply&&widths.frames.every((n,i)=>n===oracle.frames[i]),'window_oracle');active=true;
     need(diagnostic.parseCalls>beforeParse,'window_observer_missing');completed++;
    }finally{diagnostic.bind=old;}
   });}finally{active=false;if(retained)diagnostic.release(retained);retained=undefined;decoded=undefined;}
  }
  grant.finish(owner,root);
 }catch(e){error=e instanceof Error?e.message:String(e);}
 finally{active=false;for(const spy of spies.reverse())spy.mockRestore();owner?.close();codec?.close();scope?.close();diagnostic.cleanup();}
 return {mode:options.mode,capacity:options.capacity,error,completed,oracleChecks,groups:core.groups.length,
  entries:input.entries.length,sourceBytes:input.entries.reduce((n,e)=>n+e.byteLength,0),fourRangeGroups:core.groups.filter(g=>g.length===4).length,
  peakObserved:diagnostic.peak,witness:witness as {id:number;object:number;site:string}[]|null,deniedAt,deniedBeforeParse,deniedParseCalls:diagnostic.deniedParseCalls,
  counts:{parses:diagnostic.parseCalls,copies:diagnostic.copies,decodes:diagnostic.decodes,builds:diagnostic.builds},
  planSpent:balance.work,grant:grant?.diagnostics??null,diagnosticBudget:diagnostic.final,commandWidths,trace:diagnostic.events,
  scope:WINDOW_SCOPE,scopeId:scope?.id??null};
}
export function runWindowMatrix(){
 const rows=[];
 for(const role of ['reader','authority-broker'] as const)for(const boundary of ['normal','registered-maximum','schema-upper']){
  const input=windowInput(role,boundary);
  for(const mode of ['full-input','owned-input'] as const)for(const capacity of [3,8] as const){
   const balance={work:0},attempts=[windowAttempt(input,{capacity,mode,balance}),windowAttempt(input,{capacity,mode,balance})];
   rows.push({role,boundary,mode,capacity,attempts});
  }
 }
 return {schema:'cwc-lg.window-evidence.v1',rows};
}
