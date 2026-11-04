/** Explicit root registration of a shared authority time domain, never discovered from source or wire. */
import {z} from 'zod';
import {ownerPlanFacts,type OwnerPlan} from './gradleOwnedServiceOwners.js';
import {cn,parsed,need} from './gradleOwnedCurrentSchema.js';
export const authorityTimeSchema=z.object({domain:z.literal('same-host-monotonic-v1'),created:cn,lifetimeMs:cn.positive().max(600000)}).strict();
export type AuthorityTime=z.infer<typeof authorityTimeSchema>;
export type AuthorityClock=Readonly<{kind:'registered-authority-clock'}>;
const clocks=new WeakMap<AuthorityClock,{ownerId:string;storageEpoch:string;authorityId:string;now:()=>number;last:number}>();
/** The trusted deployment must establish that the A1 producer uses this exact monotonic origin.
 * This registration is an extra local-profile assumption, not OS evidence or backend approval. */
export function registerAuthorityClock(plan:OwnerPlan,port:{domain:'same-host-monotonic-v1';authorityId:string;now:()=>number}){
 const c=ownerPlanFacts(plan);need(['authority-broker','lineage-registry'].includes(c.role)&&port?.domain==='same-host-monotonic-v1'&&port.authorityId===c.lineage.authorityId&&typeof port.now==='function','authority_clock_unsupported');const clock=Object.freeze({kind:'registered-authority-clock' as const});clocks.set(clock,{ownerId:c.ownerId,storageEpoch:c.storageEpoch,authorityId:c.lineage.authorityId,now:port.now,last:-1});return clock;
}
export function assertAuthorityClock(clock:AuthorityClock,plan:OwnerPlan){const c=ownerPlanFacts(plan),state=clocks.get(clock);need(state&&state.ownerId===c.ownerId&&state.storageEpoch===c.storageEpoch&&state.authorityId===c.lineage.authorityId,'authority_clock_unsupported');}
export function checkAuthorityTime(clock:AuthorityClock,plan:OwnerPlan,value:unknown){assertAuthorityClock(clock,plan);const t=parsed(authorityTimeSchema,value),state=clocks.get(clock)!,now=state.now();need(Number.isSafeInteger(now)&&now>=0&&now>=state.last,'clock_invalid');state.last=now;need(now>=t.created,'authority_clock_unsupported');need(now-t.created<t.lifetimeMs,'authority_expired');return now;}
