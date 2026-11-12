/** Reproducible CCO-0 storage / managed-cell contract. This does not open the CCO-1 or LG-0 gate. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,relative,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {validateCo0Evidence,co0Hash,co0Canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const path='docs/validation/gradle-cwc-co0-2026-11-12.json',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.143 CCO-0a：所有storage・managed phaseの基礎fixture';
const baselinePath='docs/validation/gradle-cwc-lg-window-2026-11-12.json',baselineBytes=await readFile(baselinePath),baseline=JSON.parse(baselineBytes),sha=b=>createHash('sha256').update(b).digest('hex');
if(baseline.summary.observedDistinctCommandLowerBound!==4||baseline.summary.threeSlotBoundEstablished!==false||baseline.summary.lg0ExitEstablished!==false||baseline.evidenceDigest!==co0Hash(baseline.evidence))throw Error('co0_baseline');
const test='src/test/utils/gradleOwnedCwcCo0.test.ts',recordTest='src/test/utils/gradleOwnedCwcCo0Record.test.ts',sourceBindings={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);if(p in baseline.sourceBindings&&sourceBindings[p]!==baseline.sourceBindings[p])throw Error('co0_legacy_source_changed_'+p);
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcCo0Validation.d.mts','scripts/check-cwc-co0.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const text=await readFile(document,'utf8'),section=designSection(text,heading),design=designSection(text,'### 9.142 CWC-CO：command所有・expected比較のphase分割契約（設計のみ）');
const conditions=[...design.matchAll(/^\| (CCO\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
if(JSON.stringify(conditions.map(c=>c.id))!==JSON.stringify(Array.from({length:40},(_,i)=>'CCO'+String(i+1).padStart(2,'0'))))throw Error('co0_conditions');
const dir=await mkdtemp(resolve(tmpdir(),'cwc-co0-'));
async function run(file,prefix,count,env={}){const report=resolve(dir,prefix+'.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{encoding:'utf8',stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{const r=JSON.parse(await readFile(report));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('co0_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const r=JSON.parse(await readFile(report)),ids=r.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();
 if(!r.success||r.numPassedTests!==count||r.numFailedTests!==0||JSON.stringify(ids)!==JSON.stringify(Array.from({length:count},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('co0_test_ids');return count;
}
try{
 const output=resolve(dir,'evidence.json'),testsPassed=await run(test,'COF',20,{CWC_CO0_EVIDENCE_PATH:output}),evidence=JSON.parse(await readFile(output));
 const summary=validateCo0Evidence(evidence);let r;
 if(process.argv.includes('--check'))r=JSON.parse(await readFile(path));else r={schema:'cwc-co0.validation.v1',date:'2026-11-12',document,heading,node:process.version,sectionDigest:sha(section),designDigest:sha(design),sourceBindings,
  baseline:{path:baselinePath,sha256:sha(baselineBytes),observedDistinctCommandLowerBound:4,performanceEvidence:false},conditions,testsPassed,recordTestsPassed:8,evidence,evidenceDigest:co0Hash(evidence),summary};
 if(r.schema!=='cwc-co0.validation.v1'||r.document!==document||r.heading!==heading||r.node!==process.version||r.sectionDigest!==sha(section)||r.designDigest!==sha(design)||r.baseline.path!==baselinePath||r.baseline.sha256!==sha(baselineBytes)||r.baseline.observedDistinctCommandLowerBound!==4||r.baseline.performanceEvidence!==false||
  co0Canonical(r.sourceBindings)!==co0Canonical(sourceBindings)||co0Canonical(r.conditions)!==co0Canonical(conditions)||r.testsPassed!==20||r.recordTestsPassed!==8||r.evidenceDigest!==co0Hash(r.evidence)||co0Canonical(r.summary)!==co0Canonical(validateCo0Evidence(r.evidence))||co0Canonical(r.summary)!==co0Canonical(summary))throw Error('co0_record');
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));const recordTestsPassed=await run(recordTest,'COR',8,{CWC_CO0_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('co0_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r)+'\n');console.log(JSON.stringify({tests:testsPassed,recordTests:recordTestsPassed,...summary}));
}finally{await rm(dir,{recursive:true,force:true});}
