/** E2-P0 design/diagnostic record only: no downloads, installations, builds, proof execution or permits. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir,release} from 'node:os';
import {P0_PLAN,P0_CONDITIONS} from '../src/test/fixtures/gradleOwnedCwcHb2P0Design.mjs';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');async function imageHash(path){const h=createHash('sha256');for await(const b of createReadStream(path,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
/** Field paths (tool rows by name, at most 8) that differ between the saved and fresh observation; values are not echoed. */
function differences(saved,fresh,path,out){if(out.length>=8)return out;const obj=v=>v!==null&&typeof v==='object';if(obj(saved)&&obj(fresh)&&Array.isArray(saved)===Array.isArray(fresh)){for(const k of [...new Set([...Object.keys(saved),...Object.keys(fresh)])].sort()){const n=Array.isArray(saved)?(saved[k]?.name??fresh[k]?.name??k):k;differences(saved[k],fresh[k],path+'.'+n,out);}}else if(saved===undefined||fresh===undefined||canonical(saved)!==canonical(fresh))out.push(path);return out;}
const out='docs/validation/gradle-cwc-hb2-p0-design-2026-11-14.json',test='src/test/utils/gradleOwnedCwcHb2P0Design.test.ts';
const baseline={path:'docs/validation/gradle-cwc-hb2-ed2-design-2026-11-14.json'},base=await readFile(baseline.path),old=JSON.parse(base);baseline.sha256=sha(base);
const baselineCommit=execFileSync('git',['rev-parse',P0_PLAN.baselineCommit],{encoding:'utf8'}).trim();execFileSync('git',['merge-base','--is-ancestor',baselineCommit,'HEAD']);
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.159 HB-2 E2-P0：tool取得・image／設定・独立承認・検証workspace契約（設計）'};document.sha256=sha(designSection(await readFile(document.path,'utf8'),document.heading));
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('p0_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
for(const p of [...Object.keys(old.sourceBindings),test,'scripts/check-cwc-hb2-p0-design.mjs','src/test/fixtures/gradleOwnedCwcHb2P0Design.d.mts'])await bind(p);
const runtime={node:process.version,platform:process.platform,arch:process.arch,osRelease:release(),nodeBinaryDigest:await imageHash(process.execPath),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
const tools=[];for(const name of ['clang','cbmc','goto-cc','frama-c','z3','docker','podman','systemd-run','prlimit']){const c=spawnSync('/usr/bin/which',[name],{encoding:'utf8',timeout:2000,maxBuffer:8192});if(c.error||![0,1].includes(c.status))throw Error('p0_discovery');tools.push({name,path:c.status===0?c.stdout.trim():null,status:c.status,proofOrServiceExecuted:false});}
const clang=tools.find(t=>t.name==='clang');let compiler=null;if(clang.path){const c=spawnSync(clang.path,['--version'],{encoding:'utf8',timeout:5000,maxBuffer:16384});if(c.error||c.status!==0)throw Error('p0_clang_version');compiler={path:clang.path,version:c.stdout.split('\n')[0],target:c.stdout.split('\n').find(s=>s.startsWith('Target: ')),versionExitCode:c.status,launcherBinaryDigest:await imageHash(clang.path),executedDependencyClosure:null,approvedForProfile:false};}
const observation={platform:process.platform,arch:process.arch,tools,compiler,cgroupMemoryMaxPresent:existsSync('/sys/fs/cgroup/memory.max'),runtimeServicesInspected:false,proofExecuted:false,toolDownloadExecuted:false,sourcePinsMatched:true};
const references=[
 {url:'https://github.com/diffblue/cbmc/releases/tag/cbmc-6.8.0',role:'candidate-method-reference-not-provision-or-approval',consulted:'2026-11-14'},
 {url:'https://www.cprover.org/cbmc/',role:'candidate-method-reference-not-provision-or-approval',consulted:'2026-11-14'},
 {url:'https://github.com/llvm/llvm-project/releases/tag/llvmorg-21.1.8',role:'candidate-method-reference-not-provision-or-approval',consulted:'2026-11-14'},
 {url:'https://raw.githubusercontent.com/diffblue/cbmc/cbmc-6.8.0/src/util/config.cpp',role:'candidate-method-reference-not-provision-or-approval',consulted:'2026-11-14'},
 {url:'https://raw.githubusercontent.com/diffblue/cbmc/cbmc-6.8.0/src/cbmc/cbmc_parse_options.cpp',role:'candidate-method-reference-not-provision-or-approval',consulted:'2026-11-14'},
 {url:'https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html#memory-interface-files',role:'candidate-method-reference-not-provision-or-approval',consulted:'2026-11-14'}];
const fixed={schema:'cwc.hb2.e2-p0.design-record.v1',date:'2026-11-14',status:'design-only-unsupported',document,baseline,baselineCommit,sourceBindings,runtime,observation,plan:P0_PLAN,conditions:P0_CONDITIONS,reviewCases:P0_PLAN.reviewCases,references,readiness:{status:'unsupported',reasons:P0_PLAN.missing,independentEvidenceVerified:false,jobPermitIssued:false}};
let record={...fixed,verification:null};if(process.argv.includes('--check')){record=JSON.parse(await readFile(out));if(canonical(Object.keys(record).sort())!==canonical([...Object.keys(fixed),'verification'].sort()))throw Error('p0_saved_keys');for(const k of Object.keys(fixed))if(canonical(record[k])!==canonical(fixed[k])){const d=differences(record[k],fixed[k],k,[]);throw Error('p0_saved_'+k+' '+(d.length?d:[k]).join(','));}}
const dir=await mkdtemp(resolve(tmpdir(),'cwc-hb2-p0-design-'));
try{
 const candidate=resolve(dir,'record.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_HB2_P0_RECORD_PATH:candidate}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('p0_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^P0D\d{2}/)?.[0])).sort(),expected=Array.from({length:46},(_,i)=>'P0D'+String(i+1).padStart(2,'0'));if(!t.success||t.numPassedTests!==46||t.numFailedTests!==0||canonical(ids)!==canonical(expected))throw Error('p0_test_ids');
 const verification={success:t.success,passed:t.numPassedTests,failed:t.numFailedTests,ids};if(process.argv.includes('--check')&&canonical(record.verification)!==canonical(verification))throw Error('p0_saved_verification');record.verification=verification;
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('p0_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(out,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,designChecks:t.numPassedTests,plannedConditions:P0_CONDITIONS.length,plannedReviewCases:P0_PLAN.reviewCases.length,sources:Object.keys(sourceBindings).length,roles:P0_PLAN.authorities.length,missing:P0_PLAN.missing.map(x=>x.reason),proofExecuted:false,workspaceEnforced:false,jobPermitIssued:false,runtimeAdmitted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
