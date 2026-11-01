/** Revalidate native producer-owned BTA runs; publish hashes, never third-party snapshot bytes. */
import {readFile,writeFile,realpath} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {btaSources,hash,verifyBtaDriverCase,btaDriverRegressions} from '../fixtures/gradleBtaDriverProof.mjs';
import {tokenizeRecordedPaths,assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));const [prefix,output]=process.argv.slice(2),cache=process.env.GRADLE_USER_HOME,runtime=process.env.OSV_MCP_GRADLE_RUNTIME_ROOT,jdk=process.env.JAVA_HOME;
if(!prefix||!output||!cache||!runtime||!jdk)throw Error('usage: JAVA_HOME=... GRADLE_USER_HOME=... OSV_MCP_GRADLE_RUNTIME_ROOT=... node gradleBtaDriverResults.mjs <prefix> <output>');
const digest=async p=>hash(await readFile(p));
const sourcesSha256=Object.fromEntries(await Promise.all(btaSources.map(async p=>[p,await digest(path.join(repo,p))]))),javaSha256=await digest(path.join(jdk,'bin/java'));
const matrices=[];
for(const gradleVersion of ['8.11.1','9.2.1']){
 const matrix=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 if(matrix.schema!=='osv-mcp.bta-driver-matrix-v2'||matrix.gradleVersion!==gradleVersion||matrix.cases.length!==2||new Set(matrix.cases.map(c=>c.dsl)).size!==2)throw Error('bta-driver-matrix-invalid');
 for(const c of matrix.cases){
  const a={gradleVersion,dsl:c.dsl,javaSha256,sourcesSha256};
  if(c.javaSha256!==javaSha256||JSON.stringify(verifyBtaDriverCase(c,a))!==JSON.stringify(c.decision)||JSON.stringify(btaDriverRegressions(c,a))!==JSON.stringify(c.regressions))throw Error('bta-driver-replay-mismatch');
  for(const r of c.runs){
   for(const entry of [...r.program.runtime,r.gradle.gradleApi])if(await realpath(entry.artifact)!==entry.artifact||await digest(entry.artifact)!==entry.sha256)throw Error('bta-driver-runtime-changed');
  }
 }
 matrices.push(matrix);
}
const verificationPaths=['src/test/gradle/btaDriver.test.ts','src/test/manual/gradleBtaDriverResults.mjs','src/test/fixtures/gradleBtaDriverRuntime.d.mts','src/test/fixtures/gradlePluginJarProof.ts','src/test/fixtures/gradlePluginLoadProof.ts','src/test/fixtures/gradleSnapshotOwnerExpected.mjs','src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts'];
const verificationSourcesSha256=Object.fromEntries(await Promise.all(verificationPaths.map(async p=>[p,await digest(path.join(repo,p))])));
const cases=matrices.flatMap(m=>m.cases),runs=cases.flatMap(c=>c.runs),decisions=cases.flatMap(c=>c.decision.runs);
const scope={gradleBuilds:runs.length,kotlinCompilerCalls:decisions.reduce((n,d)=>n+d.kotlinCompilerCalls,0),generatedSnapshots:runs.reduce((n,r)=>n+r.program.snapshots.length,0),offeredInputCandidates:decisions.filter(d=>d.offeredInputsVerified).length,staleRejections:decisions.filter(d=>d.reason==='kotlin_derived_snapshot_stale').length,storageRejections:decisions.filter(d=>d.reason==='kotlin_pipeline_snapshot_storage_mismatch').length,extraEvaluationRejections:decisions.filter(d=>d.reason==='bta_driver_extra_evaluation').length,configurationRejections:decisions.filter(d=>d.reason==='bta_driver_configuration_unregistered'||d.reason==='bta_driver_configuration_binding_mismatch').length,recordMutationRejections:cases.reduce((n,c)=>n+c.regressions.length,0),approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0};
const result={schema:'osv-mcp.bta-owned-driver-experiment-v2',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),sourcesSha256,verificationSourcesSha256,javaSha256,scope,limitations:['offered-inputs-only; no compiler consumed-bytes receipt','own Java driver via common Groovy helper and Groovy/Kotlin build wrappers; no unchanged KGP build integration','closed explicit runtime profile including same-version reflect override; no default Maven resolution or arbitrary compiler versions','synchronous in-process BTA only; no daemon, parallel, incremental no-op or cache-hit reuse proof','pre/post content checks cannot exclude transient change-and-restore or prove all writers are excluded','additional evaluation measures the owned Gradle provider and concrete-list selection, not all private compiler suppliers','published snapshot evidence contains size/digest/class count only; saved bytes remain in the disposable native project'],matrices};
let preReviews=[];
try{const bytes=await readFile(output),old=JSON.parse(bytes);preReviews=old.preReviews??[];if(old.schema!=='osv-mcp.bta-owned-driver-experiment-v2')preReviews.push({schema:old.schema,recordedAt:old.recordedAt,scope:old.scope,recordSha256:hash(bytes),note:'Uncommitted v1 before configuration/parameter identity binding; reference-only summary, not current evidence.'});}catch(error){if(error.code!=='ENOENT')throw error;}
result.preReviews=preReviews;
const portable=tokenizeRecordedPaths(result,[{token:'$GRADLE_USER_HOME',paths:[cache,await realpath(cache)]},{token:'$GRADLE_RUNTIME',paths:[runtime,await realpath(runtime)]}]);assertNoAbsolutePaths(portable);await writeFile(output,JSON.stringify(portable,null,2)+'\n');console.log(JSON.stringify(scope));
