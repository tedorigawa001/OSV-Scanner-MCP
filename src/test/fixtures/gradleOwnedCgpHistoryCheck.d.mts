export type HistoryGroup={role:string;api:string;action:string;callsite:string;selector:string;phase:string;count:number;inclusiveWallMs:number};
export function validateHistoryReads(sample:any):HistoryGroup[];
