export const offerLimitations:string[];
export function readOwnedOffer(envelope:any,settings:any,read:(path:string,siblings?:string[])=>Buffer):any;
export const offerPhases:string[];
export function validateOwnedOffer(envelope:any):any;
export const offerJdkProfile:any;
export const maxPlannedCaptures:number;
export function classifyOfferExecution(witness:any):any;
export function boundedOfferReader(root:string,options?:{maxEntries?:number;maxFile?:number}):(path:string,siblings?:string[])=>Buffer;
