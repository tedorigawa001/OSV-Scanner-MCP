/** Stage A2 persistence reference. TEST FIXTURE ONLY: not a peer-authenticated authority.
 * Journal integrity/durability does not authorize execution or restore live capabilities. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonicalOwnedJson,parseOwnedJson,ownedSha256,ownedDigest} from '../../utils/gradleOwnedJson.js';
const id=z.string().min(1).max(1024),hash=z.string().regex(/^[a-f0-9]{64}$/).refine(x=>x!=='0'.repeat(64));
export const JOURNAL_LIMITS=Object.freeze({chunkBytes:1024*1024,fileBytes:8*1024*1024,transactionBytes:64*1024*1024,storeBytes:256*1024*1024,entries:4096,commits:256,records:4096});
export const journalRoles=['session-manifest','metadata-snapshot','event-ledger','terminal-record','session-index','action-reservation','operation-result'] as const;
export type JournalRole=typeof journalRoles[number];
export interface JournalRecord {id:string;role:JournalRole;bytes:Buffer}
export interface JournalIdentity {authorityId:string;storeEpoch:string;keyId:string}
export interface JournalHead {authorityId:string;storeEpoch:string;revision:number;headDigest:string}
/** put resolves only after durable publication; equal existing bytes must be re-synced. */
export interface JournalIO {list(limit:number):Promise<{name:string;size:number}[]>;read(name:string,maxBytes:number):Promise<Buffer>;put(name:string,bytes:Buffer):Promise<void>}
export interface JournalCheckpoint {read():Promise<JournalHead>;advance(expected:JournalHead,next:JournalHead):Promise<void>}
export class AuthorityJournalError extends Error {constructor(reason:string){super('authority_journal_'+reason);}}
export function journalAssert(ok:unknown,reason:string):asserts ok {if(!ok)throw new AuthorityJournalError(reason);}
const binding={authorityId:id,storeEpoch:hash};
export const journalHeadSchema=z.object({...binding,revision:z.number().int().min(0).max(JOURNAL_LIMITS.commits),headDigest:hash}).strict();
const identitySchema=z.object({...binding,keyId:id}).strict();
const manifestSchema=identitySchema.extend({schema:z.literal('osv-mcp.gradle-owned-journal-v1'),genesisDigest:hash}).strict();
const chunk=z.object({sha256:hash,size:z.number().int().positive().max(JOURNAL_LIMITS.chunkBytes)}).strict();
const descriptor=z.object({id,role:z.enum(journalRoles),size:z.number().int().nonnegative().max(JOURNAL_LIMITS.transactionBytes),sha256:hash,chunks:z.array(chunk).max(64)}).strict();
const commitSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-journal-commit-v1'),...binding,revision:z.number().int().positive().max(JOURNAL_LIMITS.commits),previousHead:hash,operationId:id,requestDigest:hash,inputDigest:hash,resultDigest:hash,records:z.array(descriptor).min(4).max(JOURNAL_LIMITS.records)}).strict();
type Commit=z.infer<typeof commitSchema>;
const sealedSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-sealed-record-v1'),keyId:id,body:z.unknown(),mac:hash}).strict();
export function sealJournalValue(body:unknown,keyId:string,key:Buffer):Buffer {
 const payload={schema:'osv-mcp.gradle-owned-sealed-record-v1',keyId,body};const mac=createHmac('sha256',key).update(canonicalOwnedJson(payload)).digest('hex');return Buffer.from(canonicalOwnedJson({...payload,mac}));
}
export function openJournalValue<T>(bytes:Buffer,keyId:string,key:Buffer,schema:z.ZodType<T>):T {
 try {
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);const raw=sealedSchema.parse(parseOwnedJson(text));journalAssert(canonicalOwnedJson(raw)===text&&raw.keyId===keyId,'authentication_invalid');
  const {mac,...payload}=raw;const actual=createHmac('sha256',key).update(canonicalOwnedJson(payload)).digest();journalAssert(timingSafeEqual(actual,Buffer.from(mac,'hex')),'authentication_invalid');return schema.parse(raw.body);
 }catch(e){if(e instanceof AuthorityJournalError)throw e;throw new AuthorityJournalError('record_invalid');}
}
export function journalGenesis(identity:JournalIdentity):JournalHead {
 const p=identitySchema.parse(identity);return {authorityId:p.authorityId,storeEpoch:p.storeEpoch,revision:0,headDigest:ownedDigest({domain:'owned-authority-journal-genesis-v1',...p})};
}
const copyHead=(v:JournalHead)=>({...v});
const sameHead=(a:JournalHead,b:JournalHead)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
const commitName=(revision:number)=>'commit-'+String(revision).padStart(8,'0')+'.json';
const blobName=(digest:string)=>'blob-'+digest+'.bin';
function indexDigest(records:Commit['records']):string {return ownedDigest(records);}
function checkDescriptors(records:Commit['records']):void {
 const unique=new Set<string>();let bytes=0;
 for(const r of records){const k=JSON.stringify([r.role,r.id]);journalAssert(!unique.has(k),'index_invalid');unique.add(k);bytes+=r.size;journalAssert(r.chunks.reduce((n,c)=>n+c.size,0)===r.size&&r.chunks.every((c,i)=>i===r.chunks.length-1||c.size===JOURNAL_LIMITS.chunkBytes),'index_invalid');}
 journalAssert(bytes<=JOURNAL_LIMITS.transactionBytes,'budget_exceeded');
 for(const role of ['session-manifest','session-index','operation-result'])journalAssert(records.filter(r=>r.role===role).length===1,'index_invalid');
 journalAssert(records.some(r=>r.role==='event-ledger'),'index_invalid');
}
export type JournalFault='before-records'|'after-records'|'before-commit'|'after-commit'|'before-checkpoint'|'after-checkpoint'|'before-ack'|'before-recovery-checkpoint'|'after-recovery-checkpoint';
export interface JournalConfig extends JournalIdentity {key:Buffer;io:JournalIO;checkpoint:JournalCheckpoint;fault?:(phase:JournalFault)=>void|Promise<void>}
export interface JournalReceipt {operationId:string;revision:number;headDigest:string;resultDigest:string;backendEligible:false;replayed?:true}
export class AuthorityJournal {
 readonly #identity:JournalIdentity;readonly #key:Buffer;readonly #io:JournalIO;readonly #checkpoint:JournalCheckpoint;readonly #fault?:JournalConfig['fault'];
 #blocked=false;#busy=false;#head:JournalHead;#commits:{body:Commit;head:JournalHead}[]=[];#blobs=new Map<string,Buffer>();
 private constructor(c:JournalConfig){this.#identity=identitySchema.parse({authorityId:c.authorityId,storeEpoch:c.storeEpoch,keyId:c.keyId});journalAssert(Buffer.isBuffer(c.key)&&c.key.length===32,'configuration_invalid');this.#key=Buffer.from(c.key);this.#io=c.io;this.#checkpoint=c.checkpoint;this.#fault=c.fault;this.#head=journalGenesis(this.#identity);}
 static async create(c:JournalConfig):Promise<AuthorityJournal>{const j=new AuthorityJournal(c);journalAssert((await c.io.list(JOURNAL_LIMITS.entries)).length===0,'store_not_empty');const anchor=await j.#anchor();journalAssert(sameHead(anchor,j.#head),'checkpoint_invalid');const manifest={schema:'osv-mcp.gradle-owned-journal-v1',...j.#identity,genesisDigest:j.#head.headDigest};await c.io.put('journal.meta',sealJournalValue(manifest,j.#identity.keyId,j.#key));await j.#recover();return j;}
 static async open(c:JournalConfig):Promise<AuthorityJournal>{const j=new AuthorityJournal(c);await j.#recover();return j;}
 async #hit(phase:JournalFault):Promise<void>{await this.#fault?.(phase);}
 async #anchor():Promise<JournalHead>{let value:unknown;try{value=await this.#checkpoint.read();}catch{throw new AuthorityJournalError('checkpoint_unavailable');}let parsed:JournalHead;try{parsed=journalHeadSchema.parse(value);}catch{throw new AuthorityJournalError('checkpoint_invalid');}journalAssert(parsed.authorityId===this.#identity.authorityId&&parsed.storeEpoch===this.#identity.storeEpoch,'checkpoint_invalid');return parsed;}
 async #advance(expected:JournalHead,next:JournalHead):Promise<void>{try{await this.#checkpoint.advance(copyHead(expected),copyHead(next));}catch{throw new AuthorityJournalError('checkpoint_unavailable');}journalAssert(sameHead(await this.#anchor(),next),'checkpoint_invalid');}
 async #recover():Promise<void>{
  const files=await this.#io.list(JOURNAL_LIMITS.entries);journalAssert(files.length<=JOURNAL_LIMITS.entries&&files.reduce((n,e)=>n+e.size,0)<=JOURNAL_LIMITS.storeBytes,'budget_exceeded');
  const names=new Set<string>();for(const f of files){journalAssert(!names.has(f.name)&&Number.isSafeInteger(f.size)&&f.size>=0&&f.size<=JOURNAL_LIMITS.fileBytes,'store_invalid');names.add(f.name);journalAssert(f.name==='journal.meta'||/^commit-[0-9]{8}\.json$/.test(f.name)||/^blob-[a-f0-9]{64}\.bin$/.test(f.name)||/^pending-[a-f0-9]{64}\.tmp$/.test(f.name),'inventory_invalid');}
  journalAssert(names.has('journal.meta'),'manifest_missing');const manifest=openJournalValue(await this.#io.read('journal.meta',JOURNAL_LIMITS.fileBytes),this.#identity.keyId,this.#key,manifestSchema);const genesis=journalGenesis(this.#identity);journalAssert(canonicalOwnedJson(manifest)===canonicalOwnedJson({schema:'osv-mcp.gradle-owned-journal-v1',...this.#identity,genesisDigest:genesis.headDigest}),'identity_mismatch');
  const blobs=new Map<string,Buffer>();for(const f of files.filter(x=>x.name.startsWith('blob-'))){const digest=f.name.slice(5,-4);const bytes=await this.#io.read(f.name,JOURNAL_LIMITS.chunkBytes);journalAssert(ownedSha256(bytes)===digest,'content_mismatch');blobs.set(digest,bytes);}
  const commits:{body:Commit;head:JournalHead}[]=[];let head=genesis;const operations=new Set<string>();
  const logs=files.filter(f=>f.name.startsWith('commit-')).sort((a,b)=>a.name<b.name?-1:1);journalAssert(logs.length<=JOURNAL_LIMITS.commits,'budget_exceeded');
  for(const [i,f] of logs.entries()){
   journalAssert(f.name===commitName(i+1),'chain_invalid');const bytes=await this.#io.read(f.name,JOURNAL_LIMITS.fileBytes);const b=openJournalValue(bytes,this.#identity.keyId,this.#key,commitSchema);
   journalAssert(b.authorityId===head.authorityId&&b.storeEpoch===head.storeEpoch&&b.revision===i+1&&b.previousHead===head.headDigest&&!operations.has(b.operationId),'chain_invalid');checkDescriptors(b.records);journalAssert(indexDigest(b.records)===b.inputDigest,'index_invalid');
   for(const r of b.records){const parts=r.chunks.map(c=>{const p=blobs.get(c.sha256);journalAssert(p&&p.length===c.size,'required_record_missing');return p;});journalAssert(ownedSha256(Buffer.concat(parts))===r.sha256,'content_mismatch');}
   const result=b.records.find(r=>r.role==='operation-result')!;journalAssert(result.sha256===b.resultDigest,'index_invalid');
   head={authorityId:b.authorityId,storeEpoch:b.storeEpoch,revision:b.revision,headDigest:ownedSha256(bytes)};commits.push({body:b,head});operations.add(b.operationId);
  }
  const anchor=await this.#anchor();journalAssert(anchor.revision<=commits.length,'rollback_detected');const anchored=anchor.revision===0?genesis:commits[anchor.revision-1]!.head;journalAssert(sameHead(anchor,anchored),'rollback_detected');
  // A failed writer must stop; at most one authenticated local commit can await publication.
  journalAssert(commits.length-anchor.revision<=1,'checkpoint_gap');if(head.revision>anchor.revision){const pending=await this.#io.read(commitName(head.revision),JOURNAL_LIMITS.fileBytes);journalAssert(ownedSha256(pending)===head.headDigest,'content_mismatch');await this.#io.put(commitName(head.revision),pending);await this.#hit('before-recovery-checkpoint');await this.#advance(anchor,head);await this.#hit('after-recovery-checkpoint');}
  this.#head=head;this.#commits=commits;this.#blobs=blobs;
 }
 #receipt(c:{body:Commit;head:JournalHead}):JournalReceipt{return {operationId:c.body.operationId,revision:c.head.revision,headDigest:c.head.headDigest,resultDigest:c.body.resultDigest,backendEligible:false};}
 async #exclusive<T>(work:()=>Promise<T>):Promise<T>{journalAssert(!this.#blocked,'recovery_required');journalAssert(!this.#busy,'busy');this.#busy=true;try{return await work();}catch(e){this.#blocked=true;throw e;}finally{this.#busy=false;}}
 async commit(input:{operationId:string;requestDigest:string;records:JournalRecord[];expectedHead?:JournalHead}):Promise<JournalReceipt>{
  // Seal caller-owned values before the first asynchronous storage/checkpoint operation.
  const operationId=id.parse(input.operationId),requestDigest=hash.parse(input.requestDigest);
  const expectedHead=input.expectedHead?journalHeadSchema.parse(input.expectedHead):undefined;
  journalAssert(Array.isArray(input.records)&&input.records.length<=JOURNAL_LIMITS.records,'budget_exceeded');
  const records:Commit['records']=[],chunks=new Map<string,Buffer>();let rawTotal=0;
   for(const r of input.records){id.parse(r.id);z.enum(journalRoles).parse(r.role);journalAssert(Buffer.isBuffer(r.bytes)&&r.bytes.length<=JOURNAL_LIMITS.transactionBytes,'record_invalid');rawTotal+=r.bytes.length;journalAssert(rawTotal<=JOURNAL_LIMITS.transactionBytes,'budget_exceeded');const refs:{sha256:string;size:number}[]=[];for(let at=0;at<r.bytes.length;at+=JOURNAL_LIMITS.chunkBytes){const bytes=Buffer.from(r.bytes.subarray(at,at+JOURNAL_LIMITS.chunkBytes)),sha256=ownedSha256(bytes);refs.push({sha256,size:bytes.length});chunks.set(sha256,bytes);}records.push({id:r.id,role:r.role,size:r.bytes.length,sha256:ownedSha256(r.bytes),chunks:refs});}
  checkDescriptors(records);const inputDigest=indexDigest(records);
  return this.#exclusive(async()=>{
   await this.#recover();const prior=this.#commits.find(c=>c.body.operationId===operationId);
   if(prior){journalAssert(prior.body.requestDigest===requestDigest&&prior.body.inputDigest===inputDigest,'operation_conflict');return {...this.#receipt(prior),replayed:true};}
   if(expectedHead)journalAssert(sameHead(expectedHead,this.#head),'revision_conflict');journalAssert(this.#head.revision<JOURNAL_LIMITS.commits,'budget_exceeded');
   const body:Commit={schema:'osv-mcp.gradle-owned-journal-commit-v1',authorityId:this.#identity.authorityId,storeEpoch:this.#identity.storeEpoch,revision:this.#head.revision+1,previousHead:this.#head.headDigest,operationId,requestDigest,inputDigest,resultDigest:records.find(r=>r.role==='operation-result')!.sha256,records};
   const encoded=sealJournalValue(body,this.#identity.keyId,this.#key),next={authorityId:this.#identity.authorityId,storeEpoch:this.#identity.storeEpoch,revision:body.revision,headDigest:ownedSha256(encoded)};
   const current=await this.#io.list(JOURNAL_LIMITS.entries);const newChunks=[...chunks].filter(([d])=>!this.#blobs.has(d));journalAssert(current.length+newChunks.length+1<=JOURNAL_LIMITS.entries&&current.reduce((n,f)=>n+f.size,0)+newChunks.reduce((n,[,b])=>n+b.length,0)+encoded.length<=JOURNAL_LIMITS.storeBytes,'budget_exceeded');
   await this.#hit('before-records');for(const [digest,bytes]of newChunks)await this.#io.put(blobName(digest),bytes);await this.#hit('after-records');await this.#hit('before-commit');await this.#io.put(commitName(body.revision),encoded);await this.#hit('after-commit');await this.#hit('before-checkpoint');await this.#advance(this.#head,next);await this.#hit('after-checkpoint');
   this.#head=next;this.#commits.push({body,head:next});for(const [d,b]of chunks)this.#blobs.set(d,b);await this.#hit('before-ack');return this.#receipt({body,head:next});
  });
 }
 async lookupOperation(operationId:string):Promise<JournalReceipt|undefined>{return this.#exclusive(async()=>{await this.#recover();const c=this.#commits.find(c=>c.body.operationId===operationId);return c?this.#receipt(c):undefined;});}
 async readLatest():Promise<JournalRecord[]>{return this.#exclusive(async()=>{await this.#recover();return this.#commits.at(-1)?.body.records.map(r=>({id:r.id,role:r.role,bytes:Buffer.concat(r.chunks.map(c=>this.#blobs.get(c.sha256)!))}))??[];});}
 get head():JournalHead{return copyHead(this.#head);}
 get backendEligible():false{return false;}
}
/** Fault-injection fixtures, not persistence/authentication implementations. */
export class MemoryJournalIO implements JournalIO {
 readonly files=new Map<string,Buffer>();
 async list(limit:number){return [...this.files].slice(0,limit+1).map(([name,b])=>({name,size:b.length}));}
 async read(name:string,max:number){const bytes=this.files.get(name);journalAssert(bytes,'file_missing');journalAssert(bytes.length<=max,'budget_exceeded');return Buffer.from(bytes);}
 async put(name:string,bytes:Buffer){const old=this.files.get(name);if(old)journalAssert(old.equals(bytes),'immutable_conflict');else this.files.set(name,Buffer.from(bytes));}
}
export class MemoryCheckpoint implements JournalCheckpoint {
 value:JournalHead;constructor(value:JournalHead){this.value=copyHead(value);}
 async read(){return copyHead(this.value);}
 async advance(expected:JournalHead,next:JournalHead){journalAssert(sameHead(this.value,expected)&&next.revision===expected.revision+1,'checkpoint_conflict');this.value=copyHead(next);}
}
