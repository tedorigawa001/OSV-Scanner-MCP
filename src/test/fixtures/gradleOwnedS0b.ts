import {z} from 'zod';
import {FileJournalCheckpoint} from '../../utils/gradleOwnedStoreCheckpoint.js';
import {canonicalOwnedJson,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {cid,chash,cn,parsed} from '../../utils/gradleOwnedCurrentSchema.js';
/** S0b fixture fork of RootedJournalIO. Product source stays unchanged. */
/** Cooperative POSIX single-owner disk adapter. openat/linkat/unlinkat stay rooted at a held fd.
 * Not a peer-authenticated service or an isolation/power-loss certification. */
import {constants as C,openSync,closeSync,fstatSync,lstatSync,realpathSync,readSync,writeSync,fsyncSync,type Stats} from 'node:fs';
import path from 'node:path';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
import {randomBytes} from 'node:crypto';
import {AuthorityJournalError,journalAssert,JOURNAL_LIMITS,journalGenesis,journalHeadSchema,openJournalValue,sealJournalValue,type JournalIdentity,type JournalHead,type JournalIO} from '../../utils/gradleOwnedStoreJournal.js';
export type DiskFault='before-file-sync'|'before-batch'|'after-batch'|'before-final-inventory'|'after-authentication'|'before-create'|'after-create'|'after-write'|'after-file-sync'|'after-publish'|'before-directory-sync'|'after-directory-sync'|'before-recovery-unlink'|'after-recovery-unlink'|'before-recovery-directory-sync';
type Native={open:(root:number,name:string,flags:number)=>number;link:(root:number,from:string,to:string)=>number;unlink:(root:number,name:string)=>number;names:(root:number,limit:number)=>string[];lock:(root:number)=>void;unlock:(root:number)=>void};
let native:Promise<Native>|undefined;
async function load():Promise<Native>{
 journalAssert(process.platform==='linux'||process.platform==='darwin','storage_unsupported');
 const {default:koffi}=await import('koffi');const libc=koffi.load(process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':null);
 const openat=libc.func('int openat(int fd, const char *path, int flags, ...)');
 const linkat=libc.func('int linkat(int oldfd, const char *oldpath, int newfd, const char *newpath, int flags)');
 const unlinkat=libc.func('int unlinkat(int fd, const char *path, int flags)');
 journalAssert(process.arch==='arm64'||process.arch==='x64','storage_unsupported');
 const dup=libc.func('int dup(int fd)'),fdopendir=libc.func('void *fdopendir(int fd)'),closedir=libc.func('int closedir(void *dir)'),rewinddir=libc.func('void rewinddir(void *dir)');
 const readdir=libc.func(process.platform==='darwin'&&process.arch==='x64'?'readdir$INODE64':'readdir','void *',['void *']);
 const flock=libc.func('int flock(int fd, int operation)');
 const errno=libc.func(process.platform==='darwin'?'__error':'__errno_location','void *',[]);
 const header=process.platform==='darwin'?koffi.struct({d_ino:'uint64_t',d_seekoff:'uint64_t',d_reclen:'uint16_t',d_namlen:'uint16_t',d_type:'uint8_t'}):koffi.struct({d_ino:'uint64_t',d_off:'int64_t',d_reclen:'uint16_t',d_type:'uint8_t'});
 const nameOffset=process.platform==='darwin'?21:19,maxName=process.platform==='darwin'?1024:256;
 const names=(fd:number,limit:number):string[]=>{
  const copy=dup(fd);journalAssert(copy>=0,'directory_unavailable');const dir=fdopendir(copy);if(!dir){closeSync(copy);throw new AuthorityJournalError('directory_unavailable');}
  const out:string[]=[];rewinddir(dir);
  try{for(;;){const error=errno();koffi.encode(error,'int',0);const ptr=readdir(dir);if(!ptr){journalAssert(koffi.decode(error,'int')===0,'directory_unavailable');break;}
   const h=koffi.decode(ptr,header) as {d_reclen:number;d_namlen?:number};journalAssert(h.d_reclen>nameOffset&&h.d_reclen<=nameOffset+maxName+8,'directory_invalid');
   const raw=Buffer.from(koffi.decode(ptr,nameOffset,'uint8_t',h.d_reclen-nameOffset));const end=raw.indexOf(0);journalAssert(end>0&&end<maxName&&(h.d_namlen===undefined||end===h.d_namlen),'directory_invalid');
   const name=new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,end));if(name==='.'||name==='..')continue;out.push(name);if(out.length>limit)break;
  }}finally{journalAssert(closedir(dir)===0,'directory_unavailable');}return out;
 };

 return {open:(fd,name,flags)=>openat(fd,name,flags,'int',0o600),link:(fd,from,to)=>linkat(fd,from,fd,to,0),unlink:(fd,name)=>unlinkat(fd,name,0),names,lock:fd=>{if(flock(fd,2|4)!==0){const code=koffi.decode(errno(),'int');throw new AuthorityJournalError(code===(process.platform==='darwin'?35:11)?'writer_busy':'lock_unavailable');}},unlock:fd=>journalAssert(flock(fd,8)===0,'lock_unavailable')};
}
export interface DiskOptions {root:string;exclusive?:boolean;maxBytes?:number;maxEntries?:number;fault?:(point:DiskFault,name:string)=>void|Promise<void>}
const ROOT_OPEN=Symbol('s0b-root-open'),SCOPE=Symbol('s0b-scope'),AUTH=Symbol('s0b-auth');
export type S0bInventory=Readonly<{kind:'s0b-call-inventory'}>;type Meta={name:string;size:number;device:number;inode:number;mode:number;uid:number;gid:number;mtime:number;ctime:number};
const inventories=new WeakMap<S0bInventory,{owner:S0bRoot;scope:object;entries:Meta[];root:string;used:boolean}>();
type AuthHandle=Readonly<{kind:'s0b-authenticated-chain'}>;const authenticated=new WeakMap<AuthHandle,{owner:S0bRoot;inventory:S0bInventory;records:{name:string;bytes:Buffer}[]}>();
export class S0bRoot implements JournalIO {
 readonly #root:string;readonly #fd:number;readonly #dev:number;readonly #ino:number;readonly #native:Native;readonly #maxBytes:number;readonly #maxEntries:number;readonly #fault?:DiskOptions['fault'];#closed=false;#exclusive=false;#writing=false;#recovering=false;
 #pairs=new Map<string,{final:string;temp:string;digest?:string}>();
 #scope:object|null=null;#scopeLimits:{maxFiles:number;maxBytes:number}|null=null;#requestGate:(()=>void)|null=null;#inventory:S0bInventory|null=null;#authNotified=false;#fileFDs=new Set<number>();
 readonly metrics={listCalls:0,readCalls:0,readBytes:0,authReads:0,authBytes:0,resyncReads:0,resyncBytes:0,batches:0,boundaryChecks:0,activeFileFDs:0,peakFileFDs:0,entriesEnumerated:0,bytesWritten:0,filesSynced:0,directoriesSynced:0,recoveredPairs:0};
 private constructor(token:symbol,options:DiskOptions,n:Native){journalAssert(token===ROOT_OPEN,'context_mismatch');
  this.#root=path.resolve(options.root);journalAssert(realpathSync(this.#root)===this.#root,'root_invalid');
  const root=lstatSync(this.#root);journalAssert(root.isDirectory()&&(root.mode&0o077)===0,'root_invalid');
  this.#fd=openSync(this.#root,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);const opened=fstatSync(this.#fd);
  if(opened.dev!==root.dev||opened.ino!==root.ino){this.#close(this.#fd);throw new AuthorityJournalError('root_invalid');}
  this.#dev=opened.dev;this.#ino=opened.ino;this.#native=n;this.#maxBytes=options.maxBytes??JOURNAL_LIMITS.storeBytes;this.#maxEntries=options.maxEntries??JOURNAL_LIMITS.entries;this.#fault=options.fault;
  if(!Number.isSafeInteger(this.#maxBytes)||this.#maxBytes<=0||this.#maxBytes>JOURNAL_LIMITS.storeBytes||!Number.isSafeInteger(this.#maxEntries)||this.#maxEntries<=0||this.#maxEntries>JOURNAL_LIMITS.entries){this.#close(this.#fd);throw new AuthorityJournalError('configuration_invalid');}
 }
 static async open(options:DiskOptions):Promise<S0bRoot>{native??=load();const io=new S0bRoot(ROOT_OPEN,options,await native);try{if(options.exclusive){io.#native.lock(io.#fd);io.#exclusive=true;io.#guard();}return io;}catch(e){io.close();throw e;}}
 #guard():void {
  this.#requestGate?.();journalAssert(!this.#closed,'closed');try{const s=lstatSync(this.#root),fd=fstatSync(this.#fd);journalAssert(s.isDirectory()&&!s.isSymbolicLink()&&s.dev===this.#dev&&s.ino===this.#ino&&fd.dev===this.#dev&&fd.ino===this.#ino&&realpathSync(this.#root)===this.#root,'root_changed');}catch(e){if(e instanceof AuthorityJournalError)throw e;throw new AuthorityJournalError('root_changed');}
 }
 #name(name:string):void {journalAssert(/^(?:journal\.meta|commit-[0-9]{8}\.json|checkpoint-[0-9]{8}\.json|blob-[a-f0-9]{64}\.bin|pending-[a-f0-9]{64}\.tmp)$/.test(name),'path_invalid');}
 #open(name:string,flags:number):number {const fd=this.#native.open(this.#fd,name,flags);journalAssert(fd>=0,'file_unavailable');this.#fileFDs.add(fd);this.metrics.activeFileFDs=this.#fileFDs.size;this.metrics.peakFileFDs=Math.max(this.metrics.peakFileFDs,this.metrics.activeFileFDs);return fd;}
 #close(fd:number){this.#fileFDs.delete(fd);this.metrics.activeFileFDs=this.#fileFDs.size;closeSync(fd);}
 #file(fd:number):Stats{const s=fstatSync(fd);journalAssert(s.isFile()&&(s.nlink===1||(this.#recovering&&s.nlink===2&&this.#pairs.has(s.dev+':'+s.ino)))&&s.dev===this.#dev&&(s.mode&0o077)===0,'file_invalid');return s;}
 #syncDirectory():void {this.#guard();fsyncSync(this.#fd);this.metrics.directoriesSynced++;}
 async #hit(phase:DiskFault,name:string):Promise<void>{await this.#fault?.(phase,name);}
 async list(limit:number):Promise<{name:string;size:number}[]>{
  this.#guard();this.metrics.listCalls++;journalAssert(Number.isSafeInteger(limit)&&limit>=0,'budget_exceeded');const maximum=Math.min(limit,this.#maxEntries,this.#scopeLimits?.maxFiles??this.#maxEntries);
  const entries:{name:string;size:number}[]=[];
  for(const name of this.#native.names(this.#fd,maximum)){this.metrics.entriesEnumerated++;const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const s=this.#file(fd);journalAssert(s.size<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');entries.push({name,size:s.size});}finally{this.#close(fd);}}

  this.#guard();if(this.#scopeLimits)journalAssert(entries.length<=this.#scopeLimits.maxFiles&&entries.reduce((n,e)=>n+e.size,0)<=this.#scopeLimits.maxBytes,'budget_exceeded');return entries;
 }
 async read(name:string,maxBytes:number):Promise<Buffer>{
  this.#name(name);this.#guard();this.metrics.readCalls++;journalAssert(Number.isSafeInteger(maxBytes)&&maxBytes>=0&&maxBytes<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{const before=this.#file(fd);journalAssert(before.size<=maxBytes,'budget_exceeded');const parts:Buffer[]=[];let size=0;const buffer=Buffer.alloc(Math.min(1024*1024,maxBytes+1));for(;;){const n=readSync(fd,buffer,0,Math.min(buffer.length,maxBytes-size+1),null);if(!n)break;size+=n;journalAssert(size<=maxBytes,'budget_exceeded');parts.push(Buffer.from(buffer.subarray(0,n)));}const after=this.#file(fd);journalAssert(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'file_changed');const check=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const current=this.#file(check);journalAssert(current.dev===before.dev&&current.ino===before.ino,'file_changed');}finally{this.#close(check);}this.#guard();const bytes=Buffer.concat(parts);this.metrics.readBytes+=bytes.length;if(this.#scope&&/^checkpoint-/.test(name)){if(this.#writing){this.metrics.resyncReads++;this.metrics.resyncBytes+=bytes.length;}else{this.metrics.authReads++;this.metrics.authBytes+=bytes.length;}}const pair=this.#pairs.get(before.dev+':'+before.ino);if(pair?.final===name)pair.digest=ownedSha256(bytes);return bytes;}finally{this.#close(fd);}
 }
 async put(name:string,bytes:Buffer):Promise<void>{
  this.#guard();if(this.#scope&&!this.#authNotified){this.#authNotified=true;await this.#hit('after-authentication','complete');this.#guard();}if(this.#scope){const inv=this.#getInventory(this.#inventory!);const expected=inv.entries.find(e=>e.name===name);journalAssert(expected,'inventory_invalid');const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{journalAssert(this.#sameMeta(expected,this.#meta(name,this.#file(fd))),'file_changed');}finally{this.#close(fd);}}journalAssert(!this.#writing,'busy');this.#writing=true;let locked=false;
  try{if(!this.#exclusive){this.#native.lock(this.#fd);locked=true;}await this.#put(name,bytes);}
  finally{try{if(locked)this.#native.unlock(this.#fd);}finally{this.#writing=false;}}
 }
 async #put(name:string,bytes:Buffer):Promise<void>{
  this.#name(name);journalAssert(!name.startsWith('pending-')&&Buffer.isBuffer(bytes)&&bytes.length<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');this.#guard();
  const files=await this.list(this.#maxEntries);journalAssert(files.length<=this.#maxEntries,'budget_exceeded');const old=files.find(e=>e.name===name);
  if(!old&&this.#scope)throw new AuthorityJournalError('file_unavailable');
  if(old){journalAssert((await this.read(name,JOURNAL_LIMITS.fileBytes)).equals(bytes),'immutable_conflict');const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{this.#file(fd);await this.#hit('before-file-sync',name);this.#guard();fsyncSync(fd);this.metrics.filesSynced++;await this.#hit('after-file-sync',name);this.#guard();}finally{this.#close(fd);}await this.#hit('before-directory-sync',name);this.#syncDirectory();await this.#hit('after-directory-sync',name);this.#guard();return;}
  journalAssert(files.length+2<=this.#maxEntries&&files.reduce((n,f)=>n+f.size,0)+bytes.length<=this.#maxBytes,'budget_exceeded');
  await this.#hit('before-create',name);this.#guard();const temp='pending-'+randomBytes(32).toString('hex')+'.tmp';const fd=this.#open(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW|C.O_NONBLOCK);let open=true;
  try{await this.#hit('after-create',name);this.#guard();this.#file(fd);let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,Math.min(1024*1024,bytes.length-at),null);journalAssert(n>0,'short_write');at+=n;this.metrics.bytesWritten+=n;}await this.#hit('after-write',name);fsyncSync(fd);this.metrics.filesSynced++;await this.#hit('after-file-sync',name);this.#guard();this.#file(fd);
   // linkat publishes a fully written inode without replacing an existing name.
   if(this.#native.link(this.#fd,temp,name)!==0){this.#close(fd);open=false;await this.read(name,JOURNAL_LIMITS.fileBytes).then(old=>journalAssert(old.equals(bytes),'immutable_conflict'));}
   else await this.#hit('after-publish',name);
   journalAssert(this.#native.unlink(this.#fd,temp)===0,'unlink_failed');await this.#hit('before-directory-sync',name);this.#syncDirectory();await this.#hit('after-directory-sync',name);this.#guard();
  }finally{if(open)this.#close(fd);}
 }
 /** Only the disk owner may use this, with full journal/checkpoint authentication in verify. */
 async recoverPublished<T>(verify:()=>Promise<T>):Promise<T>{
  this.#guard();journalAssert(this.#exclusive&&!this.busy,'recovery_lock_required');this.#recovering=true;
  try{
   const names=this.#native.names(this.#fd,this.#maxEntries);journalAssert(names.length<=this.#maxEntries,'budget_exceeded');
   const groups=new Map<string,{name:string;stat:Stats}[]>();let size=0;
   for(const name of names){
    this.#name(name);const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
    try{const stat=fstatSync(fd);journalAssert(stat.isFile()&&(stat.nlink===1||stat.nlink===2)&&stat.dev===this.#dev&&(stat.mode&0o077)===0,'recovery_inventory_invalid');size+=stat.size;journalAssert(stat.size<=JOURNAL_LIMITS.fileBytes&&size<=this.#maxBytes,'budget_exceeded');const key=stat.dev+':'+stat.ino;groups.set(key,[...(groups.get(key)??[]),{name,stat}]);}finally{this.#close(fd);}
   }
   for(const [key,group]of groups){
    if(group[0]!.stat.nlink===1){journalAssert(group.length===1,'recovery_inventory_invalid');continue;}
    const temp=group.filter(e=>e.name.startsWith('pending-')),final=group.filter(e=>!e.name.startsWith('pending-'));
    journalAssert(group.length===2&&temp.length===1&&final.length===1&&group.every(e=>e.stat.nlink===2),'recovery_inventory_invalid');
    this.#pairs.set(key,{temp:temp[0]!.name,final:final[0]!.name});
   }
   this.#guard();const result=await verify();this.#guard();
   for(const [key,pair]of this.#pairs){
    journalAssert(pair.digest,'recovery_unauthenticated');const expected=pair.digest;
    journalAssert(ownedSha256(await this.read(pair.final,JOURNAL_LIMITS.fileBytes))===expected,'content_mismatch');
    await this.#hit('before-recovery-unlink',pair.final);this.#guard();
    const final=this.#open(pair.final,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);let temp=-1;
    try{
     temp=this.#open(pair.temp,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
     const a=this.#file(final),b=this.#file(temp);journalAssert(a.dev+':'+a.ino===key&&b.dev+':'+b.ino===key&&a.nlink===2&&b.nlink===2,'recovery_inventory_invalid');
     journalAssert(a.size<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');const bytes=Buffer.alloc(a.size+1);let size=0;
     for(;;){const count=readSync(final,bytes,size,bytes.length-size,null);if(!count)break;size+=count;journalAssert(size<=a.size,'file_changed');}
     const after=this.#file(final);journalAssert(size===a.size&&ownedSha256(bytes.subarray(0,size))===expected&&after.size===a.size&&after.mtimeMs===a.mtimeMs&&after.ctimeMs===a.ctimeMs,'content_mismatch');
     fsyncSync(final);this.metrics.filesSynced++;journalAssert(this.#native.unlink(this.#fd,pair.temp)===0,'unlink_failed');
    }finally{this.#close(final);if(temp>=0)this.#close(temp);}
    await this.#hit('after-recovery-unlink',pair.final);this.metrics.recoveredPairs++;
   }
   await this.#hit('before-recovery-directory-sync','directory');this.#syncDirectory();this.#guard();return result;
  }finally{this.#pairs.clear();this.#recovering=false;}
 }

 bootstrapGate(token:symbol,gate:()=>void){journalAssert(token===SCOPE&&!this.#scope&&!this.busy,'context_mismatch');this.#requestGate=gate;this.#guard();}
 scope(token:symbol,scope:object,gate:()=>void,limits?:{maxFiles:number;maxBytes:number}){journalAssert(token===SCOPE&&!this.#scope&&!this.busy,'context_mismatch');journalAssert(limits&&Number.isSafeInteger(limits.maxFiles)&&limits.maxFiles>0&&limits.maxFiles<=257&&Number.isSafeInteger(limits.maxBytes)&&limits.maxBytes>0&&limits.maxBytes<=8*1024*1024,'budget_exceeded');this.#scopeLimits={maxFiles:limits.maxFiles,maxBytes:limits.maxBytes};this.#scope=scope;this.#authNotified=false;this.#requestGate=gate;}
 endScope(token:symbol){journalAssert(token===SCOPE,'context_mismatch');this.#inventory=null;this.#scope=null;this.#scopeLimits=null;this.#requestGate=null;}
 #meta(name:string,s:Stats):Meta{journalAssert([s.dev,s.ino,s.size,s.uid,s.gid].every(Number.isSafeInteger),'file_invalid');return {name,size:s.size,device:s.dev,inode:s.ino,mode:s.mode,uid:s.uid,gid:s.gid,mtime:s.mtimeMs,ctime:s.ctimeMs};}
 #rootMeta(){this.#guard();const s=fstatSync(this.#fd);return JSON.stringify([s.dev,s.ino,s.mode,s.uid,s.gid,s.mtimeMs,s.ctimeMs]);}
 #sameMeta(a:Meta,b:Meta){return JSON.stringify(a)===JSON.stringify(b);}
 async #snapshot(maxFiles:number,maxBytes:number){const root=this.#rootMeta(),files=await this.list(maxFiles);this.#guard();journalAssert(files.length>0&&files.length<=maxFiles&&files.reduce((n,e)=>n+e.size,0)<=maxBytes,'budget_exceeded');const entries:Meta[]=[];
  for(const f of files){journalAssert(/^checkpoint-[0-9]{8}\.json$/.test(f.name),'checkpoint_invalid');const fd=this.#open(f.name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const m=this.#meta(f.name,this.#file(fd));journalAssert(m.size===f.size,'file_changed');entries.push(m);}finally{this.#close(fd);}}
  entries.sort((a,b)=>a.name.localeCompare(b.name));journalAssert(new Set(entries.map(e=>e.name)).size===entries.length&&this.#rootMeta()===root,'inventory_changed');return {root,entries};
 }
 #getInventory(handle:S0bInventory){const i=inventories.get(handle);journalAssert(i&&i.owner===this&&i.scope===this.#scope,'context_mismatch');return i;}
 async beginInventory(token:symbol,maxFiles:number,maxBytes:number){journalAssert(token===SCOPE&&this.#scope&&this.ownsWriterLock&&!this.busy,'context_mismatch');const s=await this.#snapshot(maxFiles,maxBytes),h=Object.freeze({kind:'s0b-call-inventory' as const});inventories.set(h,{owner:this,scope:this.#scope!,...s,used:false});this.#inventory=h;return h;}
 inventoryEntries(handle:S0bInventory){return structuredClone(this.#getInventory(handle).entries);}
 async checkInventory(handle:S0bInventory,maxFiles:number,maxBytes:number){this.#guard();const i=this.#getInventory(handle),now=await this.#snapshot(maxFiles,maxBytes);journalAssert(now.root===i.root&&JSON.stringify(now.entries)===JSON.stringify(i.entries),'inventory_changed');this.metrics.boundaryChecks++;}
 authenticate(token:symbol,inventory:S0bInventory,records:{name:string;bytes:Buffer}[]){journalAssert(token===AUTH,'authentication_incomplete');const inv=this.#getInventory(inventory);journalAssert(records.length===inv.entries.length&&records.every((r,i)=>r.name===inv.entries[i]!.name&&r.bytes.length===inv.entries[i]!.size),'inventory_invalid');const h=Object.freeze({kind:'s0b-authenticated-chain' as const});authenticated.set(h,{owner:this,inventory,records:records.map(r=>({name:r.name,bytes:Buffer.from(r.bytes)}))});return h;}
 async resyncExistingBatch(inventory:S0bInventory,proof:AuthHandle,limits:{batchSize:number;maxFiles:number;maxBytes:number}){
  this.#guard();const inv=this.#getInventory(inventory),auth=authenticated.get(proof);journalAssert(auth&&auth.owner===this&&auth.inventory===inventory&&!inv.used,'authentication_incomplete');journalAssert(Number.isSafeInteger(limits.batchSize)&&limits.batchSize>0&&limits.batchSize<=64,'budget_exceeded');journalAssert(!this.busy,'busy');inv.used=true;this.#writing=true;
  try{for(let start=0;start<auth.records.length;start+=limits.batchSize){await this.#hit('before-batch',String(start));this.#guard();await this.checkInventory(inventory,limits.maxFiles,limits.maxBytes);this.metrics.batches++;
   for(const record of auth.records.slice(start,start+limits.batchSize)){this.#guard();const expected=inv.entries.find(e=>e.name===record.name)!,fd=this.#open(record.name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
    try{const before=this.#meta(record.name,this.#file(fd));journalAssert(this.#sameMeta(before,expected),'file_changed');this.metrics.readCalls++;this.metrics.resyncReads++;const pieces:Buffer[]=[];let size=0;const buffer=Buffer.alloc(1024*1024);
     for(;;){const n=readSync(fd,buffer,0,Math.min(buffer.length,JOURNAL_LIMITS.fileBytes-size+1),null);if(!n)break;size+=n;journalAssert(size<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');pieces.push(Buffer.from(buffer.subarray(0,n)));}
     const current=Buffer.concat(pieces);this.metrics.readBytes+=current.length;this.metrics.resyncBytes+=current.length;journalAssert(this.#sameMeta(before,this.#meta(record.name,this.#file(fd)))&&current.equals(record.bytes),'immutable_conflict');this.#nameBinding(record.name,fd);
     await this.#hit('before-file-sync',record.name);this.#guard();journalAssert(this.#sameMeta(expected,this.#meta(record.name,this.#file(fd))),'file_changed');this.#nameBinding(record.name,fd);fsyncSync(fd);this.metrics.filesSynced++;
     await this.#hit('after-file-sync',record.name);this.#guard();journalAssert(this.#sameMeta(expected,this.#meta(record.name,this.#file(fd))),'file_changed');this.#nameBinding(record.name,fd);
    }finally{this.#close(fd);}
    await this.#hit('before-directory-sync',record.name);this.#guard();this.#syncDirectory();await this.#hit('after-directory-sync',record.name);this.#guard();
   }
   await this.#hit('after-batch',String(start));this.#guard();await this.checkInventory(inventory,limits.maxFiles,limits.maxBytes);
  }
  await this.#hit('before-final-inventory','complete');this.#guard();await this.checkInventory(inventory,limits.maxFiles,limits.maxBytes);
  }finally{this.#writing=false;}
 }
 #nameBinding(name:string,fd:number){const expected=this.#file(fd),other=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const actual=this.#file(other);journalAssert(actual.dev===expected.dev&&actual.ino===expected.ino,'file_changed');}finally{this.#close(other);}this.#guard();}
 async faultPoint(point:DiskFault,name:string){await this.#hit(point,name);this.#guard();}
 assertOpen():void{this.#guard();}

 /** Diagnostic provider binding, not an isolation certificate or a transferable FD. */
 rootIdentity():Readonly<{device:string;inode:string}>{this.#guard();return Object.freeze({device:String(this.#dev),inode:String(this.#ino)});}
 get ownsWriterLock():boolean{this.#guard();return this.#exclusive;}
 get busy():boolean{return this.#writing||this.#recovering;}
 close():void {journalAssert(!this.busy,'busy');if(!this.#closed){this.#closed=true;this.#close(this.#fd);}}
}

export const S0B_PROFILE=Object.freeze({schema:'cgp.s0b.profile.v1',modeCatalog:Object.freeze(['F','D'] as const),batchSize:64,maxFiles:257,maxBytes:8*1024*1024,leaseMs:5000,marginMs:500,byteSkipping:false,authenticationSkipping:false,syncSkipping:false});
export const s0bProfileSchema=z.object({schema:z.literal('cgp.s0b.profile.v1'),modeCatalog:z.tuple([z.literal('F'),z.literal('D')]),batchSize:cn.positive().max(64),maxFiles:cn.positive().max(257),maxBytes:cn.positive().max(8*1024*1024),leaseMs:z.literal(5000),marginMs:z.literal(500),byteSkipping:z.literal(false),authenticationSkipping:z.literal(false),syncSkipping:z.literal(false)}).strict();
const checkpointSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-checkpoint-v1'),authorityId:z.string().min(1).max(1024),storeEpoch:chash,head:journalHeadSchema,previousSealDigest:chash}).strict();
const checkpointName=(n:number)=>'checkpoint-'+String(n).padStart(8,'0')+'.json';
class BatchCheckpoint {
 constructor(readonly io:S0bRoot,readonly identity:JournalIdentity,readonly keyId:string,readonly key:Buffer){}
 async read(inventory:S0bInventory,limits:z.infer<typeof s0bProfileSchema>){const files=this.io.inventoryEntries(inventory);journalAssert(files.length<=JOURNAL_LIMITS.commits+1,'checkpoint_invalid');const genesis=journalGenesis(this.identity);let seal=genesis.headDigest,head=genesis;const records:{name:string;bytes:Buffer}[]=[];
  for(const [i,f]of files.entries()){journalAssert(f.name===checkpointName(i),'checkpoint_invalid');const bytes=await this.io.read(f.name,JOURNAL_LIMITS.fileBytes),body=openJournalValue(bytes,this.keyId,this.key,checkpointSchema);journalAssert(body.authorityId===genesis.authorityId&&body.storeEpoch===genesis.storeEpoch&&body.head.authorityId===genesis.authorityId&&body.head.storeEpoch===genesis.storeEpoch&&body.head.revision===i&&body.previousSealDigest===seal,'checkpoint_invalid');if(i===0)journalAssert(canonicalOwnedJson(body.head)===canonicalOwnedJson(genesis),'checkpoint_invalid');seal=ownedSha256(bytes);head=body.head;records.push({name:f.name,bytes});}
  await this.io.faultPoint('after-authentication','complete');const proof=this.io.authenticate(AUTH,inventory,records);await this.io.resyncExistingBatch(inventory,proof,limits);return {...head};
 }
}
const FIXTURE_OPEN=Symbol('s0b-fixture-open');
export type S0bCall=Readonly<{kind:'s0b-own-call'}>;
type S0bOperation={digest:string;mode:'F'|'D';deadline:number;remaining:number};
const ownCalls=new WeakMap<S0bCall,{owner:S0bFixture;operation:S0bOperation}>();
const callSchema=z.object({operationId:cid,requestDigest:chash,mode:z.enum(['F','D']),deadline:cn.positive(),clockDomain:cid}).strict();
type Config={root:string;identity:JournalIdentity;keyId:string;key:Buffer;mode:'create'|'open';fileCount:number;profile:unknown;profilePin:string;fault?:DiskOptions['fault'];environment:{now:()=>number;clockDomain:string;assertCurrent:()=>void}};
export class S0bFixture {
 readonly #io:S0bRoot;readonly #full:FileJournalCheckpoint;readonly #batch:BatchCheckpoint;readonly #profile:z.infer<typeof s0bProfileSchema>;readonly #env:Config['environment'];readonly #operations=new Map<string,S0bOperation>();#closed=false;#blocked=false;#busy=false;#lastNow=0;#lastHead:JournalHead;#returned=0;
 private constructor(token:symbol,io:S0bRoot,full:FileJournalCheckpoint,batch:BatchCheckpoint,profile:z.infer<typeof s0bProfileSchema>,env:Config['environment'],head:JournalHead){journalAssert(token===FIXTURE_OPEN,'context_mismatch');this.#io=io;this.#full=full;this.#batch=batch;this.#profile=profile;this.#env=env;this.#lastHead=head;}
 static async open(input:Config){journalAssert(Object.keys(input).every(k=>['root','identity','keyId','key','mode','fileCount','profile','profilePin','fault','environment'].includes(k)),'schema_invalid');const identity=parsed(z.object({authorityId:cid,storeEpoch:chash,keyId:cid}).strict(),input.identity),profile=parsed(s0bProfileSchema,input.profile),keyId=parsed(cid,input.keyId),key=Buffer.from(input.key),env={...input.environment};journalAssert(key.length===32&&ownedDigest(profile)===parsed(chash,input.profilePin),'profile_invalid');journalAssert(Object.keys(env).sort().join(',')==='assertCurrent,clockDomain,now'&&typeof env.now==='function'&&typeof env.assertCurrent==='function','schema_invalid');parsed(cid,env.clockDomain);journalAssert(['create','open'].includes(input.mode)&&Number.isSafeInteger(input.fileCount)&&input.fileCount>0&&input.fileCount<=profile.maxFiles,'schema_invalid');env.assertCurrent();const mode=input.mode,count=input.fileCount,io=await S0bRoot.open({root:input.root,exclusive:true,fault:input.fault});
  try{io.bootstrapGate(SCOPE,()=>env.assertCurrent());const full=new FileJournalCheckpoint({identity,keyId,key,io});if(mode==='create'){
   const genesis=journalGenesis(identity),records:{name:string;bytes:Buffer}[]=[],first=sealJournalValue({schema:'osv-mcp.gradle-owned-checkpoint-v1',authorityId:identity.authorityId,storeEpoch:identity.storeEpoch,head:genesis,previousSealDigest:genesis.headDigest},keyId,key);records.push({name:checkpointName(0),bytes:first});let previous=first;
   for(let i=1;i<count;i++){const body={schema:'osv-mcp.gradle-owned-checkpoint-v1',authorityId:identity.authorityId,storeEpoch:identity.storeEpoch,head:{authorityId:identity.authorityId,storeEpoch:identity.storeEpoch,revision:i,headDigest:ownedDigest({fixture:'s0b',revision:i})},previousSealDigest:ownedSha256(previous)},bytes=sealJournalValue(body,keyId,key);records.push({name:checkpointName(i),bytes});previous=bytes;}
   journalAssert(records.reduce((n,r)=>n+r.bytes.length,0)<=profile.maxBytes,'budget_exceeded');journalAssert((await io.list(profile.maxFiles)).length===0,'checkpoint_not_empty');for(const record of records){env.assertCurrent();await io.put(record.name,record.bytes);}
  }
   // Existing-only profile: pending/published-tail repair belongs to a separate recovery path.
   // Quotas and complete namespace are checked before full authentication/re-sync on every open.
   io.scope(SCOPE,{},()=>env.assertCurrent(),profile);let head:JournalHead;
   try{const inv=await io.beginInventory(SCOPE,profile.maxFiles,profile.maxBytes);head=await full.read();await io.checkInventory(inv,profile.maxFiles,profile.maxBytes);env.assertCurrent();}finally{io.endScope(SCOPE);}
   return new S0bFixture(FIXTURE_OPEN,io,full,new BatchCheckpoint(io,identity,keyId,key),profile,env,head!);
  }catch(e){io.close();throw e;}
 }
 #now(){const n=this.#env.now();journalAssert(Number.isSafeInteger(n)&&n>=this.#lastNow,'clock_invalid');this.#lastNow=n;return n;}
 #gate(call?:S0bCall){journalAssert(!this.#closed,'owner_closed');journalAssert(!this.#blocked,'recovery_required');this.#env.assertCurrent();if(call){const c=ownCalls.get(call);journalAssert(c&&c.owner===this,'context_mismatch');journalAssert(this.#now()<c.operation.deadline,'request_expired');}}
 call(input:unknown){this.#gate();const q=parsed(callSchema,input);journalAssert(q.clockDomain===this.#env.clockDomain,'context_mismatch');const now=this.#now();let op=this.#operations.get(q.operationId);if(op)journalAssert(op.digest===q.requestDigest&&op.mode===q.mode,'idempotency_conflict');else{journalAssert(this.#operations.size<256,'capacity_exhausted');op={digest:q.requestDigest,mode:q.mode,deadline:Math.min(q.deadline,now+4500),remaining:2};this.#operations.set(q.operationId,op);}const c=Object.freeze({kind:'s0b-own-call' as const});ownCalls.set(c,{owner:this,operation:op});return c;}
 async read(mode:'F'|'D',call:S0bCall){const c=ownCalls.get(call);journalAssert((mode==='F'||mode==='D')&&c&&c.owner===this&&c.operation.mode===mode,'context_mismatch');this.#gate(call);journalAssert(!this.#busy,'busy');journalAssert(c.operation.remaining>0,'operation_budget');c.operation.remaining--;this.#busy=true;const before={...this.#io.metrics},start=performance.now();let completed=false,requestRefused=false;
  const requestGate=()=>{try{this.#gate(call);}catch(e){if(completed)requestRefused=true;throw e;}};
  this.#io.scope(SCOPE,call,requestGate,this.#profile);
  try{const inv=await this.#io.beginInventory(SCOPE,this.#profile.maxFiles,this.#profile.maxBytes);journalAssert(this.#io.inventoryEntries(inv).length>=this.#lastHead.revision+1,'rollback_detected');const head=mode==='F'?await this.#full.read():await this.#batch.read(inv,this.#profile);completed=true;requestGate();await this.#io.checkInventory(inv,this.#profile.maxFiles,this.#profile.maxBytes);requestGate();journalAssert(head.revision>=this.#lastHead.revision&&(head.revision!==this.#lastHead.revision||canonicalOwnedJson(head)===canonicalOwnedJson(this.#lastHead)),'rollback_detected');this.#lastHead=head;this.#returned++;const after=this.#io.metrics;return {head,metrics:{mode,wallMs:performance.now()-start,...(Object.fromEntries(Object.entries(after).map(([k,v])=>[k,k==='peakFileFDs'||k==='activeFileFDs'?v:v-before[k as keyof typeof before]])) as Record<keyof typeof before,number>)}};
  }catch(e){if(!requestRefused)this.#blocked=true;throw e;}finally{this.#io.endScope(SCOPE);this.#busy=false;}
 }
 get diagnostics(){return {blocked:this.#blocked,returned:this.#returned,metrics:{...this.#io.metrics},backendEligible:false,nativeIsolationVerified:false,originalReadsSkipped:0};}
 close(){journalAssert(!this.#busy,'busy');if(!this.#closed){this.#io.close();this.#closed=true;}}
}
