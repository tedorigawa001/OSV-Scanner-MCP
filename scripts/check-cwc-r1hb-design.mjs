/** R1-HB document/source/typed-arithmetic checks only. Never loads an admitted core or verifies a charge certificate. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,dirname,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {co0Canonical as canonical} from '../src/test/fixtures/gradleOwnedCwcCo0Validation.mjs';
import {R1HB_DESIGN,R1HB_REGIONS,R1HB_SOURCE_FACTS,R1HB_COMPONENTS,r1hbEnvelope,r1hbTopology} from '../src/test/fixtures/gradleOwnedCwcR1hbDesign.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),path='docs/validation/gradle-cwc-r1hb-design-2026-11-13.json';
const document={path:'docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading:'### 9.152 R1-HB：所有port／observerの採用境界と保持charge証拠（設計）'};
const section=designSection(await readFile(document.path,'utf8'),document.heading);document.sha256=sha(section);
const extract=p=>[...section.matchAll(new RegExp('^\\| ('+p+') \\| (.+) \\|$','gm'))].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
const conditions=extract('HBC\\d{2}'),steps=extract('HB-[1-4]');if(canonical(conditions.map(x=>x.id))!==canonical(Array.from({length:40},(_,i)=>'HBC'+String(i+1).padStart(2,'0')))||canonical(steps.map(x=>x.id))!==canonical(['HB-1','HB-2','HB-3','HB-4']))throw Error('r1hb_conditions');
const baselines=[],oldSources={};for(const p of ['docs/validation/gradle-cwc-r1h0-2026-11-13.json','docs/validation/gradle-cwc-r1h-design-2026-11-13.json']){const b=await readFile(p),r=JSON.parse(b);baselines.push({path:p,sha256:sha(b)});for(const [p,h]of Object.entries(r.sourceBindings)){if(p in oldSources&&oldSources[p]!==h)throw Error('r1hb_source_conflict');oldSources[p]=h;}}
const sourceBindings={};async function bind(p){if(p in sourceBindings)return;const b=await readFile(p),h=sha(b);if(p in oldSources&&oldSources[p]!==h)throw Error('r1hb_legacy_changed_'+p);sourceBindings[p]=h;if(p.startsWith('node_modules/'))return;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"\n]+)['"]/g)){if(!m[1].startsWith('.'))continue;let q=resolve(dirname(p),m[1]);if(q.endsWith('.js'))q=q.slice(0,-3)+'.ts';await bind(relative(process.cwd(),q));}}
const test='src/test/utils/gradleOwnedCwcR1hbDesign.test.ts';for(const p of [test,'scripts/check-cwc-r1hb-design.mjs','src/test/fixtures/gradleOwnedCwcR1hbDesign.d.mts',...Object.keys(oldSources)])await bind(p);
const sourcePath='src/test/fixtures/gradleOwnedCwcR1h.ts',source=await readFile(sourcePath,'utf8');
const sourceAudit=[['descriptor-in-make','define(out,i,{value:fn(i)'],['two-bodies','for(let i=0;i<2;i++)'],['handle-array','freeze(make(8,'],['reference-array','refs:make(48,'],['body-descriptor','define(bodies,bodies.length,'],['pre-guard-callback','window(h:R1hHandle']].map(([id,needle])=>{const start=source.indexOf(needle);if(start<0)throw Error('r1hb_anchor_'+id);return {id,path:sourcePath,needle,line:source.slice(0,start).split('\n').length,sourceDigest:sha(source),scope:'manual-source-site-not-allocation-proof'};});
const q=upper=>({unit:'logical-byte',upper}),unknown={activeReads:4,epochReadLimit:64,entryLimit:256,refusalLimit:64,parentLimit:q(1048576),...Object.fromEntries(R1HB_COMPONENTS.map(k=>[k,q(null)]))},finite={...unknown,globalResident:q(4096),readReusable:q(0),readEpoch:q(8192),entryEpoch:q(16),refusalEpoch:q(0),framesReusable:q(8192),bootstrapReusable:q(8192)};
const runtime={node:process.version,platform:process.platform,arch:process.arch,nodeBinaryDigest:sha(await readFile(process.execPath))};
const record={schema:'cwc-r1hb.design-record.v1',date:'2026-11-13',status:'design-only',document,baselines,sourceBindings,runtime,contract:R1HB_DESIGN,regions:R1HB_REGIONS,sourceFacts:R1HB_SOURCE_FACTS,sourceAudit,
 arithmetic:{unknown:r1hbEnvelope(unknown),hypotheticalFit:r1hbEnvelope(finite),hypotheticalOver:r1hbEnvelope({...finite,entryEpoch:q(32)})},topology:r1hbTopology({entry:'core',modules:[{id:'core',role:'core',artifact:'a'.repeat(64),edges:['port','pure']},{id:'port',role:'reader-port',artifact:'b'.repeat(64),edges:[]},{id:'pure',role:'pure-helper',artifact:'c'.repeat(64),edges:[]}]}),conditions,steps,designChecksPassed:24,runtimeRegressionsExecuted:false};
const dir=await mkdtemp(resolve(tmpdir(),'cwc-r1hb-design-'));
try{
 if(process.argv.includes('--check')&&canonical(JSON.parse(await readFile(path)))!==canonical(record))throw Error('r1hb_record');
 const candidate=resolve(dir,'candidate.json'),report=resolve(dir,'tests.json');await writeFile(candidate,JSON.stringify(record));
 try{execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+report],{stdio:'pipe',timeout:120000,maxBuffer:8388608,env:{...process.env,CWC_R1HB_DESIGN_RECORD_PATH:candidate}});}catch(e){let failed='';try{failed=JSON.stringify(JSON.parse(await readFile(report)).testResults.flatMap(t=>t.assertionResults.filter(a=>a.status==='failed').map(a=>({name:a.fullName,messages:a.failureMessages}))));}catch{}throw Error('r1hb_tests '+failed+' '+String(e.stderr??''),{cause:e});}
 const t=JSON.parse(await readFile(report)),ids=t.testResults.flatMap(t=>t.assertionResults.map(a=>a.fullName.match(/^RHBD(\d{2}):/)?.[1])).sort();if(!t.success||t.numPassedTests!==24||t.numFailedTests!==0||canonical(ids)!==canonical(Array.from({length:24},(_,i)=>String(i+1).padStart(2,'0'))))throw Error('r1hb_test_ids');
 for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('r1hb_source_changed_'+p);
 if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({status:'design-only',designChecks:24,regions:18,sourceSites:6,sources:Object.keys(sourceBindings).length,plannedRuntimeConditions:40,plannedSteps:4,runtimeRegressionsExecuted:false,runtimeAdmitted:false}));
}finally{await rm(dir,{recursive:true,force:true});}
