/** Call-through synchronous attribution. Inclusive spans are observations, not additive costs. */
import {vi} from 'vitest';
import {performance as nativePerformance} from 'node:perf_hooks';
const now=nativePerformance.now.bind(nativePerformance);
import {createHash} from 'node:crypto';
import * as json from '../../utils/gradleOwnedJson.js';
import * as session from './gradleOwnedCprBSession.js';
import * as protocol from './gradleOwnedCprBProtocol.js';
import * as signer from './gradleOwnedCprBSigner.js';
import * as planner from './gradleOwnedCwcCPlanner.js';
import {CwcLb0Session,CwcLb1Binding} from './gradleOwnedCwcLb0.js';
import {Vf3Link} from './gradleOwnedCwcVf3Link.js';
import {Vf1Owner} from './gradleOwnedCwcVf1Contract.js';
import {CwcAContract} from './gradleOwnedCwcA.js';
import {ClosedCwcBCodec} from './gradleOwnedCwcB.js';
import {CwcCReadScope,CwcConnectedGrant,CwcCApprovalRegistry,CwcCWorkLedger} from './gradleOwnedCwcC.js';
import {VF3_OPERATIONS,type Vf3Observer,type Vf3Observation,type Vf3Trace} from './gradleOwnedCwcVf3Profile.js';
import {profileGroup} from './gradleOwnedCwcVf3pValidation.mjs';
type Bucket={calls:number;inclusiveMs:number;exclusiveMs:number;childMs:number;beforeMs:number;afterMs:number;inclusiveBeforeMs:number;inclusiveAfterMs:number};
export type CostTrace={schema:string;mode:string;start:number;end:number;wallMs:number;otherMs:number;deadline:number;wallBeforeMs:number;wallAfterMs:number;otherBeforeMs:number;otherAfterMs:number;inspectionWitness:{id:number;exports:number}[];planWitness:{id:number;actor:string;start:number;end:number;returned:boolean}[];sources:Record<string,string>;entries:Record<string,number>;contextEntries:Record<string,number>;operations:Record<string,Bucket>;contexts:Record<string,{actor:string;owner:string;operation:string;calls:number;inclusiveMs:number;exclusiveMs:number;childMs:number;beforeMs:number;afterMs:number;inclusiveBeforeMs:number;inclusiveAfterMs:number}>;handshakes:Vf3Trace['handshakes']};
type Spec={target:any;key:string;label:string;exported?:boolean;actor?:boolean};
function specs():Spec[]{
 const out:Spec[]=[];const methods=(target:any,keys:string[],prefix:string)=>keys.forEach(key=>out.push({target,key,label:prefix+key}));
 methods(CwcLb0Session.prototype,['prepareChallenge','receive','connected','dispatchConnected'],'control.');
 methods(CwcLb1Binding.prototype,['providerGate','scopeGate'],'binding.');
 for(const [key,label]of [['request','link.request'],['dispatch','link.dispatch.entry'],['reply','link.reply.entry']])out.push({target:Vf3Link.prototype,key:key!,label:label!});
 methods(Vf1Owner.prototype,['current','check','assertStamp'],'owner.');
 methods(CwcCReadScope.prototype,['load'],'scope.');methods(CwcCReadScope.prototype,['gate','pre','parts','scalarPart'],'scope.');
 methods(CwcConnectedGrant.prototype,['gate','assert','assertApproval'],'grant.');methods(CwcCApprovalRegistry.prototype,['assertCurrent'],'registry.');methods(CwcCWorkLedger.prototype,['check'],'ledger.');
 for(const [key,label]of [['openCodecRoot','root.open'],['encodeCheckedCommand','fact.encode'],['provePlannedOwnerAndAuth','fact.prove']])out.push({target:CwcAContract.prototype,key:key!,label:label!});
 methods(CwcAContract.prototype,['compilePlanLayout','connectedWidths','readClientCommandFact','registerInitialPlan','verifyClientSeal','retainClientCommandFact'],'codecA.');
 methods(ClosedCwcBCodec.prototype,['planProof','inspectProof'],'codecB.');
 methods(session.SessionServer.prototype,['openPeer'],'endpoint.');methods(Object.getPrototypeOf(session.SessionServer.prototype),['gate','now','permitAPI'],'endpoint.');
 for(const [target,keys,prefix]of [[session,['inspectAuthenticatedCall'],'session.'],[protocol,['validateChallengeExchange','validateChannelFrame','validateSessionTranscript'],'protocol.'],[signer,['verifyOwnerValue'],'signer.'],[json,['canonicalOwnedJson','ownedDigest','ownedSha256'],'json.']] as const)for(const key of keys)out.push({target,key,label:prefix+key,exported:true});
 out.push({target:planner,key:'pack',label:'plan',exported:true,actor:true});return out;
}
export function vf3pObserverSources(){const s:Record<string,string>={};for(const spec of specs()){const fn=spec.target[spec.key];if(typeof fn!=='function')throw Error('vf3p_method_'+spec.label);s[spec.label]=createHash('sha256').update(Function.prototype.toString.call(fn)).digest('hex');}s['json.structuredClone']=createHash('sha256').update(Function.prototype.toString.call(globalThis.structuredClone)).digest('hex');return s;}
let installed=false;
export function installVf3pObserver(mode:Exclude<Vf3Observation,'quiet'>,deadline:number){
 if(installed)throw Error('vf3p_observer_busy');const sources=vf3pObserverSources();installed=true;const timed=mode==='timed',restores:(()=>void)[]=[],entries:CostTrace['entries']={},contextEntries:Record<string,number>={},operations:CostTrace['operations']={},contexts:CostTrace['contexts']={},handshakes:Vf3Trace['handshakes']=[];
 let active=false,closed=false,contextCount=0;const stack:{name:string;actor:string;childOwner:string;child:number;childBefore:number}[]=[],start=now();
 const planWitness:CostTrace['planWitness']=[];const inspectionWitness:{id:number;exports:number}[]=[],handles=new WeakMap<object,{id:number;exports:number}>();
 function sync<T>(name:string,run:()=>T):T{
  if(!active)return run();if(stack.length>=128)throw Error('vf3p_stack_capacity');
  const parent=stack.at(-1),actor=name.startsWith('plan.')?name.slice(5):parent?.actor??'outside',owner=parent?.childOwner??'outside',group=profileGroup(name),key=[actor,owner,name].join('|');
  if(!Object.hasOwn(contextEntries,key)&&++contextCount>1024)throw Error('vf3p_context_capacity');entries[name]=(entries[name]??0)+1;contextEntries[key]=(contextEntries[key]??0)+1;const frame={name,actor,childOwner:['canonical-hash','copy'].includes(group)?owner:group,child:0,childBefore:0},at=timed?now():0;stack.push(frame);const plan=name.startsWith('plan.')?{id:planWitness.length+1,actor,start:at,end:0,returned:false}:undefined;if(plan){if(planWitness.length>=130)throw Error('vf3p_plan_capacity');planWitness.push(plan);}
  try{const result=run();if(plan)plan.returned=true;return result;}finally{const end=timed?now():0,elapsed=timed?end-at:0,before=timed?Math.max(0,Math.min(end,deadline)-at):0;stack.pop();if(plan)plan.end=end;const exclusive=Math.max(0,elapsed-frame.child),pre=Math.max(0,before-frame.childBefore),post=Math.max(0,exclusive-pre),b=operations[name]??={calls:0,inclusiveMs:0,exclusiveMs:0,childMs:0,beforeMs:0,afterMs:0,inclusiveBeforeMs:0,inclusiveAfterMs:0},c=contexts[key]??={actor,owner,operation:name,calls:0,inclusiveMs:0,exclusiveMs:0,childMs:0,beforeMs:0,afterMs:0,inclusiveBeforeMs:0,inclusiveAfterMs:0};for(const r of [b,c]){r.calls++;r.inclusiveMs+=elapsed;r.exclusiveMs+=exclusive;r.childMs+=frame.child;r.beforeMs+=pre;r.afterMs+=post;r.inclusiveBeforeMs+=before;r.inclusiveAfterMs+=elapsed-before;}if(stack.length){stack.at(-1)!.child+=elapsed;stack.at(-1)!.childBefore+=before;}}
 }
 try{
  for(const spec of specs()){
   const {target,key,label}=spec,original=target[key],witness=(args:any[])=>{if(label==='link.dispatch.entry'){if(inspectionWitness.length>=128)throw Error('vf3p_dispatch_capacity');const row={id:inspectionWitness.length+1,exports:0};handles.set(args[1],row);inspectionWitness.push(row);}if(label==='session.inspectAuthenticatedCall'){const row=handles.get(args[0]);if(!row)throw Error('vf3p_unassociated_inspection');row.exports++;}},name=(args:any[])=>spec.actor?'plan.'+args[6].actor:label;
   if(spec.exported){const spy=vi.spyOn(target,key);spy.mockImplementation((...args:any[])=>{try{witness(args);return sync(name(args),()=>Reflect.apply(original,target,args));}finally{spy.mockClear();}});restores.push(()=>spy.mockRestore());}
   else{const descriptor=Object.getOwnPropertyDescriptor(target,key)!;Object.defineProperty(target,key,{...descriptor,value:function(this:unknown,...args:any[]){witness(args);return sync(name(args),()=>Reflect.apply(original,this,args));}});restores.push(()=>Object.defineProperty(target,key,descriptor));}
  }
  const d=Object.getOwnPropertyDescriptor(globalThis,'structuredClone')!,clone=globalThis.structuredClone;Object.defineProperty(globalThis,'structuredClone',{...d,value:(...args:Parameters<typeof structuredClone>)=>sync('json.structuredClone',()=>clone(...args))});restores.push(()=>Object.defineProperty(globalThis,'structuredClone',d));
 }catch(e){for(const restore of restores.reverse())restore();installed=false;throw e;}active=true;
 async function around<T>(kind:'handshake.open'|'handshake.exchange',run:()=>Promise<T>){if(handshakes.length>=768)throw Error('vf3p_handshake_capacity');const h={id:handshakes.length+1,kind,start:timed?now():0,end:0};handshakes.push(h);try{return await run();}finally{h.end=timed?now():0;}}
 function close(){if(closed)return;active=false;closed=true;for(const restore of restores.reverse())restore();installed=false;}
 const port:Vf3Observer={sync,around,finish(){throw Error('vf3p_port_finish');},close};
 return {port,sync,close,finish(){if(!active||stack.length)throw Error('vf3p_observer_state');active=false;const end=now(),wallMs=end-start,wallBeforeMs=Math.max(0,Math.min(end,deadline)-start),wallAfterMs=wallMs-wallBeforeMs;
  const selected=Object.fromEntries(Object.entries(operations).filter(([k])=>(VF3_OPERATIONS as readonly string[]).includes(k)).map(([k,b])=>[k,{calls:b.calls,inclusiveMs:b.inclusiveMs,exclusiveMs:b.exclusiveMs}]));
  const base:Vf3Trace={mode,start,end,wallMs,otherMs:wallMs-Object.values(selected).reduce((s,b)=>s+b.exclusiveMs,0),entries:Object.fromEntries(Object.entries(entries).filter(([k])=>(VF3_OPERATIONS as readonly string[]).includes(k))),buckets:selected,handshakes};
  const cost:CostTrace={schema:'cwc-vf3p.cost.v1',mode,start,end,wallMs,otherMs:wallMs-Object.values(operations).reduce((s,b)=>s+b.exclusiveMs,0),sources,entries,contextEntries,operations,contexts,handshakes,deadline,wallBeforeMs,wallAfterMs,otherBeforeMs:wallBeforeMs-Object.values(operations).reduce((s,b)=>s+b.beforeMs,0),otherAfterMs:wallAfterMs-Object.values(operations).reduce((s,b)=>s+b.afterMs,0),inspectionWitness,planWitness};return {base,cost};
 }};
}
