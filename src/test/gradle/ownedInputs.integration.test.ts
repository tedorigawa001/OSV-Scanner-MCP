/** Producer-source registration experiment; no production adapter is changed. */
import {execFile,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {ownedInputModes,ownedInputSourcePaths,ownedInputEvidenceTargets,ownedInputFaults,verifyOwnedInputsCase} from '../fixtures/gradleOwnedInputsProof.mjs';
const binary=process.env.OSV_MCP_TEST_GRADLE;
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const digest=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const sources=async()=>Object.fromEntries(await Promise.all(ownedInputSourcePaths.map(async f=>[f,await digest(path.join(repo,f))])));
const dirs:string[]=[],cases:any[]=[],rejections:any[]=[];
afterAll(async()=>{for(const d of dirs)await rm(d,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`Producer-owned registration (${dsl})`,()=>{
 let proof:any,faults:any[],evidenceRejections:any[];
 beforeAll(async()=>{
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-owned-registration-')));dirs.push(root);
  const version=execFileSync(binary!,['--version'],{env:process.env,encoding:'utf8'}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];
  if(!version)throw new Error('unsupported-native-version');
  const kotlinDslVersion=version==='8.11.1'?'5.1.1':'6.4.1';
  const kotlin=dsl==='Kotlin',ext=kotlin?'.gradle.kts':'.gradle';
  const producerBuild=kotlin?
   'plugins { `kotlin-dsl` }; repositories { mavenCentral() }; gradlePlugin { plugins { create("proof") { id="proof";implementationClass="proof.Proof" } } }; apply(from="owned-inputs.gradle"); (extra["installOwnedProof"] as groovy.lang.Closure<*>).call()\n':
   `plugins { id 'org.gradle.kotlin.kotlin-dsl' version '${kotlinDslVersion}' }; repositories { mavenCentral() }; gradlePlugin { plugins { proof { id='proof';implementationClass='proof.Proof' } } }; apply from: 'owned-inputs.gradle'; installOwnedProof()\n`;
  const files:Record<string,string>={
   ['settings'+ext]:kotlin?'pluginManagement { includeBuild("build-logic") }; rootProject.name="owned-consumer"\n':"pluginManagement { includeBuild('build-logic') };rootProject.name='owned-consumer'\n",
   ['build'+ext]:kotlin?'plugins { id("proof") }; tasks.register("verifyOwned") { dependsOn(gradle.includedBuild("build-logic").task(":ownedProof")) }\n':"plugins { id 'proof' }; tasks.register('verifyOwned') { dependsOn(gradle.includedBuild('build-logic').task(':ownedProof')) }\n",
   ['build-logic/settings'+ext]:kotlin?'rootProject.name="owned-producer"\n':"rootProject.name='owned-producer'\n",
   ['build-logic/build'+ext]:producerBuild,
   'build-logic/owned-inputs.gradle':await readFile(path.join(repo,'src/test/fixtures/gradle-owned-inputs-helper.gradle'),'utf8'),
   'build-logic/src/main/kotlin/proof/Proof.kt':'package proof\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\nclass Proof : Plugin<Project> { override fun apply(p: Project) { p.pluginManager.apply("java") } }\n',
   'build-logic/owned/a.txt':'first nonempty input\n','build-logic/owned/b.txt':'different second nonempty input\n'
  };
  for(const [f,body]of Object.entries(files)){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await writeFile(path.join(root,f),body);}
  const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async f=>[f,await digest(path.join(root,f))])));
  const sourcesSha256=await sources();
  await writeFile(path.join(root,'owned-baseline.json'),JSON.stringify({inputs:fixtureInputsSha256}));
  const runs:any[]=[],faultRuns=new Map<string,any>();
  for(const {observe,fault} of [{observe:false,fault:null},{observe:true,fault:null},...ownedInputFaults.map(fault=>({observe:true,fault}))]){
   const preGateRead=fault?.flag==='preGateRead',preGateKgpRead=fault?.flag==='preGateKgpRead';
   await rm(path.join(root,'build-logic/build'),{recursive:true,force:true});
   await rm(path.join(root,'owned-report.json'),{force:true});
   expect(await sources()).toEqual(sourcesSha256);
   const runId=randomUUID();
   const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,`-Dosv.owned.observe=${observe}`,`-Dosv.owned.runId=${runId}`,`-Dosv.owned.preGateRead=${preGateRead}`,`-Dosv.owned.preGateKgpRead=${preGateKgpRead}`,'verifyOwned','--offline','--rerun-tasks','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','-Pkotlin.compiler.execution.strategy=in-process','-Pkotlin.incremental=false','-Pkotlin.daemon.useFallbackStrategy=false','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
   if(result.code!==0)await writeFile(path.join(os.tmpdir(),`owned-failure-${version}-${dsl}.log`),result.output);
   expect(result.code,result.output).toBe(0);
   const r=JSON.parse(await readFile(path.join(root,'owned-report.json'),'utf8'));
   expect(r.runId).toBe(runId);expect(r.fixtureInputsSha256).toEqual(fixtureInputsSha256);expect(await sources()).toEqual(sourcesSha256);
   expect(r.preGateRead).toBe(preGateRead);expect(r.preGateKgpRead).toBe(preGateKgpRead);
   if(fault)faultRuns.set(fault.kind,r);else runs.push(r);
  }
  proof={schema:'osv-mcp.owned-input-case-v3',gradleVersion:runs[0].gradleVersion,consumerDSL:dsl,producerDSL:dsl,preGateRead:false,preGateKgpRead:false,sourcesSha256,fixtureInputsSha256,runs};
  verifyOwnedInputsCase(proof,{gradleVersion:proof.gradleVersion,consumerDSL:dsl,producerDSL:dsl,sourcesSha256});
  const approval={gradleVersion:proof.gradleVersion,consumerDSL:dsl,producerDSL:dsl,sourcesSha256};
  evidenceRejections=ownedInputEvidenceTargets.map(target=>{
   const changed=structuredClone(proof),record=changed.runs[target.runIndex].cases.find((s:any)=>s.mode===target.mode);
   record.events=record.events.filter((e:any)=>e.event!==target.event);
   let outcome:unknown,reason:string|undefined;
   try{outcome=verifyOwnedInputsCase(changed,approval);}catch(error){reason=(error as Error).message;}
   expect(outcome).toBeUndefined();expect(reason).toBe('owned_proof_event_inventory_invalid');
   return {...target,accepted:outcome!==undefined,reason};
  });
  faults=ownedInputFaults.map(({kind,flag})=>{
   const changed={...proof,[flag]:true,runs:[runs[0],faultRuns.get(kind)]};
   let outcome:unknown,reason:string|undefined;
   try{outcome=verifyOwnedInputsCase(changed,{...approval,[flag]:true});}catch(error){reason=(error as Error).message;}
   expect(outcome,kind).toBeUndefined();expect(reason,kind).toBe('owned_proof_getter_before_gate');
   return {kind,proof:changed,accepted:outcome!==undefined,reason};
  });
  cases.push({...proof,evidenceRejections});rejections.push(...faults);
  if(process.env.OSV_MCP_OWNED_INPUT_OUTPUT)await writeFile(process.env.OSV_MCP_OWNED_INPUT_OUTPUT,JSON.stringify({schema:'osv-mcp.owned-input-matrix-v3',gradleVersion:proof.gradleVersion,cases,rejections},null,2)+'\n');
 },900000);
 it('rejects an actual ready handle read before the gate',()=>expect(faults.find(f=>f.kind==='owned-pre-gate').reason).toBe('owned_proof_getter_before_gate'));
 it('records an actual unsupported KGP reader call before the gate and rejects it',()=>{
  const f=faults.find(f=>f.kind==='kgp-pre-gate'),s=f.proof.runs[1].cases.find((s:any)=>s.mode==='kgp-unsupported');
  expect(f.reason).toBe('owned_proof_getter_before_gate');
  expect(s.kgpGetterCalls).toBe(1);expect(s.events.filter((e:any)=>e.event.startsWith('kgp-getter:')).map((e:any)=>e.event)).toEqual(['kgp-getter:libraries']);
 });
 it('rejects every missing registration and Action boundary',()=>expect(evidenceRejections).toHaveLength(ownedInputEvidenceTargets.length));
 for(const mode of ownedInputModes)it(`verifies nonempty registration and no-read gate for ${mode}`,()=>{
  const s=proof.runs[1].cases.find((s:any)=>s.mode===mode);
  expect(s.decision.accepted).toBe(mode==='ready');
  if(mode==='ready')expect(s.readFiles).toHaveLength(4);
  else expect(s.getterCalls).toBe(0);
  expect(s.kgpGetterCalls).toBe(0);
 });
});
