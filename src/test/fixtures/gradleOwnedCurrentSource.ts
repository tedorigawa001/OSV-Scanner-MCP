/** Author-side v2 source for C0 regression/reproduction, not an authority witness. */
import {canonicalOwnedJson,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {replayV2,sealV2Commit,v2StateSummary,v2Genesis,type V2ReplayInput,type V2Record} from './gradleOwnedJournalV2.js';
export function currentSource():V2ReplayInput{
 const binding={authorityId:'authority',lineageId:'lineage',storeEpoch:ownedSha256('epoch'),generation:1,profileDigest:ownedSha256('profile')},baseRef={role:'compacted-base' as const,id:'base',sha256:ownedSha256('base'),byteLength:4},key=Buffer.alloc(32,7);
 const records:V2Record[]=[{key:{role:'session-manifest',id:'root'},bytes:Buffer.from('manifest')},{key:{role:'session-index',id:'root'},bytes:Buffer.from('index')},{key:{role:'event-ledger',id:'scope'},bytes:Buffer.from('events')},{key:{role:'operation-result',id:'root'},bytes:Buffer.from('result-1')}],s=v2StateSummary(records);
 const first=sealV2Commit({schema:'osv-mcp.gradle-owned-journal-commit-v2',schemaVersion:2,layout:'typed-flat-map-v1',...binding,baseRef,revision:1,previousCommit:v2Genesis(binding,baseRef),fromStateRoot:v2Genesis(binding,baseRef),...s.roots,usage:s.usage,
  operation:{id:'op1',requestDigest:ownedSha256('op1'),resultRef:s.records.find(r=>r.key.role==='operation-result')!.ref},recordMode:'full',records:s.records},'journal',key);
 return {binding,baseRef,keyId:'journal',key,approvedBaseDigest:ownedSha256(first),checkpoint:{revision:1,commitDigest:ownedSha256(first)},commits:[first],payloads:records.map(r=>r.bytes)};
}
export function extendCurrentSource(input:V2ReplayInput):V2ReplayInput{
 const old=replayV2(input),revision=old.revision+1,bytes=Buffer.from(canonicalOwnedJson({version:revision})),records=old.records.map(r=>r.key.role==='operation-result'?{...r,bytes}:r),s=v2StateSummary(records),previous=JSON.parse(input.commits.at(-1)!.toString()).body;
 const next=sealV2Commit({...previous,revision,previousCommit:old.commitDigest,fromStateRoot:old.stateRoot,...s.roots,usage:s.usage,operation:{id:'op'+revision,requestDigest:ownedSha256('op'+revision),resultRef:s.records.find(r=>r.key.role==='operation-result')!.ref},records:s.records},input.keyId,input.key);
 return {...input,commits:[...input.commits,next],payloads:[...input.payloads,bytes],checkpoint:{revision,commitDigest:ownedSha256(next)}};
}
