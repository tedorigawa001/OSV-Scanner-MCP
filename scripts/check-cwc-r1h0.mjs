/** Finite R1-H0 lifecycle replay. Original pinned R1-H/R1-M source and evidence stay immutable. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {r1hHash,validateR1hEvidence,compareR1hReplay} from '../src/test/fixtures/gradleOwnedCwcR1hValidation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1h0-2026-11-13.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.151 R1-H0：所有port・固定registry・終了／失効／回収の限定実装'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const conditions=[...section.matchAll(/^\| (R1H0\d{2}) \| (.+) \|$/gm)].map(m=>({id:m[1],condition:m[2],scope:'limited-lifecycle-fixture',executed:true,fullContractExecuted:false}));
if(canonical(conditions.map(x=>x.id))!==canonical(Array.from({length:20},(_,i)=>'R1H0'+String(i+1).padStart(2,'0'))))throw Error('r1h0_conditions');
const baseline={path:'docs/validation/gradle-cwc-r1h-design-2026-11-13.json'},b=await readFile(baseline.path),old=JSON.parse(b);baseline.sha256=sha(b);
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in old.sourceBindings&&old.sourceBindings[p]!==h)throw Error('r1h0_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const runtimeTest='src/test/utils/gradleOwnedCwcR1h.test.ts',recordTest='src/test/utils/gradleOwnedCwcR1hRecord.test.ts';
for(const p of [runtimeTest,recordTest,'scripts/check-cwc-r1h0.mjs','src/test/fixtures/gradleOwnedCwcR1hValidation.d.mts',...Object.keys(old.sourceBindings)])await bind(p);
const sourcePath='src/test/fixtures/gradleOwnedCwcR1h.ts',source=await readFile(sourcePath,'utf8');
const sourceAudit=[['input','function fields(','return out;'],['owned-port','class OwnedPorts {','export function createR1hPorts()'],['fixed-registry','readonly #registry:','Object.freeze'],
 ['two-body-reservation','this.#held+=2;','this.#registry[index]=r;'],['private-native-bytes','buffer=new NativeBytes(3072)','this.#allocations++;'],['reentry','#guard(){','#find('],['live-checks','#live(r:Read){','#run<T>'],
 ['borrow','beginBorrow(','#publicationFault('],['closed-fault-program','#publicationFault(','publish(h:'],['zero-quarantine','reclaim(h:','#release(r:Read)'],['frame-drain','finally{r.frames--;','beginRead('],['observer','static observe(','Object.freeze(R1hRuntime.prototype)']].map(([id,first,last])=>{
  // The source uses captured freeze, not a caller-replaceable Object.freeze invocation.
  if(last==='Object.freeze')last='freeze(this)';if(last==='Object.freeze(R1hRuntime.prototype)')last='freeze(R1hRuntime.prototype)';
  const start=source.indexOf(first),end=source.indexOf(last,start);if(start<0||end<start)throw Error('r1h0_source_anchor_'+id);return {id,path:sourcePath,first,last,startLine:source.slice(0,start).split('\n').length,sha256:sha(source.slice(start,end+last.length))};});
const partial=new Set(['RHC01','RHC03','RHC04','RHC05','RHC06','RHC08','RHC09','RHC11','RHC12','RHC15','RHC24','RHC25','RHC26','RHC27','RHC28','RHC30','RHC32','RHC45']);
const coverage=old.conditions.map(c=>({id:c.id,condition:c.condition,status:partial.has(c.id)?'limited-fixture':'planned',fullContractExecuted:false}));
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1h0-'));
async function run(test,env,count,prefix,duplicates){const report=resolve(dir,prefix+'.json');try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1h0_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort(),expected=Array.from({length:count/duplicates},(_,i)=>Array(duplicates).fill(String(i+1).padStart(2,'0'))).flat().sort();
 if(!t.success||t.numPassedTests!==count||t.numFailedTests!==0||canonical(ids)!==canonical(expected))throw Error('r1h0_test_ids');}
try{
 const output=resolve(dir,'evidence.json');await run(runtimeTest,{CWC_R1H_EVIDENCE_PATH:output},40,'R1HT',2);const evidence=JSON.parse(await readFile(output)),summary=validateR1hEvidence(evidence);
 const record={schema:'cwc-r1h0.record.v1',date:'2026-11-13',status:'limited-lifecycle',document,baseline,sourceBindings,runtime,sourceAudit,conditions,coverage,evidence,evidenceDigest:r1hHash(evidence),summary,runtimeTestsPassed:40,recordTestsPassed:10,performanceMeasured:false};
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));compareR1hReplay(saved.evidence,evidence);if(canonical(saved)!==canonical(record))throw Error('r1h0_saved_record');}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await run(recordTest,{CWC_R1H_RECORD_PATH:candidate},10,'R1HR',1);
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1h0_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({...summary,runtimeTests:40,recordTests:10,sources:Object.keys(sourceBindings).length}));
}finally{await rm(dir,{recursive:true,force:true});}
