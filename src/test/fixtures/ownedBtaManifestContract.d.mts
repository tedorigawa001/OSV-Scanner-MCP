export function btaFail(reason?:string):never;
export function verifyBtaManifestTuple(tuple:any):any;
export function verifyBtaManifestRecord(record:any,options?:{currentSources?:boolean}):any;
export function runtimeVector(version:string):any[];
export function bridgeFingerprints(files:string[]):Record<string,string>;

export function makeBridgeBundle(report:any):any;
