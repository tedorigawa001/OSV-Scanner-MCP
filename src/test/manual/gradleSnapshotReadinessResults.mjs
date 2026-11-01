/** Consolidate snapshot-only binding/execution witnesses; no production recipe approval. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {snapshotSources,verifySnapshotReadinessCase,verifySnapshotReadinessFault,snapshotStateRegressions} from '../fixtures/gradleSnapshotReadinessProof.mjs';
import {resolveGradleApiArtifact} from '../fixtures/gradleKgpAvailabilityProof.mjs';
import {tokenizeRecordedPaths,assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [prefix,output]=process.argv.slice(2),runtime=process.env.OSV_MCP_GRADLE_RUNTIME_ROOT,jdk=process.env.JAVA_HOME,cache=process.env.GRADLE_USER_HOME;
if(!prefix||!output||!runtime||!jdk||!cache)throw Error('usage: JAVA_HOME=... GRADLE_USER_HOME=... OSV_MCP_GRADLE_RUNTIME_ROOT=... node gradleSnapshotReadinessResults.mjs <prefix> <output>');
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const sourcesSha256=Object.fromEntries(await Promise.all(snapshotSources.map(async p=>[p,await digest(path.join(repo,p))])));
const priorPath=path.join(repo,'docs/validation/gradle-kgp-availability-2026-11-01.json'),prior=JSON.parse(await readFile(priorPath,'utf8'));
const matrices=[],contractEvidence=[];
const excerpt=(text,method)=>{const start=text.indexOf(method+'();'),end=text.indexOf('\n  public ',start+1);if(start<0)throw Error('snapshot-public-method-missing');return text.slice(start,end<0?text.length:end)};
for(const gradleVersion of ['8.11.1','9.2.1']){
 const matrix=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 if(matrix.schema!=='osv-mcp.snapshot-readiness-matrix-v2'||matrix.gradleVersion!==gradleVersion||matrix.cases.length!==2||new Set(matrix.cases.map(c=>c.dsl)).size!==2)throw Error('snapshot-matrix-incomplete');
 const old=prior.matrices.find(m=>m.gradleVersion===gradleVersion).cases[0].runs[0];
 const approvedApi={gradle:old.apiArtifacts.gradle.sha256,kgp:old.apiArtifacts.kgp.sha256,implementation:old.implementation.sha256};
 for(const dsl of ['Groovy','Kotlin']){
  const c=matrix.cases.find(c=>c.dsl===dsl);if(!c)throw Error('snapshot-dsl-missing');
  const approval={gradleVersion,dsl,approvedApi,sourcesSha256};
  c.decision=verifySnapshotReadinessCase(c,approval);
  const replay=snapshotStateRegressions(c,approval);
  if(JSON.stringify(replay)!==JSON.stringify(c.stateRejections))throw Error('snapshot-state-rejection-replay-mismatch');
  if(!c.fault||c.fault.accepted!==false||c.fault.reason!=='snapshot_readiness_preflight_read'||c.fault.proof?.preflightReadFault!==true)throw Error('snapshot-preflight-fault-missing');
  const observation=verifySnapshotReadinessFault(c.fault.proof,approval);
  if(JSON.stringify(observation)!==JSON.stringify(c.fault.observation))throw Error('snapshot-preflight-fault-replay-mismatch');
  for(const r of [...c.runs,c.fault.proof.runs[1]])for(const entry of Object.values(r.api)){
   if(await realpath(entry.artifact)!==entry.artifact||await digest(entry.artifact)!==entry.sha256)throw Error('snapshot-api-artifact-changed');
  }
 }
 const api=matrix.cases[0].runs[0].api;
 await resolveGradleApiArtifact(path.join(runtime,'gradle-'+gradleVersion,'lib'),api.gradle);
 const cp=[api.implementation.artifact,api.kgp.artifact,api.gradle.artifact].join(path.delimiter);
 const inspect=type=>execFileSync(path.join(jdk,'bin/javap'),['-public','-v','-classpath',cp,type],{encoding:'utf8',maxBuffer:4*1024**2});
 const parent=excerpt(inspect('org.jetbrains.kotlin.gradle.tasks.KotlinCompile'),'getClasspathSnapshotProperties');
 const property=excerpt(inspect('org.jetbrains.kotlin.gradle.tasks.KotlinCompile$ClasspathSnapshotProperties'),'getClasspathSnapshot');
 if(!parent.includes('org.gradle.api.tasks.Nested')||!property.includes('ConfigurableFileCollection')||!property.includes('org.gradle.api.tasks.Classpath'))throw Error('snapshot-public-input-contract-missing');
 contractEvidence.push({gradleVersion,api,parentAccessor:parent,snapshotAccessor:property,
  publicLifecycleReference:'https://docs.gradle.org/current/javadoc/org/gradle/api/provider/HasConfigurableValue.html',
  pinnedSourceReference:gradleVersion==='9.2.1'?'https://raw.githubusercontent.com/gradle/gradle/v9.2.1/subprojects/core-api/src/main/java/org/gradle/api/provider/HasConfigurableValue.java':null,
  sourceScope:gradleVersion==='8.11.1'?'Current lifecycle documentation plus exact-version bytecode annotations and observed behavior; pinned 8.11.1 source body was not retrieved.':'Pinned public lifecycle source plus exact-version annotations and observed behavior.',
  interpretation:'Task input lifecycle supports the candidate model, but mutation rejection alone cannot distinguish disallowChanges from value finalization; no public isFinalized query or full deep-immutability proof.'});
 matrices.push(matrix);
}
const verificationPaths=['src/test/gradle/snapshotReadiness.test.ts','src/test/manual/gradleSnapshotReadinessResults.mjs','src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts','src/test/fixtures/gradleKgpAvailabilityProof.mjs','src/test/fixtures/gradleKgpAvailabilityProof.d.mts'];
const verificationSourcesSha256=Object.fromEntries(await Promise.all(verificationPaths.map(async p=>[p,await digest(path.join(repo,p))])));
const all=matrices.flatMap(m=>m.cases),scope={nativeBuilds:all.reduce((n,c)=>n+c.runs.length+1,0),conditionalWitnesses:all.filter(c=>c.decision.conditionalRereadWitness).length,preflightCachedReadRejections:all.length,stateFlagRejections:all.reduce((n,c)=>n+c.stateRejections.length,0),
 noReadClassifierRefusals:all.reduce((n,c)=>n+c.runs.reduce((n,r)=>n+r.checks.filter(x=>!x.accepted).length,0),0),productionAdoptions:0,approvedRecipes:0,fullPipelineCandidates:0,naturalContentBindings:0,
 fixture:'same-DSL Groovy/Groovy and Kotlin/Kotlin; included root standard kotlin-dsl binary Kotlin; producer settings registers the helper before KGP task configuration',
 sensor:'an empty concrete list on the original snapshot collection; actual snapshot files are nonempty; unknown-source case adds a live FileTree',
 limitations:['no automatic untouched-build registration','closed producer/toolchain source assumptions are author attested','no full observer or all private supplier proof','no consumed-bytes receipt/freshness proof','post-task mutation rejection is not an isFinalized query','early/wrong binding checks are stateless preflight-classifier tests, not production capture sessions','no buildSrc/precompiled or cross-DSL matrix','no production schema/adapter/reader/trust changes']};
const roots=[{token:'$GRADLE_USER_HOME',paths:[cache,await realpath(cache)]},{token:'$GRADLE_RUNTIME',paths:[runtime,await realpath(runtime)]}];
let preReviews=[];
try{const bytes=await readFile(output),old=JSON.parse(bytes);preReviews=old.preReviews??[];if(old.schema!=='osv-mcp.snapshot-readiness-experiment-v2')preReviews.push({schema:old.schema,recordedAt:old.recordedAt,sourcesSha256:old.sourcesSha256,scope:old.scope,recordSha256:createHash('sha256').update(bytes).digest('hex'),note:'Uncommitted v1 summary before cached preflight read and TaskState validation fixes; not current v2 evidence.'});}catch(error){if(error.code!=='ENOENT')throw error;}
const result=tokenizeRecordedPaths({schema:'osv-mcp.snapshot-readiness-experiment-v2',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),pathTokens:{'$GRADLE_USER_HOME':'GRADLE_USER_HOME','$GRADLE_RUNTIME':'OSV_MCP_GRADLE_RUNTIME_ROOT'},sourcesSha256,verificationSourcesSha256,apiReferenceRecord:{path:'docs/validation/gradle-kgp-availability-2026-11-01.json',sha256:await digest(priorPath)},scope,contractEvidence,matrices,preReviews},roots);
assertNoAbsolutePaths(result);await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(scope));
