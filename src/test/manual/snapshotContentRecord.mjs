/** Lossless content-addressed storage for boundary-observation bytes, not receipt approval. */
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
const digest=b=>createHash('sha256').update(b).digest('hex');
export function packContentCase(c,blobs){
 for(const r of [...c.runs,...(c.faults??[])])for(const file of r.receipt){
  const bytes=Buffer.from(file.bytes,'base64'),key=digest(bytes);
  if(!blobs[key])blobs[key]={size:bytes.length,gzipBase64:gzipSync(bytes).toString('base64')};
  file.blobRef=key;delete file.bytes;
 }
 return c;
}
export function unpackContentCase(c,blobs,used=new Set()){
 const copy=structuredClone(c),cache=new Map();
 for(const r of [...copy.runs,...(copy.faults??[])])for(const file of r.receipt){
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
