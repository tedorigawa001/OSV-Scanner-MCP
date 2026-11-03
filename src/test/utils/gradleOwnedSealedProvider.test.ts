import {afterEach,expect,it} from 'vitest';
import {mkdtemp,realpath,mkdir,rm,writeFile,readFile,readdir,rename,symlink,link} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import path from 'node:path';import os from 'node:os';
import {OwnedJournalDisk} from '../fixtures/gradleOwnedJournalDisk.js';
import {RootedJournalIO,type DiskOptions} from '../fixtures/gradleOwnedJournalFs.js';
import {SealedPrefixStore,type SealedStoreOptions} from '../fixtures/gradleOwnedSealedProvider.js';
import {ownedDigest,ownedSha256,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {v2StateSummary,v2Genesis,sealV2Commit,replayV2,type V2ReplayInput} from '../fixtures/gradleOwnedJournalV2.js';
import type {JournalFault} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {PrefixAdmissionFixture,SealedPrefixCoordinator} from '../fixtures/gradleOwnedSealedCoordinator.js';
const hash=(v:string)=>ownedSha256(v),binding={authorityId:'authority',lineageId:'lineage',storeEpoch:hash('epoch'),generation:1,profileDigest:hash('profile')};
const key=Buffer.alloc(32,13),baseRef={role:'compacted-base' as const,id:'base',sha256:hash('base'),byteLength:4};
function source():V2ReplayInput{
 const records=['session-manifest','session-index','event-ledger','operation-result'].map(role=>({key:{role:role as 'session-manifest',id:role==='event-ledger'?'scope':'root'},bytes:Buffer.from(role)}));
 const summary=v2StateSummary(records),genesis=v2Genesis(binding,baseRef),body={schema:'osv-mcp.gradle-owned-journal-commit-v2',schemaVersion:2,layout:'typed-flat-map-v1',...binding,baseRef,revision:1,previousCommit:genesis,fromStateRoot:genesis,...summary.roots,usage:summary.usage,operation:{id:'op1',requestDigest:hash('op1'),resultRef:summary.records.find(r=>r.key.role==='operation-result')!.ref},recordMode:'full',records:summary.records};
 const commit=sealV2Commit(body,'source-key',key);
 return {binding,baseRef,keyId:'source-key',key:Buffer.from(key),approvedBaseDigest:hashBytes(commit),checkpoint:{revision:1,commitDigest:hashBytes(commit)},commits:[commit],payloads:records.map(r=>r.bytes)};
}
const hashBytes=(v:Buffer)=>ownedSha256(v);
const roots:string[]=[],ios:RootedJournalIO[]=[],disks:OwnedJournalDisk[]=[];
afterEach(async()=>{for(const io of ios.splice(0))io.close();for(const disk of disks.splice(0))disk.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'q2b-seal-')));roots.push(root);
 const data=source();for(const name of ['control','checkpoint','ns1'])await mkdir(path.join(root,name),{mode:0o700});
 const hooks:{namespace?:DiskOptions['fault'];checkpoint?:DiskOptions['fault'];provider?:SealedStoreOptions['fault'];journal?:(phase:JournalFault)=>void|Promise<void>}={};
 const options={authorityId:'provider-control',storeEpoch:hash('control'),keyId:'control-key',key:Buffer.alloc(32,21),checkpointKeyId:'checkpoint-key',checkpointKey:Buffer.alloc(32,22),store:{root:path.join(root,'control')},checkpoint:{root:path.join(root,'checkpoint'),fault:(...args:Parameters<NonNullable<DiskOptions['fault']>>)=>hooks.checkpoint?.(...args)},fault:(phase:JournalFault)=>hooks.journal?.(phase)};
 const disk=await OwnedJournalDisk.open({...options,mode:'create'});disks.push(disk);
 const io=await RootedJournalIO.open({root:path.join(root,'ns1'),exclusive:true,fault:(...args)=>hooks.namespace?.(...args)});ios.push(io);
 const config={control:disk,contextDigest:ownedDigest({binding,base: data.approvedBaseDigest}),sealKeyId:'seal-key',sealKey:Buffer.alloc(32,23),sourceKey:Buffer.from(key),fault:(...args:Parameters<NonNullable<SealedStoreOptions['fault']>>)=>hooks.provider?.(...args)};
 const store=await SealedPrefixStore.open(config);
 return {root,data,options,disk,io,config,store,hooks};
}
it('durably seals a fresh namespace before selecting it, preserving copied source bytes',async()=>{
 const f=await setup(),candidate=await f.store.prepare(f.io,f.data);
 expect(f.store.view().selected).toBeNull();
 const selected=await f.store.select(candidate);
 expect(selected.generation).toBe(1);expect(selected.fence).toBe(1);
 const actual=await f.store.readSelected();expect(actual.input.commits).toEqual(f.data.commits);
 expect(actual.backendEligible).toBe(false);expect(actual.originalReadsSkipped).toBe(0);
});
async function selected(){const f=await setup(),candidate=await f.store.prepare(f.io,f.data);await f.store.select(candidate);return {...f,candidate};}
it('does not retain mutable caller inputs, results or candidate identifiers as authority',async()=>{
 const f=await setup(),original=f.data.commits.map(b=>Buffer.from(b)),pending=f.store.prepare(f.io,f.data);
 f.data.commits[0]!.fill(0);f.data.payloads[0]!.fill(0);const candidate=await pending;
 await expect(f.store.select({kind:'sealed-namespace-candidate'})).rejects.toThrow('fence_invalid');
 await f.store.select(candidate);const first=await f.store.readSelected();first.input.commits[0]!.fill(0);
 expect((await f.store.readSelected()).input.commits).toEqual(original);
});
it('rejects a dirty root before reserving or writing a namespace',async()=>{
 const f=await setup();await writeFile(path.join(f.root,'ns1','unknown'),'keep',{mode:0o600});
 await expect(f.store.prepare(f.io,f.data)).rejects.toThrow('root_not_empty');
 expect(f.store.view().ledger.lastGeneration).toBe(0);expect(await readFile(path.join(f.root,'ns1','unknown'),'utf8')).toBe('keep');
});
it.each(['unknown','pending','modify','remove','symlink','hardlink','root-swap'])('quarantines a generation changed during sealing: %s',async fault=>{
 const f=await setup();f.hooks.provider=async phase=>{if(phase!=='after-inventory')return;const root=path.join(f.root,'ns1'),commit=path.join(root,'commit-00000001.json');
  if(fault==='unknown')await writeFile(path.join(root,'unknown'),'bad',{mode:0o600});
  if(fault==='pending')await writeFile(path.join(root,'pending-'+hash('temp')+'.tmp'),'tail',{mode:0o600});
  if(fault==='modify')await writeFile(commit,'changed',{mode:0o600});if(fault==='remove')await rm(commit);
  if(fault==='symlink'){await rm(commit);await symlink(path.join(f.root,'control','journal.meta'),commit);}
  if(fault==='hardlink')await link(commit,path.join(f.root,'external-link'));
  if(fault==='root-swap'){await rename(root,root+'-old');await mkdir(root,{mode:0o700});}
 };
 await expect(f.store.prepare(f.io,f.data)).rejects.toThrow();
 expect(f.store.view().ledger.namespaces[0]!.phase).toBe('quarantined');expect(f.store.view().selected).toBeNull();
 await expect(f.store.readSelected()).rejects.toThrow('recovery_required');
});
it.each(['before-create','after-create','after-write','after-file-sync','after-publish','before-directory-sync','after-directory-sync'] as const)('withholds a seal on marker storage failure at %s',async target=>{
 const f=await setup();f.hooks.namespace=(phase,name)=>{if(phase===target&&name==='journal.meta')throw Error('injected-marker-sync-failure');};
 await expect(f.store.prepare(f.io,f.data)).rejects.toThrow();
 expect(f.store.view().selected).toBeNull();expect(f.store.view().ledger.namespaces[0]!.phase).toBe('quarantined');
});
it('rejects marker changes after durable publication but before capture',async()=>{
 const f=await setup();f.hooks.provider=async phase=>{if(phase==='after-marker')await writeFile(path.join(f.root,'ns1','journal.meta'),'forged',{mode:0o600});};
 await expect(f.store.prepare(f.io,f.data)).rejects.toThrow('content_mismatch');expect(f.store.view().selected).toBeNull();
});
it('recovers the selected view with full replay, re-sync and a new boot; old candidates remain unusable',async()=>{
 const f=await selected(),before=f.store.view();f.store.close();const reopened=await SealedPrefixStore.open({...f.config,selectedIO:f.io});
 expect(reopened.view().boot).not.toBe(before.boot);expect(reopened.view().ledger).toEqual(before.ledger);
 expect((await reopened.readSelected()).input.commits).toEqual(f.data.commits);expect(reopened.view().metrics.recoveries).toBe(1);
 await expect(reopened.select(f.candidate)).rejects.toThrow('fence_invalid');
});
it('keeps an unfinished reservation and quota charged after restart and requires a fresh root',async()=>{
 const f=await setup();f.hooks.provider=phase=>{if(phase==='after-reservation')throw Error('owner-death');};
 await expect(f.store.prepare(f.io,f.data)).rejects.toThrow('owner-death');const reservation=f.store.view().ledger.namespaces[0]!;f.hooks.provider=undefined;
 const reopened=await SealedPrefixStore.open(f.config);expect(reopened.view().ledger.namespaces[0]).toMatchObject({phase:'quarantined',reservedBytes:reservation.reservedBytes});
 await expect(reopened.prepare(f.io,f.data)).rejects.toThrow('root_reused');
 const next=await SealedPrefixStore.open(f.config);await mkdir(path.join(f.root,'ns2'),{mode:0o700});const io=await RootedJournalIO.open({root:path.join(f.root,'ns2'),exclusive:true});ios.push(io);
 const candidate=await next.prepare(io,f.data);expect((await next.select(candidate)).generation).toBe(2);
});
it.each(['unknown','content','marker'])('fails closed on selected-view %s corruption instead of treating it as a cache miss',async fault=>{
 const f=await selected(),dir=path.join(f.root,'ns1');
 await writeFile(path.join(dir,fault==='unknown'?'extra':fault==='marker'?'journal.meta':'commit-00000001.json'),'changed',{mode:0o600});
 await expect(f.store.readSelected()).rejects.toThrow();await expect(f.store.readSelected()).rejects.toThrow('recovery_required');
});
it('rejects a cloned namespace even when every saved byte matches',async()=>{
 const f=await selected();await mkdir(path.join(f.root,'clone'),{mode:0o700});
 for(const name of await readdir(path.join(f.root,'ns1')))await writeFile(path.join(f.root,'clone',name),await readFile(path.join(f.root,'ns1',name)),{mode:0o600});
 const io=await RootedJournalIO.open({root:path.join(f.root,'clone'),exclusive:true});ios.push(io);
 await expect(SealedPrefixStore.open({...f.config,selectedIO:io})).rejects.toThrow('root_changed');
});
function prefixIdentity(data:V2ReplayInput){return {...binding,providerId:'provider',providerBootId:'untrusted-config-boot',storeRootId:'source',checkpointRootId:'checkpoint',rootPairId:'pair',storageInstanceId:'instance',namespaceGeneration:1,fence:1,baseDigest:data.approvedBaseDigest,format:'v2-flat-contract' as const,schemaDigest:hash('schema'),parserDigest:hash('parser'),providerProfileDigest:hash('provider-profile'),policyDigest:hash('policy'),registryRevision:1,checkpointIssuer:'issuer',checkpointKeyEpoch:1,providerKeyEpoch:1,proofMode:'record' as const};}
async function coordinated(limits?:SealedStoreOptions['limits']){
 const g=await selected(),f=limits?{...g,store:await SealedPrefixStore.open({...g.config,limits,selectedIO:g.io})}:g,registry=new PrefixAdmissionFixture();
 registry.stage((await f.store.readSelected()).markerDigest);registry.initialize((await f.store.readSelected()).markerDigest);
 let now=0;const coordinator=await SealedPrefixCoordinator.open({store:f.store,registry,identity:prefixIdentity(f.data),keyId:'provider-key',key:Buffer.alloc(32,29),providerNow:()=>now,readerNow:()=>now});
 const reader=coordinator.reader({peerId:'reader',bootId:'reader-boot'});return {...f,registry,coordinator,reader,tick:(n:number)=>now+=n};
}
it('holds a disk-backed read pin through Complete decision and delivery until explicit release',async()=>{
 const f=await coordinated(),request=await f.coordinator.begin(f.reader,hash('request')),
  ticket=await f.coordinator.accept(f.reader,await f.coordinator.acquire(f.reader,request)),candidate=await f.coordinator.verify(f.reader,ticket),
  complete=await f.coordinator.startComplete(f.reader,candidate),receipt=await f.coordinator.decide(f.reader,complete),delivery=await f.coordinator.deliver(f.reader,receipt);
 expect(f.coordinator.metrics.livePins).toBe(1);expect((await f.coordinator.publish(f.reader,delivery)).backendEligible).toBe(false);
 expect(f.coordinator.metrics.livePins).toBe(1);await f.coordinator.release(f.reader,delivery);expect(f.coordinator.metrics.livePins).toBe(0);
});
function append(input:V2ReplayInput):V2ReplayInput{
 const old=replayV2(input),revision=old.revision+1,bytes=Buffer.from('result-'+revision),records=old.records.map(r=>r.key.role==='operation-result'?{...r,bytes}:r),summary=v2StateSummary(records),previous=JSON.parse(input.commits.at(-1)!.toString()).body;
 const next=sealV2Commit({...previous,revision,previousCommit:old.commitDigest,fromStateRoot:old.stateRoot,...summary.roots,usage:summary.usage,records:summary.records,
  operation:{id:'op'+revision,requestDigest:hash('op'+revision),resultRef:summary.records.find(r=>r.key.role==='operation-result')!.ref}},input.keyId,input.key);
 return {...input,commits:[...input.commits,next],payloads:[...input.payloads,bytes],checkpoint:{revision,commitDigest:hashBytes(next)}};
}
async function nextCandidate(f:Awaited<ReturnType<typeof selected>>,name='ns2'){
 await mkdir(path.join(f.root,name),{mode:0o700});const io=await RootedJournalIO.open({root:path.join(f.root,name),exclusive:true});ios.push(io);
 const candidate=await f.store.prepare(io,append(f.data));return {io,candidate,descriptor:f.store.describeCandidate(candidate)};
}
async function use(f:Awaited<ReturnType<typeof coordinated>>,phase:'active'|'completing'|'decision-recorded'|'delivering'='active'){
 const request=await f.coordinator.begin(f.reader,hash('request')),wire=await f.coordinator.acquire(f.reader,request),ticket=await f.coordinator.accept(f.reader,wire),candidate=await f.coordinator.verify(f.reader,ticket);
 const complete=phase==='active'?undefined:await f.coordinator.startComplete(f.reader,candidate),receipt=(phase==='decision-recorded'||phase==='delivering')?await f.coordinator.decide(f.reader,complete!):undefined,
 delivery=phase==='delivering'?await f.coordinator.deliver(f.reader,receipt!):undefined;
 return {request,wire,ticket,candidate,complete,receipt,delivery};
}
it.each(['active','completing','decision-recorded','delivering'] as const)('keeps the selected inventory unchanged and the writer fenced while a pin is %s',async phase=>{
 const f=await coordinated(),next=await nextCandidate(f);f.registry.stage(next.descriptor.markerDigest);const current=f.store.view().selected;
 const s=await use(f,phase);await expect(f.coordinator.publishSnapshot(next.candidate)).rejects.toThrow('pins_active');expect(f.store.view().selected).toBe(current);
 const complete=s.complete??await f.coordinator.startComplete(f.reader,s.candidate),receipt=s.receipt??await f.coordinator.decide(f.reader,complete),delivery=s.delivery??await f.coordinator.deliver(f.reader,receipt);
 await f.coordinator.publish(f.reader,delivery);await expect(f.coordinator.publishSnapshot(next.candidate)).rejects.toThrow('pins_active');
 await f.coordinator.release(f.reader,delivery);expect((await f.coordinator.publishSnapshot(next.candidate)).generation).toBe(2);
 expect(f.store.view().ledger.namespaces.map(n=>n.phase)).toEqual(['retired','sealed']);
});
it.each(['freeze','cutover','gc','revoke'] as const)('orders %s before late Complete/handoff and never authorizes physical deletion',async reason=>{
 const f=await coordinated(),s=await use(f,'decision-recorded');f.coordinator.freeze(reason);
 await expect(f.coordinator.deliver(f.reader,s.receipt!)).rejects.toThrow();expect(f.coordinator.metrics.livePins).toBe(0);
 expect(f.coordinator.finishBarrier()).toEqual({physicalDeletionAuthorized:false,backendEligible:false});
 const events=f.coordinator.events;expect(events.find(e=>e.event==='decision-recorded')!.sequence).toBeLessThan(events.find(e=>e.event===reason)!.sequence);
 expect(events.map(e=>e.sequence)).toEqual(events.map((_,i)=>i+1));
});
it('persists one Complete decision idempotently and keeps a replayed old release from freeing another use',async()=>{
 const f=await coordinated(),s=await use(f,'decision-recorded'),again=await f.coordinator.decide(f.reader,s.complete!);expect(again).toEqual(s.receipt);
 const delivery=await f.coordinator.deliver(f.reader,again);await f.coordinator.publish(f.reader,delivery);await f.coordinator.release(f.reader,delivery);
 const next=await use(f);await f.coordinator.release(f.reader,delivery);expect(f.coordinator.status(f.reader,next.ticket).phase).toBe('active');
 expect(f.store.view().ledger.uses).toHaveLength(1);const body=JSON.parse(again.toString()).body;
 expect(f.store.historicalUse(body.grantId,body.useId)).toMatchObject({historical:true,backendEligible:false});
});
it.each(['expiry','freeze','owner-close'] as const)('rechecks %s after the final decision persistence await without converting history into a live receipt',async fault=>{
 const f=await coordinated(),s=await use(f,'completing');
 f.hooks.journal=phase=>{if(phase==='before-ack'){if(fault==='expiry')f.tick(5000);if(fault==='freeze')f.coordinator.freeze('freeze');if(fault==='owner-close')f.coordinator.close();}};
 await expect(f.coordinator.decide(f.reader,s.complete!)).rejects.toThrow();expect(f.coordinator.metrics.published).toBe(0);
 expect(f.store.view().ledger.uses).toHaveLength(1);expect(f.coordinator.metrics.livePins).toBe(0);
});
it('retains an old proof after natural expiry but still replays and syncs the disk source for the next grant',async()=>{
 const f=await coordinated(),s=await use(f,'delivering');await f.coordinator.publish(f.reader,s.delivery!);await f.coordinator.release(f.reader,s.delivery!);
 const expired=await use(f);f.tick(5000);await expect(f.coordinator.startComplete(f.reader,expired.candidate)).rejects.toThrow('grant_expired');
 const before=f.store.view().metrics.fullVerifications,fresh=await use(f,'delivering'),result=await f.coordinator.publish(f.reader,fresh.delivery!);
 expect(result.wouldReusePrefix).toBe(true);expect(result.originalReadsSkipped).toBe(0);expect(f.store.view().metrics.fullVerifications).toBeGreaterThan(before);
});
it('cancels disconnects and rejects old Complete and reader handles after a new provider boot',async()=>{
 const f=await coordinated(),s=await use(f,'completing');f.coordinator.disconnect(f.reader);await expect(f.coordinator.decide(f.reader,s.complete!)).rejects.toThrow();
 f.coordinator.close();f.store.close();const store=await SealedPrefixStore.open({...f.config,selectedIO:f.io}),coordinator=await SealedPrefixCoordinator.open({store,registry:f.registry,identity:prefixIdentity(f.data),keyId:'provider-key',key:Buffer.alloc(32,29),providerNow:()=>0,readerNow:()=>0});
 await expect(coordinator.accept(f.reader,s.wire)).rejects.toThrow('permission_denied');const reader=coordinator.reader({peerId:'reader',bootId:'reader-boot'});
 await expect(coordinator.decide(reader,s.complete!)).rejects.toThrow('binding_mismatch');expect(coordinator.metrics.published).toBe(0);
});
it('fails admission when no registry exists, and does not turn fixture admission into independent registry evidence',async()=>{
 const f=await selected();await expect(SealedPrefixCoordinator.open({store:f.store,identity:prefixIdentity(f.data),keyId:'provider-key',key:Buffer.alloc(32,29),providerNow:()=>0,readerNow:()=>0})).rejects.toThrow('control_unavailable');
 const registry=new PrefixAdmissionFixture();expect(registry.evidence.independentRegistryVerified).toBe(false);
});
it('stops a warm reader when fixture currentness becomes unavailable',async()=>{
 const f=await coordinated(),s=await use(f,'delivering');await f.coordinator.publish(f.reader,s.delivery!);await f.coordinator.release(f.reader,s.delivery!);f.registry.unavailable();
 await expect(f.coordinator.begin(f.reader,hash('new'))).rejects.toThrow('control_unavailable');expect(f.coordinator.metrics.originalReadsSkipped).toBe(0);
});
it('rejects an oversized wire before copying it or reading the selected disk source',async()=>{
 const f=await coordinated(),before=f.store.view().metrics.contentReadBytes;
 expect(()=>f.coordinator.acquire(f.reader,Buffer.alloc(1024*1024+1))).toThrow('budget_exceeded');
 expect(f.store.view().metrics.contentReadBytes).toBe(before);
});
it('rejects an old writer from another boot and an obsolete expected head without selecting its view',async()=>{
 const f=await selected(),a=await nextCandidate(f,'ns2'),b=await nextCandidate(f,'ns3');await f.store.select(a.candidate);
 const before=f.store.view().selected;await expect(f.store.select(b.candidate)).rejects.toThrow('fence_invalid');expect(f.store.view().selected).toBe(before);
 const reopened=await SealedPrefixStore.open({...f.config,selectedIO:a.io});await expect(reopened.select(a.candidate)).rejects.toThrow('fence_invalid');
});
it('does not hide damage to the old selected view during the final selection await',async()=>{
 const f=await selected(),next=await nextCandidate(f),before=f.store.view().selected;
 f.hooks.provider=async phase=>{if(phase==='before-select')await writeFile(path.join(f.root,'ns1','commit-00000001.json'),'damaged',{mode:0o600});};
 await expect(f.store.select(next.candidate)).rejects.toThrow();expect(f.store.view().selected).toBe(before);
});
it('keeps a freeze barrier unfinished while an earlier durable decision is still in flight',async()=>{
 const f=await coordinated(),s=await use(f,'completing');let premature=false;
 f.hooks.journal=phase=>{if(phase==='before-ack'){f.coordinator.freeze('freeze');try{f.coordinator.finishBarrier();premature=true;}catch{ /* must remain draining */ }}};
 await expect(f.coordinator.decide(f.reader,s.complete!)).rejects.toThrow();expect(premature).toBe(false);
 expect(f.coordinator.finishBarrier().physicalDeletionAuthorized).toBe(false);
});
it('stops bounded inventory enumeration at the limit plus one before a reservation or write',async()=>{
 const f=await setup();await Promise.all(Array.from({length:520},(_,i)=>writeFile(path.join(f.root,'ns1','unknown-'+i),'x',{mode:0o600})));
 const before=f.io.metrics.entriesEnumerated;await expect(f.store.prepare(f.io,f.data)).rejects.toThrow('root_not_empty');
 expect(f.io.metrics.entriesEnumerated-before).toBe(513);expect(f.io.metrics.bytesWritten).toBe(0);expect(f.store.view().ledger.lastGeneration).toBe(0);
});
it('counts unselected and quarantined reservations against a persistent namespace quota',async()=>{
 const f=await setup(),store=await SealedPrefixStore.open({...f.config,limits:{namespaces:1}});await store.prepare(f.io,f.data);
 const reopened=await SealedPrefixStore.open({...f.config,limits:{namespaces:1}});await mkdir(path.join(f.root,'ns2'),{mode:0o700});const io=await RootedJournalIO.open({root:path.join(f.root,'ns2'),exclusive:true});ios.push(io);
 await expect(reopened.prepare(io,f.data)).rejects.toThrow('budget_exceeded');expect(await readdir(path.join(f.root,'ns2'))).toHaveLength(0);
});
it('refuses a byte quota before creating any namespace file and does not forget failed reservations',async()=>{
 const f=await setup(),store=await SealedPrefixStore.open({...f.config,limits:{retainedBytes:1}});
 await expect(store.prepare(f.io,f.data)).rejects.toThrow('budget_exceeded');expect(f.io.metrics.bytesWritten).toBe(0);expect(store.view().ledger.namespaces).toHaveLength(0);
});
it('fails closed on checkpoint publication failure and refuses reopen/retry until directory re-sync succeeds',async()=>{
 const f=await selected();await mkdir(path.join(f.root,'ns2'),{mode:0o700});const io=await RootedJournalIO.open({root:path.join(f.root,'ns2'),exclusive:true});ios.push(io);
 const target='checkpoint-'+String(f.disk.journal.head.revision+1).padStart(8,'0')+'.json';let published=false;
 f.hooks.checkpoint=(phase,name)=>{if(name===target&&phase==='after-publish'){published=true;throw Error('published-not-synced');}};
 await expect(f.store.prepare(io,append(f.data))).rejects.toThrow('checkpoint_unavailable');expect(published).toBe(true);expect(io.metrics.bytesWritten).toBe(0);f.disk.close();
 f.hooks.checkpoint=(phase,name)=>{if(name===target&&phase==='before-directory-sync')throw Error('still-not-synced');};
 for(let retry=0;retry<2;retry++)await expect(OwnedJournalDisk.open({...f.options,mode:'open'})).rejects.toThrow();
 f.hooks.checkpoint=undefined;const disk=await OwnedJournalDisk.open({...f.options,mode:'open'});disks.push(disk);
 const recovered=await SealedPrefixStore.open({...f.config,control:disk,selectedIO:f.io});expect(recovered.view().ledger.namespaces[1]!.phase).toBe('quarantined');
 expect((await recovered.readSelected()).input.checkpoint.revision).toBe(1);
});
it('detects a rolled-back control history against the newer separate checkpoint',async()=>{
 const f=await selected(),control=path.join(f.root,'control'),saved=new Map<string,Buffer>();for(const name of await readdir(control))saved.set(name,await readFile(path.join(control,name)));
 const next=await nextCandidate(f);await f.store.select(next.candidate);f.store.close();f.disk.close();
 for(const name of await readdir(control))await rm(path.join(control,name));for(const [name,bytes]of saved)await writeFile(path.join(control,name),bytes,{mode:0o600});
 await expect(OwnedJournalDisk.open({...f.options,mode:'open'})).rejects.toThrow('rollback_detected');
});
it('does not replay a durable historical decision as a fresh use after restart',async()=>{
 const f=await coordinated(),s=await use(f,'decision-recorded'),body=JSON.parse(s.receipt!.toString()).body;
 f.coordinator.close();f.store.close();const store=await SealedPrefixStore.open({...f.config,selectedIO:f.io});
 expect(store.historicalUse(body.grantId,body.useId)).toMatchObject({historical:true,receiptDigest:hashBytes(s.receipt!)});
 const coordinator=await SealedPrefixCoordinator.open({store,registry:f.registry,identity:prefixIdentity(f.data),keyId:'provider-key',key:Buffer.alloc(32,29),providerNow:()=>0,readerNow:()=>0}),reader=coordinator.reader({peerId:'reader',bootId:'reader-boot'});
 await expect(coordinator.deliver(reader,s.receipt!)).rejects.toThrow();expect(coordinator.metrics.published).toBe(0);
});
async function compileChild(root:string){
 await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module'}));
 const project=path.join(root,'tsconfig.json');await writeFile(project,JSON.stringify({extends:path.resolve('tsconfig.json'),compilerOptions:{rootDir:process.cwd(),outDir:path.join(root,'modules'),noEmit:false},include:[path.resolve('src/test/fixtures/gradleOwnedSealedProvider.ts')],exclude:[]}));
 await new Promise<void>((resolve,reject)=>execFile(path.resolve('node_modules/.bin/tsc'),['-p',project],{timeout:20000},(error,out,err)=>error?reject(Error(out+err)):resolve()));
 return './modules/src/test/fixtures/';
}
it.each(['after-reservation','after-selection'] as const)('recovers after an actual SIGKILL at %s without reusing the old boot or reopening a generation',async target=>{
 const f=await setup(),prefix=await compileChild(f.root),before=f.store.view().boot;
 f.store.close();f.disk.close();f.io.close();
 const options={authorityId:f.options.authorityId,storeEpoch:f.options.storeEpoch,keyId:f.options.keyId,checkpointKeyId:f.options.checkpointKeyId,
  store:{root:f.options.store.root},checkpoint:{root:f.options.checkpoint.root}};
 const input={...f.data,key:undefined,commits:f.data.commits.map(b=>b.toString('base64')),payloads:f.data.payloads.map(b=>b.toString('base64'))};
 const script=`import {writeSync} from 'node:fs';import {OwnedJournalDisk} from '${prefix}gradleOwnedJournalDisk.js';import {RootedJournalIO} from '${prefix}gradleOwnedJournalFs.js';import {SealedPrefixStore} from '${prefix}gradleOwnedSealedProvider.js';
 const disk=await OwnedJournalDisk.open({...${JSON.stringify(options)},key:Buffer.alloc(32,21),checkpointKey:Buffer.alloc(32,22),mode:'open'});
 const io=await RootedJournalIO.open({root:${JSON.stringify(path.join(f.root,'ns1'))},exclusive:true});
 const store=await SealedPrefixStore.open({control:disk,contextDigest:${JSON.stringify(f.config.contextDigest)},sealKeyId:'seal-key',sealKey:Buffer.alloc(32,23),sourceKey:Buffer.alloc(32,13),fault:phase=>{if(phase===${JSON.stringify(target)}){writeSync(1,JSON.stringify({phase,boot:store.view().boot}));process.kill(process.pid,'SIGKILL');}}});
 const raw=${JSON.stringify(input)};raw.key=Buffer.alloc(32,13);raw.commits=raw.commits.map(b=>Buffer.from(b,'base64'));raw.payloads=raw.payloads.map(b=>Buffer.from(b,'base64'));
 const candidate=await store.prepare(io,raw);await store.select(candidate);process.exit(99);`;
 const child=path.join(f.root,'owner.mjs');await writeFile(child,script);
 const exit=await new Promise<{signal?:string|null;message?:string;stdout:string}>(resolve=>execFile(process.execPath,[child],{cwd:f.root,timeout:20000},(error,stdout)=>resolve({...error,stdout})));
 expect(exit.signal,exit.message).toBe('SIGKILL');const witness=JSON.parse(exit.stdout);expect(witness.phase).toBe(target);expect(witness.boot).toMatch(/^[a-f0-9]{64}$/);expect(witness.boot).not.toBe(before);
 const disk=await OwnedJournalDisk.open({...f.options,mode:'open'});disks.push(disk);
 const io=await RootedJournalIO.open({root:path.join(f.root,'ns1'),exclusive:true});ios.push(io);
 const store=await SealedPrefixStore.open({...f.config,control:disk,...(target==='after-selection'?{selectedIO:io}:{})});
 expect(store.view().boot).not.toBe(before);expect(store.view().boot).not.toBe(witness.boot);expect(store.view().ledger.lastGeneration).toBe(1);
 if(target==='after-reservation'){expect(store.view().ledger.namespaces[0]!.phase).toBe('quarantined');expect(store.view().selected).toBeNull();}
 else {expect((await store.readSelected()).input.commits).toEqual(f.data.commits);expect(store.view().metrics.recoveries).toBe(1);}
},30000);
it('keeps the owner usable after a dirty-root refusal that wrote nothing',async()=>{
 const f=await setup();await writeFile(path.join(f.root,'ns1','unknown'),'keep',{mode:0o600});
 await expect(f.store.prepare(f.io,f.data)).rejects.toThrow('root_not_empty');await rm(path.join(f.root,'ns1','unknown'));
 expect(f.store.view().phase).toBe('diagnostic-only');expect((await f.store.select(await f.store.prepare(f.io,f.data))).generation).toBe(1);
});
it('keeps the owner usable after quota and missing-snapshot refusals',async()=>{
 const f=await setup(),store=await SealedPrefixStore.open({...f.config,limits:{retainedBytes:1}});
 await expect(store.readSelected()).rejects.toThrow('snapshot_missing');await expect(store.prepare(f.io,f.data)).rejects.toThrow('budget_exceeded');
 expect(store.view().phase).toBe('diagnostic-only');await expect(store.readSelected()).rejects.toThrow('snapshot_missing');
});
it('refuses a stale candidate before writing to it and keeps serving the selected snapshot',async()=>{
 const f=await selected(),a=await nextCandidate(f),b=await nextCandidate(f,'ns3');await f.store.select(a.candidate);
 const written=b.io.metrics.bytesWritten;await expect(f.store.select(b.candidate)).rejects.toThrow('fence_invalid');
 expect(b.io.metrics.bytesWritten).toBe(written);expect(f.store.view().phase).toBe('diagnostic-only');expect((await f.store.readSelected()).marker.generation).toBe(2);
});
const fakeUse=(i:number)=>({grantId:hash('grant-'+i),useId:hash('use-'+i),receiptDigest:hash('receipt-'+i),completeDigest:hash('complete-'+i),readerDigest:hash('reader'),identityDigest:hash('identity')});
it('refuses a use beyond a narrowed ledger capacity without stopping the owner, while an idempotent retry still succeeds',async()=>{
 const g=await selected(),store=await SealedPrefixStore.open({...g.config,limits:{uses:2},selectedIO:g.io}),f={...g,store};
 for(let i=0;i<2;i++)await f.store.recordUse(fakeUse(i));
 expect(f.store.hasUseCapacity(hash('grant-2'))).toBe(false);expect(f.store.hasUseCapacity(hash('grant-0'))).toBe(true);
 await expect(f.store.recordUse(fakeUse(2))).rejects.toThrow('uses_exhausted');await f.store.recordUse(fakeUse(0));
 await expect(f.store.recordUse({...fakeUse(0),receiptDigest:hash('other')})).rejects.toThrow('use_conflict');
 expect(f.store.view().phase).toBe('diagnostic-only');expect((await f.store.readSelected()).marker.generation).toBe(1);
});
it('rejects a use capacity above the fixed 64-use ledger limit',async()=>{
 const f=await setup();await expect(SealedPrefixStore.open({...f.config,limits:{uses:65}})).rejects.toThrow('configuration_invalid');
});
it('refuses a new Complete decision at use capacity before recording it and keeps the coordinator serving',async()=>{
 const f=await coordinated({uses:2});for(let i=0;i<2;i++)await f.store.recordUse(fakeUse(i));
 const s=await use(f,'completing');await expect(f.coordinator.decide(f.reader,s.complete!)).rejects.toThrow('uses_exhausted');
 expect(f.coordinator.status(f.reader,s.ticket).phase).toBe('completing');expect(f.store.view().ledger.uses).toHaveLength(2);
 expect(()=>f.coordinator.reader({peerId:'second',bootId:'second-boot'})).not.toThrow();expect(f.store.view().phase).toBe('diagnostic-only');
});

it('binds the saved B2/B3 validation to the exercised source closure and keeps native isolation/adoption unestablished',async()=>{
 const record=JSON.parse(await readFile(path.resolve('docs/validation/gradle-q2b-b2-b3-storage-2026-11-03.json'),'utf8'));
 expect(record.schema).toBe('osv-mcp.q2b.b2-b3.validation.v1');expect(record.caseCount).toBe(59);expect(record.cases).toHaveLength(59);
 expect(new Set(record.cases.map((c:{name:string})=>c.name)).size).toBe(59);
 expect(record.cases.every((c:{status:string})=>c.status==='passed')).toBe(true);
 for(const source of record.sources)expect(hashBytes(await readFile(path.resolve(source.path)))).toBe(source.sha256);
 for(const pin of record.dependencies)expect(hashBytes(await readFile(path.resolve(pin.path)))).toBe(pin.sha256);
 expect(record.nativeProcessCases).toHaveLength(2);expect(record.nativeProcessCases.every((c:{signal:string;verified:boolean})=>c.signal==='SIGKILL'&&c.verified)).toBe(true);
 expect(record.scope).toBe('local-posix-storage-and-cooperative-pin-contract');
 expect(record.nativeIsolationVerified).toBe(false);expect(record.independentRegistryVerified).toBe(false);
 expect(record.backendEligible).toBe(false);expect(record.profileApproved).toBe(false);expect(record.originalReadsSkipped).toBe(0);
});
