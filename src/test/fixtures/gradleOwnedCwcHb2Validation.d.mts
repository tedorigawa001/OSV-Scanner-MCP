export const HB2_SCOPE_EXPECTED:Readonly<Record<string,boolean>>;
export function hb2Hash(value:unknown):string;
export function validateHb2Evidence(value:unknown,pins:unknown):{modes:number;scenarios:number;nativeCases:number;regions:number;activeReadCap:number;issuedReadCap:number;ordinaryCap:number;cleanupCap:number;refusalCap:number;scope:string;independentChargeApproved:false;originalUnitWorkCoverage:false;durableRestartFencing:false;wholeBudgetFit:false;productionAdopted:false};
export function validateHb2Inventory(value:unknown):true;
export function compareHb2Replay(saved:unknown,fresh:unknown,pins:unknown):true;
