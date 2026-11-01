/** Native opt-in closed producer-owned BTA driver; no natural-consumption receipt. */
import {execFile,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {btaDriverProfiles} from '../fixtures/gradleBtaDriverRuntime.mjs';
import {btaModes,btaSources,hash,verifyBtaDriverCase,btaDriverRegressions} from '../fixtures/gradleBtaDriverProof.mjs';
import {jarContents} from '../fixtures/gradlePluginJarProof.js';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),binary=process.env.OSV_MCP_TEST_GRADLE;
const digest=async(p:string)=>hash(await readFile(p));
const fingerprints=async()=>Object.fromEntries(await Promise.all(btaSources.map(async p=>[p,await digest(path.join(repo,p))])));
const dirs:string[]=[],cases:any[]=[];
afterAll(async()=>{for(const root of dirs)await rm(root,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`BTA owned driver (${dsl})`,()=>{
 let proof:any,decision:any;
 beforeAll(async()=>{
  if(!process.env.JAVA_HOME||!process.env.GRADLE_USER_HOME)throw Error('missing-native-environment');
  const java=path.join(process.env.JAVA_HOME,'bin/java'),javaSha256=await digest(java);
  const version=execFileSync(binary!,['--version'],{env:process.env,encoding:'utf8'}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];if(!version)throw Error('unsupported-gradle');
  const profile=btaDriverProfiles[version]!;
  const runtime=await Promise.all(profile.runtime.map(async e=>{const artifact=await realpath(path.join(process.env.GRADLE_USER_HOME!,e.relativePath));expect(await digest(artifact)).toBe(e.sha256);return {...e,artifact};}));
  const stdlib=runtime.find(e=>e.coordinate.startsWith('org.jetbrains.kotlin:kotlin-stdlib:'))!.artifact;
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-bta-owned-')));dirs.push(root);
  const ext=dsl==='Kotlin'?'.gradle.kts':'.gradle';
  const files:Record<string,string>={['settings'+ext]:'rootProject.name="bta-owned-producer"\n',['build'+ext]:dsl==='Kotlin'?'apply(from="driver.gradle")\n':"apply from: 'driver.gradle'\n",'driver.gradle':await readFile(path.join(repo,btaSources[1]!),'utf8'),'BtaOwnedDriver.java':await readFile(path.join(repo,btaSources[0]!),'utf8')};
  const fixtureFiles=[...Object.keys(files),'runtime-profile.json'];
  files['runtime-profile.json']=JSON.stringify({kotlinVersion:profile.kotlinVersion,runtime,stdlib,fixtureFiles});
  for(const [name,body]of Object.entries(files))await writeFile(path.join(root,name),body);
  const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async name=>[name,await digest(path.join(root,name))]))),sourcesSha256=await fingerprints();
  const runs=[];
  for(const mode of btaModes){
   await rm(path.join(root,'build'),{recursive:true,force:true});for(const name of ['driver-report.json','gradle-report.json'])await rm(path.join(root,name),{force:true});expect(await fingerprints()).toEqual(sourcesSha256);
   const runId=crypto.randomUUID();
   const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,`-Dosv.bta.mode=${mode}`,`-Dosv.bta.runId=${runId}`,'btaDriver','--offline','--no-daemon','--no-configuration-cache','--no-build-cache','--rerun-tasks','--no-parallel','--max-workers=1','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
   if(result.code)await writeFile(path.join(os.tmpdir(),`bta-owned-failure-${version}-${dsl}.log`),result.output);expect(result.code,result.output).toBe(0);
   const program=JSON.parse(await readFile(path.join(root,'driver-report.json'),'utf8')),gradle=JSON.parse(await readFile(path.join(root,'gradle-report.json'),'utf8'));
   expect(gradle.fixtureInputsSha256).toEqual(fixtureInputsSha256);expect(await fingerprints()).toEqual(sourcesSha256);
   for(const e of program.runtime)expect(await digest(e.artifact)).toBe(e.sha256);
   for(const e of program.driverClasses)expect(await digest(path.join(root,'build/driver-classes',e.path))).toBe(e.sha256);
   expect(await digest(path.join(root,'build/owned/library.jar'))).toBe(program.library.jarSha256);
   const libraryJarEntries=jarContents(await readFile(path.join(root,'build/owned/library.jar')));
   for(const c of program.compilations){expect(await digest(path.join(root,c.source))).toBe(c.stage==='warm'?program.finalSourceSha256:c.sourceSha256);}
   const last=program.compilations.at(-1),out=path.join(root,'build/owned/consumer-classes');
   for(const e of last.outputs)expect(await digest(path.join(out,e.path))).toBe(e.sha256);
   const output=execFileSync(java,['-cp',[out,path.join(root,'build/owned/library.jar'),stdlib].join(path.delimiter),'consumer.ConsumerKt'],{encoding:'utf8',timeout:30000});
   const execution={stage:last.stage,code:0,stdout:output};
   runs.push({schema:'osv-mcp.bta-driver-run-v2',gradleVersion:version,dsl,mode,runId,program,gradle,libraryJarEntries,execution});
  }
  proof={schema:'osv-mcp.bta-driver-case-v2',gradleVersion:version,dsl,javaSha256,sourcesSha256,fixtureInputsSha256,runs};
  if(process.env.OSV_MCP_BTA_DRIVER_OUTPUT)await writeFile(process.env.OSV_MCP_BTA_DRIVER_OUTPUT+`.${dsl}.raw.json`,JSON.stringify(proof,null,2)+'\n');
  const approval={gradleVersion:version,dsl,javaSha256,sourcesSha256};decision=verifyBtaDriverCase(proof,approval);
  const regressions=btaDriverRegressions(proof,approval);cases.push({...proof,decision,regressions});
  if(process.env.OSV_MCP_BTA_DRIVER_OUTPUT)await writeFile(process.env.OSV_MCP_BTA_DRIVER_OUTPUT,JSON.stringify({schema:'osv-mcp.bta-driver-matrix-v2',gradleVersion:version,cases},null,2)+'\n');
 },1800000);
 for(const mode of btaModes)it(`checks real BTA inputs and outputs for ${mode}`,()=>expect(proof.runs.find((r:any)=>r.mode===mode).program.naturalContentBinding).toBe(false));
 for(const mode of ['default-config','unregistered-config','foreign-config'])it(`rejects the actual final consumer configuration: ${mode}`,()=>{const r=proof.runs.find((r:any)=>r.mode===mode);expect(r.program.configurationChecks.at(-1).reason).toBe(mode==='foreign-config'?'bta_driver_configuration_binding_mismatch':'bta_driver_configuration_unregistered');expect(r.program.compilations).toHaveLength(2);expect(r.execution.stage).toBe('warm');});
 it('keeps natural receipts and production adoption unavailable',()=>expect(decision).toMatchObject({naturalContentBindings:0,productionAdoptions:0}));
 it('rejects an actual additional Gradle provider evaluation',()=>expect(decision.runs[btaModes.indexOf('source-fault')]).toMatchObject({reason:'bta_driver_extra_evaluation',extraMeasuredSupplierEvaluations:1}));
});
