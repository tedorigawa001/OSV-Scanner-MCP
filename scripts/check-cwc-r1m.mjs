/** R1-M mapping and fresh finite buffer observations, without changing any pinned R0/R1-O source. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical,co0Hash as hash} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {r1mBuildLedger,validateR1mLedger,validateR1mObservation,compareR1mObservation,r1mArithmeticExamples,validateR1mArithmetic} from '../src/test/fixtures/gradleOwnedCwcR1mLedger.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1m-2026-11-13.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.149 R1-M：全領域台帳・所有者・寿命・上限と未被覆の具体化'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const conditions=[...section.matchAll(/^\| (R1M\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],executed:true,scope:'inventory-check',runtimeAdmissionProved:false}));
if(canonical(conditions.map(c=>c.id))!==canonical(Array.from({length:30},(_,i)=>'R1M'+String(i+1).padStart(2,'0'))))throw Error('r1m_conditions');
const baselines=[],oldSources={};
for(const p of ['docs/validation/gradle-cwc-r1o-2026-11-13.json','docs/validation/gradle-cwc-r1-design-2026-11-13.json','docs/validation/gradle-cwc-r0-2026-11-12.json']){
 const bytes=await readFile(p),r=JSON.parse(bytes);baselines.push({path:p,sha256:sha(bytes)});for(const [p,h]of Object.entries(r.sourceBindings)){if(p in oldSources&&oldSources[p]!==h)throw Error('r1m_baseline_conflict');oldSources[p]=h;}
}
const sourceBindings={},inventoryTest='src/test/utils/gradleOwnedCwcR1m.test.ts',recordTest='src/test/utils/gradleOwnedCwcR1mRecord.test.ts';
async function bind(p){if(p in sourceBindings)return;const bytes=await readFile(p),h=sha(bytes);if(p in oldSources&&oldSources[p]!==h)throw Error('r1m_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;
 for(const m of bytes.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const ledger=r1mBuildLedger();for(const p of [inventoryTest,recordTest,'scripts/check-cwc-r1m.mjs','src/test/fixtures/gradleOwnedCwcR1mLedger.d.mts',...ledger.sourceInventory.map(s=>s.path),...Object.keys(oldSources)])await bind(p);
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath)),bufferPoolSize:Buffer.poolSize};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1m-'));
async function run(test,env,count,prefix){const report=resolve(dir,prefix+'.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}catch(e){let failed='';try{failed=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1m_tests '+failed+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();if(!t.success||t.numPassedTests!==count||t.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:count},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('r1m_test_ids');}
try{
 const output=resolve(dir,'observations.json');await run(inventoryTest,{CWC_R1M_OBSERVATION_PATH:output},30,'R1MT');const observation=JSON.parse(await readFile(output)),arithmetic=r1mArithmeticExamples();
 const record={schema:'cwc-r1m.record.v1',date:'2026-11-13',reviewedOn:'2026-11-13',status:'inventory-only',document,baselines,sourceBindings,runtime,ledger,ledgerDigest:hash(ledger),ledgerSummary:validateR1mLedger(ledger),
  observation,observationDigest:hash(observation),observationSummary:validateR1mObservation(observation),arithmetic,arithmeticDigest:hash(arithmetic),arithmeticSummary:validateR1mArithmetic(arithmetic),conditions,tests:{inventory:30,record:11},performanceMeasured:false};
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));compareR1mObservation(saved.observation,observation);if(canonical(saved)!==canonical(record))throw Error('r1m_saved_record');}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await run(recordTest,{CWC_R1M_RECORD_PATH:candidate},11,'R1MR');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1m_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,...record.ledgerSummary,...record.observationSummary,tests:record.tests,sources:Object.keys(sourceBindings).length}));
}finally{await rm(dir,{recursive:true,force:true});}
