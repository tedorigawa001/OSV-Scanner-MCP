/** Scoped API/source investigation, plus standalone BTA constructor probes. No Gradle builds or compiler calls. */
import {readFile,writeFile,mkdtemp,mkdir,rm,readdir,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';
import {ownerTuples,ownerTypes,ownerSources,digest,ownerMethod,ownerSourceExcerpts,ownerSourceNotice,snapshotOwnerFacts,verifySnapshotOwnerSurvey} from '../fixtures/gradleSnapshotOwnerProof.mjs';
import {resolveRecordedPath,tokenizeRecordedPaths,assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [sourceRoot,output]=process.argv.slice(2),cache=process.env.GRADLE_USER_HOME,runtime=process.env.OSV_MCP_GRADLE_RUNTIME_ROOT,jdk=process.env.JAVA_HOME;
if(!sourceRoot||!output||!cache||!runtime||!jdk)throw Error('usage: JAVA_HOME=... GRADLE_USER_HOME=... OSV_MCP_GRADLE_RUNTIME_ROOT=... node gradleSnapshotOwnerSurvey.mjs <downloaded-tag-source-dir> <output>');
const refPath='docs/validation/gradle-kgp-availability-2026-11-01.json',refBytes=await readFile(path.join(repo,refPath)),reference=JSON.parse(refBytes);
const surveys=[],fileHash=async p=>digest(await readFile(p));
const sourcePaths=[...ownerSources,'src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts'];
const sourcesSha256=Object.fromEntries(await Promise.all(sourcePaths.map(async p=>[p,await fileHash(path.join(repo,p))])));
const jdkTools=Object.fromEntries(await Promise.all(['java','javac','javap'].map(async name=>[name,{sha256:await fileHash(path.join(jdk,'bin',name)),version:execFileSync(path.join(jdk,'bin',name),[name==='javap'?'-version':'--version'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()}])));
for(const tuple of ownerTuples){
 const {gradleVersion,kgpVersion}=tuple,old=reference.matrices.find(m=>m.gradleVersion===gradleVersion).cases[0].runs[0];
 const gradleLib=path.join(runtime,'gradle-'+gradleVersion,'lib');
 const availableRoot=path.join(cache,'caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-build-tools-api',kgpVersion);
 const jars=(await Promise.all((await readdir(availableRoot)).map(async d=>(await readdir(path.join(availableRoot,d))).filter(n=>n===`kotlin-build-tools-api-${kgpVersion}.jar`).map(n=>path.join(availableRoot,d,n))))).flat();
 if(jars.length!==1)throw Error('bta-available-artifact-ambiguous');
 const paths={gradle:resolveRecordedPath(old.apiArtifacts.gradle.artifact,process.env),kgp:resolveRecordedPath(old.apiArtifacts.kgp.artifact,process.env),implementation:resolveRecordedPath(old.implementation.artifact,process.env),events:path.join(gradleLib,`gradle-build-events-${gradleVersion}.jar`),tooling:path.join(gradleLib,`gradle-tooling-api-${gradleVersion}.jar`),bta:jars[0],stdlib:path.join(gradleLib,`kotlin-stdlib-${kgpVersion}.jar`)};
 const artifacts=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([role,p])=>[role,{path:await realpath(p),sha256:await fileHash(p)}])));
 for(const [role,h]of Object.entries({gradle:old.apiArtifacts.gradle.sha256,kgp:old.apiArtifacts.kgp.sha256,implementation:old.implementation.sha256,bta:tuple.btaSha256}))if(artifacts[role].sha256!==h)throw Error('owner-survey-artifact-mismatch');
 const api=[];
 for(const [role,type] of ownerTypes){
  const cp=[artifacts[role].path,...Object.values(artifacts).map(a=>a.path)].join(path.delimiter);
  const full=execFileSync(path.join(jdk,'bin/javap'),['-sysinfo','-public','-classpath',cp,type],{encoding:'utf8',maxBuffer:4*1024**2});
  const match=full.match(/^Classfile jar:(file:[^\n]+)!\//m);
  if(!match||await realpath(fileURLToPath(match[1]))!==artifacts[role].path)throw Error('owner-survey-api-origin-mismatch: '+type+' '+match?.[1]+' expected '+artifacts[role].path);
  const signature=full.slice(full.indexOf('Compiled from'));
  api.push({type,artifactSha256:artifacts[role].sha256,classSha256:full.match(/SHA-256 checksum ([a-f0-9]{64})/)?.[1],signature,signatureSha256:digest(signature)});
 }
 const bytecode=execFileSync(path.join(jdk,'bin/javap'),['-p','-c','-classpath',artifacts.implementation.path,'org.jetbrains.kotlin.gradle.tasks.KotlinCompile'],{encoding:'utf8',maxBuffer:4*1024**2});
 const compileBytecode=ownerMethod(bytecode,/callCompilerAsync\$.*K2JVMCompilerArguments/)+'\n'+ownerMethod(bytecode,/private .* getClasspathChanges\(/);
 const source=await readFile(path.join(sourceRoot,`KotlinCompile-${kgpVersion}.kt`));
 // The full tag source is digest-checked here and not republished; excerpts are extracted from these exact bytes.
 if(digest(source)!==tuple.sourceSha256)throw Error('owner-survey-tag-source-mismatch');
 const excerpts=ownerSourceExcerpts(source.toString('utf8'));
 const tagSource={url:`https://raw.githubusercontent.com/JetBrains/kotlin/v${kgpVersion}/libraries/tools/kotlin-gradle-plugin/src/common/kotlin/org/jetbrains/kotlin/gradle/tasks/KotlinCompile.kt`,license:'Apache-2.0',licenseUrl:`https://github.com/JetBrains/kotlin/blob/v${kgpVersion}/license/LICENSE.txt`,notice:ownerSourceNotice,sha256:digest(source),excerpts,binding:'excerpts of the digest-checked tag source corroborate bytecode; no reproducible-build equality claim'};
 const facts=snapshotOwnerFacts(excerpts,compileBytecode);
 const temp=await mkdtemp(path.join(os.tmpdir(),'osv-owner-parameters-'));let parameterProbe;
 try{
  await mkdir(path.join(temp,'classes'));const cp=[artifacts.bta.path,artifacts.stdlib.path].join(path.delimiter);
  execFileSync(path.join(jdk,'bin/javac'),['-cp',cp,'-d',path.join(temp,'classes'),path.join(repo,ownerSources[0])],{encoding:'utf8'});
  parameterProbe=JSON.parse(execFileSync(path.join(jdk,'bin/java'),['-cp',[path.join(temp,'classes'),cp].join(path.delimiter),'gradleSnapshotOwnerParameters',path.join(temp,'files')],{encoding:'utf8'}));
  if(await realpath(parameterProbe.btaArtifact)!==artifacts.bta.path||await realpath(parameterProbe.stdlibArtifact)!==artifacts.stdlib.path)throw Error('owner-survey-probe-origin-mismatch');
 }finally{await rm(temp,{recursive:true,force:true});}
 surveys.push({gradleVersion,kgpVersion,btaArtifactRole:'available-api-not-proven-selected-by-kgp',artifacts,api,tagSource,compileBytecode,compileBytecodeSha256:digest(compileBytecode),facts,parameterProbe});
}
const schema='osv-mcp.snapshot-owner-survey-v3',head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),now=new Date().toISOString();
const result={schema,recordedAt:now,baselineRevision:head,sourcesSha256,referenceRecord:{path:refPath,sha256:digest(refBytes)},jdkTools,surveys,scope:{publicTypesPerTuple:ownerTypes.length,tagSources:2,standaloneParameterProbes:2,newGradleBuilds:0,newCompilerInvocations:0,groovyKotlinMatrixAdded:false,syntheticFilesAreKgpSnapshots:false,sourceSurveyIsExhaustive:false},decision:{existingKgp:'unsupported-owner-hook-not-established',bta:'new-owner-driver-required',producerContract:'designed-not-proven',approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0}};
const roots=[{token:'$GRADLE_USER_HOME',paths:[cache,await realpath(cache)]},{token:'$GRADLE_RUNTIME',paths:[runtime,await realpath(runtime)]}];
// The observation is the tokenized survey content; re-collecting identical content keeps its observation time.
const observation=r=>digest(JSON.stringify(tokenizeRecordedPaths({jdkTools:r.jdkTools,surveys:r.surveys},roots)));
let preReviews=[];
try{const bytes=await readFile(output),old=JSON.parse(bytes);preReviews=old.preReviews??[];
 if(old.schema===schema){if(observation(old)===observation(result))Object.assign(result,{recordedAt:old.recordedAt,baselineRevision:old.baselineRevision,reconsolidatedAt:now,reconsolidatedRevision:head});}
 else if(old.schema==='osv-mcp.snapshot-owner-survey-v2')preReviews.push({schema:old.schema,recordedAt:old.recordedAt,baselineRevision:old.baselineRevision,decision:old.decision,recordSha256:digest(bytes),committedIn:'96f7da8',note:'Committed v2 embedding full KotlinCompile.kt tag sources without JDK profile binding; superseded by v3 excerpts and pinned JDK profile.'});
 else preReviews.push({schema:old.schema,recordedAt:old.recordedAt,decision:old.decision,recordSha256:digest(bytes),note:'Earlier survey record; reference only, not current evidence.'});
}catch(error){if(error.code!=='ENOENT')throw error;}
result.preReviews=preReviews;
verifySnapshotOwnerSurvey(result,reference,sourcesSha256);
const portable=tokenizeRecordedPaths(result,roots);assertNoAbsolutePaths(portable);await writeFile(output,JSON.stringify(portable,null,2)+'\n');console.log(JSON.stringify({scope:result.scope,decision:result.decision}));
