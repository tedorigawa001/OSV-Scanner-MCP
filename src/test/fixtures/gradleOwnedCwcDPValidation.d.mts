export const DP_ARMS:string[];
export function validateDpTrace(trace:any,outerMs:number,requests:number,quiet:boolean):Record<string,{calls:number;inclusiveMs:number;exclusiveMs:number}>;
export function validateCwcDP(rows:any[],rounds:number,workloads:readonly string[],expectedClock?:'real'|'fixed'):any[];
