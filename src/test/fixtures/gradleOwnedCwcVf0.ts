/** VF-0 strict standalone fixture. No actual SessionServer association, source IO or production registration. */
import {types} from 'node:util';
import {z} from 'zod';
import {copyData,freezeData,dedicated,ordinaryBuffer,Lb0Budget,LB0_APIS} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Approval} from './gradleOwnedCwcVf0Approval.js';
import {VF0_POLICY,VF0_PHASES,VF0_STATIC,VF0_LIVE,VF0_LAYOUT} from './gradleOwnedCwcVf0Map.js';
import {Vf0Authority,Vf0Clock,stampAuthority,authorityView,authorityReason,sameAuthorityStamp,assertAuthority,readOwnedClock,type VfAuthorityStamp} from './gradleOwnedCwcVf0Authority.js';
import {validateSessionTranscript,inspectStaticSession,validateChallengeExchange,validateChannelFrame,type StaticSession} from './gradleOwnedCprBProtocol.js';
import {validateCredentialRegistry,type ServiceIdentity} from './gradleOwnedCprBOwners.js';
import {verifyOwnerValue} from './gradleOwnedCprBSigner.js';
import {sourceOperationKey} from '../../utils/gradleOwnedSourceSchema.js';
import {keys as rangeKeys} from './gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,cn,chash,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const token=(kind:string)=>Object.freeze({kind});
type Token=ReturnType<typeof token>;type Ticket=ReturnType<Lb0Budget['reserve']>;
type Phase=typeof VF0_PHASES[number];type Mode='full-verify'|'fact-live';
const expectedSchema=z.object({api:z.enum(LB0_APIS),requestId:chash,originDigest:chash,ttlMs:cn.positive().max(4500),deadline:cn.positive(),requestSequence:cn.positive(),replySequence:cn.positive()}).strict();
type Expected=z.infer<typeof expectedSchema>;
export type Vf0Hook=(info:Readonly<{phase:string;edge:string}>)=>unknown;
export type Vf0Options={approval:Vf0Approval;approvalPin:string;budget:Lb0Budget;authority:Vf0Authority;clock:Vf0Clock;mode:Mode;ownership:'owner-notified';gateLimit?:number;registry:unknown;pins:Parameters<typeof validateCredentialRegistry>[1];frames:Buffer[];peer:ServiceIdentity;server:ServiceIdentity;lineage:unknown;endpointId:string;expected:Expected;foreign:(name:string,info:Readonly<{phase:string;edge:string}>)=>unknown};
type Storage={request:Buffer;reply:Buffer;outer:Buffer;inner:Buffer};
type Fact={storage:object;storageEpoch:number;control:object;call:object;association:object;owner:object;scope:object;scopeGeneration:number;callGeneration:number;registry:object;codec:object;command:unknown;k:string;d:string};
const callsites=[...VF0_STATIC,...VF0_LIVE,'fact','association','copy','final-clock','fence','commit'] as const;
export class Vf0Session {
 readonly #o:Vf0Options;readonly #registry:ReturnType<typeof validateCredentialRegistry>;readonly #codec:StaticSession;readonly #peer:ServiceIdentity;readonly #server:ServiceIdentity;readonly #expected:Expected;readonly #lineage:any;
 readonly #base:Ticket;readonly #calls=new Map<object,object>();readonly #scopes=new WeakMap<object,{owner:object;generation:number;open:boolean}>();readonly #pending=new WeakMap<object,{completed:boolean}>();
 readonly call=token('vf0-diagnostic-call');readonly owner=token('vf0-owner');readonly scope=token('vf0-scope');
 readonly #control={};readonly #association={kind:'standalone-diagnostic'};readonly #storageKey={};readonly #stamp:VfAuthorityStamp;
 #storage?:Storage;#fact?:Fact;#command:any;#kd?:{k:string;d:string};#ticket?:Ticket;#baseReleased=false;#captured=false;#sealed=false;#claimed=false;#busy=false;#closed=false;#generation=1;#storageEpoch=1;#scopeGeneration=1;#bound?:Token;#phase='reserved';#reason?:unknown;#failed=false;#last=0;#floor=4500;#readers=0;#bytes=0;#reclaimed=false;#scratchReleased=false;#pendingDispatch=false;#readFault=false;#logical=0;
 readonly #counts=new Uint32Array(VF0_PHASES.length*callsites.length*2);readonly #events:{order:number;name:string;generation:number;readers:number;bytes:number}[]=[];
 readonly #metrics={foreignCallbacks:0,transcripts:0,inputCopies:0,reads:0,full:0,fact:0,live:0,now:0,commands:0,boundIssued:0,publications:0,reclaims:0,late:0,commits:0,privateReferences:0};
 #lastFence:any=null;#guardScopeGeneration?:number;
 constructor(o:Vf0Options){
  Lb0Budget.require(o.budget);Vf0Approval.require(o.approval);assertAuthority(o.authority);readOwnedClock(o.clock);need(this.#counts.byteLength<=VF0_LAYOUT.binding.diagnostics&&64*32<=VF0_LAYOUT.session.metadata,'codec_budget_exceeded');
  need(o.ownership==='owner-notified'&&VF0_POLICY.modes.includes(o.mode)&&Number.isSafeInteger(o.gateLimit??4096)&&(o.gateLimit??4096)>0&&(o.gateLimit??4096)<=4096,'codec_profile_unsupported');
  this.#o=Object.freeze({...o,pins:freezeData(copyData(o.pins,4096))});this.#stamp=stampAuthority(o.authority);this.#base=o.budget.reserve(VF0_POLICY.baseBytes,4096);let scratch:Ticket|undefined;
  try{scratch=o.budget.reserve(VF0_POLICY.constructorBytes);this.#registry=freezeData(validateCredentialRegistry(copyData(o.registry,57344),copyData(o.pins,4096)));this.#peer=freezeData(copyData(o.peer,2048));this.#server=freezeData(copyData(o.server,2048));const peer=this.#registry.credentials.find(c=>c.identity.credentialId===this.#peer.credentialId),server=this.#registry.credentials.find(c=>c.identity.credentialId===this.#server.credentialId);need(peer?.direction==='request'&&server?.direction==='reply'&&same(peer.identity,this.#peer)&&same(server.identity,this.#server),'peer_mismatch');this.#lineage=freezeData(copyData(o.lineage,4096));this.#expected=freezeData(parsed(expectedSchema,copyData(o.expected,4096)));this.#floor=Math.min(4500,this.#expected.deadline);
   need(o.frames.length===4,'schema_invalid');const frames=o.frames.map(x=>{ordinaryBuffer(x,16384);return dedicated(x);});try{this.#metrics.transcripts++;this.#codec=validateSessionTranscript(frames,this.#registry,o.pins,{clientCredentialId:this.#peer.credentialId,serverCredentialId:this.#server.credentialId,endpointId:o.endpointId});}finally{for(const b of frames)b.fill(0);}
   const view=authorityView(o.authority);need(view.registryPin===o.pins.registryDigest&&view.sourcePin===o.approvalPin&&view.profilePin===o.approvalPin,'codec_profile_unsupported');
   this.#scopes.set(this.scope,{owner:this.owner,generation:1,open:true});this.#calls.set(this.call,this.#control);this.#event('reserved');Object.freeze(this);
  }catch(e){o.budget.release(this.#base);throw e;}finally{if(scratch)o.budget.release(scratch);}
 }
 #event(name:string){need(this.#events.length<64,'codec_budget_exceeded');this.#events.push({order:this.#events.length+1,name,generation:this.#generation,readers:this.#readers,bytes:this.#bytes});}
 #note(phase:Phase,site:typeof callsites[number],end=false){const i=VF0_PHASES.indexOf(phase)*callsites.length*2+callsites.indexOf(site)*2+Number(end);this.#counts[i]!++;}
 #invoke<T>(phase:Phase,site:typeof callsites[number],run:()=>T):T{this.#note(phase,site);try{return run();}finally{this.#note(phase,site,true);}}
 #active(g=this.#generation){need(!this.#closed&&this.#calls.get(this.call)===this.#control&&g===this.#generation,this.#reason instanceof CurrentControlError?this.#reason.reason:'owner_closed');if(readOwnedClock(this.#o.clock)>=this.#floor){const e=new CurrentControlError('request_expired');this.#end(e);throw e;}if(this.#busy&&this.#guardScopeGeneration!==undefined)need(this.#scopes.get(this.scope)?.generation===this.#guardScopeGeneration,'owner_closed');}
 #authority(){const s=stampAuthority(this.#o.authority);need(s.epoch===this.#stamp.epoch&&s.revocation===this.#stamp.revocation,authorityReason(this.#o.authority));}
 #foreign(name:string,phase:Phase,edge:string){this.#active();this.#authority();const g=this.#generation,s=stampAuthority(this.#o.authority);this.#metrics.foreignCallbacks++;const v=this.#o.foreign(name,Object.freeze({phase,edge}));this.#active(g);need(sameAuthorityStamp(s,stampAuthority(this.#o.authority)),authorityReason(this.#o.authority));return v;}
 #time(phase:Phase,edge:string){this.#active();this.#metrics.now++;const raw=this.#foreign('now',phase,edge),n=raw===undefined?readOwnedClock(this.#o.clock):raw;need(typeof n==='number'&&Number.isSafeInteger(n)&&n>=this.#last,'clock_invalid');this.#last=n;need(n<this.#floor,'request_expired');return n;}
 #live(phase:Phase){
  this.#invoke(phase,'time-entry',()=>this.#time(phase,'live-entry'));
  this.#invoke(phase,'current',()=>{need(this.#foreign('current',phase,'current')===undefined,'schema_invalid');Vf0Approval.require(this.#o.approval);const v=authorityView(this.#o.authority);need(v.registryPin===this.#o.pins.registryDigest&&v.profilePin===this.#o.approvalPin&&v.sourcePin===this.#o.approvalPin,'codec_profile_unsupported');need(v.callbackPolicy===0,'policy_changed');});
  for(const side of ['peer','server'] as const)this.#invoke(phase,side==='peer'?'credential-peer':'credential-server',()=>{need(this.#foreign('credential-'+side,phase,'credential-'+side)===undefined,'schema_invalid');const v=authorityView(this.#o.authority);need(v[side]&&v[side==='peer'?'peerKeyEpoch':'serverKeyEpoch']===(side==='peer'?this.#peer:this.#server).keyEpoch,'permission_denied');});
  this.#invoke(phase,'purpose',()=>{need(this.#foreign('purpose',phase,'purpose')===undefined,'schema_invalid');need(authorityView(this.#o.authority).purpose==='read','permission_denied');});
  this.#invoke(phase,'permissions',()=>{need(this.#foreign('permissions',phase,'permissions')===undefined,'schema_invalid');const permissions=copyData(authorityView(this.#o.authority).permissions,32768);need(permissions.some(p=>p.api===this.#expected.api&&p.purpose==='read'&&same(p.lineage,this.#lineage)&&(p.delegateInstance===null||p.delegateInstance===this.#server.instanceId)),'permission_denied');});
  this.#invoke(phase,'budget',()=>this.#o.budget.check());this.#invoke(phase,'time-exit',()=>this.#time(phase,'live-exit'));this.#metrics.live++;
 }
 #read<T>(run:(s:Storage)=>T):T{this.#active();need(this.#storage&&!this.#reclaimed,'owner_closed');const g=this.#generation;this.#readers++;this.#metrics.reads++;
  try{if(this.#readFault){this.#readFault=false;this.#event('reader-held');this.#end(new CurrentControlError('request_expired'));this.#event('reader-still-held');}this.#active(g);const v=run(this.#storage);this.#active(g);return v;}finally{this.#readers--;if(this.#closed){this.#event('reader-drained');this.#reclaim();}}
 }
 #static(phase:Phase){this.#metrics.full++;return this.#read(s=>{
  const x=this.#expected,outer=inspectStaticSession(this.#codec);
  const challenge=this.#invoke(phase,'challenge',()=>validateChallengeExchange(s.request,s.reply,this.#codec,{requestId:x.requestId,api:x.api,originDigest:x.originDigest,requestSequence:x.requestSequence,replySequence:x.replySequence,ttlMs:x.ttlMs,purpose:'read',lineage:this.#lineage})).challenge;
  this.#invoke(phase,'channel',()=>validateChannelFrame(s.outer,s.inner,this.#codec,{direction:'request',sequence:x.requestSequence+1,challenge,api:x.api,originDigest:x.originDigest,ttlMs:x.ttlMs,purpose:'read',lineage:this.#lineage}));
  const envelope=this.#invoke(phase,'owner',()=>verifyOwnerValue(s.inner,this.#registry,{role:this.#peer.role,instanceId:this.#peer.instanceId,direction:'request',domain:'aux',api:x.api}));
  return this.#invoke(phase,'identity-command',()=>{need(outer.base.clientCredentialId===this.#peer.credentialId&&outer.base.serverCredentialId===this.#server.credentialId,'peer_mismatch');const command:any=(envelope.body as any).command;need(command&&same(command.peer,this.#peer)&&same(command.lineage,this.#lineage),'source_binding');const kd=x.api==='aux.ReadSourceRanges'?rangeKeys({peer:this.#peer,provider:this.#server,lineage:this.#lineage,manifest:hash(VF0_POLICY),catalog:this.#lineage.profileDigest} as any,command):{k:sourceOperationKey(command),d:hash({domain:'clb0-request',request:command.requestDigest})};if(this.#command)need(same(command,this.#command)&&same(kd,this.#kd),'source_binding');return {command,kd};});
 });}
 #inspect(phase:Phase,reuse:boolean){need(++this.#logical<=(this.#o.gateLimit??4096),'codec_budget_exceeded');this.#o.budget.reserve(0,0,1);this.#invoke(phase,'inspect-clock',()=>this.#time(phase,'inspect-entry'));
  if(reuse&&this.#o.mode==='fact-live'){this.#invoke(phase,'fact',()=>{this.#factBinding(this.#bound!,this.scope);this.#metrics.fact++;});}
  else {const v=this.#static(phase);if(!this.#command){this.#command=freezeData(copyData(v.command,8192));this.#kd=freezeData(v.kd);}}
  this.#live(phase);
 }
 #factBinding(bound:unknown,scope:unknown){const f=this.#fact,s=this.#scopes.get(scope as object);need(f&&bound===this.#bound&&scope===f.scope&&scope===this.scope&&s?.open&&s.owner===this.owner&&s.generation===f.scopeGeneration&&f.control===this.#control&&f.call===this.call&&f.association===this.#association&&f.owner===this.owner&&f.callGeneration===this.#generation&&f.storage===this.#storageKey&&f.storageEpoch===this.#storageEpoch&&f.codec===this.#codec&&f.registry===this.#registry&&f.command===this.#command&&f.k===this.#kd!.k&&f.d===this.#kd!.d,'source_binding');}
 #operation<T>(phase:Phase,body:()=>T,commit:(value:T)=>T=(v)=>v):T{
  this.#active();if(this.#busy){const e=new CurrentControlError('source_binding');this.#end(e);throw e;}this.#busy=true;this.#guardScopeGeneration=this.#scopes.get(this.scope)?.generation;const generation=this.#generation,start=stampAuthority(this.#o.authority);
  try{this.#authority();this.#o.budget.check();const value=body();this.#invoke(phase,'operation-clock',()=>this.#time(phase,'operation-post'));
   this.#invoke(phase,'final-clock',()=>{const n=readOwnedClock(this.#o.clock);need(n>=this.#last,'clock_invalid');need(n<this.#floor,'request_expired');});
   this.#invoke(phase,'fence',()=>{this.#active(generation);this.#authority();need(sameAuthorityStamp(start,stampAuthority(this.#o.authority)),authorityReason(this.#o.authority));});
   // This private commit argument is supplied only by fixed methods below; never by a caller or callback.
   const foreignBefore=this.#metrics.foreignCallbacks;this.#note(phase,'commit');const result=commit(value);this.#metrics.commits++;this.#note(phase,'commit',true);this.#lastFence={phase,generation,epoch:start.epoch,revision:start.revision,after:stampAuthority(this.#o.authority).revision,callbacksAfterFence:this.#metrics.foreignCallbacks-foreignBefore};return result;
  }catch(e){this.#end(e);throw e;}finally{this.#busy=false;this.#guardScopeGeneration=undefined;this.#releaseScratch();}
 }
 #captureStorage(input:unknown){
  need(input&&typeof input==='object'&&!types.isProxy(input)&&Object.getPrototypeOf(input)===Object.prototype,'schema_invalid');const d=Object.getOwnPropertyDescriptors(input);need(Object.keys(d).sort().join(',')==='inner,outer,reply,request'&&Object.values(d).every(v=>'value'in v),'schema_invalid');
  for(const k of ['request','reply','outer','inner'] as const)ordinaryBuffer(d[k]!.value,k==='inner'?8192:16384);
  const s=Object.fromEntries(['request','reply','outer','inner'].map(k=>[k,dedicated(d[k]!.value)])) as Storage;this.#metrics.inputCopies+=4;this.#storage=s;this.#metrics.privateReferences=4;this.#bytes=Object.values(s).reduce((n,b)=>n+b.length,0);need(this.#bytes<=VF0_LAYOUT.call.wire,'codec_budget_exceeded');
 }
 capture(input:unknown){return this.#operation('receive',()=>{
  need(!this.#claimed&&!this.#captured,'call_reused');this.#claimed=true;this.#phase='capturing';
  this.#ticket=this.#o.budget.reserve(VF0_POLICY.callBytes+VF0_POLICY.bindingBytes,12288,57344,57344,true);
  this.#captureStorage(input);
  this.#live('prepare');this.#read(s=>this.#invoke('prepare','challenge',()=>validateChallengeExchange(s.request,s.reply,this.#codec,{requestId:this.#expected.requestId,api:this.#expected.api,originDigest:this.#expected.originDigest,requestSequence:this.#expected.requestSequence,replySequence:this.#expected.replySequence,ttlMs:this.#expected.ttlMs,purpose:'read',lineage:this.#lineage})));this.#live('prepare');this.#invoke('prepare','legacy-post-clock',()=>this.#time('prepare','legacy-operation-post'));
  this.#live('receive');this.#inspect('receive',false);this.#invoke('receive','legacy-post-clock',()=>this.#time('receive','legacy-operation-post'));Vf0Approval.require(this.#o.approval);this.#inspect('begin',false);this.#invoke('begin','legacy-post-clock',()=>this.#time('begin','legacy-operation-post'));this.#captured=true;this.#phase='verified-unbound';this.#event('verified-unbound');return undefined;
 });}
 seal(scope:unknown=this.scope,owner:unknown=this.owner,call:unknown=this.call,associationKind='standalone-diagnostic'){return this.#operation('ready',()=>{need(owner===this.owner&&call===this.call&&associationKind==='standalone-diagnostic'&&this.#calls.get(call as object)===this.#control,'source_binding');need(this.#captured&&this.#phase==='verified-unbound'&&!this.#bound,'source_binding');const s=this.#scopes.get(scope as object);need(scope===this.scope&&s?.open&&s.owner===this.owner,'source_binding');this.#inspect('ready',false);return token('vf0-verification-binding');},bound=>{const s=this.#scopes.get(this.scope)!;this.#fact={storage:this.#storageKey,storageEpoch:this.#storageEpoch,control:this.#control,call:this.call,association:this.#association,owner:this.owner,scope:this.scope,scopeGeneration:s.generation,callGeneration:this.#generation,registry:this.#registry,codec:this.#codec,command:this.#command,k:this.#kd!.k,d:this.#kd!.d};this.#sealed=true;this.#bound=bound;this.#phase='ready';this.#metrics.boundIssued++;this.#event('ready');return bound;});}
 check(bound:unknown=this.#bound,scope:unknown=this.scope,frame?:unknown){return this.#operation('check',()=>{need(frame===undefined,'source_binding');this.#factBinding(bound,scope);this.#phase='checking';this.#inspect('check',true);return undefined;},v=>{this.#phase='ready';return v;});}
 nested(){return this.#operation('check',()=>{this.#factBinding(this.#bound,this.scope);this.#phase='checking';for(let i=0;i<4;i++)this.#inspect('check',true);return undefined;},v=>{this.#phase='ready';return v;});}
 command(bound:unknown=this.#bound,scope:unknown=this.scope){return this.#operation('copy-post',()=>{this.#factBinding(bound,scope);this.#phase='checking';this.#inspect('copy-pre',true);const q=this.#invoke('copy-pre','copy',()=>copyData(this.#command,8192));need(this.#foreign('copy','copy-post','copy')===undefined,'schema_invalid');this.#inspect('copy-post',true);return q;},q=>{this.#phase='ready';this.#metrics.commands++;return q;});}
 closeScope(scope:unknown=this.scope){const s=this.#scopes.get(scope as object);need(s&&scope===this.scope,'source_binding');if(!s.open)return;s.open=false;s.generation++;this.#scopeGeneration++;this.#phase='released';this.#bound=undefined;this.#event('scope-released');}
 finish(){return this.#operation('finish',()=>{need(this.#captured&&this.#sealed,'source_binding');this.#inspect('finish',false);return {api:this.#expected.api,requestDigest:this.#command.requestDigest};},q=>{this.#metrics.publications++;this.#end(undefined,true);return q;});}
 hold(){return this.#operation('check',()=>{this.#factBinding(this.#bound,this.scope);need(!this.#pendingDispatch,'source_binding');this.#inspect('check',true);const p=token('vf0-pending');this.#pending.set(p,{completed:false});this.#pendingDispatch=true;return p;});}
 completePending(p:unknown){const pending=this.#pending.get(p as object);need(pending&&!pending.completed,'source_binding');pending.completed=true;if(this.#closed){this.#metrics.late++;throw this.#reason??new CurrentControlError('owner_closed');}return this.finish();}
 drain(p:unknown){need(this.#pending.has(p as object),'source_binding');this.#pending.delete(p as object);this.#pendingDispatch=false;this.#releaseScratch();}
 tighten(deadline:number){return this.#operation('check',()=>{need(Number.isSafeInteger(deadline)&&deadline<=this.#floor,'request_expired');this.#floor=deadline;return undefined;});}
 expire(){if(!this.#closed&&readOwnedClock(this.#o.clock)>=this.#floor)this.#end(new CurrentControlError('request_expired'));}
 cancel(){this.#end(new CurrentControlError('owner_closed'));}
 rejectReplacement(){this.#active();this.#storageEpoch++;this.#end(new CurrentControlError('source_binding'));throw this.#reason;}
 rejectUnsafePublish(){this.#end(new CurrentControlError('codec_profile_unsupported'));throw this.#reason;}
 faultNextRead(){this.#readFault=true;}
 #end(error?:unknown,success=false){if(this.#closed)return;this.#closed=true;this.#reason=error;this.#failed=!success;this.#generation++;this.#phase=success?'released':'invalid';this.#bound=undefined;const scope=this.#scopes.get(this.scope);if(scope){scope.open=false;scope.generation++;this.#scopeGeneration=scope.generation;}this.#calls.delete(this.call);this.#event(success?'completed':'terminal');this.#event('lookup-removed');this.#reclaim();}
 #reclaim(){if(!this.#closed||this.#readers||this.#reclaimed)return;this.#reclaimed=true;for(const b of Object.values(this.#storage??{}))b.fill(0);this.#storage=undefined;this.#fact=undefined;this.#command=undefined;this.#metrics.privateReferences=0;const bytes=this.#bytes;this.#bytes=0;if(this.#ticket)this.#o.budget.release(this.#ticket,bytes);this.#metrics.reclaims++;this.#event('bytes-reclaimed');this.#releaseScratch();}
 #releaseScratch(){if(this.#scratchReleased||!this.#reclaimed||this.#pendingDispatch||this.#busy)return;this.#scratchReleased=true;if(this.#ticket){this.#o.budget.release(this.#ticket);this.#o.budget.endSlot(this.#ticket);}if(!this.#baseReleased){this.#baseReleased=true;this.#o.budget.release(this.#base);}}
 close(){this.#end(new CurrentControlError('owner_closed'));this.#releaseScratch();}
 stats(){const observed:Record<string,{entered:number;settled:number}>={};for(const p of VF0_PHASES)for(const site of callsites){const i=VF0_PHASES.indexOf(p)*callsites.length*2+callsites.indexOf(site)*2;if(this.#counts[i]||this.#counts[i+1])observed[p+'|'+site]={entered:this.#counts[i]!,settled:this.#counts[i+1]!};}return copyData({mode:this.#o.mode,association:'standalone-diagnostic',phase:this.#phase,generation:this.#generation,storageEpoch:this.#storageEpoch,scopeGeneration:this.#scopeGeneration,lookup:this.#calls.has(this.call),claimed:this.#claimed,captured:this.#captured,sealed:this.#sealed,readers:this.#readers,bytes:this.#bytes,reclaimed:this.#reclaimed,scratchReleased:this.#scratchReleased,pending:this.#pendingDispatch,logicalChecks:this.#logical,gateLimit:this.#o.gateLimit??4096,reason:this.#failed?(this.#reason instanceof CurrentControlError?this.#reason.reason:'experiment_error'):null,metrics:{...this.#metrics},observed,events:this.#events,lastFence:this.#lastFence,budget:this.#o.budget.stats(),layout:VF0_LAYOUT},65536);}
}
