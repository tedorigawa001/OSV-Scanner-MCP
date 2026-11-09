/** Reproduce CWC-DP; --check revalidates source, time and semantic/count closure. */
import {validateCwcDP} from '../src/test/fixtures/gradleOwnedCwcDPValidation.mjs';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir,cpus,loadavg,platform,arch} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
const path='docs/validation/gradle-cwc-dp-2026-11-09.json',test='src/test/utils/gradleOwnedCwcDP.test.ts',sourceBindings={};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const m of b.toString('utf8').matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of [test,'scripts/check-cwc-dp.mjs','src/test/fixtures/gradleOwnedCwcDPValidation.d.mts','src/test/fixtures/gradleOwnedCwcDValidation.d.mts','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
// Bind only §9.122 itself (up to the next ### heading), so later sections do not invalidate this record.
const heading='### 9.122 CWC-DP：composedの費用分解と診断記録の限定対照',document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',section=designSection(await readFile(document,'utf8'),heading),sectionDigest=sha(section),
// The result table in §9.122 must be derived from the stored summary (quiet medians and paired saving, ms, 1 decimal).
tableRows=summary=>summary.map(s=>'| '+[s.workload,s.role,s.times.scalar.medianMs.toFixed(1),s.times.composed.medianMs.toFixed(1),s.times['diagnostic-quiet'].medianMs.toFixed(1),s.diagnosticSaving.medianMs.toFixed(1),s.costs.profiled.categories['canonical-hash'].medianExclusiveMs.toFixed(1),s.decision].join(' | ')+' |'),scope={inProcess:true,mockStorage:true,callThroughObserver:true,closedExportCounters:true,nativeIsolation:false,rssVerified:false,productionAdopted:false,continuousEightReads:false};
let r;if(process.argv.includes('--rebind-document')){
 // Re-bind the edited §9.122 to an existing measurement without re-measuring. Every other binding is still checked below.
 r=JSON.parse(await readFile(path,'utf8'));r.sectionDigest=sectionDigest;
}else if(process.argv.includes('--check'))r=JSON.parse(await readFile(path,'utf8'));else{const dir=await mkdtemp(resolve(tmpdir(),'cwc-dp-')),environment={node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,loadStart:loadavg()};try{const output=resolve(dir,'tests.json'),evidence=resolve(dir,'evidence.json');execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+output],{stdio:'pipe',timeout:240000,env:{...process.env,CWC_DP_EVIDENCE_PATH:evidence}});const result=JSON.parse(await readFile(output,'utf8'));if(!result.success||result.numPassedTests!==14)throw Error('cwc_dp_tests');for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('cwc_dp_changed_during_run');r={schema:'cwc-dp.validation.v1',date:'2026-11-09',runner:'node scripts/check-cwc-dp.mjs',environment:{...environment,loadEnd:loadavg()},sourceBindings,sectionDigest,testsPassed:14,measurement:JSON.parse(await readFile(evidence,'utf8')),scope};}finally{await rm(dir,{recursive:true,force:true});}}
if(JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.sectionDigest!==sectionDigest||r.testsPassed!==14||r.measurement.clock!=='real'||r.measurement.rounds!==3||r.measurement.rows.length!==240||JSON.stringify(r.scope)!==JSON.stringify(scope))throw Error('cwc_dp_bindings');
const summary=validateCwcDP(r.measurement.rows,r.measurement.rounds,['small','mid-2048','large-commit','large-payload','h0Sizes','singleLarge']);if(JSON.stringify(summary)!==JSON.stringify(r.measurement.summary))throw Error('cwc_dp_summary');
if(!process.argv.includes('--measure-only')&&tableRows(summary).some(row=>!section.includes(row)))throw Error('cwc_dp_document_table');
if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(r,null,2)+'\n');
console.log(JSON.stringify({rows:r.measurement.rows.length,completed:r.measurement.rows.filter(r=>r.status==='complete').length,summary,productionAdopted:false}));
