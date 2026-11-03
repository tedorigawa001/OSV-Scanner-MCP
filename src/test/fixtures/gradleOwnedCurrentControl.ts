/** C0 cooperative memory contract. No filesystem, OS peers, independent Anchor or adoption. */
import {generateKeyPairSync,randomBytes,sign,verify,type KeyObject} from 'node:crypto';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {durableRecordSchema,durableRegistrySchema,durableIssuerSchema,durableAnchorSchema,type CurrentPersistence,type DurableRegistry,type DurableIssuer,type DurableAnchor} from './gradleOwnedCurrentPersistence.js';
import {replayV2,type V2ReplayInput} from './gradleOwnedJournalV2.js';
import {CURRENT_LIMITS as L,CurrentControlError,need,parsed,cid,chash,cn,currentRefSchema,currentBindingSchema,currentHeadSchema,wireSchema,replySchema,responseValues,
 validateRequest,semanticDigest,operationKey,decodeCurrent,apiPolicy,currentRoles,registryAPIs,type CurrentRole,type CurrentAPI,type CurrentRequest,type CurrentRef,type CurrentBinding,type CurrentHead,type Destination} from './gradleOwnedCurrentSchema.js';
export type CurrentActor=Readonly<{kind:'c0-actor'}>;
type Ref=CurrentRef;
type Actor={id:string;role:CurrentRole;peerId:string;boot:string;epoch:number;uid:number;gid:number;client:{publicKey:KeyObject;privateKey:KeyObject};permissions:Set<string>;managedTargets:Set<string>;sequence:number;requests:number;alive:boolean};
type ObjectRecord={ref:Ref;raw:Buffer;body:any;role:CurrentRole};
type Lease={ref:Ref;owner:string;expires:number;selectionRevision:number;revocationEpoch:number;incarnation:string;providerBoot:string;issuerBoot:string;phase:string;operationId:string};
type Pin=Lease&{createdControlRevision:number;operationBinding:string;checkpoint:Ref;snapshot:Ref;broker:string|null;useId:string|null;gate:Ref|null;delivery:Ref|null;hold:boolean;effect:boolean};
type Ledger={digest:string;api:CurrentAPI;owner:string;status:'pending'|'committed';applied:number;result:Ref;started:number;localStarted:number;binding:CurrentBinding};
type Barrier={ref:Ref;reason:string;participants:string[];boots:Record<string,string>;confirmed:string[];resume:boolean;completed:boolean};
type State={phase:'uninitialized'|'provisioning'|'serving'|'draining'|'frozen'|'retired';selectionRevision:number;revocationEpoch:number;writerFence:number;incarnation:string;
 selected:{snapshot:Ref;checkpoint:Ref;head:CurrentHead}|null;provision:Lease|null;writer:Lease|null;pins:Record<string,Pin>;barrier:Barrier|null;operations:Record<string,Ledger>};
type Source={ref:Ref;input:V2ReplayInput;head:CurrentHead;inventory:string};
type Prepared={ref:Ref;snapshot:Ref;head:CurrentHead;fence:Ref;previous:Ref|null;mode:'genesis'|'advance'};
type RecordEntry={ref:Ref;raw:Buffer;synced:boolean};
type Pending={actor:string;challenge:string;sequence:number;intent:string;started:number;localStarted:number;used:boolean;accepted:boolean};
type IssuerEntry=Ledger&{fence:Ref};
type FaultPoint='issuer-before-verify'|'issuer-before-sync'|'issuer-after-sync'|'issuer-before-reply'|'source-before-reply'|'registry-before-record'|'registry-after-record'|'registry-after-sync'|'anchor-before-cas'|'anchor-after-cas'|'registry-before-reply'|'handoff-completing'|'recovery-before-ready';
type Fault='fail'|'lose-response';
export interface CurrentConfig{now:()=>number;readerNow?:()=>number;approvedBase:string;identity?:Partial<Pick<CurrentBinding,'authorityId'|'lineageId'|'rootPairId'|'storeRootId'|'checkpointRootId'|'storageInstanceId'|'profileDigest'|'policyDigest'|'parserDigest'|'schemaDigest'|'storeEpoch'|'generation'>>;
 business?:{operationBinding:string;manifestDigest:string;coreGraphDigest:string;sessionId:string;scopeId:string};
 persistence?:CurrentPersistence;serverKeys?:Partial<Record<CurrentRole,{publicKey:KeyObject;privateKey:KeyObject}>>;
 limits?:Partial<Record<'pins'|'operations'|'prepares'|'records'|'objects'|'closure'|'pending'|'peerPending'|'requests',number>>;supported?:boolean;approved?:boolean;}
const nonce=()=>randomBytes(32).toString('hex'),same=(a:unknown,b:unknown)=>canonicalOwnedJson(a,L.closure)===canonicalOwnedJson(b,L.closure),clone=<T>(v:T):T=>JSON.parse(canonicalOwnedJson(v,L.closure));
const roleUID:Record<CurrentRole,number>={operator:0,manager:0,writer:1104,provider:1101,'checkpoint-issuer':1105,'lineage-registry':1106,'control-anchor':1107,'authority-broker':1108,reader:1102};
const destRole:Record<Destination,CurrentRole>={registry:'lineage-registry',issuer:'checkpoint-issuer',provider:'provider',anchor:'control-anchor'};
const flags=Object.freeze({independentRegistryVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});
export class CurrentControl{
 readonly #config:CurrentConfig;readonly #limits:{-readonly [K in keyof typeof L]:number};readonly #identity:any;readonly #business:NonNullable<CurrentConfig['business']>;
 readonly #actors=new WeakMap<CurrentActor,Actor>();readonly #byId=new Map<string,Actor>();readonly #servers=new Map<CurrentRole,{publicKey:KeyObject;privateKey:KeyObject}>();
 #objects=new Map<string,ObjectRecord>();#sources=new Map<string,Source>();#prepares=new Map<string,Prepared>();#issuerOps=new Map<string,IssuerEntry>();#pending=new Map<string,Pending>();
 #issuerReservations=new Map<string,{prepare:boolean;operation:boolean}>();
 #records=new Map<string,RecordEntry>();#anchor:{revision:number;ref:Ref|null}={revision:0,ref:null};#attempts=new Map<string,{digest:string;record:Ref}>();
 #state:State={phase:'uninitialized',selectionRevision:0,revocationEpoch:0,writerFence:0,incarnation:nonce(),selected:null,provision:null,writer:null,pins:{},barrier:null,operations:{}};
 #persistentDispatching=false;
 #revision=0;#busy=false;#blocked=false;#issuerBlocked=false;#registryAvailable=true;#issuerAvailable=true;#anchorAvailable=true;#sourceBytes=0;#objectBytes=0;#recordBytes=0;#lastNow=0;#lastReader=0;
 #inFlight=new Map<string,string>();#busySubjects=new Map<string,number>();#effects=new Set<string>();
 #faults=new Map<FaultPoint,Fault>();#pauses=new Map<FaultPoint,{reached:()=>void;promise:Promise<void>}>();
 #metrics={ownedSourceReads:0,ownedSourceBytes:0,fullReplays:0,checkpointSyncSteps:0,registrySyncSteps:0,anchorCAS:0,resolutions:0,commits:0};
 #completedAPIs=new Set<CurrentAPI>();
 constructor(config:CurrentConfig){
  chash.parse(config.approvedBase);this.#config={...config,identity:clone(config.identity??{})};this.#limits={...L};
  for(const [k,v]of Object.entries(config.limits??{})){need(Object.hasOwn(L,k)&&Number.isSafeInteger(v)&&v>0&&v<=L[k as keyof typeof L],'configuration_invalid');this.#limits[k as keyof typeof L]=v;}
  this.#identity={authorityId:'authority',lineageId:'lineage',rootPairId:'pair',storeRootId:'store',checkpointRootId:'checkpoint',storageInstanceId:'storage',generation:1,
   storeEpoch:ownedSha256('epoch'),profileDigest:ownedSha256('profile'),policyDigest:ownedSha256('policy'),parserDigest:ownedSha256('parser'),schemaDigest:ownedSha256('schema'),...config.identity};
  this.#business=clone(config.business??{operationBinding:ownedSha256('business'),manifestDigest:ownedSha256('fixture-manifest'),coreGraphDigest:ownedSha256('fixture-core'),sessionId:'session',scopeId:'scope'});
  for(const role of currentRoles)this.#servers.set(role,config.serverKeys?.[role]??generateKeyPairSync('ed25519'));
  this.binding();
 }
 /** Root harness provisioning only, never an IPC enrollment API or observed OS identity. */
 actor(role:CurrentRole,options:{id?:string;permissions?:string[];uid?:number;gid?:number;managedTargets?:string[]}={}):CurrentActor{
  need(currentRoles.includes(role)&&this.#byId.size<32,'configuration_invalid');const id=options.id??role;parsed(cid,id);need(!this.#byId.has(id),'peer_exists');
  const permissions=Object.entries(apiPolicy).filter(([,p])=>p.roles.includes(role)).map(([,p])=>p.permission);if(role==='manager')permissions.push('barrier.confirm-managed');
  if(options.permissions){const known=new Set([...Object.values(apiPolicy).map(p=>p.permission),'barrier.confirm-managed']);need(options.permissions.every(p=>known.has(p))&&new Set(options.permissions).size===options.permissions.length,'configuration_invalid');}
  const a:Actor={id,role,peerId:id,boot:nonce(),epoch:1,uid:options.uid??roleUID[role],gid:options.gid??(roleUID[role]===0?0:roleUID[role]+100),client:generateKeyPairSync('ed25519'),permissions:new Set(options.permissions??permissions),managedTargets:new Set(options.managedTargets??['provider','checkpoint-issuer','authority-broker','reader','writer','lineage-registry','control-anchor']),sequence:0,requests:0,alive:true};
  const handle=Object.freeze({kind:'c0-actor' as const});this.#actors.set(handle,a);this.#byId.set(id,a);return handle;
 }
 #actor(h:CurrentActor){const a=this.#actors.get(h);need(a,'peer_mismatch');return a;}
 #operator(h:CurrentActor){const a=this.#actor(h);need(a.role==='operator','permission_denied');return a;}
 #now(){const n=this.#config.now();need(Number.isSafeInteger(n)&&n>=this.#lastNow,'clock_invalid');this.#lastNow=n;return n;}
 #readerNow(){const n=(this.#config.readerNow??this.#config.now)();need(Number.isSafeInteger(n)&&n>=this.#lastReader,'clock_invalid');this.#lastReader=n;return n;}
 binding():CurrentBinding{return parsed(currentBindingSchema,{...this.#identity,format:'v2',providerBoot:this.#roleActor('provider')?.boot??ownedSha256('provider-not-provisioned'),
  namespaceGeneration:this.#state.selected?.head.revision??0,writerFence:this.#state.writerFence,registryIncarnation:this.#state.incarnation,selectionRevision:this.#state.selectionRevision,revocationEpoch:this.#state.revocationEpoch,
  checkpointIssuer:'checkpoint-issuer',checkpointKeyEpoch:1,enrollmentDigest:ownedDigest(this.#identity),mode:this.#state.selected?'serving':'provision',selected:clone(this.#state.selected)});}
 #roleActor(role:CurrentRole){return [...this.#byId.values()].find(a=>a.role===role);}
 #rawEnvelope(body:unknown,role:CurrentRole,keyId:string,key:KeyObject,direction:'request'|'reply'){
  const unsigned={schema:'osv-mcp.q2.current-control.envelope.v1',role,keyId,keyEpoch:1,direction,body};return Buffer.from(canonicalOwnedJson({...unsigned,signature:sign(null,Buffer.from(canonicalOwnedJson(unsigned,L.record)),key).toString('base64')},direction==='request'?L.frame:L.record));
 }
 #signed(role:CurrentRole,body:unknown){return this.#rawEnvelope(body,role,'server-'+role,this.#servers.get(role)!.privateKey,'reply');}
 #verifyEnvelope(raw:Buffer,role:CurrentRole,key:KeyObject,keyId:string,direction:'request'|'reply',max:number=L.record):any{
  const e=parsed(wireSchema,decodeCurrent(raw,max));need(e.role===role&&e.direction===direction&&e.keyId===keyId&&e.keyEpoch===1,'peer_mismatch');const {signature,...unsigned}=e;
  const signatureBytes=Buffer.from(signature,'base64');need(signatureBytes.length===64&&signatureBytes.toString('base64')===signature&&verify(null,Buffer.from(canonicalOwnedJson(unsigned,L.record)),key,signatureBytes),'signature_invalid');return e.body;
 }
 #put(role:Ref['role'],body:unknown,issuer:CurrentRole):Ref{
  const raw=this.#signed(issuer,{schema:'osv-mcp.q2.c0.object.v1',objectRole:role,body}),digest=ownedSha256(raw),ref:Ref={role,id:digest,sha256:digest,byteLength:raw.length};
  if(!this.#objects.has(digest)){need(this.#objects.size<this.#limits.objects&&this.#bytes()+raw.length<=this.#limits.closure,'capacity_exhausted');this.#objects.set(digest,{ref,raw:Buffer.from(raw),body:clone(body),role:issuer});this.#objectBytes+=raw.length;}return clone(ref);
 }
 #get(ref:Ref,role:Ref['role']):any{
  parsed(currentRefSchema,ref);need(ref.role===role,'binding_mismatch');const o=this.#objects.get(ref.id);need(o&&same(ref,o.ref),'receipt_invalid');
  need(ownedSha256(o.raw)===ref.sha256&&o.raw.length===ref.byteLength,'integrity_invalid');const b=this.#verifyEnvelope(o.raw,o.role,this.#servers.get(o.role)!.publicKey,'server-'+o.role,'reply');
  need(b.schema==='osv-mcp.q2.c0.object.v1'&&b.objectRole===role&&same(b.body,o.body),'integrity_invalid');return clone(o.body);
 }
 #bytes(){return this.#sourceBytes+this.#objectBytes+this.#recordBytes;}
 #gate(){this.#config.persistence?.assertOpen();need(this.#config.supported!==false,'anchor_unsupported');need(this.#config.approved!==false,'profile_unapproved');need(this.#registryAvailable&&this.#roleActor('lineage-registry')?.alive!==false,'control_unavailable');need(!this.#blocked,'recovery_required');need(this.#anchorAvailable&&this.#roleActor('control-anchor')?.alive!==false,'anchor_unavailable');}
 #issuerReady(){need(this.#issuerAvailable&&!this.#issuerBlocked&&this.#roleActor('checkpoint-issuer')?.alive!==false,'checkpoint_unavailable');}
 #authorize(a:Actor,r:CurrentRequest){
  this.#config.persistence?.assertOpen();
  const p=apiPolicy[r.api],permission=r.api==='ConfirmFenced'&&a.role==='manager'?'barrier.confirm-managed':p.permission;
  need(p.roles.includes(a.role)&&a.permissions.has(permission),'permission_denied');need(r.destination===p.destination,'peer_mismatch');
  need(a.alive&&r.credentialId===a.id&&r.peerId===a.peerId&&r.peerBoot===a.boot&&r.role===a.role&&r.keyEpoch===a.epoch&&a.uid===roleUID[a.role]&&a.gid===(a.uid===0?0:a.uid+100),'peer_mismatch');
  for(const key of Object.keys(this.#identity))need(same((r.binding as any)[key],this.#identity[key]),'binding_mismatch');
  need(r.binding.format==='v2','format_unsupported');need(r.binding.enrollmentDigest===ownedDigest(this.#identity)&&r.binding.checkpointIssuer==='checkpoint-issuer'&&r.binding.checkpointKeyEpoch===1,'binding_mismatch');
 }
 request(h:CurrentActor,api:CurrentAPI,payload:unknown,operationId='op-'+nonce(),binding=this.binding()):Buffer{
  this.#config.persistence?.assertOpen();
  for(const [id,p]of this.#pending)if(this.#now()-p.started>=L.lease||this.#readerNow()-p.localStarted>=L.lease)this.#pending.delete(id);
  const a=this.#actor(h);need(a.requests<this.#limits.requests,'capacity_exhausted');need(this.#pending.size<this.#limits.pending&&[...this.#pending.values()].filter(p=>p.actor===a.id).length<this.#limits.peerPending,'capacity_exhausted');
  let copied:{binding:unknown;payload:unknown};try{copied={binding:clone(binding),payload:clone(payload)};}catch{throw new CurrentControlError('schema_invalid');}
  need(Object.hasOwn(apiPolicy,api),'schema_invalid');
  const body:any={schema:'osv-mcp.q2.current-control.body.v1',api,direction:'request',destination:apiPolicy[api].destination,credentialId:a.id,role:a.role,peerId:a.peerId,peerBoot:a.boot,keyEpoch:a.epoch,
   requestId:nonce(),challenge:nonce(),sequence:++a.sequence,operationId,...copied};body.requestDigest=semanticDigest(body);a.requests++;
  let raw:Buffer;try{raw=this.#rawEnvelope(body,a.role,a.id,a.client.privateKey,'request');}catch(e){if(e instanceof CurrentControlError)throw e;throw new CurrentControlError(e instanceof Error&&e.message.includes('budget_exceeded')?'budget_exceeded':'schema_invalid');}this.#pending.set(body.requestId,{actor:a.id,challenge:body.challenge,sequence:body.sequence,intent:body.requestDigest,started:this.#now(),localStarted:this.#readerNow(),used:false,accepted:false});return raw;
 }
 /** Negative-wire test helper: client can sign arbitrary input, but cannot mint another role. */
 signMalformed(h:CurrentActor,body:unknown){const a=this.#actor(h);return this.#rawEnvelope(body,a.role,a.id,a.client.privateKey,'request');}
 inspectRequest(raw:Buffer):CurrentRequest{return validateRequest((parsed(wireSchema,decodeCurrent(raw))).body);}
 retry(h:CurrentActor,original:Buffer){const r=this.inspectRequest(original);return this.request(h,r.api,r.payload,r.operationId,r.binding);}
 async call(h:CurrentActor,api:CurrentAPI,payload:unknown,operationId?:string){const request=this.request(h,api,payload,operationId);return this.accept(h,request,await this.dispatch(h,request));}
 accept(h:CurrentActor,request:Buffer,response:Buffer):any{
  this.#config.persistence?.assertOpen();
  const a=this.#actor(h),r=this.inspectRequest(request),pending=this.#pending.get(r.requestId);need(pending&&pending.actor===a.id&&!pending.accepted,'challenge_replayed');
  need(this.#now()-pending.started<L.lease&&this.#readerNow()-pending.localStarted<L.lease,'request_expired');
  const role=destRole[r.destination],body=parsed(replySchema,this.#verifyEnvelope(response,role,this.#servers.get(role)!.publicKey,'server-'+role,'reply',L.frame));
  need(body.api===r.api&&body.destination===r.destination&&body.requestId===r.requestId&&body.challenge===r.challenge&&body.peerId===a.peerId&&body.peerBoot===a.boot&&body.requestWireDigest===ownedSha256(request)&&body.originalRequestDigest===r.requestDigest,'binding_mismatch');
  parsed(responseValues[r.api],body.value);pending.accepted=true;this.#pending.delete(r.requestId);return clone(body);
 }
 async dispatch(h:CurrentActor,wire:Buffer):Promise<Buffer>{
  if(!this.#config.persistence)return this.#dispatch(h,wire);need(!this.#persistentDispatching,'busy');this.#persistentDispatching=true;try{return await this.#dispatch(h,wire);}finally{this.#persistentDispatching=false;}
 }
 async #dispatch(h:CurrentActor,wire:Buffer):Promise<Buffer>{
  const a=this.#actor(h),r=validateRequest(this.#verifyEnvelope(wire,a.role,a.client.publicKey,a.id,'request',L.frame));this.#authorize(a,r);await this.#config.persistence?.verify({revision:this.#anchor.revision,record:clone(this.#anchor.ref)});this.#authorize(a,r);this.#history();
  const p=this.#pending.get(r.requestId);need(p&&p.actor===a.id&&p.challenge===r.challenge&&p.sequence===r.sequence&&!p.used,'challenge_replayed');need(r.requestDigest===semanticDigest(r)&&p.intent===r.requestDigest,'binding_mismatch');p.used=true;
  need(this.#now()-p.started<L.lease&&this.#readerNow()-p.localStarted<L.lease,'request_expired');const key=operationKey(r),active=this.#inFlight.get(key);
  if(active){need(active===r.requestDigest,'idempotency_conflict');const existing=this.#state.operations[key]??this.#issuerOps.get(key);need(existing?.status==='committed','operation_pending');need(a.permissions.has('operation.query-own'),'permission_denied');return this.#reply(a,r,wire,await this.#resolve(r,key,existing,true));}
  this.#inFlight.set(key,r.requestDigest);
  try{
   await this.#expire();const existing=this.#state.operations[key]??this.#issuerOps.get(key);
   if(existing){need(a.permissions.has('operation.query-own'),'permission_denied');need(existing.digest===r.requestDigest&&existing.owner===a.id&&existing.api===r.api,'idempotency_conflict');return this.#reply(a,r,wire,await this.#resolve(r,key,existing,true));}
   need(same(r.binding,this.binding()),'binding_mismatch');const result=await this.#execute(a,r,key,p.started);await this.#point('registry-before-reply');
   if(r.api==='ReadCurrentCheckpoint')await this.#config.persistence?.saveIssuer(this.#issuerImage());
   const committed=this.#state.operations[key]??this.#issuerOps.get(key);if(committed)return this.#reply(a,r,wire,await this.#resolve(r,key,committed,false));
   need(this.#now()-p.started<L.lease&&this.#readerNow()-p.localStarted<L.lease,'request_expired');this.#gate();
   const q=r.payload as any;if(r.api==='ReadCurrentCheckpoint'){this.#pin(q.pin);this.#issuerReady();}
   if(r.api==='ReadForCheckpoint')this.#fence(q.fence);
   if(r.api==='CheckLiveBinding'){if(q.target.role==='read-pin')this.#pin(q.target);else this.#fence(q.target);}
   const mode=r.api==='QueryOperation'||r.api==='anchor.query-operation'?result.status:'applied';
   return this.#reply(a,r,wire,{value:result,mode,entry:null});
  }catch(error){if(error instanceof CurrentControlError&&error.reason.startsWith('injected_issuer'))this.#issuerBlocked=true;throw error;}
  finally{this.#inFlight.delete(key);}
 }
 #reply(a:Actor,r:CurrentRequest,wire:Buffer,res:{value:any;mode:string;entry:Ledger|null}):Buffer{
  this.#authorize(a,r);const e=res.entry,applied=e?this.#recordAt(e.applied):null;
  const raw=this.#signed(destRole[r.destination],parsed(replySchema,{schema:'osv-mcp.q2.current-control.reply.v1',api:r.api,direction:'reply',destination:r.destination,requestId:r.requestId,challenge:r.challenge,requestWireDigest:ownedSha256(wire),originalRequestDigest:r.requestDigest,peerId:a.peerId,peerBoot:a.boot,
   appliedControlRevision:e?.applied??null,appliedRecordRef:applied?.ref??null,currentControlRevision:this.#anchor.revision,currentRecordRef:this.#anchor.ref,resolutionMode:res.mode,semanticResultRef:e?.result??null,value:parsed(responseValues[r.api],res.value),...flags}));need(raw.length<=L.frame,'budget_exceeded');this.#completedAPIs.add(r.api);return raw;
 }
 #recordAt(revision:number){return this.#history().find(e=>e.body.revision===revision);}
 #readRecord(e:RecordEntry):any{
  need(e.raw.length===e.ref.byteLength&&ownedSha256(e.raw)===e.ref.sha256,'integrity_invalid');const body=this.#verifyEnvelope(e.raw,'lineage-registry',this.#servers.get('lineage-registry')!.publicKey,'server-lineage-registry','reply');
  return parsed(durableRecordSchema,body);
 }
 #history(){
  this.#gate();const chain:{ref:Ref;body:any}[]=[];let ref=this.#anchor.ref,revision=this.#anchor.revision;const seen=new Set<string>(),results=new Set<string>();
  while(ref){need(chain.length<this.#limits.records&&!seen.has(ref.id),'integrity_invalid');seen.add(ref.id);const e=this.#records.get(ref.id);need(e&&same(e.ref,ref)&&e.synced,'integrity_invalid');const body=this.#readRecord(e);
   need(body.revision===revision&&same(body.identity,this.#identity),'integrity_invalid');for(const entry of Object.values(body.state.operations) as Ledger[])if(!results.has(entry.result.id)){this.#get(entry.result,'semantic-result');results.add(entry.result.id);}chain.push({ref:clone(ref),body});ref=body.previous;revision--;}
  need(revision===0&&chain.length===this.#anchor.revision,'integrity_invalid');if(chain.length)need(same(chain[0]!.body.state,this.#state),'integrity_invalid');return chain;
 }
 #isAncestor(ref:Ref){return this.#history().some(e=>same(e.ref,ref));}
 async #resolve(r:CurrentRequest,key:string,entry:Ledger,retry:boolean){
  const chain=this.#history();need(entry.owner===r.credentialId&&entry.digest===r.requestDigest,'idempotency_conflict');
  const issuer=this.#issuerOps.get(key)===entry;
  if(!issuer){const applied=chain.find(e=>e.body.revision===entry.applied);need(applied&&same(applied.body.state.operations[key],entry),'integrity_invalid');if(!retry)need(applied.body.state.incarnation===this.#state.incarnation&&applied.body.state.revocationEpoch===this.#state.revocationEpoch,'grant_revoked');}
  const semantic=this.#get(entry.result,'semantic-result');need(semantic.api===r.api,'integrity_invalid');this.#metrics.resolutions++;
  if(entry.status==='pending')throw new CurrentControlError('operation_pending');
  let live=false;
  const current=this.binding(),origin=entry.binding;const compatible=['providerBoot','selectionRevision','revocationEpoch','registryIncarnation','enrollmentDigest'].every(k=>(origin as any)[k]===(current as any)[k])&&same(origin.selected,current.selected);
  if(['AcquireReadPin','ReserveWriter'].includes(r.api)&&this.#now()-entry.started<L.lease&&this.#readerNow()-entry.localStarted<L.lease&&compatible){
   try{if(r.api==='AcquireReadPin')this.#pin(semantic.value.pin,r.credentialId,['active']);else this.#writer(semantic.value.fence,r.credentialId);live=true;}catch{/* Historical result never restores an invalid lease. */}
  }
  if(!retry){need(this.#byId.get(entry.owner)?.alive,'owner_closed');need(this.#now()-entry.started<L.lease&&this.#readerNow()-entry.localStarted<L.lease,'request_expired');if(r.api==='PrepareHandoff')this.#pin((semantic.value as any).pin,undefined,['decision-recorded']);if(r.api==='DeliverResult')this.#pin((semantic.value as any).pin,undefined,['delivering']);}
  if(issuer){this.#issuerReady();if(!retry){this.#fence((entry as IssuerEntry).fence);need(this.#now()-entry.started<L.lease,'request_expired');}}
  if(!retry&&!issuer&&!live&&['AcquireReadPin','ReserveWriter'].includes(r.api))throw new CurrentControlError('pin_expired');
  return {value:semantic.value,mode:retry?(live?'existing-live-confirmed':'committed-historical'):'applied',entry:issuer?null:entry};
 }
 async #point(name:FaultPoint){const pause=this.#pauses.get(name);if(pause){this.#pauses.delete(name);pause.reached();await pause.promise;}
  const fault=this.#faults.get(name);if(fault){this.#faults.delete(name);throw new CurrentControlError(fault==='lose-response'?'response_lost':'injected_'+name);}}
 schedule(h:CurrentActor,point:FaultPoint,fault:Fault){this.#operator(h);this.#faults.set(point,fault);}
 pause(h:CurrentActor,point:FaultPoint){this.#operator(h);let reached!:()=>void,resume!:()=>void;const ready=new Promise<void>(r=>reached=r),promise=new Promise<void>(r=>resume=r);this.#pauses.set(point,{reached,promise});return {reached:ready,resume};}
 #serving(){need(this.#state.phase==='serving','control_unavailable');}
 #fence(ref:Ref):Lease{const lease=ref.role==='provision'?this.#state.provision:this.#state.writer;need(lease&&same(lease.ref,ref),'writer_stale');need(lease.phase==='reserved'&&lease.expires>this.#now()&&lease.incarnation===this.#state.incarnation&&lease.revocationEpoch===this.#state.revocationEpoch&&lease.providerBoot===this.#roleActor('provider')?.boot&&lease.issuerBoot===this.#roleActor('checkpoint-issuer')?.boot,'writer_stale');return lease;}
 #writer(ref:Ref,owner:string){this.#serving();const w=this.#fence(ref);need(ref.role==='writer-fence'&&w.owner===owner&&w.selectionRevision===this.#state.selectionRevision,'writer_stale');return w;}
 #pin(ref:Ref,owner?:string,phases=['active','completing','decision-recorded','delivering']){
  this.#serving();const p=this.#state.pins[ref.id];need(p&&same(p.ref,ref),'binding_mismatch');need(owner===undefined||p.owner===owner,'permission_denied');need(p.expires>this.#now(),'pin_expired');
  need(phases.includes(p.phase)&&p.incarnation===this.#state.incarnation&&p.selectionRevision===this.#state.selectionRevision&&p.revocationEpoch===this.#state.revocationEpoch&&p.providerBoot===this.#roleActor('provider')?.boot&&p.issuerBoot===this.#roleActor('checkpoint-issuer')?.boot,'pin_revoked');
  const actor=this.#byId.get(p.owner);need(actor?.alive&&actor.permissions.has('pin.acquire'),'pin_revoked');return p;
 }
 #holdPins(){return Object.values(this.#state.pins).some(p=>p.hold||['active','completing','decision-recorded','delivering','cancelling'].includes(p.phase));}
 #lease(ref:Ref,owner:string,operationId:string):Lease{return {ref,owner,operationId,expires:this.#now()+L.lease,selectionRevision:this.#state.selectionRevision,revocationEpoch:this.#state.revocationEpoch,incarnation:this.#state.incarnation,providerBoot:this.#roleActor('provider')?.boot??ownedSha256('provider-not-provisioned'),issuerBoot:this.#roleActor('checkpoint-issuer')?.boot??ownedSha256('issuer-not-provisioned'),phase:'reserved'};}
 #adoptRecord(e:RecordEntry,expected:Ref|null,attemptId:string){
  need(this.#anchorAvailable,'anchor_unavailable');need(e.synced,'sync_incomplete');const body=this.#readRecord(e),attempt=ownedDigest({registry:'registry',incarnation:body.state.incarnation,previous:body.previous,next:e.ref});
  need(attempt===attemptId&&same(expected,body.previous),'binding_mismatch');const prior=this.#attempts.get(attempt);
  if(prior){need(same(prior.record,e.ref)&&this.#isAncestor(e.ref),'integrity_invalid');return;}
  need(same(this.#anchor.ref,expected)&&body.revision===this.#anchor.revision+1,'control_conflict');
  if(body.revision===1)need(body.state.phase==='provisioning'&&Object.values(body.state.operations).some((op:any)=>op.api==='BeginEnrollment'&&this.#byId.get(op.owner)?.role==='operator'),'permission_denied');
  this.#anchor={revision:body.revision,ref:clone(e.ref)};this.#state=clone(body.state);this.#revision=body.revision;this.#attempts.set(attempt,{digest:attempt,record:clone(e.ref)});this.#metrics.anchorCAS++;this.#metrics.commits++;
 }
 async #commit(r:CurrentRequest|null,key:string|null,change:(state:State)=>any,started:number,status:Ledger['status']='committed'){
  if(r)this.#authorize(this.#byId.get(r.credentialId)!,r);this.#gate();need(!this.#busy,'busy');need(this.#records.size<this.#limits.records,'capacity_exhausted');if(key)need(Object.keys(this.#state.operations).length<this.#limits.operations||!!this.#state.operations[key],'capacity_exhausted');
  if(r&&key)need(this.#objects.size<this.#limits.objects,'capacity_exhausted');
  // Capacity refusals before the registry record is written leave the owner usable; storage-boundary failures stay fail-stop.
  this.#busy=true;let committed=false,written=false,semanticId:string|null=null;
  try{
   const state=clone(this.#state),value=change(state),revision=this.#anchor.revision+1;need(Number.isSafeInteger(revision),'capacity_exhausted');
   if(r&&key){const objects=this.#objects.size,result=this.#put('semantic-result',{api:r.api,value:parsed(responseValues[r.api],value)},'lineage-registry');if(this.#objects.size>objects)semanticId=result.id;state.operations[key]={digest:r.requestDigest,api:r.api,owner:r.credentialId,status,applied:revision,result,started,localStarted:this.#pending.get(r.requestId)!.localStarted,binding:clone(r.binding)};}
   await this.#point('registry-before-record');const previous=clone(this.#anchor.ref),raw=this.#signed('lineage-registry',{schema:'osv-mcp.q2.c0.registry-record.v1',identity:this.#identity,revision,previous,state});
   need(raw.length<=L.record&&this.#bytes()+raw.length<=this.#limits.closure,'capacity_exhausted');const ref:Ref={role:'registry-record',id:ownedSha256(raw),sha256:ownedSha256(raw),byteLength:raw.length};
   written=true;this.#records.set(ref.id,{ref,raw:Buffer.from(raw),synced:false});this.#recordBytes+=raw.length;await this.#point('registry-after-record');this.#records.get(ref.id)!.synced=true;this.#metrics.registrySyncSteps++;await this.#point('registry-after-sync');await this.#point('anchor-before-cas');
   if(this.#config.persistence){await this.#config.persistence.saveIssuer(this.#issuerImage());await this.#config.persistence.saveRegistry(this.#registryImage());}
   if(r)this.#authorize(this.#byId.get(r.credentialId)!,r);
   const attempt=ownedDigest({registry:'registry',incarnation:state.incarnation,previous,next:ref});await this.#config.persistence?.cas({revision:revision-1,record:previous},{revision,record:ref},attempt);this.#adoptRecord(this.#records.get(ref.id)!,previous,attempt);committed=true;this.#busy=false;
   await this.#point('anchor-after-cas');return value;
  }catch(error){
   if(!committed){
    if(error instanceof CurrentControlError&&error.reason==='control_conflict')this.#history();
    else if(!written&&error instanceof CurrentControlError&&error.reason==='capacity_exhausted'){if(semanticId){this.#objectBytes-=this.#objects.get(semanticId)!.raw.length;this.#objects.delete(semanticId);}}
    else this.#blocked=true;
   }
   throw error;
  }finally{this.#busy=false;}
 }
 async #expire(){
  const now=this.#now(),expired=Object.values(this.#state.pins).filter(p=>now>=p.expires&&['active','completing','decision-recorded','delivering'].includes(p.phase));const writer=this.#state.writer;
  if(!expired.length&&!(writer?.phase==='reserved'&&now>=writer.expires))return;
  await this.#commit(null,null,s=>{for(const p of expired){const q=s.pins[p.ref.id]!;q.hold=q.hold||['decision-recorded','delivering'].includes(q.phase);q.phase='expired';}if(s.writer?.phase==='reserved'&&now>=s.writer.expires)s.writer.phase='expired';return {};},now);
 }
 registerSource(h:CurrentActor,supplied:V2ReplayInput):Ref{
  const a=this.#actor(h);need(a.role==='provider'&&a.alive&&a.id===this.#roleActor('provider')?.id,'permission_denied');need(Buffer.isBuffer(supplied.key)&&supplied.key.length===32,'configuration_invalid');
  const size=supplied.commits.reduce((n,b)=>n+b.length,0)+supplied.payloads.reduce((n,b)=>n+b.length,0);need(size<=L.closure&&this.#bytes()+size<=this.#limits.closure,'capacity_exhausted');
  const {key,commits,payloads,...metadata}=supplied,input={...clone(metadata),key:Buffer.from(key),commits:commits.map(b=>Buffer.from(b)),payloads:payloads.map(b=>Buffer.from(b))};
  const replay=replayV2(input);need(same(input.binding,{authorityId:this.#identity.authorityId,lineageId:this.#identity.lineageId,generation:this.#identity.generation,storeEpoch:this.#identity.storeEpoch,profileDigest:this.#identity.profileDigest}),'binding_mismatch');
  const head=parsed(currentHeadSchema,{format:'v2',revision:replay.revision,commitDigest:replay.commitDigest,stateRoot:replay.stateRoot,baseDigest:input.approvedBaseDigest}),inventory=ownedDigest({commits:input.commits.map(b=>ownedSha256(b)),payloads:input.payloads.map(b=>ownedSha256(b)).sort()});
  const ref=this.#put('snapshot',{head,inventory,provider:a.id,providerBoot:a.boot,binding:this.#identity},'provider');if(!this.#sources.has(ref.id)){need(this.#bytes()+size<=this.#limits.closure,'capacity_exhausted');this.#sources.set(ref.id,{ref,input,head,inventory});this.#sourceBytes+=size;}return clone(ref);
 }
 #source(ref:Ref){need(this.#roleActor('provider')?.alive,'provider_unavailable');const proof=this.#get(ref,'snapshot'),source=this.#sources.get(ref.id);need(source&&proof.provider===this.#roleActor('provider')!.id&&same(source.head,proof.head)&&source.inventory===proof.inventory,'receipt_invalid');return source;}
 #replay(source:Source){this.#metrics.ownedSourceReads++;this.#metrics.ownedSourceBytes+=source.input.commits.reduce((n,b)=>n+b.length,0)+source.input.payloads.reduce((n,b)=>n+b.length,0);try{const r=replayV2(source.input);this.#metrics.fullReplays++;need(same(source.head,{format:'v2',revision:r.revision,commitDigest:r.commitDigest,stateRoot:r.stateRoot,baseDigest:source.input.approvedBaseDigest}),'integrity_invalid');return r;}catch{this.#issuerBlocked=true;throw new CurrentControlError('integrity_invalid');}}
 #checkpoint(ref:Ref){this.#get(ref,'checkpoint-prepare');const p=this.#prepares.get(ref.id);need(p&&same(p.ref,ref),'receipt_invalid');return p;}
 async #prepare(a:Actor,r:CurrentRequest,key:string,started:number){
  this.#issuerReady();const q=r.payload as any,lease=this.#fence(q.fence);need(a.role==='provider'&&a.id===this.#roleActor('provider')?.id,'permission_denied');
  need(q.mode==='genesis'?this.#state.phase==='provisioning'&&q.fence.role==='provision':this.#state.phase==='serving'&&q.fence.role==='writer-fence','binding_mismatch');
  const reserved=[...this.#issuerReservations.values()];need(this.#prepares.size+reserved.filter(v=>v.prepare).length<this.#limits.prepares&&this.#issuerOps.size+reserved.filter(v=>v.operation).length<this.#limits.operations,'capacity_exhausted');const source=this.#source(q.snapshot);need(source.head.baseDigest===this.#config.approvedBase,'base_unapproved');this.#busySubjects.set('checkpoint-issuer',(this.#busySubjects.get('checkpoint-issuer')??0)+1);
  const reservation={prepare:true,operation:true};this.#issuerReservations.set(key,reservation);
  try{await this.#point('issuer-before-verify');this.#authorize(a,r);this.#fence(q.fence);this.#replay(source);
   if(q.mode==='advance'){const old=this.#source(this.#state.selected!.snapshot);need(source.head.revision>old.head.revision&&old.input.commits.every((b,i)=>source.input.commits[i]?.equals(b))&&old.input.payloads.every(b=>source.input.payloads.some(c=>c.equals(b))),'checkpoint_conflict');}
   const body={snapshot:source.ref,head:source.head,fence:q.fence,previous:this.#state.selected?.checkpoint??null,mode:q.mode};await this.#point('issuer-before-sync');this.#authorize(a,r);
   const ref=this.#put('checkpoint-prepare',body,'checkpoint-issuer');this.#prepares.set(ref.id,{...body,ref});reservation.prepare=false;this.#metrics.checkpointSyncSteps++;
   const value={checkpoint:ref,head:source.head},result=this.#put('semantic-result',{api:r.api,value},'checkpoint-issuer');this.#issuerOps.set(key,{digest:r.requestDigest,api:r.api,owner:a.id,status:'committed',applied:this.#anchor.revision,result,started,localStarted:this.#pending.get(r.requestId)!.localStarted,binding:clone(r.binding),fence:q.fence});reservation.operation=false;
   await this.#config.persistence?.saveIssuer(this.#issuerImage());
   await this.#point('issuer-after-sync');this.#fence(q.fence);need(this.#now()-started<L.lease&&lease.expires>this.#now(),'request_expired');await this.#point('issuer-before-reply');this.#fence(q.fence);return value;
  }catch(e){if(e instanceof CurrentControlError&&e.reason.startsWith('injected_'))this.#issuerBlocked=true;throw e;}finally{this.#issuerReservations.delete(key);this.#busySubjects.set('checkpoint-issuer',(this.#busySubjects.get('checkpoint-issuer')??1)-1);}
 }
 #required(){const ids=new Set<string>();for(const role of ['provider','checkpoint-issuer','authority-broker'] as const){const a=this.#roleActor(role);if(a)ids.add(a.id);}for(const p of Object.values(this.#state.pins))if(p.hold||!['released','cancelled','expired'].includes(p.phase))ids.add(p.owner);if(this.#state.writer?.phase==='reserved')ids.add(this.#state.writer.owner);return [...ids].sort();}
 requiredParticipants(){return this.#required();}
 async #execute(a:Actor,r:CurrentRequest,key:string,started:number):Promise<any>{
  this.#authorize(a,r);
  const q=r.payload as any,commit=(change:(s:State)=>any,status:Ledger['status']='committed')=>this.#commit(r,key,change,started,status);
  switch(r.api){
   case 'BeginEnrollment':{
    need(this.#state.phase==='uninitialized','control_conflict');need(q.approvedBase===this.#config.approvedBase,'base_unapproved');
    const ref=this.#put('provision',{owner:a.id,operationId:r.operationId,approvedBase:q.approvedBase,instance:this.#identity},'lineage-registry'),lease=this.#lease(ref,a.id,r.operationId);
    return commit(s=>{s.phase='provisioning';s.provision=lease;return {provision:ref,expires:lease.expires};});}
   case 'ActivateEnrollment':{
    need(this.#state.phase==='provisioning','control_unavailable');this.#fence(q.provision);const prepared=this.#checkpoint(q.checkpoint);need(prepared.mode==='genesis'&&same(prepared.fence,q.provision)&&prepared.previous===null,'binding_mismatch');
    return commit(s=>{s.selected={snapshot:prepared.snapshot,checkpoint:prepared.ref,head:prepared.head};s.selectionRevision=1;s.phase='serving';s.provision!.phase='consumed';return {selected:s.selected,selectionRevision:1};});}
   case 'ReserveWriter':{
    this.#serving();need(q.expectedSelection===this.#state.selectionRevision,'control_conflict');need(!this.#holdPins(),'pins_active');need(!this.#state.writer||this.#state.writer.phase!=='reserved','writer_busy');
    const ref=this.#put('writer-fence',{owner:a.id,boot:a.boot,operationId:r.operationId,selection:this.#state.selectionRevision,fence:this.#state.writerFence+1},'lineage-registry'),lease=this.#lease(ref,a.id,r.operationId);
    return commit(s=>{s.writerFence++;s.writer=lease;return {fence:ref,expires:lease.expires};});}
   case 'PrepareCheckpoint':return this.#prepare(a,r,key,started);
   case 'ReadForCheckpoint':{
    this.#fence(q.fence);need(a.id===this.#roleActor('checkpoint-issuer')?.id,'permission_denied');const source=this.#source(q.snapshot);need(source.head.baseDigest===this.#config.approvedBase,'base_unapproved');const data=(q.kind==='commit'?source.input.commits:source.input.payloads)[q.index];need(data&&q.offset<=data.length,'binding_mismatch');
    this.#metrics.ownedSourceReads++;this.#metrics.ownedSourceBytes+=Math.min(q.maxBytes,data.length-q.offset);const raw=Buffer.from(data.subarray(q.offset,q.offset+q.maxBytes));await this.#point('source-before-reply');this.#fence(q.fence);return {snapshot:q.snapshot,bytes:raw.toString('base64'),sha256:ownedSha256(raw),offset:q.offset};}
   case 'PublishSelection':{
    this.#writer(q.fence,a.id);need(!this.#holdPins(),'pins_active');const p=this.#checkpoint(q.checkpoint);need(p.mode==='advance'&&same(p.fence,q.fence)&&same(p.previous,this.#state.selected!.checkpoint),'checkpoint_conflict');
    return commit(s=>{s.selected={snapshot:p.snapshot,checkpoint:p.ref,head:p.head};s.selectionRevision++;s.writer!.phase='consumed';return {selected:s.selected,selectionRevision:s.selectionRevision};});}
   case 'AcquireReadPin':{
    this.#serving();need(q.operationBinding===this.#business.operationBinding,'gate_invalid');need(!this.#state.writer||this.#state.writer.phase!=='reserved','writer_busy');need(Object.values(this.#state.pins).filter(p=>!['released','cancelled','expired'].includes(p.phase)).length<this.#limits.pins&&Object.keys(this.#state.pins).length<L.retainedPins,'capacity_exhausted');
    const ref=this.#put('read-pin',{owner:a.id,boot:a.boot,operationId:r.operationId,nonce:nonce(),view:this.#state.selectionRevision,incarnation:this.#state.incarnation},'lineage-registry');
    const pin:Pin={...this.#lease(ref,a.id,r.operationId),phase:'active',createdControlRevision:this.#anchor.revision+1,operationBinding:q.operationBinding,checkpoint:this.#state.selected!.checkpoint,snapshot:this.#state.selected!.snapshot,broker:null,useId:null,gate:null,delivery:null,hold:false,effect:false};
    return commit(s=>{s.pins[ref.id]=pin;return {pin:ref,expires:pin.expires};});}
   case 'ReadCurrentCheckpoint':{
    const pin=this.#pin(q.pin);need(pin.owner===a.id||a.role==='provider'&&a.id===this.#roleActor('provider')?.id,'permission_denied');need(same(pin.checkpoint,q.checkpoint),'binding_mismatch');this.#issuerReady();
    for(const p of this.#prepares.values()){this.#checkpoint(p.ref);this.#replay(this.#source(p.snapshot));this.#metrics.checkpointSyncSteps++;}await this.#point('issuer-before-reply');this.#pin(q.pin);
    const prepared=this.#checkpoint(q.checkpoint),witness=this.#put('checkpoint-witness',{pin:q.pin,checkpoint:q.checkpoint,snapshot:pin.snapshot,head:prepared.head,owner:pin.owner,expires:pin.expires,incarnation:pin.incarnation,selection:pin.selectionRevision,epoch:pin.revocationEpoch},'checkpoint-issuer');return {witness,head:prepared.head};}
   case 'CheckLiveBinding':{
    need(['provider','checkpoint-issuer','authority-broker'].includes(a.role)&&a.id===this.#roleActor(a.role)?.id,'permission_denied');const target=q.target.role==='read-pin'?this.#pin(q.target):this.#fence(q.target);
    need(q.target.role==='read-pin'?(a.role!=='authority-broker'||q.purpose==='handoff'):(a.role!=='authority-broker'&&q.purpose!=='handoff'),'permission_denied');return {target:q.target,phase:target.phase,selectionRevision:target.selectionRevision};}
   case 'PrepareHandoff':return this.#handoff(a,r,key,started);
   case 'DeliverResult':{
    const p=this.#pin(q.pin,undefined,['decision-recorded']);need(p.broker===a.id&&p.useId===q.useId,'permission_denied');this.#validGate(p.gate!,p,q.useId);const delivery=this.#put('delivery',{pin:q.pin,useId:q.useId,broker:a.id,owner:p.owner,gate:p.gate},'lineage-registry');
    return commit(s=>{const p=s.pins[q.pin.id]!;p.phase='delivering';p.delivery=delivery;return {pin:p.ref,delivery,useId:p.useId};});}
   case 'AcknowledgeDelivery':{
    const p=this.#pin(q.pin,a.id,['delivering']);need(same(p.delivery,q.delivery),'binding_mismatch');if(p.effect){need(q.effect,'effects_pending');const proof=this.#get(q.effect,'fence-evidence');need(proof.kind==='effect-complete'&&same(proof.pin,p.ref)&&proof.broker===p.broker&&proof.useId===p.useId,'effects_pending');}
    return commit(s=>{const p=s.pins[q.pin.id]!;p.phase='released';p.hold=false;p.effect=false;return {target:p.ref,phase:'released'};});}
   case 'CancelWriter':{
    const w=this.#writer(q.fence,a.id);return commit(s=>{s.writer!.phase='cancelled';return {target:w.ref,phase:'cancelled'};});}
   case 'ReleaseReadPin':{
    const p=this.#pin(q.pin,a.id,['active','completing']);need(!p.hold&&!p.effect,'effects_pending');return commit(s=>{s.pins[p.ref.id]!.phase='cancelled';return {target:p.ref,phase:'cancelled'};});}
   case 'BeginBarrier':{
    this.#serving();need(a.role==='operator'||['revoke','freeze'].includes(q.reason),'permission_denied');const required=this.#required();need(same([...q.participants].sort(),required),'participants_incomplete');
    const barrier=this.#put('barrier',{reason:q.reason,participants:required,incarnation:this.#state.incarnation,nonce:nonce()},'lineage-registry');
    return commit(s=>{s.phase='draining';s.revocationEpoch++;s.writerFence++;if(s.writer?.phase==='reserved')s.writer.phase='cancelled';for(const p of Object.values(s.pins))if(!['released','cancelled','expired'].includes(p.phase)){p.hold=p.hold||['decision-recorded','delivering'].includes(p.phase);p.phase='cancelling';}
     s.barrier={ref:barrier,reason:q.reason,participants:required,boots:Object.fromEntries(required.map(id=>[id,this.#byId.get(id)!.boot])),confirmed:[],resume:['restart','rotation'].includes(q.reason),completed:false};return {barrier,participants:required};});}
   case 'ConfirmFenced':{
    const b=this.#state.barrier;need(this.#state.phase==='draining'&&b&&same(b.ref,q.barrier),'control_unavailable');const proof=this.#get(q.evidence,'fence-evidence');need(same(proof.barrier,q.barrier)&&b.participants.includes(proof.subject)&&b.boots[proof.subject]===proof.boot,'binding_mismatch');
    need(a.role==='manager'?proof.kind==='managed-stop'&&proof.manager===a.id:proof.kind==='own-idle'&&proof.subject===a.id,'permission_denied');need(!b.confirmed.includes(proof.subject),'control_conflict');
    return commit(s=>{s.barrier!.confirmed.push(proof.subject);for(const p of Object.values(s.pins)){if(p.owner===proof.subject&&!p.effect){p.phase='cancelled';p.hold=false;}if(p.broker===proof.subject&&proof.kind==='managed-stop'){p.effect=false;p.hold=false;p.phase='cancelled';}}
     for(const p of Object.values(s.pins))if(p.broker===proof.subject&&proof.kind==='own-idle'&&this.#effects.has(p.ref.id)){p.effect=false;p.hold=false;p.phase='cancelled';}
     return {barrier:b.ref,subject:proof.subject};});}
   case 'FinishBarrier':{
    const b=this.#state.barrier;need(this.#state.phase==='draining'&&b&&same(b.ref,q.barrier),'control_unavailable');need(same([...b.confirmed].sort(),b.participants),'fencing_unconfirmed');need(!Object.values(this.#state.pins).some(p=>p.effect||p.hold),'effects_pending');
    return commit(s=>{s.phase=b.reason==='gc'?'retired':'frozen';s.barrier!.completed=true;return {barrier:b.ref,phase:s.phase};});}
   case 'ResumeServing':{
    const b=this.#state.barrier;need(this.#state.phase==='frozen'&&b?.completed&&b.resume&&same(b.ref,q.barrier),'control_unavailable');this.#issuerReady();need(this.#roleActor('authority-broker')?.alive!==false,'authority_unavailable');this.#replay(this.#source(this.#state.selected!.snapshot));await this.#point('recovery-before-ready');need(this.#state.phase==='frozen'&&same(this.#state.barrier?.ref,q.barrier),'control_conflict');this.#issuerReady();
    return commit(s=>{s.phase='serving';return {phase:s.phase,registryIncarnation:s.incarnation};});}
   case 'QueryOperation':{
    const request={...r,api:q.originalAPI,destination:apiPolicy[q.originalAPI as CurrentAPI].destination,operationId:q.operationId},originalKey=operationKey(request),e=this.#state.operations[originalKey]??this.#issuerOps.get(originalKey);this.#history();
    if(!e){const active=this.#inFlight.get(originalKey);if(active)need(active===q.originalRequestDigest,'idempotency_conflict');return {status:active?'pending':'unknown',originalAPI:q.originalAPI,result:null,appliedControlRevision:null};}need(e.owner===a.id&&e.digest===q.originalRequestDigest,'idempotency_conflict');this.#get(e.result,'semantic-result');return {status:e.status==='pending'?'pending':'committed-historical',originalAPI:e.api,result:e.result,appliedControlRevision:e.applied};}
   case 'anchor.read':this.#history();return {revision:this.#anchor.revision,record:this.#anchor.ref};
   case 'anchor.query-operation':{const e=this.#attempts.get(q.attemptId);return {attemptId:q.attemptId,status:e?'committed-historical':'unknown',record:e?.record??null};}
   case 'anchor.cas':{
    need(this.#anchorAvailable,'anchor_unavailable');const e=this.#records.get(q.next.id);need(e&&same(e.ref,q.next)&&e.synced,'receipt_invalid');const body=this.#readRecord(e);await this.#config.persistence?.cas({revision:body.revision-1,record:q.expected},{revision:body.revision,record:e.ref},q.attemptId);this.#adoptRecord(e,q.expected,q.attemptId);return {revision:body.revision,record:e.ref};}
  }
 }
 #validGate(ref:Ref,pin:Pin,useId:string){const g=this.#get(ref,'authority-gate');need(same(g.pin,pin.ref)&&g.useId===useId&&g.owner===pin.owner&&g.operationBinding===pin.operationBinding&&g.operationBinding===this.#business.operationBinding&&g.manifestDigest===this.#business.manifestDigest&&g.coreGraphDigest===this.#business.coreGraphDigest&&g.sessionId===this.#business.sessionId&&g.scopeId===this.#business.scopeId&&g.brokerBoot===this.#byId.get(g.broker)?.boot&&g.expires>this.#now()&&g.incarnation===pin.incarnation&&g.selection===pin.selectionRevision&&g.epoch===pin.revocationEpoch,'gate_invalid');return g;}
 async #handoff(a:Actor,r:CurrentRequest,key:string,started:number){
  const q=r.payload as any,p=this.#pin(q.pin,undefined,['active']),w=this.#get(q.witness,'checkpoint-witness'),g=this.#validGate(q.gate,p,q.useId);
  need(g.broker===a.id&&same(g.result,q.result)&&same(w.pin,p.ref)&&same(w.checkpoint,p.checkpoint)&&w.owner===p.owner&&w.incarnation===p.incarnation&&w.selection===p.selectionRevision&&w.epoch===p.revocationEpoch&&w.expires>this.#now(),'gate_invalid');this.#get(q.result,'candidate-result');
  const value={pin:p.ref,useId:q.useId,phase:'decision-recorded'};
  await this.#commit(r,key,s=>{const p=s.pins[q.pin.id]!;p.phase='completing';p.broker=a.id;p.gate=q.gate;p.useId=q.useId;return value;},started,'pending');
  await this.#point('handoff-completing');this.#pin(q.pin,undefined,['completing']);this.#validGate(q.gate,this.#state.pins[q.pin.id]!,q.useId);need(this.#now()-started<L.lease,'request_expired');
  return this.#commit(r,key,s=>{const p=s.pins[q.pin.id]!;p.phase='decision-recorded';p.hold=true;p.effect=g.effect;return value;},started);
 }
 /** Trusted business/manager fixtures model evidence provenance, NOT G0 validation or OS observation. */
 authorityGate(h:CurrentActor,pinRef:Ref,useId:string,resultBytes:Buffer,options:{effect?:boolean}={}){
  const a=this.#actor(h);need(a.role==='authority-broker'&&a.alive&&a.permissions.has('handoff.prepare'),'permission_denied');const p=this.#pin(pinRef);need(resultBytes.length<=1024,'budget_exceeded');
  const result=this.#put('candidate-result',{bytes:Buffer.from(resultBytes).toString('base64'),digest:ownedSha256(resultBytes)},'authority-broker');
  const gate=this.#put('authority-gate',{...this.#business,pin:p.ref,useId,owner:p.owner,broker:a.id,brokerBoot:a.boot,result,expires:p.expires,incarnation:p.incarnation,selection:p.selectionRevision,epoch:p.revocationEpoch,effect:options.effect??false},'authority-broker');return {gate,result};
 }
 effectCompleted(h:CurrentActor,pinRef:Ref){const a=this.#actor(h),p=this.#state.pins[pinRef.id];need(p&&p.effect&&p.hold&&p.broker===a.id&&a.role==='authority-broker'&&a.alive&&p.useId,'permission_denied');this.#effects.add(pinRef.id);return this.#put('fence-evidence',{kind:'effect-complete',pin:p.ref,broker:a.id,useId:p.useId},'authority-broker');}
 ownIdleEvidence(h:CurrentActor,barrierRef:Ref){const a=this.#actor(h),b=this.#state.barrier;need(b&&same(b.ref,barrierRef)&&b.participants.includes(a.id)&&b.boots[a.id]===a.boot,'permission_denied');need(!(this.#busySubjects.get(a.role)??0),'effects_pending');need(!Object.values(this.#state.pins).some(p=>p.broker===a.id&&p.effect&&!this.#effects.has(p.ref.id)),'effects_pending');
  return this.#put('fence-evidence',{kind:'own-idle',subject:a.id,boot:a.boot,barrier:b.ref},a.role);}
 stopParticipant(h:CurrentActor,target:CurrentActor){this.#operator(h);this.#actor(target).alive=false;}
 startParticipant(h:CurrentActor,target:CurrentActor){this.#operator(h);const a=this.#actor(target);need(this.#state.phase!=='serving'&&!a.alive,'control_unavailable');a.boot=nonce();a.alive=true;a.requests=0;}
 managedEvidence(h:CurrentActor,target:CurrentActor,barrierRef:Ref){const a=this.#actor(h),t=this.#actor(target);need(a.role==='manager'&&a.permissions.has('barrier.confirm-managed')&&a.managedTargets.has(t.id)&&!t.alive&&!['operator','manager'].includes(t.role),'permission_denied');need(this.#state.barrier?.participants.includes(t.id)&&same(this.#state.barrier.ref,barrierRef),'binding_mismatch');return this.#put('fence-evidence',{kind:'managed-stop',manager:a.id,subject:t.id,boot:t.boot,barrier:barrierRef},'manager');}
 revokePermission(h:CurrentActor,target:CurrentActor,permission:string){this.#operator(h);this.#actor(target).permissions.delete(permission);}
 /** Fault-schedule access only: an independent valid competing model transaction. */
 pendingRecords(h:CurrentActor){this.#operator(h);return [...this.#records.values()].filter(e=>!this.#attempts.has(ownedDigest({registry:'registry',incarnation:this.#readRecord(e).state.incarnation,previous:this.#readRecord(e).previous,next:e.ref}))).map(e=>{const b=this.#readRecord(e);return {next:clone(e.ref),expected:clone(b.previous),attemptId:ownedDigest({registry:'registry',incarnation:b.state.incarnation,previous:b.previous,next:e.ref}),synced:e.synced};});}
 compete(h:CurrentActor){
  this.#operator(h);need(!this.#config.persistence,'unsupported_diagnostic');need(this.#busy&&this.#anchor.ref,'control_unavailable');const previous=clone(this.#anchor.ref),revision=this.#anchor.revision+1,raw=this.#signed('lineage-registry',{schema:'osv-mcp.q2.c0.registry-record.v1',identity:this.#identity,revision,previous,state:clone(this.#state),auditNonce:nonce()});
  need(this.#records.size<this.#limits.records&&this.#bytes()+raw.length<=this.#limits.closure,'capacity_exhausted');const ref:Ref={role:'registry-record',id:ownedSha256(raw),sha256:ownedSha256(raw),byteLength:raw.length},entry={ref,raw,synced:true};this.#records.set(ref.id,entry);this.#recordBytes+=raw.length;this.#adoptRecord(entry,previous,ownedDigest({registry:'registry',incarnation:this.#state.incarnation,previous,next:ref}));
 }
 availability(h:CurrentActor,target:'registry'|'issuer'|'anchor',available:boolean){this.#operator(h);if(target==='registry')this.#registryAvailable=available;else if(target==='issuer')this.#issuerAvailable=available;else this.#anchorAvailable=available;}
 corrupt(h:CurrentActor,kind:'record'|'ledger'|'result'|'source'|'drop-record'){
  this.#operator(h);if(kind==='record'||kind==='drop-record'){const ref=this.#anchor.ref;need(ref,'control_unavailable');if(kind==='drop-record')this.#records.delete(ref.id);else {const raw=this.#records.get(ref.id)!.raw;raw[0]=raw[0]!^1;}}
  else if(kind==='ledger'){const key=Object.keys(this.#state.operations)[0];need(key,'control_unavailable');delete this.#state.operations[key];}
  else if(kind==='result'){const e=Object.values(this.#state.operations)[0];need(e,'control_unavailable');const raw=this.#objects.get(e.result.id)!.raw;raw[0]=raw[0]!^1;}
  else {const s=[...this.#sources.values()][0];need(s,'source_missing');s.input.payloads[0]!.fill(0);}
 }
 rollbackLocal(h:CurrentActor,revision:number){this.#operator(h);const e=this.#recordAt(revision);need(e,'control_conflict');this.#state=clone(e.body.state);}
 async restart(h:CurrentActor){this.#operator(h);need(!this.#persistentDispatching&&!this.#busy,'busy');this.#blocked=false;this.#history();this.#issuerBlocked=false;const now=this.#now();
  await this.#commit(null,null,s=>{s.incarnation=nonce();s.revocationEpoch++;s.writerFence++;if(s.writer)s.writer.phase='cancelled';if(s.provision)s.provision.phase='cancelled';
   if(s.phase==='serving'){const participants=this.#required(),ref=this.#put('barrier',{reason:'restart',participants,nonce:nonce()},'lineage-registry');s.phase='draining';s.barrier={ref,reason:'restart',participants,boots:Object.fromEntries(participants.map(id=>[id,this.#byId.get(id)!.boot])),confirmed:[],resume:true,completed:false};}
   for(const p of Object.values(s.pins))if(!['released','cancelled','expired'].includes(p.phase)){p.hold=p.hold||['decision-recorded','delivering'].includes(p.phase);p.phase='cancelling';}return {};},now);
 }

 #issuerObject(o:ObjectRecord){return ['snapshot','checkpoint-prepare','checkpoint-witness'].includes(o.ref.role)||o.role==='checkpoint-issuer'&&o.ref.role==='semantic-result';}
 #registryImage():DurableRegistry{return parsed(durableRegistrySchema,{schema:'osv-mcp.q2.c1.registry.v1',identityDigest:ownedDigest(this.#identity),records:[...this.#records.values()].map(e=>({ref:e.ref,raw:e.raw.toString('base64')})),objects:[...this.#objects.values()].filter(o=>!this.#issuerObject(o)).map(o=>({ref:o.ref,raw:o.raw.toString('base64'),role:o.role}))});}
 #issuerImage():DurableIssuer{return parsed(durableIssuerSchema,{schema:'osv-mcp.q2.c1.issuer.v1',identityDigest:ownedDigest(this.#identity),objects:[...this.#objects.values()].filter(o=>this.#issuerObject(o)).map(o=>({ref:o.ref,raw:o.raw.toString('base64'),role:o.role})),sources:[...this.#sources.values()].map(s=>{const {key,commits,payloads,...metadata}=s.input;return {ref:s.ref,metadata,key:key.toString('base64'),commits:commits.map(b=>b.toString('base64')),payloads:payloads.map(b=>b.toString('base64'))};}),prepares:[...this.#prepares.values()],operations:[...this.#issuerOps].map(([key,entry])=>({key,entry}))});}
 /** Disk-owner startup only. Imported actors/keys/tokens are never restored. */
 async restore(h:CurrentActor,registry:unknown,issuer:unknown,anchor:unknown){
  this.#operator(h);need(this.#config.persistence&&this.#records.size===0&&this.#objects.size===0,'configuration_invalid');
  const r=parsed(durableRegistrySchema,registry),i=parsed(durableIssuerSchema,issuer),a=parsed(durableAnchorSchema,anchor);
  need(r.identityDigest===ownedDigest(this.#identity)&&i.identityDigest===r.identityDigest,'binding_mismatch');
  const decode=(text:string)=>{const b=Buffer.from(text,'base64');need(b.toString('base64')===text,'schema_invalid');return b;};
  for(const o of [...r.objects,...i.objects]){need(!this.#objects.has(o.ref.id),'integrity_invalid');const raw=decode(o.raw),body=this.#verifyEnvelope(raw,o.role,this.#servers.get(o.role)!.publicKey,'server-'+o.role,'reply');need(body.schema==='osv-mcp.q2.c0.object.v1'&&body.objectRole===o.ref.role,'integrity_invalid');this.#objects.set(o.ref.id,{ref:o.ref,raw,body:body.body,role:o.role});this.#objectBytes+=raw.length;this.#get(o.ref,o.ref.role);}
  for(const e of r.records){need(!this.#records.has(e.ref.id),'integrity_invalid');const raw=decode(e.raw);const entry={ref:e.ref,raw,synced:true};this.#readRecord(entry);this.#records.set(e.ref.id,entry);this.#recordBytes+=raw.length;}
  for(const saved of i.sources){need(!this.#sources.has(saved.ref.id),'integrity_invalid');const input={...saved.metadata,key:decode(saved.key),commits:saved.commits.map(decode),payloads:saved.payloads.map(decode)},proof=this.#get(saved.ref,'snapshot');need(input.key.length===32&&same(input.binding,{authorityId:this.#identity.authorityId,lineageId:this.#identity.lineageId,generation:this.#identity.generation,storeEpoch:this.#identity.storeEpoch,profileDigest:this.#identity.profileDigest}),'binding_mismatch');
   const source={ref:saved.ref,input,head:parsed(currentHeadSchema,proof.head),inventory:ownedDigest({commits:input.commits.map(b=>ownedSha256(b)),payloads:input.payloads.map(b=>ownedSha256(b)).sort()})};need(source.inventory===proof.inventory,'integrity_invalid');this.#sources.set(saved.ref.id,source);this.#sourceBytes+=[...input.commits,...input.payloads].reduce((n,b)=>n+b.length,0);this.#replay(source);}
  for(const p of i.prepares){need(!this.#prepares.has(p.ref.id),'integrity_invalid');const {ref,...body}=p;need(same(this.#get(ref,'checkpoint-prepare'),body),'integrity_invalid');this.#source(p.snapshot);this.#prepares.set(ref.id,p);}
  for(const o of i.operations){need(!this.#issuerOps.has(o.key),'integrity_invalid');need(this.#get(o.entry.result,'semantic-result').api===o.entry.api&&o.entry.api==='PrepareCheckpoint','integrity_invalid');this.#issuerOps.set(o.key,o.entry);}
  this.#anchor={revision:a.revision,ref:clone(a.record)};if(a.record){const e=this.#records.get(a.record.id);need(e&&same(e.ref,a.record),'integrity_invalid');this.#state=clone(this.#readRecord(e).state);}
  need(this.#bytes()<=this.#limits.closure&&this.#objects.size<=this.#limits.objects&&this.#records.size<=this.#limits.records&&this.#prepares.size<=this.#limits.prepares&&this.#issuerOps.size<=this.#limits.operations&&Object.keys(this.#state.operations).length<=this.#limits.operations&&Object.keys(this.#state.pins).length<=L.retainedPins,'capacity_exhausted');
  const validateRefs=(value:unknown):void=>{if(Array.isArray(value)){for(const v of value)validateRefs(v);return;}if(!value||typeof value!=='object')return;const o=value as Record<string,unknown>;if(['role','id','sha256','byteLength'].every(k=>Object.hasOwn(o,k))){const ref=parsed(currentRefSchema,o);if(ref.role==='registry-record'){const record=this.#records.get(ref.id);need(record&&same(record.ref,ref),'integrity_invalid');}else this.#get(ref,ref.role);return;}for(const v of Object.values(o))validateRefs(v);};
  for(const e of this.#records.values())validateRefs(this.#readRecord(e));for(const o of this.#objects.values())validateRefs(o.body);
  for(const e of this.#history()){this.#attempts.set(ownedDigest({registry:'registry',incarnation:e.body.state.incarnation,previous:e.body.previous,next:e.ref}),{digest:'restored',record:e.ref});}
  if(this.#state.selected){this.#checkpoint(this.#state.selected.checkpoint);this.#source(this.#state.selected.snapshot);}await this.#config.persistence.verify({revision:this.#anchor.revision,record:clone(this.#anchor.ref)});
  if(a.record)await this.restart(h);
 }
 view(){return clone({...this.#state,controlRevision:this.#anchor.revision,currentRecordRef:this.#anchor.ref,...flags});}
 get metrics(){return Object.freeze({...this.#metrics,retainedBytes:this.#bytes(),records:this.#records.size,objects:this.#objects.size,prepares:this.#prepares.size,completedAPIs:[...this.#completedAPIs].sort(),...flags,nativeTrials:0});}
}
