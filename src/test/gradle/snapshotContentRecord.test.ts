import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {contentSources,verifySnapshotContentCase,contentRegressions,contentCaseRegressions} from '../fixtures/gradleSnapshotContentProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
import {describe,it,expect} from 'vitest';
import {publishContentCase,packContentCase,unpackContentCase,contentRecordCounts} from '../manual/snapshotContentRecord.mjs';
const bytes=Buffer.from('nonempty snapshot');
const key=createHash('sha256').update(bytes).digest('hex');
const sample=()=>({runs:[{receipt:[{id:'snapshot',size:bytes.length,sha256:key,bytes:bytes.toString('base64')}]},{receipt:[{id:'same',size:bytes.length,sha256:key,bytes:bytes.toString('base64')}]}]});
describe('content-addressed boundary bytes',()=>{
 it('retains all bytes and deduplicates equal blobs',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);expect(Object.keys(blobs)).toHaveLength(1);expect(unpackContentCase(c,blobs)).toEqual(sample());});
 it('rejects missing blobs',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);expect(()=>unpackContentCase(c,{})).toThrow('snapshot_content_blob_invalid');});
 it('rejects compressed corruption',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);blobs[key].gzipBase64=Buffer.from('not gzip').toString('base64');expect(()=>unpackContentCase(c,blobs)).toThrow('snapshot_content_blob_invalid');});
 it('rejects a size different from saved bytes',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);blobs[key].size++;expect(()=>unpackContentCase(c,blobs)).toThrow('snapshot_content_blob_invalid');});
 it('omits bytes outside the corruption evidence and restores the omission marker',()=>{const c:any=sample();c.runs[0].mode='boundary';c.runs[1].mode='blob-corrupt';c.runs[1].mutation={id:'same'};const p=publishContentCase(c),blobs:any={};expect(p.runs[0].receipt[0]).toMatchObject({bytesOmitted:true});expect(p.runs[0].receipt[0].bytes).toBeUndefined();packContentCase(p,blobs);expect(Object.keys(blobs)).toHaveLength(1);expect(unpackContentCase(p,blobs).runs[1].receipt[0].bytes).toBe(bytes.toString('base64'));});
 it('rejects rebinding bytes under another digest',()=>{const c:any=sample(),blobs:any={};packContentCase(c,blobs);const wrong='0'.repeat(64);blobs[wrong]=blobs[key];c.runs[0].receipt[0].blobRef=wrong;expect(()=>unpackContentCase(c,blobs)).toThrow('snapshot_content_blob_invalid');});
});

const recordPath=new URL('../../../docs/validation/gradle-snapshot-content-2026-11-01.json',import.meta.url);
// Replays the published record against current sources; native byte checks are not repeatable from it.
function verifyPublishedRecord(d:any){
 if(d.schema!=='osv-mcp.snapshot-content-experiment-v3')throw Error('snapshot-content-record-schema');assertNoAbsolutePaths(d);
 for(const group of ['sourcesSha256','verificationSourcesSha256'])for(const [file,sha] of Object.entries(d[group]))if(createHash('sha256').update(readFileSync(new URL('../../../'+file,import.meta.url))).digest('hex')!==sha)throw Error('snapshot-content-record-source-drift:'+file);
 if(Object.keys(d.sourcesSha256).join()!==contentSources.join())throw Error('snapshot-content-record-source-drift');
 const refBytes=readFileSync(new URL('../../../'+d.apiReferenceRecord.path,import.meta.url));if(createHash('sha256').update(refBytes).digest('hex')!==d.apiReferenceRecord.sha256)throw Error('snapshot-content-record-api-reference-drift');
 const reference=JSON.parse(refBytes.toString()),used=new Set<string>();
 if(d.matrices.map((m:any)=>m.gradleVersion).join()!=='8.11.1,9.2.1')throw Error('snapshot-content-record-matrix');
 for(const matrix of d.matrices){
  if(matrix.cases.map((c:any)=>c.dsl).join()!=='Groovy,Kotlin')throw Error('snapshot-content-record-matrix');
  const prior=reference.matrices.find((m:any)=>m.gradleVersion===matrix.gradleVersion).cases[0].runs[0];
  const approvedApi={gradle:prior.apiArtifacts.gradle.sha256,kgp:prior.apiArtifacts.kgp.sha256,implementation:prior.implementation.sha256};
  for(const packed of matrix.cases){
   const c=unpackContentCase(packed,d.blobs,used),a={gradleVersion:matrix.gradleVersion,dsl:c.dsl,approvedApi,sourcesSha256:d.sourcesSha256,storage:'published'};
   if(JSON.stringify(c.approvedApi)!==JSON.stringify(approvedApi))throw Error('snapshot-content-record-api');
   // Only the corrupted blob-corrupt file may carry bytes.
   for(const r of [...c.runs,...c.faults])for(const f of r.receipt)if((f.bytes!==undefined)!==(r.mode==='blob-corrupt'&&f.id===r.mutation?.id))throw Error('snapshot-content-record-retention');
   if(JSON.stringify(verifySnapshotContentCase(c,a))!==JSON.stringify(c.decision))throw Error('snapshot-content-record-decision-replay');
   if(JSON.stringify(contentRegressions(c,a))!==JSON.stringify(c.regressions)||JSON.stringify(contentCaseRegressions(c,a))!==JSON.stringify(c.caseRegressions))throw Error('snapshot-content-record-regression-replay');
  }
 }
 if(used.size!==Object.keys(d.blobs).length||d.scope.retainedBlobs!==used.size)throw Error('snapshot-content-record-blob-unused');
 const counts=contentRecordCounts(d.matrices);
 if(Object.entries(counts).some(([k,v])=>d.scope[k]!==v))throw Error('snapshot-content-record-scope');
 return counts;
}
const load=()=>JSON.parse(readFileSync(recordPath,'utf8'));
it('replays every published boundary observation and rejection',()=>{
 expect(verifyPublishedRecord(load())).toMatchObject({nativeBuilds:36,boundaryFreshnessCandidates:4,cachedReadRejections:8,fileMutationRejections:12,storageMismatchRejections:4,missingReceiptNoReadRefusals:4,approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0});
 expect(load().scope.retainedBlobs).toBeLessThanOrEqual(4);
},120000);
const firstCase=(d:any)=>d.matrices[0].cases[0];
for(const [label,change,reason] of [
 ['a stale decision',(d:any)=>{firstCase(d).decision.runs[1].boundaryFreshness=false;},'snapshot-content-record-decision-replay'],
 ['an unused blob',(d:any)=>{d.blobs['f'.repeat(64)]={size:0,gzipBase64:''};},'snapshot-content-record-blob-unused'],
 ['bytes retained beyond the corruption evidence',(d:any)=>{const f=firstCase(d).runs[1].receipt[0];delete f.bytesOmitted;f.blobRef=Object.keys(d.blobs)[0];},'snapshot-content-record-retention'],
 ['an inflated scope',(d:any)=>{d.scope.fileMutationRejections++;},'snapshot-content-record-scope'],
 ['a drifted source hash',(d:any)=>{d.verificationSourcesSha256['src/test/manual/snapshotContentRecord.mjs']='0'.repeat(64);},'snapshot-content-record-source-drift'],
 ['an absolute path',(d:any)=>{firstCase(d).runs[0].api.gradle.artifact='/Users/someone/gradle.jar';},'kgp_availability_record_path_not_portable'],
] as const)it(`rejects a published record with ${label}`,()=>{const d=load();change(d);expect(()=>verifyPublishedRecord(d)).toThrow(reason);},120000);
