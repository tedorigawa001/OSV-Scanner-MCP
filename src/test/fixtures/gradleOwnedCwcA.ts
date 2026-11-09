/** CWC-A fixture contract only. Scope minting is simulated owner assembly, not live admission.
 * Full reference codecs remain enabled. No composition, crypto shortcut or production registration.
 */
import {z} from 'zod';
import {cn,chash,cid,need,parsed} from '../../utils/gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {context,cprContext,command,checkCommand,makeCommand,validatePlanCore,CPR_SPEC_DIGEST,type CprContext,type CprCommand} from './gradleOwnedCprASchema.js';
import {layout,exact,newStats} from './gradleOwnedCprAWire.js';

export const CWC_FAMILIES=['owner.request','owner.reply','auth.challenge-request','auth.challenge','auth.channel.request','auth.channel.reply'] as const;
export const CWC_DOMAINS=['command.full','wireIntent.preimage','owner.request.unsigned','owner.request.signed','owner.reply.unsigned','owner.reply.signed','auth.challenge-request.request.unsigned','auth.challenge-request.request.signed','auth.challenge.reply.unsigned','auth.challenge.reply.signed','auth.channel.request.unsigned','auth.channel.request.signed','auth.channel.reply.unsigned','auth.channel.reply.signed'] as const;
export const CWC_LIMITS=Object.freeze({templateBytes:81920,bytes:1048576,fragments:4096,commands:19,work:67108864});
const actors=z.enum(['client-initial','client-seal','provider']),domain=z.enum(CWC_DOMAINS);
export const cwcApprovalSchema=z.object({schema:z.literal('cwc.implementation-approval.v1'),codecVariantDigest:chash,sourceClosureDigest:chash,schemaFamily:z.literal('cpr.v3.owner-auth.v1'),canonicalVersion:z.literal('owned-json.v1'),semanticSpecDigest:z.literal(CPR_SPEC_DIGEST),layoutVersion:z.literal('cpr.actual-codec-bound.v1'),actor:actors,limits:z.object({templateBytes:z.literal(81920),bytes:z.literal(1048576),fragments:z.literal(4096),commands:z.literal(19),work:z.literal(67108864)}).strict()}).strict();
export const cwcBudgetSchema=z.object({bytes:cn.max(CWC_LIMITS.bytes),fragments:cn.max(CWC_LIMITS.fragments),work:cn.max(CWC_LIMITS.work)}).strict();
const currentSchema=z.object({context:cprContext,approvalPin:chash}).strict();
const scopeSchema=z.object({actor:actors,scopeId:cid,callId:cid,clockDomain:cid,originalDeadline:cn.positive(),contextFingerprint:chash}).strict();
export type CwcActor=z.infer<typeof actors>;export type CwcBudget=z.infer<typeof cwcBudgetSchema>;
type ScopeInput=z.infer<typeof scopeSchema>;
type Handle=Readonly<{kind:string}>;
type Scope={identity:ScopeInput;budget:CwcBudget;spent:CwcBudget;reserved:CwcBudget;open:boolean;last:number;rootState:'unused'|'opening'|'used';parent?:InitialEvidence;root?:Root};
type Root={scope:Scope;approval:string;state:'opened'|'compiled'|'all-commands-proved'|'disposed';busy:boolean;layout?:Handle;facts:Handle[];children:Set<Handle>;bytes:number;fragments:number;next:number;proved:number;core:ReturnType<typeof validatePlanCore>;initial?:Handle;sealVerified?:InitialEvidence};
type InitialEvidence={valid:boolean;owner:CwcAContract;scope:Scope;digest:string;contextFingerprint:string;clockDomain:string;deadline:number;binding?:boolean;sealScope?:Scope};
const initialEvidence=new WeakMap<Handle,InitialEvidence>();
type Layout={root:Root;sizing:ReturnType<typeof layout>};
type Fact={root:Root;domain:typeof CWC_DOMAINS[number];ordinal:number;requestDigest:string;q:CprCommand;bytes:Buffer;child:boolean};
export type CwcAOptions={context:CprContext;approval:unknown;approvalPin:string;actor:CwcActor;now:()=>number;current:()=>{context:CprContext;approvalPin:string};parentReservation:CwcBudget};
// Reject observable user getters before zod/copy/canonical can evaluate them. Bounded walk, no toJSON.
function plain(value:unknown){let nodes=0,stringBytes=0;const active=new Set<object>();function walk(v:unknown,depth:number){need(++nodes<=4096&&depth<=32,'codec_budget_exceeded');if(v===null||typeof v!=='object'){if(typeof v==='string'){stringBytes+=Buffer.byteLength(v);need(stringBytes<=262144,'codec_budget_exceeded');}need(['string','number','boolean'].includes(typeof v)||v===null,'schema_invalid');return;}need(!active.has(v)&&[Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v)),'schema_invalid');need(Reflect.ownKeys(v).every(k=>typeof k==='string'),'schema_invalid');active.add(v);for(const [k,d]of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&k==='length')continue;need('value'in d&&d.enumerable&&k!=='toJSON','schema_invalid');walk(d.value,depth+1);}active.delete(v);}walk(value,0);}
function copy<T>(value:T):T{plain(value);return structuredClone(value);}
const handle=(kind:string):Handle=>Object.freeze({kind});
// Buffer.from() may slice Node's shared pool, so a caller could reach private bytes through .buffer.
// Buffer.alloc() always owns a dedicated ArrayBuffer; use it for stored facts and for every returned copy.
function ownBytes(text:string){const out=Buffer.alloc(Buffer.byteLength(text));out.write(text,'utf8');return out;}
function ownCopy(bytes:Buffer){const out=Buffer.alloc(bytes.length);bytes.copy(out);return out;}
export function preflightCodecProfile(approval:unknown,expectedPin:string,actor:CwcActor){const a=parsed(cwcApprovalSchema,copy(approval));need(a.actor===parsed(actors,actor)&&hash(a)===parsed(chash,expectedPin),'codec_profile_unsupported');return Object.freeze({approvalDigest:expectedPin,referenceOnly:true as const});}
export class CwcAContract {
 readonly #c:CprContext;readonly #actor:CwcActor;readonly #pin:string;readonly #now:()=>number;readonly #current:CwcAOptions['current'];readonly #parent:CwcBudget;
 readonly #scopes=new WeakMap<Handle,Scope>();readonly #roots=new WeakMap<Handle,Root>();readonly #layouts=new WeakMap<Handle,Layout>();readonly #facts=new WeakMap<Handle,Fact>();readonly #receipts=new WeakMap<Handle,{root:Root;ordinal:number}>();
 readonly #all=new Set<Scope>();readonly #seen=new Set<string>();#closed=false;#reserved:CwcBudget={bytes:0,fragments:0,work:0};#last=0;
 #metrics={roots:0,compiles:0,commands:0,proofs:0,referenceOwners:0,referenceFrames:0,referenceLayouts:0};
 constructor(o:CwcAOptions){
  preflightCodecProfile(o.approval,o.approvalPin,o.actor);this.#actor=parsed(actors,o.actor);this.#pin=parsed(chash,o.approvalPin);this.#c=context(copy(o.context));this.#parent=parsed(cwcBudgetSchema,copy(o.parentReservation));this.#now=o.now;this.#current=o.current;
  this.#checkOwner();
 }
 #checkOwner(){need(!this.#closed,'owner_closed');const current=parsed(currentSchema,copy(this.#current()));need(current.approvalPin===this.#pin,'codec_profile_unsupported');need(hash(context(current.context))===hash(this.#c),'codec_fact_binding_mismatch');const now=this.#now();need(Number.isSafeInteger(now)&&now>=this.#last&&now>=0,'clock_invalid');this.#last=now;need(!this.#closed,'owner_closed');return now;}
 #gate(s:Scope){need(s.open,'codec_fact_binding_mismatch');try{const now=this.#checkOwner();need(s.open,'codec_fact_binding_mismatch');need(now>=s.last,'clock_invalid');s.last=now;need(now<s.identity.originalDeadline,'request_expired');if(s.parent){need(s.parent.valid,'codec_fact_binding_mismatch');s.parent.owner.#gate(s.parent.scope);need(s.open,'codec_fact_binding_mismatch');}}catch(e){this.#invalidate(s);throw e;}}
 #invalidate(s:Scope){s.open=false;if(s.root)this.#dispose(s.root,true);}
 #spend(r:Root,amount:CwcBudget){for(const k of ['bytes','fragments','work'] as const)need(amount[k]+r.scope.spent[k]<=r.scope.budget[k],'codec_budget_exceeded');for(const k of ['bytes','fragments','work'] as const)r.scope.spent[k]+=amount[k];r.bytes+=amount.bytes;r.fragments+=amount.fragments;}
 #root(h:Handle){const r=this.#roots.get(h);need(r&&r.state!=='disposed','codec_fact_binding_mismatch');need(!r.busy,'codec_fact_binding_mismatch');return r;}
 #run<T>(r:Root,fn:()=>T){need(!r.busy,'codec_fact_binding_mismatch');r.busy=true;try{this.#gate(r.scope);const value=fn();this.#gate(r.scope);return value;}catch(e){this.#dispose(r,true);throw e;}finally{r.busy=false;}}
 /** Trusted fixture owner assembly only. No claim of real AuthenticatedSessionCall / verified SourceSnapshot. */
 openScope(identity:unknown,budget:unknown,parentRead?:Handle){need(this.#all.size<512,'codec_budget_exceeded');const id=parsed(scopeSchema,copy(identity)),b=parsed(cwcBudgetSchema,copy(budget)),now=this.#checkOwner();need(id.actor===this.#actor&&id.contextFingerprint===hash(this.#c),'codec_fact_binding_mismatch');need(id.originalDeadline>now&&id.originalDeadline<=now+4500,'request_expired');
  const parent=parentRead===undefined?undefined:initialEvidence.get(parentRead);if(parentRead!==undefined){need(parent&&parent.valid&&id.actor==='client-seal'&&!parent.binding&&!parent.sealScope&&parent.contextFingerprint===id.contextFingerprint&&parent.clockDomain===id.clockDomain&&parent.deadline===id.originalDeadline,'codec_fact_binding_mismatch');parent.binding=true;parent.owner.#gate(parent.scope);}
  need(!this.#seen.has('scope:'+id.scopeId)&&!this.#seen.has('call:'+id.callId),'codec_fact_binding_mismatch');for(const k of ['bytes','fragments','work'] as const)need(this.#reserved[k]+b[k]<=this.#parent[k],'codec_budget_exceeded');
  this.#seen.add('scope:'+id.scopeId);this.#seen.add('call:'+id.callId);const s:Scope={identity:id,budget:b,spent:{bytes:0,fragments:0,work:0},reserved:{...b},open:true,last:now,rootState:'unused',parent};if(parent)parent.sealScope=s;for(const k of ['bytes','fragments','work'] as const)this.#reserved[k]+=b[k];const h=handle('cwc-a-simulated-scope');this.#scopes.set(h,s);this.#all.add(s);return h;
 }
 openCodecRoot(scope:Handle,input:unknown){const s=this.#scopes.get(scope);need(s,'codec_fact_binding_mismatch');if(s.rootState==='opening'){this.#invalidate(s);need(false,'codec_fact_binding_mismatch');}need(s.rootState==='unused'&&!s.root,'codec_fact_binding_mismatch');s.rootState='opening';try{this.#gate(s);
  // Reserve upper bounds before parsing/copying the complete plan. Failed preparation consumes work.
  const r:Root={scope:s,approval:this.#pin,state:'opened',busy:false,facts:[],children:new Set(),bytes:0,fragments:0,next:0,proved:0,core:undefined!};s.root=r;s.rootState='used';
  const h=handle('cwc-root');this.#roots.set(h,r);this.#metrics.roots++;
  return this.#run(r,()=>{this.#spend(r,{bytes:262144,fragments:64,work:156978});r.core=validatePlanCore(copy(input));const p=r.core;need(p.peer.role===this.#c.peer.role&&p.inventoryDigest===this.#c.inventoryDigest,'codec_fact_binding_mismatch');
   // Context fields not present in planCore remain in the root fingerprint, never supplied by commands.
   const {domain:_,specDigest:__,seed:___,transferId:____,groups:_____,...fields}=p;
   need(Object.entries(fields).every(([k,v])=>canonical(v)===canonical((this.#c as any)[k])),'codec_fact_binding_mismatch');return h;});}catch(e){s.rootState='used';this.#invalidate(s);throw e;}
 }
 compilePlanLayout(root:Handle){const r=this.#root(root);return this.#run(r,()=>{need(r.state==='opened','codec_fact_binding_mismatch');this.#spend(r,{bytes:81920,fragments:6,work:81920});const stats=newStats(),sizing=layout(this.#c,r.core.seed,r.core.transferId,stats);const template=sizing.bound([]);need(template.fits&&template.total<=CWC_LIMITS.templateBytes,'codec_budget_exceeded');this.#metrics.referenceOwners+=stats.layoutOwners;this.#metrics.referenceFrames+=stats.layoutFrames;this.#metrics.referenceLayouts++;this.#metrics.compiles++;const h=handle('cwc-layout');this.#layouts.set(h,{root:r,sizing});r.layout=h;r.state='compiled';return h;});}
 encodeCheckedCommand(root:Handle,layoutHandle:Handle,input:unknown,domainInput:unknown='command.full'){
  const r=this.#root(root);return this.#run(r,()=>{need(r.state==='compiled'&&this.#layouts.get(layoutHandle)?.root===r&&r.layout===layoutHandle,'codec_fact_binding_mismatch');need(parsed(domain,domainInput)==='command.full','codec_fact_binding_mismatch');need(r.next<r.core.groups.length,'codec_fact_binding_mismatch');this.#spend(r,{bytes:8192,fragments:16,work:24576});
   const q=command(copy(input));checkCommand(this.#c,q);const expected=makeCommand(this.#c,r.core.seed,r.core.transferId,r.next,r.core.groups.length,hash(r.core),r.core.groups[r.next]!);need(canonical(q)===canonical(expected),'codec_fact_binding_mismatch');const bytes=ownBytes(canonical(q,8192)),h=handle('cwc-command-fact');this.#facts.set(h,{root:r,domain:'command.full',ordinal:r.next,requestDigest:q.requestDigest,q,bytes,child:false});r.facts.push(h);r.next++;this.#metrics.commands++;return h;});
 }
 provePlannedOwnerAndAuth(root:Handle,layoutHandle:Handle,fact:Handle){const r=this.#root(root);return this.#run(r,()=>{const l=this.#layouts.get(layoutHandle),f=this.#facts.get(fact);need(r.state==='compiled'&&l?.root===r&&r.layout===layoutHandle&&f?.root===r&&f.ordinal===r.proved&&f.domain==='command.full','codec_fact_binding_mismatch');
   // A is a reference-backed contract receipt, NOT the closed-family composition proof required by B/C.
   this.#spend(r,{bytes:24576,fragments:8,work:32768});const stats=newStats();stats.phase='final';const a=exact(this.#c,f.q,stats),b=l.sizing.bound(f.q.payload.ranges);need(b.fits&&a.request<=b.request&&a.reply<=b.reply&&a.frames.every((n,i)=>n<=b.frames[i]!),'codec_layout_mismatch');this.#metrics.referenceOwners+=stats.finalOwners;this.#metrics.referenceFrames+=stats.finalFrames;this.#metrics.proofs++;r.proved++;if(r.proved===r.core.groups.length&&r.next===r.proved)r.state='all-commands-proved';const h=handle('cwc-reference-only-receipt');this.#receipts.set(h,{root:r,ordinal:f.ordinal});return h;});}
 inspectReferenceReceipt(root:Handle,receipt:Handle){const r=this.#root(root);return this.#run(r,()=>{const p=this.#receipts.get(receipt);need(p?.root===r&&p.ordinal<r.proved,'codec_fact_binding_mismatch');return Object.freeze({referenceOnly:true,compositionProven:false,authorityGranted:false,ordinal:p.ordinal});});}
 readCommandFact(root:Handle,fact:Handle,domainInput:unknown='command.full'){const r=this.#root(root);return this.#run(r,()=>{const f=this.#facts.get(fact);need(f?.root===r&&f.domain===parsed(domain,domainInput),'codec_fact_binding_mismatch');this.#spend(r,{bytes:8192,fragments:1,work:8192});return ownCopy(f.bytes);});}
 registerInitialPlan(root:Handle){const r=this.#root(root);return this.#run(r,()=>{need(r.scope.identity.actor==='client-initial'&&r.state==='all-commands-proved'&&!r.initial,'codec_fact_binding_mismatch');this.#spend(r,{bytes:8192,fragments:1,work:8192});const h=handle('cwc-initial-plan-evidence');initialEvidence.set(h,{valid:true,owner:this,scope:r.scope,digest:hash(r.core),contextFingerprint:hash(this.#c),clockDomain:r.scope.identity.clockDomain,deadline:r.scope.identity.originalDeadline});r.initial=h;return h;});}
 verifyClientSeal(root:Handle,evidence:Handle){const r=this.#root(root);return this.#run(r,()=>{const initial=initialEvidence.get(evidence);need(r.scope.identity.actor==='client-seal'&&r.state==='all-commands-proved'&&initial&&r.scope.parent===initial&&initial.sealScope===r.scope&&!r.sealVerified,'codec_fact_binding_mismatch');this.#spend(r,{bytes:8192,fragments:1,work:8192});need(hash(r.core)===initial.digest,'codec_fact_binding_mismatch');r.sealVerified=initial;});}

 retainClientCommandFact(root:Handle,fact:Handle){const r=this.#root(root);return this.#run(r,()=>{const f=this.#facts.get(fact);need(r.scope.identity.actor==='client-seal'&&r.state==='all-commands-proved'&&r.sealVerified&&r.sealVerified===r.scope.parent&&f?.root===r&&!f.child,'codec_fact_binding_mismatch');f.child=true;r.children.add(fact);return fact;});}
 readClientCommandFact(scope:Handle,fact:Handle,ordinal:number,domainInput:unknown='command.full'){const s=this.#scopes.get(scope),f=this.#facts.get(fact);need(s&&f&&f.root.scope===s&&f.child&&f.root.children.has(fact),'codec_fact_binding_mismatch');return this.#run(f.root,()=>{need(f.ordinal===ordinal&&f.domain===parsed(domain,domainInput),'codec_fact_binding_mismatch');this.#spend(f.root,{bytes:8192,fragments:1,work:8192});return ownCopy(f.bytes);});}
 #dispose(r:Root,all:boolean){if(all&&r.initial){const initial=initialEvidence.get(r.initial);if(initial)initial.valid=false;}r.state='disposed';if(r.layout)this.#layouts.delete(r.layout);for(const h of r.facts){const f=this.#facts.get(h);if(all||!f?.child){if(f)f.bytes.fill(0);this.#facts.delete(h);r.children.delete(h);}}if(all)r.children.clear();r.facts=r.facts.filter(h=>r.children.has(h));r.core=undefined!;}
 disposeCodecRoot(root:Handle){const r=this.#roots.get(root);need(r,'codec_fact_binding_mismatch');this.#dispose(r,false);}
 closeScope(scope:Handle){const s=this.#scopes.get(scope);need(s,'codec_fact_binding_mismatch');this.#invalidate(s);}
 close(){this.#closed=true;for(const s of this.#all)this.#invalidate(s);}
 diagnostics(scope:Handle){const s=this.#scopes.get(scope);need(s,'codec_fact_binding_mismatch');return structuredClone({identity:s.identity,spent:s.spent,reserved:s.reserved,open:s.open,state:s.root?.state??'unopened',children:s.root?.children.size??0});}
 get metrics(){return structuredClone(this.#metrics);}
}
