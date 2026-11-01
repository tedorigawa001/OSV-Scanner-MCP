/** Revalidate native content-boundary observations and save portable, deduplicated bytes. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {contentSources,verifySnapshotContentCase,contentRegressions,contentCaseRegressions} from '../fixtures/gradleSnapshotContentProof.mjs';
import {resolveGradleApiArtifact} from '../fixtures/gradleKgpAvailabilityProof.mjs';
import {tokenizeRecordedPaths,assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
import {packContentCase,unpackContentCase} from './snapshotContentRecord.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [prefix,output]=process.argv.slice(2),cache=process.env.GRADLE_USER_HOME,runtime=process.env.OSV_MCP_GRADLE_RUNTIME_ROOT,jdk=process.env.JAVA_HOME;
if(!prefix||!output||!cache||!runtime||!jdk)throw Error('usage: JAVA_HOME=... GRADLE_USER_HOME=<isolated-cache> OSV_MCP_GRADLE_RUNTIME_ROOT=... node gradleSnapshotContentResults.mjs <prefix> <output>');
await readFile(path.join(cache,'osv-content-isolated-cache'));
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const sourcesSha256=Object.fromEntries(await Promise.all(contentSources.map(async p=>[p,await digest(path.join(repo,p))])));
const referencePath='docs/validation/gradle-kgp-availability-2026-11-01.json',prior=JSON.parse(await readFile(path.join(repo,referencePath),'utf8'));
const matrices=[],blobs={},contractEvidence=[];
for(const gradleVersion of ['8.11.1','9.2.1']){
 const matrix=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 if(matrix.schema!=='osv-mcp.snapshot-content-matrix-v2'||matrix.gradleVersion!==gradleVersion||matrix.cases.length!==2||new Set(matrix.cases.map(c=>c.dsl)).size!==2)throw Error('snapshot_content_matrix_invalid');
 const old=prior.matrices.find(m=>m.gradleVersion===gradleVersion).cases[0].runs[0];
 const approvedApi={gradle:old.apiArtifacts.gradle.sha256,kgp:old.apiArtifacts.kgp.sha256,implementation:old.implementation.sha256};
 for(const c of matrix.cases){
  const approval={gradleVersion,dsl:c.dsl,approvedApi,sourcesSha256};
  if(JSON.stringify(c.approvedApi)!==JSON.stringify(approvedApi))throw Error('snapshot_content_approval_invalid');
  const decision=verifySnapshotContentCase(c,approval),regressions=contentRegressions(c,approval),caseRegressions=contentCaseRegressions(c,approval);
  if(JSON.stringify(decision)!==JSON.stringify(c.decision)||JSON.stringify(regressions)!==JSON.stringify(c.regressions)||JSON.stringify(caseRegressions)!==JSON.stringify(c.caseRegressions))throw Error('snapshot_content_replay_mismatch');
  for(const r of [...c.runs,...c.faults])for(const entry of Object.values(r.api))if(await realpath(entry.artifact)!==entry.artifact||await digest(entry.artifact)!==entry.sha256)throw Error('snapshot_content_api_changed');
  packContentCase(c,blobs);
  const replay=verifySnapshotContentCase(unpackContentCase(c,blobs),approval);
  if(JSON.stringify(replay)!==JSON.stringify(decision))throw Error('snapshot_content_storage_replay_mismatch');
 }
 const api=matrix.cases[0].runs[0].api;
 await resolveGradleApiArtifact(path.join(runtime,'gradle-'+gradleVersion,'lib'),api.gradle);
 const signature=execFileSync(path.join(jdk,'bin/javap'),['-public','-classpath',api.gradle.artifact,'org.gradle.api.Task'],{encoding:'utf8'});
 const methods=signature.split('\n').filter(line=>/ (doFirst|doLast)\(/.test(line));
 if(methods.length<4)throw Error('snapshot_content_public_boundary_missing');
 contractEvidence.push({gradleVersion,api,methods,currentDocumentation:'https://docs.gradle.org/current/javadoc/org/gradle/api/Task.html',versionedDocumentationRetrieved:false,interpretation:'Public task action boundary only; not a KGP compiler consumption callback or a consumed-bytes receipt.'});
 matrices.push(matrix);
}
const verificationPaths=['src/test/gradle/snapshotContent.test.ts','src/test/gradle/snapshotContentRecord.test.ts','src/test/manual/gradleSnapshotContentResults.mjs','src/test/manual/snapshotContentRecord.mjs','src/test/manual/snapshotContentRecord.d.mts','src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts','src/test/fixtures/gradlePluginJarProof.ts','src/test/fixtures/gradlePluginLoadProof.ts','src/test/fixtures/gradleKgpAvailabilityProof.mjs','src/test/fixtures/gradleKgpAvailabilityProof.d.mts'];
const verificationSourcesSha256=Object.fromEntries(await Promise.all(verificationPaths.map(async p=>[p,await digest(path.join(repo,p))])));
const cases=matrices.flatMap(m=>m.cases),scope={nativeBuilds:cases.reduce((n,c)=>n+c.runs.length+c.faults.length,0),boundaryFreshnessCandidates:cases.length,cachedReadRejections:cases.reduce((n,c)=>n+c.decision.faults.length,0),fileMutationRejections:cases.length*3,storageMismatchRejections:cases.length,missingReceiptNoReadRefusals:cases.length,recordMutationRejections:cases.reduce((n,c)=>n+c.regressions.length,0),coordinatedTraceRejections:cases.reduce((n,c)=>n+c.caseRegressions.length,0),approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0,limitations:['doFirst observation is before KGP action, not an owner natural-consumption hook','endpoint equality cannot prove consumption-time bytes or exclude transient change and restore','empty concrete supplier sensor only; not all private suppliers or all observers','same DSL included binary producer only; no buildSrc, precompiled or cross DSL','no production adapter, schema, trust setting or full pipeline adoption']};
let preReviews=[];
try{const bytes=await readFile(output),old=JSON.parse(bytes);preReviews=old.preReviews??[];if(old.schema!=='osv-mcp.snapshot-content-experiment-v2')preReviews.push({schema:old.schema,recordedAt:old.recordedAt,scope:old.scope,recordSha256:createHash('sha256').update(bytes).digest('hex'),note:'Uncommitted v1 summary before cached-read and supplier-placement review fixes; reference only, not current evidence.'});}catch(error){if(error.code!=='ENOENT')throw error;}
const result=tokenizeRecordedPaths({schema:'osv-mcp.snapshot-content-experiment-v2',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),pathTokens:{'$GRADLE_USER_HOME':'GRADLE_USER_HOME','$GRADLE_RUNTIME':'OSV_MCP_GRADLE_RUNTIME_ROOT'},sourcesSha256,verificationSourcesSha256,apiReferenceRecord:{path:referencePath,sha256:await digest(path.join(repo,referencePath))},scope,contractEvidence,matrices,blobs,preReviews},[{token:'$GRADLE_USER_HOME',paths:[cache,await realpath(cache)]},{token:'$GRADLE_RUNTIME',paths:[runtime,await realpath(runtime)]}]);
assertNoAbsolutePaths(result);await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(scope));
