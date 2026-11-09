/** Reproducible CLB-0 fixture evidence. No transport integration or performance claim. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {LB0_SCOPE} from '../src/test/fixtures/gradleOwnedCwcLb0Validation.mjs';
const path='docs/validation/gradle-cwc-lb0-2026-11-10.json';
const test='src/test/utils/gradleOwnedCwcLb0.test.ts',recordTest='src/test/utils/gradleOwnedCwcLb0Record.test.ts';
const sha=b=>createHash('sha256').update(b).digest('hex'),sourceBindings={};
async function bind(p){
 if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);
 for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){
  if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));
 }
}
for(const p of [test,recordTest,'src/test/fixtures/gradleOwnedCwcLb0Validation.d.mts','scripts/check-cwc-lb0.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.127 CLB-0：私有wire・identityとbinding状態機械の共通fixture';
const sectionDigest=sha(designSection(await readFile(document,'utf8'),heading));
const dir=await mkdtemp(resolve(tmpdir(),'cwc-lb0-'));
async function run(file,count,env){
 const report=resolve(dir,file===test?'runtime-tests.json':'record-tests.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:60000,env:{...process.env,...env}});}
 catch(e){throw Error('lb0_test_execution: '+String(e.stdout??'')+' '+String(e.stderr??''),{cause:e});}
 const r=JSON.parse(await readFile(report,'utf8'));if(!r.success||r.numPassedTests!==count||r.numTotalTests!==count)throw Error('lb0_test_count');
}
try{
 let r;
 if(process.argv.includes('--check'))r=JSON.parse(await readFile(path,'utf8'));
 else{
  const evidence=resolve(dir,'evidence.json');await run(test,36,{CWC_LB0_EVIDENCE_PATH:evidence});
  r={schema:'cwc-lb0.validation.v1',date:'2026-11-10',document,heading,sectionDigest,sourceBindings,testsPassed:36,recordTestsPassed:9,scope:LB0_SCOPE,environment:{node:process.version},measurement:JSON.parse(await readFile(evidence,'utf8'))};
 }
 if(r.document!==document||r.heading!==heading||r.sectionDigest!==sectionDigest||JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||JSON.stringify(r.scope)!==JSON.stringify(LB0_SCOPE)||r.environment.node!==process.version)throw Error('lb0_record_bindings');
 const record=resolve(dir,'record.json');await writeFile(record,JSON.stringify(r));await run(recordTest,9,{CWC_LB0_RECORD_PATH:record});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('lb0_source_changed');
 if(sha(designSection(await readFile(document,'utf8'),heading))!==sectionDigest)throw Error('lb0_document_changed');
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r,null,2)+'\n');
 console.log(JSON.stringify({runtimeTests:r.testsPassed,recordTests:r.recordTestsPassed,samples:r.measurement.samples.length,proofs:r.measurement.proofs.length,fullVerificationBothModes:true,hashElisionImplemented:false,productionAdopted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
