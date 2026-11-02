import {execFile,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {bridgeSources,btaManifestCases,runtimeRefusals} from '../fixtures/ownedBtaManifestExpected.mjs';
import {verifyBtaManifestTuple} from '../fixtures/ownedBtaManifestContract.mjs';
import {sha256} from '../fixtures/ownedManifestContract.mjs';
import {offerJdkProfile} from '../fixtures/btaOfferContract.mjs';
const binary=process.env.OSV_MCP_TEST_GRADLE,repo=fileURLToPath(new URL('../../../',import.meta.url)),roots:string[]=[],cases:any[]=[];
afterAll(async()=>{for(const p of roots)await rm(p,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`owned javac/BTA manifest ${dsl}`,()=>{
 let tuple:any;
 beforeAll(async()=>{
  const version=execFileSync(binary!,['--version'],{env:process.env,encoding:'utf8'}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];if(!version||!process.env.JAVA_HOME||!process.env.GRADLE_USER_HOME)throw Error('missing native env');
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'owned-bta-manifest-')));roots.push(root);const ext=dsl==='Kotlin'?'.gradle.kts':'.gradle';
  const files={['settings'+ext]:'rootProject.name="owned-bta-manifest"\n',['build'+ext]:dsl==='Kotlin'?'apply(from="bridge.gradle")\n':"apply from: 'bridge.gradle'\n",'bridge.gradle':await readFile(path.join(repo,'src/test/fixtures/gradle-owned-bta-manifest.gradle'),'utf8')};
  for(const [p,b]of Object.entries(files))await writeFile(path.join(root,p),b);
  const sourceHashes=Object.fromEntries(await Promise.all(bridgeSources.map(async p=>[p,sha256(await readFile(path.join(repo,p)))]))),executionId=randomUUID();
  const policy={executionId,sourceHashes,java:offerJdkProfile.java.sha256,javac:offerJdkProfile.javac.sha256,nodeRuntime:{sha256:sha256(await readFile(process.execPath)),version:process.version,platform:process.platform,arch:process.arch}};
  const args=['-p',root,'ownedBtaManifest',`-Downed.bta.executionId=${executionId}`,`-Downed.bta.node=${process.execPath}`,`-Downed.bta.producer=${path.join(repo,'src/test/fixtures/ownedBtaManifestProducer.mjs')}`,`-Downed.bta.cache=${process.env.GRADLE_USER_HOME}`,'--offline','--no-daemon','--no-configuration-cache','--no-build-cache','--no-parallel','--max-workers=1','--console=plain'];
  const result=await new Promise<{code:number;output:string}>(resolve=>execFile(binary!,args,{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,o,err)=>resolve({code:e?1:0,output:o+err})));
  if(result.code)await writeFile(path.join(os.tmpdir(),`owned-bta-${version}-${dsl}.log`),result.output);expect(result.code,result.output).toBe(0);
  const report=JSON.parse(await readFile(path.join(root,'bridge-report.json'),'utf8')),gradle=JSON.parse(await readFile(path.join(root,'bridge-gradle.json'),'utf8'));
  tuple={gradleVersion:version,dsl,policy,gradle,fixtureHashes:Object.fromEntries(Object.entries(files).map(([p,b])=>[p,sha256(b)])),report};
  try{verifyBtaManifestTuple(tuple);}catch(e){await writeFile(path.join(os.tmpdir(),`owned-bta-${version}-${dsl}-diagnostic.json`),JSON.stringify(tuple,null,2));throw e;}
  for(const [p,h]of Object.entries(sourceHashes))expect(sha256(await readFile(path.join(repo,p)))).toBe(h);
  cases.push(tuple);if(process.env.OSV_MCP_BTA_MANIFEST_OUTPUT)await writeFile(process.env.OSV_MCP_BTA_MANIFEST_OUTPUT,JSON.stringify({schema:'owned-bta-matrix-v1',cases},null,2)+'\n');
 },300000);
 it('binds owned source, fresh output and actual BTA runtime',()=>expect(verifyBtaManifestTuple(tuple).productionAdopted).toBe(0));
 for(const id of [...Object.keys(btaManifestCases),...Object.keys(runtimeRefusals)])it('native binding/freshness: '+id,()=>expect(verifyBtaManifestTuple(tuple).naturalReceipts).toBe(0));
});
