/** PO3/P0 static replay fixture. No IO, registry, migration authority or durable ack. Not shipped. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonicalOwnedJson,ownedDigest,ownedSha256,parseOwnedJson,OwnedManifestError} from '../../utils/gradleOwnedJson.js';
import {decodeAuthoritySnapshot} from './gradleOwnedAuthoritySnapshot.js';
import {journalRoles} from './gradleOwnedAuthorityJournal.js';
export const V2_LIMITS=Object.freeze({records:4096,changes:4096,commits:256,payloads:8192,logicalBytes:64*1024*1024,storeBytes:256*1024*1024,envelopeBytes:8*1024*1024,historyBytes:64*1024*1024});
export class JournalV2Error extends Error{constructor(reason:string){super('journal_v2_'+reason);}}
function check(ok:unknown,reason:string):asserts ok{if(!ok)throw new JournalV2Error(reason);}
const id=z.string().min(1).max(1024),hash=z.string().regex(/^[a-f0-9]{64}$/),natural=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const v2BindingSchema=z.object({authorityId:id,lineageId:id,storeEpoch:hash,generation:natural.positive(),profileDigest:hash}).strict();
export const v2KeySchema=z.object({role:z.enum([...journalRoles,'tombstone-core','retire-receipt','control-object','maintenance-record']),id}).strict();
const ref=z.object({sha256:hash,byteLength:natural.max(V2_LIMITS.logicalBytes)}).strict();
const baseRefSchema=ref.extend({role:z.literal('compacted-base'),id}).strict();
const descriptor=z.object({key:v2KeySchema,ref}).strict();
const usageSchema=z.object({records:natural.max(V2_LIMITS.records),logicalBytes:natural.max(V2_LIMITS.logicalBytes),uniquePayloadBytes:natural.max(V2_LIMITS.logicalBytes)}).strict();
const common={schema:z.literal('osv-mcp.gradle-owned-journal-commit-v2'),schemaVersion:z.literal(2),layout:z.literal('typed-flat-map-v1'),...v2BindingSchema.shape,baseRef:baseRefSchema,revision:natural.positive().max(V2_LIMITS.commits),previousCommit:hash,fromStateRoot:hash,toStateRoot:hash,namespaceRoot:hash,indexRoot:hash,budgetRoot:hash,usage:usageSchema,operation:z.object({id,requestDigest:hash,resultRef:ref}).strict()};
const change=z.discriminatedUnion('op',[
 z.object({op:z.literal('add'),key:v2KeySchema,ref}).strict(),
 z.object({op:z.literal('replace'),key:v2KeySchema,expectedOldRef:ref,ref}).strict(),
 z.object({op:z.literal('remove'),key:v2KeySchema,expectedOldRef:ref}).strict(),
]);
export const v2CommitSchema=z.discriminatedUnion('recordMode',[
 z.object({...common,recordMode:z.literal('full'),records:z.array(descriptor).min(4).max(V2_LIMITS.records)}).strict(),
 z.object({...common,recordMode:z.literal('delta'),changes:z.array(change).max(V2_LIMITS.changes)}).strict(),
]);
type Descriptor=z.infer<typeof descriptor>;
export type V2Binding=z.infer<typeof v2BindingSchema>;
export type V2Record={key:z.infer<typeof v2KeySchema>;bytes:Buffer};
const envelopeSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-journal-v2-envelope'),keyId:id,body:v2CommitSchema,mac:hash}).strict();
const keyText=(key:Descriptor['key'])=>canonicalOwnedJson(key);
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
export function v2Genesis(binding:V2Binding,baseRef:z.infer<typeof baseRefSchema>):string{return ownedDigest({domain:'owned-journal-v2-genesis',layout:'typed-flat-map-v1',binding:v2BindingSchema.parse(binding),baseRef:baseRefSchema.parse(baseRef)});}
function summarize(input:Descriptor[]){
 check(input.length<=V2_LIMITS.records,'budget_exceeded');const records=[...input].sort((a,b)=>keyText(a.key)<keyText(b.key)?-1:keyText(a.key)>keyText(b.key)?1:0),seen=new Set<string>(),unique=new Map<string,number>();let logicalBytes=0;
 for(const r of records){const k=keyText(r.key);check(!seen.has(k),'duplicate_key');seen.add(k);logicalBytes+=r.ref.byteLength;const old=unique.get(r.ref.sha256);check(old===undefined||old===r.ref.byteLength,'ref_mismatch');unique.set(r.ref.sha256,r.ref.byteLength);}
 check(logicalBytes<=V2_LIMITS.logicalBytes,'budget_exceeded');
 for(const role of ['session-manifest','session-index','operation-result']){const rows=records.filter(r=>r.key.role===role);check(rows.length===1&&rows[0]!.key.id==='root','required_record_missing');}
 check(records.some(r=>r.key.role==='event-ledger'),'required_record_missing');
 const usage={records:records.length,logicalBytes,uniquePayloadBytes:[...unique.values()].reduce((a,b)=>a+b,0)};
 const namespaceRoot=ownedDigest({domain:'owned-journal-v2-namespace',keys:records.map(r=>r.key)}),indexRoot=ownedDigest({domain:'owned-journal-v2-index',records}),budgetRoot=ownedDigest({domain:'owned-journal-v2-budget',usage});
 const toStateRoot=ownedDigest({domain:'owned-journal-v2-state',layout:'typed-flat-map-v1',namespaceRoot,indexRoot,budgetRoot});
 return {records,usage,roots:{namespaceRoot,indexRoot,budgetRoot,toStateRoot}};
}
/** Author-side reference helper; never trusts a caller-supplied digest as proof of bytes. */
export function v2StateSummary(input:V2Record[]){
 check(Array.isArray(input)&&input.length<=V2_LIMITS.records,'budget_exceeded');let bytes=0;
 const rows=input.map(r=>{check(Buffer.isBuffer(r.bytes),'payload_invalid');bytes+=r.bytes.length;check(bytes<=V2_LIMITS.logicalBytes,'budget_exceeded');return {key:v2KeySchema.parse(r.key),ref:{sha256:ownedSha256(r.bytes),byteLength:r.bytes.length}};});return summarize(rows);
}
export function sealV2Commit(body:unknown,keyId:string,key:Buffer):Buffer{
 id.parse(keyId);check(Buffer.isBuffer(key)&&key.length===32,'configuration_invalid');const parsed=v2CommitSchema.parse(body),payload={schema:'osv-mcp.gradle-owned-journal-v2-envelope' as const,keyId,body:parsed};
 const mac=createHmac('sha256',key).update(canonicalOwnedJson(payload,V2_LIMITS.envelopeBytes)).digest('hex');return Buffer.from(canonicalOwnedJson({...payload,mac},V2_LIMITS.envelopeBytes));
}
function open(bytes:Buffer,keyId:string,key:Buffer){
 try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),raw=envelopeSchema.parse(parseOwnedJson(text,V2_LIMITS.envelopeBytes));check(canonicalOwnedJson(raw,V2_LIMITS.envelopeBytes)===text&&raw.keyId===keyId,'authentication_invalid');const {mac,...payload}=raw;const actual=createHmac('sha256',key).update(canonicalOwnedJson(payload,V2_LIMITS.envelopeBytes)).digest();check(timingSafeEqual(actual,Buffer.from(mac,'hex')),'authentication_invalid');return raw.body;}catch(e){if(e instanceof JournalV2Error)throw e;throw new JournalV2Error('schema_invalid');}
}
function transition(previous:Descriptor[],next:Descriptor[]):void{
 const retained=new Map(next.map(r=>[keyText(r.key),r]));
 for(const old of previous){const current=retained.get(keyText(old.key));
  // Retirement/control closure is deliberately not implemented in this static primitive.
  if(!current)check(old.key.role==='metadata-snapshot'||old.key.role==='event-ledger'&&old.key.id==='empty','removal_unsupported');
  else if(['terminal-record','action-reservation','tombstone-core','retire-receipt','control-object','maintenance-record'].includes(old.key.role))check(same(old.ref,current.ref),'immutable_record_changed');
 }
}
function applyDelta(previous:Descriptor[],changes:z.infer<typeof change>[]):Descriptor[]{
 const map=new Map(previous.map(r=>[keyText(r.key),r]));let last='';
 for(const c of changes){const k=keyText(c.key);check(k>last,'duplicate_or_unordered_change');last=k;const old=map.get(k);
  if(c.op==='add'){check(!old,'key_exists');map.set(k,{key:c.key,ref:c.ref});}
  else {check(old&&same(old.ref,c.expectedOldRef),'old_ref_mismatch');if(c.op==='remove')map.delete(k);else map.set(k,{key:c.key,ref:c.ref});}
 }
 return [...map.values()].sort((a,b)=>keyText(a.key)<keyText(b.key)?-1:1);
}
export interface V2ReplayInput{binding:V2Binding;baseRef:z.infer<typeof baseRefSchema>;keyId:string;key:Buffer;approvedBaseDigest:string;checkpoint:{revision:number;commitDigest:string};commits:Buffer[];payloads:Buffer[];auditAuthoritySnapshot?:boolean}
/** Entire history is authenticated on each call. All retained bytes are privately copied. */
export function replayV2(input:V2ReplayInput){
 try{return replay(input);}catch(e){if(e instanceof JournalV2Error)throw e;throw new JournalV2Error(e instanceof OwnedManifestError&&e.message.includes('budget_exceeded')?'budget_exceeded':'schema_invalid');}
}
function replay(input:V2ReplayInput){
 const binding=v2BindingSchema.parse(input.binding),baseRef=baseRefSchema.parse(input.baseRef),keyId=id.parse(input.keyId);check(Buffer.isBuffer(input.key)&&input.key.length===32,'configuration_invalid');const key=Buffer.from(input.key),baseDigest=hash.parse(input.approvedBaseDigest),checkpoint=z.object({revision:natural.positive().max(V2_LIMITS.commits),commitDigest:hash}).strict().parse(input.checkpoint);
 check(Array.isArray(input.commits)&&input.commits.length>0&&input.commits.length<=V2_LIMITS.commits&&Array.isArray(input.payloads)&&input.payloads.length<=V2_LIMITS.payloads,'budget_exceeded');
 let historyBytes=0;const commits=input.commits.map(b=>{check(Buffer.isBuffer(b)&&b.length<=V2_LIMITS.envelopeBytes,'budget_exceeded');historyBytes+=b.length;check(historyBytes<=V2_LIMITS.historyBytes,'budget_exceeded');return Buffer.from(b);});
 const blobs=new Map<string,Buffer>();let suppliedBytes=0;
 for(const b of input.payloads){check(Buffer.isBuffer(b),'payload_invalid');suppliedBytes+=b.length;check(b.length<=V2_LIMITS.logicalBytes&&suppliedBytes+historyBytes<=V2_LIMITS.storeBytes,'budget_exceeded');const bytes=Buffer.from(b),digest=ownedSha256(bytes);blobs.set(digest,bytes);}
 check(ownedSha256(commits[0]!)===baseDigest,'base_unapproved');let previousCommit=v2Genesis(binding,baseRef),stateRoot=previousCommit,state:Descriptor[]=[];const used=new Set<string>(),operations=new Set<string>(),states:ReturnType<typeof summarize>[]=[];
 for(const [index,bytes]of commits.entries()){
  const body=open(bytes,keyId,key);check(same(Object.fromEntries(Object.keys(binding).map(k=>[k,body[k as keyof V2Binding]])),binding)&&same(body.baseRef,baseRef),'binding_mismatch');
  check(body.revision===index+1&&body.previousCommit===previousCommit&&body.fromStateRoot===stateRoot,'chain_invalid');check(!operations.has(body.operation.id),'operation_replayed');operations.add(body.operation.id);
  check(index>0||body.recordMode==='full','base_full_required');const next=body.recordMode==='full'?body.records:applyDelta(state,body.changes);transition(state,next);const summary=summarize(next);check(same(next,summary.records),'key_order_invalid');
  for(const r of next){const b=blobs.get(r.ref.sha256);check(b&&b.length===r.ref.byteLength,'payload_missing');used.add(r.ref.sha256);}
  check(same(body.usage,summary.usage)&&same(Object.fromEntries(Object.keys(summary.roots).map(k=>[k,body[k as keyof typeof summary.roots]])),summary.roots),'state_root_mismatch');
  check(same(body.operation.resultRef,next.find(r=>r.key.role==='operation-result')!.ref),'result_mismatch');
  state=next;stateRoot=body.toStateRoot;previousCommit=ownedSha256(bytes);states.push(summary);
 }
 check(checkpoint.revision===commits.length&&checkpoint.commitDigest===previousCommit,'checkpoint_mismatch');check([...blobs.keys()].every(k=>used.has(k)),'orphan_payload');
 const materialized=state.map(r=>({key:{...r.key},bytes:Buffer.from(blobs.get(r.ref.sha256)!)}));
 const authorityAudit=input.auditAuthoritySnapshot?auditAuthority(materialized,binding.authorityId):undefined;
 return {format:'v2-flat-contract' as const,backendEligible:false as const,diagnosticEligible:false as const,controlClosureVerified:false as const,revision:commits.length,commitDigest:previousCommit,stateRoot,records:materialized,...(authorityAudit?{authorityAudit}:{}),states,retainedPayloads:[...used].sort(),physicalDeletionAuthorized:false as const,storageUsage:{historyBytes,retainedPayloadBytes:[...blobs.values()].reduce((n,b)=>n+b.length,0),totalBytes:historyBytes+[...blobs.values()].reduce((n,b)=>n+b.length,0),payloads:blobs.size}};
}

/** Audit-only bridge to the existing full decoder; no actor/capability restoration or admission. */
function auditAuthority(records:V2Record[],authorityId:string){
 const allowed=new Set<string>(journalRoles);check(records.every(r=>allowed.has(r.key.role)),'authority_audit_unsupported');
 const map=new Map(records.map(r=>[keyText(r.key),r]));const take=(role:string,id:string)=>{const r=map.get(keyText({role,id} as Descriptor['key']));check(r,'required_record_missing');return {role:role as typeof journalRoles[number],id,bytes:Buffer.from(r.bytes)};};
 const ix=take('session-index','root'),index=z.object({records:z.array(z.object({id,role:z.enum(journalRoles),size:natural,sha256:hash}).strict()).max(V2_LIMITS.records)}).passthrough().parse(parseOwnedJson(ix.bytes.toString('utf8'),V2_LIMITS.logicalBytes));
 const ordered=[...index.records.map(r=>take(r.role,r.id)),ix,take('operation-result','root')];check(ordered.length===records.length,'authority_audit_invalid');
 try{return decodeAuthoritySnapshot(ordered,authorityId);}catch{throw new JournalV2Error('authority_audit_invalid');}
}
