import {AsyncLocalStorage} from 'node:async_hooks';import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export type PlannerStrategy='binary'|'max-first';
export type PlanMeasure={wallMs:number;otherMs:number;status:'running'|'complete'|'failed';costs:Record<string,{ms:number;count:number}>;probes:{ordinal:number;kind:'max'|'binary'|'final';length:number;commandDigest:string;fit:boolean;wireBytes:number}[];outputDigest?:string};
export type PlannerMeasure={strategy:PlannerStrategy;wireCap:number;wallMs:number;stages:Record<string,{ms:number;count:number}>;plans:PlanMeasure[]};
type Context={strategy:PlannerStrategy;wireCap:number;gate:()=>void;hook?:(phase:string)=>void;measure:PlannerMeasure;active?:PlanMeasure};const scope=new AsyncLocalStorage<Context>();
export function profilePlanner<T>(strategy:PlannerStrategy,gate:()=>void,run:()=>T,options:{wireCap?:number;hook?:(phase:string)=>void}={}){need(['binary','max-first'].includes(strategy)&&Number.isSafeInteger(options.wireCap??8192)&&(options.wireCap??8192)>0&&(options.wireCap??8192)<=8192,'configuration_invalid');const measure:PlannerMeasure={strategy,wireCap:options.wireCap??8192,wallMs:0,stages:{},plans:[]},started=performance.now();return scope.run({strategy,wireCap:measure.wireCap,gate,hook:options.hook,measure},()=>{try{plannerGate('operation-before');const value=run();plannerGate('operation-after');return {value,measure};}finally{measure.wallMs=performance.now()-started;}});}
export function plannerContext(){const c=scope.getStore();need(c,'configuration_invalid');return c;}
export function plannerGate(phase:string){const c=plannerContext(),started=performance.now();try{c.gate();c.hook?.(phase);c.gate();}finally{if(c.active){const t=c.active.costs.gate??={ms:0,count:0};t.ms+=performance.now()-started;t.count++;}}}
// Exclusive leaf costs. The caller never nests cost() within another cost().
export function plannerCost<T>(key:string,run:()=>T):T{plannerGate(key+':before');const c=plannerContext(),started=performance.now();try{return run();}finally{const t=c.active!.costs[key]??={ms:0,count:0};t.ms+=performance.now()-started;t.count++;plannerGate(key+':after');}}
export function plannerWireCap(request:number,reply:number){if(request>plannerContext().wireCap||reply>plannerContext().wireCap)throw Error('cgp_i0_wire_budget');}

/** Outer stages may include a planner invocation; never add seal inclusive time to its nested plan wall. */
export function plannerStage<T>(key:string,run:()=>T):T{plannerGate(key+':before');const c=plannerContext(),start=performance.now();try{return run();}finally{const t=c.measure.stages[key]??={ms:0,count:0};t.ms+=performance.now()-start;t.count++;plannerGate(key+':after');}}
