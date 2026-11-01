/** Consolidates native observations, never creates a successful observation from a planned case. */
import { readFile,writeFile,readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {supplierSourcePaths,verifySupplierMatrix} from "../fixtures/gradleKotlinSupplierProof.mjs";
const [prefix,supplierPrefix,output]=process.argv.slice(2);
// Source paths are repository-relative regardless of the caller's working directory.
const repo=fileURLToPath(new URL("../../../",import.meta.url));
const repoFile=f=>path.join(repo,f);
if(!prefix||!supplierPrefix||!output)throw new Error("usage: node gradleKotlinPipelineResults.mjs <observation-prefix> <supplier-prefix> <output>");
const files=(await readdir(path.dirname(prefix))).filter(n=>n.startsWith(path.basename(prefix)+'-')&&n.endsWith('.json')).sort();
const observations=[],sourcesSha256={},toolchainProfiles={};
for(const f of files){
 const r=JSON.parse(await readFile(path.join(path.dirname(prefix),f),'utf8'));
 if(!r.pipeline)throw new Error('missing-pipeline-observation');
 if(!r.nativePackageMutation){
  const expected=['META-INF/MANIFEST.MF','settings.txt','META-INF/services/proof.Service','META-INF/gradle-plugins/proof.convention.properties','.kotlin_module','.class'];
  const checks=r.pipeline.expectedEntryRejections;
  if(!Array.isArray(checks)||checks.length!==expected.length||new Set(checks.map(c=>c.suffix)).size!==expected.length||checks.some(c=>!expected.includes(c.suffix)||c.complete!==false||!Array.isArray(c.reasons)||!c.reasons.includes('kotlin_package_origin_incomplete')))throw new Error('missing-entry-regression-evidence');
 }

 const c=r.pipeline.receipts.find(t=>t.task===':compileKotlin');
 const selected=c.selectedPlugins.filter(e=>/KotlinPluginWrapper|KotlinDslPlugin_Decorated/.test(e.type));
 if(selected.length!==2||selected.some(e=>!e.toolchainId)||c.libraries.some(e=>!e.approved)||c.compilerClasspath.some(e=>!e.approved))throw new Error('selected-implementation-unbound');
 for(const [n,h]of Object.entries(r.proofSourcesSha256)){
  if(sourcesSha256[n]&&sourcesSha256[n]!==h)throw new Error('mixed-source-revisions');
  sourcesSha256[n]=h;
 }
 toolchainProfiles[r.toolchain.approvedDigest]=r.toolchain.profile;
 observations.push({file:f,gradleVersion:r.gradleVersion,source:r.pluginSource,invocationId:r.invocationId,inputs:r.inputs,
  nativePackageMutation:r.nativePackageMutation,pipeline:r.pipeline,kotlinPackage:r.kotlinPackage,kotlinStages:r.kotlinStages,
  builds:r.builds,runtime:r.runtime,loaderProfile:r.loaderProfile,
  graph:r.projects.registered.graph,providerTrace:r.projects.registered.trace,providerCalls:r.projects.registered.producerCalls,
  applications:r.projects.registered.applications.map(a=>({implementationClass:a.implementationClass,descriptorMatches:a.descriptorMatches,loadEvidence:a.loadEvidence})),
  finalContractAdoption:false});
}
const suppliers=[];
const supplierApprovalSources=Object.fromEntries(await Promise.all(supplierSourcePaths.map(async f=>[f,createHash('sha256').update(await readFile(repoFile(f))).digest('hex')])));
for(const v of ['8.11.1','9.2.1']){
 const observed=JSON.parse(await readFile(supplierPrefix+'-'+v+'.json','utf8'));
 const decisions=verifySupplierMatrix(observed,{gradleVersion:v,sourcesSha256:supplierApprovalSources});
 suppliers.push({...observed,decisions});
 for(const c of observed.cases)for(const [f,h]of Object.entries(c.sourcesSha256)){
  if(sourcesSha256[f]&&sourcesSha256[f]!==h)throw new Error('mixed-source-revisions');
  sourcesSha256[f]=h;
 }
}
const extraSources=['src/test/gradle/kotlinPipeline.test.ts','src/test/gradle/kotlinSupplierProof.test.ts','src/test/manual/gradleKotlinPipelineResults.mjs'];
for(const f of extraSources)sourcesSha256[f]=createHash('sha256').update(await readFile(repoFile(f))).digest('hex');
const normal=observations.filter(r=>!r.nativePackageMutation);
for(const v of ['8.11.1','9.2.1'])if(normal.filter(r=>r.gradleVersion===v).length!==8)throw new Error('incomplete-native-matrix');
for(const [name,expected]of Object.entries(sourcesSha256)){
 const f=name.includes('/')?name:(name.endsWith('.test.ts')?'src/test/gradle/':'src/test/fixtures/')+name;
 const actual=createHash('sha256').update(await readFile(repoFile(f))).digest('hex');
 if(actual!==expected)throw new Error('observation-source-changed: '+f);
}
for(const observation of observations){
 const supplier=suppliers.find(s=>s.gradleVersion===observation.gradleVersion);
 const unchanged=supplier.decisions.every(d=>d.controlCalls===d.observedCalls);
 observation.contractDecision={adopted:false,status:'not-adopted-in-proof',reason:'kotlin_pipeline_recipe_unsupported',
  supplierTraceUnchanged:unchanged,additionalBlockers:observation.pipeline.recipeStatus==='kotlin_pipeline_recipe_unsupported'?['plugins-block-public-role-collection-unavailable']:[],
  note:'Old helper/loader candidates in applications are diagnostics and do not imply the new pipeline contract is satisfied.'};
 if(unchanged)throw new Error('supplier experiment changed; review adoption decision');
}
let preReview;
try{
 const previousBytes=await readFile(output),previous=JSON.parse(previousBytes.toString());
 preReview=previous.preReview??{recordedAt:previous.recordedAt,baselineRevision:previous.baselineRevision,recordSha256:createHash('sha256').update(previousBytes).digest('hex'),sourcesSha256:previous.sourcesSha256,
  normalNativeMatrix:previous.scope?.normalNativeMatrix,totalObservations:previous.observations?.length,
  note:'Initial observations before expected-entry completeness and supplier observation-time provenance fixes. Supplier source hashes/versions were not bound at observation time.'};
}catch(error){if(error.code!=='ENOENT')throw error;}
const result={schema:'osv-mcp.gradle-kotlin-pipeline-public-api-proof',recordedAt:new Date().toISOString(),baselineRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),nodeVersion:process.version,
 scope:{productionChanged:false,productionAdoptionEnabled:false,normalNativeMatrix:normal.length,compiler:'in-process',incremental:false,offline:true,configurationCache:false,parallel:false,
  notProven:['independent executed/loaded bytecode','unchanged evaluation of arbitrary internal/built-in suppliers','complete v4 schema/trust/static import','all KP01-KP47 conditions','three-tool OSV integration']},
 sourcesSha256,toolchainProfiles,suppliers,observations,...(preReview?{preReview}:{})};
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,normal:normal.length,observations:observations.length,suppliers:suppliers.length}));
