/** Reproducible static capacity audit and synthetic tickets; never changes the original admission gate. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {CAPACITY_LIFETIMES} from '../src/test/fixtures/gradleOwnedCwcLgCapacity.mjs';
import {validateCapacityEvidence,capacityLifetimeLocations,validateCapacityLifetimeLocations} from '../src/test/fixtures/gradleOwnedCwcLgCapacityValidation.mjs';
const path='docs/validation/gradle-cwc-lg-capacity-2026-11-12.json',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.140 LG-M0：最大contextの容量分解とcommand保持windowの候補契約';
const baselinePath='docs/validation/gradle-cwc-lg0-2026-11-12.json',baselineBytes=await readFile(baselinePath),baseline=JSON.parse(baselineBytes);
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
if(baseline.schema!=='cwc-lg0.validation.v2'||baseline.summary.lg0ExitEstablished!==false||sha(canonical(baseline.evidence))!==baseline.evidenceDigest)throw Error('capacity_baseline');
const test='src/test/utils/gradleOwnedCwcLgCapacity.test.ts',recordTest='src/test/utils/gradleOwnedCwcLgCapacityRecord.test.ts',sourceBindings={},sources={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);sources[p]=b.toString();if(p in baseline.sourceBindings&&baseline.sourceBindings[p]!==sourceBindings[p])throw Error('capacity_baseline_source_'+p);
 for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcLgCapacity.d.mts','src/test/fixtures/gradleOwnedCwcLgCapacityValidation.d.mts','scripts/check-cwc-lg-capacity.mjs','package-lock.json','tsconfig.json','vitest.config.ts',...CAPACITY_LIFETIMES.map(x=>x.source)])await bind(p);
const section=designSection(await readFile(document,'utf8'),heading),regressionConditions=[...section.matchAll(/^\| (CLM\d{2}) \| (.*) \|$/gm)].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
if(JSON.stringify(regressionConditions.map(x=>x.id))!==JSON.stringify(Array.from({length:20},(_,i)=>'CLM'+String(i+1).padStart(2,'0'))))throw Error('capacity_conditions');
const dir=await mkdtemp(resolve(tmpdir(),'cwc-lg-capacity-'));
async function run(file,prefix,count,env){const report=resolve(dir,prefix+'.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{encoding:'utf8',stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{const r=JSON.parse(await readFile(report,'utf8'));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(x=>x.status==='failed').map(x=>({name:x.fullName,messages:x.failureMessages}))));}catch{}throw Error('capacity_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const r=JSON.parse(await readFile(report,'utf8')),ids=r.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();
 if(!r.success||r.numPassedTests!==r.numTotalTests||r.numFailedTests!==0||JSON.stringify(ids)!==JSON.stringify(Array.from({length:count},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('capacity_test_ids');return r.numPassedTests;
}
try{
 let r;if(process.argv.includes('--check'))r=JSON.parse(await readFile(path,'utf8'));else{
  const out=resolve(dir,'evidence.json'),testsPassed=await run(test,'LGM',12,{CWC_LG_CAPACITY_EVIDENCE_PATH:out}),evidence=JSON.parse(await readFile(out,'utf8'));
  r={schema:'cwc-lg.capacity-validation.v1',date:'2026-11-12',document,heading,sectionDigest:sha(section),node:process.version,
   baseline:{path:baselinePath,sha256:sha(baselineBytes),evidenceDigest:baseline.evidenceDigest},sourceBindings,lifetimeLocations:capacityLifetimeLocations(sources),regressionConditions,
   testsPassed,recordTestsPassed:10,evidence,evidenceDigest:sha(canonical(evidence)),summary:validateCapacityEvidence(evidence,baseline)};
 }
 if(r.schema!=='cwc-lg.capacity-validation.v1'||r.document!==document||r.heading!==heading||r.node!==process.version||r.sectionDigest!==sha(section)||r.baseline.path!==baselinePath||r.baseline.sha256!==sha(baselineBytes)||r.baseline.evidenceDigest!==baseline.evidenceDigest||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.testsPassed!==12||r.recordTestsPassed!==10||JSON.stringify(r.regressionConditions)!==JSON.stringify(regressionConditions)||r.evidenceDigest!==sha(canonical(r.evidence))||JSON.stringify(r.summary)!==JSON.stringify(validateCapacityEvidence(r.evidence,baseline)))throw Error('capacity_record');
 validateCapacityLifetimeLocations(r.lifetimeLocations,sources);
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));const recordTestsPassed=await run(recordTest,'LMR',10,{CWC_LG_CAPACITY_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('capacity_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r)+'\n');console.log(JSON.stringify({tests:r.testsPassed,recordTests:recordTestsPassed,...r.summary}));
}finally{await rm(dir,{recursive:true,force:true});}
