/** ED-1 feasibility record generator/checker. Diagnostic facts are never accepted as independent charge evidence. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {release} from 'node:os';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {collectEd1,validateEd1Execution} from './run-cwc-hb2-ed1.mjs';
import {ED1_FLAGS,ED1_IDS,ED1_LIMITS,ED1_SCOPE,ed1Assessment,validateEd1Probes,validateEd1Assessment} from '../src/test/fixtures/gradleOwnedCwcHb2Ed1.mjs';
import {hb2Inventory} from '../src/test/fixtures/gradleOwnedCwcHb2Inventory.mjs';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),out='docs/validation/gradle-cwc-hb2-ed1-2026-11-14.json';
const baseline={path:'docs/validation/gradle-cwc-hb2-evidence-design-2026-11-14.json'},base=await readFile(baseline.path),old=JSON.parse(base);baseline.sha256=sha(base);
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.157 HB-2 ED-1：現行runtime・公開API・既存toolの証拠取得可能性'};document.sha256=sha(designSection(await readFile(document.path,'utf8'),document.heading));
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('ed1_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcHb2Ed1.test.ts';for(const p of [...Object.keys(old.sourceBindings),test,'scripts/check-cwc-hb2-ed1.mjs','scripts/run-cwc-hb2-ed1.mjs','scripts/run-cwc-hb2-ed1.d.mts','scripts/probe-cwc-hb2-ed1.mjs','src/test/fixtures/gradleOwnedCwcHb2Ed1.d.mts'])await bind(p);
const hash=createHash('sha256');for await(const b of createReadStream(process.execPath,{highWaterMark:65536}))hash.update(b);
const runtime={node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,osRelease:release(),linkedVersions:{...process.versions},nodeBinaryDigest:hash.digest('hex'),flags:[...ED1_FLAGS],nodeOptions:'',nodePath:''},approval=JSON.parse(await readFile('src/test/fixtures/gradleOwnedCwcHb2Approval.json'));
const inventory=await hb2Inventory(),fresh=await collectEd1(runtime,approval),references=[
 {url:'https://nodejs.org/api/process.html#processmemoryusage',consulted:'2026-11-14',role:'semantics-only-not-image-approval'},
 {url:'https://nodejs.org/api/v8.html',consulted:'2026-11-14',role:'semantics-only-not-image-approval'},
 {url:'https://nodejs.org/api/inspector.html',consulted:'2026-11-14',role:'semantics-only-not-image-approval'},
 {url:'https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory-interface-files',consulted:'2026-11-14',role:'semantics-only-not-image-approval'}];
const fixed={schema:'cwc.hb2.ed1.record.v1',date:'2026-11-14',status:'diagnostic-feasibility-only',document,baseline,sourceBindings,runtime,inventory,scope:ED1_SCOPE,collectionLimits:ED1_LIMITS,capacityPolicy:{status:'not-established',fullProcessBound:false,snapshotCreationPrecedesStreamCap:true,productionVerifier:false},documentationVersion:'v26.13.1',references,followingSteps:['ED-2','ED-3','ED-4']};
let record={...fixed,cases:fresh,regions:ed1Assessment(fresh.map(x=>x.probe),inventory,runtime,approval),verification:null};
const ids=Array.from({length:40},(_,i)=>'ED1T'+String(i+1).padStart(2,'0'));
if(process.argv.includes('--check')){record=JSON.parse(await readFile(out));for(const k of Object.keys(fixed))if(canonical(record[k])!==canonical(fixed[k]))throw Error('ed1_record_'+k);validateEd1Probes(record.cases.map(x=>x.probe),runtime,approval);for(const c of record.cases)validateEd1Execution(c.probe,c.execution);validateEd1Assessment(record.regions,record.cases.map(x=>x.probe),inventory,runtime,approval);if(!record.verification?.success||record.verification.passed!==40||record.verification.failed!==0||canonical(record.verification.ids)!==canonical(ids))throw Error('ed1_test_evidence');}
const dir=await mkdtemp(resolve(tmpdir(),'cwc-hb2-ed1-'));
try{
 const candidate=resolve(dir,'record.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_HB2_ED1_RECORD_PATH:candidate}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('ed1_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),found=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^ED1T\d{2}/)?.[0])).sort();if(!t.success||t.numPassedTests!==40||t.numFailedTests!==0||canonical(found)!==canonical(ids))throw Error('ed1_test_ids');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('ed1_source_changed_'+p);
 record.verification={success:t.success,passed:t.numPassedTests,failed:t.numFailedTests,ids:found};if(!process.argv.includes('--check'))await writeFile(out,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,regions:record.regions.length,sourceBindings:Object.keys(sourceBindings).length,regressions:t.numPassedTests,freshProbes:fresh.map(x=>x.probe.id),independentBounds:0,credit:0,productionAdopted:false,toolResults:fresh[4].probe.data.tools.map(t=>({name:t.name,available:!!t.path,executed:!!t.execution,success:t.execution?.status===0}))}));
}finally{await rm(dir,{recursive:true,force:true});}
