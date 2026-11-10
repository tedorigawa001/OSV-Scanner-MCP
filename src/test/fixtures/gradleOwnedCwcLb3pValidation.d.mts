export const LB3P_GROUPS:string[];
export const LB3P_POLICY:any;
export function profileGroup(name:string):string;
export function costBreakdown(p:any):any;
export function validateLb3pCost(row:any,sources:Record<string,string>):any;
export function summarizeLb3p(rows:any[],rounds:number,workloads:string[],clock:string):any;
export function validateLb3pMeasurement(m:any,sources:Record<string,string>,methods:Record<string,string>):any;

export function summarizeLb3pBase(rows:any[],rounds:number,workloads:string[],clock:string):any;
export function wireShape(row:any):any;
