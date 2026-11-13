/** Verifies design/document/source consistency only; planned RHC runtime cases are never marked executed. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {R1H_DESIGN,R1H_OWNERS,R1H_REF_ROLES,R1H_SOURCE_ACTIONS,R1H_SUMMARY_LAYOUT,r1hBatchArithmetic,r1hUpperExample} from '../src/test/fixtures/gradleOwnedCwcR1hDesign.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1h-design-2026-11-13.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.150 R1-H：hook捕捉graph・保持構造の有界化とcharge（設計）'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const conditions=[...section.matchAll(/^\| (RHC\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
if(canonical(conditions.map(x=>x.id))!==canonical(Array.from({length:48},(_,i)=>'RHC'+String(i+1).padStart(2,'0'))))throw Error('r1h_conditions');
const baseline={path:'docs/validation/gradle-cwc-r1m-2026-11-13.json'},bytes=await readFile(baseline.path),old=JSON.parse(bytes);baseline.sha256=sha(bytes);
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('r1h_legacy_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcR1hDesign.test.ts';
for(const p of [test,'scripts/check-cwc-r1h-design.mjs','src/test/fixtures/gradleOwnedCwcR1hDesign.d.mts',...Object.keys(old.sourceBindings)])await bind(p);
const originalRows=R1H_SOURCE_ACTIONS.map(x=>{const row=old.ledger.rows.find(r=>r.id===x.id);if(!row)throw Error('r1h_missing_row_'+x.id);return row;});
const unknown={referenceUpper:null,handleUpper:null,windowContainerUpper:null,retirementContainerUpper:null,summaryWrapperUpper:null,moduleShareUpper:null,frameUpper:null,exportMode:'summary-v1'};
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const record={schema:'cwc-r1h.design-record.v1',date:'2026-11-13',reviewedOn:'2026-11-13',status:'design-only',document,baseline,sourceBindings,runtime,contract:R1H_DESIGN,owners:R1H_OWNERS,referenceRoles:R1H_REF_ROLES,sourceActions:R1H_SOURCE_ACTIONS,originalRows,summaryLayout:R1H_SUMMARY_LAYOUT,batchCases:R1H_DESIGN.batchCases,batchArithmetic:['provider','client'].flatMap(kind=>[1,2,19].map(batchCount=>r1hBatchArithmetic({kind,batchCount}))),
 arithmetic:{unknown:r1hUpperExample(unknown),hypotheticalFinite:r1hUpperExample({...unknown,referenceUpper:8,handleUpper:32,windowContainerUpper:384,retirementContainerUpper:128,summaryWrapperUpper:128,moduleShareUpper:128,frameUpper:128})},conditions,
 review:{regressions:['R1HD25','R1HD26','R1HD27','R1HD28'],preFixFailuresConfirmed:4,scope:'design-consistency-only',oldHypotheticalEnvelopeUpper:5376,correctedHypotheticalEnvelopeUpper:9216,omittedWindowBodyUpper:3840},designChecksPassed:28,runtimeRegressionsExecuted:false};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1h-design-'));
try{
 if(process.argv.includes('--check')&&canonical(JSON.parse(await readFile(path)))!==canonical(record))throw Error('r1h_record');
 const candidate=resolve(dir,'candidate.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_R1H_DESIGN_RECORD_PATH:candidate}});}
 catch(e){let failed='';try{const r=JSON.parse(await readFile(report));failed=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1h_tests '+failed+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^R1HD(\d{2}):/)?.[1])).sort();
 if(!t.success||t.numPassedTests!==28||t.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:28},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('r1h_test_ids');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1h_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:'design-only',designChecks:28,plannedRuntimeConditions:48,owners:7,referenceRoles:48,originalRows:19,sources:Object.keys(sourceBindings).length,runtimeRegressionsExecuted:false,runtimeAdmitted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
