import {createHmac} from 'node:crypto';
import {it,expect} from 'vitest';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {sealV2Commit,replayV2,v2StateSummary,v2Genesis,V2_LIMITS,type V2Record} from '../fixtures/gradleOwnedJournalV2.js';
const binding={authorityId:'caller',lineageId:'lineage',storeEpoch:ownedSha256('epoch-v2'),generation:1,profileDigest:ownedSha256('flat-v2-contract')},key=Buffer.alloc(32,42),keyId='v2-test';
const baseRef={role:'compacted-base' as const,id:'base',sha256:ownedSha256('base'),byteLength:4};
const records=(version=0):V2Record[]=>[
 {key:{role:'session-manifest',id:'root'},bytes:Buffer.from('manifest')},
 {key:{role:'event-ledger',id:'scope'},bytes:Buffer.from(canonicalOwnedJson({events:[version]}))},
 {key:{role:'session-index',id:'root'},bytes:Buffer.from('index')},
 {key:{role:'operation-result',id:'root'},bytes:Buffer.from(canonicalOwnedJson({version}))},
];
function full(rs=records(),revision=1,previousCommit=v2Genesis(binding,baseRef),fromStateRoot=v2Genesis(binding,baseRef)){
 const summary=v2StateSummary(rs);return {schema:'osv-mcp.gradle-owned-journal-commit-v2',schemaVersion:2,layout:'typed-flat-map-v1',...binding,baseRef,revision,previousCommit,fromStateRoot,...summary.roots,usage:summary.usage,operation:{id:'op-'+revision,requestDigest:ownedSha256('op-'+revision),resultRef:summary.records.find(r=>r.key.role==='operation-result')!.ref},recordMode:'full',records:summary.records};
}
function replay(commits:Buffer[],rs:V2Record[]){return replayV2({binding,baseRef,keyId,key,approvedBaseDigest:ownedSha256(commits[0]!),checkpoint:{revision:commits.length,commitDigest:ownedSha256(commits.at(-1)!)},commits,payloads:rs.map(r=>r.bytes)});}
it('replays an explicitly pinned full v2 base without changing record bytes or order inside payloads',()=>{
 const rs=records(),commit=sealV2Commit(full(rs),keyId,key),result=replay([commit],rs);
 expect(result).toMatchObject({backendEligible:false,diagnosticEligible:false,controlClosureVerified:false,physicalDeletionAuthorized:false,format:'v2-flat-contract',revision:1});
 expect(result.records.find(r=>r.key.role==='event-ledger')!.bytes).toEqual(rs[1]!.bytes);
 expect(result.stateRoot).toBe(v2StateSummary(rs).roots.toStateRoot);
});

it('applies exact-old-ref delta updates and retains bytes removed by upload freeze',()=>{
 const old=[...records(),{key:{role:'metadata-snapshot' as const,id:'partial'},bytes:Buffer.from('partial')}],next=[...records(1),{key:{role:'metadata-snapshot' as const,id:'frozen'},bytes:Buffer.from('complete')}];
 const first=sealV2Commit(full(old),keyId,key),a=v2StateSummary(old),b=v2StateSummary(next),body:any=full(next,2,ownedSha256(first),a.roots.toStateRoot);delete body.records;body.recordMode='delta';
 const before=new Map(a.records.map(r=>[canonicalOwnedJson(r.key),r])),after=new Map(b.records.map(r=>[canonicalOwnedJson(r.key),r]));
 body.changes=[...new Set([...before.keys(),...after.keys()])].sort().flatMap<any>(k=>{const x=before.get(k),y=after.get(k);if(!x)return [{op:'add',key:y!.key,ref:y!.ref}];if(!y)return [{op:'remove',key:x.key,expectedOldRef:x.ref}];if(canonicalOwnedJson(x.ref)===canonicalOwnedJson(y.ref))return [];return [{op:'replace',key:y.key,expectedOldRef:x.ref,ref:y.ref}];});
 const second=sealV2Commit(body,keyId,key),result=replay([first,second],[...old,...next]);
 expect(result.stateRoot).toBe(b.roots.toStateRoot);expect(result.retainedPayloads).toContain(ownedSha256('partial'));expect(result.records.some(r=>r.key.id==='partial')).toBe(false);expect(result.physicalDeletionAuthorized).toBe(false);
});

const rawSeal=(body:any)=>{const payload={schema:'osv-mcp.gradle-owned-journal-v2-envelope',keyId,body};return Buffer.from(canonicalOwnedJson({...payload,mac:createHmac('sha256',key).update(canonicalOwnedJson(payload)).digest('hex')}));};
function deltaBody(old:V2Record[],next:V2Record[],revision:number,previousCommit:string){
 const a=v2StateSummary(old),b=v2StateSummary(next),body:any=full(next,revision,previousCommit,a.roots.toStateRoot);delete body.records;body.recordMode='delta';
 const before=new Map(a.records.map(r=>[canonicalOwnedJson(r.key),r])),after=new Map(b.records.map(r=>[canonicalOwnedJson(r.key),r]));
 body.changes=[...new Set([...before.keys(),...after.keys()])].sort().flatMap<any>(k=>{const x=before.get(k),y=after.get(k);if(!x)return [{op:'add',key:y!.key,ref:y!.ref}];if(!y)return [{op:'remove',key:x.key,expectedOldRef:x.ref}];if(canonicalOwnedJson(x.ref)===canonicalOwnedJson(y.ref))return [];return [{op:'replace',key:y.key,expectedOldRef:x.ref,ref:y.ref}];});return body;
}
for(const fault of ['from-root','to-root','parent','revision','authority','lineage','epoch','generation','profile','base-ref','namespace-root','index-root','budget-root','usage','result-ref','operation-replay','old-digest','old-size','duplicate-change','unordered-change','replace-absent','add-existing'] as const)it('rejects authenticated inconsistent delta: '+fault,()=>{
 const a=records(),b=records(1),first=sealV2Commit(full(a),keyId,key),body=deltaBody(a,b,2,ownedSha256(first)),other=ownedSha256('other');
 if(fault==='from-root')body.fromStateRoot=other;if(fault==='to-root')body.toStateRoot=other;if(fault==='parent')body.previousCommit=other;if(fault==='revision')body.revision=3;
 if(fault==='authority')body.authorityId='another';if(fault==='lineage')body.lineageId='another';if(fault==='epoch')body.storeEpoch=other;if(fault==='generation')body.generation=2;if(fault==='profile')body.profileDigest=other;if(fault==='base-ref')body.baseRef.id='another';
 if(fault==='namespace-root')body.namespaceRoot=other;if(fault==='index-root')body.indexRoot=other;if(fault==='budget-root')body.budgetRoot=other;if(fault==='usage')body.usage.logicalBytes++;
 if(fault==='result-ref')body.operation.resultRef.sha256=other;if(fault==='operation-replay')body.operation.id='op-1';
 if(fault==='old-digest')body.changes[0].expectedOldRef.sha256=other;if(fault==='old-size')body.changes[0].expectedOldRef.byteLength++;
 if(fault==='duplicate-change')body.changes.push(body.changes[0]);if(fault==='unordered-change')body.changes.reverse();
 if(fault==='replace-absent')body.changes[0].key.id='absent';if(fault==='add-existing'){delete body.changes[0].expectedOldRef;body.changes[0].op='add';}
 expect(()=>replay([first,rawSeal(body)],[...a,...b])).toThrow(/journal_v2_/);
});
for(const fault of ['unknown','nested-unknown','mixed-modes','missing-mode','v1','unknown-layout','unknown-role','json-pointer','duplicate-full-key','unordered-full','missing-required','missing-payload','wrong-payload','orphan-payload','mac','noncanonical','duplicate-json-key','utf8','base-delta'] as const)it('rejects malformed base or payload: '+fault,()=>{
 const rs=records(),body:any=full(rs);let payloads=rs,encoded:Buffer;
 if(fault==='unknown')body.unknown=true;if(fault==='nested-unknown')body.records[0].ref.url='https://untrusted.invalid/';if(fault==='mixed-modes')body.changes=[];if(fault==='missing-mode')delete body.recordMode;
 if(fault==='v1'){body.schema='osv-mcp.gradle-owned-journal-commit-v1';body.schemaVersion=1;}if(fault==='unknown-layout')body.layout='unknown';if(fault==='unknown-role')body.records[0].key.role='unknown';if(fault==='json-pointer')body.records[0].key={path:'/sessions/a'};
 if(fault==='duplicate-full-key')body.records.push(body.records[0]);if(fault==='unordered-full')body.records.reverse();if(fault==='missing-required')body.records=body.records.filter((r:any)=>r.key.role!=='session-manifest');
 if(fault==='missing-payload')payloads=rs.slice(1);if(fault==='wrong-payload')payloads=[{...rs[0]!,bytes:Buffer.from('wrong')},...rs.slice(1)];if(fault==='orphan-payload')payloads=[...rs,{key:{role:'metadata-snapshot',id:'orphan'},bytes:Buffer.from('orphan')}];
 if(fault==='base-delta'){body.recordMode='delta';body.changes=[];delete body.records;}
 encoded=rawSeal(body);
 if(fault==='mac'){const raw=JSON.parse(encoded.toString());raw.mac='1'.repeat(64);encoded=Buffer.from(canonicalOwnedJson(raw));}
 if(fault==='noncanonical')encoded=Buffer.from(encoded.toString()+'\n');if(fault==='duplicate-json-key')encoded=Buffer.from(encoded.toString().replace('"keyId":', '"keyId":"duplicate","keyId":'));if(fault==='utf8')encoded=Buffer.from([255]);
 expect(()=>replay([encoded],payloads)).toThrow(/journal_v2_/);
});
for(const field of ['approved-base','checkpoint-head','checkpoint-revision','key','key-id'] as const)it('requires independent pins: '+field,()=>{
 const rs=records(),first=sealV2Commit(full(rs),keyId,key),input:any={binding,baseRef,keyId,key,approvedBaseDigest:ownedSha256(first),checkpoint:{revision:1,commitDigest:ownedSha256(first)},commits:[first],payloads:rs.map(r=>r.bytes)};
 if(field==='approved-base')input.approvedBaseDigest=ownedSha256('other');if(field==='checkpoint-head')input.checkpoint.commitDigest=ownedSha256('other');if(field==='checkpoint-revision')input.checkpoint.revision=2;if(field==='key')input.key=Buffer.alloc(32,7);if(field==='key-id')input.keyId='other';
 expect(()=>replayV2(input)).toThrow(/journal_v2_/);
});
for(const mode of ['full','delta'] as const)for(const role of ['terminal-record','action-reservation','tombstone-core','retire-receipt','control-object','maintenance-record'] as const)it('does not remove protected '+role+' through '+mode,()=>{
 const a=[...records(),{key:{role,id:'protected'},bytes:Buffer.from('protected')}],b=records(1),first=sealV2Commit(full(a),keyId,key),body=mode==='full'?full(b,2,ownedSha256(first),v2StateSummary(a).roots.toStateRoot):deltaBody(a,b,2,ownedSha256(first));
 expect(()=>replay([first,rawSeal(body)],[...a,...b])).toThrow('removal_unsupported');
});
for(const mode of ['full','delta'] as const)for(const role of ['terminal-record','maintenance-record'] as const)it('does not replace immutable '+role+' through '+mode,()=>{
 const a=[...records(),{key:{role,id:'protected'},bytes:Buffer.from('success')}],b=[...records(1),{key:{role,id:'protected'},bytes:Buffer.from('invalid')}],first=sealV2Commit(full(a),keyId,key),body=mode==='full'?full(b,2,ownedSha256(first),v2StateSummary(a).roots.toStateRoot):deltaBody(a,b,2,ownedSha256(first));
 expect(()=>replay([first,rawSeal(body)],[...a,...b])).toThrow('immutable_record_changed');
});
it('verifies every delta prefix against an independently updated full record list',()=>{
 let state=records(),first=sealV2Commit(full(state),keyId,key),commits=[first],history=[...state];
 for(let i=1;i<=24;i++){
  const next=[...records(i),{key:{role:'metadata-snapshot' as const,id:'upload-'+i%3},bytes:Buffer.from('metadata-'+i)}];
  const body=deltaBody(state,next,i+1,ownedSha256(commits.at(-1)!));commits.push(sealV2Commit(body,keyId,key));history.push(...next);state=next;
  const actual=replay(commits,history),expected=v2StateSummary(state);expect(actual.stateRoot).toBe(expected.roots.toStateRoot);expect(actual.states.at(-1)!.records).toEqual(expected.records);
  for(const r of state)expect(actual.records.find(a=>canonicalOwnedJson(a.key)===canonicalOwnedJson(r.key))!.bytes).toEqual(r.bytes);
 }
});
it('does not share payload or returned state aliases across replays',()=>{
 const rs=records(),first=sealV2Commit(full(rs),keyId,key),result=replay([first],rs);result.records[0]!.bytes.fill(0);result.states[0]!.records[0]!.key.id='mutated';
 expect(replay([first],rs).stateRoot).toBe(v2StateSummary(rs).roots.toStateRoot);expect(rs[0]!.bytes.toString()).toBe('manifest');
 rs[0]!.bytes.fill(0);expect(()=>replay([first],rs)).toThrow('payload_missing');
});
it('bounds commit history, payload count and individual input before work',()=>{
 const rs=records(),first=sealV2Commit(full(rs),keyId,key),input={binding,baseRef,keyId,key,approvedBaseDigest:ownedSha256(first),checkpoint:{revision:1,commitDigest:ownedSha256(first)},commits:[first],payloads:rs.map(r=>r.bytes)};
 expect(()=>replayV2({...input,commits:Array(V2_LIMITS.commits+1).fill(first)})).toThrow('budget_exceeded');expect(()=>replayV2({...input,payloads:Array(V2_LIMITS.payloads+1).fill(Buffer.alloc(0))})).toThrow('budget_exceeded');expect(()=>replayV2({...input,commits:[Buffer.alloc(V2_LIMITS.envelopeBytes+1)]})).toThrow('budget_exceeded');
});

import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
import {graphFixture} from '../fixtures/gradleGraphFixture.js';
import {decodeAuthoritySnapshot} from '../fixtures/gradleOwnedAuthoritySnapshot.js';
it('materializes real A1 snapshots with the same binding, ledger, terminal, expiry and retry outcomes',async()=>{
 const identity={authorityId:binding.authorityId,storeEpoch:ownedSha256('v1-source'),keyId:'source'},io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity)),journal=await AuthorityJournal.create({...identity,key:Buffer.alloc(32,3),io,checkpoint}),f=ownedPolicyFixture();let now=0;
 const config={authorityId:identity.authorityId,journal,now:()=>now,limits:{chunkBytes:1024},verifySnapshotReuse:true,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)}};
 const model=new OwnedAuthorityContract(config),caller=model.principal('caller'),reader=model.principal('reader'),scope={project:'main::',context:'runtime',invocation:'invocation'};let seq=0,prior:V2Record[]=[];const commits:Buffer[]=[],payloads=new Map<string,Buffer>();
 async function capture(){
  const raw=await journal.readLatest(),next:V2Record[]=raw.map(r=>({key:{role:r.role,id:r.id},bytes:r.bytes}));for(const r of next)payloads.set(ownedSha256(r.bytes),r.bytes);
  const revision=commits.length+1,body:any=revision===1?full(next):revision%3===0?full(next,revision,ownedSha256(commits.at(-1)!),v2StateSummary(prior).roots.toStateRoot):deltaBody(prior,next,revision,ownedSha256(commits.at(-1)!));
  const original=JSON.parse(io.files.get('commit-'+String(journal.head.revision).padStart(8,'0')+'.json')!.toString()).body;body.operation.id=original.operationId;body.operation.requestDigest=original.requestDigest;
  commits.push(sealV2Commit(body,keyId,key));const actual=replayV2({binding,baseRef,keyId,key,approvedBaseDigest:ownedSha256(commits[0]!),checkpoint:{revision,commitDigest:ownedSha256(commits.at(-1)!)},commits,payloads:[...payloads.values()],auditAuthoritySnapshot:true});
  expect(actual.authorityAudit).toEqual(decodeAuthoritySnapshot(raw,identity.authorityId));for(const r of next)expect(actual.records.find(x=>canonicalOwnedJson(x.key)===canonicalOwnedJson(r.key))!.bytes).toEqual(r.bytes);prior=next;
 }
 const command=(p:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'a1-'+(++seq),...p});
 const call=async(actor:object,p:any)=>{const r=await model.dispatchDurable(actor,command(p));await capture();return r;};
 const begin=command({operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest([scope])}),s=await model.dispatchDurable(caller,begin);await capture();
 const core=graphFixture();const bytes=Buffer.from(canonicalOwnedJson(core));let ref:any;
 for(let ordinal=0;ordinal<Math.ceil(bytes.length/1024);ordinal++){const part=bytes.subarray(ordinal*1024,(ordinal+1)*1024);ref=(await call(caller,{operation:'put-metadata-chunk',sessionId:s.sessionId,uploadId:s.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64')})).ref;}
 let bound=await call(caller,{operation:'bind-core',sessionId:s.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedSha256(bytes),rootRegistryDigest:ownedSha256('root'),scopes:[{...scope,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}]});
 await call(caller,{operation:'activate',sessionId:s.sessionId,expectedRevision:bound.revision,expectedCurrentRevision:0});let r=await call(caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});const broker=model.principal('broker',s.sessionId,scope),observer=model.principal('observer',s.sessionId,scope);
 r=await call(broker,{operation:'append-event',sessionId:s.sessionId,scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}});
 r=await call(observer,{operation:'append-event',sessionId:s.sessionId,scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'execution-observation',lookup:{status:'unavailable',reason:'receipt-missing'},leases:[]}});
 r=await call(broker,{operation:'seal-scope',phase:'prepare',sessionId:s.sessionId,scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead});r=await call(broker,{operation:'seal-scope',phase:'commit',sessionId:s.sessionId,scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead});expect(r.terminal.outcome).toBe('unavailable');
 const count=commits.length,head=journal.head;expect(await model.dispatchDurable(caller,begin)).toMatchObject({historical:true});expect(journal.head).toEqual(head);expect(commits).toHaveLength(count);
 now=600000;expect(await model.dispatchDurable(reader,command({operation:'lookup',sessionId:s.sessionId,scope,expectedRevision:0}))).toMatchObject({contractStatus:'session-unavailable'});await capture();
 await OwnedAuthorityContract.restart(config);await capture();expect(commits.length).toBeGreaterThan(10);
});

it('charges retained old payloads and refuses their absence even when the latest full state is present',()=>{
 const a=records(),b=records(1),first=sealV2Commit(full(a),keyId,key),second=sealV2Commit(full(b,2,ownedSha256(first),v2StateSummary(a).roots.toStateRoot),keyId,key),result=replay([first,second],[...a,...b]);
 const unique=new Map([...a,...b].map(r=>[ownedSha256(r.bytes),r.bytes.length]));expect(result.storageUsage.retainedPayloadBytes).toBe([...unique.values()].reduce((a,b)=>a+b,0));expect(result.storageUsage.totalBytes).toBe(result.storageUsage.retainedPayloadBytes+first.length+second.length);expect(result.storageUsage.payloads).toBe(unique.size);
 expect(()=>replay([first,second],b)).toThrow('payload_missing');
});
it('keeps explicit v1 and v2 format boundaries in both readers',async()=>{
 const rs=records(),first=sealV2Commit(full(rs),keyId,key),identity={authorityId:binding.authorityId,storeEpoch:ownedSha256('v1'),keyId},io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity)),journal=await AuthorityJournal.create({...identity,key,io,checkpoint});
 await journal.commit({operationId:'source',requestDigest:ownedSha256('source'),records:rs.map(r=>({role:r.key.role as any,id:r.key.id,bytes:r.bytes}))});
 const v1=io.files.get('commit-00000001.json')!;expect(()=>replay([v1],rs)).toThrow('schema_invalid');io.files.set('commit-00000001.json',first);await expect(journal.readLatest()).rejects.toThrow('record_invalid');
});

it('keeps record-level consistency separate from authority snapshot semantics',()=>{
 const rs=records(),first=sealV2Commit(full(rs),keyId,key),input={binding,baseRef,keyId,key,approvedBaseDigest:ownedSha256(first),checkpoint:{revision:1,commitDigest:ownedSha256(first)},commits:[first],payloads:rs.map(r=>r.bytes)};
 expect(replayV2(input).backendEligible).toBe(false);expect(()=>replayV2({...input,auditAuthoritySnapshot:true})).toThrow(/journal_v2_/);
});
