export const javacVerificationSources:string[];
export function fileFingerprints(files:string[]):Record<string,string>;
export function verifyJavacTuple(tuple:any):any;
export function verifyJavacRecord(record:any,options?:{currentSources?:boolean}):any;
