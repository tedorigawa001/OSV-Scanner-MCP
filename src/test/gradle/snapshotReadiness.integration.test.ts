/** Snapshot-only cooperative binding experiment, never production adoption. */
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {snapshotModes,snapshotSources,verifySnapshotReadinessCase,verifySnapshotReadinessFault,snapshotStateRegressions} from '../fixtures/gradleSnapshotReadinessProof.mjs';
import {jarContents} from '../fixtures/gradlePluginJarProof.js';
const binary=process.env.OSV_MCP_TEST_GRADLE,repo=fileURLToPath(new URL('../../../',import.meta.url));
const digest=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const sources=async()=>Object.fromEntries(await Promise.all(snapshotSources.map(async p=>[p,await digest(path.join(repo,p))])));
const dirs:string[]=[],cases:any[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`Snapshot readiness (${dsl})`,()=>{
 let proof:any,decision:any,fault:any,stateRejections:any[];
 beforeAll(async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-snapshot-readiness-')));dirs.push(root);
  const version=execFileSync(binary!,['--version'],{env:process.env,encoding:'utf8'}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];if(!version)throw Error('unsupported-gradle');
  const audit=JSON.parse(await readFile(path.join(repo,'docs/validation/gradle-kgp-availability-2026-11-01.json'),'utf8'));
  const prior=audit.matrices.find((m:any)=>m.gradleVersion===version).cases[0].runs[0];
  const approvedApi={gradle:prior.apiArtifacts.gradle.sha256,kgp:prior.apiArtifacts.kgp.sha256,implementation:prior.implementation.sha256};
  const kotlin=dsl==='Kotlin',ext=kotlin?'.gradle.kts':'.gradle',kdsl=version==='8.11.1'?'5.1.1':'6.4.1';
  const files:Record<string,string>={
   ['settings'+ext]:kotlin?'includeBuild("build-logic"); rootProject.name="snapshot-consumer"\n':"includeBuild('build-logic');rootProject.name='snapshot-consumer'\n",
   ['build'+ext]:kotlin?'tasks.register("snapshotCheck") { dependsOn(gradle.includedBuild("build-logic").task(":snapshotProof")) }\n':"tasks.register('snapshotCheck') { dependsOn(gradle.includedBuild('build-logic').task(':snapshotProof')) }\n",
   ['build-logic/settings'+ext]:kotlin?'rootProject.name="snapshot-producer";gradle.beforeProject(object : org.gradle.api.Action<org.gradle.api.Project> { override fun execute(p: org.gradle.api.Project) { p.apply(mapOf("from" to p.file("snapshot-helper.gradle")));(p.extensions.extraProperties.get("installSnapshotProof") as groovy.lang.Closure<*>).call() } })\n':"rootProject.name='snapshot-producer';gradle.beforeProject { p -> p.apply from:p.file('snapshot-helper.gradle');p.extensions.extraProperties.get('installSnapshotProof').call() }\n",
   ['build-logic/build'+ext]:kotlin?'plugins { `kotlin-dsl` }; repositories { mavenCentral() }; gradlePlugin { plugins { create("proof") { id="proof";implementationClass="proof.Proof" } } }\n':`plugins { id 'org.gradle.kotlin.kotlin-dsl' version '${kdsl}' };repositories { mavenCentral() };gradlePlugin { plugins { proof { id='proof';implementationClass='proof.Proof' } } }\n`,
   'build-logic/src/main/kotlin/proof/Proof.kt':'package proof\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\nclass Proof : Plugin<Project> { override fun apply(p: Project) { p.pluginManager.apply("java") } }\n',
   'build-logic/src/main/resources/proof.txt':'nonempty resource\n',
   'build-logic/snapshot-helper.gradle':await readFile(path.join(repo,snapshotSources[0]!),'utf8')
  };
  for(const [p,body] of Object.entries(files)){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),body);}
  await mkdir(path.join(root,'build-logic/probe/tree'),{recursive:true});
  const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async p=>[p,await digest(path.join(root,p))]))),sourcesSha256=await sources();
  await writeFile(path.join(root,'snapshot-baseline.json'),JSON.stringify({inputs:fixtureInputsSha256,approvedApi}));
  const runs=[];let faultRun:any;
  for(const {mode,preflightReadFault} of [...snapshotModes.map(mode=>({mode,preflightReadFault:false})),{mode:'observe',preflightReadFault:true}]){
   await rm(path.join(root,'build-logic/build'),{recursive:true,force:true});await rm(path.join(root,'snapshot-report.json'),{force:true});expect(await sources()).toEqual(sourcesSha256);
   const runId=randomUUID();
   const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,`-Dosv.snapshot.mode=${mode}`,`-Dosv.snapshot.runId=${runId}`,`-Dosv.snapshot.preflightReadFault=${preflightReadFault}`,'snapshotCheck','--offline','--rerun-tasks','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','-Pkotlin.compiler.execution.strategy=in-process','-Pkotlin.incremental=false','-Pkotlin.daemon.useFallbackStrategy=false','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
   if(result.code!==0)await writeFile(path.join(os.tmpdir(),`snapshot-readiness-failure-${version}-${dsl}.log`),result.output);expect(result.code,result.output).toBe(0);
   const r=JSON.parse(await readFile(path.join(root,'snapshot-report.json'),'utf8'));expect(r.runId).toBe(runId);expect(await sources()).toEqual(sourcesSha256);expect(r.fixtureInputsSha256).toEqual(fixtureInputsSha256);
   for(const entry of Object.values(r.api) as any[])expect(await digest(entry.artifact)).toBe(entry.sha256);
   const jars=(await readdir(path.join(root,'build-logic/build/libs'))).filter(n=>n.endsWith('.jar'));expect(jars).toHaveLength(1);
   const bytes=await readFile(path.join(root,'build-logic/build/libs',jars[0]!));r.jarEntries=jarContents(bytes);r.archiveSha256=createHash('sha256').update(bytes).digest('hex');expect(r.preflightReadFault).toBe(preflightReadFault);if(preflightReadFault)faultRun=r;else runs.push(r);
  }
  proof={schema:'osv-mcp.snapshot-readiness-case-v2',gradleVersion:version,dsl,approvedApi,sourcesSha256,fixtureInputsSha256,runs};
  if(process.env.OSV_MCP_SNAPSHOT_READINESS_OUTPUT)await writeFile(process.env.OSV_MCP_SNAPSHOT_READINESS_OUTPUT+`.${dsl}.raw.json`,JSON.stringify({proof,faultRun},null,2)+'\n');
  const approval={gradleVersion:version,dsl,approvedApi,sourcesSha256};
  decision=verifySnapshotReadinessCase(proof,approval);stateRejections=snapshotStateRegressions(proof,approval);
  const changed={...proof,preflightReadFault:true,runs:runs.map(r=>r.mode==='observe'?faultRun:r)};
  const observation=verifySnapshotReadinessFault(changed,approval);
  fault={proof:changed,accepted:false,reason:'snapshot_readiness_preflight_read',observation};
  cases.push({...proof,decision,stateRejections,fault});
  if(process.env.OSV_MCP_SNAPSHOT_READINESS_OUTPUT)await writeFile(process.env.OSV_MCP_SNAPSHOT_READINESS_OUTPUT,JSON.stringify({schema:'osv-mcp.snapshot-readiness-matrix-v2',gradleVersion:version,cases},null,2)+'\n');
 },1600000);
 it('rejects a real cached value read before a refusing preflight',()=>expect(fault.observation).toMatchObject({actualPreflightReads:1,extraInstrumentedSuppliers:0}));
 it('rejects missing, mistyped or inconsistent TaskState flags',()=>expect(stateRejections).toHaveLength(80));
 for(const mode of snapshotModes)it(`records the real ${mode} condition`,()=>{
  const r=proof.runs.find((r:any)=>r.mode===mode);expect(r.productionAdopted).toBe(false);if(mode!=='observe')expect(r.getterCalls).toBe(0);
 });
 it('rejects early, different task and different property preflights without reading values',()=>{
  const checks=proof.runs[1].checks.slice(0,3);expect(checks).toHaveLength(3);expect(checks.every((c:any)=>!c.accepted&&c.getterCalls===0)).toBe(true);
 });
 it('does not add measured suppliers when rereading the bound snapshot',()=>{expect(proof.runs[1].calls).toBe(proof.runs[0].calls);expect(proof.runs[1].files.length).toBeGreaterThan(0);});
 it('records a real change attempt in a separate diagnostic build',()=>{expect(proof.runs[4].freeze.attempts).toBe(1);expect(decision.productionAdopted).toBe(false);});
});
