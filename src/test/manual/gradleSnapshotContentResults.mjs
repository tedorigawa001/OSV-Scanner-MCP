/** Revalidate native content-boundary observations and save portable, deduplicated bytes. */
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {contentSources,verifySnapshotContentCase,contentRegressions,contentCaseRegressions} from '../fixtures/gradleSnapshotContentProof.mjs';
import {resolveGradleApiArtifact} from '../fixtures/gradleKgpAvailabilityProof.mjs';
import {tokenizeRecordedPaths,assertNoAbsolutePaths} from './kgpRecordPaths.mjs';
import {publishContentCase,packContentCase,unpackContentCase,contentRunIds,contentRecordCounts} from './snapshotContentRecord.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [prefix,output]=process.argv.slice(2),cache=process.env.GRADLE_USER_HOME,runtime=process.env.OSV_MCP_GRADLE_RUNTIME_ROOT,jdk=process.env.JAVA_HOME;
if(!prefix||!output||!cache||!runtime||!jdk)throw Error('usage: JAVA_HOME=... GRADLE_USER_HOME=<isolated-cache> OSV_MCP_GRADLE_RUNTIME_ROOT=... node gradleSnapshotContentResults.mjs <prefix> <output>');
await readFile(path.join(cache,'osv-content-isolated-cache'));
const digest=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const sourcesSha256=Object.fromEntries(await Promise.all(contentSources.map(async p=>[p,await digest(path.join(repo,p))])));
const referencePath='docs/validation/gradle-kgp-availability-2026-11-01.json',prior=JSON.parse(await readFile(path.join(repo,referencePath),'utf8'));
const matrices=[],blobs={},contractEvidence=[];let publishedCases;
for(const gradleVersion of ['8.11.1','9.2.1']){
 const matrix=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 if(matrix.schema!=='osv-mcp.snapshot-content-matrix-v2'||matrix.gradleVersion!==gradleVersion||matrix.cases.length!==2||new Set(matrix.cases.map(c=>c.dsl)).size!==2)throw Error('snapshot_content_matrix_invalid');
 const old=prior.matrices.find(m=>m.gradleVersion===gradleVersion).cases[0].runs[0];
 const approvedApi={gradle:old.apiArtifacts.gradle.sha256,kgp:old.apiArtifacts.kgp.sha256,implementation:old.implementation.sha256};
 publishedCases=[];
 for(const c of matrix.cases){
  const approval={gradleVersion,dsl:c.dsl,approvedApi,sourcesSha256};
  if(JSON.stringify(c.approvedApi)!==JSON.stringify(approvedApi))throw Error('snapshot_content_approval_invalid');
  const decision=verifySnapshotContentCase(c,approval),regressions=contentRegressions(c,approval),caseRegressions=contentCaseRegressions(c,approval);
  if(JSON.stringify(decision)!==JSON.stringify(c.decision)||JSON.stringify(regressions)!==JSON.stringify(c.regressions)||JSON.stringify(caseRegressions)!==JSON.stringify(c.caseRegressions))throw Error('snapshot_content_replay_mismatch');
  for(const r of [...c.runs,...c.faults])for(const entry of Object.values(r.api))if(await realpath(entry.artifact)!==entry.artifact||await digest(entry.artifact)!==entry.sha256)throw Error('snapshot_content_api_changed');
  // Native verification above used every boundary byte; the published case retains only corruption evidence.
  const published=publishContentCase(c),packed=packContentCase(structuredClone(published),blobs),restored=unpackContentCase(packed,blobs),publishedApproval={...approval,storage:'published'};
  if(JSON.stringify(verifySnapshotContentCase(restored,publishedApproval))!==JSON.stringify(decision)||JSON.stringify(contentRegressions(restored,publishedApproval))!==JSON.stringify(regressions)||JSON.stringify(contentCaseRegressions(restored,publishedApproval))!==JSON.stringify(caseRegressions))throw Error('snapshot_content_storage_replay_mismatch');
  publishedCases.push(packed);
 }
 const api=matrix.cases[0].runs[0].api;
 await resolveGradleApiArtifact(path.join(runtime,'gradle-'+gradleVersion,'lib'),api.gradle);
 const signature=execFileSync(path.join(jdk,'bin/javap'),['-public','-classpath',api.gradle.artifact,'org.gradle.api.Task'],{encoding:'utf8'});
 const methods=signature.split('\n').filter(line=>/ (doFirst|doLast)\(/.test(line));
 if(methods.length<4)throw Error('snapshot_content_public_boundary_missing');
 contractEvidence.push({gradleVersion,api,methods,currentDocumentation:'https://docs.gradle.org/current/javadoc/org/gradle/api/Task.html',versionedDocumentationRetrieved:false,interpretation:'Public task action boundary only; not a KGP compiler consumption callback or a consumed-bytes receipt.'});
 matrices.push({...matrix,cases:publishedCases});
}
const verificationPaths=['src/test/gradle/snapshotContent.test.ts','src/test/gradle/snapshotContentRecord.test.ts','src/test/manual/gradleSnapshotContentResults.mjs','src/test/manual/snapshotContentRecord.mjs','src/test/manual/snapshotContentRecord.d.mts','src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts','src/test/fixtures/gradlePluginJarProof.ts','src/test/fixtures/gradlePluginLoadProof.ts','src/test/fixtures/gradleKgpAvailabilityProof.mjs','src/test/fixtures/gradleKgpAvailabilityProof.d.mts'];
const verificationSourcesSha256=Object.fromEntries(await Promise.all(verificationPaths.map(async p=>[p,await digest(path.join(repo,p))])));
const scope={...contentRecordCounts(matrices),retainedBlobs:Object.keys(blobs).length,limitations:['doFirst observation is before KGP action, not an owner natural-consumption hook','endpoint equality cannot prove consumption-time bytes or exclude transient change and restore','empty concrete supplier sensor only; not all private suppliers or all observers','same DSL included binary producer only; no buildSrc, precompiled or cross DSL','no production adapter, schema, trust setting or full pipeline adoption']};
const schema='osv-mcp.snapshot-content-experiment-v3';
let preReviews=[],observed=null;
try{const bytes=await readFile(output),old=JSON.parse(bytes);preReviews=old.preReviews??[];
 // Re-consolidating the same native runs keeps their observation revision and time.
 if(old.schema===schema&&JSON.stringify(contentRunIds(old.matrices??[]))===JSON.stringify(contentRunIds(matrices)))observed={recordedAt:old.recordedAt,baselineRevision:old.baselineRevision};
 if(old.schema==='osv-mcp.snapshot-content-experiment-v2')preReviews.push({schema:old.schema,recordedAt:old.recordedAt,baselineRevision:old.baselineRevision,scope:old.scope,recordSha256:createHash('sha256').update(bytes).digest('hex'),committedIn:'503f25c',note:'Committed v2 record retaining every boundary byte (about 95 MB raw in gzip blobs); superseded by v3, which publishes only the corruption evidence bytes.'});
 else if(old.schema!==schema)throw Error('snapshot_content_previous_record_unknown');
}catch(error){if(error.code!=='ENOENT')throw error;}
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),now=new Date().toISOString();
const result=tokenizeRecordedPaths({schema,recordedAt:observed?.recordedAt??now,baselineRevision:observed?.baselineRevision??head,...(observed?{reconsolidatedAt:now,reconsolidatedRevision:head}:{}),storage:{native:'every boundary byte verified during native and consolidation checks',published:'bytes retained only for the corrupted blob-corrupt file; other receipt entries keep size and SHA-256 with bytesOmitted'},pathTokens:{'$GRADLE_USER_HOME':'GRADLE_USER_HOME','$GRADLE_RUNTIME':'OSV_MCP_GRADLE_RUNTIME_ROOT'},sourcesSha256,verificationSourcesSha256,apiReferenceRecord:{path:referencePath,sha256:await digest(path.join(repo,referencePath))},scope,contractEvidence,matrices,blobs,preReviews},[{token:'$GRADLE_USER_HOME',paths:[cache,await realpath(cache)]},{token:'$GRADLE_RUNTIME',paths:[runtime,await realpath(runtime)]}]);
assertNoAbsolutePaths(result);await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(scope));
