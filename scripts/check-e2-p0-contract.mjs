/** Metadata-only regression record. Never fetches tools, invokes a verifier or issues a permit. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir,release} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function imageHash(p){const h=createHash('sha256');for await(const b of createReadStream(p,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
const output='docs/validation/gradle-e2-p0-contract-2026-11-14.json';
const tests=['src/test/utils/gradleOwnedP0Contract.test.ts','src/test/utils/gradleOwnedP0Record.test.ts'];
const baseline={path:'docs/validation/gradle-cwc-hb2-p0-design-2026-11-14.json',commit:'ffbc66e'};
const baselineBytes=await readFile(baseline.path),old=JSON.parse(baselineBytes);baseline.sha256=sha(baselineBytes);
execFileSync('git',['merge-base','--is-ancestor',baseline.commit,'HEAD']);
if(sha(execFileSync('git',['show',baseline.commit+':'+baseline.path]))!==baseline.sha256)throw Error('p0_contract_baseline_changed');
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.160 E2-P0：取得lock・承認envelope・preflightの静的contract'};
document.sha256=sha(designSection(await readFile(document.path,'utf8'),document.heading));
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('p0_contract_legacy_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}
}
for(const p of [...Object.keys(old.sourceBindings),...tests,'scripts/check-e2-p0-contract.mjs','node_modules/zod/package.json','node_modules/jsonc-parser/package.json'])await bind(p);
const runtime={node:process.version,platform:process.platform,arch:process.arch,osRelease:release(),nodeBinaryDigest:await imageHash(process.execPath),flags:process.execArgv,nodeOptions:process.env.NODE_OPTIONS??'',nodePath:process.env.NODE_PATH??''};
const scope={metadataOnly:true,syntheticKeysAndEvidence:true,actualToolsAcquired:false,imagesBuilt:false,proofExecuted:false,workspaceEnforced:false,
 independentAuthorityDeployed:false,nativeConditionsExecuted:[],jobPermitIssued:false,runtimeAdmitted:false,physicalBoundProved:false,credit:0};
const fixed={schema:'cwc.e2-p0.contract-record.v1',date:'2026-11-14',status:'static-contract-only-unsupported',baseline,document,sourceBindings,runtime,scope,
 expectations:{testGroups:47,metadataTests:172,recordTests:6,actualState:old.plan.actualState,missing:old.plan.missing,
  staticValidIs:'signed-and-pinned-metadata-consistent-not-runtime-ready',candidateOperations:{candidateReads:0,copies:0,execs:0,publications:0},
  redGreen:{tests:['P0S41','P0S42'],before:{passed:144,failed:2},after:{passed:146,failed:0}},
  reviewRegressions:{negativeDeadline:{group:'P0S43',beforeFailed:2,afterPassed:2,effectiveDeadline:null,status:'revoked-or-expired',latched:true},
   failedPhase:{group:'P0S44',beforeFailed:10,afterPassed:10,allPhases:5,allGates:3},
   phaseEvidence:{reserved:['absent','absent','absent'],copied:['absent','absent','absent'],
    'result-validated':['success','absent','absent'],drained:['success','required','absent'],sealed:['success','required','required']},
   phaseEvidenceColumns:['result','drainWitness','sealWitness'],contradictionCases:8,normalPhaseCases:5,malformedFailureCases:1}}};
let record={...fixed,verification:null};
if(process.argv.includes('--check')){record=JSON.parse(await readFile(output));if(canonical(Object.keys(record).sort())!==canonical([...Object.keys(fixed),'verification'].sort()))throw Error('p0_contract_record_keys');
 for(const k of Object.keys(fixed))if(canonical(record[k])!==canonical(fixed[k]))throw Error('p0_contract_saved_'+k);}
const dir=await mkdtemp(resolve(tmpdir(),'e2-p0-contract-'));
try{
 const candidate=resolve(dir,'record.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',...tests,'--maxWorkers=1','--reporter=json','--outputFile='+report],
  {env:{...process.env,E2_P0_CONTRACT_RECORD:candidate},stdio:'pipe',timeout:120000,maxBuffer:8388608});}
 catch(e){let failed=[];try{failed=JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages})));}catch{}
  throw Error('p0_contract_tests '+JSON.stringify(failed)+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),names=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName)).sort();
 const groups=[...new Set(names.map(n=>n.match(/^P0[SR]\d{2}/)?.[0]))].sort();
 const expected=[...Array.from({length:47},(_,i)=>'P0S'+String(i+1).padStart(2,'0')),...Array.from({length:6},(_,i)=>'P0R'+String(i+1).padStart(2,'0'))].sort();
 if(!t.success||t.numPassedTests!==178||t.numFailedTests!==0||canonical(groups)!==canonical(expected)||new Set(names).size!==names.length)throw Error('p0_contract_test_closure');
 const verification={passed:t.numPassedTests,failed:t.numFailedTests,success:t.success,names,groups};
 if(process.argv.includes('--check')&&canonical(record.verification)!==canonical(verification))throw Error('p0_contract_saved_verification');record.verification=verification;
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('p0_contract_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(output,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({status:record.status,passed:t.numPassedTests,failed:t.numFailedTests,sources:Object.keys(sourceBindings).length,...scope}));
}finally{await rm(dir,{recursive:true,force:true});}
