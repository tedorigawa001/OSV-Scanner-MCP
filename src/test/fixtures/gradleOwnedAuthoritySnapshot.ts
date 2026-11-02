/** A2 snapshot decoder for restart invalidation only. Never restores live credentials. */
import {z} from 'zod';
import {authorityId as id,authorityHash as hash,authorityPlan,authorityScope,authorityMetadataRef,authorityProjection,AUTHORITY_LIMITS} from './gradleOwnedAuthoritySchema.js';
import {ownedLookupSchema,ownedSessionSchema} from '../../utils/gradleOwnedExecution.js';
import {canonicalOwnedJson,parseOwnedJson,ownedSha256,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {parseGradleGraph} from '../../utils/gradleGraph.js';
import type {JournalRecord} from './gradleOwnedAuthorityJournal.js';
export const SNAPSHOT_SESSION_LIMIT=256;
const n=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const validity=z.enum(['unselected','current','superseded','revoked','expired','aborted','restarted']);
const lifecycle=z.enum(['draft','core-bound','active','committed','closed']);
const terminal=z.object({outcome:z.enum(['structure-verified','not-executed','execution-aborted','unavailable','invalid']),ledgerHead:hash,bundleDigest:hash.optional(),envelopeDigest:hash.optional(),sealMetadataRef:authorityMetadataRef.optional(),reason:id.optional()}).strict();
const scopeSummary=z.object({scope:authorityScope,revision:n,lifecycle:z.enum(['planned','registered','executing','sealing','terminal']),validity:z.enum(['current','revoked']),ledgerHead:hash,sequence:n,witnessId:id.optional(),uploadId:id.optional(),terminal:terminal.optional()}).strict();
const manifestSession=z.object({id,owner:id,consumerId:id,scanRunId:id,projectRootId:id,settingsDigest:hash,scopeRequestsDigest:hash,manifestDigest:hash.optional(),graphId:id,exportId:id,executionId:id,nonce:id,coreUploadId:id,created:n,revision:n,lifecycle,validity,coreRef:authorityMetadataRef.optional(),coreDigest:hash.optional(),rootDigest:hash.optional(),metadataBytes:n,ledgerBytes:n,eventCount:n,plans:z.array(authorityPlan).max(2000)}).strict();
const limits=z.object(Object.fromEntries(Object.entries(AUTHORITY_LIMITS).map(([k,v])=>[k,z.number().int().positive().max(v)])));
const manifest=z.object({schema:z.literal('osv-mcp.gradle-owned-authority-snapshot-v1'),authorityId:id,limits:limits.strict(),sessions:z.array(manifestSession).max(SNAPSHOT_SESSION_LIMIT)}).strict();
const summary=z.object({sessionId:id,graphId:id,exportId:id,executionId:id,nonce:id,coreUploadId:id,revision:n,lifecycle,validity,currentRevision:n,metadataBytes:n,coreMetadataRef:authorityMetadataRef.optional(),manifestDigest:hash.optional(),ledgerBytes:n,eventCount:n,scopes:z.array(scopeSummary).max(2000),backendEligible:z.literal(false),diagnosticEligible:z.literal(false),ownedFileReads:z.literal(0)}).strict();
const upload=z.object({id,purpose:z.enum(['core','seal']),scope:authorityScope.optional(),witnessId:id.optional(),revision:n,state:z.enum(['open','frozen','cancelled']),received:n,total:n.optional(),digest:hash.optional(),ref:authorityMetadataRef.optional(),records:z.array(id).max(64)}).strict();
const operation=z.object({id:hash,requestDigest:hash,resultDigest:hash}).strict();
const descriptor=z.object({id,role:z.enum(['session-manifest','metadata-snapshot','event-ledger','terminal-record','action-reservation']),size:n,sha256:hash}).strict();
const index=z.object({slots:z.array(z.tuple([z.string().min(1).max(4096),z.object({revision:n,sessionId:id.optional()}).strict()])).max(SNAPSHOT_SESSION_LIMIT),sessions:z.array(z.object({summary,uploads:z.array(upload).max(2001),operations:z.array(operation).max(AUTHORITY_LIMITS.operations)}).strict()).max(SNAPSHOT_SESSION_LIMIT),records:z.array(descriptor).max(4096),backendEligible:z.literal(false)}).strict();
const event=z.object({sessionId:id,scope:authorityScope,sequence:n,previousDigest:hash,issuerRole:z.enum(['broker','observer']),payload:z.union([z.object({kind:z.literal('action-start'),capabilityConsumed:z.literal(true)}).strict(),z.object({kind:z.literal('execution-observation'),lookup:ownedLookupSchema,leases:ownedSessionSchema.shape.leases}).strict()])}).strict();
const ledger=z.object({sessionId:id,scope:authorityPlan,head:hash,sequence:n,events:z.array(event).max(AUTHORITY_LIMITS.events)}).strict();
const terminalRecord=z.object({sessionId:id,scope:authorityPlan,terminal}).strict();
const reservation=z.object({sessionId:id,scope:authorityPlan,witnessId:id,consumed:z.literal(true),sequence:n,eventDigest:hash}).strict();
export type SnapshotSession=z.infer<typeof manifestSession>;
export type SnapshotScope=z.infer<typeof scopeSummary>;
export type SnapshotUpload=z.infer<typeof upload>;
export interface DecodedSession {manifest:SnapshotSession;summary:z.infer<typeof summary>;uploads:{info:SnapshotUpload;parts:Buffer[];text?:string}[];scopes:{info:SnapshotScope;plan:z.infer<typeof authorityPlan>;events:string[];observation?:{lookup:ReturnType<typeof ownedLookupSchema.parse>;leases:unknown[]}}[];operations:z.infer<typeof operation>[]}
export interface DecodedSnapshot {sessions:DecodedSession[];slots:z.infer<typeof index>['slots'];limits:Record<string,number>}
const equal=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
const scopeKey=(s:z.infer<typeof authorityScope>)=>JSON.stringify([s.project,s.context,s.invocation]);
const onlyScope=({project,context,invocation}:z.infer<typeof authorityScope>)=>({project,context,invocation});
function check(ok:unknown):asserts ok {if(!ok)throw Error('authority_snapshot_invalid');}
export function decodeAuthoritySnapshot(records:JournalRecord[],authorityId:string):DecodedSnapshot {
 try{return decode(records,authorityId);}catch{throw Error('authority_snapshot_invalid');}
}
function decode(records:JournalRecord[],authorityId:string):DecodedSnapshot {
 const used=new Set<string>(),all=new Map(records.map(r=>[JSON.stringify([r.role,r.id]),r]));check(all.size===records.length);
 const take=(role:JournalRecord['role'],id:string)=>{const k=JSON.stringify([role,id]),r=all.get(k);check(r&&!used.has(k));used.add(k);return r.bytes;};
 const raw=<T>(role:JournalRecord['role'],id:string,schema:z.ZodType<T>)=>{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(take(role,id)),value=parseOwnedJson(text,64*1024*1024);check(canonicalOwnedJson(value,64*1024*1024)===text);return schema.parse(value);};
 const m=raw('session-manifest','root',manifest),ix=raw('session-index','root',index);check(m.authorityId===authorityId&&m.sessions.length===ix.sessions.length);
 raw('operation-result','root',z.unknown());
 check(equal(ix.records,records.filter(r=>r.role!=='session-index'&&r.role!=='operation-result').map(r=>({id:r.id,role:r.role,size:r.bytes.length,sha256:ownedSha256(r.bytes)}))));
 const slots=new Map(ix.slots);check(slots.size===ix.slots.length);
 const seen=new Set<string>(),sessions:DecodedSession[]=[];
 for(const s of m.sessions){
  check(!seen.has(s.id));seen.add(s.id);
  const entry=ix.sessions.find(x=>x.summary.sessionId===s.id);check(entry);const view=entry.summary;
  for(const k of ['graphId','exportId','executionId','nonce','coreUploadId','revision','lifecycle','validity','metadataBytes','ledgerBytes','eventCount'] as const)check(view[k]===s[k]);
  check(equal(view.coreMetadataRef??null,s.coreRef??null)&&equal(view.manifestDigest??null,s.manifestDigest??null));
  const slot=slots.get(JSON.stringify([s.consumerId,s.projectRootId]));check(view.currentRevision===(slot?.revision??0));
  check((s.validity==='current')===(slot?.sessionId===s.id));check((s.lifecycle==='closed')===['expired','aborted','revoked','superseded','restarted'].includes(s.validity));
  check(s.manifestDigest?!!s.coreRef&&!!s.coreDigest&&!!s.rootDigest:s.plans.length===0&&!s.coreRef&&!s.coreDigest&&!s.rootDigest&&(s.lifecycle==='draft'||s.lifecycle==='closed'));
  if(s.manifestDigest)check(s.scopeRequestsDigest===ownedDigest(s.plans.map(onlyScope))&&s.manifestDigest===ownedDigest({domain:'authority-session-manifest-v1',authorityId,sessionId:s.id,graphId:s.graphId,exportId:s.exportId,executionId:s.executionId,nonce:s.nonce,settingsDigest:s.settingsDigest,coreMetadataRef:s.coreRef,coreGraphDigest:s.coreDigest,rootRegistryDigest:s.rootDigest,scopes:s.plans}));
  check(s.plans.length===view.scopes.length&&new Set(s.plans.map(scopeKey)).size===s.plans.length&&new Set(view.scopes.map(sc=>scopeKey(sc.scope))).size===view.scopes.length);
  const decoded:DecodedSession={manifest:s,summary:view,uploads:[],scopes:[],operations:entry.operations};
  check(new Set(entry.operations.map(o=>o.id)).size===entry.operations.length);
  check(new Set(entry.uploads.map(u=>u.id)).size===entry.uploads.length&&entry.uploads.some(u=>u.id===s.coreUploadId&&u.purpose==='core')&&entry.uploads.filter(u=>u.purpose==='core').length===1);
  for(const u of entry.uploads){
   check(u.records.every((id,i)=>id===s.id+':'+u.id+':'+i));
   const parts=u.records.map(id=>Buffer.from(take('metadata-snapshot',id))),bytes=Buffer.concat(parts);
   check(bytes.length===u.received&&u.received<=(u.total??0));
   check(u.total===undefined?u.received===0&&u.digest===undefined:!!u.digest&&u.total>0&&u.total<=(u.purpose==='core'?m.limits.coreBytes!:m.limits.projectionBytes!));
   check(u.purpose==='core'?u.scope===undefined&&u.witnessId===undefined:u.scope!==undefined&&u.witnessId!==undefined);
   let text:string|undefined;
   if(u.state==='frozen'){
    check(parts.length===1&&u.ref&&u.received===u.total&&u.ref.uploadId===u.id&&u.ref.purpose===u.purpose&&u.ref.byteLength===u.received&&u.ref.rawSha256===u.digest&&ownedSha256(bytes)===u.digest);
    text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);const body=parseOwnedJson(text,64*1024*1024);check(canonicalOwnedJson(body,64*1024*1024)===text);
    if(u.purpose==='core')parseGradleGraph(text);else authorityProjection.parse(body);
   }else check(!u.ref&&parts.every(p=>p.length===m.limits.chunkBytes)&&(u.total===undefined||u.received<u.total));
   decoded.uploads.push({info:u,parts,text});
  }
  if(s.coreRef){const core=decoded.uploads.find(u=>u.info.id===s.coreRef!.uploadId);check(core?.info.state==='frozen'&&equal(core.info.ref,s.coreRef)&&s.coreRef.rawSha256===s.coreDigest);}
  check(entry.uploads.reduce((n,u)=>n+(u.total??0),0)===s.metadataBytes&&s.metadataBytes<=m.limits.metadataBytes!);
  let count=0,ledgerBytes=0;
  for(const plan of s.plans){
   const info=view.scopes.find(sc=>scopeKey(sc.scope)===scopeKey(plan));check(info);
   const id=ownedDigest({sessionId:s.id,scope:scopeKey(plan)}),l=raw('event-ledger',id,ledger);
   check(l.sessionId===s.id&&equal(l.scope,plan)&&l.head===info.ledgerHead&&l.sequence===info.sequence&&info.sequence===l.events.length);
   let head=ownedDigest({domain:'authority-scope-genesis-v1',sessionId:s.id,manifestDigest:s.manifestDigest,plan}),action:z.infer<typeof event>|undefined,observation:DecodedSession['scopes'][number]['observation'];
   for(const [i,e]of l.events.entries()){
    check(e.sessionId===s.id&&equal(e.scope,onlyScope(plan))&&e.sequence===i+1&&e.previousDigest===head);
    if(e.payload.kind==='action-start'){check(!action&&!observation&&e.issuerRole==='broker');action=e;}
    else {check(!observation&&e.issuerRole==='observer');observation={lookup:e.payload.lookup,leases:e.payload.leases};}
    const text=canonicalOwnedJson(e);head=ownedSha256(text);count++;ledgerBytes+=Buffer.byteLength(text);
   }
   check(head===l.head);
   if(action){const r=raw('action-reservation',id,reservation);check(equal(r,{sessionId:s.id,scope:plan,witnessId:info.witnessId,consumed:true,sequence:action.sequence,eventDigest:ownedDigest(action)}));}
   check(info.lifecycle==='planned'?!info.witnessId&&!info.uploadId&&info.revision===0:info.lifecycle==='terminal'&&!info.witnessId?!info.uploadId&&info.sequence===0:!!info.witnessId&&!!info.uploadId);
   if(info.uploadId){const u=entry.uploads.find(u=>u.id===info.uploadId);check(u&&u.purpose==='seal'&&equal(u.scope,info.scope)&&u.witnessId===info.witnessId);}
   check((info.lifecycle==='terminal')===!!info.terminal);if(s.lifecycle==='closed'||s.lifecycle==='committed')check(info.lifecycle==='terminal');
   if(info.terminal){
    const t=raw('terminal-record',id,terminalRecord);check(t.sessionId===s.id&&equal(t.scope,plan)&&equal(t.terminal,info.terminal)&&t.terminal.ledgerHead===head);
    if(t.terminal.outcome==='structure-verified'){
     const ref=t.terminal.sealMetadataRef,u=decoded.uploads.find(u=>u.info.id===ref?.uploadId);
     check(ref&&t.terminal.bundleDigest&&t.terminal.envelopeDigest&&u?.info.state==='frozen'&&u.info.purpose==='seal'&&equal(u.info.ref,ref)&&equal(u.info.scope,info.scope)&&u.info.witnessId===info.witnessId);
    }else check(!t.terminal.bundleDigest&&!t.terminal.envelopeDigest&&!t.terminal.sealMetadataRef);
   }
   decoded.scopes.push({info,plan,events:l.events.map(e=>canonicalOwnedJson(e)),observation});
  }
  check(count===s.eventCount&&ledgerBytes===s.ledgerBytes&&ledgerBytes<=m.limits.ledgerBytes!&&count<=m.limits.events!);
  check(entry.uploads.filter(u=>u.purpose==='seal').every(u=>view.scopes.some(sc=>sc.uploadId===u.id)));
  sessions.push(decoded);
 }
 check(new Set(ix.sessions.map(s=>s.summary.sessionId)).size===ix.sessions.length);
 for(const [key,slot]of slots){const pair:unknown=JSON.parse(key);check(Array.isArray(pair)&&pair.length===2&&pair.every(x=>id.safeParse(x).success)&&JSON.stringify(pair)===key);if(slot.sessionId){const s=m.sessions.find(s=>s.id===slot.sessionId);check(s&&s.validity==='current'&&s.lifecycle!=='closed'&&key===JSON.stringify([s.consumerId,s.projectRootId]));}}
 if(!sessions.some(s=>s.scopes.length))raw('event-ledger','empty',z.object({events:z.array(z.never()).length(0)}).strict());
 check(used.size===all.size);return {sessions,slots:ix.slots,limits:m.limits};
}
