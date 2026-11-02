import * as nodeModule from 'node:module';
import {it,expect,afterEach} from 'vitest';
import {mkdtemp,realpath,mkdir,rm,readFile,writeFile,readdir,link,lstat,symlink,rename} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {RootedJournalIO} from '../fixtures/gradleOwnedJournalFs.js';
const roots:string[]=[],handles:RootedJournalIO[]=[];
afterEach(async()=>{for(const io of handles.splice(0))io.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function root(){const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'authority-disk-')));roots.push(base);const store=path.join(base,'store'),anchor=path.join(base,'anchor');await mkdir(store,{mode:0o700});await mkdir(anchor,{mode:0o700});return {base,store,anchor};}
it('holds a root writer lock until close and blocks other adapters from writing',async()=>{
 const f=await root(),owner=await RootedJournalIO.open({root:f.store,exclusive:true});handles.push(owner);
 await expect(RootedJournalIO.open({root:f.store,exclusive:true})).rejects.toThrow('writer_busy');
 const other=await RootedJournalIO.open({root:f.store});handles.push(other);
 await expect(other.put('journal.meta',Buffer.from('x'))).rejects.toThrow('writer_busy');
 await owner.put('journal.meta',Buffer.from('x'));owner.close();
 const next=await RootedJournalIO.open({root:f.store,exclusive:true});handles.push(next);await next.put('journal.meta',Buffer.from('x'));
});

import {OwnedJournalDisk} from '../fixtures/gradleOwnedJournalDisk.js';
import {AuthorityJournal,type JournalRecord} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {FileJournalCheckpoint} from '../fixtures/gradleOwnedJournalCheckpoint.js';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
const disks:OwnedJournalDisk[]=[];afterEach(()=>{for(const disk of disks.splice(0))disk.close();});
const identity={authorityId:'authority',storeEpoch:ownedSha256('epoch'),keyId:'journal-key'};
const records=():JournalRecord[]=>['session-manifest','event-ledger','session-index','operation-result'].map((role,i)=>({role:role as JournalRecord['role'],id:String(i),bytes:Buffer.from(JSON.stringify({value:i}))}));
const options=(f:Awaited<ReturnType<typeof root>>)=>({...identity,store:{root:f.store},checkpoint:{root:f.anchor},key:Buffer.alloc(32,19),checkpointKeyId:'checkpoint-key',checkpointKey:Buffer.alloc(32,27)});
async function create(f:Awaited<ReturnType<typeof root>>){const disk=await OwnedJournalDisk.open({...options(f),mode:'create'});disks.push(disk);return disk;}
it('holds both roots, releases them on close and rejects overlapping roots',async()=>{
 const f=await root(),disk=await create(f);
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('writer_busy');
 for(const name of [f.store,f.anchor])await expect(RootedJournalIO.open({root:name,exclusive:true})).rejects.toThrow('writer_busy');
 disk.close();const reopened=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(reopened);
 await expect(OwnedJournalDisk.open({...options(f),checkpoint:{root:f.store},mode:'open'})).rejects.toThrow('roots_overlap');
});
it('releases the first root when acquiring the second root fails',async()=>{
 const f=await root(),held=await RootedJournalIO.open({root:f.store,exclusive:true});handles.push(held);
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('writer_busy');
 const first=await RootedJournalIO.open({root:f.anchor,exclusive:true});handles.push(first);
});
async function interrupted(target:'blob'|'commit'|'checkpoint',corrupt=false){
 const f=await root(),initial=await create(f);initial.close();let armed=true;
 const fail=(phase:string,name:string)=>{if(armed&&phase==='after-publish'&&(target==='blob'?name.startsWith('blob-'):target==='commit'?name.startsWith('commit-'):name==='checkpoint-00000001.json')){armed=false;throw Error('crash');}};
 const writer=await OwnedJournalDisk.open({...options(f),mode:'open',store:{root:f.store,fault:fail},checkpoint:{root:f.anchor,fault:fail}});disks.push(writer);
 await expect(writer.journal.commit({operationId:'op',requestDigest:ownedSha256('op'),records:records()})).rejects.toThrow();writer.close();
 const where=target==='checkpoint'?f.anchor:f.store,files=await readdir(where),temp=files.find(n=>n.startsWith('pending-'))!;
 expect(temp).toBeTruthy();const tempStat=await lstat(path.join(where,temp));expect(tempStat.nlink).toBe(2);
 const final=files.find(n=>!n.startsWith('pending-')&&lstatSyncLocal(path.join(where,n)).ino===tempStat.ino)!;
 if(corrupt)await writeFile(path.join(where,final),'corrupt',{mode:0o600});
 return {f,where,temp,final};
}
import {lstatSync as lstatSyncLocal} from 'node:fs';
for(const target of ['blob','commit','checkpoint'] as const)it('authenticates and repairs only a valid published '+target+' pair',async()=>{
 const {f,where,temp,final}=await interrupted(target);
 const disk=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(disk);
 expect((await lstat(path.join(where,final))).nlink).toBe(1);expect(await readdir(where)).not.toContain(temp);
 const reply=await disk.journal.commit({operationId:'op',requestDigest:ownedSha256('op'),records:records()});expect(reply.revision).toBe(1);
});
for(const target of ['blob','commit','checkpoint'] as const)it('does not unlink an unauthenticated '+target+' pair',async()=>{
 const {f,where,temp,final}=await interrupted(target,true);
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow();
 expect(await readdir(where)).toContain(temp);expect((await lstat(path.join(where,final))).nlink).toBe(2);
 // Failed opens release both writer locks for diagnosis/retry.
 const io=await RootedJournalIO.open({root:f.store,exclusive:true});handles.push(io);
});
it('refuses a foreign hardlink, symlink and unknown inventory without deleting anything',async()=>{
 const f=await root(),disk=await create(f);disk.close();const outside=path.join(f.base,'outside');await link(path.join(f.store,'journal.meta'),outside);
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('recovery_inventory_invalid');expect((await lstat(outside)).nlink).toBe(2);
 await rm(outside);await symlink(path.join(f.store,'journal.meta'),path.join(f.store,'pending-'+ownedSha256('link')+'.tmp'));
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow();
 await rm(path.join(f.store,'pending-'+ownedSha256('link')+'.tmp'));await writeFile(path.join(f.store,'unknown'),'x',{mode:0o600});
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('path_invalid');expect(await readFile(path.join(f.store,'unknown'),'utf8')).toBe('x');
});
it('refuses content changed after authentication and before unlink',async()=>{
 const {f,where,temp,final}=await interrupted('commit');
 await expect(OwnedJournalDisk.open({...options(f),mode:'open',store:{root:f.store,fault:async phase=>{if(phase==='before-recovery-unlink')await writeFile(path.join(where,final),'changed');}}})).rejects.toThrow('content_mismatch');
 expect(await readdir(where)).toContain(temp);
});
it('withholds recovery on directory sync failure and safely resumes when it succeeds',async()=>{
 const {f,where,temp,final}=await interrupted('commit');
 await expect(OwnedJournalDisk.open({...options(f),mode:'open',store:{root:f.store,fault:phase=>{if(phase==='before-recovery-directory-sync')throw Error('sync failed');}}})).rejects.toThrow('sync failed');
 expect(await readdir(where)).not.toContain(temp);expect((await lstat(path.join(where,final))).nlink).toBe(1);
 const disk=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(disk);expect((await disk.journal.lookupOperation('op'))?.revision).toBe(1);
});

async function childModules(f:Awaited<ReturnType<typeof root>>){
 const files=[['src/test/fixtures/gradleOwnedJournalDisk.ts','disk.mjs'],['src/test/fixtures/gradleOwnedJournalFs.ts','fs.mjs'],['src/test/fixtures/gradleOwnedAuthorityJournal.ts','journal.mjs'],['src/test/fixtures/gradleOwnedJournalCheckpoint.ts','checkpoint.mjs'],['src/utils/gradleOwnedJson.ts','json.mjs']];
 for(const [source,target]of files){let text=await readFile(path.resolve(source!),'utf8');for(const [a,b]of [['./gradleOwnedJournalFs.js','./fs.mjs'],['./gradleOwnedAuthorityJournal.js','./journal.mjs'],['./gradleOwnedJournalCheckpoint.js','./checkpoint.mjs'],['../../utils/gradleOwnedJson.js','./json.mjs']])text=text.replaceAll(a!,b!);await writeFile(path.join(f.base,target!),nodeModule.stripTypeScriptTypes(text));}
 await symlink(path.resolve('node_modules'),path.join(f.base,'node_modules'),'dir');
 const o=options(f);return `import {OwnedJournalDisk} from './disk.mjs';import {RootedJournalIO} from './fs.mjs';const options=${JSON.stringify({...o,key:undefined,checkpointKey:undefined})};options.key=Buffer.alloc(32,19);options.checkpointKey=Buffer.alloc(32,27);`;
}
it.skipIf(typeof nodeModule.stripTypeScriptTypes!=='function')('rejects a competing native process without changing either root',async()=>{
 const f=await root();await create(f);const script=await childModules(f),before=[await readdir(f.store),await readdir(f.anchor)];
 const {execFile}=await import('node:child_process');
 const source=script+`try{await OwnedJournalDisk.open({...options,mode:'open'});process.exit(2);}catch(e){if(!e.message.endsWith('writer_busy'))throw e;}const io=await RootedJournalIO.open({root:options.store.root});try{await io.put('journal.meta',Buffer.from('attack'));process.exit(3);}catch(e){if(!e.message.endsWith('writer_busy'))throw e;}io.close();`;
 await new Promise<void>((resolve,reject)=>execFile(process.execPath,['--input-type=module','-e',source],{cwd:f.base,timeout:10000},(err,_out,stderr)=>err?reject(Error(stderr)):resolve()));
 expect([await readdir(f.store),await readdir(f.anchor)]).toEqual(before);
});
it.skipIf(typeof nodeModule.stripTypeScriptTypes!=='function')('releases the native owner lock on SIGKILL and authenticates its interrupted commit',async()=>{
 const f=await root(),seed=await create(f);seed.close();const script=await childModules(f);
 const source=script+`const disk=await OwnedJournalDisk.open({...options,mode:'open',store:{...options.store,fault:(phase,name)=>{if(phase==='after-publish'&&name.startsWith('commit-'))process.kill(process.pid,'SIGKILL');}}});console.log('held');await new Promise(resolve=>process.stdin.once('data',resolve));await disk.journal.commit({operationId:'op',requestDigest:${JSON.stringify(ownedSha256('op'))},records:${JSON.stringify(records().map(r=>({...r,bytes:r.bytes.toString('base64')})))}.map(r=>({...r,bytes:Buffer.from(r.bytes,'base64')}))});process.exit(2);`;
 const file=path.join(f.base,'owner.mjs');await writeFile(file,source);const {spawn}=await import('node:child_process');const child=spawn(process.execPath,[file],{cwd:f.base,stdio:['pipe','pipe','pipe']});
 let stderr='',stdout='';child.stderr.on('data',bytes=>stderr+=bytes.toString());
 const done=new Promise<{code:number|null;signal:string|null}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{
  await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('owner startup timeout '+stderr)),10000);child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(stdout.includes('held')){clearTimeout(timeout);resolve();}});child.once('exit',()=>{clearTimeout(timeout);reject(Error('owner exited before lock '+stderr));});child.once('error',reject);});
  await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('writer_busy');
  child.stdin.write('go');expect((await done).signal,stderr).toBe('SIGKILL');
  const reopened=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(reopened);expect((await reopened.journal.lookupOperation('op'))?.revision).toBe(1);
  for(const directory of [f.store,f.anchor])expect((await readdir(directory)).filter(n=>n.startsWith('pending-'))).toHaveLength(0);
 }finally{child.kill('SIGKILL');}
},30000);
it('restarts the A1 kernel through the exclusive disk owner and rejects the old actor',async()=>{
 const {OwnedAuthorityContract}=await import('../fixtures/gradleOwnedAuthority.js');
 const {ownedPolicyFixture}=await import('../fixtures/gradleOwnedPolicyFixture.js');
 const {createOwnedRegistry,parseOwnedSettings}=await import('../../utils/gradleOwnedPolicy.js');
 const {ownedDigest}=await import('../../utils/gradleOwnedJson.js');
 const f=await root(),disk=await create(f),fixture=ownedPolicyFixture();
 const config={authorityId:'authority',journal:disk.journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',fixture.claim.profileDigest),registry:createOwnedRegistry(fixture.raw)}};
 const original=new OwnedAuthorityContract(config),caller=original.principal('caller');
 const request={schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'begin',operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest([{project:'main::',context:'runtime',invocation:'invocation'}])};
 const old=await original.dispatchDurable(caller,request);disk.close();const reopened=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(reopened);
 const restarted=await OwnedAuthorityContract.restart({...config,journal:reopened.journal});
 await expect(restarted.dispatchDurable(caller,request)).rejects.toThrow('permission_denied');const next=await restarted.dispatchDurable(restarted.principal('caller'),request);expect(next.sessionId).not.toBe(old.sessionId);
});

it('recovers a valid interrupted journal manifest without reinitializing its checkpoint',async()=>{
 const f=await root();await expect(OwnedJournalDisk.open({...options(f),mode:'create',store:{root:f.store,fault:(phase,name)=>{if(phase==='after-publish'&&name==='journal.meta')throw Error('crash');}}})).rejects.toThrow('crash');
 const disk=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(disk);expect(disk.journal.head.revision).toBe(0);expect((await lstat(path.join(f.store,'journal.meta'))).nlink).toBe(1);
});
it('does not repair an authenticated store pair when another required checkpoint is invalid',async()=>{
 const {f,where,temp}=await interrupted('commit');await writeFile(path.join(f.anchor,'checkpoint-00000000.json'),'changed');
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow();expect(await readdir(where)).toContain(temp);
});
it('keeps un-published temp data unadopted and charged to the inventory',async()=>{
 const f=await root(),disk=await create(f);disk.close();const temp='pending-'+ownedSha256('orphan')+'.tmp';await writeFile(path.join(f.store,temp),'partial',{mode:0o600});
 const recovered=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(recovered);expect(recovered.journal.head.revision).toBe(0);expect(await readFile(path.join(f.store,temp),'utf8')).toBe('partial');
});
for(const extra of ['second-final','third-link'] as const)it('refuses ambiguous recovery inventory: '+extra,async()=>{
 const {f,where,temp,final}=await interrupted('commit');
 if(extra==='second-final'){await rename(path.join(where,temp),path.join(where,'commit-00000002.json'));}
 else await link(path.join(where,final),path.join(where,'pending-'+ownedSha256('third')+'.tmp'));
 await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('recovery_inventory_invalid');expect((await lstat(path.join(where,final))).nlink).toBe(extra==='third-link'?3:2);
});
it('refuses root replacement before cleanup without writing into the replacement root',async()=>{
 const {f,temp}=await interrupted('commit');let moved=false;
 await expect(OwnedJournalDisk.open({...options(f),mode:'open',store:{root:f.store,fault:async phase=>{if(phase==='before-recovery-unlink'&&!moved){moved=true;await rename(f.store,f.store+'-old');await mkdir(f.store,{mode:0o700});}}}})).rejects.toThrow('root_changed');
 expect(await readdir(f.store)).toEqual([]);expect(await readdir(f.store+'-old')).toContain(temp);
});

it('holds ownership across a paused journal transaction and refuses close until it settles',async()=>{
 const f=await root();let armed=false,release!:()=>void,hit!:()=>void;const wait=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>hit=r);
 const disk=await OwnedJournalDisk.open({...options(f),mode:'create',fault:async phase=>{if(armed&&phase==='before-checkpoint'){hit();await wait;}}});disks.push(disk);armed=true;
 const pending=disk.journal.commit({operationId:'op',requestDigest:ownedSha256('op'),records:records()});await reached;
 try{expect(()=>disk.close()).toThrow('busy');await expect(OwnedJournalDisk.open({...options(f),mode:'open'})).rejects.toThrow('writer_busy');}
 finally{release();await pending;}
 disk.close();const next=await OwnedJournalDisk.open({...options(f),mode:'open'});disks.push(next);expect((await next.journal.lookupOperation('op'))?.revision).toBe(1);
});

it('rejects an A1 ack if disk ownership closes after journal commit but before kernel reply',async()=>{
 const {OwnedAuthorityContract}=await import('../fixtures/gradleOwnedAuthority.js');
 const {ownedPolicyFixture}=await import('../fixtures/gradleOwnedPolicyFixture.js');
 const {createOwnedRegistry,parseOwnedSettings}=await import('../../utils/gradleOwnedPolicy.js');
 const {ownedDigest}=await import('../../utils/gradleOwnedJson.js');
 const f=await root(),disk=await create(f),fixture=ownedPolicyFixture();
 const model=new OwnedAuthorityContract({authorityId:'authority',journal:disk.journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',fixture.claim.profileDigest),registry:createOwnedRegistry(fixture.raw)}}),caller=model.principal('caller');
 const commit=disk.journal.commit.bind(disk.journal);disk.journal.commit=async input=>{const result=await commit(input);disk.close();return result;};
 let ack=false;await expect(model.dispatchDurable(caller,{schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'begin',operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest([{project:'main::',context:'runtime',invocation:'invocation'}])}).then(()=>{ack=true;})).rejects.toThrow('closed');expect(ack).toBe(false);
});
