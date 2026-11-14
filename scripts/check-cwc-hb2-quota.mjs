/** Limited HB-2a inventory/quota replay. Independent charge, physical bounds and durable epochs are not proved. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {hb2Hash,validateHb2Evidence,validateHb2Inventory,compareHb2Replay} from '../src/test/fixtures/gradleOwnedCwcHb2Validation.mjs';
import {hb2Inventory} from '../src/test/fixtures/gradleOwnedCwcHb2Inventory.mjs';
import {instrumentHb2} from '../src/test/fixtures/gradleOwnedCwcHb2Observer.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-hb2-quota-2026-11-14.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.155 HB-2a：分離後artifactの保持台帳・entry／epoch quotaの限定実装'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const conditions=[...section.matchAll(/^\| (HB2C\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],scope:'limited-entry-epoch-quota',executed:true,fullContractExecuted:false}));
if(canonical(conditions.map(c=>c.id))!==canonical(Array.from({length:24},(_,i)=>'HB2C'+String(i+1).padStart(2,'0'))))throw Error('hb2_conditions');
const baseline={path:'docs/validation/gradle-cwc-hb1-2026-11-14.json'},b=await readFile(baseline.path),old=JSON.parse(b);baseline.sha256=sha(b);
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('hb2_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const runtimeTest='src/test/utils/gradleOwnedCwcHb2.test.ts',recordTest='src/test/utils/gradleOwnedCwcHb2Record.test.ts';
for(const p of [runtimeTest,recordTest,'scripts/check-cwc-hb2-quota.mjs','scripts/run-cwc-hb2.mjs','scripts/run-cwc-hb2-case.mjs','src/test/fixtures/gradleOwnedCwcHb2Inventory.d.mts','src/test/fixtures/gradleOwnedCwcHb2Validation.d.mts','src/test/fixtures/gradleOwnedCwcHb2Core.mjs','src/test/fixtures/gradleOwnedCwcHb2Admission.mjs','src/test/fixtures/gradleOwnedCwcHb2ReaderPort.mjs','src/test/fixtures/gradleOwnedCwcHb2Approval.json',...Object.keys(old.sourceBindings)])await bind(p);
const files={core:'src/test/fixtures/gradleOwnedCwcHb2Core.mjs',port:'src/test/fixtures/gradleOwnedCwcHb2ReaderPort.mjs',cell:'src/test/fixtures/gradleOwnedCwcHb1ScalarReader.mjs',admission:'src/test/fixtures/gradleOwnedCwcHb2Admission.mjs'},artifacts={};for(const [k,p]of Object.entries(files))artifacts[k]=sha(await readFile(p));artifacts.diagnostic=sha(instrumentHb2(await readFile(files.core,'utf8')));
const approval=JSON.parse(await readFile('src/test/fixtures/gradleOwnedCwcHb2Approval.json'));for(const k of Object.keys(files))if(artifacts[k]!==approval[k])throw Error('hb2_fixture_pin_'+k);
const inventory=await hb2Inventory();validateHb2Inventory(inventory);
const design=JSON.parse(await readFile('docs/validation/gradle-cwc-r1hb-design-2026-11-13.json')),partial=new Set(['HBC01','HBC02','HBC03','HBC05','HBC08','HBC09','HBC10','HBC11','HBC12','HBC13','HBC15','HBC16','HBC17','HBC19','HBC21','HBC22','HBC23','HBC24','HBC25','HBC26','HBC27','HBC28','HBC31','HBC34','HBC35','HBC40']);
const coverage=design.conditions.map(c=>({id:c.id,condition:c.condition,status:partial.has(c.id)?'limited-fixture':'planned',fullContractExecuted:false}));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath)),caseFlags:['--experimental-vm-modules'],nodeOptions:'',nodePath:''};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-hb2-'));
async function run(test,env,count,prefix,duplicates){const report=resolve(dir,prefix+'.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:16777216,env:{...process.env,...env}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('hb2_tests '+failures+' '+String(e.stderr??''),{cause:e});}const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort(),expected=Array.from({length:count/duplicates},(_,i)=>Array(duplicates).fill(String(i+1).padStart(2,'0'))).flat().sort();if(!t.success||t.numPassedTests!==count||t.numFailedTests!==0||canonical(ids)!==canonical(expected))throw Error('hb2_test_ids');}
try{
 const output=resolve(dir,'evidence.json');await run(runtimeTest,{CWC_HB2_EVIDENCE_PATH:output},48,'HB2T',2);const evidence=JSON.parse(await readFile(output)),summary=validateHb2Evidence(evidence,artifacts);if(canonical(evidence.runtime)!==canonical(runtime))throw Error('hb2_execution_runtime');
 const record={schema:'cwc.hb2-quota.record.v1',date:'2026-11-14',status:'limited-entry-epoch-quota',document,baseline,sourceBindings,runtime,artifacts,inventory,inventoryDigest:hb2Hash(inventory),conditions,coverage,evidence,evidenceDigest:hb2Hash(evidence),summary,runtimeTestsPassed:48,recordTestsPassed:12,performanceMeasured:false};
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));compareHb2Replay(saved.evidence,evidence,artifacts);if(canonical(saved)!==canonical(record))throw Error('hb2_saved_record');}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await run(recordTest,{CWC_HB2_RECORD_PATH:candidate},12,'HB2R',1);
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('hb2_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({...summary,runtimeTests:48,recordTests:12,sources:Object.keys(sourceBindings).length}));
}finally{await rm(dir,{recursive:true,force:true});}
