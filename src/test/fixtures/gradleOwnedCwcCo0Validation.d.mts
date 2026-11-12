export const CO0_SCOPE_EXPECTED:Readonly<Record<string,boolean>>;
export function co0Canonical(value:unknown):string;
export function co0Hash(value:unknown):string;
export function co0ExpectedRows(context:any):{bytes:number;sha256:string}[];
export function co0ExpectedTrace(families:number,closed?:boolean):{rows:any[];managed:number};
export function validateCo0Evidence(evidence:any):Record<string,unknown>;
export function compareCo0Replay(saved:any,fresh:any):void;
