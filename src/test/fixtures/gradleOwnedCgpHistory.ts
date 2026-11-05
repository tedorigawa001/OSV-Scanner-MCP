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
 const line=stack.split('\n').find(s=>/gradleOwned(?:AnchorOwner|RegistryOwner|SourceOwner|AuthorityOwner)\.js:\d+:\d+/.test(s));
 if(!line)return 'unattributed';
 // Keep the direct caller and compiled file position, without temporary-root paths.
 return line.trim().replace(/(?:file:\/\/)?[^ ()]*\/(gradleOwned[^/ ()]+\.js:\d+:\d+)/,'$1');
}
export function validateHistoryReads(sample:any){
 const groups=new Map<string,{role:string;api:string;action:string;callsite:string;selector:string;phase:string;count:number;inclusiveWallMs:number}>();
 const fail=(ok:unknown)=>{if(!ok)throw Error('cgp_history_evidence_invalid');};
 for(const owner of sample.owners){const probe=owner.historyReads;fail(probe&&probe.schema==='cgp.history-events.v1'&&Number.isSafeInteger(probe.eventCount)&&probe.eventCount>=0&&probe.active===0&&probe.dropped===0&&Array.isArray(probe.reads));
  fail(probe.eventCount===probe.reads.length);
  const byRpc=new Map<number,number[]>();let expectedId=0;
  fail(probe.reads.length===(owner.categories['stage.readCommitted']?.count??0));
  for(const row of probe.reads as HistoryRead[]){fail(row.eventId===++expectedId);const ids=byRpc.get(row.rpcId)??[];ids.push(row.eventId);byRpc.set(row.rpcId,ids);fail(Number.isSafeInteger(row.rpcId)&&row.rpcId>0&&Number.isFinite(row.startMs)&&row.startMs>=0&&Number.isFinite(row.wallMs)&&row.wallMs>=0&&['returned','threw'].includes(row.outcome)&&['history','receipt'].includes(row.selector)&&row.method==='readCommitted'&&typeof row.callsite==='string'&&row.callsite!=='unattributed');
   const spans=sample.rawSpans.filter((p:any)=>p.role===owner.role&&p.boot===owner.boot&&p.rpcId===row.rpcId&&p.api===row.api&&p.action===row.action);fail(spans.length===1);const span=spans[0];fail(row.startMs>=span.startMs&&row.startMs+row.wallMs<=span.startMs+span.wallMs+0.01);
   const phase=sample.readerEvents.find((e:any)=>row.startMs>=e.startMs&&row.startMs<e.startMs+e.wallMs)?.phase??'outside-reader-call';
   const key=JSON.stringify([owner.role,row.api,row.action,row.callsite,row.selector,phase]),g=groups.get(key)??{role:owner.role,api:row.api,action:row.action,callsite:row.callsite,selector:row.selector,phase,count:0,inclusiveWallMs:0};g.count++;g.inclusiveWallMs+=row.wallMs;groups.set(key,g);
  }
  // The RPC's separately recorded invocation list must cover exactly its read events.
  const seenRpc=new Set<number>();
  for(const span of sample.rawSpans.filter((p:any)=>p.role===owner.role&&p.boot===owner.boot)){
   fail(Number.isSafeInteger(span.rpcId)&&!seenRpc.has(span.rpcId));seenRpc.add(span.rpcId);
   fail(Array.isArray(span.historyEventIds)&&JSON.stringify(span.historyEventIds)===JSON.stringify(byRpc.get(span.rpcId)??[]));
  }
 }
 return [...groups.values()];
}
