/** VF-0 only. The trusted state owner is explicit; opaque callbacks cannot supply revision evidence. */
import {credentialSchema} from './gradleOwnedCprBOwners.js';
import {copyData,freezeData} from './gradleOwnedCwcLb0Contract.js';
import {need,parsed,chash,cn} from '../../utils/gradleOwnedCurrentSchema.js';
import {z} from 'zod';
export const VF_AUTH_DOMAINS=['peer-credential','server-credential','key-epoch','permissions','purpose','registry-pin','source-pin','profile-pin','callback-policy'] as const;
type Domain=typeof VF_AUTH_DOMAINS[number];
const changeSchema=z.discriminatedUnion('domain',[
 z.object({domain:z.enum(['peer-credential','server-credential']),value:z.boolean()}).strict(),
 z.object({domain:z.literal('key-epoch'),subject:z.enum(['peer','server']),value:cn.positive()}).strict(),
 z.object({domain:z.literal('permissions'),value:credentialSchema.shape.permissions}).strict(),
 z.object({domain:z.literal('purpose'),value:z.enum(['read','publication'])}).strict(),
 z.object({domain:z.enum(['registry-pin','source-pin','profile-pin']),value:chash}).strict(),
 z.object({domain:z.literal('callback-policy'),value:cn}).strict()
]);
const viewSchema=z.object({peer:z.boolean(),server:z.boolean(),peerKeyEpoch:cn.positive(),serverKeyEpoch:cn.positive(),permissions:credentialSchema.shape.permissions,purpose:z.enum(['read','publication']),registryPin:chash,sourcePin:chash,profilePin:chash,callbackPolicy:cn}).strict();
type View=z.infer<typeof viewSchema>;
type Cell={epoch:number;revision:number;revocation:number;view:View;reason:string};
const cells=new WeakMap<object,Cell>();
export type VfAuthorityStamp=Readonly<{epoch:number;revision:number;revocation:number}>;
export class Vf0Authority {
 constructor(input:unknown){const view=freezeData(parsed(viewSchema,copyData(input,32768)));cells.set(this,{epoch:1,revision:0,revocation:0,view,reason:'permission_denied'});Object.freeze(this);}
 change(input:unknown){const x=parsed(changeSchema,copyData(input,32768)),c=cell(this);need(c.revision<Number.MAX_SAFE_INTEGER&&c.revocation<Number.MAX_SAFE_INTEGER,'owner_closed');
  const view={...c.view};if(x.domain==='peer-credential')view.peer=x.value;else if(x.domain==='server-credential')view.server=x.value;else if(x.domain==='key-epoch')view[x.subject==='peer'?'peerKeyEpoch':'serverKeyEpoch']=x.value;else if(x.domain==='permissions')view.permissions=x.value;else if(x.domain==='purpose')view.purpose=x.value;else if(x.domain==='registry-pin')view.registryPin=x.value;else if(x.domain==='source-pin')view.sourcePin=x.value;else if(x.domain==='profile-pin')view.profilePin=x.value;else if(x.domain==='callback-policy')view.callbackPolicy=x.value;
  // No callback or await between revision advancement and the immutable view replacement.
  c.revision++;c.revocation++;c.reason=x.domain.endsWith('-pin')?'codec_profile_unsupported':x.domain==='callback-policy'?'policy_changed':'permission_denied';c.view=freezeData(view);
 }
 restart(){const c=cell(this);need(c.epoch<Number.MAX_SAFE_INTEGER,'owner_closed');c.epoch++;c.revision++;c.revocation++;c.reason='owner_closed';}
 snapshot(){const c=cell(this);return {...stampAuthority(this),view:copyData(c.view,32768)};}
}
function cell(owner:Vf0Authority){const c=cells.get(owner);need(c,'codec_profile_unsupported');return c;}
/** Fixed private-data accessors; no caller-supplied getters or callbacks. Never exported to a peer. */
export function stampAuthority(owner:Vf0Authority):VfAuthorityStamp {const c=cell(owner);return {epoch:c.epoch,revision:c.revision,revocation:c.revocation};}
export function assertAuthority(owner:Vf0Authority){cell(owner);}
export function authorityReason(owner:Vf0Authority){return cell(owner).reason;}
export function authorityView(owner:Vf0Authority){return cell(owner).view;}
export function sameAuthorityStamp(a:VfAuthorityStamp,b:VfAuthorityStamp){return a.epoch===b.epoch&&a.revision===b.revision&&a.revocation===b.revocation;}
// A diagnostic owned clock, not a wall-clock performance experiment or an arbitrary clock callback.
const clocks=new WeakMap<object,{now:number}>();
export class Vf0Clock {constructor(){clocks.set(this,{now:0});Object.freeze(this);}advance(to:number){const c=clocks.get(this)!;need(Number.isSafeInteger(to)&&to>=c.now,'clock_invalid');c.now=to;}}
export function readOwnedClock(clock:Vf0Clock){const c=clocks.get(clock);need(c,'codec_profile_unsupported');return c.now;}
export type VfAuthDomain=Domain;
