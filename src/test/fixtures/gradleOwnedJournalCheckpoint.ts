/** File-backed external checkpoint reference. Separate root/key is NOT proof of OS isolation. */
import {z} from 'zod';
import {ownedSha256,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {journalGenesis,journalHeadSchema,journalAssert,JOURNAL_LIMITS,sealJournalValue,openJournalValue,type JournalCheckpoint,type JournalIdentity,type JournalHead,type JournalIO} from './gradleOwnedAuthorityJournal.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(1024);
const checkpointSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-checkpoint-v1'),authorityId:id,storeEpoch:hash,head:journalHeadSchema,previousSealDigest:hash}).strict();
const name=(revision:number)=>'checkpoint-'+String(revision).padStart(8,'0')+'.json';
const same=(a:JournalHead,b:JournalHead)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
export interface CheckpointConfig {identity:JournalIdentity;keyId:string;key:Buffer;io:JournalIO}
export class FileJournalCheckpoint implements JournalCheckpoint {
 readonly #identity:JournalIdentity;readonly #key:Buffer;readonly #keyId:string;readonly #io:JournalIO;
 constructor(c:CheckpointConfig){this.#identity={...c.identity};this.#keyId=c.keyId;journalAssert(Buffer.isBuffer(c.key)&&c.key.length===32,'configuration_invalid');this.#key=Buffer.from(c.key);this.#io=c.io;}
 async initialize():Promise<void>{journalAssert((await this.#io.list(JOURNAL_LIMITS.entries)).length===0,'checkpoint_not_empty');const genesis=journalGenesis(this.#identity);const body={schema:'osv-mcp.gradle-owned-checkpoint-v1',authorityId:genesis.authorityId,storeEpoch:genesis.storeEpoch,head:genesis,previousSealDigest:genesis.headDigest};await this.#io.put(name(0),sealJournalValue(body,this.#keyId,this.#key));}
 async read():Promise<JournalHead>{
  const files=await this.#io.list(JOURNAL_LIMITS.entries);journalAssert(files.length<=JOURNAL_LIMITS.entries&&files.reduce((n,f)=>n+f.size,0)<=JOURNAL_LIMITS.storeBytes,'budget_exceeded');
  for(const f of files)journalAssert(/^checkpoint-[0-9]{8}\.json$/.test(f.name)||/^pending-[a-f0-9]{64}\.tmp$/.test(f.name),'checkpoint_invalid');
  const commits=files.filter(f=>f.name.startsWith('checkpoint-')).sort((a,b)=>a.name<b.name?-1:1);journalAssert(commits.length>0&&commits.length<=JOURNAL_LIMITS.commits+1,'checkpoint_invalid');
  const genesis=journalGenesis(this.#identity);let seal=genesis.headDigest,head=genesis;const verified:{name:string;bytes:Buffer}[]=[];
  for(const [i,f]of commits.entries()){journalAssert(f.name===name(i),'checkpoint_invalid');const bytes=await this.#io.read(f.name,JOURNAL_LIMITS.fileBytes);const body=openJournalValue(bytes,this.#keyId,this.#key,checkpointSchema);journalAssert(body.authorityId===genesis.authorityId&&body.storeEpoch===genesis.storeEpoch&&body.head.authorityId===genesis.authorityId&&body.head.storeEpoch===genesis.storeEpoch&&body.head.revision===i&&body.previousSealDigest===seal,'checkpoint_invalid');if(i===0)journalAssert(same(body.head,genesis),'checkpoint_invalid');seal=ownedSha256(bytes);head=body.head;verified.push({name:f.name,bytes});}
  // Visibility after a failed publish is not durability. Authenticate the entire
  // chain first, then re-sync the exact immutable bytes (including genesis).
  // JournalIO.put must fsync an existing equal file AND its parent directory;
  // any failure prevents this head from escaping to recovery or historical ack.
  for(const record of verified)await this.#io.put(record.name,record.bytes);
  return {...head};
 }
 async advance(expected:JournalHead,next:JournalHead):Promise<void>{
  const current=await this.read();journalAssert(same(current,expected)&&next.authorityId===current.authorityId&&next.storeEpoch===current.storeEpoch&&next.revision===current.revision+1,'checkpoint_conflict');
  const previous=await this.#io.read(name(current.revision),JOURNAL_LIMITS.fileBytes);const body={schema:'osv-mcp.gradle-owned-checkpoint-v1',authorityId:current.authorityId,storeEpoch:current.storeEpoch,head:next,previousSealDigest:ownedSha256(previous)};
  await this.#io.put(name(next.revision),sealJournalValue(body,this.#keyId,this.#key));journalAssert(same(await this.read(),next),'checkpoint_invalid');
 }
}
