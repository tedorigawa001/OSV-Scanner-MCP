/** Cooperative local-disk owner only. Not an isolation backend or a timed execution lease. */
import path from 'node:path';
import {RootedJournalIO,type DiskOptions} from './gradleOwnedJournalFs.js';
import {AuthorityJournal,journalAssert,type JournalIdentity,type JournalFault} from './gradleOwnedAuthorityJournal.js';
import {FileJournalCheckpoint} from './gradleOwnedJournalCheckpoint.js';
export interface OwnedJournalDiskOptions extends JournalIdentity {
 store:DiskOptions;checkpoint:DiskOptions;key:Buffer;checkpointKeyId:string;checkpointKey:Buffer;
 mode:'create'|'open';fault?:(phase:JournalFault)=>void|Promise<void>;
}
export class OwnedJournalDisk {
 readonly journal:AuthorityJournal;
 readonly #store:RootedJournalIO;readonly #checkpoint:RootedJournalIO;
 private constructor(journal:AuthorityJournal,store:RootedJournalIO,checkpoint:RootedJournalIO){this.journal=journal;this.#store=store;this.#checkpoint=checkpoint;}
 static async open(input:OwnedJournalDiskOptions):Promise<OwnedJournalDisk>{
  journalAssert(Buffer.isBuffer(input.key)&&input.key.length===32&&Buffer.isBuffer(input.checkpointKey)&&input.checkpointKey.length===32,'configuration_invalid');
  // Copy secrets/options before the first await; fixed lock order and nonblocking acquisition.
  const options={...input,store:{...input.store},checkpoint:{...input.checkpoint},key:Buffer.from(input.key),checkpointKey:Buffer.from(input.checkpointKey)};
  journalAssert(options.mode==='create'||options.mode==='open','configuration_invalid');
  const store=path.resolve(options.store.root),anchor=path.resolve(options.checkpoint.root);
  journalAssert(store!==anchor&&!store.startsWith(anchor+path.sep)&&!anchor.startsWith(store+path.sep),'roots_overlap');
  const roots=[{role:'store',options:options.store},{role:'checkpoint',options:options.checkpoint}].sort((a,b)=>path.resolve(a.options.root)<path.resolve(b.options.root)?-1:1);
  const opened=new Map<string,RootedJournalIO>();
  try{
   for(const root of roots)opened.set(root.role,await RootedJournalIO.open({...root.options,exclusive:true}));
   const io=opened.get('store')!,checkpointIO=opened.get('checkpoint')!,identity={authorityId:options.authorityId,storeEpoch:options.storeEpoch,keyId:options.keyId};
   const checkpoint=new FileJournalCheckpoint({identity,keyId:options.checkpointKeyId,key:options.checkpointKey,io:checkpointIO});
   const config={...identity,key:options.key,io,checkpoint,fault:options.fault};
   let journal:AuthorityJournal;
   if(options.mode==='create'){
    journalAssert((await io.list(4096)).length===0&&(await checkpointIO.list(4096)).length===0,'store_not_empty');
    await checkpoint.initialize();journal=await AuthorityJournal.create(config);
   }else{
    journal=await io.recoverPublished(()=>checkpointIO.recoverPublished(()=>AuthorityJournal.open(config)));
   }
   return new OwnedJournalDisk(journal,io,checkpointIO);
  }catch(e){for(const io of [...opened.values()].reverse())io.close();throw e;}
 }
 close():void{journalAssert(!this.journal.busy&&!this.#store.busy&&!this.#checkpoint.busy,'busy');this.#store.close();this.#checkpoint.close();}
}
