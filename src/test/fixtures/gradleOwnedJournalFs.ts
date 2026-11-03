/** POSIX disk adapter for A2 tests only. openat/linkat/unlinkat stay rooted at a held fd.
 * Not a peer-authenticated service or an isolation/power-loss certification. */
import {constants as C,openSync,closeSync,fstatSync,lstatSync,realpathSync,readSync,writeSync,fsyncSync,type Stats} from 'node:fs';
import path from 'node:path';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
import {randomBytes} from 'node:crypto';
import {AuthorityJournalError,journalAssert,JOURNAL_LIMITS,type JournalIO} from './gradleOwnedAuthorityJournal.js';
export type DiskFault='before-create'|'after-create'|'after-write'|'after-file-sync'|'after-publish'|'before-directory-sync'|'after-directory-sync'|'before-recovery-unlink'|'after-recovery-unlink'|'before-recovery-directory-sync';
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
export class RootedJournalIO implements JournalIO {
 readonly #root:string;readonly #fd:number;readonly #dev:number;readonly #ino:number;readonly #native:Native;readonly #maxBytes:number;readonly #maxEntries:number;readonly #fault?:DiskOptions['fault'];#closed=false;#exclusive=false;#writing=false;#recovering=false;
 #pairs=new Map<string,{final:string;temp:string;digest?:string}>();
 readonly metrics={entriesEnumerated:0,bytesWritten:0,filesSynced:0,directoriesSynced:0,recoveredPairs:0};
 private constructor(options:DiskOptions,n:Native){
  this.#root=path.resolve(options.root);journalAssert(realpathSync(this.#root)===this.#root,'root_invalid');
  const root=lstatSync(this.#root);journalAssert(root.isDirectory()&&(root.mode&0o077)===0,'root_invalid');
  this.#fd=openSync(this.#root,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);const opened=fstatSync(this.#fd);
  if(opened.dev!==root.dev||opened.ino!==root.ino){closeSync(this.#fd);throw new AuthorityJournalError('root_invalid');}
  this.#dev=opened.dev;this.#ino=opened.ino;this.#native=n;this.#maxBytes=options.maxBytes??JOURNAL_LIMITS.storeBytes;this.#maxEntries=options.maxEntries??JOURNAL_LIMITS.entries;this.#fault=options.fault;
  if(!Number.isSafeInteger(this.#maxBytes)||this.#maxBytes<=0||this.#maxBytes>JOURNAL_LIMITS.storeBytes||!Number.isSafeInteger(this.#maxEntries)||this.#maxEntries<=0||this.#maxEntries>JOURNAL_LIMITS.entries){closeSync(this.#fd);throw new AuthorityJournalError('configuration_invalid');}
 }
 static async open(options:DiskOptions):Promise<RootedJournalIO>{native??=load();const io=new RootedJournalIO(options,await native);try{if(options.exclusive){io.#native.lock(io.#fd);io.#exclusive=true;io.#guard();}return io;}catch(e){io.close();throw e;}}
 #guard():void {
  journalAssert(!this.#closed,'closed');try{const s=lstatSync(this.#root),fd=fstatSync(this.#fd);journalAssert(s.isDirectory()&&!s.isSymbolicLink()&&s.dev===this.#dev&&s.ino===this.#ino&&fd.dev===this.#dev&&fd.ino===this.#ino&&realpathSync(this.#root)===this.#root,'root_changed');}catch(e){if(e instanceof AuthorityJournalError)throw e;throw new AuthorityJournalError('root_changed');}
 }
 #name(name:string):void {journalAssert(/^(?:journal\.meta|commit-[0-9]{8}\.json|checkpoint-[0-9]{8}\.json|blob-[a-f0-9]{64}\.bin|pending-[a-f0-9]{64}\.tmp)$/.test(name),'path_invalid');}
 #open(name:string,flags:number):number {const fd=this.#native.open(this.#fd,name,flags);journalAssert(fd>=0,'file_unavailable');return fd;}
 #file(fd:number):Stats{const s=fstatSync(fd);journalAssert(s.isFile()&&(s.nlink===1||(this.#recovering&&s.nlink===2&&this.#pairs.has(s.dev+':'+s.ino)))&&s.dev===this.#dev&&(s.mode&0o077)===0,'file_invalid');return s;}
 #syncDirectory():void {fsyncSync(this.#fd);this.metrics.directoriesSynced++;}
 async #hit(phase:DiskFault,name:string):Promise<void>{await this.#fault?.(phase,name);}
 async list(limit:number):Promise<{name:string;size:number}[]>{
  this.#guard();journalAssert(Number.isSafeInteger(limit)&&limit>=0,'budget_exceeded');const maximum=Math.min(limit,this.#maxEntries);
  const entries:{name:string;size:number}[]=[];
  for(const name of this.#native.names(this.#fd,maximum)){this.metrics.entriesEnumerated++;const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const s=this.#file(fd);journalAssert(s.size<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');entries.push({name,size:s.size});}finally{closeSync(fd);}}

  this.#guard();return entries;
 }
 async read(name:string,maxBytes:number):Promise<Buffer>{
  this.#name(name);this.#guard();journalAssert(Number.isSafeInteger(maxBytes)&&maxBytes>=0&&maxBytes<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{const before=this.#file(fd);journalAssert(before.size<=maxBytes,'budget_exceeded');const parts:Buffer[]=[];let size=0;const buffer=Buffer.alloc(Math.min(1024*1024,maxBytes+1));for(;;){const n=readSync(fd,buffer,0,Math.min(buffer.length,maxBytes-size+1),null);if(!n)break;size+=n;journalAssert(size<=maxBytes,'budget_exceeded');parts.push(Buffer.from(buffer.subarray(0,n)));}const after=this.#file(fd);journalAssert(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'file_changed');const check=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{const current=this.#file(check);journalAssert(current.dev===before.dev&&current.ino===before.ino,'file_changed');}finally{closeSync(check);}this.#guard();const bytes=Buffer.concat(parts),pair=this.#pairs.get(before.dev+':'+before.ino);if(pair?.final===name)pair.digest=ownedSha256(bytes);return bytes;}finally{closeSync(fd);}
 }
 async put(name:string,bytes:Buffer):Promise<void>{
  this.#guard();journalAssert(!this.#writing,'busy');this.#writing=true;let locked=false;
  try{if(!this.#exclusive){this.#native.lock(this.#fd);locked=true;}await this.#put(name,bytes);}
  finally{try{if(locked)this.#native.unlock(this.#fd);}finally{this.#writing=false;}}
 }
 async #put(name:string,bytes:Buffer):Promise<void>{
  this.#name(name);journalAssert(!name.startsWith('pending-')&&Buffer.isBuffer(bytes)&&bytes.length<=JOURNAL_LIMITS.fileBytes,'budget_exceeded');this.#guard();
  const files=await this.list(this.#maxEntries);journalAssert(files.length<=this.#maxEntries,'budget_exceeded');const old=files.find(e=>e.name===name);
  if(old){journalAssert((await this.read(name,JOURNAL_LIMITS.fileBytes)).equals(bytes),'immutable_conflict');const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);try{this.#file(fd);fsyncSync(fd);this.metrics.filesSynced++;}finally{closeSync(fd);}await this.#hit('before-directory-sync',name);this.#syncDirectory();await this.#hit('after-directory-sync',name);this.#guard();return;}
  journalAssert(files.length+2<=this.#maxEntries&&files.reduce((n,f)=>n+f.size,0)+bytes.length<=this.#maxBytes,'budget_exceeded');
  await this.#hit('before-create',name);this.#guard();const temp='pending-'+randomBytes(32).toString('hex')+'.tmp';const fd=this.#open(temp,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW|C.O_NONBLOCK);let open=true;
  try{await this.#hit('after-create',name);this.#guard();this.#file(fd);let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,Math.min(1024*1024,bytes.length-at),null);journalAssert(n>0,'short_write');at+=n;this.metrics.bytesWritten+=n;}await this.#hit('after-write',name);fsyncSync(fd);this.metrics.filesSynced++;await this.#hit('after-file-sync',name);this.#guard();this.#file(fd);
   // linkat publishes a fully written inode without replacing an existing name.
   if(this.#native.link(this.#fd,temp,name)!==0){closeSync(fd);open=false;await this.read(name,JOURNAL_LIMITS.fileBytes).then(old=>journalAssert(old.equals(bytes),'immutable_conflict'));}
   else await this.#hit('after-publish',name);
   journalAssert(this.#native.unlink(this.#fd,temp)===0,'unlink_failed');await this.#hit('before-directory-sync',name);this.#syncDirectory();await this.#hit('after-directory-sync',name);this.#guard();
  }finally{if(open)closeSync(fd);}
 }
 /** Only the disk owner may use this, with full journal/checkpoint authentication in verify. */
 async recoverPublished<T>(verify:()=>Promise<T>):Promise<T>{
  this.#guard();journalAssert(this.#exclusive&&!this.busy,'recovery_lock_required');this.#recovering=true;
  try{
   const names=this.#native.names(this.#fd,this.#maxEntries);journalAssert(names.length<=this.#maxEntries,'budget_exceeded');
   const groups=new Map<string,{name:string;stat:Stats}[]>();let size=0;
   for(const name of names){
    this.#name(name);const fd=this.#open(name,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
    try{const stat=fstatSync(fd);journalAssert(stat.isFile()&&(stat.nlink===1||stat.nlink===2)&&stat.dev===this.#dev&&(stat.mode&0o077)===0,'recovery_inventory_invalid');size+=stat.size;journalAssert(stat.size<=JOURNAL_LIMITS.fileBytes&&size<=this.#maxBytes,'budget_exceeded');const key=stat.dev+':'+stat.ino;groups.set(key,[...(groups.get(key)??[]),{name,stat}]);}finally{closeSync(fd);}
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
    }finally{closeSync(final);if(temp>=0)closeSync(temp);}
    await this.#hit('after-recovery-unlink',pair.final);this.metrics.recoveredPairs++;
   }
   await this.#hit('before-recovery-directory-sync','directory');this.#syncDirectory();this.#guard();return result;
  }finally{this.#pairs.clear();this.#recovering=false;}
 }
 assertOpen():void{this.#guard();}
 /** Diagnostic provider binding, not an isolation certificate or a transferable FD. */
 rootIdentity():Readonly<{device:string;inode:string}>{this.#guard();return Object.freeze({device:String(this.#dev),inode:String(this.#ino)});}
 get ownsWriterLock():boolean{this.#guard();return this.#exclusive;}
 get busy():boolean{return this.#writing||this.#recovering;}
 close():void {journalAssert(!this.busy,'busy');if(!this.#closed){this.#closed=true;closeSync(this.#fd);}}
}
