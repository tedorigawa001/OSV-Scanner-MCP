/** VF-3 transport-side composition of the existing SessionServer and CLB controller.
 * One business RPC per channel is intentional: no synthetic sequence rebasing or lifetime extension.
 * This adapter owns no service key and cannot replace the SessionServer final validator/signer.
 */
import {Vf3SpendWitness} from './gradleOwnedCwcVf3Spend.js';
import {CwcLb0Session,type Lb0Call,type CwcLb1Binding} from './gradleOwnedCwcLb0.js';
import {Lb0Budget,type Lb0Mode,copyData,dedicated} from './gradleOwnedCwcLb0Contract.js';
import {Vf3Approval} from './gradleOwnedCwcVf3Approval.js';
import {LB2_POLICY} from './gradleOwnedCwcLb2Approval.js';
import {Vf1Owner} from './gradleOwnedCwcVf1Contract.js';
import {type Vf0Authority,type Vf0Clock} from './gradleOwnedCwcVf0Authority.js';
import {inspectAuthenticatedCall,bindAuthenticatedVerificationOwner,consumeVerifiedClientRead,noteAuthenticatedNoEffect,noteAuthenticatedEffect,type AuthenticatedSessionCall,type SessionPacket,SessionReadLifecycle,SessionServer,type SessionClient} from './gradleOwnedCprBSession.js';
import {validateSessionTranscript,validateChannelFrame,inspectStaticSession,type StaticSession} from './gradleOwnedCprBProtocol.js';
import {verifyOwnerValue} from './gradleOwnedCprBSigner.js';
import {type CredentialRegistry} from './gradleOwnedCprBOwners.js';
import {type CprContext,same,keys as planKeys} from './gradleOwnedCprASchema.js';
import {type CwcCProvider} from './gradleOwnedCwcCProvider.js';
import {need,decodeCurrent,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
import {sourceOperationKey} from '../../utils/gradleOwnedSourceSchema.js';
import {ownedSha256 as sha,ownedDigest as digest} from '../../utils/gradleOwnedJson.js';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};}
type Spent={initialization:number;work:number;wire:number;attempts:number};
const spent=(b:ReturnType<Lb0Budget['stats']>):Spent=>({initialization:b.initialization,work:b.work,wire:b.wire,attempts:b.attempts});
type Reservation={order:number;count:number;bytes:number;initialization:number;work:number;wire:number;slot:boolean;before:Spent;after:Spent};
/** Observe the actual accepted reservations, without changing their tickets, gates or balances. */
class ObservedBudget extends Lb0Budget{
 // Capture accepted unit-work debits independently of the compact reservation log.
 // All arms pay this same numeric observation cost inside T_total; it is not an
 // independent service attestation and never replaces the actual Session witness.
 readonly #reservations:Reservation[]=[];#logicalWork=0;
 override reserve(...args:Parameters<Lb0Budget['reserve']>){const before=spent(this.stats()),ticket=super.reserve(...args);const logical=args[0]===0&&(args[1]??0)===0&&args[2]===1&&(args[3]??0)===0&&!args[4],last=this.#reservations.at(-1);if(logical)this.#logicalWork++;if(logical&&last?.bytes===0&&last.initialization===0&&last.work===1&&last.wire===0&&!last.slot){last.count++;last.after=spent(this.stats());}else{need(this.#reservations.length<64,'capacity_exhausted');this.#reservations.push({order:this.#reservations.length+1,count:1,bytes:args[0],initialization:args[1]??0,work:args[2]??0,wire:args[3]??0,slot:args[4]??false,before,after:spent(this.stats())});}return ticket;}
 get reservationCount(){return this.#reservations.length;}
 get logicalWork(){return this.#logicalWork;}
 reservations(from:number,to=this.#reservations.length){return structuredClone(this.#reservations.slice(from,to));}
}
type GateReceipt={schema:'cwc-vf3.gate-work.v1';budgetKey:string;before:number;after:number};
type Accounting={schema:'cwc-vf2.consumption.v1';budgetKey:string;before:Spent;captured:Spent;after?:Spent;reservationStart:number;reservations?:Reservation[];input:{inner:number;outer:number;challengeRequest:number;challengeReply:number}};
type Config={sourceSpend:Vf3SpendWitness;deadline:number;phaseLog:string[];approval:Vf3Approval;authority:Vf0Authority;clock:Vf0Clock;verificationMode:Vf1Owner['mode'];lifecycle:SessionReadLifecycle;mode:Lb0Mode;registry:CredentialRegistry;pins:any;context:CprContext;server:SessionServer;now:()=>number;current:()=>void;purpose:()=>string;credentialCurrent:()=>boolean};
type Run={gateBefore:number;gateReceipt?:GateReceipt;operationKey:string;providerReplyBytes:number;sourceAccounting?:any;sourceBefore:any;rowBefore:any;phaseStart:number;provider?:CwcCProvider;clientState:'waiting'|'checking'|'accepted'|'refused';clientChecks:number;real:AuthenticatedSessionCall;id:number;api:string;session:CwcLb0Session;call:Lb0Call;binding:CwcLb1Binding;budget:ObservedBudget;accounting:Accounting;ready:ReturnType<typeof deferred<Buffer>>;transport:ReturnType<typeof deferred<void>>;done:Promise<unknown>;returned:boolean;providerError?:unknown;wire?:Buffer;actual?:AuthenticatedSessionCall;events:string[];outcome?:string;finalChecks:number;bytesAtFinal:number;replyDigest?:string;callBinding?:string};
type Channel={open:boolean;frames:Buffer[];codec?:StaticSession;challengeRequest?:Buffer;challengeReply?:Buffer;packet?:SessionPacket;run?:Run};
export class Vf3Link{
 readonly #o:Config;#channel?:Channel;readonly #runs:Run[]=[];readonly #budgets=new Map<string,ObservedBudget>();#unfinished=0;
 constructor(o:Config){Vf3SpendWitness.require(o.sourceSpend);Vf3Approval.require(o.approval);this.#o=o;}
 open(){this.#sweep();need(this.#unfinished===0,'operation_busy');this.closeChannel();this.#channel={open:true,frames:[]};}
 request(packet:SessionPacket){const c=this.#channel;need(c?.open,'session_closed');const m:any=decodeCurrent(packet.wire);if(m.body.kind==='client-hello'||m.body.kind==='client-proof')c.frames.push(dedicated(packet.wire));else if(m.body.kind==='challenge-request')c.challengeRequest=dedicated(packet.wire);else if(m.body.kind==='channel'){need(!c.run,'operation_busy');c.packet={wire:dedicated(packet.wire),inner:packet.inner&&dedicated(packet.inner)};}}
 #current(c:Channel,r?:Run,api?:string){const o=this.#o;o.approval.assertCurrent();o.current();need(c.open&&!o.server.closed,'session_closed');o.server.gate();const peer=o.server.registry.credentials.find(v=>v.identity.credentialId===o.context.peer.credentialId)!;need(o.server.permitAPI(peer,api??c.run?.api??'aux.ReadSourceRanges')==='read','permission_denied');if(r?.actual&&r.wire&&!r.returned)inspectAuthenticatedCall(r.actual,r.wire);}
 async dispatch(wire:Buffer,actual:AuthenticatedSessionCall,provider:CwcCProvider,afterProvider?:()=>void|Promise<void>,fault?:'refused'|'unknown'){
  const o=this.#o,c=this.#channel;need(c?.open&&c.packet?.inner&&c.challengeRequest&&c.challengeReply&&c.frames.length===4&&!c.run&&this.#unfinished===0,'source_binding');
  const authenticated=inspectAuthenticatedCall(actual,wire);need(same(authenticated.peer,o.context.peer)&&same(authenticated.server,o.context.provider)&&sha(wire)===sha(c.packet.inner),'source_binding');noteAuthenticatedNoEffect(actual);
  const q:any=(verifyOwnerValue(wire,o.registry,{role:o.context.peer.role,instanceId:o.context.peer.instanceId,direction:'request',domain:'aux',api:authenticated.api}).body as any).command;
  const request:any=(decodeCurrent(c.challengeRequest) as any).body,reply:any=(decodeCurrent(c.challengeReply) as any).body;
  let budget=this.#budgets.get(q.requestDigest);if(!budget){need(this.#budgets.size<LB2_POLICY.maximumOperations,'slot_budget');budget=new ObservedBudget();this.#budgets.set(q.requestDigest,budget);}need(this.#runs.length<128,'capacity_exhausted');
  const gateBefore=budget.logicalWork,before=spent(budget.stats()),reservationStart=budget.reservationCount,input={inner:c.packet.inner.length,outer:c.packet.wire.length,challengeRequest:c.challengeRequest.length,challengeReply:c.challengeReply.length};
  let r:Run|undefined;
  const owner=new Vf1Owner({mode:o.verificationMode,authority:o.authority,clock:o.clock,approval:o.approval.vf1,approvalPin:o.approval.vf1Pin,registryPin:o.pins.registryDigest,hook:site=>{if(site==='open')this.#current(c,r,authenticated.api);}});
  bindAuthenticatedVerificationOwner(actual,owner);
  const session=new CwcLb0Session({approval:o.approval.transport.base.view,connectedApproval:o.approval.transport.connected,budget,mode:o.mode,registry:o.registry,pins:o.pins,frames:c.frames,clientCredentialId:o.context.peer.credentialId,serverCredentialId:o.context.provider.credentialId,endpointId:o.context.endpointId,lineage:o.context.lineage,verification:owner,environment:owner.environment});
  try{
   const pending=session.prepareChallenge(c.challengeRequest,c.challengeReply,{api:authenticated.api,requestId:request.requestId,originDigest:request.originDigest,ttlMs:request.ttlMs,deadline:Math.min(authenticated.deadline,o.deadline),requestSequence:request.sequence,replySequence:reply.sequence});
   const call=session.receive(pending,{outer:c.packet.wire,inner:c.packet.inner}),binding=session.connected(call),ready=deferred<Buffer>(),transport=deferred<void>();
   r={gateBefore,operationKey:q.api==='aux.ReadSourceRanges'?planKeys(o.context,q).k:sourceOperationKey(q),providerReplyBytes:0,sourceBefore:{...provider.metrics},rowBefore:null,phaseStart:o.phaseLog.length,provider,clientState:'waiting',clientChecks:0,real:actual,id:this.#runs.length+1,api:q.api,session,call,binding,budget,accounting:{schema:'cwc-vf2.consumption.v1',budgetKey:q.requestDigest,before,captured:spent(budget.stats()),reservationStart,input},ready,transport,done:Promise.resolve(),returned:false,actual,wire:dedicated(wire),events:['authenticated','captured'],finalChecks:0,bytesAtFinal:0};c.run=r;this.#releaseCapture(c);this.#runs.push(r);this.#unfinished++;
   const run=r;run.rowBefore=provider.rows.find(row=>row.k===run.operationKey)??null;
   run.done=session.dispatchConnected(call,async()=>{
    try{o.sourceSpend.begin(run.operationKey);if(fault){if(fault==='unknown')noteAuthenticatedEffect(actual);throw new CurrentControlError(fault==='unknown'?'response_lost':'permission_denied');}
     const inner=await provider.execute(wire,call,binding);run.providerReplyBytes=inner.length;run.events.push('provider-returned');await afterProvider?.();run.returned=true;run.actual=undefined;run.wire?.fill(0);run.wire=undefined;ready.resolve(inner);await transport.promise;return {api:q.api,requestDigest:q.requestDigest,replyDigest:run.replyDigest!};
    }catch(e){run.providerError=e;ready.reject(e);throw e;}finally{run.sourceAccounting={spend:o.sourceSpend.end(run.operationKey),before:run.sourceBefore,after:{...provider.metrics},rowBefore:run.rowBefore,rowAfter:provider.rows.find(row=>row.k===run.operationKey)??null,phases:o.phaseLog.slice(run.phaseStart)};}
   });
   void run.done.catch(e=>ready.reject(e)).finally(()=>{run.events.push('binding-settled');});
   // The dispatch response can settle on timeout before its actual continuation drains.
   // Drain tracking is completed by settle(), never by returning capacity on response alone.
   return await ready.promise;
  }catch(e){if(!r)session.close();throw e;}
 }
 async reply(request:SessionPacket,reply:SessionPacket,hook?:()=>void|Promise<void>){const c=this.#channel;need(c?.open,'session_closed');const m:any=(decodeCurrent(reply.wire) as any).body;
  if(m.kind==='server-hello'||m.kind==='ready'){c.frames.push(dedicated(reply.wire));if(m.kind==='ready')c.codec=validateSessionTranscript(c.frames,this.#o.registry,this.#o.pins,{clientCredentialId:this.#o.context.peer.credentialId,serverCredentialId:this.#o.context.provider.credentialId,endpointId:this.#o.context.endpointId});return;}
  if(m.kind==='challenge'){c.challengeReply=dedicated(reply.wire);return;}
  const r=c.run;need(r&&reply.inner&&c.codec,'source_binding');const req:any=(decodeCurrent(request.wire) as any).body;
  // SessionServer already ran its own original inspect + owner verifier + signer.
  // Independently verify the actual returned packet before releasing the CLB wait.
  const validated=validateChannelFrame(reply.wire,reply.inner,c.codec,{direction:'reply',sequence:2,challenge:req.challenge,api:req.api,originDigest:req.originDigest,ttlMs:req.ttlMs,purpose:'read',lineage:this.#o.context.lineage});
  const body:any=verifyOwnerValue(reply.inner,this.#o.registry,{role:this.#o.context.provider.role,instanceId:this.#o.context.provider.instanceId,direction:'reply',domain:'aux',api:req.api}).body;
  const facts=inspectStaticSession(c.codec);r.callBinding=digest({domain:'cwc-vf2.verified-call.v1',sessionId:facts.sessionId,transcriptDigest:facts.transcriptDigest,challenge:req.challenge,api:req.api,originDigest:req.originDigest,replySequence:2,innerWireDigest:validated.innerWireDigest});
  r.finalChecks++;r.bytesAtFinal=r.session.stats(r.call).bytesHeld;r.replyDigest=sha(reply.inner);r.events.push('transport-final');await hook?.();this.#current(c);
  if(body.schema==='osv-mcp.q2.c3b.business-outcome.v1'){
   // These are the original authenticated service classifications, never inferred
   // from binding invalidation. A refused/unknown outcome is not a successful read.
   r.outcome=body.outcome;r.session.cancel(r.call);r.transport.reject(new CurrentControlError(body.reason));await r.done.catch(()=>{});
  }else{need(r.returned&&!r.providerError,'source_binding');r.events.push('await-client-verification');}
  await this.settle();
 }
 async acceptClient(client:SessionClient,body:object){const c=this.#channel,r=c?.run;need(c?.open&&r&&r.returned&&r.replyDigest&&r.callBinding&&r.finalChecks===1&&r.clientChecks===0&&r.outcome===undefined,'source_binding');if(r.clientState!=='waiting'){r.clientState='refused';this.#o.lifecycle.close();this.refuse(new CurrentControlError('source_binding'));need(false,'source_binding');}r.clientState='checking';try{this.#current(c);consumeVerifiedClientRead(client,body,this.#o.lifecycle,r.accounting.budgetKey,r.replyDigest,r.callBinding);this.#current(c);need(r.clientState==='checking','source_binding');r.clientChecks=1;r.clientState='accepted';r.events.push('client-verified');r.transport.resolve();await r.done;r.events.push('transport-released');await this.settle();}catch(e){r.clientState='refused';this.refuse(e);throw e;}}

 #releaseCapture(c:Channel){for(const b of c.frames)b.fill(0);c.frames=[];c.packet?.wire.fill(0);c.packet?.inner?.fill(0);c.packet=undefined;c.challengeRequest?.fill(0);c.challengeReply?.fill(0);c.challengeRequest=undefined;c.challengeReply=undefined;}
 #releaseLiveWire(r:Run){r.wire?.fill(0);r.wire=undefined;r.actual=undefined;}
 invalidate(reason='owner_closed'){const r=this.#channel?.run;if(r){r.session.cancel(r.call);this.#releaseLiveWire(r);r.ready.reject(new CurrentControlError(reason));r.transport.reject(new CurrentControlError(reason));}}
 refuse(error:unknown){const r=this.#channel?.run;if(r){r.session.cancel(r.call);this.#releaseLiveWire(r);r.ready.reject(error);r.transport.reject(error);}}
 closeChannel(){const c=this.#channel;if(!c)return;c.open=false;const r=c.run;if(r){r.events.push('channel-closed');r.session.close();this.#releaseLiveWire(r);r.ready.reject(new CurrentControlError('session_closed'));r.transport.reject(new CurrentControlError('session_closed'));}this.#releaseCapture(c);}
 #sweep(){for(const r of this.#runs)if(!r.events.includes('drained')&&!r.session.stats(r.call).pendingDispatch){r.events.push('drained');this.#releaseLiveWire(r);r.gateReceipt={schema:'cwc-vf3.gate-work.v1',budgetKey:r.accounting.budgetKey,before:r.gateBefore,after:r.budget.logicalWork};r.accounting.after=spent(r.budget.stats());r.accounting.reservations=r.budget.reservations(r.accounting.reservationStart);this.#unfinished--;}}
 async settle(){for(let i=0;i<64;i++){this.#sweep();if(this.#unfinished===0)return;await Promise.resolve();}}
 get approvalRecord(){return copyData(this.#o.approval.record);}
 get diagnostics(){return this.#runs.map(r=>({gateReceipt:structuredClone(r.gateReceipt??{schema:'cwc-vf3.gate-work.v1',budgetKey:r.accounting.budgetKey,before:r.gateBefore,after:r.budget.logicalWork}),id:r.id,api:r.api,operationKey:r.operationKey,providerReplyBytes:r.providerReplyBytes,sourceAccounting:structuredClone(r.sourceAccounting??{before:r.sourceBefore,after:{...r.provider!.metrics},rowBefore:r.rowBefore,rowAfter:r.provider!.rows.find(row=>row.k===r.operationKey)??null,phases:this.#o.phaseLog.slice(r.phaseStart)}),actualControl:this.#o.lifecycle.forCall(r.real),accounting:structuredClone({...r.accounting,reservations:r.accounting.reservations??r.budget.reservations(r.accounting.reservationStart)}),ownedTransportBytes:r.wire?.length??0,events:[...r.events],outcome:r.outcome??null,clientState:r.clientState,clientChecks:r.clientChecks,finalChecks:r.finalChecks,bytesAtFinal:r.bytesAtFinal,replyDigest:r.replyDigest??null,callBinding:r.callBinding??null,control:r.session.stats(r.call),budget:r.budget.stats(),binding:r.binding.diagnostics}));}
 get unfinished(){return this.#unfinished;}
 get currentSession(){return this.#channel?.run?.session;}
 get currentCall(){return this.#channel?.run?.call;}
}
