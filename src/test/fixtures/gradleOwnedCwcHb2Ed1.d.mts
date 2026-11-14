export const ED1_IDS:readonly string[];
export const ED1_FLAGS:readonly string[];
export const ED1_LIMITS:Readonly<Record<string,number>>;
export const ED1_SCOPE:Readonly<Record<string,boolean|number|null>>;
export function validateEd1Probes(probes:any,runtime:any,approval:any):true;
export function ed1Assessment(probes:any,inventory:any,runtime:any,approval:any):any[];
export function validateEd1Assessment(value:any,probes:any,inventory:any,runtime:any,approval:any):true;
