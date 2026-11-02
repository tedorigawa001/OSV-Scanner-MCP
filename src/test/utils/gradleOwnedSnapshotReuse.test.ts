import {it,expect} from 'vitest';
import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
import {ownedSha256,ownedDigest,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
const identity={authorityId:'caller',storeEpoch:ownedSha256('po2'),keyId:'key'},scope={project:'main::',context:'runtime',invocation:'invocation'};
async function setup(){
 const io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity));const journal=await AuthorityJournal.create({...identity,key:Buffer.alloc(32,3),io,checkpoint});const f=ownedPolicyFixture();let now=0;
 const config={authorityId:'caller',policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)},now:()=>now,journal,verifySnapshotReuse:true};
 const model=new OwnedAuthorityContract(config),caller=model.principal('caller'),reader=model.principal('reader');let seq=0;
 const command=(p:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++seq),...p});
 const begin=(scopes=[scope],extra:any={})=>command({operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(scopes),...extra});
 return {io,checkpoint,journal,model,caller,reader,config,command,begin,claim:f.claim,advance:(v:number)=>now+=v};
}
it('retries a committed begin without rebuilding an unchanged full snapshot',async()=>{
 const f=await setup(),input=f.begin();await f.model.dispatchDurable(f.caller,input);const before=f.model.snapshotMetrics;
 await expect(f.model.dispatchDurable(f.caller,input)).resolves.toMatchObject({historical:true});
 expect(before.builds).toBeGreaterThan(0);expect(f.model.snapshotMetrics.builds).toBe(before.builds);expect(f.journal.head.revision).toBe(1);
});

it('binds private record seals to one journal and never trusts input or output Buffer aliases',async()=>{
 const f=await setup(),bytes=Buffer.from('private'),handle=f.journal.sealRecord({id:'payload',role:'metadata-snapshot',bytes});bytes.fill(0);
 const exposed=f.journal.materializeRecord(handle);expect(exposed.bytes.toString()).toBe('private');exposed.bytes.fill(0);expect(f.journal.materializeRecord(handle).bytes.toString()).toBe('private');
 const other=await setup();expect(()=>other.journal.describeRecord(handle)).toThrow('sealed_record_invalid');expect(()=>f.journal.describeRecord(Object.freeze({}) as any)).toThrow('sealed_record_invalid');
});

import {graphFixture} from '../fixtures/gradleGraphFixture.js';
type F=Awaited<ReturnType<typeof setup>>;
const call=(f:F,actor:object,p:any)=>f.model.dispatchDurable(actor,f.command(p));
async function active(f:F,scopes=[scope],expectedCurrentRevision=0,extra:any={},large=false){
 const s=await f.model.dispatchDurable(f.caller,f.begin(scopes,extra)),core:any=graphFixture();if(large)core.inputs.files=Array.from({length:300},(_,i)=>({path:'input/'+i+'x'.repeat(4000),sha256:ownedSha256('input')}));
 const bytes=Buffer.from(canonicalOwnedJson(core));let ref:any;
 for(let ordinal=0;ordinal<Math.ceil(bytes.length/1024**2);ordinal++){
  const part=bytes.subarray(ordinal*1024**2,(ordinal+1)*1024**2);ref=(await call(f,f.caller,{operation:'put-metadata-chunk',sessionId:s.sessionId,uploadId:s.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64')})).ref;
 }
 const bound=await call(f,f.caller,{operation:'bind-core',sessionId:s.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedSha256(bytes),rootRegistryDigest:ownedSha256('root'),scopes:scopes.map(x=>({...x,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}))});
 return call(f,f.caller,{operation:'activate',sessionId:s.sessionId,expectedRevision:bound.revision,expectedCurrentRevision});
}
it('reuses frozen nonempty metadata and unchanged ledgers while matching the full builder bytes',async()=>{
 const f=await setup(),scopes=[scope,{...scope,invocation:'two'}],s=await active(f,scopes,0,{},true),before=f.model.snapshotMetrics;
 await call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});
 const after=f.model.snapshotMetrics;expect(after.referenceComparisons).toBeGreaterThanOrEqual(after.builds);expect(after.metadataBytes).toBe(before.metadataBytes);expect(after.reusedRecords).toBeGreaterThan(before.reusedRecords);
 const steady=f.model.snapshotMetrics;await call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope,expectedRevision:0});expect(f.model.snapshotMetrics.builds).toBe(steady.builds);expect(f.model.snapshotMetrics.recordsCreated).toBe(steady.recordsCreated);
});

const index=async(f:F)=>JSON.parse((await f.journal.readLatest()).find(r=>r.role==='session-index')!.bytes.toString());
it('refreshes all summaries sharing a slot after supersession and closure',async()=>{
 const f=await setup(),first=await active(f),second=await active(f,[scope],1);
 let saved=await index(f);expect(saved.sessions.map((s:any)=>s.summary.currentRevision)).toEqual([2,2]);expect(saved.sessions[0].summary.validity).toBe('superseded');
 await call(f,f.caller,{operation:'abort',sessionId:second.sessionId,expectedRevision:second.revision,reason:'operator-request'});
 saved=await index(f);expect(saved.sessions.map((s:any)=>s.summary.currentRevision)).toEqual([3,3]);expect(saved.sessions[0].summary.sessionId).toBe(first.sessionId);
});
it('rolls back failed upload candidates and preserves partial bytes through freeze',async()=>{
 const f=await setup(),s=await f.model.dispatchDurable(f.caller,f.begin()),core:any=graphFixture();core.inputs.files=Array.from({length:300},(_,i)=>({path:'input/'+i+'x'.repeat(4000),sha256:ownedSha256('input')}));const bytes=Buffer.from(canonicalOwnedJson(core));
 const send=(ordinal:number,chunk:Buffer)=>f.command({operation:'put-metadata-chunk',sessionId:s.sessionId,uploadId:s.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(chunk),base64:chunk.toString('base64')});
 await f.model.dispatchDurable(f.caller,send(0,bytes.subarray(0,1024**2)));const head=f.journal.head,before=f.model.snapshotMetrics.builds;
 const bad=Buffer.from(bytes.subarray(1024**2));bad[0]=0;await expect(f.model.dispatchDurable(f.caller,send(1,bad))).rejects.toThrow('content_mismatch');
 expect(f.journal.head).toEqual(head);expect(f.model.snapshotMetrics.builds).toBe(before);
 const partial=(await f.journal.readLatest()).filter(r=>r.role==='metadata-snapshot');expect(partial).toHaveLength(1);expect(partial[0]!.bytes.equals(bytes.subarray(0,1024**2))).toBe(true);
 await f.model.dispatchDurable(f.caller,send(1,bytes.subarray(1024**2)));const frozen=(await f.journal.readLatest()).filter(r=>r.role==='metadata-snapshot');expect(frozen).toHaveLength(1);expect(frozen[0]!.bytes.equals(bytes)).toBe(true);
});
it('keeps ledger order, reservations, cancelled uploads and sealed terminal bytes equivalent',async()=>{
 const f=await setup(),s=await active(f);let r=await call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});const broker=f.model.principal('broker',s.sessionId,scope),observer=f.model.principal('observer',s.sessionId,scope);
 const append=(event:any)=>({operation:'append-event',sessionId:s.sessionId,scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event});
 r=await call(f,broker,append({kind:'action-start',capability:r.capability}));
 const head=f.journal.head;await expect(call(f,broker,append({kind:'action-start',capability:'0'.repeat(64)}))).rejects.toThrow('capability_invalid');expect(f.journal.head).toEqual(head);
 r=await call(f,observer,append({kind:'execution-observation',lookup:{status:'unavailable',reason:'receipt-missing'},leases:[]}));
 r=await call(f,broker,{operation:'seal-scope',phase:'prepare',sessionId:s.sessionId,scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead});
 r=await call(f,broker,{operation:'seal-scope',phase:'commit',sessionId:s.sessionId,scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead});expect(r.terminal.outcome).toBe('unavailable');
 const saved=await f.journal.readLatest();expect(JSON.parse(saved.find(r=>r.role==='event-ledger')!.bytes.toString()).events).toHaveLength(2);expect(saved.filter(r=>r.role==='action-reservation')).toHaveLength(1);expect((await index(f)).sessions[0].uploads.find((u:any)=>u.purpose==='seal').state).toBe('cancelled');
});
for(const operation of ['abort','revoke'] as const)for(const scoped of [true,false])it('tracks '+operation+' and '+(scoped?'scope':'session')+' closure',async()=>{
 const f=await setup(),scopes=[scope,{...scope,invocation:'two'}],s=await active(f,scopes),r=await call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});
 await call(f,f.caller,{operation,sessionId:s.sessionId,...(scoped?{scope}:{}),expectedRevision:scoped?r.revision:s.revision,reason:'operator-request'});
 const saved=await index(f);expect(saved.sessions[0].summary.scopes[0].lifecycle).toBe('terminal');if(scoped)expect(saved.sessions[0].summary.scopes[1].lifecycle).toBe('planned');else expect(saved.sessions[0].summary.lifecycle).toBe('closed');
});
for(const boundary of ['before-dispatch','failed-operation','during-save','lookup'])it('persists expiry with reusable records at '+boundary,async()=>{
 const f=await setup(),s=await active(f);let armed=boundary==='during-save',advance=f.checkpoint.advance.bind(f.checkpoint);
 f.checkpoint.advance=async(a,b)=>{await advance(a,b);if(armed){armed=false;f.advance(600000);}};
 if(boundary==='before-dispatch'||boundary==='lookup')f.advance(600000);
 if(boundary==='failed-operation'){
  let n=0;f.config.now=()=>++n>=3?600000:0; // expiry occurs between outer admission and inner logical dispatch
  await expect(call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:99})).rejects.toThrow('not_current');
 }else if(boundary==='during-save')await expect(call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0})).rejects.toThrow('expired');
 else if(boundary==='lookup')expect(await call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope,expectedRevision:0})).toMatchObject({contractStatus:'session-unavailable'});
 else await expect(call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0})).rejects.toThrow('not_current');
 expect((await index(f)).sessions[0].summary.validity).toBe('expired');
});
it('restarts with new seals and preserves old terminals without restoring capabilities',async()=>{
 const f=await setup(),s=await active(f);await call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});
 const reopened=await AuthorityJournal.open({...identity,key:Buffer.alloc(32,3),io:f.io,checkpoint:f.checkpoint});const model=await OwnedAuthorityContract.restart({...f.config,journal:reopened});
 expect(model.snapshotMetrics.referenceComparisons).toBeGreaterThan(0);const records=await reopened.readLatest();expect(records.some(r=>r.role==='terminal-record')).toBe(true);expect(JSON.parse(records.find(r=>r.role==='session-index')!.bytes.toString()).sessions[0].summary.validity).toBe('restarted');
 await expect(call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0})).rejects.toThrow('generation_changed');
});
for(const mode of ['fake','foreign','reopened','stopped'] as const)it('rejects '+mode+' seals before committing',async()=>{
 const f=await setup(),record={id:'payload',role:'metadata-snapshot' as const,bytes:Buffer.from('private')},handle=f.journal.sealRecord(record);
 let target=f.journal,h=handle;
 if(mode==='fake')h=Object.freeze({}) as any;if(mode==='foreign')target=(await setup()).journal;
 if(mode==='reopened')target=await AuthorityJournal.open({...identity,key:Buffer.alloc(32,3),io:f.io,checkpoint:f.checkpoint});
 if(mode==='stopped'){f.io.files.delete('journal.meta');await expect(target.verifyHead()).rejects.toThrow();}
 const files=[...f.io.files.keys()];await expect(target.commitSealed({operationId:'bad',requestDigest:ownedSha256('bad'),records:[h]})).rejects.toThrow(mode==='stopped'?'recovery_required':'sealed_record_invalid');expect([...f.io.files.keys()]).toEqual(files);
});

it('reuses bound descriptors without copying or hashing the same sealed input again',async()=>{
 const f=await setup();await f.model.dispatchDurable(f.caller,f.begin());const raw=await f.journal.readLatest(),handles=raw.map(r=>f.journal.sealRecord(r)),before=f.journal.sealedRecordMetrics;
 await f.journal.commitSealed({operationId:'reused',requestDigest:ownedSha256('reused'),records:handles});
 expect(f.journal.sealedRecordMetrics.hashBytes).toBe(before.hashBytes);expect(f.journal.sealedRecordMetrics.copyBytes).toBe(before.copyBytes);expect(await f.journal.readLatest()).toEqual(raw);
});
it('does not share sealed chunk buffers with storage writers',async()=>{
 const f=await setup();await f.model.dispatchDurable(f.caller,f.begin());const raw=await f.journal.readLatest();raw.find(r=>r.role==='metadata-snapshot')?.bytes.fill(0);
 raw.push({id:'new',role:'metadata-snapshot',bytes:Buffer.from('new-private-data')});const handles=raw.map(r=>f.journal.sealRecord(r)),put=f.io.put.bind(f.io);
 f.io.put=async(n,b)=>{await put(n,b);b.fill(0);};await f.journal.commitSealed({operationId:'private-write',requestDigest:ownedSha256('private-write'),records:handles});
 expect(f.journal.materializeRecord(handles.at(-1)!).bytes.toString()).toBe('new-private-data');
});

it('rebuilds the same full wire format in reference mode and tolerates returned reply mutation',async()=>{
 const f=await setup(),s=await active(f),first=await call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});
 const request=f.command({operation:'revoke',sessionId:s.sessionId,scope,expectedRevision:first.revision,reason:'operator-request'});(f.config as any).snapshotMode='full-reference';
 const reply=await f.model.dispatchDurable(f.caller,request);reply.terminal.reason='caller-mutated';
 const again=await f.model.dispatchDurable(f.caller,request);expect(again.terminal.reason).toBe('operator-request');expect(again.historical).toBe(true);expect(f.model.snapshotMetrics.referenceComparisons).toBeGreaterThan(f.model.snapshotMetrics.builds);
});

for(const fault of ['blob','checkpoint'] as const)it('does not let reusable snapshot records hide a '+fault+' failure',async()=>{
 const f=await setup(),s=await active(f),before=f.model.snapshotMetrics.builds;
 if(fault==='blob'){const name=[...f.io.files.keys()].find(n=>n.startsWith('blob-'))!;const bytes=f.io.files.get(name)!;bytes[0]=bytes[0]!^1;}else f.checkpoint.read=async()=>{throw Error('unavailable');};
 let ack=0;const request=f.command({operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});await expect(f.model.dispatchDurable(f.caller,request).then(()=>ack++)).rejects.toThrow();expect(ack).toBe(0);expect(f.model.snapshotMetrics.builds).toBe(before);
 await expect(f.model.dispatchDurable(f.caller,request)).rejects.toThrow('recovery_required');
});
