/** Test-only call attribution. No receipt, byte cache, or production gate bypass. */
import {AsyncLocalStorage} from 'node:async_hooks';
export type HistoryContext={rpcId:number;api:string;action:string};
export type HistoryRead=HistoryContext&{eventId:number;method:string;callsite:string;selector:string;startMs:number;wallMs:number;outcome:'returned'|'threw'};
export class CgpHistoryProbe {
 readonly #context=new AsyncLocalStorage<HistoryContext&{eventIds:number[]}>();
 #reads:HistoryRead[]=[];#active=0;#dropped=0;#sequence=0;
 constructor(readonly limit=1024){if(!Number.isSafeInteger(limit)||limit<1)throw Error('cgp_probe_limit');}
 run<T>(context:HistoryContext,work:()=>T){return this.#context.run({...context,eventIds:[]},work);}
 async measure<T>(method:string,selector:string,callsite:string,work:()=>Promise<T>):Promise<T>{
  const context=this.#context.getStore()??{rpcId:0,api:'outside-rpc',action:'outside-rpc',eventIds:[]},startMs=Number(process.hrtime.bigint())/1e6;
  // Reserve at entry so concurrent calls cannot exceed the recording bound.
  const eventId=++this.#sequence;context.eventIds.push(eventId);
  const row:HistoryRead={rpcId:context.rpcId,api:context.api,action:context.action,eventId,method,selector,callsite,startMs,wallMs:0,outcome:'threw'};
  if(this.#reads.length<this.limit)this.#reads.push(row);else this.#dropped++;
  this.#active++;
  try{const value=await work();row.outcome='returned';return value;}
  finally{row.wallMs=Number(process.hrtime.bigint())/1e6-startMs;this.#active--;}
 }
 reset(){if(this.#active)throw Error('cgp_probe_busy');this.#reads=[];this.#dropped=0;this.#sequence=0;}
 currentEventIds(){return [...(this.#context.getStore()?.eventIds??[])];}
 snapshot(){return {schema:'cgp.history-events.v1',eventCount:this.#sequence,reads:structuredClone(this.#reads),active:this.#active,dropped:this.#dropped};}
}
export function historyCallsite(stack:string){
 const line=stack.split('\n').find(s=>/gradleOwned[A-Za-z0-9]+\.js:\d+:\d+/.test(s));
 if(!line)return 'unattributed';
 // Keep the direct caller and compiled file position, without temporary-root paths.
 return line.trim().replace(/(?:file:\/\/)?[^ ()]*\/(gradleOwned[^/ ()]+\.js:\d+:\d+)/,'$1');
}
