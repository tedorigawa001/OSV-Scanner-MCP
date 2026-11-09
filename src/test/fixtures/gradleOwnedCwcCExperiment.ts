/** Reproducible correctness/resource matrix, not a wall-time performance comparison. */
import {vi} from 'vitest';
import * as wire from './gradleOwnedCprAWire.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {cwcCCase} from './gradleOwnedCwcCCase.js';
import {cprBPCase} from './gradleOwnedCprBP.js';
import {CPR_WORK} from './gradleOwnedCprAAdmission.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export const CWC_C_WORKLOADS=[{id:'small',sizes:[600,800,900,1100,1300]},{id:'mid-2048',sizes:[600,2048,2048,2048,2048]},{id:'large-commit',sizes:[18000,4096,4096,4096,4096]},{id:'large-payload',sizes:[600,9000,9000,9000,9000]},{id:'h0Sizes',sizes:[3061,1250,20810,5057,949,635,2072,6745,881]},{id:'singleLarge',sizes:[41456,1,1,1,1]}] as const;
export async function runCwcCMatrix(){const samples=[];
 for(const workload of CWC_C_WORKLOADS)for(const role of ['reader','authority-broker'] as const){
  const approval=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:approval.view,variant:'combined',role,sizes:[...workload.sizes],realClock:true}),ref=cprBPCase('B-independent',{variant:'combined',role,sizes:[...workload.sizes]});
  const exact=vi.spyOn(wire,'exact'),layout=vi.spyOn(wire,'layout'),owner=vi.spyOn(wire,'owner');
  try{const r=await f.transfer(),n=r.requests,plans=[...f.codecPlans,...f.provider.codecPlans],rows=f.provider.rows;
   const finalOracleCalls=exact.mock.calls.length,layoutCalls=layout.mock.calls.length,unkeyedOwnerExportCalls=owner.mock.calls.filter(args=>args[3]===undefined).length,keyedReplyOwnerCalls=owner.mock.calls.filter(args=>args[3]!==undefined).length;
   need(finalOracleCalls===0&&layoutCalls===n+2&&unkeyedOwnerExportCalls===0&&keyedReplyOwnerCalls===n,'cwc_c_probe_mismatch');
   need(plans.length===n+2&&f.clientWork===2*CPR_WORK.plan&&f.provider.metrics.loads===n+2&&f.provider.metrics.plans===n,'cwc_c_coverage');
   for(const p of plans)need(p.stats.finalOwners===0&&p.stats.finalFrames===0&&p.stats.layoutOwners===2&&p.stats.layoutFrames===4&&p.codec.encodes===0&&p.codec.connected===true&&p.grant.prepaidPlanWork===CPR_WORK.plan&&p.grant.memory.reserved<=1048576&&p.grant.steps.root===1&&p.grant.steps.compile===1&&p.grant.steps.encode===p.grant.steps.proof&&p.grant.steps.proof===p.codec.proofs&&p.grant.steps['codec:proof']===p.codec.proofs,'cwc_c_coverage');
   need(rows.length===n+2&&rows.filter(row=>row.spent.work===CPR_WORK.total).length===n&&rows.filter(row=>row.spent.work===CPR_WORK.source+CPR_WORK.finish).length===2,'cwc_c_work_accounting');
   const reference=await ref.transfer();need(reference.outputDigest===r.outputDigest&&reference.planDigest===r.planDigest&&reference.wireBytes===r.wireBytes&&reference.requests===n,'cwc_c_semantic_mismatch');const referenceOracleCalls=exact.mock.calls.length-finalOracleCalls;
   need(referenceOracleCalls===n*(n+2),'cwc_c_probe_control');const memoryPeak=Math.max(...plans.map(p=>p.grant.memory.reserved)),live=f.liveCodecState;
   need(live.seal?.steps.read===n&&live.initial?.complete===true&&live.seal.complete===true,'cwc_c_child_coverage');
   samples.push({sourceApprovalPin:approval.pin,...(samples.length===0?{sourceApprovalEvidence:{registry:approval.registry,independentPin:approval.pin,envelope:approval.envelope}}:{}),workload:workload.id,role,requests:n,clientPlans:r.clientPlans,providerPlans:r.providerPlans,sourceLoads:f.provider.metrics.loads,privateSnapshotPerRpc:true,outputDigest:r.outputDigest,planDigest:r.planDigest,wireBytes:r.wireBytes,referenceOutputDigest:reference.outputDigest,referencePlanDigest:reference.planDigest,referenceWireBytes:reference.wireBytes,memoryPeak,memoryLimit:1048576,memoryKind:'logical-coexistence-bound',rssVerified:false,clientWork:f.clientWork,providerBatchWork:CPR_WORK.total,planReservation:CPR_WORK.plan,workAccounting:'cpr.request-bytes-ranges-probes.v1',remainingDeadlineMs:f.parentDeadline-Math.floor(r.timing.end),probes:{finalOracleCalls,layoutCalls,unkeyedOwnerExportCalls,keyedReplyOwnerCalls,referenceOracleCalls},plans,liveClientSteps:live,rows});
  }finally{exact.mockRestore();layout.mockRestore();owner.mockRestore();f.close();ref.close();}
 }
 return samples;
}
