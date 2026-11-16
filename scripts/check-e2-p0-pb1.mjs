/** Reproduce PB1 local-disk durability and native SIGKILL cases. Never grants runtime/tool admission. */
import {readFile,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve,dirname,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(import.meta.url);
async function image(p){const h=createHash('sha256');for await(const b of createReadStream(p,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
if(process.argv.slice(2).some(a=>a!=='--check')||process.argv.slice(2).length>1)throw Error('pb1_arguments');
const checking=process.argv.includes('--check'),out='docs/validation/gradle-e2-p0-pb1-2026-11-16.json',basePath='docs/validation/gradle-e2-p0-pb0-2026-11-15.json',commit='486af1e';
execFileSync('git',['merge-base','--is-ancestor',commit,'HEAD']);
const base=await readFile(basePath),old=JSON.parse(base),committed=execFileSync('git',['show',commit+':'+basePath],{maxBuffer:16777216});
if(!base.equals(committed)||Object.keys(old.sourceBindings).length!==380)throw Error('pb1_baseline_changed');
const baseline={path:basePath,commit,sha256:sha(base)},document={path:old.document.path,heading:'### 9.164 E2-P0 PB1：認証journal・anchor port・durable escape'};
const doc=await readFile(document.path,'utf8');document.sha256=sha(designSection(doc,document.heading));
if(sha(designSection(doc,old.document.heading))!==old.document.sha256)throw Error('pb1_historical_section_changed');
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('pb1_inherited_source_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedP1Durable.test.ts',recordTest='src/test/utils/gradleOwnedP1Record.test.ts';
for(const p of [...Object.keys(old.sourceBindings),test,recordTest,'scripts/check-e2-p0-pb1.mjs','vitest.config.ts'])await bind(p);
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:await image(process.execPath),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
const compilerPath=(await import(pathToFileURL(resolve('node_modules/typescript/lib/getExePath.js')).href)).default(),compiler={version:JSON.parse(await readFile('node_modules/typescript/package.json')).version,imagePath:relative(process.cwd(),compilerPath),imageDigest:await image(compilerPath),purpose:'local-TypeScript-build-not-verification-tool'};
require('koffi');const native=process.report.getReport().sharedObjects.filter(p=>p.includes('koffi')&&p.endsWith('.node'));if(native.length!==1)throw Error('pb1_native_image');
const nativeImage={path:relative(process.cwd(),native[0]),sha256:await image(native[0]),purpose:'local-openat-flock-fsync-adapter-not-isolation-proof'};
const dependencyEntryPins=[];for(const name of ['zod','jsonc-parser','vitest','koffi']){const packagePath='node_modules/'+name+'/package.json',p=await readFile(packagePath),entryPath=relative(process.cwd(),['koffi','jsonc-parser'].includes(name)?require.resolve(name):fileURLToPath(import.meta.resolve(name)));dependencyEntryPins.push({name,version:JSON.parse(p).version,packagePath,packageDigest:sha(p),entryPath,entryDigest:await image(entryPath)});}
const dir=await mkdtemp(resolve(tmpdir(),'pb1-reproduction-'));
try{
 const build=resolve(dir,'build');execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json','--outDir',build],{stdio:'pipe',timeout:120000,maxBuffer:8388608});await writeFile(resolve(build,'package.json'),'{"type":"module"}');await symlink(resolve('node_modules'),resolve(build,'node_modules'),'dir');
 const c=await import(pathToFileURL(resolve(build,'utils/gradleOwnedP1Contract.js')).href),artifacts={};
 for(const n of ['gradleOwnedP1Contract','gradleOwnedP1Store','gradleOwnedStoreDisk','gradleOwnedStoreFs','gradleOwnedStoreJournal','gradleOwnedStoreCheckpoint'])artifacts[n+'.js']=sha(await readFile(resolve(build,'utils',n+'.js')));
 const scope={localDisk:true,authenticatedJournal:true,localCheckpoint:true,externalAnchorPort:true,anchorAdapter:'test-only-same-UID-disk',realSIGKILL:true,nativeKillBoundaries:4,strictStageReplay:true,separateDurableEscape:true,originTombstone:true,fixedClock:true,currentAuthorizer:'trusted-fixture-port',independentAnchorVerified:false,OSIsolationVerified:false,realParentReservation:false,physicalMemoryUpper:null,workUpper:null,fullEpochRecovery:false,v2IPCConnected:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0};
 const reviewRegressions={groups:['PBD30','PBD31','PBD32'],caseCounts:{PBD30:2,PBD31:4,PBD32:1},before:{passed:1,failed:6},after:{passed:7,failed:0},fixes:['audit-stream-binding-before-history-and-file-read','reentry-guard-before-commit-and-audit-parsing'],auditMismatch:{historyReads:0,fileReads:0,anchorCalls:0},caughtMalformedReentry:{outerACK:0,blocked:true,durableEffectsRetained:true},idleMalformedInputRemainsNonfatal:true,scope:'same-UID-real-disk-and-trusted-callback-fixture'};
 const fixed={schema:'cwc.e2-p0.pb1-validation.v1',date:'2026-11-16',status:'PB1-local-disk-only-unsupported',baseline,document,sourceBindings,runtime,compiler,nativeImage,dependencyEntryPins,artifacts,profileDigest:c.PB1_PROFILE,limits:c.PB1_LIMITS,scope,actualState:old.actualState,conditions:old.conditions,reviewRegressions};
 let record={...fixed,verification:null,recordVerification:null};
 if(checking){record=JSON.parse(await readFile(out));if(canonical(Object.keys(record).sort())!==canonical([...Object.keys(fixed),'verification','recordVerification'].sort()))throw Error('pb1_record_keys');for(const k of Object.keys(fixed))if(canonical(fixed[k])!==canonical(record[k]))throw Error('pb1_saved_'+k);}
 const report=resolve(dir,'tests.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:240000,maxBuffer:8388608});}catch(e){throw Error('pb1_disk_tests '+String(e.stderr??e),{cause:e});}
 const t=JSON.parse(await readFile(report)),names=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName)).sort(),groups=[...new Set(names.map(n=>n.match(/^PBD\d{2}/)?.[0]))].sort();
 if(!t.success||t.numPassedTests!==59||t.numFailedTests||t.numPendingTests||new Set(names).size!==59||canonical(groups)!==canonical(Array.from({length:32},(_,i)=>'PBD'+String(i+1).padStart(2,'0'))))throw Error('pb1_test_closure');
 for(const [group,count]of Object.entries(reviewRegressions.caseCounts))if(names.filter(n=>n.startsWith(group+' ')).length!==count)throw Error('pb1_review_case_closure_'+group);
 const verification={kind:'real-disk-and-native-process-faults',passed:t.numPassedTests,failed:t.numFailedTests,skipped:t.numPendingTests,names,groups,nativeSIGKILLCaseNames:names.filter(n=>n.startsWith('PBD20 ')),fullEBRuntimeConditionsCompleted:0};
 if(verification.nativeSIGKILLCaseNames.length!==4)throw Error('pb1_native_closure');if(checking&&canonical(record.verification)!==canonical(verification))throw Error('pb1_saved_verification');record.verification=verification;
 const candidate=resolve(dir,'record.json'),rr=resolve(dir,'record-tests.json');await writeFile(candidate,JSON.stringify(record));
 execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',recordTest,'--maxWorkers=1','--reporter=json','--outputFile='+rr],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,PB1_RECORD:candidate}});
 const rt=JSON.parse(await readFile(rr)),rn=rt.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName)).sort(),rv={passed:rt.numPassedTests,failed:rt.numFailedTests,names:rn};
 if(!rt.success||rt.numPassedTests!==6||rt.numFailedTests||rt.numPendingTests||new Set(rn).size!==6)throw Error('pb1_record_test_closure');
 if(checking&&canonical(record.recordVerification)!==canonical(rv))throw Error('pb1_saved_record_verification');record.recordVerification=rv;
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('pb1_source_changed_'+p);
 for(const e of dependencyEntryPins)if(sha(await readFile(e.packagePath))!==e.packageDigest||await image(e.entryPath)!==e.entryDigest)throw Error('pb1_dependency_changed');
 if(sha(designSection(await readFile(document.path,'utf8'),document.heading))!==document.sha256||sha(await readFile(basePath))!==baseline.sha256||await image(process.execPath)!==runtime.nodeBinaryDigest||await image(compilerPath)!==compiler.imageDigest||await image(native[0])!==nativeImage.sha256)throw Error('pb1_evidence_changed');
 if(!checking)await writeFile(out,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,diskTests:verification.passed,recordTests:rv.passed,nativeSIGKILL:4,sources:Object.keys(sourceBindings).length,scope}));
}finally{await rm(dir,{recursive:true,force:true});}
