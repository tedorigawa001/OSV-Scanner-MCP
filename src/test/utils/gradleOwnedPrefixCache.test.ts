import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {DiagnosticPrefixCache} from '../fixtures/gradleOwnedPrefixCache.js';
import {ownedSha256,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {sealV2Commit,v2Genesis,v2StateSummary,replayV2,type V2ReplayInput} from '../fixtures/gradleOwnedJournalV2.js';
const hash=ownedSha256;
function source(keyValue=7):V2ReplayInput{
 const binding={authorityId:'authority',lineageId:'lineage',storeEpoch:hash('epoch'),generation:1,profileDigest:hash('profile')},baseRef={role:'compacted-base' as const,id:'base',sha256:hash('base'),byteLength:4},key=Buffer.alloc(32,keyValue);
 const records=['session-manifest','session-index','event-ledger','operation-result'].map(role=>({key:{role:role as 'session-manifest',id:role==='event-ledger'?'scope':'root'},bytes:Buffer.from(role)})),s=v2StateSummary(records);
 const first=sealV2Commit({schema:'osv-mcp.gradle-owned-journal-commit-v2',schemaVersion:2,layout:'typed-flat-map-v1',...binding,baseRef,revision:1,previousCommit:v2Genesis(binding,baseRef),fromStateRoot:v2Genesis(binding,baseRef),...s.roots,usage:s.usage,operation:{id:'op1',requestDigest:hash('op1'),resultRef:s.records.find(r=>r.key.role==='operation-result')!.ref},recordMode:'full',records:s.records},'key',key);
 return {binding,baseRef,keyId:'key',key,approvedBaseDigest:hash(first),checkpoint:{revision:1,commitDigest:hash(first)},commits:[first],payloads:records.map(r=>r.bytes)};
}
it('retains private prefix bytes only after completion and compares a warm replay with full reference',()=>{
 const c=new DiagnosticPrefixCache(),s=c.seal(source()),cold=c.verify(s);
 expect(c.metrics.cacheBytes).toBe(0);expect(c.complete(cold)).toMatchObject({hit:false,equivalent:true,originalReadsSkipped:0,backendEligible:false});
 const warm=c.complete(c.verify(s));expect(warm).toMatchObject({hit:true,equivalent:true,uncachedInputBytes:0});expect(warm.referenceInputBytes).toBeGreaterThan(0);
});
function append(input:V2ReplayInput){
 const old=replayV2(input),revision=old.revision+1,bytes=Buffer.from('result-'+revision),records=old.records.map(r=>r.key.role==='operation-result'?{...r,bytes}:r),s=v2StateSummary(records),previous=JSON.parse(input.commits.at(-1)!.toString()).body;
 const next=sealV2Commit({...previous,revision,previousCommit:old.commitDigest,fromStateRoot:old.stateRoot,...s.roots,usage:s.usage,operation:{id:'op'+revision,requestDigest:hash('op'+revision),resultRef:s.records.find(r=>r.key.role==='operation-result')!.ref},records:s.records},input.keyId,input.key);
 return {...input,checkpoint:{revision,commitDigest:hash(next)},commits:[...input.commits,next],payloads:[...input.payloads,bytes]};
}
it('compares an extended suffix with full history including exact retained payloads',()=>{
 const c=new DiagnosticPrefixCache(),input=source();c.complete(c.verify(c.seal(input)));const next=append(input),result=c.complete(c.verify(c.seal(next))),full=replayV2(next);
 expect(result).toMatchObject({hit:true,revision:2,stateRoot:full.stateRoot,commitDigest:full.commitDigest,retainedPayloads:full.retainedPayloads,fullHistoryAuthenticated:true});
 expect(result.uncachedInputBytes).toBe(next.commits[1]!.length+next.payloads.at(-1)!.length);expect(result.referenceInputBytes).toBeGreaterThan(result.uncachedInputBytes);
});
for(const fault of ['unavailable','sync-incomplete','rollback','tail-unknown'] as const)it('does not publish a verified candidate after checkpoint '+fault,()=>{
 const c=new DiagnosticPrefixCache(),s=c.seal(source()),candidate=c.verify(s);c.checkpoint(fault);expect(()=>c.complete(candidate)).toThrow('checkpoint_'+fault);expect(c.metrics.completed).toBe(0);c.checkpoint('ready');expect(()=>c.complete(candidate)).toThrow('candidate');
});
for(const action of ['evict','invalidate','close'] as const)it('rejects an outstanding candidate after '+action,()=>{
 const c=new DiagnosticPrefixCache(),s=c.seal(source()),candidate=c.verify(s);c[action]();expect(()=>c.complete(candidate)).toThrow();expect(c.metrics.completed).toBe(0);
});
it('rejects forged, foreign and reused handles',()=>{
 const c=new DiagnosticPrefixCache(),other=new DiagnosticPrefixCache(),s=c.seal(source());expect(()=>c.verify({kind:'q3-diagnostic-handle'})).toThrow('handle');expect(()=>other.verify(s)).toThrow('handle');const candidate=c.verify(s);c.complete(candidate);expect(()=>c.complete(candidate)).toThrow('candidate');
});
it('owns caller bytes and does not expose private result buffers',()=>{
 const input=source(),c=new DiagnosticPrefixCache(),s=c.seal(input);input.key.fill(0);input.commits[0]!.fill(0);input.payloads[0]!.fill(0);const first=c.complete(c.verify(s));first.retainedPayloads.length=0;expect(c.complete(c.verify(s)).retainedPayloads).toHaveLength(4);
});
it('rejects malformed source instead of treating it as a miss',()=>{
 const c=new DiagnosticPrefixCache(),input=source();c.complete(c.verify(c.seal(input)));input.commits[0]![0]=input.commits[0]![0]!^1;expect(()=>c.seal(input)).toThrow();expect(c.metrics.completed).toBe(1);
});
it('bounds pending candidates and permits a retry after completion',()=>{
 const c=new DiagnosticPrefixCache(),s=c.seal(source()),pending=Array.from({length:16},()=>c.verify(s));expect(()=>c.verify(s)).toThrow('pending_budget');c.complete(pending[0]!);expect(()=>c.verify(s)).not.toThrow();
});
it('does not store an oversized proof and evicts normally',()=>{
 const c=new DiagnosticPrefixCache(0),s=c.seal(source());c.complete(c.verify(s));expect(c.complete(c.verify(s)).hit).toBe(false);expect(c.metrics.cacheBytes).toBe(0);
 const d=new DiagnosticPrefixCache(),h=d.seal(source());d.complete(d.verify(h));d.evict();expect(d.complete(d.verify(h)).hit).toBe(false);
});
it('bounds retained sources independently of cache eviction',()=>{
 const c=new DiagnosticPrefixCache();for(let i=0;i<8;i++){c.seal(source());c.evict();}expect(()=>c.seal(source())).toThrow('source_budget');
});
it('rejects a validly reauthenticated changed prefix and stops instead of falling back',()=>{
 const c=new DiagnosticPrefixCache(),first=source(),next=append(first);c.complete(c.verify(c.seal(next)));
 const body=JSON.parse(next.commits[1]!.toString()).body;body.operation.requestDigest=hash('replacement');const changed=sealV2Commit(body,next.keyId,next.key),fork={...next,commits:[first.commits[0]!,changed],checkpoint:{revision:2,commitDigest:hash(changed)}};
 const forkHandle=c.seal(fork),oldHandle=c.seal(first);expect(()=>c.verify(forkHandle)).toThrow('prefix_changed');expect(()=>c.verify(oldHandle)).toThrow('recovery_required');expect(c.metrics.cacheBytes).toBe(0);
});
it('rejects a previously valid old head instead of using it as a normal miss',()=>{
 const c=new DiagnosticPrefixCache(),first=source(),old=c.seal(first);c.complete(c.verify(c.seal(append(first))));expect(()=>c.verify(old)).toThrow('rollback');
});
it('does not reuse a proof across a different signing key identity',()=>{
 const c=new DiagnosticPrefixCache(),first=source();c.complete(c.verify(c.seal(first)));const key=Buffer.alloc(32,19),body=JSON.parse(first.commits[0]!.toString()).body,commit=sealV2Commit(body,first.keyId,key),other={...first,key,commits:[commit],approvedBaseDigest:hash(commit),checkpoint:{revision:1,commitDigest:hash(commit)}};expect(c.complete(c.verify(c.seal(other))).hit).toBe(false);
});
it('evicts to the byte budget and performs a full miss when the old source returns',()=>{
 const first=source(),size=first.commits.reduce((n,b)=>n+b.length,0)+first.payloads.reduce((n,b)=>n+b.length,0),c=new DiagnosticPrefixCache(size),h=c.seal(first);c.complete(c.verify(h));c.complete(c.verify(c.seal(source(19))));
 expect(c.metrics.evictions).toBe(1);expect(c.metrics.cacheBytes).toBeLessThanOrEqual(size);expect(c.complete(c.verify(h)).hit).toBe(false);
});
it('rejects an older concurrent completion after a newer head was published',()=>{
 const c=new DiagnosticPrefixCache(),first=source(),old=c.verify(c.seal(first)),next=c.verify(c.seal(append(first)));c.complete(next);expect(()=>c.complete(old)).toThrow('candidate');expect(c.metrics.completed).toBe(1);
});
it('reproduces the archived diagnostic comparison and implementation fingerprints',()=>{
 const c=new DiagnosticPrefixCache(),first=source(),s=c.seal(first),cold=c.complete(c.verify(s)),hit=c.complete(c.verify(s)),suffix=c.complete(c.verify(c.seal(append(first))));
 const scenarios={cold,hit,suffix},sources=Object.fromEntries(['gradleOwnedPrefixCache.ts','gradleOwnedPrefixAdoption.ts'].map(name=>[name,hash(readFileSync(new URL('../fixtures/'+name,import.meta.url)))]));
 const report={schema:'osv-mcp.q3q4.diagnostic-comparison.v1',scenarios,sources,nativeRunPerformed:false,productionAdoption:false,originalReadsSkipped:0};
 if(process.env.OSV_Q3Q4_REPORT==='1')console.log('Q3Q4_RECORD '+JSON.stringify(report));
 else expect(JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-q3q4-diagnostic-2026-11-03.json',import.meta.url),'utf8'))).toEqual(report);
});
