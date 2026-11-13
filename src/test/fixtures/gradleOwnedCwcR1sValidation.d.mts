export const R1S_SCOPE_EXPECTED: Readonly<Record<string,boolean>>;
export function r1sHash(value:unknown):string;
export function validateR1sEvidence(value:unknown):{normal:number;rejection:number;cancelled:number;unavailable:number;modes:number;bytesPerRecord:number;realBinaryBytesPerRead:number;maxResidentBinaryBytes:number;scope:string;chargeProved:false;realCoreReceipt:false;authenticatedIPC:false;wholeBudgetFit:false;productionAdopted:false};
export function compareR1sReplay(saved:unknown,fresh:unknown):true;
