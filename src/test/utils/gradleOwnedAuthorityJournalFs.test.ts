import * as nodeModule from 'node:module';
import {it,expect,afterEach} from 'vitest';
import {mkdtemp,realpath,mkdir,rm,writeFile,readFile,symlink,link,rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RootedJournalIO} from '../fixtures/gradleOwnedJournalFs.js';
import {AuthorityJournal,journalGenesis,type JournalRecord} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {FileJournalCheckpoint} from '../fixtures/gradleOwnedJournalCheckpoint.js';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
const roots:string[]=[],handles:RootedJournalIO[]=[];
afterEach(async()=>{for(const h of handles.splice(0))h.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const identity={authorityId:'authority',storeEpoch:ownedSha256('epoch'),keyId:'journal-key'};
const records=():JournalRecord[]=>['session-manifest','event-ledger','session-index','operation-result'].map((role,i)=>({id:'root-'+i,role:role as JournalRecord['role'],bytes:Buffer.from(JSON.stringify({value:i}))}));
async function fixture(){const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'owned-a2-')));roots.push(base);const store=path.join(base,'store'),anchor=path.join(base,'checkpoint');await mkdir(store,{mode:0o700});await mkdir(anchor,{mode:0o700});const io=await RootedJournalIO.open({root:store}),checkpointIO=await RootedJournalIO.open({root:anchor});handles.push(io,checkpointIO);const checkpoint=new FileJournalCheckpoint({identity,keyId:'checkpoint-key',key:Buffer.alloc(32,27),io:checkpointIO});await checkpoint.initialize();return {...identity,key:Buffer.alloc(32,19),io,checkpoint,checkpointIO,base,store,anchor};}
it('syncs real files and directories and recovers the authenticated history',async()=>{const f=await fixture(),j=await AuthorityJournal.create(f),receipt=await j.commit({operationId:'op',requestDigest:ownedSha256('request'),records:records()});expect((await f.checkpoint.read()).revision).toBe(1);const recovered=await AuthorityJournal.open(f);expect(await recovered.lookupOperation('op')).toMatchObject({headDigest:receipt.headDigest,backendEligible:false});expect(f.io.metrics.filesSynced).toBeGreaterThan(0);expect(f.io.metrics.directoriesSynced).toBeGreaterThan(0);});

it('refuses immutable replacement, symlinks and hardlinks before writing',async()=>{
 const f=await fixture();await f.io.put('journal.meta',Buffer.from('one'));
 await expect(f.io.put('journal.meta',Buffer.from('two'))).rejects.toThrow('immutable_conflict');
 expect((await readFile(path.join(f.store,'journal.meta'))).toString()).toBe('one');
 const outside=path.join(f.base,'outside');await writeFile(outside,'outside',{mode:0o600});
 await symlink(outside,path.join(f.store,'commit-00000001.json'));
 const before=f.io.metrics.bytesWritten;await expect(f.io.put('commit-00000002.json',Buffer.from('x'))).rejects.toThrow();
 expect(f.io.metrics.bytesWritten).toBe(before);expect((await readFile(outside)).toString()).toBe('outside');
 await rm(path.join(f.store,'commit-00000001.json'));await link(outside,path.join(f.store,'commit-00000001.json'));
 await expect(f.io.read('commit-00000001.json',100)).rejects.toThrow('file_invalid');
});
it('rejects root replacement before creating or writing a file',async()=>{
 const f=await fixture();let replaced=false;
 const io=await RootedJournalIO.open({root:f.store,fault:async phase=>{if(phase==='before-create'&&!replaced){replaced=true;await rename(f.store,f.store+'-old');await mkdir(f.store,{mode:0o700});}}});handles.push(io);
 await expect(io.put('journal.meta',Buffer.from('x'))).rejects.toThrow('root_changed');expect(io.metrics.bytesWritten).toBe(0);
});
it('bounds directory enumeration and rejects capacity overflow before writes',async()=>{
 const f=await fixture();for(let i=0;i<8;i++)await writeFile(path.join(f.store,`commit-${String(i).padStart(8,'0')}.json`),'x',{mode:0o600});
 const before=f.io.metrics.entriesEnumerated;expect(await f.io.list(2)).toHaveLength(3);expect(f.io.metrics.entriesEnumerated-before).toBe(3);
 const io=await RootedJournalIO.open({root:f.anchor,maxBytes:1});handles.push(io);
 await expect(io.put('journal.meta',Buffer.from('xx'))).rejects.toThrow('budget_exceeded');expect(io.metrics.bytesWritten).toBe(0);
});
for(const point of ['before-create','after-create','after-write','after-file-sync','after-publish','before-directory-sync','after-directory-sync'] as const){
 it(`does not acknowledge disk failure at ${point}`,async()=>{
  const f=await fixture();const io=await RootedJournalIO.open({root:f.store,fault:phase=>{if(phase===point)throw new Error('injected');}});handles.push(io);
  await expect(io.put('journal.meta',Buffer.from('complete'))).rejects.toThrow('injected');
  if(point==='after-publish')await expect(f.io.read('journal.meta',100)).rejects.toThrow('file_invalid');
  if(point==='after-directory-sync')expect((await f.io.read('journal.meta',100)).toString()).toBe('complete');
 });
}
it('rejects actual store rollback while its external checkpoint is retained',async()=>{
 const f=await fixture(),j=await AuthorityJournal.create(f);await j.commit({operationId:'op',requestDigest:ownedSha256('request'),records:records()});
 await rm(path.join(f.store,'commit-00000001.json'));await expect(AuthorityJournal.open(f)).rejects.toThrow('rollback_detected');
});
it('rejects corrupted on-disk checkpoint authentication',async()=>{
 const f=await fixture();const file=path.join(f.anchor,'checkpoint-00000000.json');const bytes=await readFile(file);bytes[bytes.length-3]=bytes[bytes.length-3]!^1;await writeFile(file,bytes);
 await expect(f.checkpoint.read()).rejects.toThrow();
});

for(const phase of ['after-records','after-commit','after-checkpoint'] as const){
 it.skipIf(typeof nodeModule.stripTypeScriptTypes!=='function')(`recovers after actual child process termination at ${phase}`,async()=>{
  const f=await fixture();await AuthorityJournal.create(f);
  for(const [source,target] of [
   ['src/test/fixtures/gradleOwnedAuthorityJournal.ts','journal.mjs'],
   ['src/test/fixtures/gradleOwnedJournalFs.ts','disk.mjs'],
   ['src/test/fixtures/gradleOwnedJournalCheckpoint.ts','checkpoint.mjs'],
   ['src/utils/gradleOwnedJson.ts','json.mjs'],
  ]){
   const sourceText=(await readFile(path.resolve(source!),'utf8')).replaceAll('../../utils/gradleOwnedJson.js','./json.mjs').replaceAll('./gradleOwnedAuthorityJournal.js','./journal.mjs');
   await writeFile(path.join(f.base,target!),nodeModule.stripTypeScriptTypes(sourceText));
  }
  await symlink(path.resolve('node_modules'),path.join(f.base,'node_modules'),'dir');
  const script=`import {AuthorityJournal} from './journal.mjs';import {RootedJournalIO} from './disk.mjs';import {FileJournalCheckpoint} from './checkpoint.mjs';
const identity=${JSON.stringify(identity)};const io=await RootedJournalIO.open({root:${JSON.stringify(f.store)}});const anchor=await RootedJournalIO.open({root:${JSON.stringify(f.anchor)}});
const checkpoint=new FileJournalCheckpoint({identity,keyId:'checkpoint-key',key:Buffer.alloc(32,27),io:anchor});
const j=await AuthorityJournal.open({...identity,key:Buffer.alloc(32,19),io,checkpoint,fault:phase=>{if(phase===${JSON.stringify(phase)})process.kill(process.pid,'SIGKILL');}});
await j.commit({operationId:'child',requestDigest:${JSON.stringify(ownedSha256('request'))},records:${JSON.stringify(records().map(r=>({...r,bytes:r.bytes.toString('base64')})))}.map(r=>({...r,bytes:Buffer.from(r.bytes,'base64')}))});process.exit(99);`;
  const file=path.join(f.base,'child.mjs');await writeFile(file,script);
  const {execFile}=await import('node:child_process');
  const failure=await new Promise<Error&{signal?:string;code?:number|string}>(resolve=>execFile(process.execPath,[file],{timeout:15000},error=>resolve(error!)));
  expect(failure?.signal).toBe('SIGKILL');
  const recovered=await AuthorityJournal.open(f);expect(recovered.head.revision).toBe(phase==='after-records'?0:1);
  const replay=await recovered.commit({operationId:'child',requestDigest:ownedSha256('request'),records:records()});expect(replay.revision).toBe(1);
  expect((await f.checkpoint.read()).revision).toBe(1);expect(recovered.backendEligible).toBe(false);
 });
}

it('rejects ack after real checkpoint publication until directory re-sync succeeds on reopen',async()=>{
 const f=await fixture();let failing=false,failures=0;
 const checkpointIO=await RootedJournalIO.open({root:f.anchor,fault:(phase,name)=>{
  if(failing&&name==='checkpoint-00000001.json'&&phase==='before-directory-sync'){failures++;throw Error('injected directory sync failure');}
 }});handles.push(checkpointIO);
 const anchor=()=>new FileJournalCheckpoint({identity,keyId:'checkpoint-key',key:Buffer.alloc(32,27),io:checkpointIO});
 const config={...f,checkpoint:anchor()};const j=await AuthorityJournal.create(config);
 const input={operationId:'once',requestDigest:ownedSha256('once'),records:records()};
 failing=true;await expect(j.commit(input)).rejects.toThrow('checkpoint_unavailable');
 // The final name is visible and nlink=1, but the publishing directory sync never completed.
 expect((await f.checkpointIO.list(4096)).some(e=>e.name==='checkpoint-00000001.json')).toBe(true);
 await expect(j.commit(input)).rejects.toThrow('recovery_required');
 for(let retry=0;retry<2;retry++)await expect(AuthorityJournal.open({...config,checkpoint:anchor()})).rejects.toThrow('checkpoint_unavailable');
 expect(failures).toBe(3);
 failing=false;const before=checkpointIO.metrics.directoriesSynced;
 const recovered=await AuthorityJournal.open({...config,checkpoint:anchor()});
 expect(checkpointIO.metrics.directoriesSynced).toBeGreaterThan(before);
 expect(await recovered.commit(input)).toMatchObject({revision:1,replayed:true});
 expect((await f.io.list(4096)).filter(e=>e.name.startsWith('commit-'))).toHaveLength(1);
 expect(await recovered.lookupOperation('once')).toMatchObject({revision:1,backendEligible:false});
});
