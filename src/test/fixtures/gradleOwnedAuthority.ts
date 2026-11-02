/** Stage A1 reference kernel: bounded, in-memory logical transactions only. TEST FIXTURE:
 * kept outside src/utils so it is never built into the published package, because principal()
 * mints any role without authentication. Never installed as TrustedOwnedCaller. It authenticates no peer;
 * synchronous mode is memory-only, optional async mode saves audit snapshots through the A2 fixture. It
 * launches nothing and ALWAYS reports backendEligible=false. */
import {decodeAuthoritySnapshot,SNAPSHOT_SESSION_LIMIT} from './gradleOwnedAuthoritySnapshot.js';
import {type AuthorityJournal,type JournalRecord,type JournalHead} from './gradleOwnedAuthorityJournal.js';
import {randomBytes} from 'node:crypto';
import {types as utilTypes} from 'node:util';
import {authorityOperation,authorityProjection,authorityScope,AUTHORITY_LIMITS,type AuthorityOperation,type AuthorityMetadataRef,type AuthorityPlan,type AuthorityScope} from './gradleOwnedAuthoritySchema.js';
import {type OwnedPolicy} from '../../utils/gradleOwnedPolicy.js';
import {canonicalOwnedJson,parseOwnedJson,ownedDigest,ownedSha256,OWNED_LIMITS} from '../../utils/gradleOwnedJson.js';
import {parseGradleGraph,createGradleBudget,type GradleGraph} from '../../utils/gradleGraph.js';
import {parseGradleExportG0} from '../../utils/gradleOwnedManifest.js';
import {inspectOwnedExecution,type OwnedExecutionClaim,ownedLookupSchema} from '../../utils/gradleOwnedExecution.js';

type Role='caller'|'reader'|'broker'|'observer';
type Identity={id:string;role:Role;sessionId?:string;scope?:AuthorityScope};
type Terminal={outcome:'structure-verified'|'not-executed'|'execution-aborted'|'unavailable'|'invalid';ledgerHead:string;bundleDigest?:string;envelopeDigest?:string;sealMetadataRef?:AuthorityMetadataRef;reason?:string};
type Scope={plan:AuthorityPlan;revision:number;lifecycle:'planned'|'registered'|'executing'|'sealing'|'terminal';validity:'current'|'revoked';head:string;sequence:number;witnessId?:string;uploadId?:string;capability?:string;observation?:{lookup:ReturnType<typeof ownedLookupSchema.parse>;leases:unknown[]};terminal?:Terminal;events:string[]};
type Upload={id:string;purpose:'core'|'seal';scope?:AuthorityScope;witnessId?:string;revision:number;state:'open'|'frozen'|'cancelled';chunks:Buffer[];received:number;total?:number;digest?:string;text?:string;ref?:AuthorityMetadataRef};
type Ack={digest:string;reply:any};
type Session={id:string;owner:string;consumerId:string;scanRunId:string;projectRootId:string;settingsDigest:string;scopeRequestsDigest:string;manifestDigest?:string;graphId:string;exportId:string;executionId:string;nonce:string;coreUploadId:string;created:number;revision:number;lifecycle:'draft'|'core-bound'|'active'|'committed'|'closed';validity:'unselected'|'current'|'superseded'|'revoked'|'expired'|'aborted'|'restarted';core?:GradleGraph;coreRef?:AuthorityMetadataRef;coreDigest?:string;rootDigest?:string;scopes:Map<string,Scope>;uploads:Map<string,Upload>;acks:Map<string,Ack>;metadataBytes:number;ledgerBytes:number;eventCount:number};
type State={sessions:Map<string,Session>;slots:Map<string,{revision:number;sessionId?:string}>;begins:Map<string,Ack>};
export class OwnedAuthorityContractError extends Error {constructor(reason:string){super('authority_contract_'+reason);}}
function fail(reason:string):never {throw new OwnedAuthorityContractError(reason);}
function requireThat(ok:unknown,reason:string):asserts ok {if(!ok)fail(reason);}
const fresh=()=>randomBytes(32).toString('hex');
const key=(scope:AuthorityScope)=>JSON.stringify([scope.project,scope.context,scope.invocation]);
const slot=(s:Session)=>JSON.stringify([s.consumerId,s.projectRootId]);
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
const copy=<T>(x:T):T=>JSON.parse(JSON.stringify(x));
function assertData(value:unknown):void {
 let nodes=0;const active=new Set<object>();
 function visit(v:unknown,depth:number):void {
  requireThat(++nodes<=OWNED_LIMITS.nodes&&depth<=OWNED_LIMITS.depth,'schema_invalid');
  if(v===null||typeof v!=='object'){requireThat(['string','number','boolean'].includes(typeof v)||v===null,'schema_invalid');return;}
  requireThat(!utilTypes.isProxy(v)&&!active.has(v),'schema_invalid');
  requireThat([Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(v))&&Object.getOwnPropertySymbols(v).length===0,'schema_invalid');
  active.add(v);for(const [k,d] of Object.entries(Object.getOwnPropertyDescriptors(v))){if(Array.isArray(v)&&k==='length')continue;requireThat('value'in d,'schema_invalid');visit(d.value,depth+1);}active.delete(v);
 }
 visit(value,0);
}
function clone(s:State):State {
 return {slots:new Map([...s.slots].map(([k,v])=>[k,{...v}])),begins:new Map(s.begins),sessions:new Map([...s.sessions].map(([k,v])=>[k,{...v,scopes:new Map([...v.scopes].map(([k,v])=>[k,{...v,events:[...v.events]}])),uploads:new Map([...v.uploads].map(([k,v])=>[k,{...v,chunks:[...v.chunks]}])),acks:new Map(v.acks)}]))};
}
export interface OwnedAuthorityContractConfig {authorityId:string;policy:OwnedPolicy;now:()=>number;limits?:{[K in keyof typeof AUTHORITY_LIMITS]?:number};journal?:AuthorityJournal}
export class OwnedAuthorityContract {
 #actors=new WeakMap<object,Identity>();
 #state:State={sessions:new Map(),slots:new Map(),begins:new Map()};
 #lastTime=0;
 #journal?:AuthorityJournal;
 #historicalOperations=new Map<string,{id:string;requestDigest:string;resultDigest:string}[]>();
 #durableBusy=false;#durableStopped=false;#durableDigest='';#expectedHead?:JournalHead;
 #durableAcks=new Map<string,{requestDigest:string;resultDigest:string}>();
 readonly #limits:Record<keyof typeof AUTHORITY_LIMITS,number>;
 constructor(private readonly config:OwnedAuthorityContractConfig){
  requireThat(typeof config.authorityId==='string'&&config.authorityId.length>0&&config.authorityId.length<=1024,'configuration_invalid');
  this.#journal=config.journal;
  if(this.#journal){requireThat(this.#journal.head.authorityId===config.authorityId,'configuration_invalid');requireThat(this.#journal.head.revision===0,'restart_unsupported');this.#expectedHead=this.#journal.head;}
  this.#limits={...AUTHORITY_LIMITS};
  for(const [k,v] of Object.entries(config.limits??{})){
   requireThat(Object.hasOwn(AUTHORITY_LIMITS,k)&&typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=AUTHORITY_LIMITS[k as keyof typeof AUTHORITY_LIMITS],'configuration_invalid');
   this.#limits[k as keyof typeof AUTHORITY_LIMITS]=v;
  }
 }
 /** Restart factory: never exposes the new instance until historical invalidation is checkpointed. */
 static async restart(config:OwnedAuthorityContractConfig & {journal:AuthorityJournal}):Promise<OwnedAuthorityContract> {
  const {journal,authorityId}=config;
  const model=new OwnedAuthorityContract({...config,journal:undefined});
  model.#journal=journal;model.#durableBusy=true;
  try {
   requireThat(journal.head.authorityId===authorityId,'configuration_invalid');
   const records=await journal.readLatest();model.#expectedHead=journal.head;
   const fromHead=model.#expectedHead;
   if(records.length){
    const decoded=decodeAuthoritySnapshot(records,authorityId);
    requireThat(same(decoded.limits,model.#limits),'restart_limits_mismatch');
    model.#state.slots=new Map(decoded.slots.map(([k,v])=>[k,{...v}]));
    for(const old of decoded.sessions){
     const {plans:_,...manifest}=old.manifest;
     const scopes=new Map<string,Scope>(old.scopes.map(({info,plan,events,observation})=>[key(info.scope),{plan,revision:info.revision,lifecycle:info.lifecycle,validity:info.validity,head:info.ledgerHead,sequence:info.sequence,events,...(info.witnessId?{witnessId:info.witnessId}:{}),...(info.uploadId?{uploadId:info.uploadId}:{}),...(info.terminal?{terminal:info.terminal}:{}),...(observation?{observation}:{})}]));
     const uploads=new Map<string,Upload>(old.uploads.map(({info,parts,text})=>{const {records:_,...u}=info;return [info.id,{...u,chunks:info.state==='frozen'?[]:parts,...(text===undefined?{}:{text})}];}));
     const session:Session={...manifest,scopes,uploads,acks:new Map()};
     model.#state.sessions.set(session.id,session);model.#historicalOperations.set(session.id,old.operations);
    }
   }
   const invalidated:string[]=[];
   for(const session of model.#state.sessions.values()){
    if(session.lifecycle!=='closed'){model.#closeSession(session,'restarted','authority-restarted');invalidated.push(session.id);}
    for(const scope of session.scopes.values())if(scope.validity==='current'){scope.validity='revoked';scope.revision++;}
    for(const upload of session.uploads.values())if(upload.state==='open'){upload.state='cancelled';upload.revision++;}
   }
   // Clock origins, actors, ack caches, bearer capabilities and execution grants are not restored.
   model.#clock();
   await model.#save(fresh(),ownedDigest({domain:'authority-restart-v1',fromHead}),{maintenance:'restart',fromHead,invalidated,backendEligible:false});
   model.#requireGeneration();return model;
  }catch(e){model.#durableStopped=true;throw e;}
  finally{model.#durableBusy=false;}
 }
 #requireGeneration():void {
  if(this.#journal&&this.#expectedHead&&!same(this.#journal.head,this.#expectedHead)){this.#durableStopped=true;fail('generation_changed');}
 }
 #available():void {requireThat(!this.#durableStopped,'recovery_required');requireThat(!this.#durableBusy,'busy');this.#requireGeneration();}
 async #verifyGeneration():Promise<void> {
  try{await this.#journal!.verifyHead();this.#requireGeneration();}catch(e){this.#durableStopped=true;throw e;}
 }
 /** Trusted harness provisioning; deliberately NOT a wire/OS authentication API. */
 principal(role:Role,sessionId?:string,scope?:AuthorityScope):object {
  this.#available();
  requireThat(['caller','reader','broker','observer'].includes(role),'permission_denied');
  if(role==='broker'||role==='observer')requireThat(sessionId&&scope,'permission_denied');
  const actor=Object.freeze({});this.#actors.set(actor,{id:fresh(),role,...(sessionId?{sessionId}:{}),...(scope?{scope:authorityScope.parse(scope)}:{})});return actor;
 }
 #clock():number {const now=this.config.now();requireThat(Number.isSafeInteger(now)&&now>=this.#lastTime,'clock_invalid');this.#lastTime=now;return now;}
 #expire(now:number):boolean {
  let changed=false;for(const s of this.#state.sessions.values())if(s.lifecycle!=='closed'&&now-s.created>=this.#limits.sessionMilliseconds){this.#closeSession(s,'expired','expired');changed=true;}return changed;
 }
 #closeScope(s:Session,sc:Scope,outcome:Terminal['outcome'],reason?:string):void {
  // Terminal scopes cannot resume their upload. Release only the pending slot;
  // retained chunks and their reserved byte budget remain charged to the session.
  const upload=sc.uploadId?s.uploads.get(sc.uploadId):undefined;
  if(upload?.state==='open'){upload.state='cancelled';upload.revision++;}
  if(sc.lifecycle!=='terminal'){sc.terminal={outcome,ledgerHead:sc.head,...(reason?{reason}:{})};sc.lifecycle='terminal';sc.revision++;}
  if(s.lifecycle==='active'&&[...s.scopes.values()].every(x=>x.lifecycle==='terminal'))s.lifecycle='committed';
 }
 // Lifecycle closure (expire/abort) and validity loss (supersede/revoke) are recorded distinctly.
 #closeSession(s:Session,validity:'revoked'|'superseded'|'expired'|'aborted'|'restarted',reason:string):void {
  for(const sc of s.scopes.values())this.#closeScope(s,sc,'unavailable',reason);
  s.validity=validity;s.lifecycle='closed';s.revision++;
  const current=this.#state.slots.get(slot(s));if(current?.sessionId===s.id)this.#state.slots.set(slot(s),{revision:current.revision+1});
 }
 #live(s:Session):void {requireThat(s.validity==='current'&&(s.lifecycle==='active'||s.lifecycle==='committed')&&this.#state.slots.get(slot(s))?.sessionId===s.id,'not_current');}
 #scope(s:Session,scope:AuthorityScope):Scope {const sc=s.scopes.get(key(scope));requireThat(sc,'scope_mismatch');return sc;}
 #authorize(identity:Identity,s:Session,c:Exclude<AuthorityOperation,{operation:'begin'}>):void {
  if(identity.sessionId)requireThat(identity.sessionId===s.id,'permission_denied');
  if(identity.role==='caller'){
   requireThat(identity.id===s.owner,'permission_denied');
   requireThat(['bind-core','activate','register-scope','abort','revoke'].includes(c.operation)||(c.operation==='put-metadata-chunk'&&c.purpose==='core'),'permission_denied');
  }else if(identity.role==='reader')requireThat(c.operation==='lookup','permission_denied');
  else {
   requireThat('scope'in c&&c.scope&&same(c.scope,identity.scope),'permission_denied');
   requireThat(c.operation==='append-event'||c.operation==='seal-scope'||(c.operation==='put-metadata-chunk'&&c.purpose==='seal'),'permission_denied');
   if(c.operation==='append-event')requireThat(c.event.kind==='action-start'?identity.role==='broker':identity.role==='observer','permission_denied');
  }
 }
 #summary(s:Session):any {
  return {sessionId:s.id,graphId:s.graphId,exportId:s.exportId,executionId:s.executionId,nonce:s.nonce,coreUploadId:s.coreUploadId,revision:s.revision,lifecycle:s.lifecycle,validity:s.validity,currentRevision:this.#state.slots.get(slot(s))?.revision??0,metadataBytes:s.metadataBytes,...(s.coreRef?{coreMetadataRef:s.coreRef}:{}),...(s.manifestDigest?{manifestDigest:s.manifestDigest}:{}),ledgerBytes:s.ledgerBytes,eventCount:s.eventCount,scopes:[...s.scopes.values()].map(sc=>({scope:{project:sc.plan.project,context:sc.plan.context,invocation:sc.plan.invocation},revision:sc.revision,lifecycle:sc.lifecycle,validity:sc.validity,ledgerHead:sc.head,sequence:sc.sequence,...(sc.witnessId?{witnessId:sc.witnessId}:{}),...(sc.uploadId?{uploadId:sc.uploadId}:{}),...(sc.terminal?{terminal:sc.terminal}:{})})),backendEligible:false,diagnosticEligible:false,ownedFileReads:0};
 }
 /** Inspection is harness-only; returns no source bytes, capability or backend-ready adapter. */
 inspect(actor:object,sessionId:string):any {
  this.#available();requireThat(!this.#journal,'async_required');
  const identity=this.#actors.get(actor);requireThat(identity&&(identity.role==='caller'||identity.role==='reader'),'permission_denied');
  this.#expire(this.#clock());const s=this.#state.sessions.get(sessionId);requireThat(s,'session_missing');
  if(identity.role==='caller')requireThat(s.owner===identity.id,'permission_denied');if(identity.sessionId)requireThat(identity.sessionId===sessionId,'permission_denied');return copy(this.#summary(s));
 }
 dispatch(actor:object,input:unknown):any {
  this.#available();requireThat(!this.#journal,'async_required');return this.#dispatch(actor,input);
 }
 /** Async fixture bridge. No wire authentication, process launcher, or restart capability restoration. */
 async dispatchDurable(actor:object,input:unknown):Promise<any> {
  this.#available();requireThat(this.#journal,'persistence_required');
  const identity=this.#actors.get(actor);requireThat(identity,'permission_denied');
  let c:AuthorityOperation,encoded:string;
  try{assertData(input);encoded=canonicalOwnedJson(input);c=authorityOperation.parse(parseOwnedJson(encoded));}catch{fail('schema_invalid');}
  const started=this.#clock(),requestDigest=ownedSha256(encoded);
  const operationId=ownedDigest({domain:'authority-operation-v1',actorId:identity.id,sessionId:c.operation==='begin'?'begin':c.sessionId,operationId:c.operationId});
  this.#durableBusy=true;
  try {
   await this.#verifyGeneration();
   if(!this.#durableDigest)this.#durableDigest=this.#snapshotDigest(this.#snapshot());
   this.#expire(started);await this.#saveExpiration();
   let reply:any;
   try{reply=this.#dispatch(actor,c);}catch(e){await this.#saveExpiration();throw e;}
   if(c.operation==='lookup'){
    try{await this.#journal.verifyHead();}catch(e){this.#durableStopped=true;throw e;}
   }else {
    const prior=this.#durableAcks.get(operationId);
    if(prior){
     requireThat(prior.requestDigest===requestDigest,'replay_conflict');
     try{const saved=await this.#journal.lookupOperation(operationId);requireThat(saved&&saved.resultDigest===prior.resultDigest,'persisted_ack_missing');}catch(e){this.#durableStopped=true;throw e;}
    }else {
     const result=await this.#save(operationId,requestDigest,reply);
     this.#durableAcks.set(operationId,{requestDigest,resultDigest:result.resultDigest});
    }
   }
   // Each expiration can require another asynchronous save. Recheck after the
   // last such await, with no asynchronous gap between the final clock and reply.
   await this.#saveExpiration();
   for(;;){
    const ended=this.#clock();if(this.#expire(ended)){await this.#saveExpiration();continue;}
    this.#requireGeneration();
    if(c.operation==='lookup')return copy(this.#apply(identity,c,requestDigest,ended));
    const target=this.#state.sessions.get(c.operation==='begin'?reply.sessionId:c.sessionId);
    if(target&&ended-target.created>=this.#limits.sessionMilliseconds)fail('expired');
    if(c.operation==='put-metadata-chunk'&&ended-started>this.#limits.chunkMilliseconds)fail('deadline_exceeded');
    return copy(reply);
   }
  }finally{this.#durableBusy=false;}
 }
 #snapshotDigest(records:JournalRecord[]):string {return ownedDigest(records.map(r=>({id:r.id,role:r.role,size:r.bytes.length,sha256:ownedSha256(r.bytes)})));}
 #snapshot():JournalRecord[] {
  requireThat(this.#state.sessions.size<=SNAPSHOT_SESSION_LIMIT,'budget_exceeded');
  const records:JournalRecord[]=[],manifests:unknown[]=[],sessions:unknown[]=[];
  const add=(role:JournalRecord['role'],id:string,value:unknown)=>records.push({role,id,bytes:Buffer.from(canonicalOwnedJson(value,64*1024*1024))});
  for(const s of this.#state.sessions.values()){
   const {scopes,uploads,acks,core:_core,...manifest}=s;
   manifests.push({...manifest,plans:[...scopes.values()].map(sc=>sc.plan)});
   const uploadIndex:unknown[]=[];
   for(const u of uploads.values()){
    const {chunks,text,...info}=u;const ids:string[]=[];
    const parts=text===undefined?chunks:[Buffer.from(text)];
    for(const [i,bytes]of parts.entries()){const id=s.id+':'+u.id+':'+i;ids.push(id);records.push({role:'metadata-snapshot',id,bytes:Buffer.from(bytes)});}
    uploadIndex.push({...info,records:ids});
   }
   for(const [k,sc]of scopes){
    const id=ownedDigest({sessionId:s.id,scope:k});
    add('event-ledger',id,{sessionId:s.id,scope:sc.plan,head:sc.head,sequence:sc.sequence,events:sc.events.map(e=>parseOwnedJson(e))});
    if(sc.terminal)add('terminal-record',id,{sessionId:s.id,scope:sc.plan,terminal:sc.terminal});
    const action=sc.events.map(e=>parseOwnedJson(e) as any).find(e=>e.payload.kind==='action-start');
    if(action)add('action-reservation',id,{sessionId:s.id,scope:sc.plan,witnessId:sc.witnessId,consumed:true,sequence:action.sequence,eventDigest:ownedSha256(canonicalOwnedJson(action))});
   }
   sessions.push({summary:this.#summary(s),uploads:uploadIndex,operations:[...(this.#historicalOperations.get(s.id)??[]),...[...acks].map(([id,a])=>({id:ownedSha256(id),requestDigest:a.digest,resultDigest:ownedSha256(canonicalOwnedJson(redactReply(a.reply)))}))]});
  }
  add('session-manifest','root',{schema:'osv-mcp.gradle-owned-authority-snapshot-v1',authorityId:this.config.authorityId,limits:this.#limits,sessions:manifests});
  if(!records.some(r=>r.role==='event-ledger'))add('event-ledger','empty',{events:[]});
  add('session-index','root',{slots:[...this.#state.slots],sessions,records:records.map(r=>({id:r.id,role:r.role,size:r.bytes.length,sha256:ownedSha256(r.bytes)})),backendEligible:false});
  return records;
 }
 async #save(operationId:string,requestDigest:string,reply:unknown){
  try{
   const records=this.#snapshot(),digest=this.#snapshotDigest(records);
   records.push({role:'operation-result',id:'root',bytes:Buffer.from(canonicalOwnedJson(redactReply(reply)))});
   const receipt=await this.#journal!.commit({operationId,requestDigest,records,expectedHead:this.#expectedHead});
   this.#expectedHead=this.#journal!.head;this.#durableDigest=digest;return receipt;
  }catch(e){this.#durableStopped=true;throw e;}
 }
 async #saveExpiration():Promise<void>{
  try{if(this.#snapshotDigest(this.#snapshot())!==this.#durableDigest)await this.#save(fresh(),ownedDigest({domain:'authority-expiration-v1'}),{maintenance:'expiration',backendEligible:false});}
  catch(e){this.#durableStopped=true;throw e;}
 }
 #dispatch(actor:object,input:unknown):any {
  const identity=this.#actors.get(actor);requireThat(identity,'permission_denied');
  const started=this.#clock();
  let c:AuthorityOperation;let encoded:string;
  try{assertData(input);encoded=canonicalOwnedJson(input);c=authorityOperation.parse(parseOwnedJson(encoded));}catch{fail('schema_invalid');}
  const now=this.#clock();this.#expire(now);
  const before=this.#state;this.#state=clone(before);
  let ended=now;
  try {
   const digest=ownedSha256(encoded),reply=this.#apply(identity,c,digest,now);
   ended=this.#clock();
   if(c.operation==='lookup'){
    // Recompute the read after applying expiry at its return-time boundary.
    // Skipping the deadline check alone would leak a pre-expiry terminal.
    this.#expire(ended);
    return copy(this.#apply(identity,c,digest,ended));
   }
   const target=c.operation==='begin'?this.#state.sessions.get(reply.sessionId):this.#state.sessions.get(c.sessionId);
   if(target)requireThat(ended-target.created<this.#limits.sessionMilliseconds,'expired');
   if(c.operation==='put-metadata-chunk')requireThat(ended-started<=this.#limits.chunkMilliseconds,'deadline_exceeded');
   return copy(reply);
  }catch(e){this.#state=before;this.#expire(ended);throw e;}
 }
 #apply(identity:Identity,c:AuthorityOperation,digest:string,now:number):any {
  const ackKey=identity.id+':'+c.operationId;
  if(c.operation==='begin'){
   requireThat(identity.role==='caller'&&!identity.sessionId,'permission_denied');const prior=this.#state.begins.get(ackKey);
   if(prior){requireThat(prior.digest===digest,'replay_conflict');return {...prior.reply,historical:true};}
   requireThat([...this.#state.sessions.keys()].filter(id=>!this.#historicalOperations.has(id)).length<this.#limits.sessions,'budget_exceeded');
   const s:Session={id:fresh(),owner:identity.id,consumerId:c.consumerId,scanRunId:c.scanRunId,projectRootId:c.projectRootId,settingsDigest:c.settingsDigest,scopeRequestsDigest:c.scopeRequestsDigest,graphId:fresh(),exportId:fresh(),executionId:fresh(),nonce:fresh(),coreUploadId:fresh(),created:now,revision:1,lifecycle:'draft',validity:'unselected',scopes:new Map(),uploads:new Map(),acks:new Map(),metadataBytes:0,ledgerBytes:0,eventCount:0};
   s.uploads.set(s.coreUploadId,{id:s.coreUploadId,purpose:'core',revision:0,state:'open',chunks:[],received:0});this.#state.sessions.set(s.id,s);
   const reply=this.#summary(s);this.#state.begins.set(ackKey,{digest,reply});return reply;
  }
  const s=this.#state.sessions.get(c.sessionId);requireThat(s,'session_missing');this.#authorize(identity,s,c);
  if(c.operation==='lookup'){
   const sc=this.#scope(s,c.scope);const current=s.validity==='current'&&s.lifecycle!=='closed'&&sc.validity==='current';
   return {backendEligible:false,diagnosticEligible:false,ownedFileReads:0,readerProjection:{status:'unavailable',reason:'backend-unsupported'},contractStatus:current?sc.terminal?.outcome??'receipt-missing':'session-unavailable',...(current&&sc.terminal?{terminal:sc.terminal}:{})};
  }
  requireThat(s.lifecycle!=='closed','not_current');
  if(c.operation!=='bind-core'&&c.operation!=='activate'&&!(c.operation==='put-metadata-chunk'&&c.purpose==='core'))this.#live(s);
  const prior=s.acks.get(ackKey);if(prior){requireThat(prior.digest===digest,'replay_conflict');return {...prior.reply,historical:true};}
  requireThat(s.acks.size<this.#limits.operations,'budget_exceeded');
  let reply:any;
  if(c.operation==='put-metadata-chunk')reply=this.#chunk(s,c);
  else if(c.operation==='bind-core'){
   requireThat(s.lifecycle==='draft'&&c.expectedRevision===s.revision,'lifecycle_invalid');
   const u=this.#ref(s,c.coreMetadataRef,'core');requireThat(c.coreGraphDigest===u.ref!.rawSha256,'content_mismatch');
   const core=parseGradleGraph(u.text!,createGradleBudget());requireThat(canonicalOwnedJson(core,this.#limits.coreBytes)===u.text,'content_mismatch');
   const manifestDigest=ownedDigest({domain:'authority-session-manifest-v1',authorityId:this.config.authorityId,sessionId:s.id,graphId:s.graphId,exportId:s.exportId,executionId:s.executionId,nonce:s.nonce,settingsDigest:s.settingsDigest,coreMetadataRef:c.coreMetadataRef,coreGraphDigest:c.coreGraphDigest,rootRegistryDigest:c.rootRegistryDigest,scopes:c.scopes});
   const scopes=new Map<string,Scope>();
   requireThat(ownedDigest(c.scopes.map(({project,context,invocation})=>({project,context,invocation})))===s.scopeRequestsDigest,'scope_mismatch');
   for(const plan of c.scopes){
    const k=key(plan);requireThat(!scopes.has(k)&&core.contexts.some(x=>x.id===plan.context&&x.projectId===plan.project),'scope_mismatch');
    requireThat(this.config.policy.registry.check(plan,this.config.policy.settings)==='witness_unavailable'&&this.config.policy.registry.authorization(plan,this.config.policy.settings)?.authorityId===this.config.authorityId,'profile_unapproved');
    scopes.set(k,{plan,revision:0,lifecycle:'planned',validity:'current',head:ownedDigest({domain:'authority-scope-genesis-v1',sessionId:s.id,manifestDigest,plan}),sequence:0,events:[]});
   }
   s.manifestDigest=manifestDigest;s.core=core;s.coreRef=copy(c.coreMetadataRef);s.coreDigest=c.coreGraphDigest;s.rootDigest=c.rootRegistryDigest;s.scopes=scopes;s.lifecycle='core-bound';s.revision++;reply=this.#summary(s);
  }else if(c.operation==='activate'){
   requireThat(s.lifecycle==='core-bound'&&s.revision===c.expectedRevision,'lifecycle_invalid');
   const current=this.#state.slots.get(slot(s));requireThat((current?.revision??0)===c.expectedCurrentRevision,'slot_conflict');
   if(current?.sessionId){const old=this.#state.sessions.get(current.sessionId)!;this.#closeSession(old,'superseded','superseded');}
   this.#state.slots.set(slot(s),{revision:c.expectedCurrentRevision+1,sessionId:s.id});s.validity='current';s.lifecycle='active';s.revision++;reply=this.#summary(s);
  }else if(c.operation==='register-scope'){
   const sc=this.#scope(s,c.scope);requireThat(sc.lifecycle==='planned'&&sc.revision===c.expectedRevision,'lifecycle_invalid');
   requireThat([...s.uploads.values()].filter(u=>u.state==='open').length<this.#limits.pendingUploads,'budget_exceeded');
   sc.witnessId=fresh();sc.uploadId=fresh();sc.capability=fresh();sc.lifecycle='registered';sc.revision++;
   s.uploads.set(sc.uploadId,{id:sc.uploadId,purpose:'seal',scope:copy(c.scope),witnessId:sc.witnessId,revision:0,state:'open',chunks:[],received:0});
   reply={...this.#scopeReply(sc),capability:sc.capability};
  }else if(c.operation==='append-event'){
   const sc=this.#scope(s,c.scope);requireThat(sc.validity==='current'&&sc.revision===c.expectedRevision&&c.sequence===sc.sequence+1&&c.previousDigest===sc.head,'revision_mismatch');
   if(c.event.kind==='action-start'){requireThat(sc.lifecycle==='registered'&&sc.capability===c.event.capability,'capability_invalid');sc.lifecycle='executing';}
   else {
    requireThat((sc.lifecycle==='executing'||sc.lifecycle==='registered')&&!sc.observation,'lifecycle_invalid');
    requireThat(sc.lifecycle==='registered'?c.event.lookup.status==='not-executed':c.event.lookup.status!=='not-executed','lifecycle_invalid');
    sc.observation={lookup:c.event.lookup,leases:c.event.leases};
   }
   const event={sessionId:s.id,scope:c.scope,sequence:c.sequence,previousDigest:c.previousDigest,issuerRole:identity.role,payload:c.event.kind==='action-start'?{kind:'action-start',capabilityConsumed:true}:c.event};
   const text=canonicalOwnedJson(event);const size=Buffer.byteLength(text);requireThat(s.eventCount<this.#limits.events&&s.ledgerBytes+size<=this.#limits.ledgerBytes,'budget_exceeded');
   sc.events.push(text);sc.head=ownedSha256(text);sc.sequence++;sc.revision++;s.eventCount++;s.ledgerBytes+=size;reply=this.#scopeReply(sc);
  }else if(c.operation==='seal-scope'){
   const sc=this.#scope(s,c.scope);requireThat(sc.validity==='current'&&sc.revision===c.expectedRevision&&sc.head===c.ledgerHead,'revision_mismatch');
   if(c.phase==='prepare'){requireThat((sc.lifecycle==='registered'||sc.lifecycle==='executing')&&sc.observation,'lifecycle_invalid');sc.lifecycle='sealing';sc.revision++;reply=this.#scopeReply(sc);}
   else {requireThat(sc.lifecycle==='sealing','lifecycle_invalid');const terminal=this.#seal(s,sc,c);this.#closeScope(s,sc,terminal.outcome);sc.terminal=terminal;reply=this.#scopeReply(sc);}
  }else {
   if(c.scope){const sc=this.#scope(s,c.scope);requireThat(c.expectedRevision===sc.revision,'revision_mismatch');if(c.operation==='abort')requireThat(sc.lifecycle!=='terminal','lifecycle_invalid');
    // An independently observed Task exception keeps its own terminal kind; otherwise the cause is unknown.
    const lookup=sc.observation?.lookup,aborted=lookup?.status==='unavailable'&&lookup.reason==='execution-aborted';
    this.#closeScope(s,sc,aborted?'execution-aborted':'unavailable',c.reason);if(c.operation==='revoke'){sc.validity='revoked';sc.revision++;}reply=this.#scopeReply(sc);}
   else {requireThat(c.expectedRevision===s.revision,'revision_mismatch');this.#closeSession(s,c.operation==='abort'?'aborted':'revoked',c.reason);reply=this.#summary(s);}
  }
  const safeReply={...reply,backendEligible:false,diagnosticEligible:false,ownedFileReads:0};s.acks.set(ackKey,{digest,reply:copy(safeReply)});return safeReply;
 }
 #scopeReply(sc:Scope):any {return {revision:sc.revision,lifecycle:sc.lifecycle,validity:sc.validity,ledgerHead:sc.head,sequence:sc.sequence,...(sc.witnessId?{witnessId:sc.witnessId}:{}),...(sc.uploadId?{uploadId:sc.uploadId}:{}),...(sc.terminal?{terminal:sc.terminal}:{})};}
 #ref(s:Session,ref:AuthorityMetadataRef,purpose:'core'|'seal'):Upload {const u=s.uploads.get(ref.uploadId);requireThat(u&&u.state==='frozen'&&u.purpose===purpose&&same(u.ref,ref),'ref_mismatch');return u;}
 #chunk(s:Session,c:Extract<AuthorityOperation,{operation:'put-metadata-chunk'}>):any {
  const u=s.uploads.get(c.uploadId);requireThat(u&&u.purpose===c.purpose&&u.state==='open'&&u.revision===c.expectedRevision,'upload_invalid');
  if(c.purpose==='core')requireThat(s.lifecycle==='draft','lifecycle_invalid');
  else {const sc=this.#scope(s,c.scope);requireThat((sc.lifecycle==='registered'||sc.lifecycle==='executing')&&sc.validity==='current'&&same(u.scope,c.scope)&&u.witnessId===c.witnessId,'scope_mismatch');}
  const maximum=c.purpose==='core'?this.#limits.coreBytes:this.#limits.projectionBytes;
  requireThat(c.totalBytes<=maximum&&c.ordinal===u.chunks.length,'budget_exceeded');
  requireThat(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(c.base64),'content_mismatch');
  const bytes=Buffer.from(c.base64,'base64');requireThat(bytes.length>0&&bytes.length<=this.#limits.chunkBytes&&bytes.toString('base64')===c.base64&&ownedSha256(bytes)===c.chunkSha256,'content_mismatch');
  if(u.total===undefined){requireThat(s.metadataBytes+c.totalBytes<=this.#limits.metadataBytes,'budget_exceeded');u.total=c.totalBytes;u.digest=c.totalSha256;s.metadataBytes+=c.totalBytes;}
  requireThat(u.total===c.totalBytes&&u.digest===c.totalSha256&&u.received+bytes.length<=u.total,'content_mismatch');
  requireThat(u.received+bytes.length===u.total||bytes.length===this.#limits.chunkBytes,'content_mismatch');
  u.chunks.push(bytes);u.received+=bytes.length;u.revision++;
  if(u.received!==u.total)return {uploadId:u.id,revision:u.revision,frozen:false};
  const all=Buffer.concat(u.chunks);requireThat(ownedSha256(all)===u.digest,'content_mismatch');
  let text:string;let raw:unknown;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(all);raw=parseOwnedJson(text,maximum);requireThat(canonicalOwnedJson(raw,maximum)===text,'content_mismatch');if(c.purpose==='core')parseGradleGraph(text,createGradleBudget());else authorityProjection.parse(raw);}catch{fail('metadata_invalid');}
  u.text=text;u.chunks=[];u.state='frozen';u.ref={uploadId:u.id,purpose:u.purpose,byteLength:all.length,rawSha256:u.digest!};return {uploadId:u.id,revision:u.revision,frozen:true,ref:u.ref};
 }
 #seal(s:Session,sc:Scope,c:Extract<AuthorityOperation,{operation:'seal-scope';phase:'commit'}>):Terminal {
  const base={ledgerHead:sc.head};
  try {
   const observation=sc.observation!;let claim:OwnedExecutionClaim;
   if(observation.lookup.status==='verified'){
    requireThat(c.sealMetadataRef&&c.pair,'required_metadata_missing');const u=this.#ref(s,c.sealMetadataRef,'seal');
    requireThat(same(u.scope,{project:sc.plan.project,context:sc.plan.context,invocation:sc.plan.invocation})&&u.witnessId===sc.witnessId,'scope_mismatch');
    const projection=authorityProjection.parse(parseOwnedJson(u.text!,this.#limits.projectionBytes));requireThat(same(projection.coreMetadataRef,s.coreRef)&&projection.graphId===s.graphId&&projection.exportId===s.exportId,'ref_mismatch');
    const digests=projection.ownedOfferObjects.map(o=>o.objectDigest);requireThat(digests.every((d,i)=>i===0||digests[i-1]!<d),'inventory_mismatch');
    const {coreMetadataRef:_,...body}=projection;const parsed=parseGradleExportG0(canonicalOwnedJson({...body,coreGraph:s.core},OWNED_LIMITS.metadataBytes));
    requireThat(parsed.owned?.manifestStructure==='verified'&&parsed.executions.length===1,'g0_invalid');claim=parsed.executions[0]!;
    requireThat(claim.project===sc.plan.project&&claim.context===sc.plan.context&&claim.invocation===sc.plan.invocation&&claim.witnessId===sc.witnessId&&claim.profileId===sc.plan.profileId&&claim.recipeId===sc.plan.recipeId&&claim.coreGraphDigest===s.coreDigest&&claim.executionId===s.executionId&&claim.profileDigest===sc.plan.profileDigest&&claim.recipeDigest===sc.plan.recipeDigest&&claim.bundleDigest===c.pair.bundleDigest&&claim.envelopeDigest===c.pair.envelopeDigest,'claim_mismatch');
   }else {
    requireThat(!c.sealMetadataRef&&!c.pair,'unexpected_metadata');
    // Non-verified lookups are classified from the observed lookup and session scope only: inspectOwnedExecution
    // reads project/context/invocation, profile/recipe digests and witnessId here. The remaining fields are inert
    // placeholders that only a verified lookup would compare; a non-verified path reaching G3 is rejected below.
    claim={profileId:sc.plan.profileId,recipeId:sc.plan.recipeId,graphId:s.graphId,exportId:s.exportId,executionId:s.executionId,coreGraphDigest:s.coreDigest!,project:sc.plan.project,context:sc.plan.context,invocation:sc.plan.invocation,profileDigest:sc.plan.profileDigest,recipeDigest:sc.plan.recipeDigest,witnessId:sc.witnessId!,bundleDigest:'1'.repeat(64),envelopeDigest:'1'.repeat(64),plannedCaptures:sc.plan.plannedCaptures,captures:0,state:{producerState:'unavailable',completedThrough:'none',approvalStatus:'approved',profileDigest:sc.plan.profileDigest,recipeDigest:sc.plan.recipeDigest,blockedStage:'prepare',unavailableReason:'image_unsupported'},stages:[],processes:[]};
   }
   const authorization=this.config.policy.registry.authorization(sc.plan,this.config.policy.settings);requireThat(authorization,'profile_unapproved');
   const session={schema:'osv-mcp.gradle-owned-session-v1',authorityId:this.config.authorityId,sessionId:s.id,nonce:s.nonce,graphId:s.graphId,exportId:s.exportId,executionId:s.executionId,coreGraphDigest:s.coreDigest,rootRegistryDigest:s.rootDigest,isolationEvidenceRef:ownedDigest({domain:'unproven-stage-a1',authorityId:this.config.authorityId}),status:'current',scopes:[{project:sc.plan.project,context:sc.plan.context,invocation:sc.plan.invocation,taskId:sc.plan.taskId,actionId:sc.plan.actionId,brokerInstanceId:sc.plan.brokerInstanceId,plannedCaptures:sc.plan.plannedCaptures,profileDigest:sc.plan.profileDigest,recipeDigest:sc.plan.recipeDigest}],leases:observation.leases};
   const reason=inspectOwnedExecution(claim,{backend:'caller-owned-receipt-store-v1',session,lookup:()=>observation.lookup},authorization);
   if(reason==='capability_unsupported'){requireThat(observation.lookup.status==='verified','claim_mismatch');return {...base,outcome:'structure-verified',...c.pair!,sealMetadataRef:c.sealMetadataRef!};}
   if(reason==='action_not_executed')return {...base,outcome:'not-executed'};
   if(reason==='execution_aborted')return {...base,outcome:'execution-aborted'};
   if(reason==='witness_unavailable')return {...base,outcome:'unavailable',reason};
   return {...base,outcome:'invalid',reason};
  }catch(e){return {...base,outcome:'invalid',reason:e instanceof OwnedAuthorityContractError?e.message:'authority_contract_seal_invalid'};}
 }
}

/** Raw capabilities remain only in the live kernel. Saved results contain a digest, never a replayable bearer. */
function redactReply(value:any):any {
 if(Array.isArray(value))return value.map(redactReply);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>k==='capability'?['capabilityDigest',ownedSha256(String(v))]:[k,redactReply(v)]));
 return value;
}
