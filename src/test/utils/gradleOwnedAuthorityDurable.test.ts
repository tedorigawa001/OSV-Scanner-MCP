import {it,expect} from 'vitest';
import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis,type JournalFault} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
import {canonicalOwnedJson,ownedSha256,ownedDigest} from '../../utils/gradleOwnedJson.js';
const identity={authorityId:'caller',storeEpoch:ownedSha256('epoch'),keyId:'journal'};
const scope={project:'main::',context:'runtime',invocation:'invocation'};
async function setup(fault?:(p:JournalFault)=>void|Promise<void>){
 const f=ownedPolicyFixture(),io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity));
 const journal=await AuthorityJournal.create({...identity,key:Buffer.alloc(32,3),io,checkpoint,fault});let now=0;
 const config={authorityId:'caller',policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)},now:()=>now,journal};
 const model=new OwnedAuthorityContract(config);let seq=0;
 const caller=model.principal('caller'),reader=model.principal('reader');
 const command=(payload:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++seq),...payload});
 return {...f,io,checkpoint,journal,model,caller,reader,config,command,advance:(ms:number)=>{now+=ms;}};
}
const begin=(f:Awaited<ReturnType<typeof setup>>)=>f.command({operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest([scope])});
it('publishes an A1 begin reply only after its state and result are checkpointed',async()=>{
 const f=await setup(),input=begin(f),reply=await f.model.dispatchDurable(f.caller,input);
 expect(f.journal.head.revision).toBe(1);expect(f.checkpoint.value.revision).toBe(1);
 const saved=await f.journal.readLatest();expect(saved.some(r=>r.role==='session-manifest'&&r.bytes.includes(reply.sessionId))).toBe(true);
 expect(saved.some(r=>r.role==='operation-result'&&r.bytes.includes(reply.sessionId))).toBe(true);
 expect(await f.model.dispatchDurable(f.caller,input)).toMatchObject({...reply,historical:true});expect(f.journal.head.revision).toBe(1);
 expect(()=>f.model.dispatch(f.caller,input)).toThrow('async_required');
});

import {graphFixture} from '../fixtures/gradleGraphFixture.js';
import {ownedExecutionCase} from '../fixtures/gradleOwnedExecutionFixture.js';
import {rewriteOwned} from '../fixtures/gradleOwnedFixture.js';
type F=Awaited<ReturnType<typeof setup>>;
const call=(f:F,actor:object,payload:any)=>f.model.dispatchDurable(actor,f.command(payload));
async function upload(f:F,actor:object,s:any,purpose:'core'|'seal',value:unknown,extra:any={}){
 const bytes=Buffer.from(canonicalOwnedJson(value,64*1024*1024));let reply:any;
 for(let ordinal=0;ordinal<Math.ceil(bytes.length/(1024*1024));ordinal++){
  const chunk=bytes.subarray(ordinal*1024*1024,(ordinal+1)*1024*1024);
  reply=await call(f,actor,{operation:'put-metadata-chunk',sessionId:s.sessionId,uploadId:purpose==='core'?s.coreUploadId:s.uploadId,purpose,expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(chunk),base64:chunk.toString('base64'),...extra});
 }
 return reply.ref;
}
async function active(f:F,scopes=[scope],expectedCurrentRevision=0){
 const input=begin(f);input.scopeRequestsDigest=ownedDigest(scopes);const b=await f.model.dispatchDurable(f.caller,input);
 const core=graphFixture(),ref=await upload(f,f.caller,b,'core',core);
 const bound=await call(f,f.caller,{operation:'bind-core',sessionId:b.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedDigest(core),rootRegistryDigest:ownedSha256('pin'),scopes:scopes.map(scope=>({...scope,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}))});
 return await call(f,f.caller,{operation:'activate',sessionId:b.sessionId,expectedRevision:bound.revision,expectedCurrentRevision});
}
async function register(f:F,s:any,selected=scope){
 const r=await call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope:selected,expectedRevision:0});
 return {...s,...r,scope:selected,broker:f.model.principal('broker',s.sessionId,selected),observer:f.model.principal('observer',s.sessionId,selected)};
}
const action=(f:F,r:any)=>f.command({operation:'append-event',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}});
const json=(records:Awaited<ReturnType<AuthorityJournal['readLatest']>>,role:string)=>records.filter(r=>r.role===role).map(r=>JSON.parse(r.bytes.toString()));
it('persists frozen metadata, binding, activation and scope registration without raw capabilities',async()=>{
 const f=await setup(),s=await active(f),r=await register(f,s),saved=await f.journal.readLatest();
 expect(saved.some(x=>x.role==='metadata-snapshot'&&x.bytes.equals(Buffer.from(canonicalOwnedJson(graphFixture()))))).toBe(true);
 expect(json(saved,'session-manifest')[0].sessions[0]).toMatchObject({id:s.sessionId,coreRef:s.coreMetadataRef,plans:[{context:'runtime'}]});
 expect(json(saved,'session-index')[0].sessions[0].summary).toMatchObject({lifecycle:'active',scopes:[{lifecycle:'registered'}]});
 expect(Buffer.concat(saved.map(x=>x.bytes)).includes(r.capability)).toBe(false);
 expect(json(saved,'operation-result')[0].capabilityDigest).toBe(ownedSha256(r.capability));
});
it('blocks reads, other commands and provisioning until the action reservation is checkpointed',async()=>{
 let armed=false,release!:()=>void,hit!:()=>void;const wait=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>hit=r);
 const f=await setup(async p=>{if(armed&&p==='before-checkpoint'){hit();await wait;}}),r=await register(f,await active(f));
 armed=true;let ack=false;const request=action(f,r),pending=f.model.dispatchDurable(r.broker,request).then(reply=>{ack=true;return reply;});await reached;
 expect(ack).toBe(false);expect(()=>f.model.inspect(f.reader,r.sessionId)).toThrow('busy');expect(()=>f.model.principal('reader')).toThrow('busy');
 await expect(f.model.dispatchDurable(r.broker,request)).rejects.toThrow('busy');
 release();const reply=await pending;expect(ack).toBe(true);expect(reply.lifecycle).toBe('executing');
 const records=await f.journal.readLatest();expect(json(records,'action-reservation')).toMatchObject([{sessionId:r.sessionId,consumed:true,witnessId:r.witnessId}]);
 const rev=f.journal.head.revision;expect(await f.model.dispatchDurable(r.broker,request)).toMatchObject({...reply,historical:true});expect(f.journal.head.revision).toBe(rev);
 await expect(call(f,r.broker,{...request,operationId:'second-start',expectedRevision:reply.revision,sequence:2,previousDigest:reply.ledgerHead})).rejects.toThrow('capability_invalid');
});
for(const phase of ['before-records','after-records','after-commit','before-checkpoint','after-checkpoint','before-ack'] as JournalFault[]){
 it('withholds action permission and stops the kernel after storage failure at '+phase,async()=>{
  let armed=false;const f=await setup(p=>{if(armed&&p===phase)throw Error('injected');}),r=await register(f,await active(f)),request=action(f,r);armed=true;
  let launch=0;await expect(f.model.dispatchDurable(r.broker,request).then(()=>{launch++;})).rejects.toThrow('injected');expect(launch).toBe(0);
  await expect(f.model.dispatchDurable(r.broker,request)).rejects.toThrow('recovery_required');expect(()=>f.model.principal('reader')).toThrow('recovery_required');
  armed=false;const recovered=await AuthorityJournal.open({...identity,key:Buffer.alloc(32,3),io:f.io,checkpoint:f.checkpoint});
  expect(recovered.backendEligible).toBe(false);expect(()=>new OwnedAuthorityContract({...f.config,journal:recovered})).toThrow('restart_unsupported');
 });
}
it('stores a full G0 seal terminal with its metadata and ledger',async()=>{
 const f=await setup(),s=await active(f);let r=await register(f,s);r={...r,...await f.model.dispatchDurable(r.broker,action(f,r))};
 const fixture=ownedExecutionCase('completed','offer'),doc=fixture.doc;doc.coreGraph=graphFixture();doc.graphId=r.graphId;doc.exportId=r.exportId;
 rewriteOwned(doc,()=>true,v=>{for(const k of ['graphId','exportId','executionId']){if(v.binding)v.binding[k]=r[k];if(k in v)v[k]=r[k];}if(v.binding)v.binding.invocation=r.scope.invocation;if('invocation'in v)v.invocation=r.scope.invocation;if('witnessId'in v)v.witnessId=r.witnessId;if(v.binding)v.binding.coreGraphDigest=ownedDigest(graphFixture());if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(graphFixture());});
 doc.ownedOfferBundles[0].invocation=r.scope.invocation;
 const witness:any=fixture.witness;Object.assign(witness.binding,{authorityId:'caller',sessionId:r.sessionId,nonce:r.nonce,graphId:r.graphId,exportId:r.exportId,executionId:r.executionId,invocation:r.scope.invocation,coreGraphDigest:ownedDigest(graphFixture())});
 Object.assign(witness,{witnessId:r.witnessId,bundleDigest:doc.ownedOfferBundles[0].bundleRef.objectDigest,envelopeDigest:doc.ownedOfferBundles[0].envelopeRef.objectDigest});
 r={...r,...await call(f,r.observer,{operation:'append-event',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'execution-observation',lookup:{status:'verified',witness},leases:fixture.session.leases}})};
 const {coreGraph:_,...body}=doc;const projection={...body,coreMetadataRef:r.coreMetadataRef};projection.ownedOfferObjects.sort((a:any,b:any)=>a.objectDigest<b.objectDigest?-1:1);
 const ref=await upload(f,r.broker,r,'seal',projection,{scope:r.scope,witnessId:r.witnessId});
 r={...r,...await call(f,r.broker,{operation:'seal-scope',phase:'prepare',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead})};
 const terminal=await call(f,r.broker,{operation:'seal-scope',phase:'commit',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead,sealMetadataRef:ref,pair:{bundleDigest:witness.bundleDigest,envelopeDigest:witness.envelopeDigest}});
 expect(terminal.terminal).toMatchObject({outcome:'structure-verified'});
 const saved=await f.journal.readLatest();expect(json(saved,'terminal-record')[0].terminal).toEqual(terminal.terminal);expect(json(saved,'event-ledger')[0].events).toHaveLength(2);
 expect(json(saved,'session-index')[0].sessions[0].summary.lifecycle).toBe('committed');expect(json(saved,'session-index')[0].backendEligible).toBe(false);
});
for(const operation of ['abort','revoke'] as const)it('persists '+operation+' before returning its ack',async()=>{
 const f=await setup(),s=await active(f);await call(f,f.caller,{operation,sessionId:s.sessionId,expectedRevision:s.revision,reason:'operator-request'});
 expect(json(await f.journal.readLatest(),'session-index')[0].sessions[0].summary).toMatchObject({lifecycle:'closed',validity:operation==='abort'?'aborted':'revoked'});
});
it('persists expiry before rejecting a new operation and returns unavailable on lookup',async()=>{
 const f=await setup(),s=await active(f);f.advance(600000);
 await expect(register(f,s)).rejects.toThrow('not_current');
 expect(json(await f.journal.readLatest(),'session-index')[0].sessions[0].summary.validity).toBe('expired');
 expect(await call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope,expectedRevision:0})).toMatchObject({contractStatus:'session-unavailable',backendEligible:false});
});
it('does not expose a capability when expiry occurs during persistence',async()=>{
 let armed=false;let advance:(ms:number)=>void=()=>{};
 const f=await setup(p=>{if(armed&&p==='before-ack'){armed=false;advance(600000);}});advance=f.advance;const s=await active(f);armed=true;
 await expect(register(f,s)).rejects.toThrow('expired');
 expect(json(await f.journal.readLatest(),'session-index')[0].sessions[0].summary.validity).toBe('expired');
});
it('keeps logical rejection usable and rejects forged actors and accessor inputs without reading them',async()=>{
 const f=await setup();let reads=0;const bad={get operation(){reads++;return 'begin';}};
 await expect(f.model.dispatchDurable({},bad)).rejects.toThrow('permission_denied');
 await expect(f.model.dispatchDurable(f.caller,bad)).rejects.toThrow('schema_invalid');expect(reads).toBe(0);
 const input=begin(f),s=await f.model.dispatchDurable(f.caller,input);
 await expect(f.model.dispatchDurable(f.caller,{...input,consumerId:'different'})).rejects.toThrow('replay_conflict');
 expect(await f.model.dispatchDurable(f.caller,input)).toMatchObject({sessionId:s.sessionId,historical:true});
});

it('persists partial upload bytes and the frozen content exactly once',async()=>{
 const f=await setup(),s=await f.model.dispatchDurable(f.caller,begin(f)),core:any=graphFixture();core.inputs.files=Array.from({length:300},(_,i)=>({path:'f'+i+'/'+ 'x'.repeat(4000),sha256:ownedSha256('input')}));
 const bytes=Buffer.from(canonicalOwnedJson(core,16*1024*1024));let ref:any;
 for(let ordinal=0;ordinal<2;ordinal++){
  const chunk=bytes.subarray(ordinal*1024*1024,(ordinal+1)*1024*1024);
  const reply=await call(f,f.caller,{operation:'put-metadata-chunk',sessionId:s.sessionId,uploadId:s.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(chunk),base64:chunk.toString('base64')});
  const saved=await f.journal.readLatest(),index=json(saved,'session-index')[0].sessions[0].uploads[0];
  expect(index.state).toBe(ordinal===0?'open':'frozen');expect(index.received).toBe(ordinal===0?chunk.length:bytes.length);
  expect(Buffer.concat(saved.filter(r=>r.role==='metadata-snapshot').map(r=>r.bytes))).toEqual(ordinal===0?chunk:bytes);ref=reply.ref;
 }
 expect(ref.rawSha256).toBe(ownedSha256(bytes));
});
it('persists supersession and the new current slot in the same commit',async()=>{
 const f=await setup(),a=await active(f),b=await active(f,[scope],1),saved=json(await f.journal.readLatest(),'session-index')[0];
 expect(saved.sessions.find((s:any)=>s.summary.sessionId===a.sessionId).summary).toMatchObject({validity:'superseded',lifecycle:'closed'});
 expect(saved.sessions.find((s:any)=>s.summary.sessionId===b.sessionId).summary).toMatchObject({validity:'current',lifecycle:'active'});
 expect(saved.slots[0][1]).toMatchObject({revision:2,sessionId:b.sessionId});
});
it('preserves one scope terminal while another aborts and cancels its upload',async()=>{
 const f=await setup(),second={...scope,invocation:'second'},s=await active(f,[scope,second]);
 let a=await register(f,s);const b=await register(f,s,second);
 const done=await call(f,f.caller,{operation:'abort',sessionId:a.sessionId,scope,expectedRevision:a.revision,reason:'operator-request'});
 await call(f,f.caller,{operation:'abort',sessionId:b.sessionId,scope:second,expectedRevision:b.revision,reason:'operator-request'});
 const saved=await f.journal.readLatest();expect(json(saved,'terminal-record')).toHaveLength(2);
 expect(json(saved,'terminal-record').find((r:any)=>r.scope.invocation===scope.invocation).terminal).toEqual(done.terminal);
 const index=json(saved,'session-index')[0].sessions[0];expect(index.summary.lifecycle).toBe('committed');expect(index.uploads.filter((u:any)=>u.purpose==='seal').every((u:any)=>u.state==='cancelled')).toBe(true);
});
it('copies command data before async waits and saved records remain independent of reply mutation',async()=>{
 let armed=true,release!:()=>void,hit!:()=>void;const wait=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>hit=r);
 const f=await setup(async p=>{if(armed&&p==='before-records'){armed=false;hit();await wait;}}),input=begin(f),pending=f.model.dispatchDurable(f.caller,input);await reached;
 input.consumerId='changed';release();const reply=await pending;reply.sessionId='changed';
 expect(json(await f.journal.readLatest(),'session-manifest')[0].sessions[0].consumerId).toBe('consumer');
 expect(json(await f.journal.readLatest(),'operation-result')[0].sessionId).not.toBe('changed');
});
it('refuses to acknowledge a read or mutation when the checkpoint is unavailable',async()=>{
 const f=await setup(),s=await active(f);f.checkpoint.read=async()=>{throw Error('unavailable');};
 await expect(call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope,expectedRevision:0})).rejects.toThrow('checkpoint_unavailable');
 await expect(register(f,s)).rejects.toThrow('recovery_required');
});

it('stores an A1 action reservation through the real file adapter before returning permission',async()=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const {RootedJournalIO}=await import('../fixtures/gradleOwnedJournalFs.js');
 const {FileJournalCheckpoint}=await import('../fixtures/gradleOwnedJournalCheckpoint.js');
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'owned-a1-a2-')));
 let io:Awaited<ReturnType<typeof RootedJournalIO.open>>|undefined,anchor:Awaited<ReturnType<typeof RootedJournalIO.open>>|undefined;
 try{
  await fs.mkdir(path.join(base,'store'),{mode:0o700});await fs.mkdir(path.join(base,'anchor'),{mode:0o700});
  io=await RootedJournalIO.open({root:path.join(base,'store')});anchor=await RootedJournalIO.open({root:path.join(base,'anchor')});
  const checkpoint=new FileJournalCheckpoint({identity,keyId:'anchor',key:Buffer.alloc(32,9),io:anchor});await checkpoint.initialize();
  const journal=await AuthorityJournal.create({...identity,key:Buffer.alloc(32,3),io,checkpoint});
  const seed=await setup(),model=new OwnedAuthorityContract({...seed.config,journal});const f={...seed,model,journal,caller:model.principal('caller'),reader:model.principal('reader')};
  const r=await register(f,await active(f));await model.dispatchDurable(r.broker,action(f,r));
  const reopened=await AuthorityJournal.open({...identity,key:Buffer.alloc(32,3),io,checkpoint});
  expect(json(await reopened.readLatest(),'action-reservation')[0]).toMatchObject({sessionId:r.sessionId,consumed:true});
  expect((await checkpoint.read()).revision).toBe(journal.head.revision);
  expect(io.metrics.filesSynced).toBeGreaterThan(0);expect(anchor.metrics.directoriesSynced).toBeGreaterThan(0);
 }finally{io?.close();anchor?.close();await fs.rm(base,{recursive:true,force:true});}
});
it('refuses a chunk ack when asynchronous persistence exceeds the chunk deadline',async()=>{
 let armed=false;let advance:(ms:number)=>void=()=>{};const f=await setup(p=>{if(armed&&p==='before-ack'){armed=false;advance(5001);}});advance=f.advance;
 const s=await f.model.dispatchDurable(f.caller,begin(f));armed=true;
 await expect(upload(f,f.caller,s,'core',graphFixture())).rejects.toThrow('deadline_exceeded');
 expect(json(await f.journal.readLatest(),'session-index')[0].sessions[0].uploads[0].state).toBe('frozen');
});

it('rechecks the target after another session expiry is saved asynchronously',async()=>{
 let armed=false,hits=0;let advance:(ms:number)=>void=()=>{};
 const f=await setup(p=>{if(armed&&p==='before-ack'){hits++;advance(hits===1?10:20);}});advance=f.advance;
 await f.model.dispatchDurable(f.caller,begin(f));f.advance(10);const s=await active(f);f.advance(599980);armed=true;
 await expect(register(f,s)).rejects.toThrow('expired');
 const sessions=json(await f.journal.readLatest(),'session-index')[0].sessions;
 expect(sessions.every((s:any)=>s.summary.validity==='expired')).toBe(true);expect(hits).toBe(3);
});
