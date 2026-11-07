/** I2 planner experiment fork; original I0 behavior remains the baseline. */
/** Simulated authenticated fixture principals; not SessionServer, live authority or source IO. */
import {z} from 'zod';
import {currentBindingSchema,cref,chash,cid,cn,decodeCurrent} from '../../utils/gradleOwnedCurrentSchema.js';
import {currentLineageSchema} from '../../utils/gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema,type ServiceIdentity} from '../../utils/gradleOwnedServiceOwners.js';
import {sourceMetadataSchema,inventoryManifestSchema,type SourceEntry} from '../../utils/gradleOwnedSourceSchema.js';
import {ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {i0Bootstrap,i0Manifest,i0Command,i0Same,i0Need,i0Parse,i0Purpose,type I0ManifestHandle,type I0Command} from './gradleOwnedCgpI0Schema.js';
import {i0Plan} from './gradleOwnedCgpI2PPlanner.js';
const scopeSchema=z.object({binding:currentBindingSchema,lineage:currentLineageSchema,pin:cref('read-pin'),reader:serviceIdentitySchema,server:serviceIdentitySchema}).strict();
const pinSchema=z.object({schema:z.literal('cgp.i0.inventory-pin.v1'),snapshot:cref('snapshot'),metadata:sourceMetadataSchema,ref:z.object({sha256:chash,byteLength:cn.positive().max(65536)}).strict(),inventoryDigest:chash,sourceBytes:cn.positive().max(192*1024),entryCount:cn.positive().max(256)}).strict();
export type I0Session=Readonly<{kind:'cgp-i0-simulated-session'}>;
export type I0Authorized=Readonly<{kind:'cgp-i0-authorized-intent'}>;
export type I0Inventory=Readonly<{kind:'cgp-i0-verified-inventory'}>;
export type I0VerifiedPlan=Readonly<{kind:'cgp-i0-verified-plan'}>;
type Session={owner:CgpI0Authority;peer:ServiceIdentity;deadline:number;clockDomain:string;readId:string;active:boolean};
const sessions=new WeakMap<I0Session,Session>();
export type I0Facts={manifest:I0ManifestHandle;command:I0Command;peer:ServiceIdentity;server:ServiceIdentity;clockDomain:string;sessionDeadline:number;k:string;d:string;readId:string;inventoryDigest:string};
const intents=new WeakMap<I0Authorized,{owner:CgpI0Authority;session:I0Session;facts:I0Facts;dispatch:boolean}>();
const inventories=new WeakMap<I0Inventory,{owner:CgpI0Authority;readId:string;peer:ServiceIdentity;entries:SourceEntry[];snapshot:unknown;digest:string}>();
const plans=new WeakMap<I0VerifiedPlan,{owner:CgpI0Authority;readId:string;peer:ServiceIdentity;commands:ReturnType<typeof i0Plan>['commands']}>();
export class CgpI0Authority {
 readonly manifest:I0ManifestHandle;readonly #scope:z.infer<typeof scopeSchema>;readonly #pin:z.infer<typeof pinSchema>;readonly #principals:ServiceIdentity[];#closed=false;readonly #revoked=new Set<string>();
 constructor(config:{manifest:unknown;pins:unknown;scope:unknown;inventoryPin:unknown;principals:unknown}){
  this.manifest=i0Bootstrap(config.manifest,config.pins);this.#scope=i0Parse(scopeSchema,config.scope);this.#pin=i0Parse(pinSchema,config.inventoryPin);this.#principals=i0Parse(z.array(serviceIdentitySchema).min(1).max(64),config.principals);
  const m=i0Manifest(this.manifest),b=this.#scope.binding;i0Need(this.#pin.entryCount<=m.readPlan.maxEntries&&this.#pin.sourceBytes<=m.readPlan.maxDataBytes&&this.#pin.ref.byteLength<=4096,'workload_out_of_bounds');i0Need(b.mode==='serving'&&this.#scope.reader.role==='reader'&&this.#scope.server.role==='provider','scope_invalid');
  i0Need(new Set(this.#principals.map(p=>p.credentialId)).size===this.#principals.length,'principal_duplicate');
  i0Need(b.profileDigest===m.serviceProfile&&b.policyDigest===m.producerPolicy&&b.providerBoot===this.#scope.server.boot,'scope_mismatch');
  for(const [name,value]of Object.entries(this.#scope.lineage))i0Need((b as any)[name]===value,'lineage_mismatch');
  i0Need(i0Same(this.#pin.snapshot,b.selected.snapshot)&&this.#pin.metadata.approvedBaseDigest===b.selected.head.baseDigest&&this.#pin.metadata.checkpoint.commitDigest===b.selected.head.commitDigest&&this.#pin.metadata.checkpoint.revision===b.selected.head.revision,'inventory_pin_mismatch');
  for(const [name,value]of Object.entries(this.#pin.metadata.binding))i0Need((b as any)[name]===value,'inventory_pin_mismatch');
 }
 open(credentialId:string,clockDomain:string,deadline:number,readId='read-1'){
  i0Parse(cid,clockDomain);i0Parse(cid,readId);i0Parse(cn.positive(),deadline);const peer=this.#principals.find(p=>p.credentialId===credentialId);i0Need(peer,'peer_invalid');
  const handle=Object.freeze({kind:'cgp-i0-simulated-session' as const});sessions.set(handle,{owner:this,peer:structuredClone(peer),clockDomain,deadline,readId,active:true});this.check(handle);return handle;
 }
 check(handle:I0Session){const s=sessions.get(handle);i0Need(s&&s.owner===this&&s.active&&!this.#closed,'session_closed');i0Need(![s.peer,this.#scope.server,this.#scope.reader].some(p=>this.#revoked.has(p.credentialId)),'credential_revoked');return structuredClone({...s,owner:null});}
 closeSession(handle:I0Session){this.check(handle);sessions.get(handle)!.active=false;}
 revoke(credentialId:string){this.#revoked.add(credentialId);}
 close(){this.#closed=true;}
 scope(){return structuredClone(this.#scope);}
 /** A range command dispatches only when it belongs to a plan this authority replanned from verified inventory. */
 authorize(session:I0Session,input:unknown,plan?:I0VerifiedPlan):I0Authorized{return this.#authorize(session,input,plan,true);}
 /** Size estimation for planning; the result cannot begin a guarded attempt or accept a reply. */
 authorizeEstimate(session:I0Session,input:unknown):I0Authorized{return this.#authorize(session,input,undefined,false);}
 sealPlan(session:I0Session,inventory:I0Inventory,transferId:string,plan:unknown,operationBase=transferId):I0VerifiedPlan{
  const verified=i0Plan(this,session,inventory,transferId,operationBase),c=this.check(session);i0Need(i0Same(verified,plan),'plan_mismatch');
  const token=Object.freeze({kind:'cgp-i0-verified-plan' as const});plans.set(token,{owner:this,readId:c.readId,peer:structuredClone(c.peer),commands:verified.commands});return token;
 }
 planCommands(session:I0Session,token:I0VerifiedPlan){return structuredClone(this.#plan(this.check(session),token).commands);}
 #plan(context:{readId:string;peer:ServiceIdentity},token:I0VerifiedPlan){const value=plans.get(token);i0Need(value&&value.owner===this&&value.readId===context.readId&&i0Same(value.peer,context.peer),'plan_handle_invalid');return value;}
 #authorize(session:I0Session,input:unknown,plan:I0VerifiedPlan|undefined,dispatch:boolean):I0Authorized{
  const context=this.check(session),q=i0Command(input),m=i0Manifest(this.manifest),p:any=q.payload,b=this.#scope.binding;i0Need(b.mode==='serving','scope_invalid');
  i0Need(i0Same(q.peer,context.peer)&&i0Same(q.lineage,this.#scope.lineage)&&i0Same(q.binding,b),'binding_mismatch');
  i0Need(['reader','authority-broker','checkpoint-issuer'].includes(context.peer.role),'api_permission_denied');
  i0Need(['aux.ReadSealedSource','aux.ReadSourceDescriptor','aux.ResolveNamespace','aux.ReadSourceRanges'].includes(q.api),'api_permission_denied');
  if(context.peer.role==='checkpoint-issuer')i0Need(q.api==='aux.ResolveNamespace','api_permission_denied');
  if(q.api==='aux.ReadSourceDescriptor')i0Need(context.peer.role==='reader','api_permission_denied');
  if(q.api==='aux.ResolveNamespace')i0Need(context.peer.role!=='reader'&&i0Same(p.target,this.#scope.pin)&&i0Same(p.origin,this.#scope.reader),'delegate_mismatch');
  else {i0Need(i0Same(p.pin,this.#scope.pin)&&i0Same(p.checkpoint,b.selected.checkpoint),'pin_mismatch');if(context.peer.role==='reader')i0Need(p.origin===undefined,'delegate_mismatch');else i0Need(i0Same(p.origin,this.#scope.reader),'delegate_mismatch');}
  i0Need(i0Same(p.snapshot,b.selected.snapshot),'snapshot_mismatch');
  const batch=['B*','AB*'].includes(m.mode);
  if(q.api==='aux.ReadSourceRanges')i0Need(batch,'mode_mismatch');
  if(q.api==='aux.ReadSealedSource'&&p.kind!=='inventory')i0Need(!batch,'mode_mismatch');
  if(q.api==='aux.ReadSourceRanges'&&dispatch){i0Need(plan,'plan_required');i0Need(this.#plan(context,plan).commands.some(c=>c.requestDigest===q.requestDigest),'plan_mismatch');}
  const k=ownedDigest({domain:'osv-mcp.cgp.source-operation.v2',peer:context.peer,destination:this.#scope.server,api:q.api,operationId:q.operationId,lineage:q.lineage});
  const {requestDigest:_,...semantic}=q,d=ownedDigest({domain:'osv-mcp.cgp.source-intent.v2',semantic,purpose:i0Purpose(q),bootstrap:{manifestDigest:ownedDigest(m),guardDigest:m.guardDigest,readPlan:m.readPlan,readId:context.readId}});
  const token=Object.freeze({kind:'cgp-i0-authorized-intent' as const});intents.set(token,{owner:this,session,dispatch,facts:{manifest:this.manifest,command:structuredClone(q),peer:structuredClone(context.peer),server:structuredClone(this.#scope.server),clockDomain:context.clockDomain,sessionDeadline:context.deadline,k,d,readId:context.readId,inventoryDigest:this.#pin.inventoryDigest}});return token;
 }
 verifyInventory(session:I0Session,bytes:Buffer){const c=this.check(session),pin=this.#pin;i0Need(bytes.length===pin.ref.byteLength&&ownedSha256(bytes)===pin.ref.sha256,'inventory_bytes_mismatch');
  const parsed=i0Parse(inventoryManifestSchema,decodeCurrent(bytes,65536));i0Need(parsed.metadataDigest===ownedDigest(pin.metadata),'inventory_metadata_mismatch');
  let commit=0,payload=0,payloadStarted=false,total=0;for(const e of parsed.entries){if(e.kind==='commit'){i0Need(!payloadStarted&&e.index===commit++,'inventory_order_invalid');}else{payloadStarted=true;i0Need(e.index===payload++,'inventory_order_invalid');}total+=e.byteLength;}
  i0Need(commit>0&&payload>=4&&total===pin.sourceBytes&&parsed.entries.length===pin.entryCount&&ownedDigest({domain:'c3b-source-inventory-v1',metadata:pin.metadata,entries:parsed.entries})===pin.inventoryDigest,'inventory_digest_mismatch');
  const token=Object.freeze({kind:'cgp-i0-verified-inventory' as const});inventories.set(token,{owner:this,readId:c.readId,peer:structuredClone(c.peer),entries:structuredClone(parsed.entries),snapshot:structuredClone(pin.snapshot),digest:pin.inventoryDigest});return token;
 }
 inventory(session:I0Session,token:I0Inventory){const c=this.check(session),value=inventories.get(token);i0Need(value&&value.owner===this&&value.readId===c.readId&&i0Same(value.peer,c.peer),'inventory_handle_invalid');return structuredClone({entries:value.entries,snapshot:value.snapshot,digest:value.digest});}
}
// WeakMap manifest handles cannot be structured-cloned; preserve their identity separately.
export function i0Intent(token:I0Authorized):I0Facts{const data=intents.get(token);i0Need(data,'intent_handle_invalid');data.owner.check(data.session);return {...structuredClone({...data.facts,manifest:null}),manifest:data.facts.manifest};}
export function i0DispatchIntent(token:I0Authorized):I0Facts{const facts=i0Intent(token);i0Need(intents.get(token)!.dispatch,'intent_not_dispatchable');return facts;}
