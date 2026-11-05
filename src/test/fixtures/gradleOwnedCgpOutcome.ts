import {writeFile} from 'node:fs/promises';
/** RPC errors gain "<role>/<action>: " per hop. Only known owners may prefix an otherwise exact code. */
const ownerHops='(?:(?:control-anchor|lineage-registry|provider|checkpoint-issuer|authority-broker)/[a-z-]+: )*';
const exactCode=(code:string)=>new RegExp('^Error: '+ownerHops+'current_control_'+code+'$');
/** Only an explicit expiry is a deadline observation. Ambiguous budget errors stay separate. */
export function cgpReadFailure(reason:string):'deadline-refused'|'capacity-refused'|'other-refused'{
 if(exactCode('request_expired').test(reason))return 'deadline-refused';
 if(exactCode('capacity_exhausted').test(reason))return 'capacity-refused';
 return 'other-refused';
}
export const CGP_PARTIAL_SCHEMA='osv-mcp.cgp.measurements.partial.v0';
export type CgpProgress={stage:string;sample:number|null;index:number|null;lastRead:unknown;completeReportWritten:boolean};
/** A failed run leaves what it measured at the output path. The schema keeps it out of validation and analysis. */
export async function cgpKeepEvidenceOnFailure(output:string|undefined,evidence:()=>Record<string,unknown>,run:(progress:CgpProgress)=>Promise<void>){
 const progress:CgpProgress={stage:'start',sample:null,index:null,lastRead:null,completeReportWritten:false};
 try{await run(progress);}catch(error){
  if(output&&!progress.completeReportWritten){const {completeReportWritten:_,...failedAt}=progress;try{await writeFile(output,JSON.stringify({...evidence(),schema:CGP_PARTIAL_SCHEMA,failedAt,failure:String(error),backendEligible:false,nativeIsolationVerified:false,independentRegistryVerified:false,originalReadsSkipped:0},null,2)+'\n');}catch(writeError){throw new AggregateError([error,writeError],'cgp_partial_evidence_unwritten');}}
  throw error;
 }
}
