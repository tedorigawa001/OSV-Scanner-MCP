import {validateCwcD} from '../src/test/fixtures/gradleOwnedCwcDValidation.mjs';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
/** Re-execute CWC-D matrix; stored evidence is source-bound, not native attestation. */
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
const path='docs/validation/gradle-cwc-d-2026-11-09.json',test='src/test/utils/gradleOwnedCwcD.test.ts',sourceBindings={};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const m of b.toString('utf8').matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let next=resolve(dirname(p),m[1]);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';await bind(relative(process.cwd(),next));}}
for(const p of ['src/test/fixtures/gradleOwnedCwcDValidation.d.mts',test,'scripts/check-cwc-d.mjs','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
// Bind only §9.121 itself (up to the next ### heading), so later sections do not invalidate this record.
const document='docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md',heading='### 9.121 CWC-D：共通条件での計画込み総時間・観測費用・完了率の限定比較',section=designSection(await readFile(document,'utf8'),heading),sectionDigest=sha(section);
// The result table in §9.121 must be derived from the stored summary (quiet medians, ms, 1 decimal).
const tableRows=summary=>summary.map(s=>'| '+[s.workload,s.role,...['scalar','reference','composed'].map(a=>s.quietMedianMs[a].toFixed(1)),s.bridgeMedianMs.toFixed(1),s.decision].join(' | ')+' |');
let r;if(process.argv.includes('--rebind-document')){
 // Re-bind the edited §9.121 to an existing measurement without re-measuring. Every other binding is still checked below.
 r=JSON.parse(await readFile(path,'utf8'));r.sectionDigest=sectionDigest;await writeFile(path,JSON.stringify(r,null,2)+'\n');
}else if(process.argv.includes('--check'))r=JSON.parse(await readFile(path,'utf8'));else{const dir=await mkdtemp(resolve(tmpdir(),'cwc-d-'));try{const output=resolve(dir,'tests.json'),evidence=resolve(dir,'evidence.json');execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+output],{stdio:'pipe',timeout:240000,env:{...process.env,CWC_D_EVIDENCE_PATH:evidence}});const result=JSON.parse(await readFile(output,'utf8'));if(!result.success||result.numPassedTests!==15)throw Error('cwc_d_tests');for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('cwc_d_changed_during_run');r={schema:'cwc-d.validation.v1',date:'2026-11-09',runner:'node scripts/check-cwc-d.mjs',sourceBindings,sectionDigest,testsPassed:15,measurement:JSON.parse(await readFile(evidence,'utf8')),scope:{inProcess:true,mockStorage:true,nativeIsolation:false,rssVerified:false,productionAdopted:false,continuousEightReads:false}};await writeFile(path,JSON.stringify(r,null,2)+'\n');}finally{await rm(dir,{recursive:true,force:true});}}
if(JSON.stringify(r.sourceBindings)!==JSON.stringify(sourceBindings)||r.sectionDigest!==sectionDigest||r.testsPassed!==15||r.measurement.rows.length!==384||r.measurement.summary.length!==12||r.measurement.clock!=='real'||r.scope.productionAdopted!==false)throw Error('cwc_d_bindings');
const summary=validateCwcD(r.measurement.rows,r.measurement.rounds,['small','mid-2048','large-commit','large-payload','h0Sizes','singleLarge']);if(JSON.stringify(summary)!==JSON.stringify(r.measurement.summary))throw Error('cwc_d_summary');
if(!process.argv.includes('--measure-only')&&tableRows(summary).some(row=>!section.includes(row)))throw Error('cwc_d_document_table');
console.log(JSON.stringify({rows:r.measurement.rows.length,summary:r.measurement.summary,productionAdopted:false}));
