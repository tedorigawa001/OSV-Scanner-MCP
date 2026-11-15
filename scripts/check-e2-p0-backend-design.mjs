/** Design consistency only: does not implement, authorize or deploy a persistent backend. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {P0_BACKEND_PLAN as plan,P0_BACKEND_CONDITIONS as conditions} from '../src/test/fixtures/gradleOwnedP0BackendDesign.mjs';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
if(process.argv.slice(2).some(a=>a!=='--check')||process.argv.slice(2).length>1)throw Error('backend_design_arguments');
const checking=process.argv.includes('--check'),sha=b=>createHash('sha256').update(b).digest('hex');
async function image(p){const h=createHash('sha256');for await(const b of createReadStream(p,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
const out='docs/validation/gradle-e2-p0-backend-design-2026-11-15.json';
const basePath='docs/validation/gradle-e2-p0-runner-2026-11-14.json',commit=plan.baselineCommit;
execFileSync('git',['merge-base','--is-ancestor',commit,'HEAD']);
const committed=execFileSync('git',['show',commit+':'+basePath],{maxBuffer:16777216}),base=await readFile(basePath),old=JSON.parse(base);
if(!base.equals(committed))throw Error('backend_design_baseline_changed');
if(Object.keys(old.sourceBindings).length!==366)throw Error('backend_design_baseline_sources');
const baseline={path:basePath,commit,sha256:sha(base)};
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.162 E2-P0 backend：job認可・永続保存・boot／current pinの契約'};
const doc=await readFile(document.path,'utf8');document.sha256=sha(designSection(doc,document.heading));
if(sha(designSection(doc,old.document.heading))!==old.document.sha256)throw Error('backend_design_prior_section_changed');
const sourceBindings={};
async function bind(p){
 if(p in sourceBindings)return;
 const bytes=await readFile(p),h=sha(bytes);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('backend_design_inherited_source_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of bytes.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){
  if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));
 }
}
const testPath='src/test/utils/gradleOwnedP0BackendDesign.test.ts';
for(const p of [...Object.keys(old.sourceBindings),testPath,'src/test/fixtures/gradleOwnedP0BackendDesign.d.mts','scripts/check-e2-p0-backend-design.mjs'])await bind(p);
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:await image(process.execPath),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
const reviewRegressions={groups:Array.from({length:6},(_,i)=>'EBD'+String(i+25).padStart(2,'0')),before:{passed:0,failed:6},after:{passed:6,failed:0},
 kind:'design-consistency-not-runtime',fixes:['separate-control-K-D-and-query-origin','prepaid-init-control-slice-within-original-wire-parent'],nativeConditionsExecuted:0};
const secondReviewRegressions={groups:Array.from({length:5},(_,i)=>'EBD'+String(i+31).padStart(2,'0')),strengthened:['EBD13'],before:{passed:0,failed:5},after:{passed:5,failed:0},kind:'design-consistency-not-runtime',
 fixes:['begin-consumes-pre-reserved-init-admission','separate-durable-escape-step-before-enqueue','read-K-D-digest-domains','control-debt-fields-and-absent-origin-tombstone'],nativeConditionsExecuted:0};
const fixed={schema:'cwc.e2-p0.backend-design-record.v1',date:'2026-11-15',status:plan.status,baseline,document,sourceBindings,runtime,plan,conditions,scope:plan.scope,actualState:plan.actualState,reviewRegressions,secondReviewRegressions};
let record={...fixed,verification:null};
if(checking){record=JSON.parse(await readFile(out));if(canonical(Object.keys(record).sort())!==canonical([...Object.keys(fixed),'verification'].sort()))throw Error('backend_design_record_keys');for(const k of Object.keys(fixed))if(canonical(record[k])!==canonical(fixed[k]))throw Error('backend_design_saved_'+k);}
const dir=await mkdtemp(resolve(tmpdir(),'e2-p0-backend-design-'));
try{
 const candidate=resolve(dir,'record.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',testPath,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,E2_P0_BACKEND_DESIGN_RECORD:candidate}});}
 catch(e){let failed=[];try{failed=JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages})));}catch{}throw Error('backend_design_tests '+JSON.stringify(failed)+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),names=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName)).sort();
 const groups=names.map(n=>n.match(/^EBD\d{2}/)?.[0]),expected=Array.from({length:35},(_,i)=>'EBD'+String(i+1).padStart(2,'0'));
 if(!t.success||t.numPassedTests!==35||t.numFailedTests!==0||canonical(groups)!==canonical(expected)||new Set(names).size!==names.length)throw Error('backend_design_test_closure');
 const verification={kind:'design-consistency-not-runtime',passed:t.numPassedTests,failed:t.numFailedTests,success:t.success,names,groups,plannedRuntimeConditions:48,executedRuntimeConditions:0};
 if(checking&&canonical(record.verification)!==canonical(verification))throw Error('backend_design_saved_verification');record.verification=verification;
 for(const [p,h] of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('backend_design_source_changed_'+p);
 if(sha(designSection(await readFile(document.path,'utf8'),document.heading))!==document.sha256||sha(await readFile(basePath))!==baseline.sha256||await image(process.execPath)!==runtime.nodeBinaryDigest)throw Error('backend_design_evidence_changed');
 if(!checking)await writeFile(out,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,sources:Object.keys(sourceBindings).length,...verification,names:undefined,groups:undefined,jobPermitIssued:false,runtimeAdmitted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
