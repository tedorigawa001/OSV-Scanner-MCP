export const manifestLimits:Readonly<Record<string,number>>;
export function canonicalBytes(value:any):Buffer;
export function parseManifestJson(bytes:Buffer|string|Uint8Array):any;
export function objectDigest(value:any):string;
export function sha256(bytes:Buffer|string|Uint8Array):string;

export const stages: readonly string[];
export const successRefs: readonly string[];
export const failureCases: readonly {stage:string;phase:string;reason:string}[];
export function verifyManifest(input:any, expected:any):any;
