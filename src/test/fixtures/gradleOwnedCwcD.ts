import {validateCwcD} from './gradleOwnedCwcDValidation.mjs';
export {validateCwcD} from './gradleOwnedCwcDValidation.mjs';
/** CWC-D local signed-session comparison. No deployed storage or RSS claim. */
import {collectPlans,type PlanTrace} from './gradleOwnedCprBPProfile.js';
import {performance} from 'node:perf_hooks';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {cwcCCase} from './gradleOwnedCwcCCase.js';
import {cprBPCase} from './gradleOwnedCprBP.js';
import {CWC_C_WORKLOADS} from './gradleOwnedCwcCExperiment.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export type Arm='scalar'|'reference'|'composed'|'bp-bridge';
const arms:Arm[]=['scalar','reference','composed','bp-bridge'];
export async function runCwcD(rounds=3,workloads:readonly typeof CWC_C_WORKLOADS[number][]=CWC_C_WORKLOADS){
 need(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=10,'configuration_invalid');const rows:any[]=[];
 // Warm each arm; warmups are retained and excluded from paired summaries.
 for(const workload of workloads)for(const role of ['reader','authority-broker'] as const)for(let round=-1;round<rounds;round++)for(const observed of [false,true]){
  const approval=cwcCApprovalFixture();
  for(let i=0;i<4;i++){const arm=arms[(i+round+1)%4]!,assemblyStart=performance.now(),opts={variant:'combined' as const,role,sizes:[...workload.sizes],realClock:true,planEvents:observed};
   const f=arm==='bp-bridge'?cprBPCase('B-independent',opts):cwcCCase(arm==='scalar'?'S-scoped':'B-independent',{...opts,codeApproval:approval.view,comparisonProfile:true,memory:1048576,referenceOracle:arm==='reference'});
   const assemblyMs=performance.now()-assemblyStart,start=performance.now();
   try{const traces:PlanTrace[]=[];const r=observed?await collectPlans(traces,()=>f.transfer()):await f.transfer(),end=performance.now();rows.push({workload:workload.id,role,round,observed,arm,approvalPin:arm==='bp-bridge'?null:approval.pin,deadlineMs:4500,memoryLimit:arm==='bp-bridge'?null:1048576,referenceScratchBytes:arm==='bp-bridge'?null:81920,assemblyMs,outerMs:end-start,status:'complete',traces,...r,referenceOracleCalls:'codecPlans'in f?[...f.codecPlans,...(f.provider as any).codecPlans].reduce((n,p)=>n+(p.referenceOracleCalls??0),0):null});}
   catch(e){rows.push({workload:workload.id,role,round,observed,arm,approvalPin:arm==='bp-bridge'?null:approval.pin,deadlineMs:4500,memoryLimit:arm==='bp-bridge'?null:1048576,referenceScratchBytes:arm==='bp-bridge'?null:81920,assemblyMs,outerMs:performance.now()-start,status:'failed',error:e instanceof Error?e.message:String(e)});}
   finally{f.close();}
  }
 }
 return {schema:'cwc-d.measurement.v1',rounds,rows,summary:validateCwcD(rows,rounds,workloads.map(w=>w.id))};
}
