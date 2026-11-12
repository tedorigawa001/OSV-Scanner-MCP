/** Actual A/B consumer lower-bound diagnostic and replay. Never admits the proposed window profile. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {WINDOW_SITES,validateWindowEvidence,windowHash,windowCanonical,windowSourceLocations} from '../src/test/fixtures/gradleOwnedCwcLgWindowValidation.mjs';
const path='docs/validation/gradle-cwc-lg-window-2026-11-12.json',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.141 LG-M1：実A／B consumerのcommand参照追跡と3 slot拒否';
const baselinePath='docs/validation/gradle-cwc-lg-capacity-2026-11-12.json',baselineBytes=await readFile(baselinePath),baseline=JSON.parse(baselineBytes);
const sha=b=>createHash('sha256').update(b).digest('hex'),sourceBindings={},sources={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);sources[p]=b.toString();
 if(p in baseline.sourceBindings&&sourceBindings[p]!==baseline.sourceBindings[p])throw Error('window_old_source_changed_'+p);
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){
  if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
const test='src/test/utils/gradleOwnedCwcLgWindow.test.ts',recordTest='src/test/utils/gradleOwnedCwcLgWindowRecord.test.ts';
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcLgWindowValidation.d.mts','scripts/check-cwc-lg-window.mjs',
 'package-lock.json','tsconfig.json','vitest.config.ts','node_modules/zod/package.json','node_modules/zod/v4/core/parse.js',
 'node_modules/zod/v4/core/schemas.js','node_modules/zod/v4/classic/schemas.js','node_modules/vitest/package.json',...WINDOW_SITES.map(s=>s.path)])await bind(p);
const section=designSection(await readFile(document,'utf8'),heading),sourceLocations=windowSourceLocations(sources),dir=await mkdtemp(resolve(tmpdir(),'cwc-lg-window-'));
async function run(file,prefix,count,env={}){
 const report=resolve(dir,prefix+'.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{encoding:'utf8',stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{const r=JSON.parse(await readFile(report));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,failures:a.failureMessages}))));}catch{}throw Error('window_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const r=JSON.parse(await readFile(report)),ids=r.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();
 const first=prefix==='LMW'?1:21;
 if(!r.success||r.numPassedTests!==count||r.numFailedTests!==0||JSON.stringify(ids)!==JSON.stringify(Array.from({length:count},(_,i)=>String(first+i).padStart(2,'0'))))throw Error('window_test_ids');return count;
}
try{
 // Always execute the real consumer, including --check. Static replay alone cannot authenticate a width trace.
 const out=resolve(dir,'evidence.json'),testsPassed=await run(test,'LMW',6,{CWC_LG_WINDOW_EVIDENCE_PATH:out}),fresh=JSON.parse(await readFile(out));
 const summary=validateWindowEvidence(fresh,baseline);
 let r;if(process.argv.includes('--check'))r=JSON.parse(await readFile(path));else r={schema:'cwc-lg.window-validation.v1',date:'2026-11-12',document,heading,sectionDigest:sha(section),node:process.version,
  baseline:{path:baselinePath,sha256:sha(baselineBytes)},sourceBindings,sourceLocations,testsPassed,recordTestsPassed:10,evidence:fresh,evidenceDigest:windowHash(fresh),summary};
 if(r.schema!=='cwc-lg.window-validation.v1'||r.node!==process.version||r.document!==document||r.heading!==heading||r.sectionDigest!==sha(section)||
  r.baseline.path!==baselinePath||r.baseline.sha256!==sha(baselineBytes)||windowCanonical(r.sourceBindings)!==windowCanonical(sourceBindings)||windowCanonical(r.sourceLocations)!==windowCanonical(sourceLocations)||
  r.testsPassed!==6||r.recordTestsPassed!==10||r.evidenceDigest!==windowHash(r.evidence)||windowCanonical(r.summary)!==windowCanonical(validateWindowEvidence(r.evidence,baseline))||windowCanonical(r.summary)!==windowCanonical(summary))throw Error('window_record');
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));
 const recordTestsPassed=await run(recordTest,'LMR',10,{CWC_LG_WINDOW_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('window_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r)+'\n');console.log(JSON.stringify({tests:testsPassed,recordTests:recordTestsPassed,...summary}));
}finally{await rm(dir,{recursive:true,force:true});}
