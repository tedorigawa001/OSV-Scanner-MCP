/** C3b-2 public-record-only Anchor. Never receives an issuer/registry filesystem or secret key. */
import {randomBytes} from 'node:crypto';
import {ownerPlanFacts,validateCredentialRegistry,type OwnerPlan,type OwnedStore,type RoleSigner,type CredentialRegistry,type ServiceIdentity} from './gradleOwnedServiceOwners.js';
import {makeStageCommit,type StageReceipt} from './gradleOwnedServiceStages.js';
import {anchorRequestSchema,anchorResultSchema,anchorImageSchema,anchorHeadSchema,registryRecordSchema,decodeStoredRecord,sameRegistryValue as same,type AnchorHead,type AnchorRequest,type RegistryRecord} from './gradleOwnedRegistrySchema.js';
import {signOwnerValue,verifyOwnerValue} from './gradleOwnedRoleSigner.js';
import {need,parsed,chash} from './gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson,ownedDigest} from './gradleOwnedJson.js';
export interface OwnerEnvironment {now:()=>number;assertOpen:()=>void;credentialCurrent:(identity:ServiceIdentity)=>boolean}
export type RegistryPublicOwner={ownerId:string;storageEpoch:string;instanceId:string};
export const registryAttempt=(body:Omit<RegistryRecord,'attemptId'>)=>ownedDigest({domain:'osv-mcp.q2.c3b.registry-attempt.v1',...body});
export function verifyPublicRegistryRecord(value:{ref:any;wire:string},registry:CredentialRegistry,owner:RegistryPublicOwner,lineage:unknown){
 const envelope=decodeStoredRecord(value),record=parsed(registryRecordSchema,envelope.body),api='control.'+record.api;
 verifyOwnerValue(Buffer.from(value.wire,'base64'),registry,{role:'lineage-registry',instanceId:owner.instanceId,direction:'reply',domain:'control',api,historical:true});
 const {attemptId,...body}=record;need(record.ownerId===owner.ownerId&&record.storageEpoch===owner.storageEpoch&&same(record.lineage,lineage)&&attemptId===registryAttempt(body),'binding_mismatch');return record;
}
function checkStore(plan:OwnerPlan,store:OwnedStore){const c=ownerPlanFacts(plan);need(store.ownerId===c.ownerId&&store.storageEpoch===c.storageEpoch&&same(store.roots,c.roots)&&store.journalKeyId===c.journalKeyId&&store.checkpointKeyId===c.checkpointKeyId,'binding_mismatch');return c;}
export {checkStore as checkOwnerStore};
export class AnchorOwner {
 readonly #config:ReturnType<typeof ownerPlanFacts>;readonly #registry:CredentialRegistry;readonly #plan:OwnerPlan;readonly #store:OwnedStore;readonly #signer:RoleSigner;readonly #registryOwner:RegistryPublicOwner;readonly #env:OwnerEnvironment;
 #closed=false;#blocked=false;#busy=false;#lastNow=-1;#image:ReturnType<typeof anchorImageSchema.parse>={schema:'osv-mcp.q2.c3b.anchor-image.v1',entries:[]};#head:StageReceipt['appliedHead']|null=null;#ledger:StageReceipt[]=[];#cas=0;
 private constructor(o:{plan:OwnerPlan;store:OwnedStore;signer:RoleSigner;registry:CredentialRegistry;registryOwner:RegistryPublicOwner;environment:OwnerEnvironment}){this.#plan=o.plan;this.#config=checkStore(o.plan,o.store);need(this.#config.role==='control-anchor'&&o.signer.identity.credentialId===this.#config.serverCredentialId,'peer_mismatch');this.#store=o.store;this.#signer=o.signer;this.#registry=o.registry;this.#registryOwner={...o.registryOwner};this.#env={...o.environment};}
 static async start(o:{plan:OwnerPlan;store:OwnedStore;signer:RoleSigner;registry:unknown;pins:Parameters<typeof validateCredentialRegistry>[1];registryOwner:RegistryPublicOwner;environment:OwnerEnvironment;floor:AnchorHead}){
  const registry=validateCredentialRegistry(o.registry,o.pins),owner=new AnchorOwner({...o,registry});owner.#gate();const floor=parsed(anchorHeadSchema,o.floor);
  try{const history:any=await o.store.recover();owner.#gate();owner.#head=history.head;owner.#ledger=history.ledger;
   if(history.image!==null)owner.#image=parsed(anchorImageSchema,history.image);
   let current:AnchorHead={revision:0,record:null};const seen=new Set<string>();for(const e of owner.#image.entries){const r=verifyPublicRegistryRecord(e.record,registry,o.registryOwner,owner.#config.lineage);need(!seen.has(e.attemptId)&&same(e.expected,current)&&e.next.revision===current.revision+1&&same(e.next.record,e.record.ref)&&r.revision===e.next.revision&&same(r.previous,current.record)&&r.attemptId===e.attemptId,'integrity_invalid');seen.add(e.attemptId);current=e.next;}
   need(floor.revision===0||owner.#image.entries.some(e=>same(e.next,floor)),'rollback_detected');return owner;
  }catch(e){owner.#blocked=true;throw e;}
 }
 #gate(peer?:ServiceIdentity){need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');this.#store.assertOpen();this.#env.assertOpen();need(this.#env.credentialCurrent(this.#signer.identity)&&(!peer||this.#env.credentialCurrent(peer)),'permission_denied');const now=this.#env.now();need(Number.isSafeInteger(now)&&now>=0&&now>=this.#lastNow,'clock_invalid');this.#lastNow=now;return now;}
 #current():AnchorHead{return structuredClone(this.#image.entries.at(-1)?.next??{revision:0,record:null});}
 // The expected API is taken from a bounded closed schema before signature verification, not used to choose a key.
 async call(wire:Buffer){const {ownerEnvelopeSchema}=await import('./gradleOwnedRegistrySchema.js');const {decodeCurrent}=await import('./gradleOwnedCurrentSchema.js');const raw=parsed(ownerEnvelopeSchema,decodeCurrent(wire,65536));need(raw.api&&['control.anchor.read','control.anchor.cas','control.anchor.query-operation'].includes(raw.api),'permission_denied');this.#gate();need(!this.#busy,'busy');this.#busy=true;try{const envelope=verifyOwnerValue(wire,this.#registry,{role:'lineage-registry',instanceId:this.#registryOwner.instanceId,direction:'request',domain:'control',api:raw.api});return await this.#execute(envelope);}finally{this.#busy=false;}}
 async #execute(envelope:ReturnType<typeof verifyOwnerValue>){
  const peer=envelope.identity,request=parsed(anchorRequestSchema,envelope.body),started=this.#gate(peer);need(same(request.lineage,this.#config.lineage),'binding_mismatch');
  const credential=this.#registry.credentials.find(c=>c.identity.credentialId===peer.credentialId)!;need(credential.permissions.some(p=>p.api==='control.'+request.api&&same(p.lineage,request.lineage)&&(p.delegateInstance===null||p.delegateInstance===this.#config.instanceId)),'permission_denied');
  try{const saved:any=await this.#store.recover();this.#gate(peer);need(same(saved.head,this.#head)&&same(saved.image??{schema:'osv-mcp.q2.c3b.anchor-image.v1',entries:[]},this.#image),'rollback_detected');}catch(e){this.#blocked=true;throw e;}
  let applied:AnchorHead|null=null,attemptId:string|null=null;
  if(request.api==='anchor.cas'){
   const record=verifyPublicRegistryRecord(request.record,this.#registry,this.#registryOwner,this.#config.lineage);attemptId=request.attemptId;
   need(record.attemptId===attemptId&&record.revision===request.expected.revision+1&&same(record.previous,request.expected.record),'binding_mismatch');const old=this.#image.entries.find(e=>e.attemptId===attemptId);
   if(old){need(same(old.expected,request.expected)&&same(old.record,request.record),'idempotency_conflict');applied=old.next;}
   else{need(same(request.expected,this.#current()),'control_conflict');const next:AnchorHead={revision:record.revision,record:request.record.ref},image=parsed(anchorImageSchema,{...this.#image,entries:[...this.#image.entries,{expected:request.expected,next,attemptId,record:request.record}]});
    const operationKey=ownedDigest({domain:'c3b-anchor-cas',ownerId:this.#config.ownerId,attemptId}),requestDigest=ownedDigest({...request,requestId:null}),q=makeStageCommit(this.#plan,{api:'control.anchor.cas',operationKey,requestDigest,stageId:'anchor-adopted',expectedHead:this.#head,previousStageReceipt:null,nextImage:Buffer.from(canonicalOwnedJson(image,8*1024*1024)).toString('base64')});this.#gate(peer);
    try{const receipt:any=await this.#store.commitStageExact(q);this.#gate(peer);this.#head=receipt.appliedHead;this.#ledger.push(receipt);this.#image=image;this.#cas++;applied=next;}catch(e){this.#blocked=true;throw e;}
   }
  }else if(request.api==='anchor.query-operation'){attemptId=request.attemptId;applied=this.#image.entries.find(e=>e.attemptId===attemptId)?.next??null;}
  this.#gate(peer);need(this.#env.now()-started<5000,'request_expired');const response=parsed(anchorResultSchema,{api:request.api,requestDigest:ownedDigest(request),head:this.#current(),applied,attemptId});const reply=await signOwnerValue(this.#plan,this.#signer,'control','control.'+request.api,response);this.#gate(peer);need(this.#env.now()-started<5000,'request_expired');return reply;
 }
 close(){need(!this.#busy,'busy');this.#closed=true;this.#store.close();}
 get diagnostics(){return {scope:'cooperative-local-anchor',cas:this.#cas,revision:this.#current().revision,blocked:this.#blocked,backendEligible:false,independentRegistryVerified:false,originalReadsSkipped:0};}
}
export interface AnchorPort {read():Promise<AnchorHead>;cas(expected:AnchorHead,record:{ref:any;wire:string},attemptId:string):Promise<{head:AnchorHead;applied:AnchorHead|null}>;query(attemptId:string):Promise<{head:AnchorHead;applied:AnchorHead|null}>}
type AnchorIntent = {[A in AnchorRequest['api']]:Omit<Extract<AnchorRequest,{api:A}>,'requestId'>}[AnchorRequest['api']];
export class AnchorClient implements AnchorPort {
 readonly #config:ReturnType<typeof ownerPlanFacts>;readonly #registry:CredentialRegistry;
 constructor(readonly plan:OwnerPlan,readonly signer:RoleSigner,registry:unknown,pins:Parameters<typeof validateCredentialRegistry>[1],readonly transport:{call:(bytes:Buffer)=>Promise<Buffer>},readonly environment:OwnerEnvironment){this.#config=ownerPlanFacts(plan);need(this.#config.role==='lineage-registry'&&signer.identity.credentialId===this.#config.clientCredentialId,'peer_mismatch');this.#registry=validateCredentialRegistry(registry,pins);}
 async #call(intent:AnchorIntent){const request=parsed(anchorRequestSchema,{...intent,requestId:randomBytes(32).toString('hex')});this.environment.assertOpen();need(this.environment.credentialCurrent(this.signer.identity),'permission_denied');const target=this.#config.clients.find(c=>c.role==='control-anchor')!;const wire=await signOwnerValue(this.plan,this.signer,'control','control.'+request.api,request);this.environment.assertOpen();const result=await this.transport.call(wire);this.environment.assertOpen();need(this.environment.credentialCurrent(this.signer.identity),'permission_denied');const envelope=verifyOwnerValue(result,this.#registry,{role:'control-anchor',instanceId:target.instanceId,direction:'reply',domain:'control',api:'control.'+request.api});need(this.environment.credentialCurrent(envelope.identity),'permission_denied');const body=parsed(anchorResultSchema,envelope.body);need(body.api===request.api&&body.requestDigest===ownedDigest(request)&&body.attemptId===(request.api==='anchor.read'?null:request.attemptId),'binding_mismatch');return body;}
 async read(){return (await this.#call({api:'anchor.read',lineage:this.#config.lineage})).head;}
 async cas(expected:AnchorHead,record:{ref:any;wire:string},attemptId:string){return this.#call({api:'anchor.cas',lineage:this.#config.lineage,expected,record,attemptId});}
 async query(attemptId:string){return this.#call({api:'anchor.query-operation',lineage:this.#config.lineage,attemptId:parsed(chash,attemptId)});}
}
