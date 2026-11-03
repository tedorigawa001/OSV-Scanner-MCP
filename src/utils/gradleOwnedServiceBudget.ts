/** C3b-0 conservative full-read planning; no time measurement, quota reservation or IO. */
import {z} from 'zod';
import {cn,parsed,need,CURRENT_LIMITS} from './gradleOwnedCurrentSchema.js';
import {readBudgetSchema,validateReadBudget,readBudgetPhases,admitReadClosure} from './gradleOwnedCurrentAuxiliary.js';
export const budgetActors=['reader','provider','checkpoint-issuer','authority-broker','lineage-registry'] as const;
const counts=z.object(Object.fromEntries(budgetActors.map(r=>[r,cn.max(256)])) as Record<typeof budgetActors[number],typeof cn>).strict();
export const serviceReadBudgetSchema=readBudgetSchema.extend({schema:z.literal('osv-mcp.q2.c3b.read-budget.v2'),algorithm:z.literal('selected-source-read-v1'),chunkBytes:z.literal(4096),sessionRecoveries:z.literal(1),
 handshakeChannels:z.literal(10),handshakeFrames:z.literal(4),framesPerBusinessRequest:z.literal(4),signatureChecksPerFrame:z.literal(2),frameBytes:z.literal(16384),storageStages:z.literal(9),
 minSignatureChecksPerSecond:cn.positive(),minStorageStagesPerSecond:cn.positive(),recoveryHandshakeMs:cn.positive().max(5000)}).strict();
export type ServiceReadBudget=z.infer<typeof serviceReadBudgetSchema>;
const ceil=(a:bigint,b:bigint)=>(a+b-1n)/b;
// A read verifies only the selected source. Per chunk: the reader's ReadSealedSource, the provider's live
// re-check before answering the reader and the broker, the issuer's witness read and the broker's source read.
const fixedRequests={'reader':5,'provider':2,'checkpoint-issuer':2,'authority-broker':5,'lineage-registry':10} as const;
const chunkRequests={'reader':1,'provider':2,'checkpoint-issuer':1,'authority-broker':1,'lineage-registry':0} as const;
export function serviceReadCosts(closureBytes:number){
 need(Number.isSafeInteger(closureBytes)&&closureBytes>0&&closureBytes<=CURRENT_LIMITS.closure,'budget_exceeded');const chunks=Math.ceil(closureBytes/4096);
 const requests=Object.fromEntries(budgetActors.map(r=>[r,fixedRequests[r]+chunkRequests[r]*chunks])) as Record<typeof budgetActors[number],number>;
 const reservedRequests=Object.fromEntries(budgetActors.map(r=>[r,requests[r]+1])) as Record<typeof budgetActors[number],number>;
 // Reserve initial and recovery handshakes for every one of the ten directed service edges, although only one recovery is allowed.
 const frames=Object.values(reservedRequests).reduce((n,v)=>n+v,0)*4+10*2*4;
 return {chunks,requests:reservedRequests,frames,signatureChecks:frames*2,wireBytes:frames*16384,verificationBytes:closureBytes*10,storageStages:9};
}
/** Largest closure whose per-actor request plan, including the one reserved retry, stays within the C0 request limit. */
export function serviceReadClosureLimit(){const chunks=Math.min(...budgetActors.filter(r=>chunkRequests[r]>0).map(r=>Math.floor((CURRENT_LIMITS.requests-1-fixedRequests[r])/chunkRequests[r])));return Math.min(chunks*4096,CURRENT_LIMITS.closure);}
function base(b:ServiceReadBudget){const {algorithm,chunkBytes,sessionRecoveries,handshakeChannels,handshakeFrames,framesPerBusinessRequest,signatureChecksPerFrame,frameBytes,storageStages,minSignatureChecksPerSecond,minStorageStagesPerSecond,recoveryHandshakeMs,...v1}=b;return {...v1,schema:'osv-mcp.q2.c3a.read-budget.v1'};}
export function validateServiceReadBudget(value:unknown){
 const b=parsed(serviceReadBudgetSchema,value);validateReadBudget(base(b));const costs=serviceReadCosts(b.closureBytes);need(Object.values(costs.requests).every(v=>v<=CURRENT_LIMITS.requests),'budget_exceeded');
 const transferMs=ceil(BigInt(costs.wireBytes)*1000n,BigInt(b.minTransferBytesPerSecond));
 const verifyMs=ceil(BigInt(costs.verificationBytes)*1000n,BigInt(b.minVerifyBytesPerSecond))+ceil(BigInt(costs.signatureChecks)*1000n,BigInt(b.minSignatureChecksPerSecond));
 const storageMs=ceil(BigInt(costs.storageStages)*1000n,BigInt(b.minStorageStagesPerSecond));
 need(transferMs<=BigInt(b.phases.transfer)&&verifyMs<=BigInt(b.phases.verify)&&storageMs<=BigInt(b.phases.pin+b.phases.checkpoint+b.phases.handoff+b.phases.delivery+b.phases.use+b.phases.ack),'budget_exceeded');
 need(readBudgetPhases.reduce((n,k)=>n+BigInt(b.phases[k]),0n)+BigInt(b.marginMs)+BigInt(b.recoveryHandshakeMs)<=BigInt(b.leaseMs),'budget_exceeded');return b;
}
export const serviceReadAdmissionSchema=z.object({closureBytes:cn.positive().max(CURRENT_LIMITS.closure),bootRemaining:counts,sessionRemaining:counts,framesRemaining:cn,storageStagesRemaining:cn,remainingMs:cn.max(5000),recoveriesRemaining:z.literal(1)}).strict();
export function admitServiceRead(value:unknown,request:unknown){const b=validateServiceReadBudget(value),r=parsed(serviceReadAdmissionSchema,request);admitReadClosure(validateReadBudget(base(b)),r.closureBytes);const cost=serviceReadCosts(r.closureBytes);
 need(budgetActors.every(role=>cost.requests[role]<=r.bootRemaining[role]&&cost.requests[role]<=r.sessionRemaining[role])&&cost.frames<=r.framesRemaining&&cost.storageStages<=r.storageStagesRemaining,'capacity_exhausted');
 need(readBudgetPhases.reduce((n,k)=>n+BigInt(b.phases[k]),0n)+BigInt(b.marginMs)+BigInt(b.recoveryHandshakeMs)<=BigInt(r.remainingMs),'budget_exceeded');
 return {...cost,scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};
}
