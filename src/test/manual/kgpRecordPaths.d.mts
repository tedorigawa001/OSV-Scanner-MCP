export const recordTokens:string[];
export function tokenizeRecordedPaths<T>(value:T,roots:Array<{token:string;paths:Array<string|undefined>}>):T;
export function assertNoAbsolutePaths(value:unknown,where?:string):void;
export function resolveRecordedPath(recorded:string,env:Record<string,string|undefined>):string;
