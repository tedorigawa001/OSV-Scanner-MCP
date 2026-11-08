/** Re-run the CWC-A fixture suite to write evidence; --check verifies persisted source/document bindings. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
const recordPath='docs/validation/gradle-cwc-a-2026-11-09.json',test='src/test/utils/gradleOwnedCwcA.test.ts';
const sha=b=>createHash('sha256').update(b).digest('hex');
const sources={};
async function bind(path){if(path in sources)return;const text=await readFile(path,'utf8');sources[path]=sha(text);for(const m of text.matchAll(/from\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(path),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
await bind(test);await bind('scripts/check-cwc-a.mjs');await bind('package-lock.json');await bind('vitest.config.ts');await bind('tsconfig.json');
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.118 CWC-A：private helper・fact・予算／寿命のfixture contract'};
document.sectionSha256=sha(designSection(await readFile(document.path,'utf8'),document.heading));
const claims={fixtureContractOnly:true,simulatedScopeAssembly:true,productionRegistered:false,realSessionConnected:false,independentSourceApprovalDeployed:false,compositionImplemented:false,closedFamilyProofEstablished:false,actualEmitterChanged:false,codecReductionEstablished:false,performanceMeasured:false,realStorageVerified:false,nativeIsolationVerified:false,eightReadsEstablished:false,originalReadsSkipped:0,readCommittedReduction:0};
const expectedIds=Array.from({length:41},(_,i)=>'CWA'+String(i+1).padStart(2,'0'));
const expectedTitles=[...(await readFile(test,'utf8')).matchAll(/it\('([^']+)'/g)].map(m=>m[1]);
if(expectedTitles.length!==expectedIds.length)throw Error('cwc_a_test_source_coverage');
function checkCases(cases){if(cases.length!==expectedIds.length||new Set(cases.map(x=>x.id)).size!==expectedIds.length||JSON.stringify(cases.map(x=>x.id).sort())!==JSON.stringify(expectedIds)||cases.some(x=>x.status!=='passed'||x.title!==expectedTitles[expectedIds.indexOf(x.id)]))throw Error('cwc_a_case_coverage');}
if(process.argv.includes('--check')){
 const r=JSON.parse(await readFile(recordPath,'utf8'));checkCases(r.cases);
 if(r.schema!=='cwc-a.validation.v1'||r.testFile!==test||JSON.stringify(r.sourceBindings)!==JSON.stringify(sources)||JSON.stringify(r.document)!==JSON.stringify(document)||JSON.stringify(r.claims)!==JSON.stringify(claims)||r.testsPassed!==expectedIds.length||r.testsFailed!==0)throw Error('cwc_a_evidence_mismatch');
}else{
 const temporary=await mkdtemp(resolve(tmpdir(),'cwc-a-'));
 try{
  const output=resolve(temporary,'vitest.json');execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+output],{stdio:'pipe',timeout:60000});
  const result=JSON.parse(await readFile(output,'utf8'));
  if(!result.success||result.numPassedTests!==expectedIds.length||result.numFailedTests!==0||result.numPendingTests!==0||result.testResults.length!==1)throw Error('cwc_a_test_failure');
  const cases=result.testResults.flatMap(f=>f.assertionResults.map(a=>({id:a.fullName.match(/^CWA\d{2}/)?.[0],title:a.fullName,status:a.status})));
  checkCases(cases);
  for(const [p,h]of Object.entries(sources))if(sha(await readFile(p))!==h)throw Error('cwc_a_source_changed_during_run');
  await writeFile(recordPath,JSON.stringify({schema:'cwc-a.validation.v1',date:'2026-11-09',testFile:test,runner:{command:'node scripts/check-cwc-a.mjs',node:process.version,vitest:JSON.parse(await readFile('node_modules/vitest/package.json','utf8')).version},document,sourceBindings:sources,claims,testsPassed:result.numPassedTests,testsFailed:result.numFailedTests,cases},null,2)+'\n');
 }finally{await rm(temporary,{recursive:true,force:true});}
}
console.log(JSON.stringify({cases:expectedIds.length,status:'fixture-contract-only',compositionProven:false,codecReductionEstablished:false}));
