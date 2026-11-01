export const ownerTuples:any[];
export const ownerSources:string[];
export const ownerTypes:string[][];
export function digest(b:any):string;
export function ownerMethod(bytecode:string,pattern:RegExp):string;
export function snapshotOwnerFacts(source:string,bytecode:string):any;
export function verifySnapshotOwnerSurvey(d:any,reference:any,sources:any):any;
