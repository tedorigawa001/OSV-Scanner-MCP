/** Reproduce PB0 static contracts and real codec measurements. Never starts a backend or verification tool. */
import {readFile,writeFile,mkdtemp,rm,symlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),require=createRequire(import.meta.url);
async function image(p){const h=createHash('sha256');for await(const b of createReadStream(p,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
if(process.argv.slice(2).some(a=>a!=='--check')||process.argv.slice(2).length>1)throw Error('pb0_arguments');
const checking=process.argv.includes('--check'),out='docs/validation/gradle-e2-p0-pb0-2026-11-15.json',basePath='docs/validation/gradle-e2-p0-backend-design-2026-11-15.json',commit='fd82b26';
execFileSync('git',['merge-base','--is-ancestor',commit,'HEAD']);
const committed=execFileSync('git',['show',commit+':'+basePath],{maxBuffer:16777216}),base=await readFile(basePath),old=JSON.parse(base);
if(!base.equals(committed)||Object.keys(old.sourceBindings).length!==370)throw Error('pb0_baseline_changed');
const baseline={path:basePath,commit,sha256:sha(base)};
const document={path:old.document.path,heading:'### 9.163 E2-P0 PB0：strict contract・認可・状態・参照と実codec'};
const doc=await readFile(document.path,'utf8');document.sha256=sha(designSection(doc,document.heading));
if(sha(designSection(doc,old.document.heading))!==old.document.sha256)throw Error('pb0_historical_design_changed');
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('pb0_inherited_source_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const tests=['src/test/utils/gradleOwnedP0StateContract.test.ts','src/test/utils/gradleOwnedP0StateGraph.test.ts','src/test/utils/gradleOwnedP0StateCodec.test.ts','src/test/utils/gradleOwnedP0StateRecord.test.ts'];
for(const p of [...Object.keys(old.sourceBindings),...tests,'scripts/check-e2-p0-pb0.mjs','vitest.config.ts'])await bind(p);
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:await image(process.execPath),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
const compilerPath=(await import(pathToFileURL(resolve('node_modules/typescript/lib/getExePath.js')).href)).default();
const compiler={version:JSON.parse(await readFile('node_modules/typescript/package.json')).version,imagePath:relative(process.cwd(),compilerPath),imageDigest:await image(compilerPath),purpose:'local-TypeScript-build-not-verification-tool'};
const dependencyEntryPins=[];for(const name of ['zod','jsonc-parser','vitest']){const packagePath='node_modules/'+name+'/package.json',p=await readFile(packagePath),entryPath=relative(process.cwd(),name==='jsonc-parser'?require.resolve(name):fileURLToPath(import.meta.resolve(name)));dependencyEntryPins.push({name,version:JSON.parse(p).version,packagePath,packageDigest:sha(p),entryPath,entryDigest:await image(entryPath)});}
const dir=await mkdtemp(resolve(tmpdir(),'e2-p0-pb0-'));
try{
 const build=resolve(dir,'build');execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json','--outDir',build],{stdio:'pipe',timeout:120000,maxBuffer:8388608});await writeFile(resolve(build,'package.json'),'{"type":"module"}');await symlink(resolve('node_modules'),resolve(build,'node_modules'),'dir');
 const c=await import(pathToFileURL(resolve(build,'utils/gradleOwnedP0StateContract.js')).href),g=await import(pathToFileURL(resolve(build,'utils/gradleOwnedP0StateGraph.js')).href);
 const artifacts={};for(const n of ['gradleOwnedP0StateContract','gradleOwnedP0StateGraph','gradleOwnedP0StateMachine','gradleOwnedP0StateCodec','gradleOwnedJson'])artifacts[n+'.js']=sha(await readFile(resolve(build,'utils',n+'.js')));
 const contract={profileDigest:c.PB0_PROFILE_DIGEST,limits:c.PB0_LIMITS,domains:{readKey:'cwc.e2-p0.read-operation-key.v1',readIntent:'cwc.e2-p0.read-intent.v1',controlKey:'cwc.e2-p0.control-operation-key.v1',controlIntent:'cwc.e2-p0.control-intent.v1'},readAPIs:Object.keys(c.PB0_READ_POLICY),controlAPIs:Object.keys(c.PB0_CONTROL_POLICY),recordKinds:g.pb0RecordSchema.options.map(s=>s.shape.kind.value)};
 const scope={strictFixtureContract:true,realEd25519Codec:true,memoryBudgetFixture:true,staticAPIAuthorization:true,fixedClock:true,sameProcess:true,currentAuthorityVerified:false,realParentReservation:false,durableStore:false,nativeBackendIntegration:false,dependencyClosureProved:false,physicalBoundProved:false,jobPermitIssued:false,runtimeAdmitted:false,credit:0};
 const reviewRegressions={groups:['PBC18','PBC19','PBG11','PBG12','PBG13','PBG14','PBG15'],caseCounts:{PBC18:3,PBC19:3,PBG11:4,PBG12:1,PBG13:1,PBG14:1,PBG15:1},
  before:{passed:4,failed:10},after:{passed:14,failed:0},fixes:['api-specific-new-CAS-preconditions','bundle-local-workflow-init-ticket-and-grant-ownership'],historicalLookupPreserved:true,ownershipScope:'single-bundle-not-durable-or-cross-bundle'};
 const fixed={schema:'cwc.e2-p0.pb0-record.v1',date:'2026-11-15',status:'PB0-static-fixture-only-unsupported',baseline,document,sourceBindings,runtime,compiler,dependencyEntryPins,artifacts,contract,scope,actualState:old.actualState,conditions:old.conditions,reviewRegressions};
 let record={...fixed,codecObservation:null,verification:null};
 if(checking){record=JSON.parse(await readFile(out));if(canonical(Object.keys(record).sort())!==canonical([...Object.keys(fixed),'codecObservation','verification'].sort()))throw Error('pb0_record_keys');for(const k of Object.keys(fixed))if(canonical(record[k])!==canonical(fixed[k]))throw Error('pb0_saved_'+k);}
 // First collect the codec observation through the same public API regression test. Then validate the complete record.
 const observation=resolve(dir,'codec.json'),codecReport=resolve(dir,'codec-tests.json');
 execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',tests[2],'--maxWorkers=1','--reporter=json','--outputFile='+codecReport],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,PB0_CODEC_OBSERVATION:observation}});
 const cr=JSON.parse(await readFile(codecReport));if(!cr.success||cr.numPassedTests!==14||cr.numFailedTests!==0)throw Error('pb0_codec_observation_failed');
 const observed=JSON.parse(await readFile(observation));if(checking&&canonical(observed)!==canonical(record.codecObservation))throw Error('pb0_saved_codec_observation');record.codecObservation=observed;
 const candidate=resolve(dir,'record.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...tests,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,PB0_RECORD:candidate,PB0_CODEC_OBSERVATION:''}});}
 catch(e){let failed=[];try{failed=JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages})));}catch{}throw Error('pb0_tests '+JSON.stringify(failed)+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),names=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName)).sort(),groups=[...new Set(names.map(n=>n.match(/^PB[CGWR]\d{2}/)?.[0]))].sort();
 const expected=[...Array.from({length:19},(_,i)=>'PBC'+String(i+1).padStart(2,'0')),...Array.from({length:15},(_,i)=>'PBG'+String(i+1).padStart(2,'0')),...Array.from({length:14},(_,i)=>'PBW'+String(i+1).padStart(2,'0')),...Array.from({length:6},(_,i)=>'PBR'+String(i+1).padStart(2,'0'))].sort();
 if(!t.success||t.numPassedTests!==73||t.numFailedTests!==0||canonical(groups)!==canonical(expected)||new Set(names).size!==names.length)throw Error('pb0_test_closure');
 for(const [group,count]of Object.entries(reviewRegressions.caseCounts))if(names.filter(n=>n.startsWith(group+' ')).length!==count)throw Error('pb0_review_case_closure_'+group);
 const verification={kind:'static-contract-and-real-codec-fixture',passed:t.numPassedTests,failed:t.numFailedTests,success:t.success,names,groups,runtimeConditionsCompleted:0};if(checking&&canonical(record.verification)!==canonical(verification))throw Error('pb0_saved_verification');record.verification=verification;
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('pb0_source_changed_'+p);
 for(const e of dependencyEntryPins)if(sha(await readFile(e.packagePath))!==e.packageDigest||await image(e.entryPath)!==e.entryDigest)throw Error('pb0_dependency_changed');
 if(sha(designSection(await readFile(document.path,'utf8'),document.heading))!==document.sha256||sha(await readFile(basePath))!==baseline.sha256||await image(process.execPath)!==runtime.nodeBinaryDigest||await image(compilerPath)!==compiler.imageDigest)throw Error('pb0_evidence_changed');
 if(!checking)await writeFile(out,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,passed:t.numPassedTests,failed:t.numFailedTests,sources:Object.keys(sourceBindings).length,codec:observed,scope}));
}finally{await rm(dir,{recursive:true,force:true});}
