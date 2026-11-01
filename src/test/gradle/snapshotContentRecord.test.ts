import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {contentSources,verifySnapshotContentCase,contentRegressions,contentCaseRegressions} from '../fixtures/gradleSnapshotContentProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
import {describe,it,expect} from 'vitest';
import {packContentCase,unpackContentCase} from '../manual/snapshotContentRecord.mjs';
const bytes=Buffer.from('nonempty snapshot');
const key=createHash('sha256').update(bytes).digest('hex');
const sample=()=>({runs:[{receipt:[{id:'snapshot',size:bytes.length,sha256:key,bytes:bytes.toString('base64')}]},{receipt:[{id:'same',size:bytes.length,sha256:key,bytes:bytes.toString('base64')}]}]});
describe('content-addressed boundary bytes',()=>{
 it('retains all bytes and deduplicates equal blobs',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);expect(Object.keys(blobs)).toHaveLength(1);expect(unpackContentCase(c,blobs)).toEqual(sample());});
 it('rejects missing blobs',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);expect(()=>unpackContentCase(c,{})).toThrow('snapshot_content_blob_invalid');});
 it('rejects compressed corruption',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);blobs[key].gzipBase64=Buffer.from('not gzip').toString('base64');expect(()=>unpackContentCase(c,blobs)).toThrow('snapshot_content_blob_invalid');});
 it('rejects a size different from saved bytes',()=>{const c=sample(),blobs:any={};packContentCase(c,blobs);blobs[key].size++;expect(()=>unpackContentCase(c,blobs)).toThrow('snapshot_content_blob_invalid');});
 it('rejects rebinding bytes under another digest',()=>{const c:any=sample(),blobs:any={};packContentCase(c,blobs);const wrong='0'.repeat(64);blobs[wrong]=blobs[key];c.runs[0].receipt[0].blobRef=wrong;expect(()=>unpackContentCase(c,blobs)).toThrow('snapshot_content_blob_invalid');});
});

const recordPath=new URL('../../../docs/validation/gradle-snapshot-content-2026-11-01.json',import.meta.url);
it('replays every published boundary observation and rejection from saved bytes',()=>{
 const d=JSON.parse(readFileSync(recordPath,'utf8'));
 expect(d.schema).toBe('osv-mcp.snapshot-content-experiment-v2');assertNoAbsolutePaths(d);
 for(const group of ['sourcesSha256','verificationSourcesSha256'])for(const [file,sha] of Object.entries(d[group]))expect(createHash('sha256').update(readFileSync(new URL('../../../'+file,import.meta.url))).digest('hex'),file).toBe(sha);
 const refBytes=readFileSync(new URL('../../../'+d.apiReferenceRecord.path,import.meta.url));expect(createHash('sha256').update(refBytes).digest('hex')).toBe(d.apiReferenceRecord.sha256);
 const reference=JSON.parse(refBytes.toString()),used=new Set<string>();let runs=0,rejections=0,traceRejections=0,cachedReads=0;
 expect(d.matrices.map((m:any)=>m.gradleVersion)).toEqual(['8.11.1','9.2.1']);
 for(const matrix of d.matrices){
  expect(matrix.cases.map((c:any)=>c.dsl)).toEqual(['Groovy','Kotlin']);
  const prior=reference.matrices.find((m:any)=>m.gradleVersion===matrix.gradleVersion).cases[0].runs[0];
  const approvedApi={gradle:prior.apiArtifacts.gradle.sha256,kgp:prior.apiArtifacts.kgp.sha256,implementation:prior.implementation.sha256};
  for(const packed of matrix.cases){
   const c=unpackContentCase(packed,d.blobs,used),a={gradleVersion:matrix.gradleVersion,dsl:c.dsl,approvedApi,sourcesSha256:d.sourcesSha256};
   expect(c.approvedApi).toEqual(approvedApi);expect(Object.keys(c.sourcesSha256)).toEqual(contentSources);
   expect(verifySnapshotContentCase(c,a)).toEqual(c.decision);expect(contentRegressions(c,a)).toEqual(c.regressions);expect(contentCaseRegressions(c,a)).toEqual(c.caseRegressions);runs+=c.runs.length+c.faults.length;rejections+=c.regressions.length;traceRejections+=c.caseRegressions.length;cachedReads+=c.decision.faults.length;
  }
 }
 expect(used.size).toBe(Object.keys(d.blobs).length);
 expect(d.scope).toMatchObject({nativeBuilds:runs,recordMutationRejections:rejections,coordinatedTraceRejections:traceRejections,cachedReadRejections:cachedReads,boundaryFreshnessCandidates:4,fileMutationRejections:12,storageMismatchRejections:4,missingReceiptNoReadRefusals:4,approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0});
},120000);
