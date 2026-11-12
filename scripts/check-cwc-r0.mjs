/** CCO-R0 owned command fixture, independent legacy oracle and source-bound fresh replay. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical,co0Hash as hash} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {validateR0Evidence,validateR0Differential,validateR0Review,compareR0Replay,r0SourceAudit} from '../src/test/fixtures/gradleOwnedCwcR0Validation.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r0-2026-11-12.json';
const document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.146 CCO-R0：所有producer・有界parser・独立expectedの限定実証';
const baselinePaths=['docs/validation/gradle-cwc-co-redesign-2026-11-12.json','docs/validation/gradle-cwc-co0b-2026-11-12.json'];
const baselines=[],oldSources={};for(const p of baselinePaths){const b=await readFile(p),r=JSON.parse(b);baselines.push({path:p,sha256:sha(b)});for(const [p,h]of Object.entries(r.sourceBindings)){if(p in oldSources&&oldSources[p]!==h)throw Error('r0_legacy_conflict');oldSources[p]=h;}}
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in oldSources&&oldSources[p]!==h)throw Error('r0_legacy_changed_'+p);sourceBindings[p]=h;
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcR0.test.ts',recordTest='src/test/utils/gradleOwnedCwcR0Record.test.ts';
for(const p of [test,recordTest,'scripts/check-cwc-r0.mjs','src/test/fixtures/gradleOwnedCwcR0Validation.d.mts','package-lock.json','tsconfig.json','vitest.config.ts',...Object.keys(oldSources)])await bind(p);
const runtime={node:process.version,versions:process.versions,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const sectionDigest=sha(designSection(await readFile(document,'utf8'),heading)),dir=await mkdtemp(resolve(tmpdir(),'cwc-r0-'));
async function tests(file,prefix,expected,env={}){const report=resolve(dir,prefix+'.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{const r=JSON.parse(await readFile(report));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r0_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const r=JSON.parse(await readFile(report)),ids=r.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();
 if(!r.success||r.numPassedTests!==expected.length||r.numFailedTests!==0||canonical(ids)!==canonical(expected.sort()))throw Error('r0_test_identity');return r.numPassedTests;
}
try{
 const output=resolve(dir,'evidence.json'),corpus=resolve(dir,'differential.json'),reviewOutput=resolve(dir,'review.json'),ids=Array.from({length:28},(_,i)=>String(i+1).padStart(2,'0')).concat(['13','16','17','25',...Array(5).fill('27'),...Array(3).fill('28')]);
 const testsPassed=await tests(test,'R0T',ids,{CWC_R0_EVIDENCE_PATH:output,CWC_R0_DIFFERENTIAL_PATH:corpus,CWC_R0_REVIEW_PATH:reviewOutput}),evidence=JSON.parse(await readFile(output)),differential=JSON.parse(await readFile(corpus));
 const review=JSON.parse(await readFile(reviewOutput)),audit=r0SourceAudit(),summary={...validateR0Evidence(evidence),differential:validateR0Differential(differential),review:validateR0Review(review)},body={evidence,differential,audit,review};
 const record=process.argv.includes('--check')?JSON.parse(await readFile(path)):{schema:'cwc-r0.validation.v1',date:'2026-11-12',reviewedOn:'2026-11-13',document,heading,sectionDigest,sourceBindings,baselines,runtime,testsPassed,recordTestsPassed:11,...body,evidenceDigest:hash(body),summary};
 if(record.schema!=='cwc-r0.validation.v1'||record.reviewedOn!=='2026-11-13'||record.document!==document||record.heading!==heading||record.sectionDigest!==sectionDigest||canonical(record.sourceBindings)!==canonical(sourceBindings)||canonical(record.baselines)!==canonical(baselines)||canonical(record.runtime)!==canonical(runtime)||record.testsPassed!==testsPassed||record.recordTestsPassed!==11||canonical(record.summary)!==canonical(summary)||record.evidenceDigest!==hash({evidence:record.evidence,differential:record.differential,audit:record.audit,review:record.review}))throw Error('r0_record');
 compareR0Replay({evidence:record.evidence,differential:record.differential,audit:record.audit,review:record.review},body);
 const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(record));await tests(recordTest,'R0R',Array.from({length:11},(_,i)=>String(i+1).padStart(2,'0')),{CWC_R0_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r0_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record)+'\n');console.log(JSON.stringify({tests:testsPassed,recordTests:11,sources:Object.keys(sourceBindings).length,...summary}));
}finally{await rm(dir,{recursive:true,force:true});}
