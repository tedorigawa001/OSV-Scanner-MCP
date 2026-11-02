/** Owned javac construction proof only. No KGP build is observed or production profile approved. */
import {execFile,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,realpath,access} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,it,expect} from 'vitest';
import {verifyBuildCase} from '../fixtures/ownedJavacContract.mjs';
import {buildCases,javacSources} from '../fixtures/ownedJavacExpected.mjs';
import {sha256} from '../fixtures/ownedManifestContract.mjs';
import {offerJdkProfile} from '../fixtures/btaOfferContract.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),binary=process.env.OSV_MCP_TEST_GRADLE;
const roots:string[]=[],records:any[]=[];
afterAll(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`owned javac construction (${dsl})`,()=>{
 let record:any,policy:any;
 beforeAll(async()=>{
  const version=execFileSync(binary!,['--version'],{encoding:'utf8',env:process.env}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];if(!version||!process.env.JAVA_HOME||!process.env.GRADLE_USER_HOME)throw Error('native environment missing');
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-owned-javac-')));roots.push(root);const ext=dsl==='Kotlin'?'.gradle.kts':'.gradle';
  const files={['settings'+ext]:'rootProject.name="owned-javac-proof"\n',['build'+ext]:dsl==='Kotlin'?'apply(from="recipe.gradle")\n':"apply from: 'recipe.gradle'\n",'recipe.gradle':await readFile(path.join(repo,'src/test/fixtures/gradle-owned-javac.gradle'),'utf8')};
  for(const [p,b]of Object.entries(files))await writeFile(path.join(root,p),b);
  const fixtureHashes=Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(b)]));
  const executorHashes=Object.fromEntries(await Promise.all(javacSources.map(async(f:string)=>[f,sha256(await readFile(path.join(repo,f)))])));
  const executionId=randomUUID(),args=['-p',root,'ownedJavacProof',`-Dosv.javac.executionId=${executionId}`,`-Dosv.javac.node=${process.execPath}`,`-Dosv.javac.producer=${path.join(repo,'src/test/fixtures/ownedJavacProducer.mjs')}`,'--offline','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','--console=plain','--stacktrace'];
  // Offer an executor preload through NODE_OPTIONS; the recipe must not pass it to the owned executor.
  const marker=path.join(root,'preload-marker'),preload=path.join(root,'preload.cjs'),preloadBody=`require('fs').writeFileSync(${JSON.stringify(marker)},'loaded');\n`;await writeFile(preload,preloadBody);
  const result=await new Promise<{code:number,output:string}>(resolve=>execFile(binary!,args,{env:{...process.env,NODE_OPTIONS:'--require '+preload},timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?1:0,output:out+err})));
  if(result.code)await writeFile(path.join(os.tmpdir(),`owned-javac-${version}-${dsl}.log`),result.output);expect(result.code,result.output).toBe(0);
  const report=JSON.parse(await readFile(path.join(root,'javac-report.json'),'utf8')),gradle=JSON.parse(await readFile(path.join(root,'gradle-javac-report.json'),'utf8'));
  policy={executionId,executorHashes,java:offerJdkProfile.java.sha256,javac:offerJdkProfile.javac.sha256,nodeRuntime:{sha256:sha256(await readFile(process.execPath)),version:process.version,platform:process.platform,arch:process.arch}};
  expect(gradle).toMatchObject({executionId,gradleVersion:version,actionEntered:true,taskState:{executed:true,didWork:true,skipped:false,noSource:false,failed:false},javaSha256:policy.java,javacSha256:policy.javac,maxWorkers:1,parallel:false});
  expect(report.executorHashes).toEqual(executorHashes);expect(report.executionId).toBe(executionId);expect(report.cases.map((c:any)=>c.case)).toEqual(Object.keys(buildCases));
  for(const c of report.cases){try{verifyBuildCase(c,policy);}catch(e){await writeFile(path.join(os.tmpdir(),`owned-javac-${version}-${dsl}-diagnostic.json`),JSON.stringify({policy,gradle,report},null,2));throw Error(c.case+': '+(e as Error).message+'; observed '+[c.buildState,c.failureStage,c.failurePhase,c.failureReason].join('/'));}}
  for(const [f,h]of Object.entries(executorHashes))expect(sha256(await readFile(path.join(repo,f)))).toBe(h);
  for(const [p,h]of Object.entries(fixtureHashes))expect(sha256(await readFile(path.join(root,p)))).toBe(h);
  const markerCreated=await access(marker).then(()=>true,()=>false);expect(markerCreated).toBe(false);
  record={gradleVersion:version,dsl,fixtureHashes,policy,gradle,report,injection:{nodeOptionsOffered:true,preloadSha256:sha256(preloadBody),markerCreated}};records.push(record);
  if(process.env.OSV_MCP_JAVAC_OUTPUT)await writeFile(process.env.OSV_MCP_JAVAC_OUTPUT,JSON.stringify({schema:'osv-mcp.owned-javac-matrix-v2',cases:records},null,2)+'\n');
 },300000);
 for(const name of Object.keys(buildCases))it('BM04–BM07/BM17 native case: '+name,()=>{const c=record.report.cases.find((x:any)=>x.case===name);expect(verifyBuildCase(c,policy).productionAdopted).toBe(0);});
});
