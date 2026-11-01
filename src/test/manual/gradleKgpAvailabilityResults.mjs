/** Scoped public API inventory plus revalidation of native acquisition diagnostics. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {tokenizeRecordedPaths,assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
import {kgpAvailabilitySources,verifyKgpAvailabilityCase,verifyApiArtifact,resolveGradleApiArtifact,verifyKgpSnapshotFault,kgpAvailabilityRegressions} from '../fixtures/gradleKgpAvailabilityProof.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [prefix,output]=process.argv.slice(2);
const runtime=process.env.OSV_MCP_GRADLE_RUNTIME_ROOT,jdk=process.env.JAVA_HOME;
if(!prefix||!output||!runtime||!jdk)throw Error('usage: JAVA_HOME=... OSV_MCP_GRADLE_RUNTIME_ROOT=... node gradleKgpAvailabilityResults.mjs <prefix> <output>');
const digest=async f=>createHash('sha256').update(await readFile(f)).digest('hex');
const sourcesSha256=Object.fromEntries(await Promise.all(kgpAvailabilitySources.map(async p=>[p,await digest(path.join(repo,p))])));
const matrices=[],apiInventories=[];
for(const gradleVersion of ['8.11.1','9.2.1']){
 const m=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 if(m.schema!=='osv-mcp.kgp-availability-matrix-v2'||m.gradleVersion!==gradleVersion||m.cases.length!==2||new Set(m.cases.map(c=>c.dsl)).size!==2)throw Error('incomplete-availability-matrix');
 for(const dsl of ['Groovy','Kotlin']){
  const c=m.cases.find(c=>c.dsl===dsl);if(!c)throw Error('missing-dsl');
  c.decision=verifyKgpAvailabilityCase(c,{gradleVersion,dsl,sourcesSha256});
  const f=c.fault;
  if(!f||f.accepted!==false||f.reason!=='kgp_availability_no_read_violated'||f.proof?.faultSnapshotRead!==true)throw Error('missing-actual-snapshot-fault');
  f.observation=verifyKgpSnapshotFault(f.proof,{gradleVersion,dsl,sourcesSha256});
  const replay=kgpAvailabilityRegressions(f.proof,{gradleVersion,dsl,sourcesSha256});
  if(JSON.stringify(replay)!==JSON.stringify(c.regressions))throw Error('fault-regression-replay-mismatch');
  let apiReason;
  try{verifyApiArtifact(c.runs[0].apiArtifacts.gradle,c.runs[0].apiArtifacts.kgp);}catch(error){apiReason=error.message;}
  if(apiReason!=='kgp_availability_api_artifact_mismatch'||c.apiMismatchRejection?.accepted!==false||c.apiMismatchRejection.reason!==apiReason)throw Error('api-mismatch-regression-missing');
  for(const r of [...c.runs,c.fault.proof.runs[2]]){
   if(await digest(r.implementation.artifact)!==r.implementation.sha256)throw Error('selected-kgp-artifact-changed');
   for(const binding of Object.values(r.apiArtifacts))verifyApiArtifact(binding,{artifact:await realpath(binding.artifact),sha256:await digest(binding.artifact)});
  }
 }
 const selected=m.cases[0].runs[0].implementation;
 if(m.cases.some(c=>c.runs[0].implementation.sha256!==selected.sha256))throw Error('kgp-dsl-drift');
 const kgpVersion=path.basename(selected.artifact).match(/^kotlin-gradle-plugin-(\d+\.\d+\.\d+)-gradle[0-9]+\.jar$/)?.[1];
 if(!kgpVersion)throw Error('unrecognized-selected-kgp-artifact');
 const nativeApi=m.cases[0].runs[0].apiArtifacts;
 const gradleLib=path.join(runtime,'gradle-'+gradleVersion,'lib');
 const gradleApi=await resolveGradleApiArtifact(gradleLib,nativeApi.gradle);
 const kgpApi=verifyApiArtifact(nativeApi.kgp,{artifact:await realpath(nativeApi.kgp.artifact),sha256:await digest(nativeApi.kgp.artifact)});
 const artifacts=[selected.artifact,kgpApi.artifact,gradleApi.artifact];
 const cp=artifacts.join(path.delimiter);
 const classes=['org.gradle.api.provider.HasConfigurableValue','org.gradle.api.file.ConfigurableFileCollection','org.gradle.api.file.FileCollection','org.gradle.api.tasks.TaskInputs','org.gradle.api.artifacts.Configuration','org.gradle.api.artifacts.ResolvableDependencies','org.gradle.api.Task','org.jetbrains.kotlin.gradle.tasks.KotlinCompile','org.jetbrains.kotlin.gradle.tasks.KotlinCompile$ClasspathSnapshotProperties','org.jetbrains.kotlin.gradle.tasks.AbstractKotlinCompile','org.jetbrains.kotlin.gradle.tasks.AbstractKotlinCompileTool','org.jetbrains.kotlin.gradle.tasks.KotlinCompileTool','org.jetbrains.kotlin.gradle.plugin.KotlinCompilerArgumentsProducer','org.jetbrains.kotlin.gradle.dsl.KotlinJvmCompile'];
 const signatures=classes.map(type=>({type,text:execFileSync(path.join(jdk,'bin/javap'),['-public','-classpath',cp,type],{encoding:'utf8',maxBuffer:2*1024**2})}));
 const annotationClass='org.jetbrains.kotlin.gradle.tasks.KotlinCompile$ClasspathSnapshotProperties';
 const verbose=execFileSync(path.join(jdk,'bin/javap'),['-public','-v','-classpath',cp,annotationClass],{encoding:'utf8',maxBuffer:2*1024**2});
 const start=verbose.indexOf('getClasspathSnapshot();'),next=verbose.indexOf('\n  public ',start+1);
 if(start<0)throw Error('snapshot-accessor-not-found');
 const snapshotAccessorAnnotations=verbose.slice(start,next<0?verbose.length:next);
 apiInventories.push({gradleVersion,kgpVersion,selectionEvidence:'native KotlinPluginWrapper, KotlinCompileTool and TaskInputs CodeSources; independently checked artifact identities and digests',artifacts:await Promise.all(artifacts.map(async artifact=>({artifact,sha256:await digest(artifact)}))),signatures,snapshotAccessorAnnotations,
  scope:'Only listed public JVM signatures and the snapshot accessor annotations; public bytecode visibility is not a stability or supported-hook guarantee. No internal/mangled method is invoked by the native reader.',
  ownerReceiptFinding:'No matching natural-materialization callback established in this scoped survey; not an exhaustive proof of absence.',
  stableRereadFinding:'No approved non-evaluating runtime readiness recipe established. Snapshot has @Classpath/@Incremental/@Optional annotations and zero sensor delta in this ordered experiment; requires a dedicated recipe proof.'});
 matrices.push(m);
}
// Use both actual executed distributions as each other's wrong-version directory.
const differentGradleApiRejections=[];
for(const matrix of matrices){
 const other=matrices.find(m=>m.gradleVersion!==matrix.gradleVersion);
 const expected=matrix.cases[0].runs[0].apiArtifacts.gradle,candidate=other.cases[0].runs[0].apiArtifacts.gradle;
 let outcome,reason;
 try{outcome=await resolveGradleApiArtifact(path.dirname(candidate.artifact),expected);}catch(error){reason=error.message;}
 if(outcome!==undefined||reason!=='kgp_availability_api_artifact_mismatch')throw Error('wrong-runtime-directory-not-rejected');
 differentGradleApiRejections.push({expectedVersion:matrix.gradleVersion,actualVersion:other.gradleVersion,expected,candidate,accepted:outcome!==undefined,reason});
}
const verificationSourcesSha256=Object.fromEntries(await Promise.all(['src/test/gradle/kgpAvailability.test.ts','src/test/manual/gradleKgpAvailabilityResults.mjs','src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts'].map(async p=>[p,await digest(path.join(repo,p))])));
let preReviews=[],observed=null;
// Run IDs identify the native observation set independently of record formatting.
const runIdsOf=ms=>ms.flatMap(m=>m.cases.flatMap(c=>[...c.runs,c.fault.proof.runs[2]].map(r=>r.runId))).sort();
try{
 const bytes=await readFile(output);const old=JSON.parse(bytes);
 preReviews=old.preReviews??[];
 // Re-consolidating the same native runs keeps their observation revision and time.
 if(old.schema==='osv-mcp.kgp-availability-experiment-v2'&&JSON.stringify(runIdsOf(old.matrices??[]))===JSON.stringify(runIdsOf(matrices)))observed={recordedAt:old.recordedAt,baselineRevision:old.baselineRevision};
 if(old.schema!=='osv-mcp.kgp-availability-experiment-v2')preReviews.push({schema:old.schema,recordedAt:old.recordedAt,sourcesSha256:old.sourcesSha256,scope:old.scope,recordSha256:createHash('sha256').update(bytes).digest('hex'),note:'Uncommitted v1 record summary; not current v2 API binding or fault-trace evidence.'});
}catch(error){if(error.code!=='ENOENT')throw error;}
// Verification above used the native absolute paths; the published record carries portable tokens only.
const userHome=process.env.GRADLE_USER_HOME;
if(!userHome)throw Error('GRADLE_USER_HOME is required to tokenize recorded cache paths');
const roots=[{token:'$GRADLE_USER_HOME',paths:[userHome,await realpath(userHome)]},{token:'$GRADLE_RUNTIME',paths:[runtime,await realpath(runtime)]}];
const portable=v=>tokenizeRecordedPaths(v,roots);
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),now=new Date().toISOString();
const result={schema:'osv-mcp.kgp-availability-experiment-v2',pathTokens:{'$GRADLE_USER_HOME':'GRADLE_USER_HOME','$GRADLE_RUNTIME':'OSV_MCP_GRADLE_RUNTIME_ROOT'},recordedAt:observed?.recordedAt??now,baselineRevision:observed?.baselineRevision??head,...(observed?{reconsolidatedAt:now,reconsolidatedRevision:head}:{}),sourcesSha256,verificationSourcesSha256,
 scope:{nativeBuilds:matrices.reduce((n,m)=>n+m.cases.reduce((n,c)=>n+c.runs.length+1,0),0),slotDiagnostics:matrices.reduce((n,m)=>n+m.cases.reduce((n,c)=>n+c.runs[1].reads.length,0),0),noReadRejections:matrices.reduce((n,m)=>n+m.cases.reduce((n,c)=>n+c.runs[2].decisions.length,0),0),snapshotGetterFaultRejections:matrices.reduce((n,m)=>n+m.cases.length,0),faultTraceRegressions:matrices.flatMap(m=>m.cases).reduce((n,c)=>n+c.regressions.length,0),apiMismatchRejections:matrices.flatMap(m=>m.cases).length,differentGradleApiRejections:differentGradleApiRejections.length,productionAdoptions:0,fullPipelineCandidates:0,
 fixture:'included root binary Kotlin, standard kotlin-dsl, same-DSL Groovy/Groovy and Kotlin/Kotlin pairs',
 diagnostic:'ordered post-compile reads: libraries, snapshots, compilerClasspath, Task.inputs; not isolated per-slot builds',
 sensors:'libraries/snapshot/compiler classpath sensors return empty lists; Task.inputs sensor is a real nonempty file; actual acquired collections are nonempty',
 limitations:['no owner-materialized bridge or content-bound receipt implemented','not a full observer noninterference proof','not all private suppliers observed','API survey is scoped, not an absence proof','no buildSrc/precompiled/plugins-block or cross-DSL matrix','no production adapter/reader/profile changes','snapshot zero sensor delta does not establish readiness or freshness']},apiInventories:portable(apiInventories),matrices:portable(matrices),differentGradleApiRejections:portable(differentGradleApiRejections),preReviews:portable(preReviews)};
assertNoAbsolutePaths(result);
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result.scope));
