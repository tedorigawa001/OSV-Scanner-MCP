/** CWC-DP diagnostic only: fresh signed calls, no authority fact caching. */
import {cwcCCase} from './gradleOwnedCwcCCase.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {CWC_C_WORKLOADS} from './gradleOwnedCwcCExperiment.js';
import {installDpObserver} from './gradleOwnedCwcDPProfile.js';
import {DP_ARMS,validateCwcDP} from './gradleOwnedCwcDPValidation.mjs';
export {validateCwcDP};
export async function runCwcDP(rounds=3,workloads:readonly typeof CWC_C_WORKLOADS[number][]=CWC_C_WORKLOADS,{realClock=true}:{realClock?:boolean}={}){
 const rows:any[]=[];
 for(const workload of workloads)for(const role of ['reader','authority-broker'] as const)for(let round=-1;round<rounds;round++){
  const approval=cwcCApprovalFixture();
  for(let index=0;index<DP_ARMS.length;index++){
   const arm=DP_ARMS[(index+round+1)%DP_ARMS.length]!,profiled=arm.endsWith('profiled'),quiet=arm.startsWith('diagnostic-quiet');
   const f=cwcCCase(arm==='scalar'?'S-scoped':'B-independent',{codeApproval:approval.view,comparisonProfile:true,codecDiagnostics:!quiet,variant:'combined',role,sizes:[...workload.sizes],realClock,planEvents:false});
   let observer:ReturnType<typeof installDpObserver>|undefined;const traceHolder:{trace:any}={trace:null};
   const observerSetupStart=performance.now();if(profiled)observer=installDpObserver();const observerSetupMs=profiled?performance.now()-observerSetupStart:0,start=performance.now();
   try{let result:Awaited<ReturnType<typeof f.transfer>>;
    if(observer){const measured=await observer.measure(()=>f.transfer());traceHolder.trace=measured.trace;if(!measured.ok)throw measured.error;result=measured.result!;}else result=await f.transfer();
    const end=performance.now(),rs=f.provider.rows;
    rows.push({workload:workload.id,role,round,arm,clock:realClock?'real':'fixed',approvalPin:approval.pin,deadlineMs:4500,memoryLimit:1048576,observerSetupMs,outerMs:end-start,status:'complete',trace:traceHolder.trace,...result,providerRows:rs,sourceLoads:f.provider.metrics.loads,clientWork:f.clientWork,codecRecords:f.codecPlans.length+f.provider.codecPlans.length,batchRows:rs.filter(r=>r.spent.work===222515).length,completeRows:rs.filter(r=>r.state==='complete').length,workValid:rs.every(r=>[65537,222515].includes(r.spent.work))});
   }catch(e){rows.push({workload:workload.id,role,round,arm,clock:realClock?'real':'fixed',approvalPin:approval.pin,deadlineMs:4500,memoryLimit:1048576,observerSetupMs,outerMs:performance.now()-start,status:'failed',trace:traceHolder.trace,error:e instanceof Error?e.message:String(e)});}
   finally{observer?.close();f.close();}
  }
 }
 // Fixed clock runs are regression-only: no performance evidence or adoption claim.
 return {schema:'cwc-dp.measurement.v1',clock:realClock?'real':'fixed',rounds,rows,summary:validateCwcDP(rows,rounds,workloads.map(w=>w.id),realClock?'real':'fixed')};
}
