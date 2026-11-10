/** CLB-2 cooperative real-session correctness evidence; no performance/adoption assertion. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {LB2_SCOPE} from '../src/test/fixtures/gradleOwnedCwcLb2Validation.mjs';
const path='docs/validation/gradle-cwc-lb2-2026-11-10.json',test='src/test/utils/gradleOwnedCwcLb2.test.ts',recordTest='src/test/utils/gradleOwnedCwcLb2Record.test.ts';
const sha=b=>createHash('sha256').update(b).digest('hex'),sourceBindings={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const x of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!x[1].startsWith('.'))continue;let next=resolve(dirname(p),x[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcLb1Fixture.ts','src/test/fixtures/gradleOwnedCwcLb2Validation.d.mts','scripts/check-cwc-lb2.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.129 CLB-2：実SessionServer・全batch転送・transport最終検証への接続';
const sectionDigest=sha(designSection(await readFile(document,'utf8'),heading)),dir=await mkdtemp(resolve(tmpdir(),'cwc-lb2-'));
async function run(file,count,env){const report=resolve(dir,file===test?'runtime.json':'record.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:300000,env:{...process.env,...env}});}catch(e){let failures='';try{const r=JSON.parse(await readFile(report,'utf8'));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({test:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('lb2_tests: '+failures+' '+String(e.stdout??'')+' '+String(e.stderr??''),{cause:e});}const r=JSON.parse(await readFile(report,'utf8'));if(!r.success||r.numPassedTests!==count||r.numTotalTests!==count)throw Error('lb2_test_count');}
try{
 let r;if(process.argv.includes('--check'))r=JSON.parse(await readFile(path,'utf8'));else{const evidence=resolve(dir,'evidence.json');await run(test,14,{CWC_LB2_EVIDENCE_PATH:evidence});r={schema:'cwc-lb2.validation.v1',date:'2026-11-10',document,heading,sectionDigest,sourceBindings,testsPassed:14,recordTestsPassed:8,environment:{node:process.version},scope:LB2_SCOPE,measurement:JSON.parse(await readFile(evidence,'utf8'))};}
 if(r.document!==document||r.heading!==heading||r.sectionDigest!==sectionDigest||r.environment.node!==process.version||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||JSON.stringify(r.scope)!==JSON.stringify(LB2_SCOPE))throw Error('lb2_record_bindings');
 const record=resolve(dir,'candidate.json');await writeFile(record,JSON.stringify(r));await run(recordTest,8,{CWC_LB2_RECORD_PATH:record});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('lb2_source_changed');if(sha(designSection(await readFile(document,'utf8'),heading))!==sectionDigest)throw Error('lb2_document_changed');
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({runtimeTests:r.testsPassed,recordTests:r.recordTestsPassed,samples:r.measurement.samples.length,proofs:r.measurement.proofs.length,realSessionServer:true,performanceComparison:false,productionAdopted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
