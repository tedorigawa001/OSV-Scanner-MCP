/** CCO-0b unchanged-source lower-bound investigation and fail-closed evidence. */
import {readFile,writeFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,relative,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0bSha} from '../src/test/fixtures/gradleOwnedCwcCo0bAudit.mjs';
import {co0Canonical as canonical,co0Hash as hash} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {packCo0b,unpackCo0b} from '../src/test/fixtures/gradleOwnedCwcCo0bPacked.mjs';
import {validateCo0bEvidence,compareCo0bReplay} from '../src/test/fixtures/gradleOwnedCwcCo0bValidation.mjs';
const path='docs/validation/gradle-cwc-co0b-2026-11-12.json',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.144 CCO-0b：内部参照・canonical／hash scratch・追加workの調査';
const baselinePaths=['docs/validation/gradle-cwc-co0-2026-11-12.json','docs/validation/gradle-cwc-lg-window-2026-11-12.json'];
const baselines=[],oldSources={};for(const p of baselinePaths){const b=await readFile(p),r=JSON.parse(b);if(r.evidenceDigest!==hash(r.evidence))throw Error('co0b_baseline');
 for(const [p,h]of Object.entries(r.sourceBindings)){if(p in oldSources&&oldSources[p]!==h)throw Error('co0b_baseline_source');oldSources[p]=h;}baselines.push({path:p,sha256:co0bSha(b)});}
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=co0bSha(b);sourceBindings[p]=h;if(p in oldSources&&oldSources[p]!==h)throw Error('co0b_legacy_source_changed_'+p);
 if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcCo0b.test.ts',recordTest='src/test/utils/gradleOwnedCwcCo0bRecord.test.ts';
for(const p of [test,recordTest,'scripts/check-cwc-co0b.mjs','package-lock.json','tsconfig.json','vitest.config.ts',...Object.keys(oldSources)])await bind(p);
// Pin the installed parser artifacts as evidence, without claiming its internal allocation upper bound.
async function artifactTree(dir){for(const e of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const p=dir+'/'+e.name;if(e.isDirectory())await artifactTree(p);else if(e.name.endsWith('.js'))sourceBindings[p]=co0bSha(await readFile(p));}}
for(const p of ['node_modules/zod/package.json','node_modules/zod/index.js','node_modules/jsonc-parser/package.json'])sourceBindings[p]=co0bSha(await readFile(p));
await artifactTree('node_modules/zod/v4');await artifactTree('node_modules/jsonc-parser/lib/esm');
const runtime={node:process.version,versions:process.versions,platform:process.platform,arch:process.arch,nodeBinaryDigest:co0bSha(await readFile(process.execPath)),
 zod:JSON.parse(await readFile('node_modules/zod/package.json')).version};
const section=designSection(await readFile(document,'utf8'),heading),sectionDigest=co0bSha(section),dir=await mkdtemp(resolve(tmpdir(),'cwc-co0b-'));
async function tests(file,prefix,count,env={}){const report=resolve(dir,prefix+'.json');
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:180000,maxBuffer:8388608,env:{...process.env,...env}});}
 catch(e){let failures='';try{const r=JSON.parse(await readFile(report));failures=JSON.stringify(r.testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('co0b_tests '+failures+' '+String(e.stderr??''),{cause:e});}
 const r=JSON.parse(await readFile(report)),ids=r.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(new RegExp('^'+prefix+'(\\d{2}):'))?.[1])).sort();
 if(!r.success||r.numPassedTests!==count||r.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:count},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('co0b_test_ids');return count;
}
try{
 const output=resolve(dir,'evidence.json'),testsPassed=await tests(test,'COB',13,{CWC_CO0B_EVIDENCE_PATH:output}),fresh=JSON.parse(await readFile(output)),summary=validateCo0bEvidence(fresh);
 const packed=packCo0b(fresh);compareCo0bReplay(unpackCo0b(packed),fresh);
 const r=process.argv.includes('--check')?JSON.parse(await readFile(path)):{schema:'cwc-co0b.validation.v1',date:'2026-11-12',document,heading,sectionDigest,sourceBindings,baselines,runtime,testsPassed,recordTestsPassed:12,packed,packedDigest:hash(packed),summary};
 if(r.schema!=='cwc-co0b.validation.v1'||r.document!==document||r.heading!==heading||r.sectionDigest!==sectionDigest||canonical(r.sourceBindings)!==canonical(sourceBindings)||canonical(r.baselines)!==canonical(baselines)||canonical(r.runtime)!==canonical(runtime)||r.testsPassed!==13||r.recordTestsPassed!==12||r.packedDigest!==hash(r.packed)||canonical(r.summary)!==canonical(summary))throw Error('co0b_record');
 compareCo0bReplay(unpackCo0b(r.packed),fresh);const candidate=resolve(dir,'candidate.json');await writeFile(candidate,JSON.stringify(r));
 const recordTestsPassed=await tests(recordTest,'CBR',12,{CWC_CO0B_RECORD_PATH:candidate});
 for(const [p,h]of Object.entries(sourceBindings))if(co0bSha(await readFile(p))!==h)throw Error('co0b_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r)+'\n');const {casesSummary,...brief}=summary;console.log(JSON.stringify({tests:testsPassed,recordTests:recordTestsPassed,...brief}));
}finally{await rm(dir,{recursive:true,force:true});}
