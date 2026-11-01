/** Lossless content-addressed storage for boundary-observation bytes, not receipt approval. */
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
const digest=b=>createHash('sha256').update(b).digest('hex');
const allRuns=c=>[...c.runs,...(c.faults??[])];
// Published records keep only the bytes that the storage-mismatch judgment needs.
export function publishContentCase(c){
 const copy=structuredClone(c);
 for(const r of allRuns(copy))for(const file of r.receipt){
  if(typeof file.bytes!=='string')throw Error('snapshot_content_blob_invalid');
  if(!(r.mode==='blob-corrupt'&&file.id===r.mutation?.id)){delete file.bytes;file.bytesOmitted=true;}
 }
 return copy;
}
export function packContentCase(c,blobs){
 for(const r of allRuns(c))for(const file of r.receipt){
  if(file.bytesOmitted===true&&file.bytes===undefined)continue;
  const bytes=Buffer.from(file.bytes,'base64'),key=digest(bytes);
  if(!blobs[key])blobs[key]={size:bytes.length,gzipBase64:gzipSync(bytes).toString('base64')};
  file.blobRef=key;delete file.bytes;
 }
 return c;
}
export function unpackContentCase(c,blobs,used=new Set()){
 const copy=structuredClone(c),cache=new Map();
 for(const r of allRuns(copy))for(const file of r.receipt){
  if(file.bytesOmitted===true&&file.blobRef===undefined&&file.bytes===undefined)continue;
  const key=file.blobRef,blob=blobs[key];
  if(!/^[a-f0-9]{64}$/.test(key)||!blob||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>64*1024**2||typeof blob.gzipBase64!=='string'||Buffer.from(blob.gzipBase64,'base64').toString('base64')!==blob.gzipBase64)throw Error('snapshot_content_blob_invalid');
  if(!cache.has(key)){
   let bytes;try{bytes=gunzipSync(Buffer.from(blob.gzipBase64,'base64'),{maxOutputLength:64*1024**2});}catch{throw Error('snapshot_content_blob_invalid');}
   if(bytes.length!==blob.size||digest(bytes)!==key)throw Error('snapshot_content_blob_invalid');cache.set(key,bytes.toString('base64'));
  }
  used.add(key);file.bytes=cache.get(key);delete file.blobRef;
 }
 return copy;
}
// Run IDs identify the native observation set independently of record formatting.
export const contentRunIds=matrices=>matrices.flatMap(m=>m.cases.flatMap(c=>allRuns(c).map(r=>r.runId))).sort();
export function contentRecordCounts(matrices){
 const cases=matrices.flatMap(m=>m.cases),decided=cases.flatMap(c=>c.runs.map((r,i)=>({mode:r.mode,...c.decision.runs[i]})));
 const count=f=>decided.filter(f).length;
 return {nativeBuilds:cases.reduce((n,c)=>n+allRuns(c).length,0),boundaryFreshnessCandidates:count(d=>d.mode==='boundary'&&d.boundaryFreshness),
  cachedReadRejections:cases.reduce((n,c)=>n+c.decision.faults.filter(f=>f.accepted===false&&f.reason==='snapshot_content_no_read_violated').length,0),
  fileMutationRejections:count(d=>['mutate-same-size','mutate-size','delete'].includes(d.mode)&&d.reason==='kotlin_derived_snapshot_stale'),
  storageMismatchRejections:count(d=>d.mode==='blob-corrupt'&&d.reason==='kotlin_pipeline_snapshot_storage_mismatch'),
  missingReceiptNoReadRefusals:count(d=>d.mode==='no-receipt'&&d.reason==='kgp_capture_content_evidence_unavailable'),
  recordMutationRejections:cases.reduce((n,c)=>n+c.regressions.length,0),coordinatedTraceRejections:cases.reduce((n,c)=>n+c.caseRegressions.length,0),
  approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0};
}
