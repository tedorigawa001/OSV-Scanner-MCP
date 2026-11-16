/** Complete ecosystem ZIPs fetched explicitly from OSV; immutable objects and an atomic manifest. */
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,chmod,open,opendir,realpath,lstat,rename,rm,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {z} from 'zod';
import {ScanToolError} from '../errors.js';
import {copyRegularFile,readRegularFile} from '../utils/safeRead.js';
import {SNAPSHOT_DIR_PREFIX,trackTempDir} from '../utils/processCleanup.js';
import {offlineConfig,requireOnline,type OfflineOptions} from './offline.js';
export const OFFLINE_ECOSYSTEMS=['Maven','npm','PyPI','Go','crates.io','Packagist','NuGet'] as const;
export const OFFLINE_LIMITS=Object.freeze({databaseBytes:512*1024*1024,totalBytes:2*1024*1024*1024,objects:128,manifestBytes:65536});
const entry=z.object({ecosystem:z.enum(OFFLINE_ECOSYSTEMS),sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().positive().max(OFFLINE_LIMITS.databaseBytes),downloaded_at:z.string().datetime(),url:z.string()}).strict().superRefine((e,c)=>{if(e.url!==databaseURL(e.ecosystem))c.addIssue({code:'custom',message:'database-origin'});});
const manifestSchema=z.object({schema:z.literal(1),databases:z.array(entry).min(1).max(OFFLINE_ECOSYSTEMS.length)}).strict().superRefine((m,c)=>{if(new Set(m.databases.map(d=>d.ecosystem)).size!==m.databases.length)c.addIssue({code:'custom',message:'duplicate-ecosystem'});});
type Manifest=z.infer<typeof manifestSchema>;
export const databaseURL=(ecosystem:string)=>`https://osv-vulnerabilities.storage.googleapis.com/${encodeURIComponent(ecosystem)}/all.zip`;
const failure=(message:string)=>new ScanToolError('scan_failed',`Offline database cache: ${message}. Run osv-scanner-mcp cache on a connected machine and copy the complete cache directory`);
async function load(root:string):Promise<Manifest>{
 const r=await readRegularFile(path.join(root,'manifest.json'),{boundary:root,maxBytes:OFFLINE_LIMITS.manifestBytes});if(!r.ok)throw failure('manifest missing or unreadable');
 try{return manifestSchema.parse(JSON.parse(r.bytes.toString('utf8')));}catch{throw failure('manifest invalid');}
}
async function hashFile(file:string){const hash=createHash('sha256');let size=0;for await(const b of createReadStream(file)){size+=b.length;if(size>OFFLINE_LIMITS.databaseBytes)throw failure('database exceeds the byte limit');hash.update(b);}return {sha256:hash.digest('hex'),bytes:size};}
async function safeDirectory(dir:string){
 await mkdir(dir,{recursive:true,mode:0o700});const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())throw failure('directory must be a real directory');const canonical=await realpath(dir);await chmod(canonical,0o700);return canonical;
}
async function inventory(root:string){let bytes=0,count=0;const dir=await opendir(root);try{for await(const e of dir){if(++count>OFFLINE_LIMITS.objects)throw failure('object count limit reached; remove unused objects while the service is stopped');const s=await lstat(path.join(root,e.name));if(!s.isFile()||s.isSymbolicLink()||!(/^[a-f0-9]{64}\.zip$/.test(e.name)))throw failure('unexpected cache object');bytes+=s.size;if(bytes>OFFLINE_LIMITS.totalBytes)throw failure('cache size limit reached');}}finally{await dir.close().catch(()=>{});}return {bytes,count};}
export interface PrepareOfflineOptions {dir:string;ecosystems:readonly string[];fetchFn?:typeof fetch;now?:number;timeoutMs?:number}
export async function prepareOfflineDatabases(options:PrepareOfflineOptions){
 requireOnline();if(!path.isAbsolute(options.dir))throw failure('directory must be absolute');
 const ecosystems=[...new Set(options.ecosystems)];if(!ecosystems.length||ecosystems.some(e=>!(OFFLINE_ECOSYSTEMS as readonly string[]).includes(e)))throw failure(`ecosystems must be selected from ${OFFLINE_ECOSYSTEMS.join(', ')}`);
 const root=await safeDirectory(path.resolve(options.dir)),objects=path.join(root,'objects');await safeDirectory(objects);
 let lock;try{lock=await open(path.join(root,'update.lock'),'wx',0o600);}catch{throw failure('another update is active, or update.lock remains from an interrupted update; stop the updater before removing that lock');}
 const temp=path.join(objects,'.download-'+randomBytes(12).toString('hex')),manifestTemp=path.join(root,'.manifest-'+randomBytes(12).toString('hex'));
 try{
  const present=await lstat(path.join(root,'manifest.json')).catch(e=>{if(e.code==='ENOENT')return null;throw e;});const prior=present?await load(root):{schema:1 as const,databases:[]};
  const retained=await inventory(objects);let allocated=retained.bytes,count=retained.count;const entries=new Map(prior.databases.map(e=>[e.ecosystem,e]));
  for(const ecosystem of ecosystems){
   if(count>=OFFLINE_LIMITS.objects)throw failure('object count limit reached');
   const url=databaseURL(ecosystem),response=await (options.fetchFn??fetch)(url,{redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??120000)});
   if(response.status!==200||response.headers.has('content-range')||!response.body){await response.body?.cancel();throw failure(`complete download required (HTTP ${response.status})`);}
   const length=Number(response.headers.get('content-length'));if(Number.isFinite(length)&&length>OFFLINE_LIMITS.databaseBytes){await response.body.cancel();throw failure('download exceeds the byte limit');}
   const file=await open(temp,'wx',0o600),hash=createHash('sha256');let bytes=0;const prefix=Buffer.alloc(4);let prefixSize=0;
   try{for await(const chunk of response.body){const b=Buffer.from(chunk);bytes+=b.length;if(bytes>OFFLINE_LIMITS.databaseBytes||allocated+bytes>OFFLINE_LIMITS.totalBytes)throw failure('download exceeds the cache byte limit');if(prefixSize<4){const n=Math.min(4-prefixSize,b.length);b.copy(prefix,prefixSize,0,n);prefixSize+=n;}hash.update(b);for(let at=0;at<b.length;){const w=await file.write(b,at,b.length-at);if(!w.bytesWritten)throw failure('short write');at+=w.bytesWritten;}}if(prefixSize!==4||prefix.readUInt32LE(0)!==0x04034b50)throw failure('download is not a nonempty ZIP archive');await file.sync();}finally{await file.close();}
   const sha256=hash.digest('hex'),object=path.join(objects,sha256+'.zip'),old=await lstat(object).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   if(old){if(old.isSymbolicLink()||!old.isFile())throw failure('existing object is invalid');const v=await hashFile(object);if(v.sha256!==sha256||v.bytes!==bytes)throw failure('existing object is invalid');await rm(temp);}
   else{await rename(temp,object);allocated+=bytes;count++;}
   entries.set(ecosystem as typeof OFFLINE_ECOSYSTEMS[number],entry.parse({ecosystem,sha256,bytes,downloaded_at:new Date(options.now??Date.now()).toISOString(),url}));
  }
  const manifest=manifestSchema.parse({schema:1,databases:[...entries.values()]});const file=await open(manifestTemp,'wx',0o600);try{await file.writeFile(JSON.stringify(manifest,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(manifestTemp,path.join(root,'manifest.json'));return manifest;
 }catch(e){if(e instanceof ScanToolError)throw e;throw failure('update failed; the previous manifest remains selected');}
 finally{await rm(temp,{force:true});await rm(manifestTemp,{force:true});await lock.close();await rm(path.join(root,'update.lock'),{force:true});}
}
export async function captureOfflineDatabases(options:OfflineOptions,required?:readonly string[],now=Date.now()){
 const config=offlineConfig(options);if(!config.enabled)throw failure('offline mode is not enabled');
 let root:string;try{root=await realpath(config.dir);}catch{throw failure('directory is unavailable');}
 const manifest=await load(root),selected=required?manifest.databases.filter(d=>required.includes(d.ecosystem)):manifest.databases;
 if(required?.some(e=>!selected.some(d=>d.ecosystem===e)))throw failure('a required ecosystem database is missing');
 let total=0;for(const d of selected){const age=now-Date.parse(d.downloaded_at);if(age<0||age>=config.maxAgeMs)throw failure(`${d.ecosystem} database is expired or has a future timestamp`);total+=d.bytes;}if(!selected.length||total>OFFLINE_LIMITS.totalBytes)throw failure('database selection exceeds the limit');
 const dir=await mkdtemp(path.join(await realpath(os.tmpdir()),SNAPSHOT_DIR_PREFIX)),untrack=trackTempDir(dir);
 const cleanup=async()=>{await rm(dir,{recursive:true,force:true});untrack();};
 try{for(const d of selected){const target=path.join(dir,'osv-scalibr',d.ecosystem);await mkdir(target,{recursive:true,mode:0o700});const dest=path.join(target,'all.zip'),copied=await copyRegularFile(path.join(root,'objects',d.sha256+'.zip'),dest,{boundary:root,maxBytes:d.bytes});if(!copied.ok||copied.bytes!==d.bytes)throw failure(`${d.ecosystem} database is missing, replaced or truncated`);const v=await hashFile(dest);if(v.sha256!==d.sha256||v.bytes!==d.bytes)throw failure(`${d.ecosystem} database digest mismatch`);}
  return {dir,cleanup,metadata:{mode:'offline' as const,network_requests:false as const,max_age_hours:config.maxAgeMs/3600000,databases:selected.map(d=>({ecosystem:d.ecosystem,downloaded_at:d.downloaded_at,sha256:d.sha256})),warning:'Results use a local database snapshot and do not include vulnerabilities published after it was downloaded'}};
 }catch(e){await cleanup();throw e;}
}
export type OfflineDatabaseMetadata=Awaited<ReturnType<typeof captureOfflineDatabases>>['metadata'];
export const offlineMetadata=new WeakMap<object,OfflineDatabaseMetadata>();
export function offlineResultFields(raw:unknown){const m=typeof raw==='object'&&raw!==null?offlineMetadata.get(raw):undefined;return m?{offline_database:m}:{};}
