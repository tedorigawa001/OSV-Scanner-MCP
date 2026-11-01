export const supplierSourcePaths:readonly string[];
export interface SupplierApproval {gradleVersion:string;consumerDSL?:string;sourcesSha256:Record<string,string>}
export interface SupplierDecision {controlCalls:number;observedCalls:number;extraPhase:string}
export function verifySupplierProof(data:unknown,approval:SupplierApproval):SupplierDecision;
export function verifySupplierMatrix(data:unknown,approval:SupplierApproval):SupplierDecision[];
