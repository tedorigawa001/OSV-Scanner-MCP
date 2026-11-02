/** Native owner helper proof; test-only, no production adoption or natural receipt. */
import {execFile,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {btaDriverProfiles} from '../fixtures/gradleBtaDriverRuntime.mjs';
import {offerJdkProfile as ownerJdkProfile} from '../fixtures/btaOfferContract.mjs';
import {hash} from '../fixtures/gradleBtaDriverProof.mjs';
import {readOwnedOffer} from '../fixtures/btaOfferContract.mjs';
import {offerSources as sources,verifyOfferCase} from '../fixtures/btaOfferProof.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url)),binary=process.env.OSV_MCP_TEST_GRADLE;
const roots:string[]=[],cases:any[]=[];const digest=async(p:string)=>hash(await readFile(p));
afterAll(async()=>{for(const root of roots)await rm(root,{recursive:true,force:true});},120000);
for(const dsl of ['Groovy','Kotlin'])describe.skipIf(!binary)(`BTA owner envelope (${dsl})`,()=>{
 let record:any,decisions:any[];
 beforeAll(async()=>{
  const version=execFileSync(binary!,['--version'],{encoding:'utf8',env:process.env}).match(/Gradle (8\.11\.1|9\.2\.1)\b/)?.[1];if(!version||!process.env.JAVA_HOME||!process.env.GRADLE_USER_HOME)throw Error('missing-native-environment');
  const profile=btaDriverProfiles[version]!;expect(await digest(path.join(process.env.JAVA_HOME,'bin/java'))).toBe(ownerJdkProfile.java.sha256);
  const runtime=await Promise.all(profile.runtime.map(async e=>{const artifact=await realpath(path.join(process.env.GRADLE_USER_HOME!,e.relativePath));expect(await digest(artifact)).toBe(e.sha256);return {...e,artifact};}));
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'osv-bta-offer-')));roots.push(root);
  const sourceHashes=Object.fromEntries(await Promise.all(sources.map(async f=>[f,await digest(path.join(repo,f))])));
  const registration={producerSha256:hash(sourceHashes[sources[0]!]!+sourceHashes[sources[1]!]!),runtimeSha256:hash(JSON.stringify(profile.runtime)),profileSha256:hash(JSON.stringify({version,java:ownerJdkProfile.java.sha256,strategy:'in-process'}))};
  const exportId=crypto.randomUUID(),profileId='test-owned-'+version,settings={trust:true,profiles:{[profileId]:{registration,strategy:'in-process'}},graphId:'graph',exportId};
  const ext=dsl==='Kotlin'?'.gradle.kts':'.gradle';
  const files:Record<string,string>={['settings'+ext]:'rootProject.name="bta-offer-proof"\n',['build'+ext]:dsl==='Kotlin'?'apply(from="offer.gradle")\n':"apply from: 'offer.gradle'\n",'BtaOwnedDriver.java':await readFile(path.join(repo,sources[0]!),'utf8'),'BtaOfferProbe.java':await readFile(path.join(repo,sources[1]!),'utf8'),'offer.gradle':await readFile(path.join(repo,sources[2]!),'utf8')};
  const fixtureFiles=[...Object.keys(files),'runtime-profile.json'];files['runtime-profile.json']=JSON.stringify({runtime,stdlib:runtime.find(e=>e.coordinate.startsWith('org.jetbrains.kotlin:kotlin-stdlib:'))!.artifact,exportId,profileId,registration,fixtureFiles});
  for(const [f,b]of Object.entries(files))await writeFile(path.join(root,f),b);
  const fixtureHashes=Object.fromEntries(await Promise.all(fixtureFiles.map(async f=>[f,await digest(path.join(root,f))])));
  const run=await new Promise<{code:number,output:string}>(resolve=>execFile(binary!,['-p',root,'offerProof','--offline','--no-daemon','--no-configuration-cache','--no-build-cache','--rerun-tasks','--no-parallel','--max-workers=1','--console=plain','--stacktrace'],{env:process.env,timeout:300000,maxBuffer:4*1024**2},(e,out,err)=>resolve({code:e?1:0,output:out+err})));
  if(run.code)await writeFile(path.join(os.tmpdir(),`bta-offer-${version}-${dsl}.log`),run.output);expect(run.code,run.output).toBe(0);
  const report=JSON.parse(await readFile(path.join(root,'offer-report.json'),'utf8')),gradle=JSON.parse(await readFile(path.join(root,'offer-gradle.json'),'utf8'));
  expect(gradle).toMatchObject({gradleVersion:version,javaSha256:ownerJdkProfile.java.sha256,javacSha256:ownerJdkProfile.javac.sha256,parallel:false,maxWorkers:1,fixtureHashes});
  expect(report.javaSha256).toBe(ownerJdkProfile.java.sha256);expect(report.actualCompilerVersion).toBe(profile.kotlinVersion);
  for(const c of report.driverClasses)expect(await digest(path.join(root,'build/driver-classes',c.path))).toBe(c.sha256);
  for(const r of runtime)expect(await digest(r.artifact)).toBe(r.sha256);
  for(const f of sources)expect(await digest(path.join(repo,f))).toBe(sourceHashes[f]);
  decisions=[];
  for(const e of report.envelopes){
   const noRead=()=>{throw Error('unexpected-read');};
   let trusted:any;try{trusted=readOwnedOffer(e,settings,p=>{const real=path.join(root,p);return readFileSync(real);});}catch(error){trusted={rejected:(error as Error).message};}
   const gates=[];for(const gate of [{...settings,trust:false},{...settings,profiles:{}}]){try{gates.push(readOwnedOffer(e,gate,noRead));}catch(error){gates.push({rejected:(error as Error).message});}}
   decisions.push({invocation:e.invocation,trusted,gates});
  }
  record={gradleVersion:version,dsl,sourceHashes,registration,report,gradle,decisions};verifyOfferCase(record);cases.push(record);
  if(process.env.OSV_MCP_BTA_OFFER_OUTPUT)await writeFile(process.env.OSV_MCP_BTA_OFFER_OUTPUT,JSON.stringify({schema:'osv-mcp.bta-offer-matrix-v2',cases},null,2)+'\n');
 },300000);
 it('completes a real bound BTA call as offered-only, not compiler-work or natural receipt',()=>expect(decisions.find(d=>d.invocation==='completed').trusted).toMatchObject({importStatus:'accepted',fileReads:4,compilerWorkStatus:'unknown',naturalReady:false}));
 for(const name of ['storage-failed','call-failed'])it('keeps a legitimate failed prefix without requiring later evidence: '+name,()=>expect(decisions.find(d=>d.invocation===name).trusted).toMatchObject({importStatus:'producer_failed',fileReads:0}));
 for(const name of ['post-failed','capture-failed','stale-precheck','source-changed'])it('accepts a producer-recorded stale refusal only after the reader re-reads the mismatch: '+name,()=>expect(decisions.find(d=>d.invocation===name).trusted).toMatchObject({producerState:'failed',importStatus:'producer_failed',producerReason:'stale',fileReads:5}));
 for(const name of ['foreign-config','foreign-project','foreign-parameter','foreign-paths'])it('accepts a producer-recorded binding refusal without a graph rejection: '+name,()=>{const e=record.report.envelopes.find((e:any)=>e.invocation===name);expect(e.failurePhase).toBe('precheck');expect(e.phases.some((x:any)=>x.phase==='call')).toBe(false);expect(decisions.find(d=>d.invocation===name).trusted).toMatchObject({importStatus:'producer_failed',producerReason:'binding_mismatch',fileReads:0});});
 it('writes completed only after the planned capture',()=>{const e=record.report.envelopes.find((e:any)=>e.invocation==='completed');expect(e.plannedCaptures).toBe(1);expect(e.phases.at(-1)).toMatchObject({phase:'capture',outcome:'success'});});
 it('does no file reads with trust disabled or profile unapproved',()=>{for(const d of decisions)for(const g of d.gates)if(!g.rejected)expect(g).toMatchObject({importStatus:'unavailable',fileReads:0});});
 it('rejects duplicate, late, reused and failed handles before any extra BTA call',()=>{expect(record.report.rejections.map((x:any)=>x.mode)).toEqual(['duplicate-begin','reentry','reuse','phase-after-completion','failed-reuse','late-registration']);for(const r of record.report.rejections)expect(r.callsAfter).toBe(r.callsBefore);});
 it('reports only its bounded native scope',()=>expect(record.report).toMatchObject({btaConsumerCalls:4,libraryCalls:1,generatedSnapshots:2,naturalContentBinding:false,productionAdopted:false}));
});
