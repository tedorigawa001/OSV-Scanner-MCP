export function i2Sources():Promise<any>;
export function analyzeI2(raw:any):any;
export function checkI2Instruments(files:Record<string,string>,read:(file:string)=>Promise<string|Buffer>):Promise<void>;
