/** Public full-reader experiment. Producer-owned finalization changes the build contract. */
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,readdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {observerSourcePaths,verifyObserverCase} from '../fixtures/gradleKotlinObserverProof.mjs';
import {jarContents} from '../fixtures/gradlePluginJarProof.js';
const binary=process.env.OSV_MCP_TEST_GRADLE;
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const init=path.join(repo,'src/test/fixtures/gradle-kotlin-observer.init.gradle');
const digest=async(f:string)=>createHash('sha256').update(await readFile(f)).digest('hex');
const sources=async()=>Object.fromEntries(await Promise.all(observerSourcePaths.map(async f=>[f,await digest(path.join(repo,f))])));
const modes=(process.env.OSV_MCP_OBSERVER_MODES??'raw,owned,tainted').split(',');
const evidenceTargets=[
 ...['pre-compileKotlin','compileKotlin','compileJava','pluginDescriptors','processResources','jar'].map(task=>({task,field:null as string|null,name:'receipt:'+task})),
 ...[['pre-compileKotlin','classes'],['pre-compileKotlin','javaSources'],['compileKotlin','settings'],['compileJava','javaOutputs'],['pluginDescriptors','readSlots'],['processResources','readSlots'],['jar','manifest'],['jar','archive'],['jar','temporaryRoot']].map(([task,field])=>({task:task!,field:field!,name:task+':'+field})),
 ...['libraries','snapshots','compilerClasspath','plugins','taskInputs','taskOutputs'].map(field=>({task:'compileKotlin',field:'readSlots.'+field,name:'compileKotlin:readSlots.'+field})),
 ...['taskInputs','taskOutputs'].map(field=>({task:'jar',field:'readSlots.'+field,name:'jar:readSlots.'+field}))
];
const dirs:string[]=[],cases:any[]=[],rejections:any[]=[];
afterAll(async()=>{for(const root of dirs)await rm(root,{recursive:true,force:true});},120000);
for(const consumerDSL of ['Groovy','Kotlin'])describe.skipIf(!binary)(`Full Kotlin observer (${consumerDSL} consumer)`,()=>{
 const proofs=new Map<string,any>();
 let eagerRejection:any;
 beforeAll(async()=>{
  for(const {mode,eagerCompiler} of [...modes.map(mode=>({mode,eagerCompiler:false})),...(modes.includes('owned')?[{mode:'owned',eagerCompiler:true}]:[])]){
   const sourcesSha256=await sources(),root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-full-observer-')));dirs.push(root);
   const producer=path.join(root,'build-logic');
   const files:Record<string,string>={
    [consumerDSL==='Kotlin'?'settings.gradle.kts':'settings.gradle']:consumerDSL==='Kotlin'?'pluginManagement { includeBuild("build-logic") };rootProject.name="observer-consumer"\n':"pluginManagement { includeBuild('build-logic') };rootProject.name='observer-consumer'\n",
    [consumerDSL==='Kotlin'?'build.gradle.kts':'build.gradle']:consumerDSL==='Kotlin'?'plugins { id("proof") }\n':"plugins { id 'proof' }\n",
    'build-logic/settings.gradle.kts':'rootProject.name="observer-proof"\n',
    'build-logic/build.gradle.kts':'plugins { `kotlin-dsl` }; repositories { mavenCentral() }; gradlePlugin { plugins { create("proof") { id="proof";implementationClass="proof.Proof" } } }\n',
    'build-logic/src/main/kotlin/proof/Proof.kt':'package proof\nimport org.gradle.api.Plugin\nimport org.gradle.api.Project\nclass Proof : Plugin<Project> { override fun apply(p: Project) { p.pluginManager.apply("java") } }\n',
    'build-logic/src/main/resources/proof-resource.txt':'stable-resource\n'
   };
   for(const [f,body]of Object.entries(files)){await mkdir(path.dirname(path.join(root,f)),{recursive:true});await writeFile(path.join(root,f),body);}
   const fixtureInputsSha256=Object.fromEntries(await Promise.all(Object.keys(files).map(async f=>[f,await digest(path.join(root,f))])));
   await writeFile(path.join(root,'observer-baseline.json'),JSON.stringify({inputs:fixtureInputsSha256,mode}));
   const runs=[];
   for(const observe of [false,true]){
    await rm(path.join(producer,'build'),{recursive:true,force:true});
    await rm(path.join(root,'observer-report.json'),{force:true});await writeFile(path.join(root,'observer-trace.jsonl'),'');
    expect(await sources()).toEqual(sourcesSha256);
    const runId=randomUUID();
    const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,['-p',root,'-I',init,`-Dosv.observer.root=${root}`,`-Dosv.observer.mode=${mode}`,`-Dosv.observer.enabled=${observe}`,`-Dosv.observer.eagerCompiler=${eagerCompiler}`,`-Dosv.observer.runId=${runId}`,`-Dosv.observer.collector=${init}`,'help','--offline','--rerun-tasks','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','-Pkotlin.compiler.execution.strategy=in-process','-Pkotlin.incremental=false','-Pkotlin.daemon.useFallbackStrategy=false','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?typeof e.code==='number'?e.code:-1:0,output:out+err})));
    expect(result.code,result.output).toBe(0);expect(await sources()).toEqual(sourcesSha256);
    const r=JSON.parse(await readFile(path.join(root,'observer-report.json'),'utf8'));
    expect(r.runId).toBe(runId);expect(r.fixtureInputsSha256).toEqual(fixtureInputsSha256);
    const archive=(await readdir(path.join(producer,'build/libs'))).filter(n=>n.endsWith('.jar'));
    expect(archive).toHaveLength(1);
    r.jarEntries=jarContents(await readFile(path.join(producer,'build/libs',archive[0]!)));
    r.trace=(await readFile(path.join(root,'observer-trace.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    for(const receipt of r.receipts)for(const p of receipt.readSlots?.plugins??[])if(p.origin)p.origin=p.origin.replaceAll(root,'$FIXTURE').replaceAll(process.env.GRADLE_USER_HOME??'__none__','$GRADLE_CACHE').replaceAll(path.dirname(path.dirname(binary!)),'$GRADLE_HOME');
    runs.push(r);
   }
   const proof={schema:'osv-mcp.kotlin-full-observer-case-v2',gradleVersion:runs[0].gradleVersion,consumerDSL,mode,eagerCompiler,sourcesSha256,fixtureInputsSha256,runs};
   if(process.env.OSV_MCP_KOTLIN_OBSERVER_OUTPUT)await writeFile(process.env.OSV_MCP_KOTLIN_OBSERVER_OUTPUT+`.${consumerDSL}.${mode}${eagerCompiler?'-eager':''}.raw.json`,JSON.stringify(proof,null,2)+'\n');
   const approval={gradleVersion:proof.gradleVersion,consumerDSL,mode,eagerCompiler,sourcesSha256};
   if(eagerCompiler){
    let reason:string|undefined,outcome:unknown;
    try{outcome=verifyObserverCase(proof,approval);}catch(error){reason=(error as Error).message;}
    const accepted=outcome!==undefined;expect(accepted).toBe(false);expect(reason).toBe('observer_policy_early_evaluation');
    eagerRejection={proof,accepted,reason};rejections.push(eagerRejection);
   }else{
    const decision=verifyObserverCase(proof,approval);
    const evidenceRejections=[];
    for(const target of evidenceTargets){
     const changed=structuredClone(proof),record=changed.runs[1].receipts.find((r:any)=>r.task===target.task);
     if(target.field===null)changed.runs[1].receipts=changed.runs[1].receipts.filter((r:any)=>r.task!==target.task);
     else if(target.field.startsWith('readSlots.'))delete record.readSlots[target.field.slice('readSlots.'.length)];
     else delete record[target.field];
     let outcome:unknown,reason:string|undefined;
     try{outcome=verifyObserverCase(changed,approval);}catch(error){reason=(error as Error).message;}
     const rejection={name:target.name,accepted:outcome!==undefined,reason};
     expect(rejection.accepted,target.name).toBe(false);expect(reason,target.name).toBe('observer_read_inventory_incomplete');
     evidenceRejections.push(rejection);
    }
    proofs.set(mode,{proof,decision,evidenceRejections});cases.push({...proof,decision,evidenceRejections});
   }
   if(process.env.OSV_MCP_KOTLIN_OBSERVER_OUTPUT)await writeFile(process.env.OSV_MCP_KOTLIN_OBSERVER_OUTPUT,JSON.stringify({schema:'osv-mcp.kotlin-full-observer-matrix-v2',gradleVersion:proof.gradleVersion,cases,rejections},null,2)+'\n');
  }
 },1900000);
 it.skipIf(!modes.includes('owned'))('rejects compilerClasspath eager finalization at the producer boundary',()=>{expect(eagerRejection?.reason).toBe('observer_policy_early_evaluation');});
 for(const mode of modes)it(`records the entire reader and its supplier trace under ${mode}`,()=>{
  const {proof,decision,evidenceRejections}=proofs.get(mode);
  expect(evidenceRejections).toHaveLength(evidenceTargets.length);
  if(mode==='owned')expect(decision.equal,JSON.stringify(decision)).toBe(true);
  else{expect(decision.equal).toBe(false);expect(decision.extraEvaluations.length).toBeGreaterThan(0);}
  expect(decision.productionAdopted).toBe(false);
  if(mode==='tainted')expect(decision.extraEvaluations.some((e:any)=>e.event==='supplier:unownedJarSource')).toBe(true);
  const observed=proof.runs[1];
  expect(observed.receipts.find((r:any)=>r.task==='pre-compileKotlin').classes).toEqual({});
  expect(observed.receipts.find((r:any)=>r.task==='compileKotlin').settings).toEqual({incremental:false,strategy:'IN_PROCESS',fallback:false});
  expect(observed.receipts.find((r:any)=>r.task==='pluginDescriptors').readSlots.declarations).toEqual([{id:'proof',implementationClass:'proof.Proof'}]);
  expect(observed.receipts.find((r:any)=>r.task==='processResources').didWork).toBe(true);
  const java=observed.receipts.find((r:any)=>r.task==='compileJava');expect(java.noSource).toBe(true);expect(java.javaOutputs).toEqual({});
  for(const r of proof.runs){
   expect(r.trace.filter((e:any)=>e.event==='plugin-application:proof')).toHaveLength(1);expect(r.trace.some((e:any)=>e.event==='supplier:unused')).toBe(false);
   for(const t of ['compilerClasspath','compileKotlin','jar']){
    const begin=r.trace.findIndex((e:any)=>e.event==='policy:begin:'+t),end=r.trace.findIndex((e:any)=>e.event==='policy:end:'+t);
    expect(begin).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(begin);
    expect(r.trace.slice(begin,end+1).some((e:any)=>e.event.startsWith('supplier:'))).toBe(false);
   }
  }
 });
 it.skipIf(!modes.includes('raw')||!modes.includes('owned'))('does not call producer-owned finalization transparent to the original baseline',()=>{
  const count=(mode:string)=>proofs.get(mode).proof.runs[0].trace.filter((e:any)=>e.event==='supplier:libraries').length;
  expect(count('owned')).toBeLessThan(count('raw'));
  expect(proofs.get('owned').proof.runs[0].jarEntries).toEqual(proofs.get('raw').proof.runs[0].jarEntries);
 });
});
