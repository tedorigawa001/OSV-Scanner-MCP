/** C2 orchestration for explicit application-owned clients. All admission flags stay closed. */
import {OwnedCurrentClient,currentOperation} from './gradleOwnedCurrentClient.js';
import {cref,chash,parsed,need,CurrentControlError,type CurrentRef,type CurrentBinding,currentNamespaceSchema,type CurrentNamespace} from './gradleOwnedCurrentSchema.js';
import {replayV2,type V2ReplayInput} from './gradleOwnedJournalV2.js';
import {parseGradleExport,parseGradleExportG0,type GradleExport} from './gradleOwnedManifest.js';
import {ownedSessionSchema,inspectOwnedExecution,type TrustedOwnedCaller} from './gradleOwnedExecution.js';
import {type OwnedPolicy} from './gradleOwnedPolicy.js';
import {type GradleBudget} from './gradleGraph.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256,parseOwnedJson} from './gradleOwnedJson.js';
export {currentNamespaceSchema,type CurrentNamespace} from './gradleOwnedCurrentSchema.js';
export interface CurrentScope {sessionId:string;project:string;context:string;invocation:string;consumerId:string;scanRunId:string;projectRootId:string;settingsDigest:string;manifestDigest:string;coreGraphDigest:string;operationBinding:string;profileId:string;recipeId:string;profileDigest:string;recipeDigest:string}
export interface CurrentProviderClient {
 assertOpen():void;
 prepare(fence:CurrentRef):Promise<{snapshot:CurrentRef}>;
 read(snapshot:CurrentRef,pin:CurrentRef):Promise<{input:V2ReplayInput;namespace:CurrentNamespace}>;
 mirror(snapshot:CurrentRef,pin:CurrentRef):Promise<void>;
 recordUse(value:{grantId:string;useId:string;receiptDigest:string;completeDigest:string;readerDigest:string;identityDigest:string}):Promise<void>;
}
export type CurrentAuthorityProof=Readonly<{kind:'verified-current-authority'}>;
type Facts={pin:CurrentRef;scope:CurrentScope;resultDigest:string;resultBytes:Buffer;authorityTerminalDigest:string;document:GradleExport};
/** Proofs are minted only after full replay, exact source binding and G0/G2 validation. */
export class CurrentAuthorityVerifier {
 readonly #proofs=new WeakMap<CurrentAuthorityProof,Facts>();
 constructor(readonly baseDigest:string,readonly sourceKeyDigest:string){parsed(chash,baseDigest);parsed(chash,sourceKeyDigest);}
 verify(input:V2ReplayInput,selected:NonNullable<CurrentBinding['selected']>,pin:CurrentRef,scope:CurrentScope,policy:OwnedPolicy,budget:GradleBudget){
  need(input.approvedBaseDigest===this.baseDigest&&ownedSha256(input.key)===this.sourceKeyDigest,'binding_mismatch');const result=replayV2({...input,auditAuthoritySnapshot:true});
  need(result.revision===selected.head.revision&&result.commitDigest===selected.head.commitDigest&&result.stateRoot===selected.head.stateRoot&&input.approvedBaseDigest===selected.head.baseDigest,'binding_mismatch');
  const session=result.authorityAudit?.sessions.find(s=>s.manifest.id===scope.sessionId),m=session?.manifest,sc=session?.scopes.find(s=>s.plan.project===scope.project&&s.plan.context===scope.context&&s.plan.invocation===scope.invocation);
  need(session&&m&&sc&&sc.events.some(e=>(parseOwnedJson(e) as any).payload?.kind==='action-start')&&m.validity==='current'&&m.lifecycle==='committed'&&sc.info.validity==='current'&&sc.info.terminal?.outcome==='structure-verified','witness_unavailable');
  for(const key of ['consumerId','scanRunId','projectRootId','settingsDigest','manifestDigest'] as const)need(m[key]===scope[key],'binding_mismatch');need(m.coreDigest===scope.coreGraphDigest&&sc.observation?.lookup.status==='verified','binding_mismatch');for(const key of ['profileId','recipeId','profileDigest','recipeDigest'] as const)need(sc.plan[key]===scope[key],'binding_mismatch');
  const core=session.uploads.find(u=>u.info.id===m.coreRef?.uploadId),projection=session.uploads.find(u=>u.info.id===sc.info.terminal?.sealMetadataRef?.uploadId);need(core?.text&&projection?.text,'witness_unavailable');
  const {coreMetadataRef,...body}=parseOwnedJson(projection.text,64*1024*1024) as any;need(canonicalOwnedJson(coreMetadataRef)===canonicalOwnedJson(m.coreRef),'binding_mismatch');const text=canonicalOwnedJson({...body,coreGraph:parseOwnedJson(core.text)},64*1024*1024),g0=parseGradleExportG0(text);need(g0.executions.length===1,'binding_mismatch');
  const claim=g0.executions[0]!,w=sc.observation.lookup.witness;need(claim.graphId===m.graphId&&claim.exportId===m.exportId&&claim.executionId===m.executionId&&claim.coreGraphDigest===m.coreDigest&&claim.profileId===sc.plan.profileId&&claim.recipeId===sc.plan.recipeId&&claim.profileDigest===sc.plan.profileDigest&&claim.recipeDigest===sc.plan.recipeDigest,'binding_mismatch');need(claim.witnessId===sc.info.witnessId&&claim.project===scope.project&&claim.context===scope.context&&claim.invocation===scope.invocation&&claim.bundleDigest===sc.info.terminal.bundleDigest&&claim.envelopeDigest===sc.info.terminal.envelopeDigest,'binding_mismatch');
  const {profileId:_,recipeId:__,...sessionScope}=sc.plan;
  const authoritySession=ownedSessionSchema.parse({schema:'osv-mcp.gradle-owned-session-v1',authorityId:input.binding.authorityId,sessionId:m.id,nonce:m.nonce,graphId:m.graphId,exportId:m.exportId,executionId:m.executionId,coreGraphDigest:m.coreDigest,rootRegistryDigest:m.rootDigest,isolationEvidenceRef:ownedDigest({domain:'unapproved-c2-authority-projection',manifest:m.manifestDigest}),status:'current',scopes:[sessionScope],leases:sc.observation.leases});
  // authorityPlan carries profileId/recipeId; the session scope deliberately does not.
  const caller:TrustedOwnedCaller={backend:'caller-owned-receipt-store-v1',session:authoritySession,lookup:request=>{need(request.sessionId===m.id&&request.witnessId===w.witnessId&&request.coreGraphDigest===m.coreDigest&&request.rootRegistryDigest===m.rootDigest,'binding_mismatch');return sc.observation!.lookup;}};
  const auth=policy.registry.authorization(claim,policy.settings);need(auth&&inspectOwnedExecution(claim,caller,auth)==='capability_unsupported','witness_unavailable');const parsedDocument=parseGradleExport(text,budget,policy,caller),document={graph:parsedDocument.graph,...(parsedDocument.owned?{owned:parsedDocument.owned}:{})};
  need(document.owned?.manifestStructure==='verified'&&document.owned.executionWitness==='verified','witness_unavailable');const resultDigest=ownedDigest(document),proof=Object.freeze({kind:'verified-current-authority' as const});this.#proofs.set(proof,{pin:structuredClone(pin),scope:structuredClone(scope),resultDigest,resultBytes:Buffer.from(canonicalOwnedJson({resultDigest})),authorityTerminalDigest:ownedDigest(sc.info.terminal),document});return proof;
 }
 inspect(proof:CurrentAuthorityProof){const value=this.#proofs.get(proof);need(value,'gate_invalid');return {...structuredClone({pin:value.pin,scope:value.scope,resultDigest:value.resultDigest,authorityTerminalDigest:value.authorityTerminalDigest,document:value.document}),resultBytes:Buffer.from(value.resultBytes)};}
}
export interface CurrentAuthorityClient {prepare(proof:CurrentAuthorityProof,useId:string):Promise<{gate:CurrentRef;result:CurrentRef}>}
export type CurrentPublication=Readonly<{kind:'current-publication'}>;
export type CurrentRead=Readonly<{kind:'current-read'}>;
type Publication={mode:'genesis'|'advance';fence:CurrentRef;prepared?:{snapshot:CurrentRef};checkpoint?:CurrentRef;selected?:NonNullable<CurrentBinding['selected']>;ids:Record<string,string>;done:boolean};
type Reservation={id:string;role:'operator'|'writer'|'reader';api:'BeginEnrollment'|'ReserveWriter'|'AcquireReadPin';payload:unknown;selection:string};
const RESERVATION_LIMIT=8;
/** Only an unknown outcome keeps a request for its same-ID retry; a decided refusal frees the slot. */
const ambiguous=(e:unknown)=>!(e instanceof CurrentControlError)||e.reason==='response_lost';
type Read={pin:CurrentRef;selected:NonNullable<CurrentBinding['selected']>;witness:CurrentRef;proof:CurrentAuthorityProof;scope:CurrentScope;phase:'active'|'decision-recorded'|'delivering'|'released'|'failed';useId:string;document:GradleExport;gate?:{gate:CurrentRef;result:CurrentRef};receiptDigest?:string;delivery?:CurrentRef};
export class OwnedCurrentBridge {
 readonly #publications=new WeakMap<CurrentPublication,Publication>();readonly #reads=new WeakMap<CurrentRead,Read>();#closed=false;#blocked=false;#busy=false;
 readonly #reservations=new Map<string,Reservation>();
 constructor(readonly client:OwnedCurrentClient,readonly provider:CurrentProviderClient,readonly authority:CurrentAuthorityClient,readonly verifier:CurrentAuthorityVerifier,readonly resolveScope:(file:string)=>CurrentScope,readonly maintenanceOperationBinding:string){parsed(chash,maintenanceOperationBinding);}
 #gate(){need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');this.client.assertOpen();this.provider.assertOpen();}
 async #call(...args:Parameters<OwnedCurrentClient['call']>){this.#gate();const reply=await this.client.call(...args);this.#gate();return reply;}
 async #context(){this.#gate();const context=await this.client.context();this.#gate();return context;}
 async #run<T>(work:()=>Promise<T>){this.#gate();need(!this.#busy,'busy');this.#busy=true;try{return await work();}finally{this.#busy=false;}}
 async #live(pin:CurrentRef){this.#gate();await this.#call('provider','CheckLiveBinding',{target:pin,purpose:'source-read'});this.#gate();}
 // Keep the original intent through ambiguous replies. A different operation cannot replace it.
 async #reserve(intent:unknown,selected:unknown,role:Reservation['role'],api:Reservation['api'],payload:unknown){
  const binding=canonicalOwnedJson(intent),selection=canonicalOwnedJson(selected);
  // A selection change makes an unanswered request unreachable; its lease is left to expire, never renewed.
  for(const [key,r] of this.#reservations)if(r.selection!==selection)this.#reservations.delete(key);
  let pending=this.#reservations.get(binding);
  if(!pending){need(this.#reservations.size<RESERVATION_LIMIT,'capacity_exhausted');pending={id:currentOperation(),role,api,payload:structuredClone(payload),selection};this.#reservations.set(binding,pending);}
  need(pending.role===role&&pending.api===api,'binding_mismatch');
  try{
   const reply=await this.#call(pending.role,pending.api,pending.payload,pending.id,api==='BeginEnrollment');
   const target=api==='BeginEnrollment'?reply.value.provision:api==='ReserveWriter'?reply.value.fence:reply.value.pin;
   await this.#call('provider','CheckLiveBinding',{target,purpose:api==='AcquireReadPin'?'source-read':'checkpoint'});
   this.#reservations.delete(binding);return target as CurrentRef;
  }catch(e){if(!ambiguous(e))this.#reservations.delete(binding);throw e;}
 }
 async #releaseQuietly(pin:CurrentRef){try{await this.#call('reader','ReleaseReadPin',{pin});}catch{/* A revoked or unknown pin is never treated as released. */}}
 async beginPublication(mode:'genesis'|'advance'){return this.#run(async()=>{const context=await this.#context();need(mode==='genesis'?context.selected===null:context.selected!==null,'binding_mismatch');const fence=await this.#reserve({kind:'publication',mode,selected:context.selected},context.selected,mode==='genesis'?'operator':'writer',mode==='genesis'?'BeginEnrollment':'ReserveWriter',mode==='genesis'?{approvedBase:this.verifier.baseDigest}:{expectedSelection:context.selectionRevision});const handle=Object.freeze({kind:'current-publication' as const});this.#publications.set(handle,{mode,fence,ids:{prepare:currentOperation(),publish:currentOperation()},done:false});return handle;});}
 async publish(handle:CurrentPublication){return this.#run(async()=>{const p=this.#publications.get(handle);need(p&&!p.done,'binding_mismatch');
  if(!p.prepared){await this.#call('provider','CheckLiveBinding',{target:p.fence,purpose:'checkpoint'});p.prepared=await this.provider.prepare(p.fence);parsed(cref('snapshot'),p.prepared.snapshot);}
  if(!p.checkpoint)p.checkpoint=(await this.#call('provider','PrepareCheckpoint',{mode:p.mode,fence:p.fence,snapshot:p.prepared.snapshot},p.ids.prepare,true)).value.checkpoint;
  if(!p.selected){const reply=p.mode==='genesis'?await this.#call('operator','ActivateEnrollment',{provision:p.fence,checkpoint:p.checkpoint},p.ids.publish,true):await this.#call('writer','PublishSelection',{fence:p.fence,checkpoint:p.checkpoint},p.ids.publish,true);p.selected=reply.value.selected;need(p.selected&&canonicalOwnedJson(p.selected.snapshot)===canonicalOwnedJson(p.prepared.snapshot)&&canonicalOwnedJson(p.selected.checkpoint)===canonicalOwnedJson(p.checkpoint),'binding_mismatch');}
  await this.#mirror(p.selected);p.done=true;return {selected:structuredClone(p.selected),backendEligible:false as const,originalReadsSkipped:0 as const};});}
 async #mirror(selected:NonNullable<CurrentBinding['selected']>){const context=await this.#context();need(canonicalOwnedJson(context.selected)===canonicalOwnedJson(selected),'binding_mismatch');const pin=await this.#reserve({kind:'mirror',selected},context.selected,'reader','AcquireReadPin',{operationBinding:this.maintenanceOperationBinding});
  try{await this.#live(pin);await this.provider.mirror(selected.snapshot,pin);await this.#live(pin);await this.#call('reader','ReleaseReadPin',{pin});}catch(e){this.#blocked=true;throw e;}}
 async repairMirror(){return this.#run(async()=>{const context=await this.#context();need(context.selected,'control_unavailable');await this.#mirror(context.selected);});}
 async prepareRead(file:string,budget:GradleBudget,policy:OwnedPolicy){return this.#run(async()=>{const scope=structuredClone(this.resolveScope(file));parsed(chash,scope.operationBinding);need(!policy.settings.invalid&&!policy.registry.invalid,'configuration_invalid');need(policy.settings.enabled&&policy.registry.authorization(scope,policy.settings),'profile_unapproved');const context=await this.#context();need(context.selected,'control_unavailable');const pin=await this.#reserve({kind:'read',file,scope,selected:context.selected},context.selected,'reader','AcquireReadPin',{operationBinding:scope.operationBinding});
  try{const cp=await this.#call('reader','ReadCurrentCheckpoint',{pin,checkpoint:context.selected.checkpoint});await this.#live(pin);const source=await this.provider.read(context.selected.snapshot,pin);await this.#live(pin);parsed(currentNamespaceSchema,source.namespace);for(const key of Object.keys(source.input.binding))need((source.input.binding as any)[key]===(context as any)[key],'binding_mismatch');const proof=this.verifier.verify(source.input,context.selected,pin,scope,policy,budget),facts=this.verifier.inspect(proof),handle=Object.freeze({kind:'current-read' as const});await this.#live(pin);this.#reads.set(handle,{pin,selected:context.selected,witness:cp.value.witness,proof,scope,phase:'active',useId:currentOperation(),document:facts.document});return handle;
  }catch(e){await this.#releaseQuietly(pin);throw e;}});}
 async deliverRead(handle:CurrentRead){return this.#run(async()=>{const r=this.#reads.get(handle);need(r?.phase==='active','binding_mismatch');
  // Nothing is written before the first live check, so its refusal fails only this read.
  try{await this.#live(r.pin);}catch(e){r.phase='failed';await this.#releaseQuietly(r.pin);throw e;}
  try{r.gate=await this.authority.prepare(r.proof,r.useId);await this.#live(r.pin);const receipt=await this.#call('authority-broker','PrepareHandoff',{pin:r.pin,witness:r.witness,...r.gate,useId:r.useId});r.phase='decision-recorded';r.receiptDigest=receipt.semanticResultRef?.sha256??ownedDigest(receipt.value);const delivered=await this.#call('authority-broker','DeliverResult',{pin:r.pin,useId:r.useId});r.delivery=delivered.value.delivery;r.phase='delivering';await this.#live(r.pin);
   await this.provider.recordUse({grantId:r.pin.id,useId:r.useId,receiptDigest:r.receiptDigest,completeDigest:ownedDigest({pin:r.pin,witness:r.witness,...r.gate,useId:r.useId}),readerDigest:ownedDigest(r.scope),identityDigest:ownedDigest(r.selected)});await this.#live(r.pin);
  }catch(e){r.phase='failed';this.#blocked=true;throw e;}});}
 async acknowledgeRead(handle:CurrentRead){return this.#run(async()=>{const r=this.#reads.get(handle);need(r?.phase==='delivering'&&r.delivery,'binding_mismatch');await this.#live(r.pin);await this.#call('reader','AcknowledgeDelivery',{pin:r.pin,delivery:r.delivery,effect:null});this.#gate();r.phase='released';return structuredClone(r.document);});}
 async readDocument(file:string,budget:GradleBudget,policy:OwnedPolicy){const handle=await this.prepareRead(file,budget,policy);await this.deliverRead(handle);return this.acknowledgeRead(handle);}
 close(){this.#closed=true;}
 get diagnostics(){return {backendEligible:false,profileApproved:false,independentRegistryVerified:false,originalReadsSkipped:0};}
}
