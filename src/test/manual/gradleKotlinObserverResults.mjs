/** Consolidate only complete full-reader experiments whose captured sources still match. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {observerSourcePaths,verifyObserverMatrix,verifyObserverCase} from '../fixtures/gradleKotlinObserverProof.mjs';
const repo=fileURLToPath(new URL('../../../',import.meta.url));
const [prefix,output]=process.argv.slice(2);
if(!prefix||!output)throw new Error('usage: node gradleKotlinObserverResults.mjs <matrix-prefix> <output>');
const digest=async f=>createHash('sha256').update(await readFile(path.join(repo,f))).digest('hex');
const sourcesSha256=Object.fromEntries(await Promise.all(observerSourcePaths.map(async f=>[f,await digest(f)])));
const matrices=[],baselineComparisons=[];
for(const gradleVersion of ['8.11.1','9.2.1']){
 const matrix=JSON.parse(await readFile(prefix+'-'+gradleVersion+'.json','utf8'));
 const decisions=verifyObserverMatrix(matrix,{gradleVersion,sourcesSha256});
 const targets=[
  ...['pre-compileKotlin','compileKotlin','compileJava','pluginDescriptors','processResources','jar'].map(task=>({task,field:null,name:'receipt:'+task})),
  ...[['pre-compileKotlin','classes'],['pre-compileKotlin','javaSources'],['compileKotlin','settings'],['compileJava','javaOutputs'],['pluginDescriptors','readSlots'],['processResources','readSlots'],['jar','manifest'],['jar','archive'],['jar','temporaryRoot']].map(([task,field])=>({task,field,name:task+':'+field})),
  ...['libraries','snapshots','compilerClasspath','plugins','taskInputs','taskOutputs'].map(field=>({task:'compileKotlin',field:'readSlots.'+field,name:'compileKotlin:readSlots.'+field})),
  ...['taskInputs','taskOutputs'].map(field=>({task:'jar',field:'readSlots.'+field,name:'jar:readSlots.'+field}))
 ];
 for(let i=0;i<matrix.cases.length;i++){
  const c=matrix.cases[i],decision=decisions[['Groovy','Kotlin'].indexOf(c.consumerDSL)*3+['raw','owned','tainted'].indexOf(c.mode)];
  if(c.mode==='owned'?!decision.equal:decision.equal||!decision.extraEvaluations.length)throw new Error('unexpected-profile-result');
  if(!Array.isArray(c.evidenceRejections)||c.evidenceRejections.length!==targets.length||new Set(c.evidenceRejections.map(r=>r.name)).size!==targets.length)throw new Error('missing-observer-rejection-evidence');
  for(const target of targets){
   const saved=c.evidenceRejections.find(r=>r.name===target.name);
   if(!saved||saved.accepted!==false||saved.reason!=='observer_read_inventory_incomplete')throw new Error('invalid-observer-rejection-evidence');
   const changed=structuredClone(c),record=changed.runs[1].receipts.find(r=>r.task===target.task);
   if(target.field===null)changed.runs[1].receipts=changed.runs[1].receipts.filter(r=>r.task!==target.task);
   else if(target.field.startsWith('readSlots.'))delete record.readSlots[target.field.slice('readSlots.'.length)];
   else delete record[target.field];
   let outcome,reason;
   try{outcome=verifyObserverCase(changed,{gradleVersion,consumerDSL:c.consumerDSL,mode:c.mode,eagerCompiler:false,sourcesSha256});}catch(error){reason=error.message;}
   if(outcome!==undefined||reason!==saved.reason)throw new Error('observer-rejection-replay-mismatch');
  }
  c.decision=decision;
 }
 matrices.push(matrix);
 for(const consumerDSL of ['Groovy','Kotlin']){
  const raw=matrix.cases.find(c=>c.consumerDSL===consumerDSL&&c.mode==='raw').runs[0];
  const owned=matrix.cases.find(c=>c.consumerDSL===consumerDSL&&c.mode==='owned').runs[0];
  const counts=run=>Object.fromEntries([...new Set(run.trace.filter(e=>e.event.startsWith('supplier:')).map(e=>e.event))].sort().map(event=>[event,run.trace.filter(e=>e.event===event).length]));
  if(JSON.stringify(Object.entries(matrix.cases.find(c=>c.consumerDSL===consumerDSL&&c.mode==='raw').fixtureInputsSha256).sort())!==JSON.stringify(Object.entries(matrix.cases.find(c=>c.consumerDSL===consumerDSL&&c.mode==='owned').fixtureInputsSha256).sort()))throw new Error('baseline-source-changed');
  if(JSON.stringify(raw.jarEntries)!==JSON.stringify(owned.jarEntries))throw new Error('baseline-artifact-changed');
  baselineComparisons.push({gradleVersion,consumerDSL,rawControlCounts:counts(raw),ownedControlCounts:counts(owned),artifactEntriesEqual:true,
   transparentToOriginalBuild:false,note:'The producer-owned finalization policy changes the original supplier evaluation contract, despite equal artifact entry contents.'});
 }
}
const verificationSourcesSha256=Object.fromEntries(await Promise.all(['src/test/gradle/kotlinObserver.test.ts','src/test/manual/gradleKotlinObserverResults.mjs'].map(async f=>[f,await digest(f)])));
let preReview;
try{const old=JSON.parse(await readFile(output,'utf8'));preReview=old.preReview??{recordedAt:old.recordedAt,sourcesSha256:old.sourcesSha256,nativeBuilds:old.scope?.nativeBuilds,regularCases:old.matrices?.reduce((n,m)=>n+m.cases.length,0),note:'Initial v1 observations before compiler registration lifecycle and complete receipt validation fixes; not reused as v2 native evidence.'};}catch(error){if(error.code!=='ENOENT')throw error;}
const result={schema:'osv-mcp.kotlin-full-observer-experiment-v2',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),nodeVersion:process.version,sourcesSha256,verificationSourcesSha256,
 scope:{productionChanged:false,productionAdoptionEnabled:false,consumerDSL:['Groovy','Kotlin'],producer:'included build root, binary Kotlin compiled by standard kotlin-dsl',modes:['raw','owned','tainted'],nativeBuilds:matrices.reduce((n,m)=>n+m.cases.reduce((sum,c)=>sum+c.runs.length,0)+m.rejections.reduce((sum,r)=>sum+r.proof.runs.length,0),0),maxWorkers:1,parallel:false,configurationCache:false,compilerExecution:'IN_PROCESS',incremental:false,
  sensorValues:'Seven fixture-owned suppliers return empty concrete file lists; the actual standard compiler, source, snapshot and Jar API collections are nonempty.',
  traceMeaning:'Lifecycle phases and order of instrumented suppliers, task Actions, declaration realization and plugin application; not all private Gradle/KGP suppliers or wall-clock equality.',
  unproven:['transparent capture for an unmodified build','independent completeness of all input-owner registrations','every internal supplier evaluation','precompiled Kotlin and plugins-block capture recipe','buildSrc','production v4/v6 schema and import','snapshot blob persistence and full budget rules','OSV integration']},
 exploration:[{attempt:'Add an empty file dependency directly before defaultDependencies',result:'rejected-build-failed',reason:'KGP default compiler dependencies suppressed',includedInMatrix:false},{attempt:'One shared phase variable across tasks',result:'rejected-measurement-invalid',reason:'Another task progressed during Kotlin compile and overwrote the phase; replaced by thread-local context stack and serial profile',includedInMatrix:false},{attempt:'Public withDependencies callback after default dependencies',result:'used-by-final-fixture',internalApiCalled:false}],
 baselineComparisons,matrices,...(preReview?{preReview}:{})};
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,cases:matrices.reduce((n,m)=>n+m.cases.length,0),nativeBuilds:result.scope.nativeBuilds,earlyRejections:matrices.reduce((n,m)=>n+m.rejections.length,0),evidenceRejections:matrices.flatMap(m=>m.cases).reduce((n,c)=>n+c.evidenceRejections.length,0),conditionalCandidates:matrices.flatMap(m=>m.cases).filter(c=>c.decision.conditionalCandidate).length,productionAdoptions:matrices.flatMap(m=>m.cases).filter(c=>c.decision.productionAdopted).length}));
