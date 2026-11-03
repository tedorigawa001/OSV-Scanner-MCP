import {it,expect} from 'vitest';
import {CurrentControl} from '../fixtures/gradleOwnedCurrentControl.js';
import {ownedSha256,ownedDigest,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {currentSource,extendCurrentSource} from '../fixtures/gradleOwnedCurrentSource.js';
import {currentRoles,currentAPIs,apiPolicy,type CurrentRole,type CurrentAPI,type CurrentRef} from '../fixtures/gradleOwnedCurrentSchema.js';
import {runCurrentScenario} from '../fixtures/gradleOwnedCurrentScenario.js';
import {readFileSync} from 'node:fs';
const hash=ownedSha256;
it('reproduces the recorded C0 scenario and source fingerprints',async()=>{
 const result=await runCurrentScenario();
 if(process.env.OSV_CURRENT_C0_REPORT==='1')console.log('C0_REPORT '+JSON.stringify(result));
 const path=new URL('../../../docs/validation/gradle-independent-currentness-c0-2026-11-03.json',import.meta.url);
 if(process.env.OSV_CURRENT_C0_REPORT==='1')return;
 const record=JSON.parse(readFileSync(path,'utf8'));expect(result).toEqual(record.scenario);
 for(const [path,digest]of Object.entries(record.sourceSha256))expect(hash(readFileSync(new URL('../../../'+path,import.meta.url)))).toBe(digest);
});
it('enrolls only through operator provisioning and issuer genesis preparation',async()=>{
 const c=new CurrentControl({now:()=>0,approvedBase:hash('base')});
 const op=c.actor('operator'),reader=c.actor('reader');
 await expect(c.call(reader,'BeginEnrollment',{approvedBase:hash('base')})).rejects.toThrow('permission_denied');
 const result=await c.call(op,'BeginEnrollment',{approvedBase:hash('base')});
 expect(result.value.provision.role).toBe('provision');expect(c.view().phase).toBe('provisioning');expect(c.view().selected).toBeNull();
 expect(result.backendEligible).toBe(false);
});
function setup(options:Partial<ConstructorParameters<typeof CurrentControl>[0]>={}){
 let tick=0,local=100000;const source=currentSource(),c=new CurrentControl({now:()=>tick,readerNow:()=>local,approvedBase:source.approvedBaseDigest,...options});
 const actors=Object.fromEntries(currentRoles.map(role=>[role,c.actor(role)])) as Record<CurrentRole,ReturnType<CurrentControl['actor']>>;
 return {c,actors,source,tick:(amount:number)=>{tick+=amount;local+=amount;},localTick:(amount:number)=>local+=amount};
}
type F=ReturnType<typeof setup>;
async function enroll(f:F){const {c,actors:a,source}=f,snapshot=c.registerSource(a.provider,source),provision=(await c.call(a.operator,'BeginEnrollment',{approvedBase:source.approvedBaseDigest})).value.provision;
 const checkpoint=(await c.call(a.provider,'PrepareCheckpoint',{mode:'genesis',fence:provision,snapshot})).value.checkpoint;
 await c.call(a.operator,'ActivateEnrollment',{provision,checkpoint});return {snapshot,checkpoint,provision};}
async function pin(f:F,actor=f.actors.reader){return (await f.c.call(actor,'AcquireReadPin',{operationBinding:hash('business')})).value.pin;}
it('adopts checkpoint and snapshot together only after preparation, then advances under an exclusive writer',async()=>{
 const f=setup(),{c,actors:a}=f;const initial=await enroll(f);expect(c.view().selected!.checkpoint).toEqual(initial.checkpoint);
 const fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence;
 await expect(c.call(a.reader,'AcquireReadPin',{operationBinding:hash('business')})).rejects.toThrow('writer_busy');
 const next=c.registerSource(a.provider,extendCurrentSource(f.source)),prepared=(await c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot:next})).value;
 expect(c.view().selected!.snapshot).toEqual(initial.snapshot);await c.call(a.writer,'PublishSelection',{fence,checkpoint:prepared.checkpoint});
 expect(c.view().selected).toMatchObject({snapshot:next,checkpoint:prepared.checkpoint,head:{revision:2}});expect(c.view().selectionRevision).toBe(2);
});
it('retains a pin through handoff and releases only after the consumer acknowledgment',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const p=await pin(f),checkpoint=c.view().selected!.checkpoint,witness=(await c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint})).value.witness;
 const gate=c.authorityGate(a['authority-broker'],p,'use-1',Buffer.from('candidate'));
 await c.call(a['authority-broker'],'PrepareHandoff',{pin:p,witness,...gate,useId:'use-1'});expect(c.view().pins[p.id]!.phase).toBe('decision-recorded');
 await expect(c.call(a.reader,'ReleaseReadPin',{pin:p})).rejects.toThrow('pin_revoked');const delivery=(await c.call(a['authority-broker'],'DeliverResult',{pin:p,useId:'use-1'})).value.delivery;
 await expect(c.call(a.writer,'ReserveWriter',{expectedSelection:1})).rejects.toThrow('pins_active');await c.call(a.reader,'AcknowledgeDelivery',{pin:p,delivery,effect:null});expect(c.view().pins[p.id]!.phase).toBe('released');
});
async function beginBarrier(f:F,reason='freeze'){return (await f.c.call(f.actors.operator,'BeginBarrier',{reason,participants:f.c.requiredParticipants()})).value.barrier;}
async function confirmAll(f:F,b:CurrentRef){for(const id of f.c.view().barrier!.participants){const actor=f.actors[id as CurrentRole];await f.c.call(actor,'ConfirmFenced',{barrier:b,evidence:f.c.ownIdleEvidence(actor,b)});}return f.c.call(f.actors.operator,'FinishBarrier',{barrier:b});}
async function handoff(f:F,effect=false){const {c,actors:a}=f,p=await pin(f),witness=(await c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint})).value.witness,gate=c.authorityGate(a['authority-broker'],p,'use',Buffer.from('candidate'),{effect});
 await c.call(a['authority-broker'],'PrepareHandoff',{pin:p,witness,...gate,useId:'use'});return {pin:p,witness,...gate};}
it('resolves a lost pin response after another reader commits without another CAS or lease extension',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const b=c.actor('reader',{id:'reader-b'}),wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')},'lost-pin');c.schedule(a.operator,'anchor-after-cas','lose-response');
 await expect(c.dispatch(a.reader,wire)).rejects.toThrow('response_lost');const first=c.view(),original=Object.values(first.pins)[0]!;await pin(f,b);const cas=c.metrics.anchorCAS;
 const retry=c.retry(a.reader,wire),reply=c.accept(a.reader,retry,await c.dispatch(a.reader,retry));expect(reply.resolutionMode).toBe('existing-live-confirmed');expect(reply.value.pin).toEqual(original.ref);expect(reply.value.expires).toBe(original.expires);expect(reply.appliedControlRevision).toBe(first.controlRevision);expect(reply.currentControlRevision).toBeGreaterThan(reply.appliedControlRevision);expect(c.metrics.anchorCAS).toBe(cas);
 const request=c.inspectRequest(wire),query=await c.call(a.reader,'QueryOperation',{originalAPI:'AcquireReadPin',operationId:request.operationId,originalRequestDigest:request.requestDigest});expect(query.value.status).toBe('committed-historical');expect(query.resolutionMode).toBe('committed-historical');
});
it('retains a delayed first response while another transaction commits, and binds its fresh current head',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const pause=c.pause(a.operator,'anchor-after-cas'),wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')});const pending=c.dispatch(a.reader,wire);await pause.reached;
 const other=c.actor('reader',{id:'other'});await pin(f,other);pause.resume();const reply=c.accept(a.reader,wire,await pending);expect(reply.currentControlRevision).toBeGreaterThan(reply.appliedControlRevision);expect(Object.keys(c.view().pins)).toHaveLength(2);
});
it('returns only historical results after the original pin expired',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')},'lost');c.schedule(a.operator,'anchor-after-cas','lose-response');await expect(c.dispatch(a.reader,wire)).rejects.toThrow('response_lost');f.tick(5000);
 const retry=c.retry(a.reader,wire),reply=c.accept(a.reader,retry,await c.dispatch(a.reader,retry));expect(reply.resolutionMode).toBe('committed-historical');expect(c.view().pins[reply.value.pin.id]!.phase).toBe('expired');
});
it('rejects changed arguments with the same operation identity',async()=>{
 const f=setup();await enroll(f);const p=await pin(f),wire=f.c.request(f.actors.reader,'ReleaseReadPin',{pin:p},'release');await f.c.dispatch(f.actors.reader,wire);const changed={...p,id:hash('other')};await expect(f.c.call(f.actors.reader,'ReleaseReadPin',{pin:changed},'release')).rejects.toThrow('idempotency_conflict');
});
it('supports explicit writer cancellation and active reader release without restoring either lease',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence;await c.call(a.writer,'CancelWriter',{fence});const p=await pin(f);await c.call(a.reader,'ReleaseReadPin',{pin:p});
 await expect(c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint})).rejects.toThrow('pin_revoked');await c.call(a.writer,'ReserveWriter',{expectedSelection:1});expect(c.view().writer!.ref).not.toEqual(fence);
});
it('releases a completing pin before a handoff decision without allowing a late decision',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const p=await pin(f),w=(await c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint})).value.witness,g=c.authorityGate(a['authority-broker'],p,'use',Buffer.from('r')),pause=c.pause(a.operator,'handoff-completing');
 const pending=c.call(a['authority-broker'],'PrepareHandoff',{pin:p,witness:w,...g,useId:'use'});await pause.reached;await c.call(a.reader,'ReleaseReadPin',{pin:p});pause.resume();await expect(pending).rejects.toThrow('pin_revoked');expect(c.view().pins[p.id]!.phase).toBe('cancelled');
});
it('drains all derived participants before a barrier can finish and cannot resume a freeze',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);await pin(f);const barrier=await beginBarrier(f);await expect(c.call(a.operator,'FinishBarrier',{barrier})).rejects.toThrow('fencing_unconfirmed');await confirmAll(f,barrier);expect(c.view().phase).toBe('frozen');await expect(c.call(a.operator,'ResumeServing',{barrier})).rejects.toThrow('control_unavailable');
});
it('does not let timeout or reader acknowledgment resolve an unfinished effect',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const h=await handoff(f,true),delivery=(await c.call(a['authority-broker'],'DeliverResult',{pin:h.pin,useId:'use'})).value.delivery;
 await expect(c.call(a.reader,'AcknowledgeDelivery',{pin:h.pin,delivery,effect:null})).rejects.toThrow('effects_pending');f.tick(5000);await expect(c.call(a.writer,'ReserveWriter',{expectedSelection:1})).rejects.toThrow('pins_active');
 const barrier=await beginBarrier(f);expect(()=>c.ownIdleEvidence(a['authority-broker'],barrier)).toThrow('effects_pending');
 c.stopParticipant(a.operator,a['authority-broker']);const evidence=c.managedEvidence(a.manager,a['authority-broker'],barrier);await c.call(a.manager,'ConfirmFenced',{barrier,evidence});
 for(const id of c.view().barrier!.participants.filter(id=>id!=='authority-broker')){const actor=a[id as CurrentRole];await c.call(actor,'ConfirmFenced',{barrier,evidence:c.ownIdleEvidence(actor,barrier)});}await c.call(a.operator,'FinishBarrier',{barrier});expect(c.view().phase).toBe('frozen');
});
it('accepts completed effect evidence only from its bound broker and same use',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const h=await handoff(f,true),delivery=(await c.call(a['authority-broker'],'DeliverResult',{pin:h.pin,useId:'use'})).value.delivery;
 expect(()=>c.effectCompleted(a.writer,h.pin)).toThrow('permission_denied');const effect=c.effectCompleted(a['authority-broker'],h.pin);await c.call(a.reader,'AcknowledgeDelivery',{pin:h.pin,delivery,effect});expect(c.view().pins[h.pin.id]!.phase).toBe('released');
});
it('fences old pin references on a registry restart and only resumes a restart barrier explicitly',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const p=await pin(f),old=c.view().incarnation;await c.restart(a.operator);expect(c.view().incarnation).not.toBe(old);expect(c.view().phase).toBe('draining');const barrier=c.view().barrier!.ref;await confirmAll(f,barrier);await c.call(a.operator,'ResumeServing',{barrier});
 await expect(c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint})).rejects.toThrow('pin_revoked');expect(c.view().phase).toBe('serving');
});
it('does not reopen a preexisting frozen lineage on restart',async()=>{const f=setup();await enroll(f);const b=await beginBarrier(f);await confirmAll(f,b);await f.c.restart(f.actors.operator);expect(f.c.view().phase).toBe('frozen');await expect(f.c.call(f.actors.operator,'ResumeServing',{barrier:b})).rejects.toThrow('control_unavailable');});
for(const point of ['registry-before-record','registry-after-record','registry-after-sync','anchor-before-cas'] as const)it('never adopts a registry transaction after injected failure at '+point,async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const before=c.view();c.schedule(a.operator,point,'fail');await expect(pin(f)).rejects.toThrow('injected_');expect(c.view().currentRecordRef).toEqual(before.currentRecordRef);expect(c.metrics.anchorCAS).toBe(before.controlRevision);await expect(pin(f)).rejects.toThrow('recovery_required');
});
for(const point of ['issuer-before-sync','issuer-after-sync','issuer-before-reply'] as const)it('does not adopt or report current after issuer fault at '+point,async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const old=c.view().selected,fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence,snapshot=c.registerSource(a.provider,extendCurrentSource(f.source));c.schedule(a.operator,point,'fail');await expect(c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot})).rejects.toThrow('injected_');expect(c.view().selected).toEqual(old);
 await expect(c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot})).rejects.toThrow('checkpoint_unavailable');
});
it('rejects prepared work invalidated during its last await',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence,snapshot=c.registerSource(a.provider,extendCurrentSource(f.source)),pause=c.pause(a.operator,'issuer-after-sync');const pending=c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot});await pause.reached;await beginBarrier(f);pause.resume();await expect(pending).rejects.toThrow('writer_stale');expect(c.view().selected!.head.revision).toBe(1);
});
it('rejects a checkpoint witness if revocation happens after verification but before the response',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const p=await pin(f),pause=c.pause(a.operator,'registry-before-reply'),pending=c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint});await pause.reached;await beginBarrier(f);pause.resume();await expect(pending).rejects.toThrow('control_unavailable');
});
it('retains historical delivery without resending effects after revocation',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const h=await handoff(f),wire=c.request(a['authority-broker'],'DeliverResult',{pin:h.pin,useId:'use'},'deliver');c.schedule(a.operator,'anchor-after-cas','lose-response');await expect(c.dispatch(a['authority-broker'],wire)).rejects.toThrow('response_lost');await beginBarrier(f);const retry=c.retry(a['authority-broker'],wire),result=c.accept(a['authority-broker'],retry,await c.dispatch(a['authority-broker'],retry));expect(result.resolutionMode).toBe('committed-historical');
});
for(const kind of ['record','ledger','result','drop-record'] as const)it('does not resolve a cached operation through damaged '+kind,async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')});await c.dispatch(a.reader,wire);c.corrupt(a.operator,kind);const retry=c.retry(a.reader,wire);await expect(c.dispatch(a.reader,retry)).rejects.toThrow('integrity_invalid');
});
it('authenticates the full source again instead of accepting provider digests alone',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const p=await pin(f),before=c.metrics.fullReplays;await c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint});expect(c.metrics.fullReplays).toBeGreaterThan(before);c.corrupt(a.operator,'source');await expect(c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint})).rejects.toThrow('integrity_invalid');
});
it('bounds pins and preserves existing state on admission refusal',async()=>{
 const f=setup({limits:{pins:1}});await enroll(f);const p=await pin(f);await expect(pin(f)).rejects.toThrow('capacity_exhausted');await f.c.call(f.actors.reader,'ReleaseReadPin',{pin:p});await expect(pin(f)).resolves.toBeTruthy();
});
it('separates valid Anchor reads and idempotent CAS from registry API authority',async()=>{
 const f=setup(),{c,actors:a}=f;await c.call(a.operator,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest});const state=c.view(),record=state.currentRecordRef!,attemptId=ownedDigest({registry:'registry',incarnation:state.incarnation,previous:null,next:record});
 expect((await c.call(a['lineage-registry'],'anchor.read',{})).value.record).toEqual(record);expect((await c.call(a['lineage-registry'],'anchor.cas',{expected:null,next:record,attemptId})).value.revision).toBe(1);expect((await c.call(a['lineage-registry'],'anchor.query-operation',{attemptId})).value.status).toBe('committed-historical');
 await expect(c.call(a.reader,'anchor.read',{})).rejects.toThrow('permission_denied');await expect(c.call(a['lineage-registry'],'ReserveWriter',{expectedSelection:0})).rejects.toThrow('permission_denied');
});
it('limits issuer source reads and participant introspection to their delegated API',async()=>{
 const f=setup(),{c,actors:a}=f,initial=await enroll(f),fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence;
 const read=await c.call(a['checkpoint-issuer'],'ReadForCheckpoint',{fence,snapshot:initial.snapshot,kind:'commit',index:0,offset:0,maxBytes:32});expect(Buffer.from(read.value.bytes,'base64')).toEqual(f.source.commits[0]!.subarray(0,32));
 expect((await c.call(a.provider,'CheckLiveBinding',{target:fence,purpose:'checkpoint'})).value.phase).toBe('reserved');await c.call(a.writer,'CancelWriter',{fence});const p=await pin(f);
 expect((await c.call(a.provider,'ReadCurrentCheckpoint',{pin:p,checkpoint:initial.checkpoint})).value.head.revision).toBe(1);
 await expect(c.call(a['authority-broker'],'CheckLiveBinding',{target:p,purpose:'checkpoint'})).rejects.toThrow('permission_denied');
 const rogue=c.actor('checkpoint-issuer',{id:'other-issuer'});await expect(c.call(rogue,'ReadForCheckpoint',{fence,snapshot:initial.snapshot,kind:'payload',index:0,offset:0,maxBytes:1})).rejects.toThrow('writer_stale');
});
function dummyPayload(api:CurrentAPI):any{
 const ref=(role:CurrentRef['role'])=>({role,id:'dummy',sha256:hash('dummy'),byteLength:1}),pin=ref('read-pin'),fence=ref('writer-fence'),checkpoint=ref('checkpoint-prepare'),barrier=ref('barrier');
 const payloads:Record<CurrentAPI,any>={BeginEnrollment:{approvedBase:hash('base')},ActivateEnrollment:{provision:ref('provision'),checkpoint},ReserveWriter:{expectedSelection:0},PrepareCheckpoint:{mode:'genesis',fence:ref('provision'),snapshot:ref('snapshot')},ReadForCheckpoint:{fence,snapshot:ref('snapshot'),kind:'commit',index:0,offset:0,maxBytes:1},PublishSelection:{fence,checkpoint},AcquireReadPin:{operationBinding:hash('business')},ReadCurrentCheckpoint:{pin,checkpoint},CheckLiveBinding:{target:pin,purpose:'checkpoint'},PrepareHandoff:{pin,witness:ref('checkpoint-witness'),gate:ref('authority-gate'),result:ref('candidate-result'),useId:'use'},DeliverResult:{pin,useId:'use'},AcknowledgeDelivery:{pin,delivery:ref('delivery'),effect:null},BeginBarrier:{reason:'freeze',participants:[]},ConfirmFenced:{barrier,evidence:ref('fence-evidence')},FinishBarrier:{barrier},ResumeServing:{barrier},QueryOperation:{originalAPI:'BeginEnrollment',operationId:'missing',originalRequestDigest:hash('missing')},CancelWriter:{fence},ReleaseReadPin:{pin},'anchor.read':{},'anchor.cas':{expected:null,next:ref('registry-record'),attemptId:hash('attempt')},'anchor.query-operation':{attemptId:hash('attempt')}};
 return payloads[api];
}
for(const api of currentAPIs)it('denies unauthorized '+api+' before owned reads or mutation',async()=>{
 const f=setup(),policy=apiPolicy[api],wrong=currentRoles.find(role=>!policy.roles.includes(role));const actor=wrong?f.actors[wrong]:f.c.actor('reader',{id:'no-grant',permissions:[]});
 const before=f.c.view();await expect(f.c.call(actor,api,dummyPayload(api))).rejects.toThrow('permission_denied');expect(f.c.metrics.ownedSourceReads).toBe(0);expect(f.c.view()).toEqual(before);
});
for(const api of currentAPIs)it('strictly rejects unknown payload fields for '+api,async()=>{
 const f=setup(),role=apiPolicy[api].roles[0]!,actor=f.actors[role];await expect(f.c.call(actor,api,{...dummyPayload(api),path:'/untrusted/path'})).rejects.toThrow('schema_invalid');expect(f.c.metrics.ownedSourceReads).toBe(0);expect(f.c.metrics.commits).toBe(0);
});
for(const field of ['authorityId','lineageId','generation','storeEpoch','rootPairId','storeRootId','checkpointRootId','storageInstanceId','profileDigest','policyDigest','parserDigest','schemaDigest','enrollmentDigest','checkpointIssuer','checkpointKeyEpoch'] as const)it('binds requests to the independently configured '+field,async()=>{
 const f=setup(),actor=f.actors.operator,binding:any=f.c.binding();binding[field]=typeof binding[field]==='number'?binding[field]+1:binding[field].length===64?hash('other'):'other';const wire=f.c.request(actor,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest},'enroll',binding);await expect(f.c.dispatch(actor,wire)).rejects.toThrow('binding_mismatch');expect(f.c.metrics.ownedSourceReads).toBe(0);
});
for(const field of ['role','peerId','peerBoot','keyEpoch','destination'] as const)it('rejects a client-signed mismatched '+field,async()=>{
 const f=setup(),a=f.actors.operator,wire=f.c.request(a,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest}),body:any=f.c.inspectRequest(wire);body[field]=field==='role'?'manager':field==='keyEpoch'?2:field==='destination'?'provider':field==='peerBoot'?hash('other'):'other';await expect(f.c.dispatch(a,f.c.signMalformed(a,body))).rejects.toThrow('peer_mismatch');expect(f.c.metrics.commits).toBe(0);
});
for(const shape of ['array','unknown','negative','float','duplicate','utf8','oversized','signature','whitespace'] as const)it('rejects malformed wire '+shape,async()=>{
 const f=setup(),a=f.actors.operator,wire=f.c.request(a,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest});let bad:Buffer=wire;
 if(shape==='array')bad=f.c.signMalformed(a,[]);if(shape==='unknown')bad=f.c.signMalformed(a,{...f.c.inspectRequest(wire),unknown:true});
 if(shape==='negative')bad=Buffer.from(wire.toString().replace('"sequence":1','"sequence":-1'));if(shape==='float')bad=Buffer.from(wire.toString().replace('"sequence":1','"sequence":1.5'));
 if(shape==='duplicate')bad=Buffer.from(wire.toString().replace('"sequence":1','"sequence":1,"sequence":1'));if(shape==='utf8')bad=Buffer.from([255]);if(shape==='oversized')bad=Buffer.alloc(16385,32);
 if(shape==='signature'){const e=JSON.parse(wire.toString());e.signature=(e.signature[0]==='A'?'B':'A')+e.signature.slice(1);bad=Buffer.from(canonicalOwnedJson(e));}if(shape==='whitespace')bad=Buffer.concat([wire,Buffer.from(' ')]);
 await expect(f.c.dispatch(a,bad)).rejects.toThrow('current_control_');expect(f.c.metrics.ownedSourceReads).toBe(0);expect(f.c.metrics.commits).toBe(0);
});
it('does not replay challenges or use a response for another request',async()=>{
 const f=setup(),a=f.actors.operator,wire=f.c.request(a,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest}),response=await f.c.dispatch(a,wire);f.c.accept(a,wire,response);await expect(f.c.dispatch(a,wire)).rejects.toThrow('challenge_replayed');
 const query=f.c.request(a,'QueryOperation',{originalAPI:'BeginEnrollment',operationId:'unknown',originalRequestDigest:hash('unknown')});expect(()=>f.c.accept(a,query,response)).toThrow('binding_mismatch');
});
it('rejects an unprovisioned actor handle and misconfigured principal identity',async()=>{
 const f=setup(),wire=f.c.request(f.actors.operator,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest});await expect(f.c.dispatch({kind:'c0-actor'},wire)).rejects.toThrow('peer_mismatch');const a=f.c.actor('operator',{id:'wrong-principal',uid:1102,gid:1202});await expect(f.c.call(a,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest})).rejects.toThrow('peer_mismatch');
});
for(const cfg of [{supported:false},{approved:false}])it('closes the configuration gate before owned reads '+JSON.stringify(cfg),async()=>{const f=setup(cfg);await expect(f.c.call(f.actors.operator,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest})).rejects.toThrow(/anchor_unsupported|profile_unapproved/);expect(f.c.metrics.ownedSourceReads).toBe(0);});
it('does not let broker, manager or participant roles widen their authority',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);await expect(c.call(a['authority-broker'],'BeginBarrier',{reason:'gc',participants:c.requiredParticipants()})).rejects.toThrow('permission_denied');
 await expect(c.call(a.manager,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest})).rejects.toThrow('permission_denied');await expect(c.call(a.operator,'BeginBarrier',{reason:'freeze',participants:[]})).rejects.toThrow('participants_incomplete');
 const barrier=await beginBarrier(f),own=c.ownIdleEvidence(a.provider,barrier);await expect(c.call(a['checkpoint-issuer'],'ConfirmFenced',{barrier,evidence:own})).rejects.toThrow('permission_denied');
 expect(()=>c.managedEvidence(a.manager,a.provider,barrier)).toThrow('permission_denied');await expect(c.call(a.manager,'AcknowledgeDelivery',dummyPayload('AcknowledgeDelivery'))).rejects.toThrow('permission_denied');
});
it('does not accept a caller hash as an authority business gate',async()=>{
 const f=setup();await enroll(f);await expect(f.c.call(f.actors.reader,'AcquireReadPin',{operationBinding:hash('unapproved-business')})).rejects.toThrow('gate_invalid');
});
it('executes all 22 APIs in a reproducible positive trace',async()=>{
 const r=await runCurrentScenario();expect(r.metrics.completedAPIs).toEqual([...currentAPIs].sort());expect(r.lostResponse).toMatchObject({samePin:true,leaseExtended:false,additionalCAS:0,resolutionMode:'existing-live-confirmed'});expect(r.handoffPhases).toEqual(['decision-recorded','delivering','released']);expect(r.barrierPhase).toBe('frozen');expect(r.finalPhase).toBe('serving');expect(r.selectedSourceRevision).toBe(2);
});
it('coalesces a concurrent retry of an already committed operation',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const pause=c.pause(a.operator,'anchor-after-cas'),wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')},'parallel'),first=c.dispatch(a.reader,wire);await pause.reached;
 const cas=c.metrics.anchorCAS,retry=c.retry(a.reader,wire),second=c.accept(a.reader,retry,await c.dispatch(a.reader,retry));pause.resume();const one=c.accept(a.reader,wire,await first);expect(second.value.pin).toEqual(one.value.pin);expect(c.metrics.anchorCAS).toBe(cas);
});
it('keeps an unadopted pending attempt distinct from a committed result',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const pause=c.pause(a.operator,'anchor-before-cas'),wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')},'pending'),first=c.dispatch(a.reader,wire);await pause.reached;
 const r=c.inspectRequest(wire),query=await c.call(a.reader,'QueryOperation',{originalAPI:'AcquireReadPin',operationId:r.operationId,originalRequestDigest:r.requestDigest});expect(query.value.status).toBe('pending');expect(query.resolutionMode).toBe('pending');
 const retry=c.retry(a.reader,wire);await expect(c.dispatch(a.reader,retry)).rejects.toThrow('operation_pending');pause.resume();await first;
});
it('classifies a valid competing transaction as conflict without rebase or global fail-stop',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const pause=c.pause(a.operator,'anchor-before-cas'),wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')},'conflict'),first=c.dispatch(a.reader,wire);await pause.reached;c.compete(a.operator);pause.resume();await expect(first).rejects.toThrow('control_conflict');
 const r=c.inspectRequest(wire),query=await c.call(a.reader,'QueryOperation',{originalAPI:'AcquireReadPin',operationId:r.operationId,originalRequestDigest:r.requestDigest});expect(query.value.status).toBe('unknown');expect(Object.keys(c.view().pins)).toHaveLength(0);await expect(pin(f)).resolves.toBeTruthy();
});
it('coalesces a direct retry of the same Anchor attempt before the original RPC returns',async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const pause=c.pause(a.operator,'anchor-before-cas'),wire=c.request(a.reader,'AcquireReadPin',{operationBinding:hash('business')}),first=c.dispatch(a.reader,wire);await pause.reached;
 const attempt=c.pendingRecords(a.operator)[0]!;await c.call(a['lineage-registry'],'anchor.cas',{expected:attempt.expected,next:attempt.next,attemptId:attempt.attemptId});const cas=c.metrics.anchorCAS;pause.resume();await first;expect(c.metrics.anchorCAS).toBe(cas);
});
it('rejects a legitimate older local state against the still-current Anchor',async()=>{
 const f=setup();await enroll(f);const old=f.c.view().controlRevision;await pin(f);f.c.rollbackLocal(f.actors.operator,old);await expect(pin(f)).rejects.toThrow('integrity_invalid');
});

it('expires a delayed reply on the independent reader clock',async()=>{
 const f=setup();await enroll(f);const r=f.c.request(f.actors.reader,'AcquireReadPin',{operationBinding:hash('business')}),reply=await f.c.dispatch(f.actors.reader,r);f.localTick(5000);
 expect(()=>f.c.accept(f.actors.reader,r,reply)).toThrow('request_expired');
});
it('rejects a backwards clock without a new commit',async()=>{
 const f=setup();await enroll(f);f.tick(10);await pin(f);const n=f.c.metrics.anchorCAS;f.tick(-1);await expect(pin(f)).rejects.toThrow('clock_invalid');expect(f.c.metrics.anchorCAS).toBe(n);
});
it('keeps private source bytes and diagnostic views independent of caller mutation',async()=>{
 const f=setup(),{c,actors:a}=f,s=c.registerSource(a.provider,f.source);f.source.payloads[0]!.fill(0);const provision=(await c.call(a.operator,'BeginEnrollment',{approvedBase:f.source.approvedBaseDigest})).value.provision;
 const checkpoint=(await c.call(a.provider,'PrepareCheckpoint',{mode:'genesis',fence:provision,snapshot:s})).value.checkpoint;await c.call(a.operator,'ActivateEnrollment',{provision,checkpoint});
 const view=c.view();view.phase='retired';view.selected!.snapshot.id='altered';const p=await pin(f);await expect(c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint})).resolves.toMatchObject({value:{}});expect(c.view().phase).toBe('serving');
});
for(const target of ['registry','issuer','anchor'] as const)it('has no fallback when '+target+' is unavailable',async()=>{
 const f=setup();const {checkpoint}=await enroll(f),p=await pin(f);f.c.availability(f.actors.operator,target,false);const before=f.c.metrics.ownedSourceReads;
 await expect(f.c.call(f.actors.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint})).rejects.toThrow(target==='issuer'?'checkpoint_unavailable':target==='anchor'?'anchor_unavailable':'control_unavailable');expect(f.c.metrics.ownedSourceReads).toBe(before);
});
it('expires an unused writer reservation before admitting another reader',async()=>{
 const f=setup();await enroll(f);const fence=(await f.c.call(f.actors.writer,'ReserveWriter',{expectedSelection:1})).value.fence;f.tick(5000);await pin(f);
 await expect(f.c.call(f.actors.writer,'CancelWriter',{fence})).rejects.toThrow('writer_stale');
});
for(const limit of ['operations','records','prepares'] as const)it('enforces the '+limit+' budget before current selection changes',async()=>{
 const f=setup({limits:{[limit]:limit==='prepares'?1:2}});await enroll(f);const selected=f.c.view().selected;
 if(limit==='prepares'){const fence=(await f.c.call(f.actors.writer,'ReserveWriter',{expectedSelection:1})).value.fence,snapshot=f.c.registerSource(f.actors.provider,extendCurrentSource(f.source));await expect(f.c.call(f.actors.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot})).rejects.toThrow('capacity_exhausted');}
 else await expect(pin(f)).rejects.toThrow('capacity_exhausted');expect(f.c.view().selected).toEqual(selected);
});
it('bounds global pending challenges independently of per-peer requests',()=>{
 const f=setup({limits:{pending:1}});f.c.request(f.actors.reader,'QueryOperation',{originalAPI:'AcquireReadPin',operationId:'missing',originalRequestDigest:hash('missing')});
 expect(()=>f.c.request(f.actors.writer,'ReserveWriter',{expectedSelection:0})).toThrow('capacity_exhausted');f.tick(5000);expect(()=>f.c.request(f.actors.writer,'ReserveWriter',{expectedSelection:0})).not.toThrow();
});

it('counts snapshot metadata and original source together against the byte budget',()=>{
 const source=currentSource(),bytes=[...source.commits,...source.payloads].reduce((n,b)=>n+b.length,0),f=setup({limits:{closure:bytes+1}});
 expect(()=>f.c.registerSource(f.actors.provider,source)).toThrow('capacity_exhausted');expect(f.c.metrics.retainedBytes).toBeLessThanOrEqual(bytes+1);expect(f.c.view().selected).toBeNull();
});

it('does not reset original reader elapsed time with a fresh retry nonce',async()=>{
 const f=setup();await enroll(f);const r=f.c.request(f.actors.reader,'AcquireReadPin',{operationBinding:hash('business')},'local-deadline');f.c.schedule(f.actors.operator,'anchor-after-cas','lose-response');await expect(f.c.dispatch(f.actors.reader,r)).rejects.toThrow('response_lost');
 f.localTick(5000);const n=f.c.metrics.anchorCAS,retry=f.c.retry(f.actors.reader,r),reply=f.c.accept(f.actors.reader,retry,await f.c.dispatch(f.actors.reader,retry));expect(reply.resolutionMode).toBe('committed-historical');expect(f.c.metrics.anchorCAS).toBe(n);
});

for(const boundary of ['handoff-completing','anchor-before-cas','registry-before-reply'] as const)it('rejects revoked handoff permission at '+boundary,async()=>{
 const f=setup(),{c,actors:a}=f;await enroll(f);const p=await pin(f),witness=(await c.call(a.reader,'ReadCurrentCheckpoint',{pin:p,checkpoint:c.view().selected!.checkpoint})).value.witness,gate=c.authorityGate(a['authority-broker'],p,'revoked-use',Buffer.from('candidate'));
 const completing=c.pause(a.operator,'handoff-completing'),pending=c.call(a['authority-broker'],'PrepareHandoff',{pin:p,witness,...gate,useId:'revoked-use'});await completing.reached;
 let resume=completing.resume;if(boundary!=='handoff-completing'){const next=c.pause(a.operator,boundary);completing.resume();await next.reached;resume=next.resume;}
 c.revokePermission(a.operator,a['authority-broker'],'handoff.prepare');resume();await expect(pending).rejects.toThrow('permission_denied');
 expect(c.view().pins[p.id]!.phase).toBe(boundary==='registry-before-reply'?'decision-recorded':'completing');
});
for(const limit of ['prepares','operations'] as const)it('reserves '+limit+' capacity across concurrent issuer prepares',async()=>{
 const f=setup({limits:{[limit]:limit==='prepares'?2:3}}),{c,actors:a}=f;await enroll(f);const fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence,next=extendCurrentSource(f.source),s1=c.registerSource(a.provider,next),s2=c.registerSource(a.provider,extendCurrentSource(next));
 if(limit==='operations')await c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot:s1},'warmup');
 const pause=c.pause(a.operator,'issuer-before-verify');const pending=c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot:s1},'reserved-prepare');await pause.reached;const reads=c.metrics.ownedSourceReads;
 await expect(c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot:s2},'over-limit')).rejects.toThrow('capacity_exhausted');expect(c.metrics.ownedSourceReads).toBe(reads);pause.resume();await pending;expect(c.metrics.prepares).toBe(2);
});
it('releases unused issuer capacity after a cancelled in-flight prepare',async()=>{
 const f=setup({limits:{prepares:2}}),{c,actors:a}=f;await enroll(f);const fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence,snapshot=c.registerSource(a.provider,extendCurrentSource(f.source)),pause=c.pause(a.operator,'issuer-before-verify');
 const pending=c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot});await pause.reached;await c.call(a.writer,'CancelWriter',{fence});pause.resume();await expect(pending).rejects.toThrow('writer_stale');
 const fresh=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence;await expect(c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence:fresh,snapshot})).resolves.toMatchObject({value:{head:{revision:2}}});expect(c.metrics.prepares).toBe(2);
});

it('keeps saved prepare capacity charged after cancellation following sync',async()=>{
 const f=setup({limits:{prepares:2}}),{c,actors:a}=f;await enroll(f);const fence=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence,snapshot=c.registerSource(a.provider,extendCurrentSource(f.source)),pause=c.pause(a.operator,'issuer-after-sync');
 const pending=c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence,snapshot});await pause.reached;await c.call(a.writer,'CancelWriter',{fence});pause.resume();await expect(pending).rejects.toThrow('writer_stale');expect(c.metrics.prepares).toBe(2);
 const fresh=(await c.call(a.writer,'ReserveWriter',{expectedSelection:1})).value.fence;await expect(c.call(a.provider,'PrepareCheckpoint',{mode:'advance',fence:fresh,snapshot})).rejects.toThrow('capacity_exhausted');expect(c.view().selected!.head.revision).toBe(1);
});
