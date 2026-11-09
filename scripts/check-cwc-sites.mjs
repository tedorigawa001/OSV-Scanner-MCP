import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir,loadavg,cpus} from 'node:os';
import {resolve,dirname,relative} from 'node:path';
import {designSection} from '../src/test/fixtures/gradleOwnedCgpS0Bound.mjs';
import {validateSiteRows} from '../src/test/fixtures/gradleOwnedCwcSiteValidation.mjs';
const path='docs/validation/gradle-cwc-sites-2026-11-09.json',test='src/test/utils/gradleOwnedCwcSites.test.ts',sha=b=>createHash('sha256').update(b).digest('hex'),sourceBindings={};
async function bind(p){if(p in sourceBindings)return;const b=await readFile(p);sourceBindings[p]=sha(b);for(const m of b.toString('utf8').matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1].startsWith('.'))continue;let target=resolve(dirname(p),m[1]);if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';await bind(relative(process.cwd(),target));}}
for(const p of [test,'scripts/check-cwc-sites.mjs','src/test/fixtures/gradleOwnedCwcSiteValidation.d.mts','src/test/fixtures/gradleOwnedCwcDValidation.d.mts','package-lock.json','tsconfig.json','vitest.config.ts'])await bind(p);
const section=designSection(await readFile('docs/GRADLE_KOTLIN_PLUGIN_DECLARATIONS.md','utf8'),'### 9.123 CWC-Sites：private context・current入力・command／内容検証の呼出し位置別計測'),sectionDigest=sha(section);
// §9.123.1 table: per group, the range over the 12 conditions of median calls, exclusive ms and estimated observer ms.
const GROUPS=['private-context.rehash','current.hash','grant.context-input','current.input','command.validation','content.validation','gate.validation','other'];
const range=(values,digits)=>Math.min(...values).toFixed(digits)+'〜'+Math.max(...values).toFixed(digits);
const tableRows=summary=>GROUPS.map(g=>'| '+[g,range(summary.map(s=>s.costs[g].medianCalls),0),range(summary.map(s=>s.costs[g].medianExclusiveMs),1),range(summary.map(s=>s.costs[g].medianEstimatedObserverMs),1)].join(' | ')+' |');
// The runtime class witness is identical for every sites row of one run; store it once instead of 48 times.
function pack(r){const rows=r.measurement.rows,texts=new Set(rows.filter(x=>x.artifact).map(x=>JSON.stringify(x.artifact)));if(texts.size!==1)return r;const shared=JSON.parse([...texts][0]);return {...r,measurement:{...r.measurement,sharedArtifact:shared,rows:rows.map(x=>x.artifact?{...x,artifact:'shared'}:x)}};}
function unpack(r){const m=r.measurement;if(!m.sharedArtifact)return r;return {...r,measurement:{...m,rows:m.rows.map(x=>x.artifact==='shared'?{...x,artifact:m.sharedArtifact}:x)}};}
let r;if(process.argv.includes('--rebind-document')){
 // Re-bind the edited §9.123 to an existing measurement without re-measuring. Every other binding is still checked below.
 r=unpack(JSON.parse(await readFile(path,'utf8')));r.sectionDigest=sectionDigest;
}else if(process.argv.includes('--check'))r=unpack(JSON.parse(await readFile(path,'utf8')));else{const dir=await mkdtemp(resolve(tmpdir(),'cwc-sites-')),loadStart=loadavg();try{const output=resolve(dir,'tests.json'),evidence=resolve(dir,'evidence.json');execFileSync(process.execPath,['node_modules/vitest/vitest.mjs','run',test,'--maxWorkers=1','--reporter=json','--outputFile='+output],{stdio:'pipe',timeout:300000,env:{...process.env,CWC_SITES_EVIDENCE_PATH:evidence}});const t=JSON.parse(await readFile(output,'utf8'));if(!t.success||t.numPassedTests!==12)throw Error('site_tests');for(const [p,h]of Object.entries(sourceBindings))if(sha(await readFile(p))!==h)throw Error('site_source_changed');r={schema:'cwc-sites.validation.v1',date:'2026-11-09',runner:'node scripts/check-cwc-sites.mjs',environment:{node:process.version,cpu:cpus()[0]?.model,loadStart,loadEnd:loadavg()},sourceBindings,sectionDigest,testsPassed:12,measurement:JSON.parse(await readFile(evidence,'utf8')),scope:{inProcess:true,mockStorage:true,sourceMapped:false,loadedModuleAttestation:false,cacheImplemented:false,productionAdopted:false}};}finally{await rm(dir,{recursive:true,force:true});}}
if(JSON.stringify(sourceBindings)!==JSON.stringify(r.sourceBindings)||sectionDigest!==r.sectionDigest||r.testsPassed!==12||r.measurement.clock!=='real'||r.measurement.rounds!==3||r.measurement.rows.length!==144||r.scope.productionAdopted!==false)throw Error('site_bindings');const summary=validateSiteRows(r.measurement.rows,3,['small','mid-2048','large-commit','large-payload','h0Sizes','singleLarge']);if(JSON.stringify(summary)!==JSON.stringify(r.measurement.summary))throw Error('site_summary');if(!process.argv.includes('--measure-only')&&tableRows(summary).some(row=>!section.includes(row)))throw Error('site_document_table');
// Compact JSON: the traces alone are ~19 MB, and indentation nearly doubled the file.
if(!process.argv.includes('--check'))await writeFile(path,JSON.stringify(pack(r))+'\n');console.log(JSON.stringify({rows:r.measurement.rows.length,completed:r.measurement.rows.filter(r=>r.status==='complete').length,summary}));
