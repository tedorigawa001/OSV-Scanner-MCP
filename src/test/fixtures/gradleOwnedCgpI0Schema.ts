/** CGP-I0 fixture contract only. No production API registration or authority claim. */
import {z} from 'zod';
import {cid,chash,cn,cref,currentBindingSchema} from '../../utils/gradleOwnedCurrentSchema.js';
import {currentLineageSchema} from '../../utils/gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema} from '../../utils/gradleOwnedServiceOwners.js';
import {ownedDigest,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {validateSourceCommand,sourcePurpose} from '../../utils/gradleOwnedSourceSchema.js';
export function i0Need(ok:unknown,why:string):asserts ok{if(!ok)throw Error('cgp_i0_'+why);}
export function i0Parse<T>(schema:z.ZodType<T>,input:unknown):T{try{return schema.parse(input);}catch{throw Error('cgp_i0_schema_invalid');}}
export const i0Same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
export const i0ModeSchema=z.enum(['S*','A*','B*','AB*']);
export type I0Mode=z.infer<typeof i0ModeSchema>;
export const I0_FLAGS=Object.freeze({backendEligible:false,profileApproved:false,nativeIsolationVerified:false,independentRegistryVerified:false,originalReadsSkipped:0});
export const i0GuardPolicySchema=z.object({schema:z.literal('cgp.i0.guard-policy.v1'),implementation:z.literal('common-cgp-intent-guard-v1'),coverage:z.literal('serving-source-observations-v1'),enabled:z.literal(true),partition:z.literal('owner-shared'),targetReads:z.literal(8),sourcePassesPerRead:z.literal(2),scalarControlOperationsPerRead:z.literal(3),scalarOperationsPerRead:cn.positive(),maxSlots:cn.positive().max(512),maxSerializedBytes:cn.positive().max(1024*1024),maxAttempts:z.literal(2),leaseMs:z.literal(5000),marginMs:z.literal(500),noEviction:z.literal(true)}).strict();
export const I0_GUARD_POLICY=Object.freeze({schema:'cgp.i0.guard-policy.v1',implementation:'common-cgp-intent-guard-v1',coverage:'serving-source-observations-v1',enabled:true,partition:'owner-shared',targetReads:8,sourcePassesPerRead:2,scalarControlOperationsPerRead:3,scalarOperationsPerRead:43,maxSlots:512,maxSerializedBytes:262144,maxAttempts:2,leaseMs:5000,marginMs:500,noEviction:true} as const);
const readPlan=z.object({schema:z.literal('cgp.i0.read-plan.v4'),algorithm:z.enum(['scalar-control-v1','ranges-v1']),maxBatches:cn.positive().max(256),maxDataBytes:cn.positive().max(192*1024),maxEntries:cn.positive().max(256),maxWireBytes:cn.positive().max(64*1024*1024),maxWorkUnits:cn.positive().max(64*1024*1024)}).strict();
export const i0ManifestSchema=z.object({schema:z.literal('cgp.i0.mode-manifest.v1'),mode:i0ModeSchema,serviceProfile:chash,producerPolicy:chash,observerDigest:chash,guard:i0GuardPolicySchema,guardDigest:chash,facts:z.boolean(),readPlan,fixtureApproved:z.literal(true)}).strict();
export type I0Manifest=z.infer<typeof i0ManifestSchema>;
export const i0PinsSchema=z.object({manifestDigest:chash,serviceProfile:chash,producerPolicy:chash,observerDigest:chash,guardDigest:chash}).strict();
export type I0Pins=z.infer<typeof i0PinsSchema>;
/** The largest scalar data chunk count any inventory within these limits can need: each entry adds less than one full chunk of rounding. */
export const i0WorstDataChunks=(plan:{maxEntries:number;maxDataBytes:number})=>Math.floor((plan.maxDataBytes+plan.maxEntries*4095)/4096);
export const i0WorstOperationsPerRead=(guard:{scalarControlOperationsPerRead:number;sourcePassesPerRead:number},plan:{maxEntries:number;maxDataBytes:number})=>guard.scalarControlOperationsPerRead+guard.sourcePassesPerRead*(1+i0WorstDataChunks(plan));
export type I0ManifestHandle=Readonly<{kind:'cgp-i0-manifest'}>;
const manifests=new WeakMap<I0ManifestHandle,I0Manifest>();
export function i0Bootstrap(input:unknown,pinsInput:unknown){const m=i0Parse(i0ManifestSchema,input),p=i0Parse(i0PinsSchema,pinsInput);
 i0Need(ownedDigest(m)===p.manifestDigest&&m.serviceProfile===p.serviceProfile&&m.producerPolicy===p.producerPolicy&&m.observerDigest===p.observerDigest,'manifest_pin_mismatch');
 i0Need(ownedDigest(m.guard)===m.guardDigest&&m.guardDigest===p.guardDigest,'guard_policy_mismatch');
 i0Need(m.facts===['A*','AB*'].includes(m.mode)&&m.readPlan.algorithm===(['B*','AB*'].includes(m.mode)?'ranges-v1':'scalar-control-v1'),'mode_mismatch');
 i0Need(m.guard.scalarOperationsPerRead===i0WorstOperationsPerRead(m.guard,m.readPlan)&&m.readPlan.maxBatches<=i0WorstDataChunks(m.readPlan)&&m.guard.maxSlots>=m.guard.targetReads*m.guard.scalarOperationsPerRead,'slot_capacity_insufficient');
 const handle=Object.freeze({kind:'cgp-i0-manifest' as const});manifests.set(handle,structuredClone(m));return handle;
}
export function i0Manifest(handle:I0ManifestHandle){const m=manifests.get(handle);i0Need(m,'manifest_handle_invalid');return structuredClone(m);}
export function i0CheckPrimary(handles:I0ManifestHandle[]){i0Need(handles.length===4,'primary_modes_invalid');const ms=handles.map(i0Manifest);i0Need(new Set(ms.map(m=>m.mode)).size===4,'primary_modes_invalid');const first=ms[0]!;
 for(const m of ms)i0Need(i0Same({...m,mode:first.mode,facts:first.facts,readPlan:{...m.readPlan,algorithm:first.readPlan.algorithm}},first),'primary_policy_mismatch');return true;
}
export const i0RangeSchema=z.object({ordinal:cn.max(3),kind:z.enum(['commit','payload']),index:cn.max(255),offset:cn.max(192*1024),length:cn.positive().max(4096),entry:z.object({sha256:chash,byteLength:cn.positive().max(192*1024)}).strict()}).strict();
export type I0Range=z.infer<typeof i0RangeSchema>;
export const i0BatchPayloadSchema=z.object({snapshot:cref('snapshot'),checkpoint:cref('checkpoint-prepare'),pin:cref('read-pin'),origin:serviceIdentitySchema.optional(),transferId:cid,planDigest:chash,ranges:z.array(i0RangeSchema).min(1).max(4),byteBudget:cn.positive().max(4096)}).strict();
export const i0BatchCommandSchema=z.object({schema:z.literal('osv-mcp.cgp.source-command.v2'),api:z.literal('aux.ReadSourceRanges'),purpose:z.literal('read'),operationId:cid,peer:serviceIdentitySchema,lineage:currentLineageSchema,binding:currentBindingSchema,payload:i0BatchPayloadSchema,requestDigest:chash}).strict();
export type I0Command=ReturnType<typeof validateSourceCommand>|z.infer<typeof i0BatchCommandSchema>;
export function i0BatchDigest(input:unknown){const q=i0Parse(i0BatchCommandSchema,input),{requestDigest:_,...semantic}=q;return ownedDigest({domain:'cgp.i0.wire-intent.v2',semantic});}
export function i0ValidateRanges(ranges:I0Range[],byteBudget:number){let total=0;for(const [i,r]of ranges.entries()){
 i0Need(r.ordinal===i&&r.offset+r.length<=r.entry.byteLength,'range_invalid');total+=r.length;
 if(i){const p=ranges[i-1]!,pk=p.kind==='commit'?0:1,rk=r.kind==='commit'?0:1;i0Need(rk>pk||(rk===pk&&(r.index>p.index||(r.index===p.index&&r.offset>=p.offset+p.length))),'range_order_invalid');if(r.kind===p.kind&&r.index===p.index)i0Need(i0Same(r.entry,p.entry),'range_entry_mismatch');}
 }i0Need(total===byteBudget&&total<=4096,'range_budget_invalid');
}
export function i0Command(input:unknown):I0Command{const raw=input as {api?:string};if(raw?.api!=='aux.ReadSourceRanges')return validateSourceCommand(input);
 const q=i0Parse(i0BatchCommandSchema,input);i0ValidateRanges(q.payload.ranges,q.payload.byteBudget);i0Need(q.requestDigest===i0BatchDigest(q),'wire_digest_invalid');return q;
}
export function i0MakeBatch(input:Omit<z.infer<typeof i0BatchCommandSchema>,'requestDigest'>){const q={...input,requestDigest:'0'.repeat(64)};return i0Command({...q,requestDigest:i0BatchDigest(q)}) as z.infer<typeof i0BatchCommandSchema>;}
export const i0Purpose=(q:I0Command)=>q.api==='aux.ReadSourceRanges'?'read':sourcePurpose(q.api);
