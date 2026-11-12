export const WINDOW_SCOPE_EXPECTED:Readonly<Record<string,boolean>>;
export const WINDOW_SITES:ReadonlyArray<{id:string;path:string;anchor:string}>;
export function windowSourceLocations(sources:Record<string,string>):any[];
export function windowCanonical(value:unknown):string;
export function windowHash(value:unknown):string;
export function expectedWindowTrace(widths:number[],capacity:number):any[];
export function validateWindowEvidence(evidence:any,capacityRecord:any):Record<string,unknown>;
export function compareWindowReplay(recorded:any,replayed:any):void;
