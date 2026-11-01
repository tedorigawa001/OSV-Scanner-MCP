export const observerSourcePaths:readonly string[];
export interface ObserverApproval {gradleVersion:string;consumerDSL?:string;mode?:string;eagerCompiler?:boolean;sourcesSha256:Record<string,string>}
export interface TraceComparison {equal:boolean;extraEvaluations:{event:string;phase:string}[];outsideObserverChanged:boolean}
export function compareObserverTraces(control:{event:string;phase:string}[],observed:{event:string;phase:string}[]):TraceComparison;
export function verifyObserverCase(data:any,approval:ObserverApproval):TraceComparison & {conditionalCandidate:boolean;productionAdopted:boolean;reason:string};
export function verifyObserverMatrix(data:any,approval:ObserverApproval):ReturnType<typeof verifyObserverCase>[];
