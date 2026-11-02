import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {verifyBuildCase,createJar,inspectJar} from '../fixtures/ownedJavacContract.mjs';
import {verifyJavacRecord,verifyJavacTuple} from '../fixtures/ownedJavacProof.mjs';
import {buildCases,javacRecipe} from '../fixtures/ownedJavacExpected.mjs';
import {objectDigest,sha256} from '../fixtures/ownedManifestContract.mjs';
const load=()=>JSON.parse(readFileSync('docs/validation/gradle-owned-javac-construction-2026-11-02.json','utf8'));
const clone=(name='normal-inner')=>{const t=structuredClone(load().cases[0]);return {t,c:t.report.cases.find((x:any)=>x.case===name)};};
it('BM06 refuses success without a fresh output root and bound construction evidence',()=>{
 expect(()=>verifyBuildCase({case:'normal-inner',buildState:'completed'},{})).toThrow('owned_javac_');
});
it('replays source-bound native matrices and computes counts from verified evidence',()=>{
 const r=load();expect(verifyJavacRecord(r)).toEqual(r.scope);expect(r.scope.btaCalls).toBe(0);expect(r.scope.productionAdopted).toBe(0);expect(r.scope.naturalReceipts).toBe(0);
});
for(const version of ['8.11.1','9.2.1'])for(const dsl of ['Groovy','Kotlin'])describe(`${version}/${dsl}`,()=>{
 for(const name of Object.keys(buildCases))it('BM04–BM07/BM17 saved native '+name,()=>{const t=load().cases.find((t:any)=>t.gradleVersion===version&&t.dsl===dsl),c=t.report.cases.find((c:any)=>c.case===name);expect(verifyBuildCase(c,t.policy).productionAdopted).toBe(0);});
});
it('BM17 requires compiler evidence reached before packaging failure',()=>{
 const {t,c}=clone('jar-resource');for(const k of ['compiler','outputStart','inputManifest','inputManifestDigest','outputSet','outputSetDigest','packaging'])delete c[k];c.compilerCalls=0;expect(()=>verifyBuildCase(c,t.policy)).toThrow('owned_javac_');
});
for(const key of ['createdNew','path','token','checks'])it('BM06 rejects missing output start '+key,()=>{const {t,c}=clone();delete c.outputStart[key];expect(()=>verifyBuildCase(c,t.policy)).toThrow();});
it('BM04 refuses self-resealed source changes and digest rebasing',()=>{
 const {t,c}=clone();const f=c.inputManifest.sourceInventory.files[0];const b=Buffer.from('public class Driver {}\n');Object.assign(f,{bytes:b.toString('base64'),sha256:sha256(b),size:b.length});c.inputManifestDigest=objectDigest(c.inputManifest);c.compiler.inputDigest=c.inputManifestDigest;expect(()=>verifyBuildCase(c,t.policy)).toThrow('source_mismatch');
});
for(const key of ['arguments','environment','emptyInputs','executorHashes','nodeRuntime','toolchain'])it('BM05 refuses changed recipe input '+key,()=>{const {t,c}=clone();c.inputManifest[key]={unregistered:true};c.inputManifestDigest=objectDigest(c.inputManifest);c.compiler.inputDigest=c.inputManifestDigest;expect(()=>verifyBuildCase(c,t.policy)).toThrow();});
it('BM04 requires a post-compiler comparison against the original seal',()=>{const {t,c}=clone('source-post-compile');c.postInputs.matched=true;c.postInputs.digest=c.inputManifestDigest;c.postInputs.currentInventory=c.inputManifest.sourceInventory;expect(()=>verifyBuildCase(c,t.policy)).toThrow('claim_mismatch');});
it('BM06 keeps the previous root unchanged and binds it to the actual prior output set',()=>{const r=load(),t=r.cases[0],c=t.report.cases.find((x:any)=>x.case==='rebuild-no-removed');c.previousRootCheck.before={directories:[],files:[]};c.previousRootCheck.after=c.previousRootCheck.before;expect(()=>verifyJavacTuple(t)).toThrow('claim_mismatch');});
for(const key of ['inputManifest','outputSet','buildReceipt','index','execution'])it('BM06/BM17 refuses missing success evidence '+key,()=>{const {t,c}=clone();delete c[key];expect(()=>verifyBuildCase(c,t.policy)).toThrow();});
it('BM17 never adopts partially compiled classes as a successful build or launches them',()=>{
 const {t,c}=clone('compiler-partial');expect(c.partialOutput.files.map((f:any)=>f.path)).toContain('Good.class');c.buildState='completed';expect(()=>verifyBuildCase(c,t.policy)).toThrow();
 const other=clone('compiler-partial');other.c.artifactCalls=1;other.c.execution={};expect(()=>verifyBuildCase(other.c,other.t.policy)).toThrow();
});
for(const name of ['processor-enabled','implicit-source-enabled','unregistered-argfile','unregistered-generator'])it('BM05 records no source capture/compiler for unsupported input '+name,()=>{const {t,c}=clone(name);expect(c.sourceCaptures).toBe(0);c.sourceCaptures=1;expect(()=>verifyBuildCase(c,t.policy)).toThrow();});
for(const key of ['failureStage','failurePhase','failureReason','buildState','exported'])it('BM17 refuses rewritten failed state '+key,()=>{const {t,c}=clone('state-save-failed');c[key]=key==='exported'?true:'completed';expect(()=>verifyBuildCase(c,t.policy)).toThrow();});
for(const name of ['jar-resource','jar-missing-manifest','jar-duplicate','jar-traversal','jar-collision','jar-budget','jar-provenance'])it('BM07 rechecks the actual refused archive '+name,()=>{const {t,c}=clone(name);const good=clone().c.packaging.jar;c.packaging.jar=good;expect(()=>verifyBuildCase(c,t.policy)).toThrow('claim_mismatch');});
it('BM07 refuses changed entry origins even with an updated receipt digest',()=>{const {t,c}=clone();c.packaging.entries[0].origin={kind:'compiler-output',digest:c.outputSetDigest};c.buildReceiptDigest=objectDigest(c.buildReceipt);expect(()=>verifyBuildCase(c,t.policy)).toThrow('inventory_mismatch');});
it('BM07 treats the raw JAR digest as artifact identity and never normalizes its bytes',()=>{const {t,c}=clone();c.packaging.jar.bytes=Buffer.concat([Buffer.from(c.packaging.jar.bytes,'base64'),Buffer.from('extra')]).toString('base64');expect(()=>verifyBuildCase(c,t.policy)).toThrow('content_mismatch');});
it('BM06 refuses swapping another invocation output after rehashing it',()=>{const {t,c}=clone();c.outputSet.buildInvocationId='other';c.outputSetDigest=objectDigest(c.outputSet);expect(()=>verifyBuildCase(c,t.policy)).toThrow('claim_mismatch');});
it('BM17 counts actual Java runs even if metadata saving fails, without emitting a receipt',()=>{for(const name of ['index-save-failed','state-save-failed']){const {t,c}=clone(name);expect(c.artifactCalls).toBe(1);expect(c).not.toHaveProperty('buildReceipt');delete c.execution;c.artifactCalls=0;expect(()=>verifyBuildCase(c,t.policy)).toThrow();}});
it('rejects forged tuple API artifact, task witness and inflated aggregate counts',()=>{
 const a=load();a.cases[0].gradle.gradleApiSha256=sha256('other API');expect(()=>verifyJavacRecord(a,{currentSources:false})).toThrow('profile_mismatch');
 const b=load();b.cases[0].gradle.taskState.skipped=true;expect(()=>verifyJavacRecord(b,{currentSources:false})).toThrow();
 const c=load();c.scope.compilerInvocations++;expect(()=>verifyJavacRecord(c,{currentSources:false})).toThrow();
});
it('BM07 validates ZIP headers, CRC and decompression budgets without extracting paths',()=>{
 const bytes=createJar([{path:'META-INF/MANIFEST.MF',bytes:Buffer.from(javacRecipe.manifest)},{path:'日本語 空白/resource',bytes:Buffer.from('bytes')}]);expect(inspectJar(bytes)).toHaveLength(2);
 const corrupt=Buffer.from(bytes);corrupt[30+Buffer.byteLength('META-INF/MANIFEST.MF')]!^=1;expect(()=>inspectJar(corrupt)).toThrow();
 for(const p of ['../x','/x','C:/x','x\\y','a//b'])expect(()=>inspectJar(createJar([{path:p,bytes:Buffer.from('x')}]))).toThrow('path_invalid');
 expect(()=>inspectJar(createJar([{path:'a',bytes:Buffer.from('a')},{path:'a/b',bytes:Buffer.from('b')}]))).toThrow('inventory_mismatch');
});
it('BM06 binds the actually deleted source to the prior cohort without altering the old output',()=>{const r=load(),t=r.cases[0],c=t.report.cases.find((x:any)=>x.case==='rebuild-no-removed');c.sourceRemoval.sha256=sha256('unrelated source');expect(()=>verifyJavacTuple(t)).toThrow('claim_mismatch');});
it('BM17 allows fresh retry after partial failure while retaining the original quarantine',()=>{const {t,c}=clone('retry-fresh');expect(verifyBuildCase(c,t.policy).completed).toBe(1);expect(c.outputSet.inventory.files.some((f:any)=>f.path==='Good.class')).toBe(false);c.previousRootCheck.after.files=[];expect(()=>verifyBuildCase(c,t.policy)).toThrow('claim_mismatch');});
for(const key of ['outputSet','outputStart','compiler','postInputs','packaging','execution'])it('rejects unknown typed construction fields '+key,()=>{const {t,c}=clone();c[key].unknown=true;expect(()=>verifyBuildCase(c,t.policy)).toThrow('schema_invalid');});
it('BM04 refuses a claimed post-compiler check moved into the precompiler phase',()=>{const {t,c}=clone();c.postInputs.point='precompiler';expect(()=>verifyBuildCase(c,t.policy)).toThrow('claim_mismatch');});
import {verifyRequestedRecipe} from '../fixtures/ownedJavacContract.mjs';
it('BM05 validates concrete requested recipe options before any input capture',()=>{expect(verifyRequestedRecipe(structuredClone(javacRecipe))).toBe(true);for(const patch of [{processorPolicy:'full'},{sourcepath:['src']},{generators:['unregistered']},{argumentFile:'unknown.args'}])expect(()=>verifyRequestedRecipe({...structuredClone(javacRecipe),...patch})).toThrow('recipe_invalid');});
