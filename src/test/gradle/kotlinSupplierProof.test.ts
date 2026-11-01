import {mkdtemp,readFile,writeFile,rm,access} from "node:fs/promises";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {supplierSourcePaths} from "../fixtures/gradleKotlinSupplierProof.mjs";
import {describe,it,expect} from "vitest";
import {verifySupplierProof,verifySupplierMatrix} from "../fixtures/gradleKotlinSupplierProof.mjs";
const h='a'.repeat(64),sources={'src/test/fixtures/gradle-kotlin-supplier.init.gradle':h,'harness':h};
function fixture(){
 const prefix=['libraries','before-compile','libraries','libraries','after-compile'];
 const inputs={'build.gradle':h,'build-logic/build.gradle.kts':h};
 return {schema:'osv-mcp.kotlin-supplier-proof-v2',gradleVersion:'8.11.1',consumerDSL:'Groovy',sourcesSha256:sources,fixtureInputsSha256:inputs,reports:[false,true].map((observe,i)=>({runId:`00000000-0000-4000-8000-00000000000${i}`,observe,gradleVersion:'8.11.1',consumerDSL:'Groovy',collectorSha256:h,fixtureInputsSha256:inputs,trace:[...prefix,...observe?['libraries']:[],'after-observer']}))};
}
const approval={gradleVersion:'8.11.1',consumerDSL:'Groovy',sourcesSha256:sources};
describe('supplier observation provenance',()=>{
 it('verifies actual version, captured source hashes and the phase of the extra evaluation',()=>{
  expect(verifySupplierProof(fixture(),approval)).toEqual({controlCalls:3,observedCalls:4,extraPhase:'post-compile'});
 });
});

describe('supplier observation rejection regressions',()=>{
 it.each([
  ['outer-version','supplier_identity_mismatch'],['run-version','supplier_identity_mismatch'],['consumer','supplier_identity_mismatch'],['observe-order','supplier_identity_mismatch'],['duplicate-run','supplier_identity_mismatch'],
  ['source-hash','supplier_source_mismatch'],['source-key-missing','supplier_source_mismatch'],['collector-hash','supplier_source_mismatch'],['fixture-hash','supplier_fixture_mismatch'],
  ['arbitrary-trace','supplier_trace_invalid'],['missing-phase','supplier_trace_invalid'],['duplicate-phase','supplier_trace_invalid'],['extra-during-compile','supplier_trace_invalid'],['different-prefix','supplier_trace_invalid'],['no-extra-call','supplier_trace_invalid'],['two-extra-calls','supplier_trace_invalid']
 ])('rejects %s',(mutation,reason)=>{
  const data:any=structuredClone(fixture());
  if(mutation==='outer-version')data.gradleVersion='9.2.1';
  if(mutation==='run-version')data.reports[1].gradleVersion='9.2.1';
  if(mutation==='consumer')data.reports[1].consumerDSL='Kotlin';
  if(mutation==='observe-order')data.reports.reverse();
  if(mutation==='duplicate-run')data.reports[1].runId=data.reports[0].runId;
  if(mutation==='source-hash')data.sourcesSha256={...data.sourcesSha256,harness:'b'.repeat(64)};
  if(mutation==='source-key-missing')delete data.sourcesSha256.harness;
  if(mutation==='collector-hash')data.reports[1].collectorSha256='b'.repeat(64);
  if(mutation==='fixture-hash')data.reports[1].fixtureInputsSha256={...data.fixtureInputsSha256,'build.gradle':'b'.repeat(64)};
  if(mutation==='arbitrary-trace')data.reports[1].trace=['unrelated-difference'];
  if(mutation==='missing-phase')data.reports[1].trace=data.reports[1].trace.filter((x:string)=>x!=='after-compile');
  if(mutation==='duplicate-phase')data.reports[1].trace.push('after-observer');
  if(mutation==='extra-during-compile')data.reports[1].trace.splice(4,0,data.reports[1].trace.splice(5,1)[0]);
  if(mutation==='different-prefix')data.reports[1].trace.splice(2,0,'libraries');
  if(mutation==='no-extra-call')data.reports[1].trace=data.reports[0].trace;
  if(mutation==='two-extra-calls')data.reports[1].trace.splice(5,0,'libraries');
  expect(()=>verifySupplierProof(data,approval)).toThrow(reason);
 });
 it('rejects a stored proof after the approved source changes',()=>{
  expect(()=>verifySupplierProof(fixture(),{...approval,sourcesSha256:{...sources,harness:'b'.repeat(64)}})).toThrow('supplier_source_mismatch');
 });
 it('requires both consumer DSLs and verifies their actual version',()=>{
  const kotlin:any=structuredClone(fixture());kotlin.consumerDSL='Kotlin';for(const r of kotlin.reports)r.consumerDSL='Kotlin';
  const matrix={schema:'osv-mcp.kotlin-supplier-matrix-v2',gradleVersion:'8.11.1',cases:[fixture(),kotlin]};
  expect(verifySupplierMatrix(matrix,approval)).toHaveLength(2);
  expect(()=>verifySupplierMatrix({...matrix,cases:[fixture(),fixture()]},approval)).toThrow('supplier_matrix_incomplete');
  expect(()=>verifySupplierMatrix(matrix,{...approval,gradleVersion:'9.2.1'})).toThrow('supplier_matrix_incomplete');
 });
});

describe('result consolidator uses observed supplier provenance',()=>{
 it.each([['version','supplier_identity_mismatch'],['stale-source','supplier_source_mismatch'],['arbitrary-trace','supplier_trace_invalid'],['legacy-report','supplier_matrix_incomplete']])('does not publish results for %s',async(mutation,reason)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'osv-supplier-aggregate-'));
  try{
   const repo=fileURLToPath(new URL('../../../',import.meta.url));
   const currentSources=Object.fromEntries(await Promise.all(supplierSourcePaths.map(async f=>[f,createHash('sha256').update(await readFile(path.join(repo,f))).digest('hex')])));
   const cases:any[]=['Groovy','Kotlin'].map(dsl=>{
    const data:any=structuredClone(fixture());data.consumerDSL=dsl;data.sourcesSha256=currentSources;
    for(const r of data.reports){r.consumerDSL=dsl;r.collectorSha256=currentSources['src/test/fixtures/gradle-kotlin-supplier.init.gradle'];}
    return data;
   });
   const matrix:any={schema:'osv-mcp.kotlin-supplier-matrix-v2',gradleVersion:'8.11.1',cases};
   if(mutation==='version')matrix.cases[0].reports[0].gradleVersion='9.2.1';
   if(mutation==='stale-source')matrix.cases[0].sourcesSha256={...currentSources,'src/test/gradle/kotlinPipelineSupplier.integration.test.ts':'b'.repeat(64)};
   if(mutation==='arbitrary-trace')matrix.cases[0].reports[1].trace=['unrelated-difference'];
   if(mutation==='legacy-report')matrix.schema='test-only-kotlin-supplier-proof';
   const prefix=path.join(root,'supplier'),out=path.join(root,'published.json');
   await writeFile(prefix+'-8.11.1.json',JSON.stringify(matrix));
   const result=spawnSync(process.execPath,[path.join(repo,'src/test/manual/gradleKotlinPipelineResults.mjs'),path.join(root,'observation'),prefix,out],{cwd:repo,encoding:'utf8',timeout:30000});
   expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);expect(result.stderr).toContain(reason);
   await expect(access(out)).rejects.toBeDefined();
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
