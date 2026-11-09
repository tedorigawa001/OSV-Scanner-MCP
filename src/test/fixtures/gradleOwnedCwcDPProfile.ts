/** Test-only call-through observer. No authority or cached verification facts. */
import {vi} from 'vitest';
import * as json from '../../utils/gradleOwnedJson.js';
import {CwcAContract} from './gradleOwnedCwcA.js';
import {CwcConnectedGrant,CwcCReadScope,CwcCApprovalRegistry} from './gradleOwnedCwcC.js';
import {ClosedCwcBCodec} from './gradleOwnedCwcB.js';
export const DP_CATEGORIES=['root-fact','copy','gate','canonical-hash','diagnostics','proof'] as const;
export type DpCategory=typeof DP_CATEGORIES[number];
export type DpBucket={calls:number;inclusiveMs:number;exclusiveMs:number};
export type DpTrace={wallMs:number;otherMs:number;operations:Record<string,{category:DpCategory}&DpBucket>};
let installed=false;
export function installDpObserver(){
 if(installed)throw Error('cwc_dp_busy');installed=true;
 const restores:(()=>void)[]=[];let active=false,stack:{child:number}[]=[],operations:DpTrace['operations']={};
 function observe<T>(label:string,category:DpCategory,run:()=>T):T{
  if(!active)return run();const frame={child:0},start=performance.now();stack.push(frame);
  try{return run();}finally{const elapsed=performance.now()-start;stack.pop();const b=operations[label]??={category,calls:0,inclusiveMs:0,exclusiveMs:0};b.calls++;b.inclusiveMs+=elapsed;b.exclusiveMs+=elapsed-frame.child;if(stack.length)stack.at(-1)!.child+=elapsed;}
 }
 function method(target:any,key:string,category:DpCategory,label:string,getter=false){const descriptor=Object.getOwnPropertyDescriptor(target,key);if(!descriptor)throw Error('cwc_dp_missing_operation');const original=getter?descriptor.get:descriptor.value;if(typeof original!=='function')throw Error('cwc_dp_missing_operation');Object.defineProperty(target,key,{...descriptor,[getter?'get':'value']:function(this:unknown,...args:unknown[]){return observe(label,category,()=>Reflect.apply(original,this,args));}});restores.push(()=>Object.defineProperty(target,key,descriptor));}
 try{
  for(const name of ['openScope','openCodecRoot','compilePlanLayout','encodeCheckedCommand','provePlannedOwnerAndAuth','connectedWidths','connectedSummary','registerInitialPlan','verifyClientSeal','retainClientCommandFact','readClientCommandFact','disposeCodecRoot'])method(CwcAContract.prototype,name,'root-fact','A.'+name);
  for(const name of ['assert','assertApproval','gate'])method(CwcConnectedGrant.prototype,name,'gate','grant.'+name);
  method(CwcCReadScope.prototype,'gate','gate','scope.gate');method(CwcCApprovalRegistry.prototype,'assertCurrent','gate','approval.assertCurrent');
  for(const name of ['planProof','inspectProof'])method(ClosedCwcBCodec.prototype,name,'proof','B.'+name);
  method(CwcAContract.prototype,'metrics','diagnostics','A.metrics',true);method(CwcConnectedGrant.prototype,'diagnostics','diagnostics','grant.diagnostics',true);method(ClosedCwcBCodec.prototype,'diagnostics','diagnostics','B.diagnostics',true);
  method(globalThis,'structuredClone','copy','structuredClone');method(Buffer,'alloc','copy','Buffer.alloc');method(Buffer.prototype,'copy','copy','Buffer.copy');method(Buffer.prototype,'write','copy','Buffer.write');
  // Digest's lexical canonical/SHA calls are included in its duration, not counted as extra exported calls.
  for(const name of ['canonicalOwnedJson','ownedDigest','ownedSha256'] as const){const original=json[name] as (...a:any[])=>any;const spy=vi.spyOn(json,name as any);spy.mockImplementation(((...args:any[])=>{try{return observe('json.'+name,'canonical-hash',()=>original(...args));}finally{spy.mockClear();}}) as any);restores.push(()=>spy.mockRestore());}
 }catch(e){for(const restore of restores.reverse())restore();installed=false;throw e;}
 return {
  async measure<T>(run:()=>Promise<T>){if(active)throw Error('cwc_dp_busy');operations={};stack=[];active=true;const start=performance.now();let result:T|undefined,error:unknown,ok=false;try{result=await run();ok=true;}catch(e){error=e;}finally{active=false;}
   const wallMs=performance.now()-start,exclusive=Object.values(operations).reduce((n,b)=>n+b.exclusiveMs,0);return {ok,result,error,trace:{wallMs,otherMs:wallMs-exclusive,operations} satisfies DpTrace};},
  close(){if(active)throw Error('cwc_dp_busy');for(const restore of restores.reverse())restore();installed=false;}
 };
}
