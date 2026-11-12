export const CO0B_SITES:readonly (readonly string[])[];
export function co0bSha(bytes:string|Buffer):string;
export function co0bSourceAudit(read?:(path:string)=>string):any;
export function co0bEligibility(audit:unknown):{eligible:false;reasons:string[];threeSlotEstablished:false;metadataBridgeWithin4096:false;completeWorkCoverage:false;co0Exit:false;co1Admitted:false;productionAdopted:false};
