/** Shared checks for the published snapshot readiness record; verification sources only. */
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// The fault proof may differ from the normal case only by its own observe run.
export function verifySnapshotFaultBinding(c){
 const runs=c?.fault?.proof?.runs;
 if(!Array.isArray(runs)||runs.length!==c.runs.length||[0,2,3,4].some(i=>!same(runs[i],c.runs[i]))||runs[1]?.mode!=='observe'||runs[1].preflightReadFault!==true||c.runs.some(r=>r.runId===runs[1].runId))throw Error('snapshot-preflight-fault-unbound');
 const {preflightReadFault:_p,runs:_r,...faultIdentity}=c.fault.proof,{decision:_d,stateRejections:_s,fault:_f,runs:_n,...caseIdentity}=c;
 if(!same(faultIdentity,caseIdentity))throw Error('snapshot-preflight-fault-unbound');
}
// Run IDs identify the native observation set independently of record formatting.
export const snapshotRunIds=matrices=>matrices.flatMap(m=>m.cases.flatMap(c=>[...c.runs,c.fault.proof.runs[1]].map(r=>r.runId))).sort();
export function snapshotRecordCounts(matrices){
 const all=matrices.flatMap(m=>m.cases);
 return {nativeBuilds:all.reduce((n,c)=>n+c.runs.length+1,0),conditionalWitnesses:all.filter(c=>c.decision.conditionalRereadWitness).length,preflightCachedReadRejections:all.length,stateFlagRejections:all.reduce((n,c)=>n+c.stateRejections.length,0),
  noReadClassifierRefusals:all.reduce((n,c)=>n+c.runs.reduce((n,r)=>n+r.checks.filter(x=>!x.accepted).length,0),0),productionAdoptions:0,approvedRecipes:0,fullPipelineCandidates:0,naturalContentBindings:0};
}
