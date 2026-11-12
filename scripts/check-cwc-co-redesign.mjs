/** Documentation/conditional-arithmetic verification only; executes no planned CCR runtime condition. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {CO_RED_DESIGN,coRedesignCapacity,coRedesignWork,coRedesignBatch} from '../src/test/fixtures/gradleOwnedCwcCoRedesign.mjs';
import {co0Canonical as canonical,co0Hash as hash} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-co-redesign-2026-11-12.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.145 CCO-R：所有consumer・領域・workの改訂契約（設計）'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const extract=p=>[...section.matchAll(new RegExp('^\\| ('+p+') \\| (.+) \\|$','gm'))].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
const conditions=extract('CCR\\d{2}'),stages=extract('CCO-R[0-2]');
if(canonical(conditions.map(c=>c.id))!==canonical(Array.from({length:48},(_,i)=>'CCR'+String(i+1).padStart(2,'0')))||canonical(stages.map(s=>s.id))!==canonical(['CCO-R0','CCO-R1','CCO-R2']))throw Error('co_redesign_conditions');
const baselinePaths=['docs/validation/gradle-cwc-co0b-2026-11-12.json','docs/validation/gradle-cwc-lg-capacity-2026-11-12.json'];
const baselines=[],oldSources={};let capacity;
for(const p of baselinePaths){const b=await readFile(p),r=JSON.parse(b);baselines.push({path:p,sha256:sha(b)});if(p.includes('co0b')){
 if(r.packedDigest!==hash(r.packed)||r.summary.decision.co0Exit!==false)throw Error('co_redesign_baseline');Object.assign(oldSources,r.sourceBindings);
 }else capacity=r;}
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in oldSources&&oldSources[p]!==h)throw Error('co_redesign_old_source_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcCoRedesign.test.ts';
for(const p of [...Object.keys(oldSources),'scripts/check-cwc-co-redesign.mjs',test,'src/test/fixtures/gradleOwnedCwcCoRedesign.d.mts'])await bind(p);
const memoryRows=capacity.evidence.rows.filter(r=>r.mode==='full-input'&&r.recipe==='window-3-with-4096-metadata').map(r=>({role:r.role,boundary:r.boundary,context:r.context,calculation:coRedesignCapacity(r.context,r.role)}));
if(memoryRows.length!==6)throw Error('co_redesign_matrix');
const arithmetic={metadataBytes:['header','rows','bridge','leases','alignment'].reduce((a,k)=>a+CO_RED_DESIGN.metadata[k],0),
 bridgeBytes:48*8+8*32+384,activeWindowBytes:3*8192,
 retainedCallerExample:coRedesignCapacity(memoryRows.at(-1).context,'authority-broker',{callerClientCores:1}),
 illustrativeWork:coRedesignWork({work:151554,initialization:0,extraWork:5424,extraInitialization:0})};
if(arithmetic.metadataBytes!==4096||arithmetic.bridgeBytes!==1024||arithmetic.retainedCallerExample.client!==1057397)throw Error('co_redesign_arithmetic');
const width=memoryRows[0].calculation.widths.commandBytes;
const batchExamples=[1,2,19].map(n=>coRedesignBatch({batchCount:n,coreGroups:n,width,capturedOrdinals:Array.from({length:n},(_,i)=>i),provedOrdinals:Array.from({length:n},(_,i)=>i)}));
const legacyPlannerOracle={sizes:[1,1,1,1,1],entries:5,sourceBytes:5,commands:2,batchCount:2,coreGroups:2,width,reservedRows:19,reservedFamilyBytes:19*width};
const record={schema:'cwc-co.redesign-record.v1',date:'2026-11-12',status:'design-only',document,sourceBindings,baselines,contract:CO_RED_DESIGN,
 memoryRows,arithmetic,batchExamples,legacyPlannerOracle,legacyPlannerOracleExecuted:true,conditions,stages,designChecksPassed:14,runtimeRegressionsExecuted:false,performanceMeasured:false};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-co-redesign-'));
try{
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path,'utf8'));if(canonical(saved)!==canonical(record))throw Error('co_redesign_record');}
 const candidate=resolve(dir,'candidate.json'),report=resolve(dir,'tests.json'),oraclePath=resolve(dir,'batch-oracle.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_CO_REDESIGN_RECORD_PATH:candidate,CWC_CO_REDESIGN_BATCH_PATH:oraclePath}});}
 catch(e){let failed='';try{const r=JSON.parse(await readFile(report));failed=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('co_redesign_checks '+failed+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^CRD(\d{2}):/)?.[1])).sort();
 if(!t.success||t.numPassedTests!==14||t.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:14},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('co_redesign_tests');
 if(canonical(JSON.parse(await readFile(oraclePath,'utf8')))!==canonical(legacyPlannerOracle))throw Error('co_redesign_legacy_batch_oracle');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('co_redesign_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:'design-only',designChecks:14,plannedRuntimeConditions:48,plannedStages:3,memoryExamples:6,legacyPlannerCommands:2,runtimeRegressionsExecuted:false,co0Exit:false}));
}finally{await rm(dir,{recursive:true,force:true});}
