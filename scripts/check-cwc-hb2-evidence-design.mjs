/** Design/doc route checks only. Does not collect native evidence, verify signatures or grant admission. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {HB2E_CONTRACT,HB2E_COMMON,HB2E_REGIONS,HB2E_REFERENCES,hb2EvidenceRoute} from '../src/test/fixtures/gradleOwnedCwcHb2EvidenceDesign.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-hb2-evidence-design-2026-11-14.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.156 HB-2：18領域の独立charge・単位対応・寿命証拠契約（設計）'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const extract=p=>[...section.matchAll(new RegExp('^\\| ('+p+') \\| (.+) \\|$','gm'))].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
const conditions=extract('HBEC\\d{2}'),steps=extract('ED-[1-4]');if(canonical(conditions.map(c=>c.id))!==canonical(Array.from({length:48},(_,i)=>'HBEC'+String(i+1).padStart(2,'0')))||canonical(steps.map(c=>c.id))!==canonical(['ED-1','ED-2','ED-3','ED-4']))throw Error('hb2e_conditions');
const baseline={path:'docs/validation/gradle-cwc-hb2-quota-2026-11-14.json'},b=await readFile(baseline.path),old=JSON.parse(b);baseline.sha256=sha(b);
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('hb2e_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcHb2EvidenceDesign.test.ts';for(const p of [test,'scripts/check-cwc-hb2-evidence-design.mjs','src/test/fixtures/gradleOwnedCwcHb2EvidenceDesign.d.mts',...Object.keys(old.sourceBindings)])await bind(p);
const examples=[];for(const region of HB2E_REGIONS)for(const method of ['source-inventory','memory-metrics','heap-snapshot','engine-proof','bounded-recipe','capacity-domain']){const input={region:region.id,sourceUnit:'payload-byte',targetUnit:'logical-byte',method,action:'charge',event:'none'};examples.push({input,result:hb2EvidenceRoute(input)});}
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const record={schema:'cwc.hb2-evidence.design-record.v1',date:'2026-11-14',status:'design-only',document,baseline,baselineScope:old.summary,sourceBindings,runtime,contract:HB2E_CONTRACT,common:HB2E_COMMON,regions:HB2E_REGIONS,references:HB2E_REFERENCES,examples,conditions,steps,designChecksPassed:32,runtimeRegressionsExecuted:false,collectorExecuted:false,chargeCertificateVerified:false};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-hb2e-design-'));
try{
 if(process.argv.includes('--check')&&canonical(JSON.parse(await readFile(path)))!==canonical(record))throw Error('hb2e_saved_record');
 const candidate=resolve(dir,'candidate.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_HB2E_DESIGN_RECORD_PATH:candidate}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('hb2e_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^HBED(\d{2}):/)?.[1])).sort();if(!t.success||t.numPassedTests!==32||t.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:32},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('hb2e_test_ids');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('hb2e_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:'design-only',regions:18,designChecks:32,plannedRuntimeConditions:48,acquisitionSteps:4,routeExamples:108,sources:Object.keys(sourceBindings).length,collectorExecuted:false,chargeCertificateVerified:false,runtimeAdmitted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
