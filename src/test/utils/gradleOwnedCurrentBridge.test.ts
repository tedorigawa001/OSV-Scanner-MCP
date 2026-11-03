import {afterEach,it,expect} from 'vitest';
import {mkdtemp,realpath,mkdir,rm,writeFile,readdir} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {generateKeyPairSync} from 'node:crypto';
import {OwnedCurrentDisk,type CurrentDiskOptions} from '../fixtures/gradleOwnedCurrentDisk.js';
import {CurrentControl} from '../fixtures/gradleOwnedCurrentControl.js';
import {currentRoles,type CurrentRole,type CurrentRef} from '../../utils/gradleOwnedCurrentSchema.js';
import {OwnedCurrentClient,type OwnedCurrentTransport} from '../../utils/gradleOwnedCurrentClient.js';
import {OwnedCurrentBridge,CurrentAuthorityVerifier,type CurrentProviderClient,type CurrentAuthorityClient} from '../../utils/gradleOwnedCurrentBridge.js';
import {SealedPrefixStore} from '../fixtures/gradleOwnedSealedProvider.js';
import {RootedJournalIO} from '../fixtures/gradleOwnedJournalFs.js';
import {OwnedJournalDisk} from '../fixtures/gradleOwnedJournalDisk.js';
import {currentAuthoritySource} from '../fixtures/gradleOwnedCurrentBridgeFixture.js';
import {extendCurrentSource} from '../fixtures/gradleOwnedCurrentSource.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256 as hash} from '../../utils/gradleOwnedJson.js';
import {createGradleBudget} from '../../utils/gradleGraph.js';
const observations:Record<string,unknown>={};
const roots:string[]=[],ios:RootedJournalIO[]=[],disks:OwnedJournalDisk[]=[],currentOwners:OwnedCurrentDisk[]=[];
afterEach(async()=>{for(const owner of currentOwners.splice(0))owner.close();for(const io of ios.splice(0))io.close();for(const d of disks.splice(0))d.close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(durable=false){
 const lockBytes=Buffer.from('g:a:1=runtimeClasspath\ng:b:2=runtimeClasspath\nempty=\n'),core=(await import('../fixtures/gradleGraphFixture.js')).graphFixture();core.lockfiles[0]!.sha256=hash(lockBytes);core.inputs.complete=true;
 const data=await currentAuthoritySource(core),root=await realpath(await mkdtemp(path.join(os.tmpdir(),'current-c2-')));roots.push(root);for(const name of ['provider','provider-checkpoint','namespace1','namespace2'])await mkdir(path.join(root,name),{mode:0o700});
 const disk=await OwnedJournalDisk.open({authorityId:'provider-control',storeEpoch:hash('provider'),keyId:'provider',key:Buffer.alloc(32,21),checkpointKeyId:'provider-checkpoint',checkpointKey:Buffer.alloc(32,22),store:{root:path.join(root,'provider')},checkpoint:{root:path.join(root,'provider-checkpoint')},mode:'create'});disks.push(disk);
 const hooks:{mirror?:()=>void|Promise<void>;beforeCall?:(api:string)=>void|Promise<void>;source?:(input:any)=>any;afterRecord?:()=>void|Promise<void>}={};
 const storeOptions={selectionMode:'registry' as const,control:disk,contextDigest:ownedDigest({binding:data.input.binding,base:data.input.approvedBaseDigest}),sealKeyId:'seal',sealKey:Buffer.alloc(32,23),sourceKey:data.input.key,fault:async (phase:string)=>{if(phase==='before-select')await hooks.mirror?.();}},storeInitial=await SealedPrefixStore.open(storeOptions);let store=storeInitial;
 let now=0,unavailable=false;const controlConfig={now:()=>now,approvedBase:data.input.approvedBaseDigest,identity:{authorityId:'caller'},business:{operationBinding:data.request.operationBinding,manifestDigest:data.request.manifestDigest,coreGraphDigest:data.request.coreGraphDigest,sessionId:data.request.sessionId,scopeId:ownedDigest({project:data.request.project,context:data.request.context,invocation:data.request.invocation})}};let c:CurrentControl,a:Record<CurrentRole,ReturnType<CurrentControl['actor']>>,currentOwner:OwnedCurrentDisk|undefined;
 if(durable){let key=30;const owners={} as CurrentDiskOptions['owners'];for(const role of ['issuer','registry','anchor'] as const){const storage=path.join(root,role),checkpoint=path.join(root,role+'-cp');await mkdir(storage,{mode:0o700});await mkdir(checkpoint,{mode:0o700});owners[role]={authorityId:'c2-'+role,storeEpoch:hash(role),keyId:role,key:Buffer.alloc(32,key++),checkpointKeyId:role+'-cp',checkpointKey:Buffer.alloc(32,key++),store:{root:storage},checkpoint:{root:checkpoint}};}currentOwner=await OwnedCurrentDisk.open({owners,mode:'create',serverKeys:Object.fromEntries(currentRoles.map(role=>[role,generateKeyPairSync('ed25519')])) as CurrentDiskOptions['serverKeys'],anchorFloor:{revision:0,record:null}});currentOwners.push(currentOwner);const started=await currentOwner.start(controlConfig);c=started.control;a=started.actors;}
 else{c=new CurrentControl(controlConfig);a=Object.fromEntries(currentRoles.map(role=>[role,c.actor(role)])) as Record<CurrentRole,ReturnType<CurrentControl['actor']>>;}
 const saved=new Map<string,{wire:Buffer;payload:string}>(),events:string[]=[],attempts:{api:string;id:string;payload:string}[]=[];
 const transport:OwnedCurrentTransport={assertOpen(){currentOwner?.assertOpen();if(unavailable)throw Error('service-offline');},async context(){events.push('context');return c.binding();},async call(role,api,payload,id){await hooks.beforeCall?.(api);events.push(api);attempts.push({api,id,payload:canonicalOwnedJson(payload)});const key=role+':'+api+':'+id,prior=saved.get(key);if(prior&&prior.payload!==canonicalOwnedJson(payload))throw Error('intent-conflict');const original=prior?.wire??c.request(a[role],api,payload,id);if(!prior)saved.set(key,{wire:original,payload:canonicalOwnedJson(payload)});const wire=prior?c.retry(a[role],original):original;return c.accept(a[role],wire,await c.dispatch(a[role],wire));}};
 const client=new OwnedCurrentClient(transport,data.input.binding),verifier=new CurrentAuthorityVerifier(data.input.approvedBaseDigest,hash(data.input.key));let sequence=0,nextInput=data.input;
 const staged=new Map<string,CurrentRef>();
 const provider:CurrentProviderClient={assertOpen(){transport.assertOpen();store.assertOpen();},async prepare(fence){const old=staged.get(fence.id);if(old)return {snapshot:old};await client.call('provider','CheckLiveBinding',{target:fence,purpose:'checkpoint'});const io=await RootedJournalIO.open({root:path.join(root,'namespace'+ ++sequence),exclusive:true});ios.push(io);const candidate=await store.prepare(io,nextInput),source=await store.readCandidate(candidate),namespace={namespaceId:source.marker.namespaceId,markerDigest:source.markerDigest,generation:source.marker.generation,fence:source.marker.fence,root:source.marker.root};await client.call('provider','CheckLiveBinding',{target:fence,purpose:'checkpoint'});const snapshot=c.registerSource(a.provider,source.input,namespace);staged.set(fence.id,snapshot);return {snapshot};},async read(snapshot,pin){await client.call('provider','CheckLiveBinding',{target:pin,purpose:'source-read'});const namespace=c.sourceNamespace(a.provider,snapshot,pin),source=await store.readExact(namespace.markerDigest);return {namespace,input:hooks.source?hooks.source(source.input):source.input};},async mirror(snapshot,pin){const namespace=c.sourceNamespace(a.provider,snapshot,pin);await store.mirrorExact(namespace.markerDigest,async()=>{await client.call('provider','CheckLiveBinding',{target:pin,purpose:'source-read'});c.sourceNamespace(a.provider,snapshot,pin);});},async recordUse(value){await store.recordUse(value);await hooks.afterRecord?.();}};
 const authority:CurrentAuthorityClient={async prepare(proof,useId){const facts=verifier.inspect(proof);await client.call('authority-broker','CheckLiveBinding',{target:facts.pin,purpose:'handoff'});if(facts.scope.manifestDigest!==data.request.manifestDigest)throw Error('binding-mismatch');const live=await data.currentAuthority();if(live.contractStatus!=='structure-verified'||ownedDigest(live.terminal)!==facts.authorityTerminalDigest)throw Error('authority-unavailable');return c.authorityGate(a['authority-broker'],facts.pin,useId,facts.resultBytes);}};
 const bridge=new OwnedCurrentBridge(client,provider,authority,verifier,()=>data.request,data.request.operationBinding);
 return {...data,root,lockBytes,disk,currentOwner,get store(){return store;},storeOptions,c,a,client,verifier,bridge,events,attempts,hooks,provider,authority,tick:(ms:number)=>now+=ms,offline:()=>unavailable=true,setNext:()=>nextInput=extendCurrentSource(nextInput),reopen:async()=>{store.close();store=await SealedPrefixStore.open({...storeOptions,namespaceIOs:ios});return new OwnedCurrentBridge(client,provider,authority,verifier,()=>data.request,data.request.operationBinding);}};
}
async function selected(){const f=await setup(),publication=await f.bridge.beginPublication('genesis');await f.bridge.publish(publication);return f;}
it('uses registry adoption before a local mirror and verifies the G0/G2 source under a live pin',async()=>{
 const f=await selected();expect(f.events.indexOf('ActivateEnrollment')).toBeLessThan(f.events.lastIndexOf('AcquireReadPin'));expect(f.store.view().selected).not.toBeNull();const handle=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);expect(Object.values(f.c.view().pins).some(p=>p.phase==='active')).toBe(true);await f.bridge.deliverRead(handle);expect(Object.values(f.c.view().pins).some(p=>p.phase==='delivering')).toBe(true);const doc=await f.bridge.acknowledgeRead(handle);expect(doc.owned?.executionWitness).toBe('verified');expect(doc.owned?.importStatus).toBe('unavailable');expect(f.store.view().ledger.uses).toHaveLength(1);expect(f.bridge.diagnostics.backendEligible).toBe(false);observations.read={executionWitness:doc.owned?.executionWitness,importStatus:doc.owned?.importStatus,useRecords:f.store.view().ledger.uses.length,releasedPins:Object.values(f.c.view().pins).filter(p=>p.phase==='released').length,handoffBeforeDelivery:f.events.indexOf('PrepareHandoff')<f.events.indexOf('DeliverResult'),deliveryBeforeAck:f.events.indexOf('DeliverResult')<f.events.indexOf('AcknowledgeDelivery'),originalReadsSkipped:f.bridge.diagnostics.originalReadsSkipped};
});
it('never reads or selects the local selected pointer in registry mode',async()=>{const f=await selected();await expect(f.store.readSelected()).rejects.toThrow('registry_selection_required');const before=f.store.view().metrics.contentReadBytes;f.offline();await expect(f.bridge.prepareRead('file',createGradleBudget(),f.policy)).rejects.toThrow('service-offline');expect(f.store.view().metrics.contentReadBytes).toBe(before);});
it('holds the pin through recorded delivery and rejects publication until consumer ACK',async()=>{const f=await selected(),handle=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);await f.bridge.deliverRead(handle);await expect(f.bridge.beginPublication('advance')).rejects.toThrow('pins_active');await f.bridge.acknowledgeRead(handle);f.setNext();const p=await f.bridge.beginPublication('advance');await f.bridge.publish(p);expect(f.c.view().selected!.head.revision).toBe(2);expect(f.store.view().ledger.namespaces.filter(n=>n.phase==='sealed')).toHaveLength(2);});
it('refuses stale or changed source content and never creates an authority gate from it',async()=>{const f=await selected();f.hooks.source=input=>({...input,payloads:input.payloads.map((b:Buffer,i:number)=>i?b:Buffer.from('changed'))});await expect(f.bridge.prepareRead('file',createGradleBudget(),f.policy)).rejects.toThrow();expect(f.events).not.toContain('PrepareHandoff');});
it('never promotes a fabricated proof or an expired pinned read',async()=>{const f=await selected();expect(()=>f.verifier.inspect({kind:'verified-current-authority'})).toThrow('gate_invalid');const h=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);f.tick(5000);await expect(f.bridge.deliverRead(h)).rejects.toThrow();expect(f.store.view().ledger.uses).toHaveLength(0);});

import {GradleGraphCache,GRADLE_COMPANION} from '../../utils/gradleGraphCache.js';
it('feeds the actual GradleGraphCache through a fresh service read with no companion fallback or cached caller',async()=>{
 const f=await selected();await writeFile(path.join(f.root,GRADLE_COMPANION),'invalid companion');const cache=new GradleGraphCache(f.root,undefined,undefined,undefined,undefined,undefined,f.policy,undefined,f.bridge),lock=path.join(f.root,'gradle.lockfile'),first=await cache.capture(lock,f.lockBytes);expect(first.metadata.owned_manifest?.executionWitness).toBe('verified');expect(first.lookup!('g:a','1').relation).toBe('direct');const reads=f.store.view().metrics.fullVerifications;await cache.capture(lock,f.lockBytes);expect(f.store.view().metrics.fullVerifications).toBeGreaterThan(reads);f.offline();const unavailable=await cache.capture(lock,f.lockBytes);expect(unavailable.metadata.reasons).toContain('owned_current_unavailable');expect(unavailable.metadata.reasons).toContain('metadata_unavailable');observations.graphCache={relation:first.lookup!('g:a','1').relation,executionWitness:first.metadata.owned_manifest?.executionWitness,freshNamespaceVerification:f.store.view().metrics.fullVerifications>reads,noCompanionFallback:unavailable.metadata.reasons.includes('owned_current_unavailable')};
});
it('repairs an adopted namespace after mirror failure without retiring the old selected namespace',async()=>{
 const f=await selected();f.setNext();const p=await f.bridge.beginPublication('advance');let failed=false;f.hooks.mirror=()=>{if(!failed){failed=true;throw Error('mirror-failed');}};await expect(f.bridge.publish(p)).rejects.toThrow('mirror-failed');expect(f.c.view().selected!.head.revision).toBe(2);expect(f.store.view().ledger.namespaces.every(n=>n.phase==='sealed')).toBe(true);f.hooks.mirror=undefined;const next=await f.reopen();await next.repairMirror();expect(f.store.view().ledger.namespaces.find(n=>n.namespaceId===f.store.view().selected)!.generation).toBe(2);const document=await next.readDocument('file',createGradleBudget(),f.policy);expect(document.owned?.executionWitness).toBe('verified');
});
it('resolves a lost PublishSelection reply without a second selection CAS',async()=>{
 const f=await selected();f.setNext();const p=await f.bridge.beginPublication('advance');let armed=true;f.hooks.beforeCall=api=>{if(armed&&api==='PublishSelection'){armed=false;f.c.schedule(f.a.operator,'anchor-after-cas','lose-response');}};await expect(f.bridge.publish(p)).rejects.toThrow('response_lost');const revision=f.c.view().selectionRevision;await f.bridge.publish(p);expect(f.c.view().selectionRevision).toBe(revision);expect(revision).toBe(2);observations.publicationRetry={selectionRevision:revision,noSecondSelection:f.c.view().selectionRevision===revision};
});
it('does not expose a result when durable use recording fails or the pin expires during recording',async()=>{
 const f=await selected(),h=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);f.hooks.afterRecord=()=>{f.tick(5000);};await expect(f.bridge.deliverRead(h)).rejects.toThrow();await expect(f.bridge.acknowledgeRead(h)).rejects.toThrow('recovery_required');expect(f.store.view().ledger.uses).toHaveLength(1);expect(Object.values(f.c.view().pins).some(p=>p.hold)).toBe(true);
});
it('rejects a foreign session/scope instead of treating a matching manifest hash as authority',async()=>{const f=await selected();const bridge=new OwnedCurrentBridge(f.client,f.provider,f.authority,f.verifier,()=>({...f.request,sessionId:'foreign'}),f.request.operationBinding);await expect(bridge.prepareRead('file',createGradleBudget(),f.policy)).rejects.toThrow('witness_unavailable');expect(f.store.view().ledger.uses).toHaveLength(0);});
it('rejects old read handles after bridge close and never silently releases a delivered use',async()=>{const f=await selected(),h=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);await f.bridge.deliverRead(h);f.bridge.close();await expect(f.bridge.acknowledgeRead(h)).rejects.toThrow('owner_closed');expect(Object.values(f.c.view().pins).some(p=>p.phase==='delivering')).toBe(true);});

it('connects the production reader and physical provider to the C1 durable issuer/registry/Anchor',async()=>{
 const f=await setup(true),p=await f.bridge.beginPublication('genesis');await f.bridge.publish(p);const doc=await f.bridge.readDocument('file',createGradleBudget(),f.policy);expect(doc.owned?.executionWitness).toBe('verified');expect((await f.currentOwner!.readAnchor()).revision).toBe(f.c.view().controlRevision);expect(f.store.view().ledger.uses).toHaveLength(1);const before=f.store.view().metrics.contentReadBytes;f.currentOwner!.close();await expect(f.bridge.prepareRead('file',createGradleBudget(),f.policy)).rejects.toThrow('owner_closed');expect(f.store.view().metrics.contentReadBytes).toBe(before);observations.durable={selectedHead:f.c.view().selected!.head.revision,consumerUses:f.store.view().ledger.uses.length,ownerCloseReadDelta:f.store.view().metrics.contentReadBytes-before,backendEligible:f.currentOwner!.diagnostics.backendEligible};
},60000);

it('rejects disabled or unapproved profiles before service acquisition or namespace reads',async()=>{
 const f=await selected(),bytes=f.store.view().metrics.contentReadBytes,events=f.events.length,reads=f.c.metrics.ownedSourceReads;
 await expect(f.bridge.prepareRead('file',createGradleBudget(),{...f.policy,settings:{enabled:false,invalid:false,profiles:[]}})).rejects.toThrow('profile_unapproved');
 const wrong=new OwnedCurrentBridge(f.client,f.provider,f.authority,f.verifier,()=>({...f.request,profileDigest:hash('unapproved')}),f.request.operationBinding);await expect(wrong.prepareRead('file',createGradleBudget(),f.policy)).rejects.toThrow('profile_unapproved');expect(f.store.view().metrics.contentReadBytes).toBe(bytes);expect(f.c.metrics.ownedSourceReads).toBe(reads);expect(f.events.length).toBe(events);
});
it('checks close after an awaited handoff and never sends a subsequent delivery or exposes a document',async()=>{
 const f=await selected(),h=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);f.hooks.beforeCall=api=>{if(api==='PrepareHandoff')f.bridge.close();};await expect(f.bridge.deliverRead(h)).rejects.toThrow('owner_closed');expect(f.events).not.toContain('DeliverResult');expect(f.store.view().ledger.uses).toHaveLength(0);
});
it('refuses a historical DeliverResult retry instead of issuing another consumer delivery',async()=>{
 const f=await selected(),h=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);f.hooks.beforeCall=api=>{if(api==='DeliverResult')f.c.schedule(f.a.operator,'anchor-after-cas','lose-response');};await expect(f.bridge.deliverRead(h)).rejects.toThrow('response_lost');const revision=f.c.view().controlRevision;await expect(f.bridge.deliverRead(h)).rejects.toThrow('recovery_required');expect(f.c.view().controlRevision).toBe(revision);expect(f.store.view().ledger.uses).toHaveLength(0);
});

it('does not substitute the issuer copy when the actual sealed namespace is changed',async()=>{
 const f=await selected(),directory=path.join(f.root,'namespace1'),blob=(await readdir(directory)).find(name=>name.startsWith('blob-'))!;await writeFile(path.join(directory,blob),'changed original');const reads=f.c.metrics.fullReplays;await expect(f.bridge.prepareRead('file',createGradleBudget(),f.policy)).rejects.toThrow();expect(f.c.metrics.fullReplays).toBeGreaterThan(reads);expect(f.events).not.toContain('PrepareHandoff');expect(f.store.view().ledger.uses).toHaveLength(0);
});
it('denies writer role aliases before invoking a service transport',async()=>{
 const f=await selected(),events=f.events.length;await expect(f.client.call('authority-broker','ReserveWriter',{expectedSelection:1})).rejects.toThrow('permission_denied');expect(f.events.length).toBe(events);
});

it('rechecks the live authority kernel even when the registry-selected source still contains a valid terminal',async()=>{
 const f=await selected(),h=await f.bridge.prepareRead('file',createGradleBudget(),f.policy);await f.revokeAuthority();await expect(f.bridge.deliverRead(h)).rejects.toThrow('authority-unavailable');expect(f.events).not.toContain('PrepareHandoff');expect(f.store.view().ledger.uses).toHaveLength(0);
});

it('refuses legacy local-first select even when a valid staged candidate exists',async()=>{
 const f=await selected(),before=f.store.view().selected,io=await RootedJournalIO.open({root:path.join(f.root,'namespace2'),exclusive:true});ios.push(io);const candidate=await f.store.prepare(io,extendCurrentSource(f.input));await expect(f.store.select(candidate)).rejects.toThrow('registry_selection_required');expect(f.store.view().selected).toBe(before);expect(f.c.view().selected!.head.revision).toBe(1);
});
it('rejects a staged but unselected snapshot under a different read pin before physical source IO',async()=>{
 const f=await selected(),fence=(await f.client.call('writer','ReserveWriter',{expectedSelection:1})).value.fence;f.setNext();const staged=await f.provider.prepare(fence);await f.client.call('writer','CancelWriter',{fence});const pin=(await f.client.call('reader','AcquireReadPin',{operationBinding:f.request.operationBinding})).value.pin,before=f.store.view().metrics.contentReadBytes;await expect(f.provider.read(staged.snapshot,pin)).rejects.toThrow('binding_mismatch');expect(f.store.view().metrics.contentReadBytes).toBe(before);
});

it.each(['BeginEnrollment','ReserveWriter','AcquireReadPin'] as const)('retries a lost initial %s response with the original request and lease',async(api)=>{
 const f=api==='BeginEnrollment'?await setup():await selected();
 const work=()=>api==='AcquireReadPin'?f.bridge.prepareRead('file',createGradleBudget(),f.policy):f.bridge.beginPublication(api==='BeginEnrollment'?'genesis':'advance');
 let armed=true;f.hooks.beforeCall=name=>{if(armed&&name===api){armed=false;f.c.schedule(f.a.operator,'anchor-after-cas','lose-response');}};
 const first=f.attempts.length;await expect(work()).rejects.toThrow('response_lost');const before=f.c.view(),revision=before.controlRevision;
 f.tick(10);const handle=await work(),after=f.c.view(),attempts=f.attempts.slice(first).filter(a=>a.api===api);
 expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(after.controlRevision).toBe(revision);
 expect(after.pins).toEqual(before.pins);expect(after.writer).toEqual(before.writer);expect(after.provision).toEqual(before.provision);
 if(api==='AcquireReadPin'){await f.bridge.deliverRead(handle as any);await f.bridge.acknowledgeRead(handle as any);}else{if(api==='ReserveWriter')f.setNext();await f.bridge.publish(handle as any);}
});
it('retries a lost mirror pin acquisition without allocating another pin',async()=>{
 const f=await setup(),p=await f.bridge.beginPublication('genesis');let armed=true;
 f.hooks.beforeCall=api=>{if(armed&&api==='AcquireReadPin'){armed=false;f.c.schedule(f.a.operator,'anchor-after-cas','lose-response');}};
 await expect(f.bridge.publish(p)).rejects.toThrow('response_lost');const pins=f.c.view().pins;await f.bridge.publish(p);
 const attempts=f.attempts.filter(a=>a.api==='AcquireReadPin');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(Object.keys(f.c.view().pins)).toEqual(Object.keys(pins));
});

it.each(['BeginEnrollment','ReserveWriter','AcquireReadPin'] as const)('never renews an expired initial %s after losing its response',async(api)=>{
 const f=api==='BeginEnrollment'?await setup():await selected(),first=f.attempts.length;
 const work=()=>api==='AcquireReadPin'?f.bridge.prepareRead('file',createGradleBudget(),f.policy):f.bridge.beginPublication(api==='BeginEnrollment'?'genesis':'advance');
 let armed=true;f.hooks.beforeCall=name=>{if(armed&&name===api){armed=false;f.c.schedule(f.a.operator,'anchor-after-cas','lose-response');}};
 await expect(work()).rejects.toThrow('response_lost');const before=f.c.view();f.tick(5000);
 await expect(work()).rejects.toThrow();await expect(work()).rejects.toThrow();
 const attempts=f.attempts.slice(first).filter(a=>a.api===api);expect(attempts).toHaveLength(3);expect(attempts.every(a=>canonicalOwnedJson(a)===canonicalOwnedJson(attempts[0]))).toBe(true);
 const after=f.c.view();expect(Object.keys(after.pins)).toEqual(Object.keys(before.pins));expect(after.provision?.ref).toEqual(before.provision?.ref);expect(after.provision?.expires).toBe(before.provision?.expires);expect(after.writer?.ref).toEqual(before.writer?.ref);expect(after.writer?.expires).toBe(before.writer?.expires);
 for(const [id,pin] of Object.entries(before.pins))expect(after.pins[id]!.expires).toBe(pin.expires);expect(f.store.view().ledger.uses).toHaveLength(0);
});
it('keeps a pending read intent and refuses replacement before source IO',async()=>{
 const f=await selected();let armed=true;f.hooks.beforeCall=api=>{if(armed&&api==='AcquireReadPin'){armed=false;f.c.schedule(f.a.operator,'anchor-after-cas','lose-response');}};
 await expect(f.bridge.prepareRead('original',createGradleBudget(),f.policy)).rejects.toThrow('response_lost');const events=f.attempts.length,bytes=f.store.view().metrics.contentReadBytes;
 await expect(f.bridge.prepareRead('other',createGradleBudget(),f.policy)).rejects.toThrow('binding_mismatch');expect(f.attempts.length).toBe(events);expect(f.store.view().metrics.contentReadBytes).toBe(bytes);
 const h=await f.bridge.prepareRead('original',createGradleBudget(),f.policy);await f.bridge.deliverRead(h);await f.bridge.acknowledgeRead(h);
});
it('reproduces the recorded C2 integration outcomes and source fingerprints',async()=>{
 const scenario={schema:'osv-mcp.q2.c2.scenario.v1',scope:'application-client-with-local-service-fixtures',observations,backendEligible:false,profileApproved:false,independentRegistryVerified:false,originalReadsSkipped:0};expect(Object.keys(observations).sort()).toEqual(['durable','graphCache','publicationRetry','read']);
 if(process.env.OSV_CURRENT_C2_REPORT==='1'){console.log('C2_REPORT '+JSON.stringify(scenario));return;}
 const {readFile}=await import('node:fs/promises'),record=JSON.parse(await readFile(new URL('../../../docs/validation/gradle-independent-currentness-c2-2026-11-03.json',import.meta.url),'utf8'));expect(scenario).toEqual(record.scenario);for(const [file,digest]of Object.entries(record.sourceSha256))expect(hash(await readFile(new URL('../../../'+file,import.meta.url)))).toBe(digest);
});
