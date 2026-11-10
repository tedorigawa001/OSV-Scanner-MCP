/** Reproduce alone: one worker, real original deadlines, all failures retained. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir,platform,arch,cpus,release} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {lb3Table,LB3_APPROVAL_ROOTS} from '../src/test/fixtures/gradleOwnedCwcLb3Validation.mjs';
const path='docs/validation/gradle-cwc-lb3p-2026-11-10.json',test='src/test/utils/gradleOwnedCwcLb3p.test.ts',recordTest='src/test/utils/gradleOwnedCwcLb3pRecord.test.ts',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.131 CLB-3P：共通batch経路の検証・gate・計画・codec費用分解';
const sha=b=>createHash('sha256').update(b).digest('hex'),sourceBindings={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const x of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!x[1].startsWith('.'))continue;let next=resolve(dirname(p),x[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcLb3p.ts',...LB3_APPROVAL_ROOTS,'src/test/fixtures/gradleOwnedCwcLb3pValidation.d.mts','scripts/check-cwc-lb3p.mjs'])await bind(p);
const dir=await mkdtemp(resolve(tmpdir(),'cwc-lb3p-')),check=process.argv.includes('--check');
// Keep the resumable measurement outside the repository so an interrupted run cannot be committed by accident.
const pendingPath=resolve(tmpdir(),'cwc-lb3p-pending-'+sha(JSON.stringify(sourceBindings))+'.json');
async function run(file,count,env){const report=resolve(dir,file===test?'runtime.json':'record.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--disableConsoleIntercept','--reporter=json','--outputFile='+report],{stdio:file===test?'inherit':'pipe',timeout:1900000,maxBuffer:8388608,env:{...process.env,...env}});}catch(e){let failures='';try{const r=JSON.parse(await readFile(report,'utf8'));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({test:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('lb3_tests: '+failures+' '+String(e.stdout??'')+' '+String(e.stderr??''),{cause:e});}const r=JSON.parse(await readFile(report,'utf8'));if(!r.success||r.numPassedTests!==count||r.numTotalTests!==count)throw Error('lb3_test_count');}
try{
 let r;if(check)r=JSON.parse(await readFile(path,'utf8'));else{
  const evidence=resolve(dir,'measurement.json');console.log('CLB-3P: 216 trials including 54 warmups; original 4500 ms deadlines; one worker.');let measurement;if(process.argv.includes('--resume')){const pending=JSON.parse(await readFile(pendingPath,'utf8'));if(JSON.stringify(pending.sourceBindings)!==JSON.stringify(sourceBindings))throw Error('lb3_pending_sources');measurement=pending.measurement;}else{await run(test,18,{CWC_LB3P_EVIDENCE_PATH:evidence,CWC_LB3P_RAW_PATH:pendingPath+'.raw'});measurement=JSON.parse(await readFile(evidence,'utf8'));await writeFile(pendingPath,JSON.stringify({sourceBindings,measurement}));}
  const old=await readFile(document,'utf8'),table=lb3Table(measurement);if(!old.includes('<!-- CLB3P-TABLE-BEGIN -->')||!old.includes('<!-- CLB3P-TABLE-END -->'))throw Error('lb3_table_markers');
  await writeFile(document,old.replace(/<!-- CLB3P-TABLE-BEGIN -->[\s\S]*?<!-- CLB3P-TABLE-END -->/,'<!-- CLB3P-TABLE-BEGIN -->\n'+table+'\n<!-- CLB3P-TABLE-END -->'));
  r={schema:'cwc-lb3p.validation.v1',date:'2026-11-10',document,heading,sectionDigest:sha(designSection(await readFile(document,'utf8'),heading)),sourceBindings,testsPassed:18,recordTestsPassed:12,environment:{node:process.version,vitest:JSON.parse(await readFile('node_modules/vitest/package.json','utf8')).version,platform:platform(),arch:arch(),release:release(),cpu:cpus()[0]?.model,processes:'one Vitest worker; same-process signed endpoints; no external storage'},measurement};
 }
 const doc=await readFile(document,'utf8');if(r.schema!=='cwc-lb3p.validation.v1'||r.document!==document||r.heading!==heading||r.sectionDigest!==sha(designSection(doc,heading))||r.environment.node!==process.version||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.testsPassed!==18||r.recordTestsPassed!==12)throw Error('lb3_record_bindings');
 if(!doc.includes('<!-- CLB3P-TABLE-BEGIN -->\n'+lb3Table(r.measurement)+'\n<!-- CLB3P-TABLE-END -->'))throw Error('lb3_table');
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));await run(recordTest,12,{CWC_LB3P_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('lb3_source_changed');
 if(!check){await writeFile(path,JSON.stringify(r)+'\n');await rm(pendingPath,{force:true});await rm(pendingPath+'.raw',{force:true});}console.log(JSON.stringify({tests:r.testsPassed,recordTests:r.recordTestsPassed,...r.measurement.profileSummary}));
}finally{await rm(dir,{recursive:true,force:true});}
