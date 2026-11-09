/** CWC-B evidence from actual Vitest cases, signed matrix and unmodified-session observations. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
const path='docs/validation/gradle-cwc-b-2026-11-09.json',test='src/test/utils/gradleOwnedCwcB.test.ts',sha=b=>createHash('sha256').update(b).digest('hex');
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const s=await readFile(p,'utf8');sourceBindings[p]=sha(s);for(const m of s.matchAll(/from\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,'scripts/check-cwc-b.mjs','package-lock.json','vitest.config.ts','tsconfig.json'])await bind(p);
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.119 CWC-B：閉じたfamilyの構造／長さと実codec bytesの限定実証'};
document.sectionSha256=sha(designSection(await readFile(document.path,'utf8'),document.heading));
const expectedIds=Array.from({length:35},(_,i)=>'CWB'+String(i+1).padStart(2,'0')),titles=[...(await readFile(test,'utf8')).matchAll(/it\('([^']+)'/g)].map(m=>m[1]);
if(titles.length!==expectedIds.length)throw Error('cwc_b_source_cases');
const claims={diagnosticOnly:true,closedSubsetTreeChecked:true,fullOracleRetained:true,realSignatureVectorsChecked:true,realSignedSessionObserved:true,sessionAdapterChanged:false,independentSourceApprovalDeployed:false,optimizedPrimaryAdopted:false,performanceMeasured:false,performanceImprovementEstablished:false,productionAdopted:false,realStorageVerified:false,nativeIsolationVerified:false,eightReadsEstablished:false,originalReadsSkipped:0,readCommittedReduction:0};
const workloadIds=['small','mid-2048','large-commit','large-payload','h0Sizes','singleLarge'],domains=['command.full','wireIntent.preimage','owner.request.signed','owner.request.unsigned','owner.reply.signed','owner.reply.unsigned',...['auth.challenge-request.request','auth.challenge.reply','auth.channel.request','auth.channel.reply'].flatMap(x=>[x+'.signed',x+'.unsigned'])].sort();
function validate(r){
 if(r.schema!=='cwc-b.validation.v1'||r.testFile!==test||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||JSON.stringify(r.document)!==JSON.stringify(document)||JSON.stringify(r.claims)!==JSON.stringify(claims)||r.testsPassed!==35||r.testsFailed!==0)throw Error('cwc_b_bindings');
 if(r.cases.length!==35||new Set(r.cases.map(x=>x.id)).size!==35||r.cases.some(x=>!expectedIds.includes(x.id)||x.title!==titles[expectedIds.indexOf(x.id)]||x.status!=='passed'))throw Error('cwc_b_cases');
 if(r.samples.length!==24||new Set(r.samples.map(x=>[x.workload,x.role,x.largeIds].join(':'))).size!==24)throw Error('cwc_b_samples');
 for(const s of r.samples){const n=s.commands,d=s.diagnostics;
  if(!workloadIds.includes(s.workload)||!['reader','authority-broker'].includes(s.role)||typeof s.largeIds!=='boolean'||!Number.isSafeInteger(n)||n<1||n>19||s.comparisons!==14*n||s.preimages!==6*n||s.signedEnvelopes!==6*n||s.signatureVerifications!==6*n||s.oracleOwners!==2*n||s.oracleFrames!==4*n||s.sourcePlannerReference.layoutOwners!==2||s.sourcePlannerReference.layoutFrames!==4||s.sourcePlannerReference.finalOwners!==2*n||s.sourcePlannerReference.finalFrames!==4*n||s.proofWorkUnits!==s.referenceWorkUnits||s.conservativeWireBytes!==s.referenceWireBytes||s.sourceReadCallbacks!==0||s.semanticPlanUnchanged!==true||JSON.stringify(Object.keys(s.domains).sort())!==JSON.stringify(domains)||Object.values(s.domains).some(x=>x!==n)||d.encodes!==14*n||d.proofs!==n||JSON.stringify(s.planningCalls)!==JSON.stringify({owner:0,frames:0,exact:0,result:0,layout:0,ownedSha256:0})||s.probeControlOwnerCalls!==2*n||d.fixedBytes>81920||d.fragments>4096||d.scratchPeak>65536||d.logicalWorkspaceReserved+s.oraclePeakLogicalBytes+s.serializedPlanBytes>1048576)throw Error('cwc_b_sample_coverage');
 }
 if(r.sessions.length!==2||new Set(r.sessions.map(x=>x.role)).size!==2)throw Error('cwc_b_sessions');
 for(const s of r.sessions)if(!['reader','authority-broker'].includes(s.role)||s.authFrames!==4*s.requests||s.ownerEnvelopes!==2*s.requests||s.comparisons!==12*s.requests||s.requests<1||s.requests>19||s.clientPlans!==2||s.providerPlans!==s.requests||s.sourceLoads!==s.baselineSourceLoads||s.validatedBytes!==s.baselineValidatedBytes||s.wireBytes!==s.baselineWireBytes||s.randomSessionIdsDiffer!==true||s.semanticOutputsMatched!==true||s.wireUnchanged!==true||s.sessionAdapterChanged!==false)throw Error('cwc_b_session_coverage');
 const totals={samples:r.samples.length,commands:r.samples.reduce((n,s)=>n+s.commands,0),comparisons:r.samples.reduce((n,s)=>n+s.comparisons,0),signatureVerifications:r.samples.reduce((n,s)=>n+s.signatureVerifications,0),sessionComparisons:r.sessions.reduce((n,s)=>n+s.comparisons,0)};
 if(JSON.stringify(r.totals)!==JSON.stringify(totals))throw Error('cwc_b_totals');return totals;
}
let record;
if(process.argv.includes('--check'))record=JSON.parse(await readFile(path,'utf8'));
else{const temporary=await mkdtemp(resolve(tmpdir(),'cwc-b-'));try{
 const report=resolve(temporary,'vitest.json'),sampleFile=resolve(temporary,'samples.json'),sessionFile=resolve(temporary,'sessions.json');
 execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:60000,env:{...process.env,CWC_B_EVIDENCE_PATH:sampleFile,CWC_B_SESSION_EVIDENCE_PATH:sessionFile}});
 const result=JSON.parse(await readFile(report,'utf8'));if(!result.success||result.numPassedTests!==35||result.numFailedTests!==0||result.numPendingTests!==0||result.testResults.length!==1)throw Error('cwc_b_test_failure');
 const cases=result.testResults.flatMap(f=>f.assertionResults.map(a=>({id:a.fullName.match(/^CWB\d{2}/)?.[0],title:a.fullName,status:a.status}))),samples=JSON.parse(await readFile(sampleFile,'utf8')),sessions=JSON.parse(await readFile(sessionFile,'utf8'));
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('cwc_b_source_changed');
 record={schema:'cwc-b.validation.v1',date:'2026-11-09',testFile:test,runner:{command:'node scripts/check-cwc-b.mjs',node:process.version,vitest:JSON.parse(await readFile('node_modules/vitest/package.json','utf8')).version},document,sourceBindings,claims,testsPassed:result.numPassedTests,testsFailed:result.numFailedTests,cases,samples,sessions,totals:{samples:samples.length,commands:samples.reduce((n,s)=>n+s.commands,0),comparisons:samples.reduce((n,s)=>n+s.comparisons,0),signatureVerifications:samples.reduce((n,s)=>n+s.signatureVerifications,0),sessionComparisons:sessions.reduce((n,s)=>n+s.comparisons,0)}};
 validate(record);await writeFile(path,JSON.stringify(record,null,2)+'\n');
 }finally{await rm(temporary,{recursive:true,force:true});}}
console.log(JSON.stringify({...validate(record),status:'closed-subset-diagnostic-only',optimizedPrimaryAdopted:false}));
