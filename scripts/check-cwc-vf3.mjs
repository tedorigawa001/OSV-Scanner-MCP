/** VF-3 real owned-clock comparison. Run alone with one Vitest worker. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir,platform,arch,cpus,release} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {validateVf3Measurement,vf3Table} from '../src/test/fixtures/gradleOwnedCwcVf3Validation.mjs';
const path='docs/validation/gradle-cwc-vf3-2026-11-11.json',test='src/test/utils/gradleOwnedCwcVf3.test.ts',benchmark='src/test/utils/gradleOwnedCwcVf3Benchmark.test.ts',recordTest='src/test/utils/gradleOwnedCwcVf3Record.test.ts',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.136 VF-3：実時間clockと4方式の共通比較';
const sha=b=>createHash('sha256').update(b).digest('hex'),sourceBindings={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,benchmark,recordTest,'src/test/fixtures/gradleOwnedCwcVf1Fixture.ts','src/test/utils/gradleOwnedCwcVf1.test.ts','src/test/utils/gradleOwnedCwcVf2.test.ts','src/test/fixtures/gradleOwnedCwcCCase.ts','src/test/fixtures/gradleOwnedCwcLb2Case.ts','src/test/fixtures/gradleOwnedCwcVf3Validation.d.mts','scripts/check-cwc-vf3.mjs','src/test/fixtures/gradleOwnedCgpS0Bound.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const dir=await mkdtemp(resolve(tmpdir(),'cwc-vf3-')),check=process.argv.includes('--check'),pendingPath=resolve(tmpdir(),'cwc-vf3-pending-'+sha(JSON.stringify(sourceBindings))+'.json');
async function run(file,env={}){const report=resolve(dir,'report.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--disableConsoleIntercept','--reporter=json','--outputFile='+report],{stdio:file===benchmark?'inherit':'pipe',timeout:1900000,maxBuffer:8388608,env:{...process.env,...env}});}catch(e){let failures='';try{const r=JSON.parse(await readFile(report,'utf8'));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({test:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('vf3_tests '+failures+' '+String(e.stdout??'')+' '+String(e.stderr??''),{cause:e});}const r=JSON.parse(await readFile(report,'utf8'));if(!r.success||r.numFailedTests||r.numPendingTests||!r.numPassedTests||r.numPassedTests!==r.numTotalTests)throw Error('vf3_test_count');return r.numPassedTests;}
try{
 let r;if(check)r=JSON.parse(await readFile(path,'utf8'));else{
  const testsPassed=await run(test),output=resolve(dir,'measurement.json');let measurement;
  if(process.argv.includes('--resume'))measurement=JSON.parse(await readFile(pendingPath,'utf8'));else{await run(benchmark,{CWC_VF3_EVIDENCE_PATH:output,CWC_VF3_RAW_PATH:pendingPath});measurement=JSON.parse(await readFile(output,'utf8'));await writeFile(pendingPath,JSON.stringify(measurement));}
  const summary=validateVf3Measurement(measurement,sourceBindings);measurement.summary=summary;
  const old=await readFile(document,'utf8');if(!old.includes('<!-- VF3-TABLE-BEGIN -->'))throw Error('vf3_table_marker');await writeFile(document,old.replace(/<!-- VF3-TABLE-BEGIN -->[\s\S]*?<!-- VF3-TABLE-END -->/,'<!-- VF3-TABLE-BEGIN -->\n'+vf3Table(summary)+'\n<!-- VF3-TABLE-END -->'));
  const oracles={};for(const n of ['vf0','vf1','vf2']){const p='docs/validation/gradle-cwc-'+n+'-2026-11-'+(n==='vf0'?'10':'11')+'.json',bytes=await readFile(p),prior=JSON.parse(bytes);for(const [p,h]of Object.entries(prior.sourceBindings))if(p in sourceBindings&&sourceBindings[p]!==h)throw Error('vf3_functional_source_'+p);oracles[n]={path:p,sha256:sha(bytes),tests:prior.testsPassed,recordTests:prior.recordTestsPassed};}
  r={schema:'cwc-vf3.validation.v2',date:'2026-11-11',document,heading,sectionDigest:sha(designSection(await readFile(document,'utf8'),heading)),sourceBindings,testsPassed,recordTestsPassed:null,environment:{node:process.version,vitest:JSON.parse(await readFile('node_modules/vitest/package.json','utf8')).version,platform:platform(),arch:arch(),release:release(),cpu:cpus()[0]?.model,processes:'one worker; same-process signed endpoints; owned monotonic clock; one RPC/channel'},oracles,measurement};
 }
 const doc=await readFile(document,'utf8');if(r.schema!=='cwc-vf3.validation.v2'||r.environment.node!==process.version||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.sectionDigest!==sha(designSection(doc,heading)))throw Error('vf3_record_binding');
 validateVf3Measurement(r.measurement,sourceBindings);if(!doc.includes(vf3Table(r.measurement.summary)))throw Error('vf3_table');
 for(const [n,o]of Object.entries(r.oracles)){if(sha(await readFile(o.path))!==o.sha256)throw Error('vf3_oracle_'+n);}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));const count=await run(recordTest,{CWC_VF3_RECORD_PATH:candidate});if(check&&count!==r.recordTestsPassed)throw Error('vf3_record_tests');r.recordTestsPassed=count;
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('vf3_source_changed');
 if(!check){await writeFile(path,JSON.stringify(r)+'\n');await rm(pendingPath,{force:true});}console.log(JSON.stringify({tests:r.testsPassed,recordTests:r.recordTestsPassed,...r.measurement.summary}));
}finally{await rm(dir,{recursive:true,force:true});}
