/** Finite synthetic-summary replay. No approval/charge/IPC certificate is issued. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {r1sHash,validateR1sEvidence,compareR1sReplay} from '../src/test/fixtures/gradleOwnedCwcR1sValidation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1s-2026-11-14.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.153 R1-S：有界summary配送の限定実装'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const conditions=[...section.matchAll(/^\| (R1S\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],scope:'limited-synthetic-summary-delivery',executed:true,fullContractExecuted:false}));
if(canonical(conditions.map(x=>x.id))!==canonical(Array.from({length:20},(_,i)=>'R1S'+String(i+1).padStart(2,'0'))))throw Error('r1s_conditions');
const baseline={path:'docs/validation/gradle-cwc-r1hb-design-2026-11-13.json'},b=await readFile(baseline.path),old=JSON.parse(b);baseline.sha256=sha(b);
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('r1s_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const runtimeTest='src/test/utils/gradleOwnedCwcR1s.test.ts',recordTest='src/test/utils/gradleOwnedCwcR1sRecord.test.ts';
for(const p of [runtimeTest,recordTest,'scripts/check-cwc-r1s.mjs','src/test/fixtures/gradleOwnedCwcR1sValidation.d.mts',...Object.keys(old.sourceBindings)])await bind(p);
const sourcePath='src/test/fixtures/gradleOwnedCwcR1s.ts',source=await readFile(sourcePath,'utf8');
const sourceAudit=[['fixed-registry','constructor(mode:','recipient()'],['synthetic-receipt','#receipt(r:','#run(op:'],['guard-before-entry','#run(op:','this.#busy=true;'],['bank-allocation','const sender=new Bytes(512)','return read;'],['zero-drain',"if(op==='reclaim')",'const i=this.#item'],['immutable-retransmission',"if(op==='dispatch')", "if(op==='receive')"],['dedup-before-copy',"if(op==='receive')","if(op==='ack')"],['ack-consumer-separation',"if(op==='ack')",'throw NativeError(\'r1s_operation\')'],['harness-only','static copySender(','freeze(R1sDelivery.prototype)']].map(([id,first,last])=>{const start=source.indexOf(first),end=source.indexOf(last,start);if(start<0||end<start)throw Error('r1s_source_anchor_'+id);return {id,path:sourcePath,first,last,startLine:source.slice(0,start).split('\n').length,sha256:sha(source.slice(start,end+last.length))};});
const prior=JSON.parse(await readFile('docs/validation/gradle-cwc-r1h-design-2026-11-13.json'));
const coverage=prior.conditions.map(c=>({id:c.id,condition:c.condition,status:Number(c.id.slice(3))>=33&&Number(c.id.slice(3))<=42?'limited-synthetic-fixture':'planned',fullContractExecuted:false}));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1s-'));
async function run(test,env,count,prefix,duplicates){const report=resolve(dir,prefix+'.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1s_tests '+failures+' '+String(e.stderr??''),{cause:e});}const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort(),expected=Array.from({length:count/duplicates},(_,i)=>Array(duplicates).fill(String(i+1).padStart(2,'0'))).flat().sort();if(!t.success||t.numPassedTests!==count||t.numFailedTests!==0||canonical(ids)!==canonical(expected))throw Error('r1s_test_ids');}
try{
 const output=resolve(dir,'evidence.json');await run(runtimeTest,{CWC_R1S_EVIDENCE_PATH:output},40,'R1ST',2);const evidence=JSON.parse(await readFile(output)),summary=validateR1sEvidence(evidence);
 const record={schema:'cwc-r1s.record.v1',date:'2026-11-14',status:'limited-synthetic-summary-delivery',document,baseline,sourceBindings,runtime,sourceAudit,conditions,coverage,evidence,evidenceDigest:r1sHash(evidence),summary,runtimeTestsPassed:40,recordTestsPassed:10,performanceMeasured:false};
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));compareR1sReplay(saved.evidence,evidence);if(canonical(saved)!==canonical(record))throw Error('r1s_saved_record');}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await run(recordTest,{CWC_R1S_RECORD_PATH:candidate},10,'R1SR',1);
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1s_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({...summary,runtimeTests:40,recordTests:10,sources:Object.keys(sourceBindings).length}));
}finally{await rm(dir,{recursive:true,force:true});}
