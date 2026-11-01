/** Adversarial public FileCollection supplier probe with observation-time provenance. */
import { execFile } from "node:child_process";
import { createHash,randomUUID } from "node:crypto";
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { verifySupplierProof,supplierSourcePaths } from "../fixtures/gradleKotlinSupplierProof.mjs";
const binary=process.env.OSV_MCP_TEST_GRADLE;
const repo=fileURLToPath(new URL("../../../",import.meta.url));
const sourcePaths=supplierSourcePaths;
const init=path.join(repo,sourcePaths[1]!);
const hash=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourcePaths.map(async f=>[f,await hash(path.join(repo,f))])));
const dirs:string[]=[],cases:any[]=[];
afterAll(async()=>{for(const root of dirs)await rm(root,{recursive:true,force:true});});
for(const consumerDSL of ['Groovy','Kotlin'])describe.skipIf(!binary)(`Kotlin public collection non-interference gate (${consumerDSL} consumer)`,()=>{
 let proof:any,approval:any;
 beforeAll(async()=>{
  const sourcesSha256=await sourceHashes();
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-kotlin-supplier-')));dirs.push(root);
  const producer=path.join(root,'build-logic');
  const files:Record<string,string>={
   [consumerDSL==='Kotlin'?'settings.gradle.kts':'settings.gradle']:consumerDSL==='Kotlin'?'pluginManagement { includeBuild("build-logic") };rootProject.name="supplier-consumer"\n':"pluginManagement { includeBuild('build-logic') };rootProject.name='supplier-consumer'\n",
   [consumerDSL==='Kotlin'?'build.gradle.kts':'build.gradle']:consumerDSL==='Kotlin'?'plugins { id("proof") }\n':"plugins { id 'proof' }\n",
   'build-logic/settings.gradle.kts':'rootProject.name="supplier-proof"\n',
   'build-logic/build.gradle.kts':'plugins { `kotlin-dsl` }; repositories { mavenCentral() }\n',
   'build-logic/src/main/kotlin/proof.gradle.kts':'plugins { java }\n'
  };
  for(const [f,body]of Object.entries(files)){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await writeFile(path.join(root,f),body);}
  const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async f=>[f,await hash(path.join(root,f))])));
  await writeFile(path.join(root,'supplier-baseline.json'),JSON.stringify({inputs:fixtureInputsSha256}));
  const reports=[];
  for(const observe of [false,true]){
   // The trusted caller explicitly clears producer outputs before each fresh compile.
   await rm(path.join(producer,'build'),{recursive:true,force:true});
   await rm(path.join(producer,'supplier-report.json'),{force:true});
   const runId=randomUUID();
   expect(await sourceHashes()).toEqual(sourcesSha256);
   const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,'-I',init,`-Dosv.observe=${observe}`,`-Dosv.supplier.root=${root}`,`-Dosv.supplier.runId=${runId}`,`-Dosv.supplier.collector=${init}`,'help','--rerun-tasks','--offline','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=2','-Pkotlin.compiler.execution.strategy=in-process','-Pkotlin.incremental=false','-Pkotlin.daemon.useFallbackStrategy=false','--console=plain'],{env:process.env,timeout:240000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
   expect(result.code,result.output).toBe(0);
   expect(await sourceHashes()).toEqual(sourcesSha256);
   const report=JSON.parse(await readFile(path.join(producer,'supplier-report.json'),'utf8'));
   expect(report.runId).toBe(runId);expect(report.observe).toBe(observe);
   expect(report.fixtureInputsSha256).toEqual(fixtureInputsSha256);reports.push(report);
  }
  proof={schema:'osv-mcp.kotlin-supplier-proof-v2',gradleVersion:reports[0].gradleVersion,consumerDSL,sourcesSha256,fixtureInputsSha256,reports};
  approval={gradleVersion:proof.gradleVersion,consumerDSL,sourcesSha256};
  verifySupplierProof(proof,approval);
  cases.push(proof);
  if(process.env.OSV_MCP_KOTLIN_SUPPLIER_OUTPUT)await writeFile(process.env.OSV_MCP_KOTLIN_SUPPLIER_OUTPUT,JSON.stringify({schema:'osv-mcp.kotlin-supplier-matrix-v2',gradleVersion:proof.gradleVersion,cases},null,2)+'\n');
 },510000);
 it('rejects the public recipe because an additional supplier evaluation occurs post-compile',()=>{
  expect(verifySupplierProof(proof,approval)).toEqual({controlCalls:3,observedCalls:4,extraPhase:'post-compile'});
 });
});
