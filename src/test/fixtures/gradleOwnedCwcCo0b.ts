/** CCO-0b diagnostic. Spies observe unchanged sources; observer references/exports are
 * separate overhead. These are source-supported lower bounds, never a heap upper bound.
 * Run synchronously and without concurrent tests; all spies are restored in finally.
 */
import {vi} from 'vitest';
import * as schema from './gradleOwnedCprASchema.js';
import * as json from '../../utils/gradleOwnedJson.js';
import {co0Fixture} from './gradleOwnedCwcCo0Fixture.js';
import {Co0bPrimitives} from './gradleOwnedCwcCo0bPrimitives.js';
import {co0bSourceAudit} from './gradleOwnedCwcCo0bAudit.mjs';
import type {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
export const CO0B_SCOPE=Object.freeze({diagnosticOnly:true,unchangedCo0Source:true,realCprPrimitives:true,fixedClock:true,sameProcess:true,
 observerExtendsSomeLifetimes:true,
 actualAB:false,actualSession:false,lgModesConnected:false,fullHeapUpperBound:false,threeSlotEstablished:false,
 metadataBridgeWithin4096:false,completeWorkCoverage:false,budgetCoexistence:false,co0Exit:false,productionAdopted:false});
type Phase='setup'|'capture'|'normalize'|'expected'|'compare'|'cleanup';
type Frame={kind:'make'|'check';raw?:object;parsed?:object;q?:object};
type Denied={phase:string;ordinal:number;beforeHashUpdate:boolean;allocationAlreadyOccurred:boolean};
type Options={role?:'reader'|'authority-broker';boundary?:string;kind?:'provider'|'client';ordinals?:number;rootLimit?:3|8;guardPhase?:'normalize'|'expected';observe?:boolean;
 budget?:Lb0Budget;stop?:'deadline'|'revocation'|'reentry';fault?:'row-after-normalize'|'capture-failure'};
type Witness={phase:Phase;actor:number;ordinal:number;distinctRoots:number;ids:number[];labels:string[];canonicalBytes:number[];shallowAlias:boolean;
 sourceSupportedRoots:number;observerExtendedRaw:boolean;lifetimePolicy:string};
let running=false;
export function traceCo0b(o:Options={}){
 if(running)throw Error('co0b_reentry');
 if(!Number.isSafeInteger(o.ordinals??19)||(o.ordinals??19)<1||(o.ordinals??19)>19)throw Error('co0b_configuration');
 const f=co0Fixture({...o,hook:(site,owner)=>{if(site==='expected-before'){
   phase='expected';if(o.stop==='deadline')f.clock.advance(4500);if(o.stop==='revocation')f.approval.view.revoke();if(o.stop==='reentry'){try{owner.claim();}catch{}}
  }if(site==='compare-after')phase='compare';}}),spies:{mockRestore:()=>void}[]=[],frames:Frame[]=[],witnesses:Witness[]=[];
 const parse=schema.cprCommandSchema.parse,make=schema.makeCommand,check=schema.checkCommand,cmd=schema.command,hash=json.ownedDigest,canon=json.canonicalOwnedJson;
 let phase:Phase='setup',ordinal=0,actor=0,input:object|undefined,prepared:object|undefined,error:string|null=null,next=0;
 running=true;let denied:Denied|null=null;
 const primitive=new Co0bPrimitives(()=>({phase,actor,ordinal}),o.observe!==false),parses:{seq:number;phase:string;actor:number;ordinal:number;input:number;output:number;inputBytes:number;outputBytes:number}[]=[];
 const ids=new WeakMap<object,number>(),id=(v:object)=>{if(!ids.has(v))ids.set(v,++next);return ids.get(v)!;};
 const onHash=(v:any)=>{if(v?.domain!=='cpr.wire-intent.v3')return;
  const top=frames.at(-1),roots:[string,object|undefined][]=[];
  if(phase==='expected')roots.push(['prepared',prepared],['raw-expected',top?.raw],['parsed-expected',top?.parsed]);
  else if(phase==='normalize'&&top?.kind==='check')roots.push(['decode-input',input],['prepared',prepared],['check-result',top.parsed]);
  else return;
  roots.push(['wire-preimage',v.command]);if(roots.some(([,v])=>!v))return;
  const values=roots.map(([,v])=>v!);witnesses.push({phase,actor,ordinal,distinctRoots:new Set(values).size,ids:values.map(id),labels:roots.map(([k])=>k),
   canonicalBytes:values.map(v=>Buffer.byteLength(canon(v))),shallowAlias:(values[2] as any).payload===(values[3] as any).payload,
   sourceSupportedRoots:phase==='normalize'?4:3,observerExtendedRaw:phase==='expected',lifetimePolicy:phase==='normalize'?'source-holder-and-future-use':'conservative-active-frame'});
  if(o.rootLimit===3&&phase===(o.guardPhase??'normalize')){denied={phase,ordinal,beforeHashUpdate:true,allocationAlreadyOccurred:true};throw Error('co0b_root_limit');}
 };
 try{
  if(o.observe!==false){
  spies.push(vi.spyOn(schema,'makeCommand').mockImplementation((...a)=>{const frame:Frame={kind:'make'};frames.push(frame);try{return make(...a);}finally{frames.pop();}}));
  spies.push(vi.spyOn(schema,'checkCommand').mockImplementation((...a)=>{const frame:Frame={kind:'check',q:a[1]};frames.push(frame);try{return check(...a);}finally{frames.pop();}}));
  spies.push(vi.spyOn(schema,'command').mockImplementation((v)=>{if(phase==='normalize')input=v as object;const q=cmd(v);if(phase==='normalize')prepared=q;return q;}));
  spies.push(vi.spyOn(schema.cprCommandSchema,'parse').mockImplementation((...a:Parameters<typeof parse>)=>{const frame=frames.at(-1);if(frame?.kind==='make')frame.raw=a[0] as object;const q=Reflect.apply(parse,schema.cprCommandSchema,a);if(frame)frame.parsed=q;
   primitive.ignore(()=>parses.push({seq:parses.length,phase,actor,ordinal,input:id(a[0] as object),output:id(q),inputBytes:Buffer.byteLength(canon(a[0])),outputBytes:Buffer.byteLength(canon(q))}));return q;}));
  spies.push(vi.spyOn(json,'ownedDigest').mockImplementation((v,max)=>{primitive.ignore(()=>onHash(v));return primitive.run('hash',v,()=>hash(v,max));}));
  spies.push(vi.spyOn(json,'canonicalOwnedJson').mockImplementation((v,max)=>{if(phase==='expected'&&v===prepared)phase='compare';return primitive.run('canonical',v,()=>canon(v,max));}));
  }
  const claims=f.owner.claim(),actors=o.kind==='client'?['client-initial','client-seal'] as const:['provider'] as const;
  for(const [i,a]of actors.entries()){
   actor=i;phase='setup';ordinal=0;input=undefined;prepared=undefined;const w=f.owner.open(claims[i]!,f.owner.identity(a),f.core);
   phase='capture';for(ordinal=0;ordinal<19;ordinal++)f.owner.capture(w);
   // The fixed original hook marks the externally visible phase boundaries without changing inputs.
   for(ordinal=0;ordinal<(o.ordinals??19);ordinal++){
    phase='normalize';f.owner.process(w);input=undefined;prepared=undefined;
   }
  }
  if(o.kind==='client')f.owner.compareFamilies();
 }catch(e){error=e instanceof Error?e.message:String(e);}
 finally{for(const s of spies.reverse())s.mockRestore();primitive.close();phase='cleanup';f.owner.close();running=false;}
 const {trace,...stats}=f.owner.stats(),work=primitive.summary(),scratch=primitive.rows.filter(r=>r.scratch).map(r=>({seq:r.seq,...r.scratch!}));
 return {role:o.role??'reader',boundary:o.boundary??'normal',kind:o.kind??'provider',context:f.context,error,compared:stats.comparedRows,denied:denied as Denied|null,witnesses,parses,work,scratch,primitives:primitive.rows,
  finalBudget:stats.budget,protocol:{...stats,traceLength:trace.length,traceDigest:hash(trace)},scope:CO0B_SCOPE};
}
export function runCo0bMatrix(){
 const rows=[];
 for(const role of ['reader','authority-broker'] as const)for(const boundary of ['normal','registered-maximum','schema-upper'])for(const kind of ['provider','client'] as const){
  const options={role,boundary,kind},observed=traceCo0b(options),control=traceCo0b({...options,observe:false});
  const guards=(['normalize','expected'] as const).map(guardPhase=>{const {primitives,parses,scratch,...result}=traceCo0b({...options,rootLimit:3,guardPhase});
   return {guardPhase,result:{...result,primitiveTrace:{length:primitives.length,digest:json.ownedDigest(primitives,8388608)},parseTrace:{length:parses.length,digest:json.ownedDigest(parses)},scratchTrace:{length:scratch.length,digest:json.ownedDigest(scratch)}}};});
  rows.push({observed,control:control.protocol,guards});
 }
 return {schema:'cwc-co0b.evidence.v1',audit:co0bSourceAudit(),rows};
}
