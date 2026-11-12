/** R1 documentation/source/conditional-arithmetic consistency only. No runtime entry is implemented or exercised. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical,co0Hash as hash} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {R1_DESIGN,R1_REGIONS,R1_ADDITIONS,r1SourceAudit,r1BufferAudit,r1CapacityExample,r1WorkExample} from '../src/test/fixtures/gradleOwnedCwcR1Design.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1-design-2026-11-13.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.147 CCO-R1：所有移管・全領域台帳・事前予約の具体化（設計）'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const extract=p=>[...section.matchAll(new RegExp('^\\| ('+p+') \\| (.+) \\|$','gm'))].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
const conditions=extract('R1C\\d{2}'),steps=extract('R1-[OMWG]');
if(canonical(conditions.map(x=>x.id))!==canonical(Array.from({length:48},(_,i)=>'R1C'+String(i+1).padStart(2,'0')))||canonical(steps.map(s=>s.id))!==canonical(['R1-O','R1-M','R1-W','R1-G']))throw Error('r1_design_conditions');
const baselinePaths=['docs/validation/gradle-cwc-r0-2026-11-12.json','docs/validation/gradle-cwc-co-redesign-2026-11-12.json'],baselines=[],oldSources={};let r0,design;
for(const p of baselinePaths){const b=await readFile(p),r=JSON.parse(b);baselines.push({path:p,sha256:sha(b)});if(p.includes('r0-')){r0=r;if(r.evidenceDigest!==hash({evidence:r.evidence,differential:r.differential,audit:r.audit,review:r.review})||r.summary.co0Exit!==false)throw Error('r1_r0_baseline');}else design=r;
 for(const [p,h]of Object.entries(r.sourceBindings)){if(p in oldSources&&oldSources[p]!==h)throw Error('r1_source_conflict');oldSources[p]=h;}}
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in oldSources&&oldSources[p]!==h)throw Error('r1_legacy_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcR1Design.test.ts';
for(const p of [test,'scripts/check-cwc-r1-design.mjs','src/test/fixtures/gradleOwnedCwcR1Design.d.mts',...Object.keys(oldSources)])await bind(p);
const r=design.memoryRows.at(-1).calculation,zero=()=>Object.fromEntries(R1_ADDITIONS.map(k=>[k,0])),unknown=()=>Object.fromEntries(R1_ADDITIONS.map(k=>[k,null]));
const capacityExamples={unknown:r1CapacityExample(r.client,unknown()),conditional:r1CapacityExample(r.client,zero()),retainedCaller:r1CapacityExample(r.client,{...zero(),callerCoreBytes:r.widths.coreBytes}),providerOverflow:r1CapacityExample(r.provider,{...unknown(),outsideOverlayBytes:1996})};
const workExampleInput=R1_DESIGN.reservation.namespaces.map(namespace=>({namespace,unit:R1_DESIGN.reservation.unit,limit:namespace==='Lb0.call'?156978:namespace==='provider.read-row'?1048576:67108864,spent:namespace==='Lb0.call'?151554:0,additional:namespace==='Lb0.call'?5424:namespace==='CwcC.plan-parent'?2*156978:null}));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const record={schema:'cwc-r1.design-record.v1',date:'2026-11-13',status:'design-only',document,baselines,sourceBindings,runtime,contract:R1_DESIGN,regions:R1_REGIONS,
 sourceAudit:r1SourceAudit(),bufferAudit:r1BufferAudit(r0.evidence),capacityExamples,workExampleInput,workExample:r1WorkExample(workExampleInput),conditions,steps,designChecksPassed:20,runtimeRegressionsExecuted:false,performanceMeasured:false};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1-design-'));
try{
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));if(canonical(saved)!==canonical(record))throw Error('r1_design_record');}
 const candidate=resolve(dir,'candidate.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_R1_DESIGN_RECORD_PATH:candidate}});}
 catch(e){let failed='';try{const r=JSON.parse(await readFile(report));failed=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1_design_tests '+failed+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^R1D(\d{2}):/)?.[1])).sort();
 if(!t.success||t.numPassedTests!==20||t.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:20},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('r1_design_test_ids');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:'design-only',designChecks:20,plannedRuntimeConditions:48,plannedSteps:4,regions:15,sourceGroups:record.sourceAudit.length,r0BufferRows:record.bufferAudit.length,sources:Object.keys(sourceBindings).length,runtimeRegressionsExecuted:false,runtimeAdmitted:false,co0Exit:false}));
}finally{await rm(dir,{recursive:true,force:true});}
