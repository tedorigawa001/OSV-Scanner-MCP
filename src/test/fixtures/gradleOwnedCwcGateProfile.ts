/** Test-only synchronous call-through attribution; no stack capture or verification reuse. */
import {vi} from 'vitest';
import * as json from '../../utils/gradleOwnedJson.js';
import * as session from './gradleOwnedCprBSession.js';
import {CwcConnectedGrant,CwcCReadScope,CwcCApprovalRegistry,CwcCWorkLedger} from './gradleOwnedCwcC.js';

export const GATE_OPERATIONS = [
 'scope.gate','grant.assert','grant.assertApproval','grant.gate','ledger.check','registry.assertCurrent',
 'session.inspectAuthenticatedCall','endpoint.gate','endpoint.now','endpoint.permitAPI',
 ...['gate','outside'].flatMap(domain=>['canonicalOwnedJson','ownedDigest','ownedSha256','structuredClone'].map(name=>domain+'.'+name)),
] as const;
// These closed-profile SHA exports take strings/Buffers, invoke no callbacks, and have no observed children.
export const GATE_NON_REENTRANT=['gate.ownedSha256','outside.ownedSha256'] as const;
type Bucket={calls:number;inclusiveMs:number;exclusiveMs:number};
export type GateTrace={timed:boolean;wallMs:number;otherMs:number;entryCalls:Record<string,number>;operations:Record<string,Bucket>};
let installed=false;
export function installGateObserver(timed=true){
 if(installed)throw Error('cwc_gate_busy');installed=true;
 const restores:(()=>void)[]=[];
 let active=false,closed=false,stack:{name:string;child:number}[]=[],operations:GateTrace['operations']={},entryCalls:GateTrace['entryCalls']={};
 // Count at the wrapper entry, separately from observe()'s finally accounting.
 function invoke<T>(name:string,run:()=>T):T{
  if(active)entryCalls[name]=(entryCalls[name]??0)+1;
  return observe(name,run);
 }
 function observe<T>(name:string,run:()=>T):T{
  if(!active)return run();
  const frame={name,child:0},start=timed?performance.now():0;
  stack.push(frame);
  try{return run();}finally{
   const elapsed=timed?performance.now()-start:0;
   stack.pop();const b=operations[name]??={calls:0,inclusiveMs:0,exclusiveMs:0};
   b.calls++;b.inclusiveMs+=elapsed;b.exclusiveMs+=elapsed-frame.child;
   if(stack.length)stack.at(-1)!.child+=elapsed;
  }
 }
 const domain=()=>stack.some(f=>!f.name.startsWith('outside.')&&!f.name.startsWith('gate.'))?'gate':'outside';
 function method(target:any,key:string,label:string){
  const d=Object.getOwnPropertyDescriptor(target,key);
  if(typeof d?.value!=='function')throw Error('cwc_gate_method');
  Object.defineProperty(target,key,{...d,value:function(this:unknown,...args:unknown[]){return invoke(label,()=>Reflect.apply(d.value,this,args));}});
  restores.push(()=>Object.defineProperty(target,key,d));
 }
 function exported(module:any,name:string,label:()=>string){
  const original=module[name],spy=vi.spyOn(module,name);
  spy.mockImplementation((...args:any[])=>{try{return invoke(label(),()=>Reflect.apply(original,module,args));}finally{spy.mockClear();}});
  restores.push(()=>spy.mockRestore());
 }
 try{
  method(CwcCReadScope.prototype,'gate','scope.gate');
  for(const n of ['assert','assertApproval','gate'])method(CwcConnectedGrant.prototype,n,'grant.'+n);
  method(CwcCWorkLedger.prototype,'check','ledger.check');
  method(CwcCApprovalRegistry.prototype,'assertCurrent','registry.assertCurrent');
  const endpoint=Object.getPrototypeOf(session.SessionServer.prototype);
  for(const n of ['gate','now','permitAPI'])method(endpoint,n,'endpoint.'+n);
  exported(session,'inspectAuthenticatedCall',()=> 'session.inspectAuthenticatedCall');
  for(const n of ['canonicalOwnedJson','ownedDigest','ownedSha256'])exported(json,n,()=>domain()+'.'+n);
  const d=Object.getOwnPropertyDescriptor(globalThis,'structuredClone')!,original=globalThis.structuredClone;
  Object.defineProperty(globalThis,'structuredClone',{...d,value:(...args:Parameters<typeof structuredClone>)=>invoke(domain()+'.structuredClone',()=>original(...args))});
  restores.push(()=>Object.defineProperty(globalThis,'structuredClone',d));
 }catch(error){for(const restore of restores.reverse())restore();installed=false;throw error;}
 return {
  async measure<T>(run:()=>Promise<T>){
   if(active||closed)throw Error('cwc_gate_closed_or_busy');
   operations={};entryCalls={};stack=[];active=true;const start=performance.now();let result:T|undefined,error:unknown,ok=false;
   try{result=await run();ok=true;}catch(e){error=e;}finally{active=false;}
   const wallMs=performance.now()-start;
   return {ok,result,error,trace:{timed,wallMs,otherMs:wallMs-Object.values(operations).reduce((n,b)=>n+b.exclusiveMs,0),entryCalls,operations} satisfies GateTrace};
  },
  close(){if(active)throw Error('cwc_gate_busy');if(closed)return;closed=true;for(const restore of restores.reverse())restore();installed=false;},
 };
}
