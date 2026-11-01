/** Test-only evidence validator shared by native runner and result consolidator. */
export const supplierSourcePaths=['src/test/gradle/kotlinPipelineSupplier.integration.test.ts','src/test/fixtures/gradle-kotlin-supplier.init.gradle','src/test/fixtures/gradleKotlinSupplierProof.mjs','src/test/fixtures/gradleKotlinSupplierProof.d.mts'];
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=reason=>{throw new Error(reason);};
const hashMap=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length>0&&Object.values(value).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v));
const sameMap=(a,b)=>hashMap(a)&&hashMap(b)&&equal(Object.entries(a).sort(),Object.entries(b).sort());
export function verifySupplierProof(data,approval){
 if(data?.schema!=='osv-mcp.kotlin-supplier-proof-v2'||!['8.11.1','9.2.1'].includes(data.gradleVersion)||data.gradleVersion!==approval.gradleVersion||data.consumerDSL!==approval.consumerDSL||!['Groovy','Kotlin'].includes(data.consumerDSL))fail('supplier_identity_mismatch');
 if(!sameMap(data.sourcesSha256,approval.sourcesSha256))fail('supplier_source_mismatch');
 if(!hashMap(data.fixtureInputsSha256)||!Array.isArray(data.reports)||data.reports.length!==2)fail('supplier_observation_invalid');
 const ids=new Set();
 for(let i=0;i<2;i++){
  const r=data.reports[i];
  if(r?.gradleVersion!==data.gradleVersion||r.consumerDSL!==data.consumerDSL||r.observe!==Boolean(i)||typeof r.runId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.runId)||ids.has(r.runId))fail('supplier_identity_mismatch');
  ids.add(r.runId);
  if(r.collectorSha256!==data.sourcesSha256['src/test/fixtures/gradle-kotlin-supplier.init.gradle'])fail('supplier_source_mismatch');
  if(!sameMap(r.fixtureInputsSha256,data.fixtureInputsSha256))fail('supplier_fixture_mismatch');
  if(!Array.isArray(r.trace)||r.trace.some(x=>!['libraries','before-compile','after-compile','after-observer'].includes(x)))fail('supplier_trace_invalid');
 }
 const [control,observed]=data.reports.map(r=>r.trace);
 const prefix=t=>t.slice(0,t.indexOf('after-compile')+1);
 const expectedPrefix=['libraries','before-compile','libraries','libraries','after-compile'];
 if(!equal(prefix(control),expectedPrefix)||!equal(prefix(observed),expectedPrefix)||!equal(control.slice(expectedPrefix.length),['after-observer'])||!equal(observed.slice(expectedPrefix.length),['libraries','after-observer']))fail('supplier_trace_invalid');
 return {controlCalls:3,observedCalls:4,extraPhase:'post-compile'};
}
export function verifySupplierMatrix(data,approval){
 if(data?.schema!=='osv-mcp.kotlin-supplier-matrix-v2'||data.gradleVersion!==approval.gradleVersion||!Array.isArray(data.cases)||data.cases.length!==2||new Set(data.cases.map(c=>c.consumerDSL)).size!==2)fail('supplier_matrix_incomplete');
 return ['Groovy','Kotlin'].map(consumerDSL=>verifySupplierProof(data.cases.find(c=>c.consumerDSL===consumerDSL),{...approval,consumerDSL}));
}
