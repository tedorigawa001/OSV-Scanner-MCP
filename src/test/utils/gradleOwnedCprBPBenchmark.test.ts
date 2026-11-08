import {it,expect} from 'vitest';import {writeFile} from 'node:fs/promises';
import {cprBPCase} from '../fixtures/gradleOwnedCprBP.js';import {cprBCase} from '../fixtures/gradleOwnedCprB.js';
import {type PlannerVariant} from '../fixtures/gradleOwnedCprBPPlanner.js';
import {collectPlans,type PlanTrace} from '../fixtures/gradleOwnedCprBPProfile.js';import {instrumentPlans} from '../fixtures/gradleOwnedCprBPInstrumentation.js';
import {cprBPSources,analyzeCprBP,primaryOrder} from '../fixtures/gradleOwnedCprBPRecord.mjs';
const workloads={default:[600,700,1600,2000,3000],small:[100,200,300,400,500,600,700,800,900],h0Sizes:[3061,1250,20810,5057,949,635,2072,6745,881],singleLarge:[41456,1,1,1,1]};
it.skipIf(process.env.OSV_CPR_BP_RECORD!=='1')('records planner decomposition and matched original/scalar/reference/combined transfers',async()=>{
 const sources=await cprBPSources(),blocks=[],warmups=[],diagnostics=[];
 for(const [workload,sizes]of Object.entries(workloads))for(const role of ['reader','authority-broker'] as const){
  async function arm(variant:string,temperature:string){
   const mode=variant==='scalar'?'S-scoped':'B-independent',f=variant==='original'?cprBCase(mode,{sizes,role,realClock:true}):cprBPCase(mode,{sizes,role,realClock:true,variant:variant==='scalar'?'reference':variant as PlannerVariant});let phase='connect';
   try{if(temperature==='warm')await f.client.connect();const first=f.frames.length;phase='transfer';const result=await f.transfer('transfer');return {status:'complete',result,metrics:structuredClone(f.provider.metrics),plans:structuredClone(f.provider.plans),frames:structuredClone(f.frames.slice(first)),clientRows:f.clientRows,providerRows:f.provider.rows,deadline:f.parentDeadline};}
   catch(error:any){return {status:'failed',failure:{phase,reason:error?.reason??'unexpected_error',message:String(error?.message??error),partial:f.clientRows.some(x=>x.state==='complete')},metrics:structuredClone(f.provider.metrics),frames:structuredClone(f.frames),clientRows:f.clientRows,providerRows:f.provider.rows,deadline:f.parentDeadline};}
   finally{f.close();}
  }
  // No profiling wrappers are installed during these primary/bridge arms.
  for(const temperature of ['cold','warm']){
   for(const variant of ['scalar','reference','combined','original'])warmups.push({workload,role,temperature,variant,arm:await arm(variant,temperature)});
   for(let repetition=0;repetition<6;repetition++){
    const order=primaryOrder(repetition),arms:any={};let original:any;
    if(repetition%2)original=await arm('original',temperature);
    for(const variant of order)arms[variant]=await arm(variant,temperature);
    if(!original)original=await arm('original',temperature);
    blocks.push({workload,role,temperature,repetition,order,arms,original,originalPosition:repetition%2?'before':'after'});
   }
  }
  for(const [i,variant]of (['reference','max-first','single-check','combined'] as const).entries()){
   let quiet:any;if(i%2)quiet=await arm(variant,'warm');const traces:PlanTrace[]=[],restore=instrumentPlans();let observed:any;
   try{observed=await collectPlans(traces,()=>arm(variant,'warm'));}finally{restore();}
   if(!quiet)quiet=await arm(variant,'warm');diagnostics.push({workload,role,variant,quiet,observed,traces,quietPosition:i%2?'before':'after'});
  }
 }
 const raw={schema:'cpr-bp.native.v1',date:'2026-11-08',sources,host:{node:process.version,platform:process.platform,arch:process.arch},scope:{inProcess:true,signedSessionRuntime:true,mockStorage:true,mockPin:true,independentPlans:true,realStorageVerified:false,nativeIsolationVerified:false,productionAdopted:false,eightReadsEstablished:false,originalReadsSkipped:0,readCommittedReduction:0},blocks,warmups,diagnostics,sourceSnapshotStable:JSON.stringify(sources)===JSON.stringify(await cprBPSources())};
 if(process.env.OSV_CPR_BP_OUTPUT)await writeFile(process.env.OSV_CPR_BP_OUTPUT,JSON.stringify(raw)+'\n');analyzeCprBP(raw);expect(raw.sourceSnapshotStable).toBe(true);
},180000);
