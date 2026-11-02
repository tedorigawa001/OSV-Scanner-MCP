import {it,expect} from 'vitest';
import {createHmac} from 'node:crypto';
import {PrefixContract,sealPrefixReply} from '../fixtures/gradleOwnedPrefixContract.js';
import {ownedDigest,ownedSha256,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {v2StateSummary,v2Genesis,sealV2Commit,replayV2,type V2ReplayInput,type V2Record} from '../fixtures/gradleOwnedJournalV2.js';
const hash=(s:string)=>ownedSha256(s),binding={authorityId:'caller',lineageId:'lineage',storeEpoch:hash('epoch'),generation:1,profileDigest:hash('journal-profile')};
const baseRef={role:'compacted-base' as const,id:'base',sha256:hash('base'),byteLength:4},journalKey=Buffer.alloc(32,7),providerKey=Buffer.alloc(32,8);
function source(version=0,supplied?:V2Record[]){
 const records=supplied??[{key:{role:'session-manifest' as const,id:'root'},bytes:Buffer.from('manifest')},{key:{role:'session-index' as const,id:'root'},bytes:Buffer.from('index')},{key:{role:'event-ledger' as const,id:'scope'},bytes:Buffer.from(canonicalOwnedJson({events:[version]}))},{key:{role:'operation-result' as const,id:'root'},bytes:Buffer.from(canonicalOwnedJson({version}))}];
 const s=v2StateSummary(records),body={schema:'osv-mcp.gradle-owned-journal-commit-v2',schemaVersion:2,layout:'typed-flat-map-v1',...binding,baseRef,revision:1,previousCommit:v2Genesis(binding,baseRef),fromStateRoot:v2Genesis(binding,baseRef),...s.roots,usage:s.usage,operation:{id:'op-0',requestDigest:hash('op-0'),resultRef:s.records.find(r=>r.key.role==='operation-result')!.ref},recordMode:'full',records:s.records};
 const first=sealV2Commit(body,'journal',journalKey);return {binding,baseRef,keyId:'journal',key:Buffer.from(journalKey),approvedBaseDigest:ownedSha256(first),checkpoint:{revision:1,commitDigest:ownedSha256(first)},commits:[first],payloads:records.map(r=>r.bytes)} satisfies V2ReplayInput;
}
function setup(options:any={},initial?:V2ReplayInput){
 const data:V2ReplayInput=initial??source();let providerNow=0,readerNow=100000;
 const identity={...binding,providerId:'provider',providerBootId:'provider-boot',storeRootId:'store',checkpointRootId:'checkpoint',rootPairId:'pair',storageInstanceId:'storage',namespaceGeneration:1,fence:1,baseDigest:data.approvedBaseDigest,format:'v2-flat-contract',schemaDigest:hash('schema'),parserDigest:hash('parser'),providerProfileDigest:hash('provider-profile'),policyDigest:hash('policy'),registryRevision:1,checkpointIssuer:'checkpoint-issuer',checkpointKeyEpoch:1,providerKeyEpoch:1,proofMode:options.proofMode??'record'};
 const model=new PrefixContract({identity,keyId:'provider-key',key:providerKey,providerNow:()=>providerNow,readerNow:()=>readerNow,...options}),operator=model.principal('operator'),checkpoint=model.principal('checkpoint'),authority=model.principal('authority'),reader=model.principal('reader',{peerId:'reader',bootId:'reader-boot'});model.install(operator,data);
 return {model,operator,checkpoint,authority,reader,data,identity,tick:(n:number)=>{providerNow+=n;readerNow+=n;},providerTick:(n:number)=>providerNow+=n,readerTick:(n:number)=>readerNow+=n};
}
type F=ReturnType<typeof setup>;
function start(f:F,reader=f.reader){const request=f.model.begin(reader,hash('operation')),wire=f.model.acquire(reader,request),ticket=f.model.accept(reader,wire),candidate=f.model.verify(reader,ticket,f.data);return {request,wire,ticket,candidate};}
function finish(f:F,s:ReturnType<typeof start>,reader=f.reader){const cp=f.model.checkpoint(f.checkpoint,s.candidate),auth=f.model.authority(f.authority,s.candidate),complete=f.model.startComplete(reader,s.candidate,cp,auth),receipt=f.model.decide(reader,complete),delivery=f.model.deliver(reader,receipt),result=f.model.publish(reader,delivery);return {complete,receipt,delivery,result};}
it('reuses a verified prefix only after a fresh grant and all publication gates',()=>{
 const f=setup(),cold=finish(f,start(f));expect(cold.result).toMatchObject({wouldReusePrefix:false,backendEligible:false,originalReadsSkipped:0});f.model.release(f.reader,cold.delivery);
 const warm=finish(f,start(f));expect(warm.result).toMatchObject({wouldReusePrefix:true,backendEligible:false,diagnosticEligible:false,originalReadsSkipped:0});f.model.release(f.reader,warm.delivery);expect(f.model.metrics.fullVerifications).toBe(3);
});

it('retransmits one unfinished acquire without minting another grant or pin',()=>{
 const f=setup(),request=f.model.begin(f.reader,hash('op')),first=f.model.acquire(f.reader,request),again=f.model.acquire(f.reader,Buffer.from(request));expect(again).toEqual(first);expect(f.model.metrics.grants).toBe(1);expect(f.model.metrics.livePins).toBe(1);
});
it('cancels a locally expired use and preserves a committed proof for a fresh grant',()=>{
 const f=setup(),cold=finish(f,start(f));f.model.release(f.reader,cold.delivery);const next=start(f);f.readerTick(5000);
 expect(()=>finish(f,next)).toThrow('grant_expired');expect(f.model.status(f.reader,next.ticket).phase).toBe('expired');const retried=finish(f,start(f));expect(retried.result.wouldReusePrefix).toBe(true);
});

it('expires an unanswered challenge without exhausting its pending slot',()=>{
 const f=setup({limits:{pending:1}}),old=f.model.begin(f.reader,hash('op'));f.tick(5000);const fresh=f.model.begin(f.reader,hash('op'));expect(fresh).not.toEqual(old);
});

const replyBody=(wire:Buffer)=>JSON.parse(wire.toString()).body;
const forge=(body:any)=>sealPrefixReply(body,'provider-key',providerKey);
function append(input:V2ReplayInput):V2ReplayInput{
 const old=replayV2(input),revision=old.revision+1,bytes=Buffer.from(canonicalOwnedJson({version:revision})),records=old.records.map(r=>r.key.role==='operation-result'?{...r,bytes}:r),s=v2StateSummary(records),previous=JSON.parse(input.commits.at(-1)!.toString()).body;
 const body={...previous,revision,previousCommit:ownedSha256(input.commits.at(-1)!),fromStateRoot:old.stateRoot,...s.roots,usage:s.usage,operation:{id:'op-'+revision,requestDigest:hash('op-'+revision),resultRef:s.records.find(r=>r.key.role==='operation-result')!.ref},recordMode:'full',records:s.records};const next=sealV2Commit(body,input.keyId,input.key);return {...input,checkpoint:{revision,commitDigest:ownedSha256(next)},commits:[...input.commits,next],payloads:[...input.payloads,bytes]};
}
it('validates an exact immutable prefix extension under a new view and fence',()=>{
 const f=setup(),cold=finish(f,start(f));f.model.release(f.reader,cold.delivery);f.data=append(f.data);f.model.install(f.operator,f.data);const warm=finish(f,start(f));expect(warm.result.wouldReusePrefix).toBe(true);expect(replyBody(warm.receipt).head.revision).toBe(2);
});
for(const limits of [{suffixCommits:0},{suffixBytes:0},{suffixEntries:0}])it('declines an over-budget suffix before issuing a grant '+JSON.stringify(limits),()=>{
 const f=setup({limits}),cold=finish(f,start(f));f.model.release(f.reader,cold.delivery);f.data=append(f.data);f.model.install(f.operator,f.data);
 for(let i=0;i<2;i++){const request=f.model.begin(f.reader,hash('op')),wire=f.model.acquire(f.reader,request);expect(replyBody(wire)).toMatchObject({kind:'full-required',reason:'suffix_limit_exceeded'});expect(()=>f.model.accept(f.reader,wire)).toThrow('suffix_limit_exceeded');}expect(f.model.metrics.grants).toBe(1);expect(f.model.metrics.livePins).toBe(0);
});
for(const options of [{supported:false},{approved:false}])it('never issues grants without supported enrollment '+JSON.stringify(options),()=>{
 const f=setup(options),request=f.model.begin(f.reader,hash('op')),wire=f.model.acquire(f.reader,request);expect(replyBody(wire).kind).toBe('full-required');expect(()=>f.model.accept(f.reader,wire)).toThrow(/provider_unsupported|profile_unapproved/);expect(f.model.metrics.grants).toBe(0);expect(f.model.metrics.originalReadsSkipped).toBe(0);
});
for(const field of ['challenge','requestDigest','requestId','sequence','peer','reader-boot','inventory','head','manifest','extension','registry-pin','cached-key','deadline'] as const)it('rejects a signed response with wrong '+field,()=>{
 const f=setup(),request=f.model.begin(f.reader,hash('op')),wire=f.model.acquire(f.reader,request),body=replyBody(wire);
 if(['challenge','requestDigest','requestId','extension'].includes(field))body[field==='extension'?'extensionDigest':field]=hash('other');if(field==='sequence')body.sequence++;
 if(field==='peer')body.reader.peerId='other';if(field==='reader-boot')body.reader.bootId='other';if(field==='inventory')body.snapshot.inventoryRoot=hash('other');if(field==='head')body.snapshot.head.commitDigest=hash('other');if(field==='manifest')body.snapshot.manifestDigest=hash('other');if(field==='registry-pin')body.registryPin.revision++;if(field==='cached-key')body.cachedKey=hash('fake');if(field==='deadline')body.clock.expires++;
 expect(()=>f.model.accept(f.reader,forge(body))).toThrow(/binding_mismatch|receipt_invalid/);expect(()=>f.model.begin(f.reader,hash('new'))).toThrow('recovery_required');expect(f.model.metrics.published).toBe(0);
});
for(const field of ['authorityId','lineageId','storeEpoch','generation','profileDigest','providerId','providerBootId','storeRootId','checkpointRootId','rootPairId','storageInstanceId','namespaceGeneration','fence','baseDigest','schemaDigest','parserDigest','providerProfileDigest','policyDigest','registryRevision','checkpointIssuer','checkpointKeyEpoch','providerKeyEpoch','proofMode'] as const)it('binds grants and cache identity to '+field,()=>{
 const f=setup(),request=f.model.begin(f.reader,hash('op')),wire=f.model.acquire(f.reader,request),body=replyBody(wire),old=body.identity[field];body.identity[field]=typeof old==='number'?old+1:field==='proofMode'?'authority-audit':old.length===64?hash('other'):'other';expect(()=>f.model.accept(f.reader,forge(body))).toThrow('binding_mismatch');
});
for(const kind of ['mac','issuer','unknown','noncanonical','duplicate-key','utf8'] as const)it('rejects malformed wire '+kind,()=>{
 const f=setup(),request=f.model.begin(f.reader,hash('op'));let wire=f.model.acquire(f.reader,request),raw=JSON.parse(wire.toString());
 if(kind==='mac')raw.mac='1'.repeat(64);if(kind==='issuer')raw.keyId='unknown';if(kind==='unknown'){raw.body.extra=true;const {mac,...p}=raw;raw.mac=createHmac('sha256',providerKey).update(canonicalOwnedJson(p)).digest('hex');}wire=Buffer.from(canonicalOwnedJson(raw));
 if(kind==='noncanonical')wire=Buffer.from(wire.toString()+'\n');if(kind==='duplicate-key')wire=Buffer.from(wire.toString().replace('"keyId":','"keyId":"duplicate","keyId":'));if(kind==='utf8')wire=Buffer.from([255]);expect(()=>f.model.accept(f.reader,wire)).toThrow(/receipt_invalid|schema_invalid/);
});
it('rejects accepted challenge replay and an old response after a new request',()=>{
 const f=setup(),cold=start(f);expect(()=>f.model.accept(f.reader,cold.wire)).toThrow('challenge_replayed');expect(f.model.metrics.published).toBe(0);
 const g=setup(),old=finish(g,start(g));g.model.release(g.reader,old.delivery);g.model.begin(g.reader,hash('new'));expect(()=>g.model.deliver(g.reader,old.receipt)).toThrow();
});
for(const phase of ['active','completing','decision-recorded','delivering'] as const)it('expires and releases pins at '+phase+' without losing an old proof',()=>{
 const f=setup(),old=finish(f,start(f));f.model.release(f.reader,old.delivery);const s=start(f);let complete:Buffer|undefined,receipt:Buffer|undefined,delivery:any;
 if(phase!=='active')complete=f.model.startComplete(f.reader,s.candidate,f.model.checkpoint(f.checkpoint,s.candidate),f.model.authority(f.authority,s.candidate));if(phase==='decision-recorded'||phase==='delivering')receipt=f.model.decide(f.reader,complete!);if(phase==='delivering')delivery=f.model.deliver(f.reader,receipt!);
 f.providerTick(5000);expect(()=>phase==='active'?finish(f,s):phase==='completing'?f.model.decide(f.reader,complete!):phase==='decision-recorded'?f.model.deliver(f.reader,receipt!):f.model.publish(f.reader,delivery)).toThrow('grant_expired');expect(f.model.status(f.reader,s.ticket).phase).toBe('expired');expect(f.model.metrics.livePins).toBe(0);expect(finish(f,start(f)).result.wouldReusePrefix).toBe(true);
});
for(const phase of ['active','completing','decision-recorded','delivering'] as const)it('drains and fences a pin at '+phase,()=>{
 const f=setup(),s=start(f);let complete:any,receipt:any,delivery:any;if(phase!=='active')complete=f.model.startComplete(f.reader,s.candidate,f.model.checkpoint(f.checkpoint,s.candidate),f.model.authority(f.authority,s.candidate));if(phase==='decision-recorded'||phase==='delivering')receipt=f.model.decide(f.reader,complete);if(phase==='delivering')delivery=f.model.deliver(f.reader,receipt);
 f.model.drain(f.operator,'freeze');expect(()=>phase==='active'?finish(f,s):phase==='completing'?f.model.decide(f.reader,complete):phase==='decision-recorded'?f.model.deliver(f.reader,receipt):f.model.publish(f.reader,delivery)).toThrow();expect(f.model.status(f.reader,s.ticket).phase).toBe('cancelled');expect(f.model.metrics.livePins).toBe(0);f.model.finishBarrier(f.operator);expect(()=>f.model.begin(f.reader,hash('new'))).toThrow('control_unavailable');
});
for(const fault of ['unavailable','sync-incomplete','rollback','tail-unknown'] as const)it('keeps checkpoint gate mandatory with a warm proof: '+fault,()=>{
 const f=setup(),old=finish(f,start(f));f.model.release(f.reader,old.delivery);const s=start(f);f.model.control(f.operator,{checkpoint:fault});expect(()=>f.model.checkpoint(f.checkpoint,s.candidate)).toThrow('checkpoint_');expect(f.model.metrics.published).toBe(1);
});
for(const change of [{checkpoint:'unavailable'},{authority:'expired'},{authority:'revoked'},{available:false},{owner:false}] as const)it('rejects a changed final gate before publication '+JSON.stringify(change),()=>{
 const f=setup(),s=start(f),cp=f.model.checkpoint(f.checkpoint,s.candidate),a=f.model.authority(f.authority,s.candidate),complete=f.model.startComplete(f.reader,s.candidate,cp,a),receipt=f.model.decide(f.reader,complete),delivery=f.model.deliver(f.reader,receipt);f.model.control(f.operator,change);expect(()=>f.model.publish(f.reader,delivery)).toThrow();expect(f.model.metrics.published).toBe(0);
});
it('does not release a delivering pin before publication or let an old release touch a new use',()=>{
 const f=setup(),s=start(f),complete=f.model.startComplete(f.reader,s.candidate,f.model.checkpoint(f.checkpoint,s.candidate),f.model.authority(f.authority,s.candidate)),receipt=f.model.decide(f.reader,complete),delivery=f.model.deliver(f.reader,receipt);
 expect(()=>f.model.release(f.reader,delivery)).toThrow('handle_invalid');expect(()=>f.model.install(f.operator,f.data)).toThrow('pins_active');f.model.publish(f.reader,delivery);expect(()=>f.model.install(f.operator,f.data)).toThrow('pins_active');f.model.release(f.reader,delivery);
 const next=start(f);f.model.release(f.reader,delivery);expect(f.model.status(f.reader,next.ticket).phase).toBe('active');
});
it('retries a lost Complete response idempotently and returns only historical use lookups',()=>{
 const f=setup(),s=start(f),c=f.model.startComplete(f.reader,s.candidate,f.model.checkpoint(f.checkpoint,s.candidate),f.model.authority(f.authority,s.candidate)),a=f.model.decide(f.reader,c),b=f.model.decide(f.reader,c);expect(b).toEqual(a);const delivery=f.model.deliver(f.reader,b);f.model.publish(f.reader,delivery);expect(()=>f.model.publish(f.reader,delivery)).toThrow('lifecycle_invalid');f.model.release(f.reader,delivery);
 const body=replyBody(b);expect(f.model.lookupUse(f.reader,body.grantId,body.useId)).toMatchObject({historical:true,wouldReusePrefix:false,backendEligible:false});expect(()=>f.model.decide(f.reader,c)).toThrow();
});
it('rejects foreign or forged handles and checkpoint/authority roles',()=>{
 const f=setup(),s=start(f),other=f.model.principal('reader',{peerId:'other',bootId:'other-boot'}),foreign=start(f,other);
 expect(()=>f.model.verify(other,s.ticket,f.data)).toThrow('handle_invalid');expect(()=>f.model.checkpoint(f.reader,s.candidate)).toThrow('permission_denied');expect(()=>f.model.publish(f.reader,Object.freeze({}) as any)).toThrow('handle_invalid');
 expect(()=>f.model.startComplete(f.reader,s.candidate,f.model.checkpoint(f.checkpoint,foreign.candidate),f.model.authority(f.authority,s.candidate))).toThrow('gate_invalid');
});
for(const limit of ['cacheBytes','cacheEntries','cacheNodes','keyBytes'] as const)it('falls back to an empty cache when '+limit+' is exhausted',()=>{
 const f=setup({limits:{[limit]:0}}),r=finish(f,start(f));expect(r.result.cachedProofStored).toBe(false);expect(r.result.wouldReusePrefix).toBe(false);expect(f.model.metrics.cacheBytes).toBe(0);f.model.release(f.reader,r.delivery);expect(finish(f,start(f)).result.wouldReusePrefix).toBe(false);
});
it('evicts normally and verifies every candidate rather than skipping original input',()=>{
 const f=setup(),first=finish(f,start(f));f.model.release(f.reader,first.delivery);f.model.evict(f.reader);expect(finish(f,start(f)).result.wouldReusePrefix).toBe(false);expect(f.model.metrics.originalReadsSkipped).toBe(0);expect(f.model.metrics.fullVerifications).toBe(3);
});
it('rejects tampered candidate bytes instead of silently falling back to full',()=>{
 const f=setup(),cold=finish(f,start(f));f.model.release(f.reader,cold.delivery);const q=f.model.begin(f.reader,hash('op')),ticket=f.model.accept(f.reader,f.model.acquire(f.reader,q)),data={...f.data,payloads:f.data.payloads.map(b=>Buffer.from(b))};data.payloads[0]!.fill(0);expect(()=>f.model.verify(f.reader,ticket,data)).toThrow('content_mismatch');expect(()=>f.model.begin(f.reader,hash('new'))).toThrow('recovery_required');expect(f.model.metrics.cacheBytes).toBe(0);
});
it('bounds pending requests, retained use history and installed source bytes',()=>{
 const f=setup({limits:{pending:1,requests:1}}),other=f.model.principal('reader',{peerId:'other',bootId:'b'});f.model.begin(f.reader,hash('op'));expect(()=>f.model.begin(other,hash('op'))).toThrow('budget_exceeded');f.tick(5000);const done=finish(f,start(f));f.model.release(f.reader,done.delivery);const q=f.model.begin(f.reader,hash('op'));expect(()=>f.model.acquire(f.reader,q)).toThrow('budget_exceeded');
 expect(()=>setup({limits:{sourceBytes:1}})).toThrow('budget_exceeded');expect(()=>setup({limits:{pending:65}})).toThrow('configuration_invalid');
});

it('drops ended pin payload ownership instead of retaining all old snapshots as use history',()=>{
 const f=setup({limits:{cacheBytes:0}}),old=finish(f,start(f));f.model.release(f.reader,old.delivery);f.data=append(f.data);f.model.install(f.operator,f.data);
 expect(f.model.metrics.retainedPayloadBytes).toBe(f.data.commits.reduce((n,b)=>n+b.length,0)+f.data.payloads.reduce((n,b)=>n+b.length,0));
});
it('enforces the configured wire limit before accepting a pending request',()=>{
 const f=setup({limits:{wireBytes:1}});expect(()=>f.model.begin(f.reader,hash('op'))).toThrow('budget_exceeded');expect(f.model.metrics.livePins).toBe(0);
});

for(const cp of ['unavailable','sync-incomplete','rollback','tail-unknown'] as const)it('does not issue a positive grant with checkpoint state '+cp,()=>{
 const f=setup();f.model.control(f.operator,{checkpoint:cp});const request=f.model.begin(f.reader,hash('op'));expect(()=>f.model.acquire(f.reader,request)).toThrow('checkpoint_');expect(f.model.metrics.grants).toBe(0);
});
it('fences disconnected peers and does not transfer proof to another reader boot',()=>{
 const f=setup(),old=finish(f,start(f));f.model.release(f.reader,old.delivery);const pending=start(f);f.model.disconnect(f.operator,f.reader);expect(f.model.status(f.reader,pending.ticket).phase).toBe('cancelled');expect(()=>finish(f,pending)).toThrow();
 const next=f.model.principal('reader',{peerId:'reader',bootId:'fresh-boot'});expect(finish(f,start(f,next),next).result.wouldReusePrefix).toBe(false);
});
for(const patch of [{providerBootId:'new-boot'},{parserDigest:hash('new-parser')},{policyDigest:hash('new-policy')},{registryRevision:2},{checkpointKeyEpoch:2},{providerKeyEpoch:2}] as const)it('invalidates old proof and handles on context change '+JSON.stringify(patch),()=>{
 const f=setup(),old=finish(f,start(f));f.model.release(f.reader,old.delivery);const pending=start(f);f.model.rotate(f.operator,patch);expect(()=>finish(f,pending)).toThrow();expect(f.model.metrics.cacheBytes).toBe(0);f.model.install(f.operator,f.data);expect(finish(f,start(f)).result.wouldReusePrefix).toBe(false);
});
it('owns signing keys and input bytes independently of their caller buffers',()=>{
 const signingKey=Buffer.from(providerKey),f=setup({key:signingKey}),data={...f.data,key:Buffer.from(f.data.key),commits:f.data.commits.map(b=>Buffer.from(b)),payloads:f.data.payloads.map(b=>Buffer.from(b))};signingKey.fill(0);f.data.key.fill(0);f.data.commits[0]!.fill(0);f.data.payloads[0]!.fill(0);
 const request=f.model.begin(f.reader,hash('op')),ticket=f.model.accept(f.reader,f.model.acquire(f.reader,request)),candidate=f.model.verify(f.reader,ticket,data);expect(finish(f,{request,wire:Buffer.alloc(0),ticket,candidate}).result.wouldReusePrefix).toBe(false);
});
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
it('requires actual authority audit verification for authority-audit proof mode',async()=>{
 expect(()=>setup({proofMode:'authority-audit'})).toThrow();
 const identity={authorityId:'caller',storeEpoch:hash('source-v1'),keyId:'source'},io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity)),journal=await AuthorityJournal.create({...identity,key:Buffer.alloc(32,3),io,checkpoint}),policy=ownedPolicyFixture();
 const model=new OwnedAuthorityContract({authorityId:'caller',journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',policy.claim.profileDigest),registry:createOwnedRegistry(policy.raw)}}),caller=model.principal('caller');await model.dispatchDurable(caller,{schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'begin',operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:hash('settings'),scopeRequestsDigest:ownedDigest([])});
 const records=(await journal.readLatest()).map(r=>({key:{role:r.role,id:r.id},bytes:r.bytes})),f=setup({proofMode:'authority-audit'},source(0,records));const cold=finish(f,start(f));f.model.release(f.reader,cold.delivery);expect(finish(f,start(f)).result.wouldReusePrefix).toBe(true);
});

it('keeps a pinned private proof charged until delivery even when its cache entry is evicted',()=>{
 const f=setup(),old=finish(f,start(f));f.model.release(f.reader,old.delivery);const pending=start(f),bytes=f.model.metrics.cacheBytes;f.model.evict(f.reader);expect(f.model.metrics.cacheBytes).toBe(bytes);expect(finish(f,pending).result.wouldReusePrefix).toBe(true);
});

it('does not publish a candidate when the local deadline is reached during final preparation',()=>{
 let armed=false,reads=0;const f=setup({readerNow:()=>{if(armed)reads++;return armed&&reads>=3?105000:100000;}}),s=start(f),complete=f.model.startComplete(f.reader,s.candidate,f.model.checkpoint(f.checkpoint,s.candidate),f.model.authority(f.authority,s.candidate)),receipt=f.model.decide(f.reader,complete),delivery=f.model.deliver(f.reader,receipt);armed=true;
 expect(()=>f.model.publish(f.reader,delivery)).toThrow('grant_expired');expect(f.model.metrics.published).toBe(0);expect(f.model.metrics.cacheBytes).toBe(0);
});

it('rejects an authenticated fork at source publication even after the proof cache is evicted',()=>{
 const f=setup();f.data=append(f.data);f.model.install(f.operator,f.data);f.model.evict(f.reader);const fork:V2ReplayInput={...f.data,commits:f.data.commits.map(b=>Buffer.from(b)),checkpoint:{...f.data.checkpoint}},body=JSON.parse(fork.commits[1]!.toString()).body;body.operation.id='fork';body.operation.requestDigest=hash('fork');fork.commits[1]=sealV2Commit(body,fork.keyId,fork.key);fork.checkpoint.commitDigest=ownedSha256(fork.commits[1]!);expect(()=>f.model.install(f.operator,fork)).toThrow('inventory_mismatch');expect(finish(f,start(f)).result.wouldReusePrefix).toBe(false);
});
