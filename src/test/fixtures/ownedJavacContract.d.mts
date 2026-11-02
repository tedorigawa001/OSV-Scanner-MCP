export function verifyBuildCase(c:any,policy:any):any;
export function verifyInventory(inv:any):any;
export function createJar(entries:{path:string;bytes:Buffer;compression?:'deflate'}[]):Buffer;
export function inspectJar(bytes:Buffer):any[];
export function safeEntry(path:string):void;
export function crc32(bytes:Buffer):number;
export function expectedArgs(sources:any):string[];
export function buildFail(reason?:string):never;

export function verifyRequestedRecipe(recipe:any):boolean;
export function codeUnitOrder(a:string,b:string):number;
