/** Functional oracle only: fixed-clock VF-2, never a performance/control-arm measurement. */
import {vf2Case} from './gradleOwnedCwcVf2Case.js';
import {vf2ApprovalFixture} from './gradleOwnedCwcVf2Approval.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {VF3_WORKLOADS} from './gradleOwnedCwcVf3Validation.mjs';
export async function vf3Oracles(){
 const a=vf2ApprovalFixture(),code=cwcCApprovalFixture(),rows:any[]=[];
 for(const w of VF3_WORKLOADS)for(const role of ['reader','authority-broker'] as const)for(const transferMode of ['S-scoped','B-independent'] as const)for(const verificationMode of ['full-verify','fact-live'] as const){
  const f=vf2Case({approval:a.view,codeApproval:code.view,role,sizes:w.sizes,transferMode,verificationMode,comparisonProfile:true,memory:1048576,work:1048576,wireBudget:67108864});
  try{const result=await f.transfer('vf3-common');f.close();await f.link.settle();rows.push({workload:w.id,role,transferMode,verificationMode,result,calls:f.link.diagnostics,frames:f.frames});}finally{f.close();}
 }
 a.view.close();code.view.close();return {kind:'fixed-clock-functional-oracle',performanceEvidence:false,rows};
}
