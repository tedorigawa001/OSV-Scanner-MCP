/** HB-1 finite source/role fixture replay; never issues deployment/charge/adoption certificates. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {hb1Hash,validateHb1Evidence,compareHb1Replay} from '../src/test/fixtures/gradleOwnedCwcHb1Validation.mjs';
import {instrumentHb1} from '../src/test/fixtures/gradleOwnedCwcHb1Observer.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-hb1-2026-11-14.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.154 HB-1：core／診断artifact・reader role境界の限定実装'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const conditions=[...section.matchAll(/^\| (HB1C\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],scope:'limited-artifact-role-fixture',executed:true,fullContractExecuted:false}));
if(canonical(conditions.map(x=>x.id))!==canonical(Array.from({length:20},(_,i)=>'HB1C'+String(i+1).padStart(2,'0'))))throw Error('hb1_conditions');
const baseline={path:'docs/validation/gradle-cwc-r1s-2026-11-14.json'},b=await readFile(baseline.path),old=JSON.parse(b);baseline.sha256=sha(b);
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('hb1_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const runtimeTest='src/test/utils/gradleOwnedCwcHb1.test.ts',recordTest='src/test/utils/gradleOwnedCwcHb1Record.test.ts';
for(const p of [runtimeTest,recordTest,'scripts/check-cwc-hb1.mjs','scripts/run-cwc-hb1.mjs','src/test/fixtures/gradleOwnedCwcHb1Validation.d.mts','src/test/fixtures/gradleOwnedCwcHb1Core.mjs','src/test/fixtures/gradleOwnedCwcHb1ReaderPort.mjs','src/test/fixtures/gradleOwnedCwcHb1ScalarReader.mjs','src/test/fixtures/gradleOwnedCwcHb1Approval.json',...Object.keys(old.sourceBindings)])await bind(p);
const corePath='src/test/fixtures/gradleOwnedCwcHb1Core.mjs',core=await readFile(corePath,'utf8'),portPath='src/test/fixtures/gradleOwnedCwcHb1ReaderPort.mjs',cellPath='src/test/fixtures/gradleOwnedCwcHb1ScalarReader.mjs';
const approval=JSON.parse(await readFile('src/test/fixtures/gradleOwnedCwcHb1Approval.json'));
const artifacts={core:sha(core),port:sha(await readFile(portPath)),cell:sha(await readFile(cellPath)),diagnostic:sha(instrumentHb1(core))};for(const k of ['core','port','cell'])if(artifacts[k]!==approval[k])throw Error('hb1_fixture_pin_'+k);
const sourceAudit=[];for(const [p,id,first,last]of [[corePath,'candidate-reader','const api=create(null);','export const reader=freeze(api);'],[corePath,'entry-guard','function run(','try{if(!completion)live(r);'],[corePath,'final-publication-fence',"if(op==='publish')","if(op==='closeWindow')"],[corePath,'lookup-zero-drain',"if(op==='reclaim')",'throw NativeError(\'hb1_operation\')'],[cellPath,'readonly-capture','function view(cell)','export function makeHb1CurrentReader'],[portPath,'sealed-port','const portValue=','export const port=Object.freeze(portValue);'],['src/test/fixtures/gradleOwnedCwcHb1Bootstrap.mjs','fixed-linker','async function linker','await core.link(linker)'],['src/test/fixtures/gradleOwnedCwcHb1Bootstrap.mjs','approved-helper-before-evaluation','const accepted=verifyHb1Candidate()','const readCurrent='],['src/test/fixtures/gradleOwnedCwcHb1Observer.mjs','separate-instrumentation','const epilogue=','export function instrumentHb1']]){const s=await readFile(p,'utf8'),start=s.indexOf(first),end=s.indexOf(last,start);if(start<0||end<start)throw Error('hb1_source_anchor_'+id);sourceAudit.push({id,path:p,first,last,startLine:s.slice(0,start).split('\n').length,sha256:sha(s.slice(start,end+last.length))});}
const design=JSON.parse(await readFile('docs/validation/gradle-cwc-r1hb-design-2026-11-13.json')),partial=new Set(['HBC01','HBC02','HBC03','HBC05','HBC07','HBC08','HBC09','HBC10','HBC11','HBC35']);
const coverage=design.conditions.map(c=>({id:c.id,condition:c.condition,status:partial.has(c.id)?'limited-fixture':'planned',fullContractExecuted:false}));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath)),flags:['--experimental-vm-modules'],nodeOptions:'',nodePath:''};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-hb1-'));
async function run(test,env,count,prefix,duplicates){const report=resolve(dir,prefix+'.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('hb1_tests '+failures+' '+String(e.stderr??''),{cause:e});}const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort(),expected=Array.from({length:count/duplicates},(_,i)=>Array(duplicates).fill(String(i+1).padStart(2,'0'))).flat().sort();if(!t.success||t.numPassedTests!==count||t.numFailedTests!==0||canonical(ids)!==canonical(expected))throw Error('hb1_test_ids');}
try{
 const output=resolve(dir,'evidence.json');await run(runtimeTest,{CWC_HB1_EVIDENCE_PATH:output},40,'HB1T',2);const evidence=JSON.parse(await readFile(output)),summary=validateHb1Evidence(evidence,artifacts);if(canonical(evidence.runtime)!==canonical(runtime))throw Error('hb1_execution_runtime');
 const record={schema:'cwc.hb1.record.v1',date:'2026-11-14',status:'limited-artifact-role-fixture',document,baseline,sourceBindings,runtime,artifacts,sourceAudit,conditions,coverage,evidence,evidenceDigest:hb1Hash(evidence),summary,runtimeTestsPassed:40,recordTestsPassed:10,performanceMeasured:false};
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));compareHb1Replay(saved.evidence,evidence,artifacts);if(canonical(saved)!==canonical(record))throw Error('hb1_saved_record');}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await run(recordTest,{CWC_HB1_RECORD_PATH:candidate},10,'HB1R',1);
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('hb1_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({...summary,runtimeTests:40,recordTests:10,sources:Object.keys(sourceBindings).length}));
}finally{await rm(dir,{recursive:true,force:true});}
