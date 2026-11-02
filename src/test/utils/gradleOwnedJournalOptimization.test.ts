import {it,expect} from 'vitest';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis,type JournalConfig,type JournalRecord,type JournalIO} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {ownedSha256} from '../../utils/gradleOwnedJson.js';
const identity={authorityId:'authority',storeEpoch:ownedSha256('po1-epoch'),keyId:'key'},key=Buffer.alloc(32,8);
const payload=Buffer.alloc(512*1024,47);
const records=(version:number):JournalRecord[]=>[
 {id:'manifest',role:'session-manifest',bytes:Buffer.from('manifest')},
 {id:'index',role:'session-index',bytes:Buffer.from('index')},
 {id:'ledger',role:'event-ledger',bytes:Buffer.from('ledger-'+version)},
 {id:'result',role:'operation-result',bytes:Buffer.from('result-'+version)},
 {id:'payload',role:'metadata-snapshot',bytes:payload},
];
async function fixture(options:Partial<JournalConfig>={}){
 const io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity)),config={...identity,key,io,checkpoint,...options};
 const journal=await AuthorityJournal.create(config);for(let i=0;i<4;i++)await journal.commit({operationId:'op-'+i,requestDigest:ownedSha256('op-'+i),records:records(i)});
 return {io,checkpoint,config,journal};
}
it('reuses repeated content only within one complete verification',async()=>{
 const f=await fixture();expect(await f.journal.verifyHead()).toEqual(f.journal.head);
 const first=f.journal.verificationMetrics!;const exposed=f.journal.verificationMetrics!;exposed.memoHits=-1;expect(f.journal.verificationMetrics!.memoHits).toBeGreaterThanOrEqual(0);expect(first.recordChecks).toBe(20);expect(first.memoHits).toBeGreaterThanOrEqual(3);expect(first.recordHashBytes).toBeLessThan(payload.length*2);
 await f.journal.verifyHead();expect(f.journal.verificationMetrics).toEqual(first);
 const actual=await f.journal.readLatest();expect(actual.find(r=>r.id==='payload')!.bytes.equals(payload)).toBe(true);
});

import {canonicalOwnedJson,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {sealJournalValue} from '../fixtures/gradleOwnedAuthorityJournal.js';
function rewriteLast(f:Awaited<ReturnType<typeof fixture>>,change:(body:any)=>void){
 const name='commit-00000004.json',raw=JSON.parse(f.io.files.get(name)!.toString());change(raw.body);raw.body.inputDigest=ownedDigest(raw.body.records);
 const encoded=sealJournalValue(raw.body,identity.keyId,key);f.io.files.set(name,encoded);f.checkpoint.value.headDigest=ownedSha256(encoded);
}
it('head-only verifies the same history but materializes no output records',async()=>{
 const f=await fixture();const head=await f.journal.verifyHead();expect(head).toEqual(f.journal.head);expect(f.journal.verificationMetrics!.returnedRecordBytes).toBe(0);
 head.revision=99;expect((await f.journal.verifyHead()).revision).toBe(4);
 expect((await f.journal.readLatest()).find(r=>r.id==='payload')!.bytes.equals(payload)).toBe(true);expect(f.journal.verificationMetrics!.returnedRecordBytes).toBeGreaterThan(payload.length);
 await expect(f.journal.verifyHead(journalGenesis(identity))).rejects.toThrow('revision_conflict');expect((await f.journal.verifyHead()).revision).toBe(4);
});
for(const options of [{contentMemoEntries:0},{contentMemoEntries:1},{contentMemoKeyBytes:1},{contentMemoEntries:2,contentMemoKeyBytes:160}])it('bounds the memo and falls back to full content checks: '+JSON.stringify(options),async()=>{
 const cached=await fixture(),bounded=await fixture(options);expect(await bounded.journal.verifyHead()).toEqual(await cached.journal.verifyHead());
 const metrics=bounded.journal.verificationMetrics!;expect(metrics.peakMemoEntries).toBeLessThanOrEqual(options.contentMemoEntries??4096);expect(metrics.peakMemoKeyBytes).toBeLessThanOrEqual(options.contentMemoKeyBytes??8*1024*1024);
 expect(metrics.recordHashBytes).toBeGreaterThanOrEqual(cached.journal.verificationMetrics!.recordHashBytes);
 if(options.contentMemoEntries===1||options.contentMemoEntries===2)expect(metrics.memoEvictions).toBeGreaterThan(0);
 if(options.contentMemoEntries===0||options.contentMemoKeyBytes===1){expect(metrics.memoHits).toBe(0);expect(metrics.recordHashChecks).toBe(metrics.recordChecks);}
});
it('does not reuse proof for a reordered chunk list with the same whole digest and size',async()=>{
 const big=Buffer.concat([Buffer.alloc(1024*1024,1),Buffer.alloc(1024*1024,2)]),f=await fixture();
 // Rebuild an independent history with a multi-chunk repeated payload.
 const io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity)),config={...identity,key,io,checkpoint},j=await AuthorityJournal.create(config);
 for(let i=0;i<4;i++){const r=records(i);r[4]!.bytes=big;await j.commit({operationId:'op-'+i,requestDigest:ownedSha256('op-'+i),records:r});}
 rewriteLast({...f,io,checkpoint},body=>body.records.find((r:any)=>r.id==='payload').chunks.reverse());
 await expect(j.verifyHead()).rejects.toThrow('content_mismatch');expect(j.verificationMetrics).toBeUndefined();
});
for(const mutation of ['role','size','missing-blob','blob','mac','rollback','checkpoint'] as const)it('preserves rejection on warm head-only verification: '+mutation,async()=>{
 const f=await fixture();await f.journal.verifyHead();
 if(mutation==='role')rewriteLast(f,b=>b.records.find((r:any)=>r.role==='session-manifest').role='metadata-snapshot');
 if(mutation==='size')rewriteLast(f,b=>{const r=b.records.find((r:any)=>r.id==='payload');r.size++;r.chunks[0].size++;});
 const name='blob-'+ownedSha256(payload)+'.bin';
 if(mutation==='missing-blob')f.io.files.delete(name);if(mutation==='blob')f.io.files.set(name,Buffer.alloc(payload.length,48));
 if(mutation==='mac'){const name='commit-00000004.json',raw=JSON.parse(f.io.files.get(name)!.toString());raw.mac='1'.repeat(64);f.io.files.set(name,Buffer.from(canonicalOwnedJson(raw)));}
 if(mutation==='rollback')f.io.files.delete('commit-00000004.json');
 if(mutation==='checkpoint')f.checkpoint.read=async()=>{throw Error('unavailable');};
 await expect(f.journal.verifyHead()).rejects.toThrow(/authority_journal_/);expect(f.journal.verificationMetrics).toBeUndefined();
 await expect(f.journal.verifyHead()).rejects.toThrow('recovery_required');
});
it('copies provider bytes before proving content and does not leak provider aliases',async()=>{
 const f=await fixture();const aliasIO:JournalIO={list:f.io.list.bind(f.io),put:f.io.put.bind(f.io),read:async(name,max)=>{const bytes=f.io.files.get(name)!;expect(bytes.length).toBeLessThanOrEqual(max);return bytes;}};const j=await AuthorityJournal.open({...f.config,io:aliasIO});
 const name='blob-'+ownedSha256(payload)+'.bin',read=f.checkpoint.read.bind(f.checkpoint);let armed=true;
 f.checkpoint.read=async()=>{if(armed){armed=false;f.io.files.get(name)!.fill(48);}return read();};
 const recovered=await j.readLatest();expect(recovered.find(r=>r.id==='payload')!.bytes.equals(payload)).toBe(true);
 await expect(j.verifyHead()).rejects.toThrow('content_mismatch');
});
for(const config of [{contentMemoEntries:-1},{contentMemoEntries:4097},{contentMemoEntries:0.5},{contentMemoKeyBytes:-1},{contentMemoKeyBytes:8*1024*1024+1}])it('rejects invalid memo limits '+JSON.stringify(config),async()=>{
 const io=new MemoryJournalIO(),checkpoint=new MemoryCheckpoint(journalGenesis(identity));await expect(AuthorityJournal.create({...identity,key,io,checkpoint,...config})).rejects.toThrow('configuration_invalid');expect(io.files.size).toBe(0);
});
