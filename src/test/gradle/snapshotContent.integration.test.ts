/** Test-only content-boundary diagnostic, not a natural-consumption receipt. */
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {contentModes,contentSources,verifySnapshotContentCase,contentRegressions,contentCaseRegressions} from '../fixtures/gradleSnapshotContentProof.mjs';
import {jarContents} from '../fixtures/gradlePluginJarProof.js';
const binary=process.env.OSV_MCP_TEST_GRADLE,repo=fileURLToPath(new URL('../../../',import.meta.url));
const digest=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const sources=async()=>Object.fromEntries(await Promise.all(contentSources.map(async p=>[p,await digest(path.join(repo,p))])));
const dirs:string[]=[],cases:any[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`Snapshot content (${dsl})`,()=>{
 let proof:any,decision:any;
 beforeAll(async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-snapshot-content-')));dirs.push(root);
  const version=execFileSync(binary!,['--version'],{env:process.env,encoding:'utf8'}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];if(!version)throw Error('unsupported-gradle');
  const audit=JSON.parse(await readFile(path.join(repo,'docs/validation/gradle-kgp-availability-2026-11-01.json'),'utf8'));
  const prior=audit.matrices.find((m:any)=>m.gradleVersion===version).cases[0].runs[0];
  const approvedApi={gradle:prior.apiArtifacts.gradle.sha256,kgp:prior.apiArtifacts.kgp.sha256,implementation:prior.implementation.sha256};
  const kotlin=dsl==='Kotlin',ext=kotlin?'.gradle.kts':'.gradle',kdsl=version==='8.11.1'?'5.1.1':'6.4.1';
  const files:Record<string,string>={
   ['settings'+ext]:kotlin?'includeBuild("build-logic"); rootProject.name="snapshot-consumer"\n':"includeBuild('build-logic');rootProject.name='snapshot-consumer'\n",
   ['build'+ext]:kotlin?'tasks.register("snapshotCheck") { dependsOn(gradle.includedBuild("build-logic").task(":snapshotProof")) }\n':"tasks.register('snapshotCheck') { dependsOn(gradle.includedBuild('build-logic').task(':snapshotProof')) }\n",
   ['build-logic/settings'+ext]:kotlin?'rootProject.name="snapshot-producer";gradle.beforeProject(object : org.gradle.api.Action<org.gradle.api.Project> { override fun execute(p: org.gradle.api.Project) { p.apply(mapOf("from" to p.file("snapshot-helper.gradle")));(p.extensions.extraProperties.get("installSnapshotContentProof") as groovy.lang.Closure<*>).call() } })\n':"rootProject.name='snapshot-producer';gradle.beforeProject { p -> p.apply from:p.file('snapshot-helper.gradle');p.extensions.extraProperties.get('installSnapshotContentProof').call() }\n",
   ['build-logic/build'+ext]:kotlin?'plugins { `kotlin-dsl` }; repositories { mavenCentral() }; gradlePlugin { plugins { create("proof") { id="proof";implementationClass="proof.Proof" } } }\n':`plugins { id 'org.gradle.kotlin.kotlin-dsl' version '${kdsl}' };repositories { mavenCentral() };gradlePlugin { plugins { proof { id='proof';implementationClass='proof.Proof' } } }\n`,
   'build-logic/src/main/kotlin/proof/Proof.kt':'package proof\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\nclass Proof : Plugin<Project> { override fun apply(p: Project) { p.pluginManager.apply("java") } }\n',
   'build-logic/src/main/resources/proof.txt':'nonempty resource\n',
   'build-logic/snapshot-helper.gradle':await readFile(path.join(repo,contentSources[0]!),'utf8')
  };
  for(const [p,body] of Object.entries(files)){await mkdir(path.dirname(path.join(root,p)),{recursive:true});await writeFile(path.join(root,p),body);}
  await mkdir(path.join(root,'build-logic/probe/tree'),{recursive:true});
  const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async p=>[p,await digest(path.join(root,p))]))),sourcesSha256=await sources();
  await writeFile(path.join(root,'snapshot-baseline.json'),JSON.stringify({inputs:fixtureInputsSha256,approvedApi}));

  const runs=[],faults=[];
  for(const {mode,readFault} of [...contentModes.map(mode=>({mode,readFault:'none'})),{mode:'boundary',readFault:'capture'},{mode:'no-receipt',readFault:'no-receipt'}]){
   await rm(path.join(root,'build-logic/build'),{recursive:true,force:true});await rm(path.join(root,'snapshot-report.json'),{force:true});expect(await sources()).toEqual(sourcesSha256);
   const runId=randomUUID();
   const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,`-Dosv.content.mode=${mode}`,`-Dosv.content.readFault=${readFault}`,`-Dosv.content.runId=${runId}`,'snapshotCheck','--offline','--rerun-tasks','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','-Pkotlin.compiler.execution.strategy=in-process','-Pkotlin.incremental=false','-Pkotlin.daemon.useFallbackStrategy=false','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
   if(result.code!==0)await writeFile(path.join(os.tmpdir(),`snapshot-content-failure-${version}-${dsl}.log`),result.output);expect(result.code,result.output).toBe(0);
   const r=JSON.parse(await readFile(path.join(root,'snapshot-report.json'),'utf8'));expect(r.runId).toBe(runId);expect(await sources()).toEqual(sourcesSha256);expect(r.fixtureInputsSha256).toEqual(fixtureInputsSha256);
   for(const entry of Object.values(r.api) as any[])expect(await digest(entry.artifact)).toBe(entry.sha256);
   const jars=(await readdir(path.join(root,'build-logic/build/libs'))).filter(n=>n.endsWith('.jar'));expect(jars).toHaveLength(1);
   const bytes=await readFile(path.join(root,'build-logic/build/libs',jars[0]!));r.jarEntries=jarContents(bytes);r.archiveSha256=createHash('sha256').update(bytes).digest('hex');expect(r.readFault).toBe(readFault);if(readFault==='none')runs.push(r);else faults.push(r);
  }
  proof={schema:'osv-mcp.snapshot-content-case-v2',gradleVersion:version,dsl,approvedApi,sourcesSha256,fixtureInputsSha256,runs,faults};
  if(process.env.OSV_MCP_SNAPSHOT_CONTENT_OUTPUT)await writeFile(process.env.OSV_MCP_SNAPSHOT_CONTENT_OUTPUT+`.${dsl}.raw.json`,JSON.stringify(proof,null,2)+'\n');
  decision=verifySnapshotContentCase(proof,{gradleVersion:version,dsl,approvedApi,sourcesSha256});
  const regressions=contentRegressions(proof,{gradleVersion:version,dsl,approvedApi,sourcesSha256});
  const caseRegressions=contentCaseRegressions(proof,{gradleVersion:version,dsl,approvedApi,sourcesSha256});
  cases.push({...proof,decision,regressions,caseRegressions});
  if(process.env.OSV_MCP_SNAPSHOT_CONTENT_OUTPUT)await writeFile(process.env.OSV_MCP_SNAPSHOT_CONTENT_OUTPUT,JSON.stringify({schema:'osv-mcp.snapshot-content-matrix-v2',gradleVersion:version,cases},null,2)+'\n');
 },1800000);
 for(const mode of contentModes)it(`validates ${mode} using retained concrete files`,()=>{
  const r=proof.runs.find((r:any)=>r.mode===mode);expect(r.productionAdopted).toBe(false);expect(r.getterCalls).toBe(['control','no-receipt'].includes(mode)?0:1);
 });
 for(const readFault of ['capture','no-receipt'])it(`rejects an actual cached read in ${readFault}`,()=>expect(decision.faults.find((f:any)=>f.readFault===readFault)).toMatchObject({actualCachedReads:1,extraInstrumentedSuppliers:0,accepted:false}));
 it('keeps exact natural-consumption adoption unavailable',()=>expect(decision.naturalContentBindings).toBe(0));
});
