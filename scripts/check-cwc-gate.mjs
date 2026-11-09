/** Lightweight attribution of CWC connection gates; neither a cache nor backend adoption. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir,cpus,loadavg,platform,arch} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
const path='docs/validation/gradle-cwc-gate-2026-11-09.json',test='src/test/utils/gradleOwnedCwcGate.test.ts',sourceBindings={};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,'src/test/utils/gradleOwnedCwcGateRecord.test.ts','scripts/check-cwc-gate.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.125 CWC-Gate：接続費用の軽量分解と優先順位の変更',section=designSection(await readFile(document,'utf8'),heading),sectionDigest=sha(section);
const scope={callThroughOnly:true,stackCapture:false,verificationReuse:false,gateRemoved:false,fixedFingerprintImplemented:false,inProcess:true,mockStorage:true,productionAdopted:false,continuousEightReads:false};
const reviewFixes={bpBatchEquivalence:true,wrapperEntryWitness:true,inspectionCountContract:'cwc-gate.success-no-retry.v1',nonReentrantShaWallBound:true,regressions:['CWG10','CWG11','CWG12','CWG13','CWG14','CWG15']};
let r;
if(process.argv.includes('--check')||process.argv.includes('--rebind-document')){
 r=JSON.parse(await readFile(path,'utf8'));if(process.argv.includes('--rebind-document'))r.sectionDigest=sectionDigest;
}else{
 const dir=await mkdtemp(resolve(tmpdir(),'cwc-gate-')),environment={node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,loadStart:loadavg()};
 try{
  const output=resolve(dir,'tests.json'),evidence=resolve(dir,'evidence.json');
  execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+output],{stdio:'pipe',timeout:240000,env:{...process.env,CWC_GATE_EVIDENCE_PATH:evidence}});
  const result=JSON.parse(await readFile(output,'utf8'));if(!result.success||result.numPassedTests!==15)throw Error('cwc_gate_tests');
  r={schema:'cwc-gate.validation.v1',date:'2026-11-09',sourceBindings,document,heading,sectionDigest,testsPassed:15,environment:{...environment,loadEnd:loadavg()},scope,reviewFixes,measurement:JSON.parse(await readFile(evidence,'utf8'))};
 }finally{await rm(dir,{recursive:true,force:true});}
}
if(JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.sectionDigest!==sectionDigest||JSON.stringify(r.scope)!==JSON.stringify(scope)||JSON.stringify(r.reviewFixes)!==JSON.stringify(reviewFixes)||r.testsPassed!==15||r.measurement.clock!=='real'||r.measurement.rounds!==3||r.measurement.rows.length!==240)throw Error('cwc_gate_bindings');
// Revalidate the stored rows using the same exported validator in a fresh Vitest execution.
const dir=await mkdtemp(resolve(tmpdir(),'cwc-gate-check-'));
try{
 const record=resolve(dir,'record.json');await writeFile(record,JSON.stringify(r.measurement));
 execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run','src/test/utils/gradleOwnedCwcGateRecord.test.ts','--maxWorkers=1'],{stdio:'pipe',timeout:60000,env:{...process.env,CWC_GATE_RECORD_PATH:record,CWC_GATE_SKIP_DOCUMENT_TABLE:process.argv.includes('--measure-only')?'1':'0'}});
}finally{await rm(dir,{recursive:true,force:true});}
for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('cwc_gate_source_changed');
if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r,null,2)+'\n');
console.log(JSON.stringify({rows:r.measurement.rows.length,completed:r.measurement.rows.filter(r=>r.status==='complete').length,summary:r.measurement.summary.map(s=>({workload:s.workload,role:s.role,composedMs:s.times.composed.medianMs,bpBridgeMs:s.times['bp-bridge'].medianMs,gateExclusiveMs:s.gateExclusiveMs,observerOverheadMs:s.observerOverhead.medianMs})),productionAdopted:false}));
