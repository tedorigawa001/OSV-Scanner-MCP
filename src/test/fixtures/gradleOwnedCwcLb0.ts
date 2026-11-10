/** CLB-0 retains full verification by default; CLB-1 separately approves the connected opt-in port.
 * Signed-input fixture only: no live SessionServer, external SourceOwner/storage or performance claim. */
import {z} from 'zod';
import {types} from 'node:util';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,cn,chash,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
import {currentLineageSchema} from '../../utils/gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema,credentialSchema,validateCredentialRegistry,type ServiceIdentity,type CredentialRegistry} from './gradleOwnedCprBOwners.js';
import {validateSessionTranscript,inspectStaticSession,validateChallengeExchange,validateChannelFrame,type StaticSession} from './gradleOwnedCprBProtocol.js';
import {verifyOwnerValue} from './gradleOwnedCprBSigner.js';
import {sourceOperationKey} from '../../utils/gradleOwnedSourceSchema.js';
import {keys as rangeKeys,context as parsedContext,type CprCommand,type CprContext} from './gradleOwnedCprASchema.js';
import {Lb1Approval,LB1_POLICY} from './gradleOwnedCwcLb1Approval.js';
import {CwcCProvider,type CwcCProviderRow} from './gradleOwnedCwcCProvider.js';
import {CwcCReadScope} from './gradleOwnedCwcC.js';
import {LB0_POLICY,LB0_APIS,LB0_MODES,Lb0Approval,Lb0Budget,copyData,freezeData,dedicated,ordinaryBuffer,type Lb0Mode} from './gradleOwnedCwcLb0Contract.js';

type Token<K extends string>=Readonly<{kind:K}>;
export type Lb0Call=Token<'clb0-authenticated-call'>;
export type Lb0Owner=Token<'clb0-owner'>;export type Lb0Scope=Token<'clb0-scope'>;
export type Lb0Draft=Token<'clb0-draft'>;export type Lb0Bound=Token<'clb0-bound'>;
export type Lb0Pending=Token<'clb0-pending'>;export type Lb0Row=Token<'clb0-operation-row'>;
const token=<K extends string>(kind:K):Token<K>=>Object.freeze({kind});
type Ticket=ReturnType<Lb0Budget['reserve']>;
type Event={order:number;name:string;readers:number;generation:number;bytes:number};
type Binding={c:Control;owner:Lb0Owner;scope?:Lb0Scope;row?:Row;projection?:Projection;state:'constructing'|'ready'|'checking'|'closed';generation:number;ticket?:Ticket};
type Row={c:Control;k:string;d:string;deadline:number;state:'admitted'|'complete'|'retired'};
type Frame={c:Control;b:Binding;generation:number;active:boolean};
type Storage={request?:Buffer;reply?:Buffer;inner?:Buffer;outer?:Buffer};
type Control={call:Lb0Call;state:'active'|'closed';generation:number;reason?:unknown;failure:boolean;phase:'prepared'|'issued';busy:boolean;started:boolean;issuedPurpose:'read';api:typeof LB0_APIS[number];deadline:number;last:number;
 expectation:PendingExpectation;storage?:Storage;bytes:number;readers:number;reclaimed:boolean;ticket:Ticket;scratchReleased:boolean;slotReleased:boolean;claim?:Lb0Owner;b?:Binding;admission?:any;row?:Row;
 timer?:ReturnType<typeof setTimeout>;pendingDispatch:boolean;dispatchStarted:boolean;boundReady:boolean;connectedClaim?:boolean;settle?:{resolve:(v:unknown)=>void;reject:(e:unknown)=>void};fault?:'read-expire';
 events:Event[];metrics:{fullChecks:number;wireIdentityHashes:number;challengeChecks:number;channelChecks:number;ownerChecks:number;liveChecks:number;purposeChecks:number;credentialChecks:number;copies:number;lookups:number;reclaims:number;byteReleases:number;publications:number;late:number}};
const pendingSchema=z.object({api:z.enum(LB0_APIS),requestId:chash,originDigest:chash,ttlMs:cn.positive().max(4500),deadline:cn.positive(),requestSequence:cn.positive(),replySequence:cn.positive()}).strict();
type PendingExpectation=z.infer<typeof pendingSchema>;
const projectionSchema=z.object({peer:serviceIdentitySchema,server:serviceIdentitySchema,api:z.enum(LB0_APIS),purpose:z.literal('read'),actor:z.literal('provider')}).strict();
type Projection=z.infer<typeof projectionSchema>;
export type Lb0Environment={now:()=>number;assertOpen:()=>void;credentialCurrent:(identity:Readonly<ServiceIdentity>)=>boolean;purpose:(api:string)=>string;permissions:(identity:Readonly<ServiceIdentity>)=>unknown};
type Options={approval:Lb0Approval;connectedApproval?:Lb1Approval;budget:Lb0Budget;mode:Lb0Mode;registry:unknown;pins:Parameters<typeof validateCredentialRegistry>[1];frames:readonly Buffer[];clientCredentialId:string;serverCredentialId:string;endpointId:string;lineage:unknown;environment:Lb0Environment};
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);

export class CwcLb0Session{
 readonly #connectedApproval?:Lb1Approval;
 readonly #approval:Lb0Approval;readonly #budget:Lb0Budget;readonly #mode:Lb0Mode;readonly #registry:CredentialRegistry;readonly #session:StaticSession;
 readonly #peer:ServiceIdentity;readonly #server:ServiceIdentity;readonly #peerView:ServiceIdentity;readonly #serverView:ServiceIdentity;readonly #lineage:z.infer<typeof currentLineageSchema>;readonly #env:Lb0Environment;readonly #created:number;readonly #base:Ticket;
 #open=true;#channelOpen=true;#closed=false;#last=0;#receiveSequence=0;#sendSequence=0;#ownersCreated=0;#scopesCreated=0;#requests=0;#preparing=false;
 readonly #calls=new Map<Lb0Call,Control>();readonly #all=new WeakMap<Lb0Call,Control>();readonly #pending=new WeakMap<Lb0Pending,Control>();readonly #controls=new Set<Control>();
 readonly #owners=new WeakSet<Lb0Owner>();readonly #scopes=new WeakMap<Lb0Scope,{owner:Lb0Owner;open:boolean;b?:Binding}>();readonly #drafts=new WeakMap<Lb0Draft,Binding>();readonly #bounds=new WeakMap<Lb0Bound,Binding>();readonly #rows=new WeakMap<Lb0Row,Row>();readonly #frames=new WeakSet<Frame>();
 constructor(o:Options){
  Lb0Budget.require(o.budget);if(o.connectedApproval)Lb1Approval.require(o.connectedApproval);this.#connectedApproval=o.connectedApproval;this.#budget=o.budget;this.#base=o.budget.reserve(o.connectedApproval?LB1_POLICY.sessionBytes:LB0_POLICY.baseBytes,4096);
  let construction:Ticket|undefined;
  try{
   if(o.connectedApproval)construction=this.#budget.reserve(LB1_POLICY.constructorBytes);
   Lb0Approval.require(o.approval);need(LB0_MODES.includes(o.mode),'codec_profile_unsupported');this.#approval=o.approval;this.#mode=o.mode;
   this.#env=Object.freeze({...o.environment});for(const fn of Object.values(this.#env))need(typeof fn==='function','configuration_invalid');
   this.#registry=freezeData(validateCredentialRegistry(copyData(o.registry,o.connectedApproval?LB1_POLICY.registryBytes:65536),copyData(o.pins,o.connectedApproval?4096:65536)));
   this.#lineage=freezeData(parsed(currentLineageSchema,copyData(o.lineage,o.connectedApproval?4096:65536)));
   const peer=this.#registry.credentials.find(c=>c.identity.credentialId===o.clientCredentialId),server=this.#registry.credentials.find(c=>c.identity.credentialId===o.serverCredentialId);
   need(peer?.direction==='request'&&['reader','authority-broker'].includes(peer.identity.role)&&server?.direction==='reply'&&server.identity.role==='provider','peer_mismatch');
   this.#peer=freezeData(copyData(peer.identity));this.#server=freezeData(copyData(server.identity));this.#peerView=freezeData(copyData(this.#peer));this.#serverView=freezeData(copyData(this.#server));
   if(o.connectedApproval){copyData(this.#peer,2048);copyData(this.#server,2048);}
   need(o.frames.length===4,'schema_invalid');const frames=o.frames.map(v=>{ordinaryBuffer(v,o.connectedApproval?4096:16384);return dedicated(v);});
   try{this.#session=validateSessionTranscript(frames,this.#registry,o.pins,{clientCredentialId:o.clientCredentialId,serverCredentialId:o.serverCredentialId,endpointId:o.endpointId});}finally{for(const b of frames)b.fill(0);}
   this.#created=this.#clock();need(this.#env.assertOpen()===undefined,'schema_invalid');this.#approval.assertCurrent();Object.freeze(this);
  }catch(e){this.#budget.release(this.#base);throw e;}finally{if(construction)this.#budget.release(construction);}
 }
 get identities(){return {peer:copyData(this.#peer),server:copyData(this.#server)};}
 get sequence(){return {request:this.#receiveSequence+1,reply:this.#sendSequence+1};}
 owner():Lb0Owner{need(!this.#closed&&++this.#ownersCreated<=256,'codec_budget_exceeded');const h=token('clb0-owner');this.#owners.add(h);return h;}
 scope(owner:Lb0Owner):Lb0Scope{need(this.#owners.has(owner)&&!this.#closed,'source_binding');need(++this.#scopesCreated<=256,'codec_budget_exceeded');const h=token('clb0-scope');this.#scopes.set(h,{owner,open:true});return h;}
 #event(c:Control,name:string){need(c.events.length<64,'codec_budget_exceeded');c.events.push({order:c.events.length+1,name,readers:c.readers,generation:c.generation,bytes:c.bytes});}
 #clock(c?:Control){const n=this.#env.now();need(Number.isSafeInteger(n)&&n>=this.#last&&(!c||n>=c.last),'clock_invalid');this.#last=n;if(c)c.last=n;return n;}
 #active(c:Control,generation=c.generation){if(c.state!=='active'||c.generation!==generation)throw c.failure?c.reason:new CurrentControlError('owner_closed');need(this.#open&&this.#channelOpen,'session_closed');}
 #time(c:Control){this.#active(c);const generation=c.generation,n=this.#clock(c);this.#active(c,generation);if(n>=c.deadline||n>=this.#created+30000){this.#end(c,new CurrentControlError('request_expired'));throw c.reason;}return n;}
 #live(c:Control){
  this.#time(c);const g=c.generation;this.#approval.assertCurrent();this.#active(c,g);this.#connectedApproval?.assertCurrent();this.#active(c,g);const open=this.#env.assertOpen();this.#active(c,g);need(open===undefined,'schema_invalid');
  for(const view of [this.#peerView,this.#serverView]){c.metrics.credentialChecks++;const valid=this.#env.credentialCurrent(view);this.#active(c,g);need(valid===true,'permission_denied');}
  c.metrics.purposeChecks++;const purpose=this.#env.purpose(c.api);this.#active(c,g);need(purpose===c.issuedPurpose&&(!c.b?.projection||c.b.projection.purpose===purpose),'permission_denied');
  const input=this.#env.permissions(this.#peerView);this.#active(c,g);const permissions=parsed(credentialSchema.shape.permissions,copyData(input,32768));
  need(permissions.some(p=>p.api===c.api&&p.purpose===purpose&&same(p.lineage,this.#lineage)&&(p.delegateInstance===null||p.delegateInstance===this.#server.instanceId)),'permission_denied');
  this.#budget.check();this.#time(c);c.metrics.liveChecks++;
 }
 #assertIdle(c:Control){this.#active(c);if(c.busy){this.#end(c,new CurrentControlError('source_binding'));throw c.reason;}}
 #operation<T>(c:Control,run:()=>T):T{
  this.#assertIdle(c);c.busy=true;const g=c.generation;
  try{const result=run();this.#active(c,g);this.#time(c);return result;}catch(e){this.#end(c,e);throw e;}finally{c.busy=false;}
 }
 #watch(c:Control){if(c.timer)clearTimeout(c.timer);const delay=Math.max(0,c.deadline-this.#last);c.timer=setTimeout(()=>this.#end(c,new CurrentControlError('request_expired')),delay);c.timer.unref?.();}
 prepareChallenge(request:Buffer,reply:Buffer,expectation:unknown):Lb0Pending{
  if(this.#preparing){for(const c of this.#controls)if(c.busy)this.#end(c,new CurrentControlError('source_binding'));need(false,'source_binding');}
  need(this.#open&&this.#channelOpen&&!this.#closed,'session_closed');need(this.#controls.size===0&&this.#requests<256,'operation_busy');this.#preparing=true;
  let c:Control|undefined,ticket:Ticket|undefined;
  try{
   ticket=this.#budget.reserve(LB0_POLICY.callBytes,8192,0,0,true);
   const x=parsed(pendingSchema,copyData(expectation));need(x.requestSequence===this.#receiveSequence+1&&x.replySequence===this.#sendSequence+1,'sequence_invalid');
   const now=this.#clock();need(x.deadline>now&&x.deadline<=Math.min(now+x.ttlMs,this.#created+30000),'request_expired');
   c={call:token('clb0-authenticated-call'),state:'active',generation:1,failure:false,phase:'prepared',busy:false,started:false,issuedPurpose:'read',api:x.api,deadline:x.deadline,last:now,expectation:freezeData(x),bytes:0,readers:0,reclaimed:false,ticket,scratchReleased:false,slotReleased:false,pendingDispatch:false,dispatchStarted:false,boundReady:false,events:[],metrics:{fullChecks:0,wireIdentityHashes:0,challengeChecks:0,channelChecks:0,ownerChecks:0,liveChecks:0,purposeChecks:0,credentialChecks:0,copies:0,lookups:0,reclaims:0,byteReleases:0,publications:0,late:0}};
   this.#controls.add(c);this.#all.set(c.call,c);this.#watch(c);
   const control=c;
   this.#operation(control,()=>{
    this.#live(control);ordinaryBuffer(request,16384);ordinaryBuffer(reply,16384);
    control.storage={request:dedicated(request),reply:dedicated(reply)};control.bytes=request.length+reply.length;
    this.#read(control,s=>{control.metrics.challengeChecks++;validateChallengeExchange(s.request!,s.reply!,this.#session,{requestId:x.requestId,api:x.api,originDigest:x.originDigest,requestSequence:x.requestSequence,replySequence:x.replySequence,ttlMs:x.ttlMs,purpose:'read',lineage:this.#lineage});return undefined;});
    this.#live(control);
   });
   this.#receiveSequence=x.requestSequence;this.#sendSequence=x.replySequence;const h=token('clb0-pending');this.#pending.set(h,c);this.#requests++;return h;
  }catch(e){if(c)this.#end(c,e);else if(ticket){this.#budget.release(ticket);this.#budget.endSlot(ticket);}throw e;}finally{this.#preparing=false;}
 }
 #read<T>(c:Control,run:(storage:Storage)=>T):T{
  this.#active(c);need(c.storage&&!c.reclaimed,'owner_closed');const g=c.generation;c.readers++;
  try{if(c.fault==='read-expire'){c.fault=undefined;this.#event(c,'reader-held');this.#end(c,new CurrentControlError('request_expired'));this.#event(c,'reader-still-held');}this.#active(c,g);const value=run(c.storage);this.#active(c,g);return value;}
  finally{c.readers--;if(c.state==='closed'){this.#event(c,'reader-drained');this.#reclaim(c);}}
 }
 #inspect(c:Control,skipOwnedDigest=false){
  this.#time(c);need(c.phase==='issued','source_binding');need(c.metrics.fullChecks++<LB0_POLICY.maxChecks,'codec_budget_exceeded');
  const value=this.#read(c,s=>{
   const outer:any=inspectStaticSession(this.#session);c.metrics.challengeChecks++;const challenge=validateChallengeExchange(s.request!,s.reply!,this.#session,{...this.#challengeExpected(c)}).challenge;
   c.metrics.channelChecks++;validateChannelFrame(s.outer!,s.inner!,this.#session,{direction:'request',sequence:c.expectation.requestSequence+1,challenge,api:c.api,originDigest:c.expectation.originDigest,ttlMs:c.expectation.ttlMs,purpose:c.issuedPurpose,lineage:this.#lineage});
   need(outer.base.clientCredentialId===this.#peer.credentialId&&outer.base.serverCredentialId===this.#server.credentialId,'peer_mismatch');
   let digest:string;if(skipOwnedDigest){need(c.admission,'source_binding');digest=c.admission.innerDigest;}else{c.metrics.wireIdentityHashes++;digest=sha(s.inner!);need(!c.admission||digest===c.admission.innerDigest,'peer_mismatch');}
   c.metrics.ownerChecks++;const envelope=verifyOwnerValue(s.inner!,this.#registry,{role:this.#peer.role,instanceId:this.#peer.instanceId,direction:'request',domain:'aux',api:c.api});
   const q=(envelope.body as any).command;need(q&&same(q.peer,this.#peer)&&same(q.lineage,this.#lineage),'source_binding');
   const kd=c.api==='aux.ReadSourceRanges'?rangeKeys({peer:this.#peer,provider:this.#server,lineage:this.#lineage,manifest:hash(LB0_POLICY),catalog:this.#lineage.profileDigest} as any,q as CprCommand):{k:sourceOperationKey(q),d:hash({domain:'clb0-request',request:q.requestDigest})};
   return freezeData({command:copyData(q,8192),innerDigest:digest,...kd});
  });
  this.#live(c);return value;
 }
 #challengeExpected(c:Control){const x=c.expectation;return {requestId:x.requestId,api:x.api,originDigest:x.originDigest,requestSequence:x.requestSequence,replySequence:x.replySequence,ttlMs:x.ttlMs,purpose:c.issuedPurpose,lineage:this.#lineage};}
 receive(pending:Lb0Pending,packet:{outer:Buffer;inner:Buffer}):Lb0Call{
  const c=this.#pending.get(pending);need(c,'source_binding');this.#assertIdle(c);need(!c.started,'source_binding');c.started=true;
  return this.#operation(c,()=>{
   this.#live(c);need(packet&&!types.isProxy(packet)&&Object.getPrototypeOf(packet)===Object.prototype,'schema_invalid');
   const ds=Object.getOwnPropertyDescriptors(packet);need(Object.keys(ds).sort().join(',')==='inner,outer'&&'value'in ds.inner!&&'value'in ds.outer!,'schema_invalid');
   ordinaryBuffer(ds.inner!.value,8192);ordinaryBuffer(ds.outer!.value,16384);
   const inner=ds.inner!.value as Buffer,outer=ds.outer!.value as Buffer;
   this.#budget.reserve(0,0,inner.length,inner.length+outer.length);
   c.storage!.inner=dedicated(inner);c.storage!.outer=dedicated(outer);c.bytes+=inner.length+outer.length;c.phase='issued';
   c.admission=this.#inspect(c);this.#receiveSequence=c.expectation.requestSequence+1;
   this.#calls.set(c.call,c);this.#event(c,'call-issued');return c.call;
  });
 }
 #lookup(call:Lb0Call){const c=this.#calls.get(call);need(c&&this.#all.get(call)===c,'peer_mismatch');this.#active(c);c.metrics.lookups++;return c;}
 begin(call:Lb0Call,owner:Lb0Owner):{draft:Lb0Draft;admission:any}{
  const c=this.#lookup(call);need(this.#owners.has(owner),'source_binding');if(c.claim){this.#end(c,new CurrentControlError('call_reused'));throw c.reason;}c.claim=owner;this.#event(c,'claim');
  return this.#operation(c,()=>{this.#approval.assertCurrent();this.#active(c);const b:Binding={c,owner,state:'constructing',generation:1};c.b=b;
   const value=this.#inspect(c),h=token('clb0-draft');this.#drafts.set(h,b);this.#event(c,'draft');return {draft:h,admission:copyData(value)};
  });
 }
 operationRow(draft:Lb0Draft,owner:Lb0Owner):Lb0Row{
  const b=this.#drafts.get(draft);need(b&&b.owner===owner&&b.state==='constructing'&&!b.c.row,'source_binding');
  return this.#operation(b.c,()=>{this.#live(b.c);const row:Row={c:b.c,k:b.c.admission.k,d:b.c.admission.d,deadline:b.c.deadline,state:'admitted'};b.c.row=row;const h=token('clb0-operation-row');this.#rows.set(h,row);return h;});
 }
 seal(draft:Lb0Draft,owner:Lb0Owner,scope:Lb0Scope,rowToken:Lb0Row,projection:unknown):Lb0Bound{
  const b=this.#drafts.get(draft);need(b,'source_binding');
  return this.#operation(b.c,()=>{
   const s=this.#scopes.get(scope),row=this.#rows.get(rowToken);need(b.owner===owner&&b.state==='constructing'&&s?.owner===owner&&s.open&&!s.b&&row?.c===b.c&&row===b.c.row,'source_binding');
   b.ticket=this.#budget.reserve(LB0_POLICY.bindingBytes,4096);
   const p=freezeData(parsed(projectionSchema,copyData(projection,8192)));need(same(p.peer,this.#peer)&&same(p.server,this.#server)&&p.api===b.c.api&&p.purpose===b.c.issuedPurpose,'source_binding');
   b.scope=scope;b.row=row;b.projection=p;s.b=b;this.#inspect(b.c);need(b.state==='constructing'&&s.open,'owner_closed');b.state='ready';b.c.boundReady=true;this.#event(b.c,'scope-ready');const h=token('clb0-bound');this.#bounds.set(h,b);return h;
  });
 }
 #binding(bound:Lb0Bound,owner:Lb0Owner,scope:Lb0Scope){const b=this.#bounds.get(bound);need(b,'source_binding');const s=this.#scopes.get(scope);need(b.owner===owner&&b.scope===scope&&s?.b===b&&s.open&&b.state==='ready'&&b.row===b.c.row,'source_binding');this.#lookup(b.c.call);return b;}
 #withBinding<T>(bound:Lb0Bound,owner:Lb0Owner,scope:Lb0Scope,run:(b:Binding,frame:Frame)=>T):T{
  const b=this.#bounds.get(bound);need(b,'source_binding');
  return this.#operation(b.c,()=>{this.#binding(bound,owner,scope);b.state='checking';const f:Frame={c:b.c,b,generation:b.c.generation,active:true};this.#frames.add(f);
   try{const result=run(b,f);this.#frame(f);need(this.#scopes.get(scope)?.open&&b.state==='checking','owner_closed');return result;}
   finally{f.active=false;this.#frames.delete(f);if(b.state==='checking')b.state='ready';}
  });
 }
 #frame(f:Frame){need(this.#frames.has(f)&&f.active&&f.c===f.b.c&&f.b.state==='checking','source_binding');this.#active(f.c,f.generation);}
 #privateGate(f:Frame){this.#frame(f);this.#inspect(f.c);this.#frame(f);}
 check(bound:Lb0Bound,owner:Lb0Owner,scope:Lb0Scope){const argc=arguments.length;this.#withBinding(bound,owner,scope,(_b,f)=>{need(argc===3,'source_binding');this.#privateGate(f);});}
 nestedChecks(bound:Lb0Bound,owner:Lb0Owner,scope:Lb0Scope){this.#withBinding(bound,owner,scope,(_b,f)=>{this.#privateGate(f);this.#privateS(f);this.#privateGate(f);});}
 #privateS(f:Frame){this.#privateGate(f);this.#privateGate(f);}
 readCommand(bound:Lb0Bound,owner:Lb0Owner,scope:Lb0Scope){return this.#withBinding(bound,owner,scope,(b,f)=>{this.#privateGate(f);const command=this.#read(b.c,s=>{b.c.metrics.copies++;b.c.metrics.ownerChecks++;const raw=verifyOwnerValue(s.inner!,this.#registry,{role:this.#peer.role,instanceId:this.#peer.instanceId,direction:'request',domain:'aux',api:b.c.api});return copyData((raw.body as any).command,8192);});this.#privateGate(f);return command;});}
 inspectCall(call:Lb0Call,wire:Buffer){const c=this.#lookup(call);return this.#operation(c,()=>{ordinaryBuffer(wire,8192);const equal=this.#read(c,s=>{c.metrics.wireIdentityHashes+=2;return sha(wire)===sha(s.inner!);});need(equal,'peer_mismatch');return copyData(this.#inspect(c));});}
 closeScope(scope:Lb0Scope){const s=this.#scopes.get(scope);need(s,'source_binding');s.open=false;if(s.b)this.#closeBinding(s.b);}
 #closeBinding(b:Binding){if(b.state==='closed')return;b.state='closed';b.generation++;if(b.scope){const s=this.#scopes.get(b.scope);if(s)s.open=false;}if(b.ticket){this.#budget.release(b.ticket);b.ticket=undefined;}this.#event(b.c,'binding-closed');}
 releaseDraft(draft:Lb0Draft,owner:Lb0Owner){const b=this.#drafts.get(draft);need(b&&b.owner===owner,'source_binding');this.#closeBinding(b);}
 tighten(call:Lb0Call,deadline:number){const c=this.#lookup(call);this.#operation(c,()=>{this.#time(c);need(Number.isSafeInteger(deadline)&&deadline<=c.deadline,'request_expired');c.deadline=deadline;if(c.row)c.row.deadline=deadline;if(deadline<=this.#last)this.#end(c,new CurrentControlError('request_expired'));else this.#watch(c);});}
 cancel(call:Lb0Call){const c=this.#all.get(call);need(c,'peer_mismatch');this.#end(c,new CurrentControlError('owner_closed'));}
 /** Operator-only fault selector: no arbitrary callback or raw-byte access while a reader is held. */
 faultNextRead(call:Lb0Call){const c=this.#lookup(call);c.fault='read-expire';}
 #reclaim(c:Control){
  if(c.state!=='closed'||c.readers!==0||c.reclaimed)return;
  c.reclaimed=true;for(const b of Object.values(c.storage??{}))b?.fill(0);c.storage=undefined;
  const bytes=c.bytes;c.bytes=0;this.#budget.release(c.ticket,bytes);c.metrics.reclaims++;c.metrics.byteReleases++;this.#event(c,'bytes-reclaimed');
  if(!c.pendingDispatch)this.#releaseScratch(c);
 }
 #releaseScratch(c:Control){if(c.scratchReleased||!c.reclaimed||c.pendingDispatch)return;c.scratchReleased=true;this.#budget.release(c.ticket);if(!c.slotReleased){this.#budget.endSlot(c.ticket);c.slotReleased=true;}this.#controls.delete(c);if(this.#closed&&this.#controls.size===0)this.#releaseBase();}
 #end(c:Control,error?:unknown,success=false){
  if(c.state==='closed')return;c.state='closed';c.generation++;c.reason=error;c.failure=!success;if(c.timer)clearTimeout(c.timer);
  this.#event(c,success?'completed':'expired-or-refused');if(c.b)this.#closeBinding(c.b);
  if(this.#calls.get(c.call)===c)this.#calls.delete(c.call);this.#event(c,'lookup-removed');
  if(!success){this.#channelOpen=false;if(c.row)c.row.state='retired';}else if(c.row)c.row.state='complete';
  this.#reclaim(c);if(!success)c.settle?.reject(error);
 }
 #finish(c:Control,value:unknown){
  const result=this.#operation(c,()=>{need(c.boundReady,'source_binding');this.#inspect(c);return copyData(value,8192);});
  c.metrics.publications++;this.#event(c,'output');this.#end(c,undefined,true);return result;
 }
 finishCall(call:Lb0Call){const c=this.#lookup(call);need(c.boundReady,'source_binding');need(!c.dispatchStarted,'operation_busy');return this.#finish(c,{api:c.api,requestDigest:c.admission.command.requestDigest});}
 dispatch(call:Lb0Call,work:()=>Promise<unknown>):Promise<unknown>{
  return this.#dispatch(call,work,false);
 }
 dispatchConnected(call:Lb0Call,work:()=>Promise<unknown>):Promise<unknown>{
  need(this.#connectedApproval,'codec_profile_unsupported');Lb1Approval.require(this.#connectedApproval);return this.#dispatch(call,work,true);
 }
 #dispatch(call:Lb0Call,work:()=>Promise<unknown>,preparation:boolean):Promise<unknown>{
  const c=this.#lookup(call);need(!c.dispatchStarted,'operation_busy');this.#operation(c,()=>{if(!preparation)need(c.boundReady&&c.b?.state==='ready'&&c.b.scope&&this.#scopes.get(c.b.scope)?.open,'source_binding');this.#inspect(c);if(!preparation)need(c.b!.state==='ready'&&this.#scopes.get(c.b!.scope!)?.open,'owner_closed');});c.dispatchStarted=true;c.pendingDispatch=true;const generation=c.generation;
  const response=new Promise((resolve,reject)=>{c.settle={resolve,reject};});
  void(async()=>{let value:unknown,error:unknown,rejected=false;try{value=await work();}catch(e){rejected=true;error=e;}
   try{
    // Late means the outcome arrived after the call had already ended (timeout, cancel or close).
    if(c.state!=='active'||c.generation!==generation){c.metrics.late++;this.#event(c,rejected?'late-reject':'late-resolve');return;}
    if(rejected){this.#end(c,error);return;}
    // An on-time result refused by the final verification is ended (and the caller rejected) inside #finish; it is not a late arrival.
    let result:unknown;try{result=this.#finish(c,value);}catch{return;}
    c.settle!.resolve(result);
   }finally{c.pendingDispatch=false;this.#event(c,'dispatch-drained');c.settle=undefined;this.#releaseScratch(c);}})();
  return response;
 }
 stats(call:Lb0Call){const c=this.#all.get(call);need(c,'peer_mismatch');return {mode:this.#mode,state:c.state,phase:c.phase,generation:c.generation,lookupPresent:this.#calls.get(call)===c,readers:c.readers,bytesHeld:c.bytes,reclaimed:c.reclaimed,pendingDispatch:c.pendingDispatch,scratchReleased:c.scratchReleased,slotReleased:c.slotReleased,claimHeld:!!c.claim,bindingState:c.b?.state??'absent',deadline:c.deadline,issuedPurpose:c.issuedPurpose,metrics:{...c.metrics},events:copyData(c.events),budget:this.#budget.stats()};}
 /** Copied diagnostics only: observing a rejected pending input must not expose a call capability. */
 pendingStats(pending:Lb0Pending){const c=this.#pending.get(pending);need(c,'source_binding');return this.stats(c.call);}
 /** Opt-in connection capability. No frame, private wire or arbitrary byte callback is exposed. */
 connected(call:Lb0Call){
  need(this.#connectedApproval,'codec_profile_unsupported');const approval=this.#connectedApproval,c=this.#lookup(call);this.#assertIdle(c);if(c.connectedClaim||c.claim){this.#end(c,new CurrentControlError('call_reused'));throw c.reason;}c.connectedClaim=true;try{Lb1Approval.require(approval);this.#active(c);}catch(e){this.#end(c,e);throw e;}let b:Binding|undefined,scope:Lb0Scope|undefined,extra:Ticket|undefined,bindingTicket:Ticket|undefined,scopeBytes=0;const owner=this.owner();
  const counts={checks:0,elidedHashes:0,identityCopies:0,identityComparisons:0,internal:0};
  const active=()=>{this.#active(c);};
  const enter=<T>(parent:Frame|undefined,fn:(f:Frame)=>T):T=>{
   this.#active(c);if(parent){try{this.#frame(parent);need(parent.b===b,'source_binding');active();counts.internal++;return fn(parent);}catch(e){this.#end(c,e);throw e;}}
   return this.#operation(c,()=>{active();need(b&&['constructing','ready'].includes(b.state),'source_binding');const previous=b.state;b.state='checking';const f:Frame={c,b,generation:c.generation,active:true};this.#frames.add(f);
    try{const result=fn(f);this.#frame(f);return result;}finally{f.active=false;this.#frames.delete(f);if(b.state==='checking')b.state=previous;}
   });
  };
  const inspect=(f:Frame,context:CprContext)=>{try{this.#frame(f);counts.checks++;const elide=this.#mode==='bound-live'&&c.boundReady;this.#inspect(c,elide);this.#frame(f);if(elide)counts.elidedHashes++;else{counts.identityCopies+=2;counts.identityComparisons+=2;need(same(copyData(this.#peer),context.peer)&&same(copyData(this.#server),context.provider),'peer_mismatch');}}catch(e){this.#end(c,e);throw e;}};
  return new CwcLb1Binding(lb1Secret,call,{
   start:(wire)=>{this.#active(c);bindingTicket=this.#budget.reserve(LB0_POLICY.bindingBytes,4096);const draft=this.begin(call,owner);b=this.#drafts.get(draft.draft)!;b.ticket=bindingTicket;this.inspectCall(call,wire);return {...draft.admission,peer:copyData(this.#peer),server:copyData(this.#server),api:c.api,deadline:c.deadline};},
   enter,inspect,assertPublic:()=>this.#assertIdle(c),
   reserve:(bytes)=>{active();need(!extra&&Number.isSafeInteger(bytes)&&bytes>LB1_POLICY.frameWorkspace,'codec_budget_exceeded');need(LB0_POLICY.callBytes-(2*16384+8192+16384)-8192>=LB1_POLICY.frameWorkspace,'codec_budget_exceeded');extra=this.#budget.reserve(bytes-LB1_POLICY.frameWorkspace);scopeBytes=bytes;},
   ready:(context)=>{active();need(b&&b.state==='constructing','source_binding');scope=this.scope(owner);b.scope=scope;b.row={c,k:c.admission.k,d:c.admission.d,deadline:c.deadline,state:'admitted'};c.row=b.row;b.projection=freezeData({peer:copyData(this.#peer),server:copyData(this.#server),api:c.api,purpose:'read',actor:'provider'});this.#scopes.get(scope)!.b=b;this.#operation(c,()=>{this.#inspect(c);need(b!.state==='constructing'&&this.#scopes.get(scope!)!.open,'owner_closed');need(same(context.peer,this.#peer)&&same(context.provider,this.#server),'source_binding');b!.state='ready';c.boundReady=true;this.#event(c,'scope-ready');});},
   close:()=>{if(b)this.#closeBinding(b);if(bindingTicket){this.#budget.release(bindingTicket);bindingTicket=undefined;}if(extra){this.#budget.release(extra);extra=undefined;}},
   fail:(e)=>{this.#end(c,e);},
   diagnostics:()=>({mode:this.#mode,...counts,scopeBytes,sharedFrameWorkspace:LB1_POLICY.frameWorkspace,sessionBytes:LB1_POLICY.sessionBytes,budget:this.#budget.stats(),call:this.stats(call)})
  });
 }
 get counts(){return {lookup:this.#calls.size,retained:this.#controls.size,requests:this.#requests};}
 #baseReleased=false;
 #releaseBase(){if(!this.#baseReleased){this.#baseReleased=true;this.#budget.release(this.#base);}}
 close(){if(this.#closed)return;this.#closed=true;this.#open=false;this.#channelOpen=false;for(const c of [...this.#controls])this.#end(c,new CurrentControlError('owner_closed'));if(this.#controls.size===0)this.#releaseBase();}
}

const lb1Secret=Symbol('lb1-connection'),connectedBindings=new WeakSet<object>();
type ConnectedDriver={start:(wire:Buffer)=>any;enter:<T>(frame:Frame|undefined,fn:(f:Frame)=>T)=>T;inspect:(f:Frame,c:CprContext)=>void;assertPublic:()=>void;reserve:(bytes:number)=>void;ready:(c:CprContext)=>void;close:()=>void;fail:(error:unknown)=>void;diagnostics:()=>any};
/** Trusted adapter port. Only fixed provider/scope bodies are registered; foreign callbacks never receive frames. */
export class CwcLb1Binding{
 #foreign=false;
 readonly #call:Lb0Call;readonly #d:ConnectedDriver;#provider?:object;#scope?:object;#c?:CprContext;#current?:()=>void;#now?:()=>number;#parent=0;#scopeBody?: (frame:Frame)=>void;#row?:CwcCProviderRow;#floor={work:0,wire:0,attempts:0};#rowDeadline=Infinity;#rowKey?:{k:string;d:string};#closed=false;
 constructor(key:symbol,call:Lb0Call,driver:ConnectedDriver){need(key===lb1Secret,'source_binding');this.#call=call;this.#d=driver;connectedBindings.add(this);Object.freeze(this);}
 static require(value:CwcLb1Binding,call:unknown){need(connectedBindings.has(value)&&value.#call===call,'source_binding');}
 static accept(value:CwcLb1Binding){need(connectedBindings.has(value),'source_binding');}
 start(provider:object,context:CprContext,current:()=>void,now:()=>number,deadline:number,wire:Buffer){need(CwcCProvider.ownsBinding(provider,this)&&!this.#provider&&!this.#closed,'source_binding');this.#provider=provider;this.#current=current;this.#now=now;this.#parent=deadline;const initial=this.#d.start(wire);this.#c=freezeData(parsedContext(copyData(context)));this.#command=freezeData(copyData(initial.command));return initial;}
 attachRow(row:CwcCProviderRow){need(this.#provider&&CwcCProvider.ownsRow(this.#provider,this,row)&&!this.#row&&!this.#closed,'source_binding');const q=this.#command,kd=q.api==='aux.ReadSourceRanges'?rangeKeys(this.#c!,q):{k:sourceOperationKey(q),d:hash({domain:'cpr-b.scalar-intent',request:q.requestDigest,manifest:this.#c!.manifest})};need(row.k===kd.k&&row.d===kd.d,'source_binding');this.#row=row;this.#rowKey=kd;this.#rowDeadline=row.deadline;}
 providerGate(provider:object,frame?:unknown){this.assertEntry();need(provider===this.#provider&&this.#c&&!this.#closed,'source_binding');return this.#d.enter(frame as Frame|undefined,f=>{const result=this.#current!();need(result===undefined,'schema_invalid');this.#d.inspect(f,this.#c!);const now=this.#now!();need(Number.isSafeInteger(now)&&now<Math.min(this.#parent,this.#row?.deadline??Infinity),'request_expired');if(this.#row){const r=this.#row;need(r.k===this.#rowKey!.k&&r.d===this.#rowKey!.d,'source_binding');need(r.deadline<=this.#rowDeadline,'request_expired');this.#rowDeadline=r.deadline;for(const key of ['work','wire','attempts'] as const){const value=key==='attempts'?r.attempts:r.spent[key];need(Number.isSafeInteger(value)&&value>=this.#floor[key],'operation_budget');this.#floor[key]=value;}}});}
 reserve(bytes:number){this.#d.reserve(bytes);}
 attachScope(scope:object,context:CprContext,body:(frame:unknown)=>void){this.assertPublicEntry();need(CwcCReadScope.isInstance(scope)&&this.#row&&!this.#scope&&this.#c&&!this.#closed&&same(context,this.#c),'source_binding');this.#scope=scope;this.#scopeBody=body;}
 scopeGate(scope:object,frame?:unknown){this.assertEntry();need(scope===this.#scope&&this.#scopeBody&&!this.#closed,'source_binding');return this.#d.enter(frame as Frame|undefined,f=>this.#scopeBody!(f));}
 checkScope(scope:object,frame:unknown){need(scope===this.#scope&&this.#c&&!this.#closed,'source_binding');this.#d.inspect(frame as Frame,this.#c);}
 ready(scope:object){need(scope===this.#scope&&this.#c&&!this.#closed,'source_binding');this.#d.ready(this.#c);}
 command(){this.assertEntry();need(this.#c&&!this.#closed,'source_binding');return this.#d.enter(undefined,f=>{this.#d.inspect(f,this.#c!);const q=copyData(this.#command);this.#d.inspect(f,this.#c!);return q;});}
 #command:any;
 closeScope(scope:object){need(scope===this.#scope,'source_binding');this.#closed=true;this.#d.close();}
 finishProvider(provider:object){need(provider===this.#provider,'source_binding');this.#closed=true;this.#d.close();}
 rejectReentry(provider:object){need(provider===this.#provider,'source_binding');const e=new CurrentControlError('source_binding');this.#d.fail(e);throw e;}
 assertEntry(){if(this.#foreign){const e=new CurrentControlError('source_binding');this.#d.fail(e);throw e;}}
 assertPublicEntry(){this.assertEntry();this.#d.assertPublic();}
 external<T>(scope:object,fn:()=>T):T{need(scope===this.#scope&&!this.#foreign&&!this.#closed,'source_binding');this.#foreign=true;try{const value=fn();this.#d.assertPublic();return value;}finally{this.#foreign=false;}}
 /** Owner/codec clocks run outside a P/S checking frame; they remain foreign callbacks. */
 providerExternal<T>(provider:object,fn:()=>T):T{need(provider===this.#provider&&!this.#foreign&&!this.#closed,'source_binding');this.assertPublicEntry();this.#foreign=true;try{const value=fn();this.#d.assertPublic();return value;}finally{this.#foreign=false;}}
 async phase(provider:object,fn:()=>void|Promise<void>){need(provider===this.#provider&&!this.#foreign&&!this.#closed,'source_binding');this.#foreign=true;try{await fn();}finally{this.#foreign=false;}}
 get diagnostics(){return this.#d.diagnostics();}
}
