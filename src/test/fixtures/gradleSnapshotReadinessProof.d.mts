export const snapshotModes:string[];
export const snapshotSources:string[];
export function verifySnapshotReadinessCase(c:any,a:any):any;
export function verifySnapshotReadinessFault(c:any,a:any):any;
export const snapshotStateTargets:Array<{mode:string;field:string;action:string;reason:string}>;
export function mutateSnapshotState(c:any,target:any):any;
export function snapshotStateRegressions(c:any,a:any):any[];
