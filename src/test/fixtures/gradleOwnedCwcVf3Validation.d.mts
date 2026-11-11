export const VF3_WORKLOADS:{id:string;sizes:number[]}[];export const VF3_ARMS:string[];export const VF3_OBSERVATIONS:("quiet"|"counts"|"timed")[];export const VF3_CONDITIONS:any;export function summarizeVf3(rows:any[]):any;
export function validateVf3Row(row:any):any;export function validateVf3Measurement(m:any,sources:Record<string,string>):any;export function classifyVf3Control(r:any):any;export function vf3Decision(rows:any[]):any;export function vf3Table(summary:any):string;
export function validateVf3LiveCounts(metrics:any,partial:boolean):void;
export function validateVf3Actual(actual:any,parentDeadline:number):void;
