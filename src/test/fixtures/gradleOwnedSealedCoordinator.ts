/** Q2/B3 disk/Q1 bridge. Harness roles + in-memory registry, NOT authenticated IPC. */
import {z} from 'zod';
import {ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {PrefixContract,prefixIdentitySchema,PREFIX_LIMITS,type PrefixContractConfig,type PrefixHandle} from './gradleOwnedPrefixContract.js';
import {SealedPrefixStore,SealedProviderError,type SealedCandidate} from './gradleOwnedSealedProvider.js';

function need(ok:unknown,reason:string):asserts ok{if(!ok)throw new SealedProviderError(reason);}
const hash=z.string().regex(/^[a-f0-9]{64}$/);
/** Explicitly provisioned test admission. No independent-currentness claim. */
export class PrefixAdmissionFixture{
 #selected:string|null=null;#revision=0;#phase:'idle'|'draining'|'retired'='idle';#available=true;#staged=new Set<string>();
 stage(digest:string){hash.parse(digest);need(this.#phase==='idle'&&this.#staged.size<32,'control_unavailable');this.#staged.add(digest);}
 initialize(digest:string){need(this.#selected===null&&this.#staged.has(digest),'profile_unapproved');this.#selected=digest;this.#staged.delete(digest);this.#revision=1;}
 current(digest:string){need(this.#available&&this.#phase==='idle','control_unavailable');need(this.#selected===digest,'binding_mismatch');return this.#revision;}
 advance(expected:string,next:string){this.current(expected);need(this.#staged.has(next)&&next!==expected,'profile_unapproved');this.#staged.delete(next);this.#selected=next;return ++this.#revision;}
 unavailable(){this.#available=false;}
 freeze(){this.#phase='draining';this.#revision++;}
 finish(){need(this.#phase==='draining','control_unavailable');this.#phase='retired';}
 get evidence(){return Object.freeze({kind:'in-memory-fixture-only',revision:this.#revision,phase:this.#phase,independentRegistryVerified:false,backendEligible:false,physicalDeletionAuthorized:false});}
}
export interface SealedCoordinatorOptions{
 store:SealedPrefixStore;registry?:PrefixAdmissionFixture;identity:PrefixContractConfig['identity'];keyId:string;key:Buffer;
 providerNow:()=>number;readerNow:()=>number;
}
export class SealedPrefixCoordinator{
 readonly #config:SealedCoordinatorOptions;readonly #protocol:PrefixContract;readonly #operator:object;readonly #checkpoint:object;readonly #authority:object;
 #marker:string;#revision:number;#closed=false;#blocked=false;#busy=false;
 #decisionsSeen=new Set<string>();
 #events:{sequence:number;event:string}[]=[];
 private constructor(c:SealedCoordinatorOptions,selected:Awaited<ReturnType<SealedPrefixStore['readSelected']>>,revision:number){
  this.#config=c;this.#marker=selected.markerDigest;this.#revision=revision;
  const identity=prefixIdentitySchema.parse({...c.identity,providerBootId:c.store.view().boot,namespaceGeneration:selected.marker.generation,
   fence:selected.marker.fence,registryRevision:revision});
  const binding=Object.fromEntries(['authorityId','lineageId','storeEpoch','generation','profileDigest'].map(k=>[k,identity[k as keyof typeof identity]]));
  need(ownedDigest({binding,base:identity.baseDigest})===selected.marker.contextDigest,'binding_mismatch');
  this.#protocol=new PrefixContract({...c,identity});this.#operator=this.#protocol.principal('operator');
  this.#checkpoint=this.#protocol.principal('checkpoint');this.#authority=this.#protocol.principal('authority');
  this.#protocol.install(this.#operator,selected.input);
 }
 static async open(c:SealedCoordinatorOptions){
  const config={...c,identity:prefixIdentitySchema.parse(c.identity),key:Buffer.from(c.key)};
  const selected=await config.store.readSelected();need(config.registry instanceof PrefixAdmissionFixture,'control_unavailable');
  return new SealedPrefixCoordinator(config,selected,config.registry.current(selected.markerDigest));
 }
 #stop(){this.#blocked=true;this.#protocol.control(this.#operator,{owner:false});}
 #gate(){
  need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');
  try{need(this.#config.registry!.current(this.#marker)===this.#revision,'generation_changed');}
  catch(error){this.#stop();throw error;}
 }
 #event(event:string){need(this.#events.length<512,'budget_exceeded');this.#events.push({sequence:this.#events.length+1,event});}
 #wire(wire:Buffer){need(Buffer.isBuffer(wire)&&wire.length<=PREFIX_LIMITS.wireBytes,'budget_exceeded');return Buffer.from(wire);}
 async #fresh(){
  try{const view=await this.#config.store.readSelected();this.#gate();need(view.markerDigest===this.#marker,'generation_changed');return view;}
  catch(error){this.#stop();throw error;}
 }
 async #call<T>(event:string,work:(source:Awaited<ReturnType<SealedPrefixStore['readSelected']>>)=>T):Promise<T>{
  this.#gate();need(!this.#busy,'busy');this.#busy=true;
  try{const source=await this.#fresh();this.#gate();const result=work(source);this.#event(event);return result;}finally{this.#busy=false;}
 }
 /** Harness provisioning only; never accepts a UID claim or IPC authentication. */
 reader(peer:{peerId:string;bootId:string}){this.#gate();return this.#protocol.principal('reader',peer);}
 begin(reader:object,operation:string){return this.#call('begin',()=>this.#protocol.begin(reader,operation));}
 acquire(reader:object,wire:Buffer){const bytes=this.#wire(wire);return this.#call('acquire',()=>this.#protocol.acquire(reader,bytes));}
 accept(reader:object,wire:Buffer){const bytes=this.#wire(wire);return this.#call('accept',()=>this.#protocol.accept(reader,bytes));}
 verify(reader:object,ticket:PrefixHandle){return this.#call('verify',source=>this.#protocol.verify(reader,ticket,source.input));}
 startComplete(reader:object,candidate:PrefixHandle){return this.#call('completing',()=>this.#protocol.startComplete(reader,candidate,
  this.#protocol.checkpoint(this.#checkpoint,candidate),this.#protocol.authority(this.#authority,candidate)));}
 async decide(reader:object,wire:Buffer){
  const bytes=this.#wire(wire);this.#gate();need(!this.#busy,'busy');
  // Refuse a new Complete once the use ledger is full, before the protocol records a decision. The grant ID
  // is unauthenticated here and only selects idempotent retries; decide() still authenticates the request.
  let grantId:unknown;try{grantId=JSON.parse(bytes.toString('utf8')).grantId;}catch{grantId=undefined;}
  need(this.#config.store.hasUseCapacity(grantId),'uses_exhausted');this.#busy=true;
  try{
   await this.#fresh();const receipt=this.#protocol.decide(reader,bytes),body=JSON.parse(receipt.toString()).body;
   const receiptDigest=ownedSha256(receipt);if(!this.#decisionsSeen.has(receiptDigest)){this.#event('decision-linearized');this.#decisionsSeen.add(receiptDigest);}
   try{await this.#config.store.recordUse({grantId:body.grantId,useId:body.useId,receiptDigest:ownedSha256(receipt),completeDigest:body.completeDigest,
    readerDigest:ownedDigest(body.reader),identityDigest:ownedDigest(body.identity)});}catch(error){this.#stop();throw error;}
   // Persistence and all final awaits precede the live pin/deadline check. A
   // durable historical decision never revives an expired or revoked use.
   await this.#fresh();this.#gate();const result=this.#protocol.decide(reader,bytes);this.#event('decision-recorded');return result;
  }finally{this.#busy=false;}
 }
 deliver(reader:object,wire:Buffer){const bytes=this.#wire(wire);return this.#call('delivering',()=>this.#protocol.deliver(reader,bytes));}
 publish(reader:object,delivery:PrefixHandle){return this.#call('handoff',()=>this.#protocol.publish(reader,delivery));}
 release(reader:object,delivery:PrefixHandle){return this.#call('release',()=>this.#protocol.release(reader,delivery));}
 status(reader:object,ticket:PrefixHandle){return this.#protocol.status(reader,ticket);}
 disconnect(reader:object){this.#protocol.disconnect(this.#operator,reader);this.#event('disconnect');}
 async publishSnapshot(candidate:SealedCandidate){
  this.#gate();need(!this.#busy,'busy');this.#protocol.assertPublishable(this.#operator);this.#busy=true;
  try{
   await this.#fresh();this.#protocol.assertPublishable(this.#operator);
   const previous=this.#marker;this.#event('snapshot-selection-started');const selection=await this.#config.store.select(candidate);
   this.#gate();const current=await this.#config.store.readSelected();this.#gate();need(selection.markerDigest===current.markerDigest,'binding_mismatch');
   const revision=this.#config.registry!.advance(previous,selection.markerDigest);
   this.#protocol.rotate(this.#operator,{namespaceGeneration:selection.generation,fence:selection.fence,registryRevision:revision});
   this.#protocol.install(this.#operator,current.input);this.#marker=selection.markerDigest;this.#revision=revision;this.#event('snapshot-published');
   return {...selection,backendEligible:false as const,originalReadsSkipped:0 as const};
  }catch(error){this.#stop();throw error;}finally{this.#busy=false;}
 }
 freeze(reason:'freeze'|'cutover'|'gc'|'revoke'){
  need(!this.#closed,'owner_closed');this.#config.registry!.freeze();this.#protocol.drain(this.#operator,reason);this.#event(reason);
 }
 finishBarrier(){need(!this.#busy,'busy');this.#protocol.finishBarrier(this.#operator);this.#config.registry!.finish();this.#event('barrier-finished');return {physicalDeletionAuthorized:false as const,backendEligible:false as const};}
 close(){if(!this.#closed){this.#closed=true;this.#protocol.control(this.#operator,{owner:false});this.#event('owner-close');}}
 get metrics(){return {...this.#protocol.metrics,backendEligible:false as const,originalReadsSkipped:0 as const};}
 get events(){return this.#events.map(e=>({...e}));}
}
