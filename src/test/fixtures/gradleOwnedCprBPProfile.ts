import {AsyncLocalStorage} from 'node:async_hooks';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export type Bucket={calls:number;inclusiveMs:number;exclusiveMs:number};
export type PlanTrace={witness?:{call:number;requestDigest:string;batchOrdinal:number};id:number;variant:string;actor:string;wallMs:number;otherMs:number;failed:boolean;commands:number;planDigest:string|null;buckets:Record<string,Bucket>};
type Frame={start:number;child:number};
type Scope={trace:PlanTrace;stack:Frame[]};
const scopes=new AsyncLocalStorage<Scope>();let sink:PlanTrace[]|undefined;
/** Diagnostic only. Never enabled on primary transfers. */
export function collectPlans<T>(out:PlanTrace[],run:()=>Promise<T>){need(!sink,'profile_busy');sink=out;return run().finally(()=>{sink=undefined;});}
export function span<T>(category:string,run:()=>T):T{
 const s=scopes.getStore();if(!s)return run();
 const f={start:performance.now(),child:0};s.stack.push(f);
 try{return run();}finally{
  const elapsed=performance.now()-f.start;s.stack.pop();
  const b=s.trace.buckets[category]??={calls:0,inclusiveMs:0,exclusiveMs:0};b.calls++;b.inclusiveMs+=elapsed;b.exclusiveMs+=elapsed-f.child;
  if(s.stack.length)s.stack.at(-1)!.child+=elapsed;
 }
}
export function planRoot<T extends {commands:unknown[];planDigest:string}>(variant:string,actor:string,run:()=>T,witness?:PlanTrace['witness']):T{
 if(!sink)return run();const trace:PlanTrace={id:sink.length+1,variant,actor,wallMs:0,otherMs:0,failed:true,commands:0,planDigest:null,buckets:{},...(witness?{witness:{...witness}}:{})};
 sink.push(trace);const scope:Scope={trace,stack:[]},start=performance.now();
 try{return scopes.run(scope,()=>{const p=run();trace.failed=false;trace.commands=p.commands.length;trace.planDigest=p.planDigest;return p;});}
 finally{trace.wallMs=performance.now()-start;trace.otherMs=trace.wallMs-Object.values(trace.buckets).reduce((n,b)=>n+b.exclusiveMs,0);}
}
