/** Acquisition diagnostics are not approved capture recipes. */
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {kgpSlots,kgpAvailabilitySources,verifyKgpAvailabilityCase,verifyApiArtifact,verifyKgpSnapshotFault,kgpAvailabilityRegressions} from '../fixtures/gradleKgpAvailabilityProof.mjs';
import {jarContents} from '../fixtures/gradlePluginJarProof.js';
const binary=process.env.OSV_MCP_TEST_GRADLE;
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const init=path.join(repo,'src/test/fixtures/gradle-kgp-availability.init.gradle');
const digest=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const sources=async()=>Object.fromEntries(await Promise.all(kgpAvailabilitySources.map(async f=>[f,await digest(path.join(repo,f))])));
const dirs:string[]=[],cases:any[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`KGP availability (${dsl})`,()=>{
 let proof:any,decision:any,fault:any,regressions:any[];
 beforeAll(async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-kgp-availability-')));dirs.push(root);
  const version=execFileSync(binary!,['--version'],{env:process.env,encoding:'utf8'}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];
  if(!version)throw Error('unsupported-gradle');
  const kotlin=dsl==='Kotlin',ext=kotlin?'.gradle.kts':'.gradle',kdsl=version==='8.11.1'?'5.1.1':'6.4.1';
  const files:Record<string,string>={
   ['settings'+ext]:kotlin?'pluginManagement { includeBuild("build-logic") }; rootProject.name="availability-consumer"\n':"pluginManagement { includeBuild('build-logic') }; rootProject.name='availability-consumer'\n",
   ['build'+ext]:kotlin?'plugins { id("proof") }\n':"plugins { id 'proof' }\n",
   ['build-logic/settings'+ext]:kotlin?'rootProject.name="availability-producer"\n':"rootProject.name='availability-producer'\n",
   ['build-logic/build'+ext]:kotlin?'plugins { `kotlin-dsl` }; repositories { mavenCentral() }; gradlePlugin { plugins { create("proof") { id="proof";implementationClass="proof.Proof" } } }\n':`plugins { id 'org.gradle.kotlin.kotlin-dsl' version '${kdsl}' }; repositories { mavenCentral() }; gradlePlugin { plugins { proof { id='proof';implementationClass='proof.Proof' } } }\n`,
   'build-logic/src/main/kotlin/proof/Proof.kt':'package proof\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\nclass Proof : Plugin<Project> { override fun apply(p: Project) { p.pluginManager.apply("java") } }\n',
   'build-logic/src/main/resources/proof.txt':'actual nonempty resource\n','build-logic/probe/input.txt':'nonempty task input sensor\n'
  };
  for(const [f,body]of Object.entries(files)){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await writeFile(path.join(root,f),body);}
  const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async f=>[f,await digest(path.join(root,f))]))),sourcesSha256=await sources();
  await writeFile(path.join(root,'availability-baseline.json'),JSON.stringify({inputs:fixtureInputsSha256}));
  const runs=[];let faultRun:any;
  for(const {mode,faultSnapshotRead} of [...['control','diagnostic','unsupported'].map(mode=>({mode,faultSnapshotRead:false})),{mode:'unsupported',faultSnapshotRead:true}]){
   await rm(path.join(root,'build-logic/build'),{recursive:true,force:true});await rm(path.join(root,'availability-report.json'),{force:true});
   expect(await sources()).toEqual(sourcesSha256);
   const runId=randomUUID();
   const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,'-I',init,`-Dosv.kgp.root=${root}`,`-Dosv.kgp.mode=${mode}`,`-Dosv.kgp.runId=${runId}`,`-Dosv.kgp.faultSnapshotRead=${faultSnapshotRead}`,'help','--offline','--rerun-tasks','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','-Pkotlin.compiler.execution.strategy=in-process','-Pkotlin.incremental=false','-Pkotlin.daemon.useFallbackStrategy=false','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
   if(result.code!==0)await writeFile(path.join(os.tmpdir(),`kgp-availability-failure-${version}-${dsl}.log`),result.output);
   expect(result.code,result.output).toBe(0);
   const r=JSON.parse(await readFile(path.join(root,'availability-report.json'),'utf8'));
   expect(r.runId).toBe(runId);expect(r.gradleVersion).toBe(version);expect(r.fixtureInputsSha256).toEqual(fixtureInputsSha256);expect(await sources()).toEqual(sourcesSha256);
   expect(await digest(r.implementation.artifact)).toBe(r.implementation.sha256);
   for(const binding of Object.values(r.apiArtifacts) as any[])expect(await digest(binding.artifact)).toBe(binding.sha256);
   const jars=(await readdir(path.join(root,'build-logic/build/libs'))).filter(n=>n.endsWith('.jar'));expect(jars).toHaveLength(1);
   const bytes=await readFile(path.join(root,'build-logic/build/libs',jars[0]!));r.archiveSha256=createHash('sha256').update(bytes).digest('hex');r.jarEntries=jarContents(bytes);
   expect(r.faultSnapshotRead).toBe(faultSnapshotRead);if(faultSnapshotRead)faultRun=r;else runs.push(r);
  }
  proof={schema:'osv-mcp.kgp-availability-case-v2',gradleVersion:version,dsl,sourcesSha256,fixtureInputsSha256,runs};
  if(process.env.OSV_MCP_KGP_AVAILABILITY_OUTPUT)await writeFile(process.env.OSV_MCP_KGP_AVAILABILITY_OUTPUT+`.${dsl}.raw.json`,JSON.stringify({proof,faultRun},null,2)+'\n');
  decision=verifyKgpAvailabilityCase(proof,{gradleVersion:version,dsl,sourcesSha256});
  const changed={...proof,faultSnapshotRead:true,runs:[runs[0],runs[1],faultRun]};let reason:string|undefined,outcome:unknown;
  try{outcome=verifyKgpAvailabilityCase(changed,{gradleVersion:version,dsl,sourcesSha256,faultSnapshotRead:true});}catch(error){reason=(error as Error).message;}
  fault={proof:changed,accepted:outcome!==undefined,reason};expect(fault.accepted).toBe(false);expect(reason).toBe('kgp_availability_no_read_violated');
  fault.observation=verifyKgpSnapshotFault(changed,{gradleVersion:version,dsl,sourcesSha256});
  regressions=kgpAvailabilityRegressions(changed,{gradleVersion:version,dsl,sourcesSha256});
  let apiReason:string|undefined;
  try{verifyApiArtifact(runs[0].apiArtifacts.gradle,runs[0].apiArtifacts.kgp);}catch(error){apiReason=(error as Error).message;}
  expect(apiReason).toBe('kgp_availability_api_artifact_mismatch');
  cases.push({...proof,decision,fault,regressions,apiMismatchRejection:{accepted:false,reason:apiReason}});
  if(process.env.OSV_MCP_KGP_AVAILABILITY_OUTPUT)await writeFile(process.env.OSV_MCP_KGP_AVAILABILITY_OUTPUT,JSON.stringify({schema:'osv-mcp.kgp-availability-matrix-v2',gradleVersion:version,cases},null,2)+'\n');
 },1200000);
 it('rejects an actual snapshot getter call even without extra supplier evaluations',()=>{expect(fault.reason).toBe('kgp_availability_no_read_violated');expect(fault.proof.runs[2].getterCalls.snapshots).toBe(1);});
 it('rejects a different runtime API artifact',()=>expect(()=>verifyApiArtifact(proof.runs[0].apiArtifacts.gradle,proof.runs[0].apiArtifacts.kgp)).toThrow('kgp_availability_api_artifact_mismatch'));
 it('rejects malformed or shifted fault trace evidence',()=>expect(regressions.every(r=>r.accepted===false)).toBe(true));
 for(const slot of kgpSlots)it(`records actual post-compile acquisition without adopting ${slot}`,()=>{
  expect(proof.runs[1].reads.find((r:any)=>r.slot===slot).files.length).toBeGreaterThan(0);
  expect(decision.slots.find((s:any)=>s.slot===slot).status).toBe('unsupported');
 });
 it('refuses every unsupported slot with no source getter calls',()=>{expect(proof.runs[2].events.some((e:any)=>e.event.startsWith('getter:'))).toBe(false);expect(proof.runs[2].decisions).toHaveLength(4);});
 it('keeps all candidate and production adoption decisions disabled',()=>expect(decision).toMatchObject({adopted:false,ownerReceiptSupported:false,stableRereadSupported:false}));
});
