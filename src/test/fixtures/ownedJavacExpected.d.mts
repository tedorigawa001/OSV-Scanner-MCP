export const javacRecipe:any;
export const javacRecipeDigest:string;
export const buildCases:Readonly<Record<string,readonly string[]|null>>;
export const javacSources:string[];
export function driverSource(removed?:boolean,value?:string):string;
export function expectedSources(name:string):Record<string,string>;
export function expectedSourceHashes(name:string):Record<string,string>;
