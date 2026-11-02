import {it,expect} from 'vitest';
import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis,type JournalFault} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
import {ownedDigest,ownedSha256,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
const identity={authorityId:'caller',storeEpoch:ownedSha256('restart-epoch'),keyId:'journal'};
const scope={project:'main::',context:'runtime',invocation:'invocation'};
async function setup(fault?:(p:JournalFault)=>void|Promise<void>){
 const fixture=ownedPolicyFixture(),io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity));
 const storage={...identity,key:Buffer.alloc(32,8),io,checkpoint,fault};
 const journal=await AuthorityJournal.create(storage);let now=0,seq=0;
 const config={authorityId:'caller',policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',fixture.claim.profileDigest),registry:createOwnedRegistry(fixture.raw)},now:()=>now,journal};
 const model=new OwnedAuthorityContract(config),caller=model.principal('caller');
 const command=(payload:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++seq),...payload});
 const begin=()=>command({operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest([scope])});
 return {...fixture,io,checkpoint,storage,journal,config,model,caller,command,begin,advance:(ms:number)=>{now+=ms;}};
}
const json=(records:Awaited<ReturnType<AuthorityJournal['readLatest']>>,role:string)=>records.filter(r=>r.role===role).map(r=>JSON.parse(r.bytes.toString()));
it('durably invalidates the old draft before a restarted kernel accepts a new session',async()=>{
 const f=await setup(),request=f.begin(),old=await f.model.dispatchDurable(f.caller,request);
 const restarted=await OwnedAuthorityContract.restart(f.config);
 const saved=json(await f.journal.readLatest(),'session-index')[0];expect(saved.sessions[0].summary).toMatchObject({sessionId:old.sessionId,lifecycle:'closed',validity:'expired'});
 expect(saved.sessions[0].uploads[0].state).toBe('cancelled');
 await expect(restarted.dispatchDurable(f.caller,request)).rejects.toThrow('permission_denied');
 const caller=restarted.principal('caller'),next=await restarted.dispatchDurable(caller,f.begin());expect(next.sessionId).not.toBe(old.sessionId);
 expect(json(await f.journal.readLatest(),'session-index')[0].sessions).toHaveLength(2);
});

import {graphFixture} from '../fixtures/gradleGraphFixture.js';
type F=Awaited<ReturnType<typeof setup>>;
const call=(f:F,model:OwnedAuthorityContract,actor:object,payload:any)=>model.dispatchDurable(actor,f.command(payload));
async function activate(f:F,model=f.model,caller=f.caller,current=0){
 const s=await model.dispatchDurable(caller,f.begin()),bytes=Buffer.from(canonicalOwnedJson(graphFixture()));
 const upload=await call(f,model,caller,{operation:'put-metadata-chunk',sessionId:s.sessionId,uploadId:s.coreUploadId,purpose:'core',expectedRevision:0,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal:0,chunkSha256:ownedSha256(bytes),base64:bytes.toString('base64')});
 const b=await call(f,model,caller,{operation:'bind-core',sessionId:s.sessionId,expectedRevision:1,coreMetadataRef:upload.ref,coreGraphDigest:ownedDigest(graphFixture()),rootRegistryDigest:ownedSha256('pin'),scopes:[{...scope,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}]});
 return model.dispatchDurable(caller,f.command({operation:'activate',sessionId:s.sessionId,expectedRevision:b.revision,expectedCurrentRevision:current}));
}
async function register(f:F,model:OwnedAuthorityContract,caller:object,s:any){
 const r=await call(f,model,caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});return {...s,...r,broker:model.principal('broker',s.sessionId,scope)};
}
const action=(f:F,r:any)=>f.command({operation:'append-event',sessionId:r.sessionId,scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}});
it('fences the old kernel and rejects old actors, bearer capabilities and action permission replay',async()=>{
 const f=await setup(),r=await register(f,f.model,f.caller,await activate(f)),request=action(f,r),ack=await f.model.dispatchDurable(r.broker,request);
 const restarted=await OwnedAuthorityContract.restart(f.config);
 await expect(f.model.dispatchDurable(r.broker,request)).rejects.toThrow('generation_changed');
 await expect(restarted.dispatchDurable(r.broker,request)).rejects.toThrow('permission_denied');
 const broker=restarted.principal('broker',r.sessionId,scope);
 await expect(restarted.dispatchDurable(broker,request)).rejects.toThrow('not_current');
 await expect(restarted.dispatchDurable(ack,request)).rejects.toThrow('permission_denied');
 const reader=restarted.principal('reader');expect(await call(f,restarted,reader,{operation:'lookup',sessionId:r.sessionId,scope,expectedRevision:0})).toMatchObject({contractStatus:'session-unavailable',backendEligible:false});
 const caller=restarted.principal('caller'),next=await register(f,restarted,caller,await activate(f,restarted,caller,2));
 await expect(restarted.dispatchDurable(next.broker,{...action(f,next),event:{kind:'action-start',capability:r.capability}})).rejects.toThrow('capability_invalid');
 const current=await restarted.dispatchDurable(next.broker,action(f,next));expect(current.lifecycle).toBe('executing');
 const saved=await f.journal.readLatest(),index=json(saved,'session-index')[0];
 expect(index.sessions.find((s:any)=>s.summary.sessionId===r.sessionId).summary).toMatchObject({lifecycle:'closed',validity:'expired',scopes:[{validity:'revoked',lifecycle:'terminal'}]});
 expect(json(saved,'action-reservation').find((v:any)=>v.sessionId===r.sessionId)).toMatchObject({consumed:true,witnessId:r.witnessId});
 expect(Buffer.concat(saved.map(r=>r.bytes)).includes(r.capability)).toBe(false);
});
it('fences a still-live predecessor after reopening with a different journal object',async()=>{
 const f=await setup(),input=f.begin();await f.model.dispatchDurable(f.caller,input);
 const journal=await AuthorityJournal.open(f.storage);await OwnedAuthorityContract.restart({...f.config,journal});
 await expect(f.model.dispatchDurable(f.caller,input)).rejects.toThrow('generation_changed');
});
it('does not expose the new kernel before restart invalidation is checkpointed',async()=>{
 let armed=false,release!:()=>void,hit!:()=>void;const wait=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>hit=r);
 const f=await setup(async phase=>{if(armed&&phase==='before-checkpoint'){hit();await wait;}});await activate(f);armed=true;
 let ready=false;const pending=OwnedAuthorityContract.restart(f.config).then(m=>{ready=true;return m;});await reached;expect(ready).toBe(false);
 release();const restarted=await pending;expect(ready).toBe(true);expect(json(await f.journal.readLatest(),'session-index')[0].sessions[0].summary.validity).toBe('expired');
 expect(await restarted.dispatchDurable(restarted.principal('caller'),f.begin())).toMatchObject({lifecycle:'draft'});
});
for(const phase of ['before-records','after-records','after-commit','before-checkpoint','after-checkpoint','before-ack'] as JournalFault[]){
 it('withholds startup after restart persistence fails at '+phase+' and retries without reviving history',async()=>{
  let armed=false;const f=await setup(p=>{if(armed&&p===phase)throw Error('restart fault');}),s=await activate(f);armed=true;
  let issued=0;await expect(OwnedAuthorityContract.restart(f.config).then(()=>{issued++;})).rejects.toThrow('restart fault');expect(issued).toBe(0);
  const journal=await AuthorityJournal.open({...f.storage,fault:undefined}),restarted=await OwnedAuthorityContract.restart({...f.config,journal});
  const index=json(await journal.readLatest(),'session-index')[0];expect(index.sessions[0].summary).toMatchObject({sessionId:s.sessionId,validity:'expired',lifecycle:'closed',revision:s.revision+1});
  expect(index.slots[0][1]).toEqual({revision:2});
  await expect(restarted.dispatchDurable(f.caller,f.begin())).rejects.toThrow('permission_denied');
 });
}
it('keeps previously closed terminals and frozen metadata but never restores a current session',async()=>{
 const f=await setup(),r=await register(f,f.model,f.caller,await activate(f));
 const closed=await call(f,f.model,f.caller,{operation:'abort',sessionId:r.sessionId,scope,expectedRevision:r.revision,reason:'operator-request'});
 expect(closed.terminal.outcome).toBe('unavailable');
 const before=await f.journal.readLatest(),restarted=await OwnedAuthorityContract.restart(f.config),once=json(await f.journal.readLatest(),'session-index')[0];
 expect(json(await f.journal.readLatest(),'terminal-record')[0].terminal).toEqual(closed.terminal);
 expect((await f.journal.readLatest()).filter(r=>r.role==='metadata-snapshot').map(r=>r.bytes)).toEqual(before.filter(r=>r.role==='metadata-snapshot').map(r=>r.bytes));
 const reader=restarted.principal('reader');await OwnedAuthorityContract.restart({...f.config,now:()=>0});
 const twice=json(await f.journal.readLatest(),'session-index')[0];expect(twice.sessions).toEqual(once.sessions);expect(twice.slots).toEqual(once.slots);
 await expect(restarted.dispatchDurable(reader,f.begin())).rejects.toThrow();
});
it('rejects authenticated but inconsistent snapshot references before any restart write',async()=>{
 const f=await setup();await activate(f);const records=await f.journal.readLatest(),r=records.find(r=>r.role==='session-index')!,ix=JSON.parse(r.bytes.toString());ix.sessions[0].summary.revision++;r.bytes=Buffer.from(canonicalOwnedJson(ix));
 await f.journal.commit({operationId:'invalid-snapshot',requestDigest:ownedSha256('invalid'),records});const before=f.journal.head.revision;
 await expect(OwnedAuthorityContract.restart(f.config)).rejects.toThrow('authority_snapshot_invalid');expect(f.journal.head.revision).toBe(before);
});
for(const corruption of ['old-blob','rollback','checkpoint'] as const)it('verifies all saved history on restart and rejects '+corruption,async()=>{
 const f=await setup();await f.model.dispatchDurable(f.caller,f.begin());await f.model.dispatchDurable(f.caller,f.begin());
 if(corruption==='checkpoint')f.checkpoint.read=async()=>{throw Error('missing');};
 if(corruption==='rollback')f.io.files.delete('commit-00000002.json');
 if(corruption==='old-blob'){
  const commit=JSON.parse(f.io.files.get('commit-00000001.json')!.toString());const result=commit.body.records.find((r:any)=>r.role==='operation-result');f.io.files.set('blob-'+result.chunks[0].sha256+'.bin',Buffer.from('changed'));
 }
 await expect(OwnedAuthorityContract.restart(f.config)).rejects.toThrow(/authority_journal_/);
});
it('restarts an empty journal with a persisted startup marker',async()=>{
 const f=await setup(),restarted=await OwnedAuthorityContract.restart(f.config);expect(json(await f.journal.readLatest(),'operation-result')[0]).toMatchObject({maintenance:'restart',invalidated:[],backendEligible:false});
 expect(await restarted.dispatchDurable(restarted.principal('caller'),f.begin())).toMatchObject({lifecycle:'draft'});
});

it('allows a fresh boot session quota after invalidating a full previous boot',async()=>{
 const f=await setup();for(let i=0;i<32;i++)await f.model.dispatchDurable(f.caller,f.begin());
 const restarted=await OwnedAuthorityContract.restart(f.config),caller=restarted.principal('caller');
 expect(await restarted.dispatchDurable(caller,f.begin())).toMatchObject({lifecycle:'draft'});
 expect(json(await f.journal.readLatest(),'session-index')[0].sessions).toHaveLength(33);
 await expect(OwnedAuthorityContract.restart(f.config)).resolves.toBeInstanceOf(OwnedAuthorityContract);
});
it('requires an explicit limits migration instead of saving history under incompatible limits',async()=>{
 const f=await setup();await f.model.dispatchDurable(f.caller,f.begin());const before=f.journal.head.revision;
 await expect(OwnedAuthorityContract.restart({...f.config,limits:{chunkBytes:1}})).rejects.toThrow('restart_limits_mismatch');expect(f.journal.head.revision).toBe(before);
});

it('keeps startup closed while the published restart checkpoint cannot be re-synced',async()=>{
 const {FileJournalCheckpoint}=await import('../fixtures/gradleOwnedJournalCheckpoint.js');
 const f=await setup(),checkpointIO=new MemoryJournalIO();let failing=false,published=false,failures=0;
 const put=checkpointIO.put.bind(checkpointIO);
 checkpointIO.put=async(name,bytes)=>{await put(name,bytes);if(failing&&name==='checkpoint-00000002.json'){published=true;failures++;throw Error('directory sync failed');}};
 const checkpoint=new FileJournalCheckpoint({identity,keyId:'anchor',key:Buffer.alloc(32,9),io:checkpointIO});await checkpoint.initialize();
 const storage={...f.storage,io:new MemoryJournalIO(),checkpoint},journal=await AuthorityJournal.create(storage),config={...f.config,journal};
 const model=new OwnedAuthorityContract(config);await model.dispatchDurable(model.principal('caller'),f.begin());failing=true;
 await expect(OwnedAuthorityContract.restart(config)).rejects.toThrow('checkpoint_unavailable');expect(published).toBe(true);
 for(let i=0;i<2;i++)await expect(AuthorityJournal.open(storage)).rejects.toThrow('checkpoint_unavailable');expect(failures).toBe(3);
 failing=false;const reopened=await AuthorityJournal.open(storage),restarted=await OwnedAuthorityContract.restart({...config,journal:reopened});
 expect(json(await reopened.readLatest(),'session-index')[0].sessions[0].summary).toMatchObject({lifecycle:'closed',validity:'expired',revision:2});
 expect(await restarted.dispatchDurable(restarted.principal('caller'),f.begin())).toMatchObject({lifecycle:'draft'});
});
it('reopens real files and checkpoints invalidation before issuing a fresh actor',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const {RootedJournalIO}=await import('../fixtures/gradleOwnedJournalFs.js'),{FileJournalCheckpoint}=await import('../fixtures/gradleOwnedJournalCheckpoint.js');
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'authority-restart-'))),handles:Awaited<ReturnType<typeof RootedJournalIO.open>>[]=[];
 try{
  await fs.mkdir(path.join(base,'store'),{mode:0o700});await fs.mkdir(path.join(base,'anchor'),{mode:0o700});
  const open=async()=>{const io=await RootedJournalIO.open({root:path.join(base,'store')}),anchor=await RootedJournalIO.open({root:path.join(base,'anchor')});handles.push(io,anchor);return {io,checkpoint:new FileJournalCheckpoint({identity,keyId:'anchor',key:Buffer.alloc(32,9),io:anchor})};};
  const initial=await open();await initial.checkpoint.initialize();const f=await setup(),storage={...f.storage,...initial},journal=await AuthorityJournal.create(storage),config={...f.config,journal};
  const original=new OwnedAuthorityContract(config),caller=original.principal('caller'),r=await register(f,original,caller,await activate(f,original,caller));await original.dispatchDurable(r.broker,action(f,r));
  for(const handle of handles.splice(0))handle.close();
  const fresh=await open(),reopened=await AuthorityJournal.open({...storage,...fresh}),restarted=await OwnedAuthorityContract.restart({...config,journal:reopened,now:()=>0});
  const saved=await reopened.readLatest();expect(json(saved,'session-index')[0].sessions[0].summary).toMatchObject({lifecycle:'closed',validity:'expired',scopes:[{validity:'revoked'}]});
  expect((await fresh.checkpoint.read()).revision).toBe(reopened.head.revision);
  expect(json(saved,'action-reservation')[0]).toMatchObject({sessionId:r.sessionId,consumed:true});
  await expect(restarted.dispatchDurable(r.broker,action(f,r))).rejects.toThrow('permission_denied');
  const nextCaller=restarted.principal('caller'),next=await activate(f,restarted,nextCaller,2);expect(next.validity).toBe('current');
 }finally{for(const handle of handles)handle.close();await fs.rm(base,{recursive:true,force:true});}
});

it('recovers a process killed during restart invalidation without reopening old execution permission',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const {RootedJournalIO}=await import('../fixtures/gradleOwnedJournalFs.js'),{FileJournalCheckpoint}=await import('../fixtures/gradleOwnedJournalCheckpoint.js');
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'authority-restart-kill-'))),handles:Awaited<ReturnType<typeof RootedJournalIO.open>>[]=[];
 try{
  await fs.mkdir(path.join(base,'store'),{mode:0o700});await fs.mkdir(path.join(base,'anchor'),{mode:0o700});
  const open=async()=>{const io=await RootedJournalIO.open({root:path.join(base,'store')}),anchor=await RootedJournalIO.open({root:path.join(base,'anchor')});handles.push(io,anchor);return {io,checkpoint:new FileJournalCheckpoint({identity,keyId:'anchor',key:Buffer.alloc(32,9),io:anchor})};};
  const initial=await open();await initial.checkpoint.initialize();const f=await setup(),storage={...f.storage,...initial},journal=await AuthorityJournal.create(storage),config={...f.config,journal};
  const original=new OwnedAuthorityContract(config),caller=original.principal('caller'),r=await register(f,original,caller,await activate(f,original,caller));await original.dispatchDurable(r.broker,action(f,r));
  for(const handle of handles.splice(0))handle.close();
  // Use the project's compiler so the child runs the actual module closure,
  // including TypeScript parameter properties, without a hand-written transform.
  await fs.symlink(path.resolve('node_modules'),path.join(base,'node_modules'),'dir');
  await fs.writeFile(path.join(base,'package.json'),JSON.stringify({type:'module'}));
  const project=path.join(base,'tsconfig.json');
  await fs.writeFile(project,JSON.stringify({extends:path.resolve('tsconfig.json'),compilerOptions:{rootDir:process.cwd(),outDir:path.join(base,'modules'),noEmit:false},include:['gradleOwnedAuthority','gradleOwnedAuthorityJournal','gradleOwnedJournalFs','gradleOwnedJournalCheckpoint','gradleOwnedPolicyFixture'].map(name=>path.resolve('src/test/fixtures/'+name+'.ts')),exclude:[]}));
  const {execFile}=await import('node:child_process');
  await new Promise<void>((resolve,reject)=>execFile(path.resolve('node_modules/.bin/tsc'),['-p',project],{timeout:15000},(error,stdout,stderr)=>error?reject(Error(stdout+stderr)):resolve()));
  const script=`import {OwnedAuthorityContract} from './modules/src/test/fixtures/gradleOwnedAuthority.js';
import {AuthorityJournal} from './modules/src/test/fixtures/gradleOwnedAuthorityJournal.js';
import {RootedJournalIO} from './modules/src/test/fixtures/gradleOwnedJournalFs.js';
import {FileJournalCheckpoint} from './modules/src/test/fixtures/gradleOwnedJournalCheckpoint.js';
import {ownedPolicyFixture} from './modules/src/test/fixtures/gradleOwnedPolicyFixture.js';
import {parseOwnedSettings,createOwnedRegistry} from './modules/src/utils/gradleOwnedPolicy.js';
const identity=${JSON.stringify(identity)},io=await RootedJournalIO.open({root:${JSON.stringify(path.join(base,'store'))}}),anchor=await RootedJournalIO.open({root:${JSON.stringify(path.join(base,'anchor'))}});
const checkpoint=new FileJournalCheckpoint({identity,keyId:'anchor',key:Buffer.alloc(32,9),io:anchor});
const journal=await AuthorityJournal.open({...identity,key:Buffer.alloc(32,8),io,checkpoint,fault:phase=>{if(phase==='after-commit')process.kill(process.pid,'SIGKILL');}});
const f=ownedPolicyFixture();await OwnedAuthorityContract.restart({authorityId:'caller',journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)}});process.exit(99);`;
  const child=path.join(base,'restart-child.mjs');await fs.writeFile(child,script);
  const result=await new Promise<{signal?:string|null;message?:string}>(resolve=>execFile(process.execPath,[child],{timeout:15000},error=>resolve(error??{})));expect(result.signal,result.message).toBe('SIGKILL');
  const fresh=await open(),reopened=await AuthorityJournal.open({...storage,...fresh}),restarted=await OwnedAuthorityContract.restart({...config,journal:reopened});
  const saved=json(await reopened.readLatest(),'session-index')[0];expect(saved.sessions[0].summary).toMatchObject({sessionId:r.sessionId,lifecycle:'closed',validity:'expired',revision:4});
  expect(saved.slots[0][1]).toEqual({revision:2});
  await expect(restarted.dispatchDurable(r.broker,action(f,r))).rejects.toThrow('permission_denied');
  const next=await activate(f,restarted,restarted.principal('caller'),2);expect(next.validity).toBe('current');
 }finally{for(const handle of handles)handle.close();await fs.rm(base,{recursive:true,force:true});}
},45_000);

for(const mutation of ['schema','metadata-ref','ledger-chain','reservation','noncanonical','metadata-bytes'] as const){
 it('rejects a re-authenticated snapshot with invalid '+mutation+' before issuing a restarted kernel',async()=>{
  const f=await setup(),r=await register(f,f.model,f.caller,await activate(f));await f.model.dispatchDurable(r.broker,action(f,r));
  const records=await f.journal.readLatest(),indexRecord=records.find(r=>r.role==='session-index')!,index=JSON.parse(indexRecord.bytes.toString());
  const edit=(role:string,change:(value:any)=>void)=>{const record=records.find(r=>r.role===role)!,value=JSON.parse(record.bytes.toString());change(value);record.bytes=Buffer.from(canonicalOwnedJson(value));};
  if(mutation==='schema')edit('session-manifest',v=>v.schema='unsupported');
  if(mutation==='metadata-ref')index.sessions[0].uploads[0].records[0]='missing';
  if(mutation==='ledger-chain')edit('event-ledger',v=>v.events[0].previousDigest=ownedSha256('wrong'));
  if(mutation==='reservation')edit('action-reservation',v=>v.eventDigest=ownedSha256('wrong'));
  if(mutation==='noncanonical'){const record=records.find(r=>r.role==='session-manifest')!;record.bytes=Buffer.concat([record.bytes,Buffer.from(' ')]);}
  if(mutation==='metadata-bytes'){const record=records.find(r=>r.role==='metadata-snapshot')!;record.bytes=Buffer.from('{}');}
  index.records=records.filter(r=>r.role!=='session-index'&&r.role!=='operation-result').map(r=>({id:r.id,role:r.role,size:r.bytes.length,sha256:ownedSha256(r.bytes)}));
  indexRecord.bytes=Buffer.from(canonicalOwnedJson(index));
  await f.journal.commit({operationId:'re-signed-invalid',requestDigest:ownedSha256('invalid'),records});const before=f.journal.head.revision;
  await expect(OwnedAuthorityContract.restart(f.config)).rejects.toThrow('authority_snapshot_invalid');expect(f.journal.head.revision).toBe(before);
 });
}
