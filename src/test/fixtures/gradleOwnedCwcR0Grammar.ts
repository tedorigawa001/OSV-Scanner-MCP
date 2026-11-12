/** Closed ASCII command family. Static descriptor compilation is outside the R0 command path. */
import {CPR_SPEC_DIGEST} from './gradleOwnedCprASchema.js';
export type R0Spec={kind:'object'|'array'|'string'|'number';fields?:readonly (readonly [string,R0Spec,boolean])[];item?:R0Spec;min?:number;max?:number;
 pattern?:'cid'|'hash';values?:readonly string[];optional?:boolean;nullable?:boolean;binding?:boolean};
const cid:R0Spec={kind:'string',pattern:'cid'},hash:R0Spec={kind:'string',pattern:'hash'};
const num=(min=0,max=Number.MAX_SAFE_INTEGER):R0Spec=>({kind:'number',min,max});
const lit=(...values:string[]):R0Spec=>({kind:'string',values});
const obj=(fields:Record<string,R0Spec>):R0Spec=>({kind:'object',fields:Object.keys(fields).sort().map(k=>[k,fields[k]!,!!fields[k]!.optional])});
const optional=(s:R0Spec):R0Spec=>({...s,optional:true});
const identity=obj({credentialId:cid,role:lit('operator','manager','writer','provider','checkpoint-issuer','lineage-registry','control-anchor','authority-broker','reader'),instanceId:cid,boot:hash,keyEpoch:num(1)});
const lineageFields={authorityId:cid,lineageId:cid,generation:num(1),storeEpoch:hash,enrollmentDigest:hash,profileDigest:hash};
const lineage=obj(lineageFields),ref=(role:string)=>obj({role:lit(role),id:cid,sha256:hash,byteLength:num(1,65536)});
const snapshot=ref('snapshot'),checkpoint=ref('checkpoint-prepare'),pin=ref('read-pin');
const head=obj({format:lit('v2'),revision:num(1,256),commitDigest:hash,stateRoot:hash,baseDigest:hash});
const selected={...obj({snapshot,checkpoint,head}),nullable:true};
const binding={...obj({...lineageFields,format:lit('v1','v2'),storeRootId:cid,checkpointRootId:cid,rootPairId:cid,storageInstanceId:cid,providerBoot:hash,
 namespaceGeneration:num(),writerFence:num(),registryIncarnation:hash,selectionRevision:num(),revocationEpoch:num(),checkpointIssuer:cid,checkpointKeyEpoch:num(1),
 schemaDigest:hash,parserDigest:hash,policyDigest:hash,mode:lit('provision','serving'),selected}),binding:true};
export const R0_CONTEXT=obj({catalog:hash,manifest:hash,registryDigest:hash,deploymentDigest:hash,endpointId:cid,requestKeyId:cid,replyKeyId:cid,
 peer:identity,provider:identity,origin:optional(identity),lineage,binding,snapshot,checkpoint,pin,metadataDigest:hash,inventoryDigest:hash});
const range=obj({ordinal:num(0,3),kind:lit('commit','payload'),index:num(0,8),offset:num(0,41460),length:num(1,4096),entry:obj({sha256:hash,byteLength:num(1,41460)})});
export const R0_COMMAND=obj({schema:lit('osv-mcp.cgp.source-command.v3'),api:lit('aux.ReadSourceRanges'),purpose:lit('read'),operationId:hash,peer:identity,lineage,binding,
 payload:obj({snapshot,checkpoint,pin,origin:optional(identity),transferId:cid,plan:obj({specDigest:lit(CPR_SPEC_DIGEST),seed:cid,batchOrdinal:num(0,18),batchCount:num(1,19),planDigest:hash,inventoryDigest:hash}),
 ranges:{kind:'array',item:range,min:1,max:4},byteBudget:num(1,4096)}),requestDigest:hash});
const keys=new Set<string>(),seen=new Set<R0Spec>();
function freeze(s:R0Spec){if(seen.has(s))return;seen.add(s);for(const f of s.fields??[]){keys.add(f[0]);freeze(f[1]);Object.freeze(f);}if(s.item)freeze(s.item);if(s.fields)Object.freeze(s.fields);if(s.values)Object.freeze(s.values);Object.freeze(s);}
freeze(R0_CONTEXT);freeze(R0_COMMAND);
export const R0_KEYS:readonly string[]=Object.freeze([...keys].sort());
export const r0Key=(s:string)=>{const n=R0_KEYS.indexOf(s);if(n<0)throw Error('r0_key');return n;};
