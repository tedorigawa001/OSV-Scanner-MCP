export const ownedInputModes:string[];
export const ownedInputSourcePaths:string[];
export const ownedInputBoundaryEvents:string[];
export const ownedInputFaults:Array<{kind:string;flag:'preGateRead'|'preGateKgpRead'}>;
export const ownedInputEvidenceTargets:Array<{runIndex:number;mode:string;event:string}>;
export function verifyOwnedInputsCase(value:any, approval:any):any;
