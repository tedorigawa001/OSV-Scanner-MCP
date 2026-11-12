/** Reproduce standalone LG-0 evidence. No performance run or provider/Session admission. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {validateLg0Evidence} from '../src/test/fixtures/gradleOwnedCwcLg0Validation.mjs';
const path='docs/validation/gradle-cwc-lg0-2026-11-12.json',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md';
const heading='### 9.139 LG-0：所有live入力のstandalone契約・状態機械・容量gateの限定実証';
const test='src/test/utils/gradleOwnedCwcLg0.test.ts',recordTest='src/test/utils/gradleOwnedCwcLg0Record.test.ts';
const sha=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);
 for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcLg0Validation.d.mts','src/test/fixtures/gradleOwnedCwcLg0Context.d.mts','scripts/check-cwc-lg0.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const dir=await mkdtemp(resolve(tmpdir(),'cwc-lg0-'));
async function run(file,prefix,count,env){
 const report=resolve(dir,prefix+'.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',encoding:'utf8',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{const r=JSON.parse(await readFile(report,'utf8'));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({test:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('lg0_test_execution '+failures+' '+String(e.stderr??''),{cause:e});}
 const digits=prefix==='LG'?3:2,result=JSON.parse(await readFile(report,'utf8')),names=result.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{'+digits+'}):'))?.[1])).sort();
 if(!result.success||result.numPassedTests!==result.numTotalTests||result.numFailedTests!==0||JSON.stringify(names)!==JSON.stringify(Array.from({length:count},(_,i)=>String(i+1).padStart(digits,'0'))))throw Error('lg0_test_cases');
 return result.numPassedTests;
}
try{
 let r;if(process.argv.includes('--check'))r=JSON.parse(await readFile(path,'utf8'));else{
  const out=resolve(dir,'evidence.json');const testsPassed=await run(test,'LG',30,{CWC_LG0_EVIDENCE_PATH:out});
  const raw=JSON.parse(await readFile(out,'utf8')),policy=raw.policy;delete raw.policy;
  const evidence=raw,summary=validateLg0Evidence(evidence,sourceBindings,policy);
  const designPath='docs/validation/gradle-cwc-lg-design-2026-11-12.json';
  r={schema:'cwc-lg0.validation.v2',date:'2026-11-12',document,heading,sectionDigest:sha(designSection(await readFile(document,'utf8'),heading)),
   node:process.version,policy,sourceBindings,designRecord:{path:designPath,sha256:sha(await readFile(designPath))},testsPassed,recordTestsPassed:14,
   evidence,evidenceDigest:sha(canonical(evidence)),summary};
 }
 const designPath='docs/validation/gradle-cwc-lg-design-2026-11-12.json';
 if(r.schema!=='cwc-lg0.validation.v2'||r.document!==document||r.heading!==heading||r.sectionDigest!==sha(designSection(await readFile(document,'utf8'),heading))||r.node!==process.version||r.designRecord.path!==designPath||r.designRecord.sha256!==sha(await readFile(designPath))||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.testsPassed!==30||r.recordTestsPassed!==14||r.evidenceDigest!==sha(canonical(r.evidence))||JSON.stringify(r.summary)!==JSON.stringify(validateLg0Evidence(r.evidence,sourceBindings,r.policy)))throw Error('lg0_record_bindings');
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));
 const recordTestsPassed=await run(recordTest,'LGR',14,{CWC_LG0_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('lg0_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r)+'\n');
 console.log(JSON.stringify({tests:r.testsPassed,recordTests:recordTestsPassed,...r.summary,scope:r.evidence.scope}));
}finally{await rm(dir,{recursive:true,force:true});}
