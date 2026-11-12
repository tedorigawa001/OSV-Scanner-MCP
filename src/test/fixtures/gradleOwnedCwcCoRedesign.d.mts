export const CO_RED_DESIGN:any;
export function coRedesignCapacity(c:any,role:string,o?:{callerClientCores?:number;callerProviderCores?:number;outsideScratch?:number;bridgeOverTarget?:number;otherUncoveredBytes?:number}):any;
export function coRedesignWork(o:{work:number;initialization:number;extraWork:number;extraInitialization:number;attempts?:number}):any;
export function coRedesignBatch(o:{batchCount:number;coreGroups:number;width:number;capturedOrdinals:number[];provedOrdinals:number[];commandBatchCounts?:number[]}):any;
