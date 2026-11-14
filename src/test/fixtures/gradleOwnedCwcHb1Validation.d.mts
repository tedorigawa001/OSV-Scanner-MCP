export const HB1_SCOPE_EXPECTED:Readonly<Record<string,boolean>>;
export function hb1Hash(value:unknown):string;
export function validateHb1Evidence(value:unknown,pins:unknown):{normal:number;rejection:number;authority:number;cleanup:number;boundary:number;source:number;modes:number;readerMethods:number;scope:string;signedRegistryApproval:false;independentChargeApproved:false;actualParentLedgerVector:false;productionAdopted:false};
export function compareHb1Replay(saved:unknown,fresh:unknown,pins:unknown):true;
