/** Reproduce read-only backend / native IPC evidence; never downloads or runs verification tools. */
import {readFile,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir,release} from 'node:os';
import {pathToFileURL} from 'node:url';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function image(p){const h=createHash('sha256');for await(const b of createReadStream(p,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
const out='docs/validation/gradle-e2-p0-runner-2026-11-14.json';
const tests=['src/test/utils/gradleOwnedP0Runner.test.ts','src/test/utils/gradleOwnedP0RunnerNative.test.ts','src/test/utils/gradleOwnedP0RunnerRecord.test.ts'];
const basePath='docs/validation/gradle-e2-p0-contract-2026-11-14.json',commit='59d5447';
execFileSync('git',['merge-base','--is-ancestor',commit,'HEAD']);
const committed=execFileSync('git',['show',commit+':'+basePath]),before=JSON.parse(committed),base=await readFile(basePath),old=JSON.parse(base);
const beforeWithoutDoc=structuredClone(before),oldWithoutDoc=structuredClone(old);delete beforeWithoutDoc.document.sha256;delete oldWithoutDoc.document.sha256;
if(canonical(beforeWithoutDoc)!==canonical(oldWithoutDoc))throw Error('p0_runner_baseline_changed_outside_doc_digest');
const heading='### 9.160 E2-P0：取得lock・承認envelope・preflightの静的contract';
const originalSection=designSection(execFileSync('git',['show',commit+':'+before.document.path],{encoding:'utf8',maxBuffer:16777216}),heading);
const doc=await readFile(before.document.path,'utf8'),corrected=designSection(doc,heading);
const oldText='でsource・本節・保存した全test名／件数を再照合し152件を再実行する。',newText='でsource・本節・保存した全test名／件数を再照合し193件（現行：metadata187＋記録6）を再実行する。';
// Allowed §9.160 corrections only: the current-count wording and removal of the local command prefix from operator commands.
const corrections=[[oldText,newText],['`bdo node scripts/check-e2-p0-contract.mjs`','`node scripts/check-e2-p0-contract.mjs`'],['`bdo node scripts/check-e2-p0-contract.mjs --check`','`node scripts/check-e2-p0-contract.mjs --check`']];
if(corrections.some(([a])=>originalSection.split(a).length!==2)||corrected!==corrections.reduce((s,[a,b])=>s.replace(a,()=>b),originalSection)||corrected.includes('bdo ')||sha(corrected)!==old.document.sha256)throw Error('p0_runner_document_correction');
const baseline={path:basePath,commit,committedSha256:sha(committed),sha256:sha(base),allowedChanges:['document.sha256'],documentCorrections:['current-count','operator-command-prefix'],oldCount:152,requestedHistoricalCount:178,currentCount:193};
const document={path:before.document.path,heading:'### 9.161 E2-P0：取得metadata・preflight runnerと独立backend接続'};document.sha256=sha(designSection(doc,document.heading));
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const bytes=await readFile(p),h=sha(bytes);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('p0_runner_inherited_source_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of bytes.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}
}
for(const p of [...Object.keys(old.sourceBindings),...tests,'scripts/check-e2-p0-runner.mjs','src/cli/e2P0Preflight.ts','src/test/fixtures/gradleOwnedP0CliFault.mjs','tsconfig.json','tsconfig.build.json','node_modules/typescript/package.json','node_modules/typescript/bin/tsc','node_modules/typescript/lib/tsc.js','node_modules/typescript/lib/getExePath.js'])await bind(p);
const compilerPath=(await import(pathToFileURL(resolve('node_modules/typescript/lib/getExePath.js')).href)).default();
const runtime={node:process.version,platform:process.platform,arch:process.arch,osRelease:release(),nodeBinaryDigest:await image(process.execPath),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
const compiler={version:JSON.parse(await readFile('node_modules/typescript/package.json')).version,imagePath:relative(process.cwd(),compilerPath),imageDigest:await image(compilerPath),purpose:'local-cli-build-not-CBMC-or-Clang-proof'};
const dir=await mkdtemp(resolve(tmpdir(),'e2-p0-runner-record-'));
try{
 const build=resolve(dir,'build');execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json','--outDir',build],{stdio:'pipe',timeout:120000,maxBuffer:8388608});
 await writeFile(resolve(build,'package.json'),'{"type":"module"}');await symlink(resolve('node_modules'),resolve(build,'node_modules'),'dir');
 const artifacts={};for(const p of ['cli/e2P0Preflight.js','utils/gradleOwnedP0Runner.js','utils/gradleOwnedP0Backend.js','utils/gradleOwnedP0Socket.js','utils/gradleOwnedP0Contract.js','utils/gradleOwnedJson.js'])artifacts[p]=sha(await readFile(resolve(build,p)));
 const native=spawnSync(process.execPath,[resolve(build,'cli/e2P0Preflight.js')],{encoding:'utf8',timeout:10000,maxBuffer:65536});
 if(native.error||native.status!==2||native.stderr!=='')throw Error('p0_runner_cli_diagnostic');const diagnostic=JSON.parse(native.stdout);
 const scope={metadataAcquisition:true,mutuallySignedProtocol:true,nativeUnixIPC:true,separateCliProcess:true,syntheticAuthorities:true,sameUID:true,
  independentlyDeployedBackend:false,actualToolsAcquired:false,toolImageBuilt:false,proofExecuted:false,workspaceEnforced:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0};
 const fixed={schema:'cwc.e2-p0.runner-record.v1',date:'2026-11-14',status:'backend-metadata-only-unsupported',baseline,document,sourceBindings,runtime,compiler,artifacts,
  unconfiguredCLI:{exitCode:native.status,stdoutSha256:sha(native.stdout),result:diagnostic},scope,
  protocol:{apis:['ReadPins','ReadAcquisition','ReadPreflight','ReadLive'],maxCalls:8,totalWireLimit:8388608,frameLimit:1048576,originalClientDeadlineMs:5000,jobPermitIssued:false},
  observations:{restrictedNativeAttempt:{passed:3,failed:5,reason:'listen-EPERM'},authorizedNative:{passed:29,failed:0},
   preLookupRevocationRegression:{group:'P0B09',beforeFailed:1,afterPassed:1},cliAliasRegression:{group:'P0N08',beforeFailed:1,afterPassed:1},
   reviewRegressions:{finalGuard:{group:'P0B32',beforeFailed:4,afterPassed:4,afterResultFormatting:true,afterSynchronousCleanup:true,originalDeadlinePreserved:true},
    operatorFile:{groups:['P0N10','P0N11'],beforeFailed:10,beforePassed:6,afterPassed:16,roles:['config','key'],
     required:['regular-file','nonblocking-no-follow-open','pre-open-and-FD-identity','pre-read-and-post-read-path-identity','nanosecond-freshness','secret-zero-on-refusal']},
    nativeFinalGuard:{groups:['P0N09','P0N12'],passed:4,realUnixSocket:true,separateCliProcess:true},
    faultArtifact:'src/test/fixtures/gradleOwnedP0CliFault.mjs',faultsEnabledInProduction:false},
   actualState:old.expectations.actualState,missing:old.expectations.missing}};
 let record={...fixed,verification:null};if(process.argv.includes('--check')){record=JSON.parse(await readFile(out));if(canonical(Object.keys(record).sort())!==canonical([...Object.keys(fixed),'verification'].sort()))throw Error('p0_runner_record_keys');for(const k of Object.keys(fixed))if(canonical(record[k])!==canonical(fixed[k]))throw Error('p0_runner_saved_'+k);}
 const candidate=resolve(dir,'record.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...tests,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,E2_P0_RUNNER_RECORD:candidate}});}
 catch(e){let failed=[];try{failed=JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages})));}catch{}throw Error('p0_runner_tests '+JSON.stringify(failed)+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),names=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName)).sort(),groups=[...new Set(names.map(n=>n.match(/^P0[BNV]\d{2}/)?.[0]))].sort();
 const expected=[...Array.from({length:32},(_,i)=>'P0B'+String(i+1).padStart(2,'0')),...Array.from({length:12},(_,i)=>'P0N'+String(i+1).padStart(2,'0')),...Array.from({length:6},(_,i)=>'P0V'+String(i+1).padStart(2,'0'))].sort();
 if(!t.success||t.numPassedTests!==90||t.numFailedTests!==0||canonical(groups)!==canonical(expected)||new Set(names).size!==names.length)throw Error('p0_runner_test_closure');
 const verification={passed:t.numPassedTests,failed:t.numFailedTests,success:t.success,names,groups};if(process.argv.includes('--check')&&canonical(record.verification)!==canonical(verification))throw Error('p0_runner_saved_verification');record.verification=verification;
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('p0_runner_source_changed_'+p);
 if(await image(compilerPath)!==compiler.imageDigest)throw Error('p0_runner_compiler_changed');
 if(!process.argv.includes('--check'))await writeFile(out,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,passed:t.numPassedTests,failed:t.numFailedTests,sources:Object.keys(sourceBindings).length,unconfiguredCliExit:native.status,...scope}));
}finally{await rm(dir,{recursive:true,force:true});}
