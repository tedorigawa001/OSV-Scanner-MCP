export const CAPACITY_BOUNDARIES:readonly string[];
export const CAPACITY_RECIPES:readonly string[];
export const CAPACITY_SCOPE:Readonly<Record<string,boolean>>;
export const CAPACITY_LIFETIMES:readonly {id:string;source:string;anchor:string;retainedUntil:string;releaseBefore:string;candidate:string}[];
export function capacityContext(input:unknown,role:'reader'|'authority-broker',boundary:string):any;
export function capacityBreakdown(input:unknown,role:'reader'|'authority-broker'):any;
export function capacityCandidate(input:unknown,role:'reader'|'authority-broker',recipe:string):any;
export function capacityRow(input:unknown,role:'reader'|'authority-broker',recipe:string):any;
