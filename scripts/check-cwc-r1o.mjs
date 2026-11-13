/** Replay the R1-O diagnostic ownership contract; preserve every older pinned source. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {r1oHash,validateR1oEvidence,compareR1oReplay,validateR1oReview,compareR1oReview} from '../src/test/fixtures/gradleOwnedCwcR1oValidation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1o-2026-11-13.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.148 R1-O：所有登録・scope shell・排他的移管の限定実装'};
document.sha256=sha(designSection(await readFile(document.path,'utf8'),document.heading));
const baselines=[],oldSources={};
for(const p of ['docs/validation/gradle-cwc-r1-design-2026-11-13.json','docs/validation/gradle-cwc-r0-2026-11-12.json']){
 const bytes=await readFile(p),r=JSON.parse(bytes);baselines.push({path:p,sha256:sha(bytes)});
 for(const [p,h]of Object.entries(r.sourceBindings)){if(p in oldSources&&oldSources[p]!==h)throw Error('r1o_baseline_conflict');oldSources[p]=h;}
}
const runtimeTest='src/test/utils/gradleOwnedCwcR1o.test.ts',recordTest='src/test/utils/gradleOwnedCwcR1oRecord.test.ts',sourceBindings={};
async function bind(p){
 if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in oldSources&&oldSources[p]!==h)throw Error('r1o_legacy_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){
  if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));
 }
}
for(const p of [runtimeTest,recordTest,'scripts/check-cwc-r1o.mjs','src/test/fixtures/gradleOwnedCwcR1oValidation.d.mts',...Object.keys(oldSources)])await bind(p);
const sourcePath='src/test/fixtures/gradleOwnedCwcR1o.ts',source=await readFile(sourcePath,'utf8');
const audit=[
 ['private-source','readonly #calls=new Map<R1oHandle,Call>()','Object.freeze(this)'],
 ['shell','registerOwnedIntake(','c.scopeAllocations++'],
 ['capacity-before-produce',"c.phase==='reserved'&&c.ticket",'this.#produce(c)'],
 ['borrow-pins-real-buffers','context:s.store.context,core:s.store.core','c.pin=s.store'],
 ['stop-before-validate',"s.state='stopped'","'drain-existing-borrows'"],
 ['exclusive-complete-validate',"c.phase='exclusive'",'this.#validate(c,store)'],
 ['full-schema-and-inventory','validatePlanCore(parse(ps))','hash(entries)===c.entriesPin'],
 ['stamp-and-fence','c.stamp={store,revision:c.revision,epoch:c.epoch','this.#fence(c,store)'],
 ['same-store-move','d.store=store;c.source!.store=undefined','c.sameLease=c.ticket===ticket'],
 ['fatal-before-mutation',"return this.#denied(c)",'const b=store[part]'],
 ['drain-after-borrow',"c.borrow?.open||c.exclusive||c.released",'Reflect.apply(fill,b,[0])'],
 ['unsupported-production','adoptProduction(',"throw Error('r1o_profile_unsupported')"],
 ['owned-budget-port','requireR1oBudget(this.#budget)','checkR1oBudget(this.#budget)'],
 ['reject-async-return','if(result!==undefined)',"throw Error('r1o_async_callback_unsupported')"],
 ['observe-pending-native-promise','c.pendingCallbacks++;','Reflect.apply(promiseThen,result,[settled,settled])'],
 ['drain-pending-callbacks','c.pendingCallbacks||','Reflect.apply(fill,b,[0])']
].map(([id,first,last])=>{const a=source.indexOf(first),b=source.indexOf(last,a);if(a<0||b<a)throw Error('r1o_anchor_'+id);return {id,path:sourcePath,first,last,sha256:sha(source.slice(a,b+last.length))};});
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1o-'));
async function run(test,env,count,prefix,ids){
 const report=resolve(dir,prefix+'.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{failures=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1o_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),actual=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();
 if(!t.success||t.numPassedTests!==count||t.numFailedTests!==0||canonical(actual)!==canonical(ids.sort()))throw Error('r1o_test_ids');
}
try{
 const exported=resolve(dir,'evidence.json'),reviewPath=resolve(dir,'review.json');await run(runtimeTest,{CWC_R1O_EVIDENCE_PATH:exported,CWC_R1O_REVIEW_PATH:reviewPath},35,'R1OT',[...Array.from({length:28},(_,i)=>String(i+1).padStart(2,'0')),'12','13','13','22','22','22','23']);
 const evidence=JSON.parse(await readFile(exported)),summary=validateR1oEvidence(evidence),review=JSON.parse(await readFile(reviewPath)),reviewSummary=validateR1oReview(review);
 const record={schema:'cwc-r1o.record.v1',date:'2026-11-13',reviewedOn:'2026-11-13',status:'ownership-only',document,baselines,sourceBindings,runtime,audit,evidence,evidenceDigest:r1oHash(evidence),summary,review,reviewDigest:r1oHash(review),reviewSummary,runtimeTestsPassed:35,recordTestsPassed:12,performanceMeasured:false};
 if(process.argv.includes('--check')){const saved=JSON.parse(await readFile(path));compareR1oReplay(saved.evidence,evidence);compareR1oReview(saved.review,review);if(canonical(saved)!==canonical(record))throw Error('r1o_saved_record');}
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await run(recordTest,{CWC_R1O_RECORD_PATH:candidate},12,'R1OR',Array.from({length:12},(_,i)=>String(i+1).padStart(2,'0')));
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1o_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify({...summary,review:reviewSummary,runtimeTests:35,recordTests:12,sources:Object.keys(sourceBindings).length}));
}finally{await rm(dir,{recursive:true,force:true});}
