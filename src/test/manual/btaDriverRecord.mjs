/** Published-record form for producer-owned BTA runs; the native verifier stays pinned by btaSources. */
import {createHash} from 'node:crypto';
export const btaRecordSchema='osv-mcp.bta-owned-driver-experiment-v3';
// Snapshot descriptors in configuration evidence are copied from sealed entries by staged-path identity, not re-read bytes.
export const btaBindingSemantics={snapshotDescriptorSource:'sealed-by-path',contentGuard:'preflight-postflight-checks',nativeUnprovenChecks:['binding-reuse','context-mismatch','parameter-path-mismatch']};
const shrunk='shrunk-classpath-snapshot.bin',hash=b=>createHash('sha256').update(b).digest('hex'),sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const fail=m=>{throw Error(m)};
export function summarizePrivateCache(items){
 const kept=items.filter(i=>i.path===shrunk);if(kept.length!==1)fail('bta_driver_cache_invalid');
 return {entries:items.length,totalSize:items.reduce((n,i)=>n+i.size,0),inventorySha256:hash(JSON.stringify(items)),shrunkSnapshot:kept[0]};
}
// Native view keeps only the retained shrunk entry; the native verifier needs inventory validity and that entry.
function nativeCache(s){
 if(Array.isArray(s)||!s||Object.keys(s).sort().join()!=='entries,inventorySha256,shrunkSnapshot,totalSize')fail('bta_driver_published_cache_invalid');
 const k=s.shrunkSnapshot;
 if(!Number.isSafeInteger(s.entries)||s.entries<1||!Number.isSafeInteger(s.totalSize)||!sha(s.inventorySha256)||k?.path!==shrunk||!Number.isSafeInteger(k.size)||k.size<0||s.totalSize<k.size||!sha(k.sha256))fail('bta_driver_published_cache_invalid');
 return [k];
}
export function publishBtaCase(c){
 const out=structuredClone(c);for(const r of out.runs)r.program.privateCache=summarizePrivateCache(r.program.privateCache);return out;
}
export function nativeBtaCase(c){
 const out=structuredClone(c);for(const r of out.runs)r.program.privateCache=nativeCache(r.program.privateCache);return out;
}
export function verifyBtaRecordSemantics(d){
 if(d?.schema!==btaRecordSchema||JSON.stringify(d.bindingSemantics)!==JSON.stringify(btaBindingSemantics))fail('bta_driver_binding_semantics_invalid');
}
export const btaObservationSha256=matrices=>hash(JSON.stringify(matrices));
