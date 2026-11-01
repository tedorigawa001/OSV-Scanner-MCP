/** Test-only full-reader evidence; no production eligibility is conferred. */
export const observerSourcePaths=['src/test/gradle/kotlinObserver.integration.test.ts','src/test/fixtures/gradle-kotlin-observer.init.gradle','src/test/fixtures/gradleKotlinObserverProof.mjs','src/test/fixtures/gradleKotlinObserverProof.d.mts','src/test/fixtures/gradlePluginJarProof.ts','src/test/fixtures/gradlePluginLoadProof.ts','src/utils/gradleJson.ts','package-lock.json'];
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=reason=>{throw new Error(reason);};
const map=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length>0&&Object.values(value).every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v));
const same=(a,b)=>map(a)&&map(b)&&equal(Object.entries(a).sort(),Object.entries(b).sort());
export function compareObserverTraces(control,observed){
 const extraEvaluations=observed.filter(e=>e.event.startsWith('supplier:')&&e.phase.startsWith('observer:'));
 return {equal:equal(control,observed),extraEvaluations,outsideObserverChanged:!equal(control,observed.filter(e=>!extraEvaluations.includes(e)))};
}
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const empty=v=>object(v)&&Object.keys(v).length===0;
const missing=()=>fail('observer_read_inventory_incomplete');
function files(v,allowEmpty=false){
 if(!Array.isArray(v)||!allowEmpty&&!v.length)missing();
 for(const f of v)if(!object(f)||typeof f.id!=='string'||!f.id||typeof f.name!=='string'||!f.name||!(f.size===null&&f.sha256===null||Number.isSafeInteger(f.size)&&f.size>=0&&hash(f.sha256)))fail('observer_read_evidence_invalid');
}
function verifyReceipts(observed){
 const expected=['pre-compileKotlin','compileKotlin','compileJava','pluginDescriptors','processResources','jar'];
 if(!Array.isArray(observed.receipts)||observed.receipts.length!==expected.length||new Set(observed.receipts.map(r=>r?.task)).size!==expected.length)missing();
 const get=t=>{const r=observed.receipts.find(r=>r.task===t);if(!r)missing();return r;};
 const pre=get('pre-compileKotlin');
 if(!object(pre.classes)||!object(pre.javaSources))missing();
 if(!empty(pre.classes)||!empty(pre.javaSources))fail('observer_precondition_invalid');
 for(const t of expected.slice(1)){
  const r=get(t);if(!object(r.readSlots)||!Object.hasOwn(r,'didWork')||!Object.hasOwn(r,'noSource'))missing();
  const java=t==='compileJava';
  if(r.didWork!==!java||r.noSource!==java)fail('observer_execution_invalid');
  files(r.readSlots.taskInputs,java||t==='pluginDescriptors');files(r.readSlots.taskOutputs);
 }
 const compile=get('compileKotlin');
 for(const slot of ['libraries','snapshots','compilerClasspath'])files(compile.readSlots[slot]);
 const plugins=compile.readSlots.plugins;
 if(!Array.isArray(plugins)||!plugins.length)missing();
 if(plugins.some(p=>!object(p)||typeof p.type!=='string'||!p.type||!(p.origin===null||typeof p.origin==='string')))fail('observer_read_evidence_invalid');
 if(!object(compile.settings)||['incremental','strategy','fallback'].some(k=>!Object.hasOwn(compile.settings,k)))missing();
 if(compile.settings.incremental!==false||compile.settings.strategy!=='IN_PROCESS'||compile.settings.fallback!==false)fail('observer_execution_invalid');
 const java=get('compileJava');if(!object(java.javaOutputs))missing();if(!empty(java.javaOutputs))fail('observer_precondition_invalid');
 const declarations=get('pluginDescriptors').readSlots.declarations;
 if(!Array.isArray(declarations))missing();
 if(declarations.length!==1||declarations[0]?.id!=='proof'||declarations[0]?.implementationClass!=='proof.Proof')fail('observer_declaration_invalid');
 const jar=get('jar');
 if(!object(jar.manifest)||!object(jar.archive)||!Object.hasOwn(jar,'temporaryRoot'))missing();
 if(jar.temporaryRoot!=='jar'||!Number.isSafeInteger(jar.manifest.size)||jar.manifest.size<=0||!hash(jar.manifest.sha256)||typeof jar.archive.name!=='string'||!jar.archive.name.endsWith('.jar')||!hash(jar.archive.sha256))fail('observer_read_evidence_invalid');
 const manifests=jar.readSlots.taskInputs.filter(f=>f.id==='build-logic/build/tmp/jar/MANIFEST.MF');
 const archives=jar.readSlots.taskOutputs.filter(f=>f.name===jar.archive.name);
 if(manifests.length!==1||manifests[0].size!==jar.manifest.size||manifests[0].sha256!==jar.manifest.sha256||archives.length!==1||archives[0].sha256!==jar.archive.sha256)fail('observer_read_evidence_invalid');
 const entry=observed.jarEntries.filter(e=>e.path==='META-INF/MANIFEST.MF');
 if(entry.length!==1||entry[0].sha256!==jar.manifest.sha256||entry[0].size!==jar.manifest.size)fail('observer_read_evidence_invalid');
}
function verifyPolicy(run,mode){
 const trace=run.trace,firstTask=trace.findIndex(e=>e.event.startsWith('task:before:'));
 const window=(prefix,name)=>{
  const begin=trace.map((e,i)=>({e,i})).filter(x=>x.e.event===prefix+':begin:'+name),end=trace.map((e,i)=>({e,i})).filter(x=>x.e.event===prefix+':end:'+name);
  if(begin.length!==1||end.length!==1||begin[0].i>=end[0].i||end[0].i>=firstTask||begin[0].e.phase!==end[0].e.phase||begin[0].e.phase!=='configuration-or-unbound')fail('observer_policy_invalid');
  if(trace.slice(begin[0].i+1,end[0].i).some(e=>e.event.startsWith('supplier:')))fail('observer_policy_early_evaluation');
  return [begin[0].i,end[0].i];
 };
 const groups={compilerClasspath:['compilerClasspath'],compileKotlin:['libraries','compileInput','compileOutput'],jar:['jarSource','jarInput','jarOutput']};
 for(const [group,roles]of Object.entries(groups)){
  const [start,finish]=window('policy',group);
  for(const role of roles){
   const [begin,end]=window('registration',role);
   if(begin<=start||end>=finish)fail('observer_policy_invalid');
   const calls=trace.map((e,i)=>({e,i})).filter(x=>x.e.event==='supplier:'+role);
   if(calls.some(x=>x.i<end)||mode!=='raw'&&calls.length!==1)fail('observer_policy_invalid');
  }
 }
}
export function verifyObserverCase(data,approval){
 if(data?.schema!=='osv-mcp.kotlin-full-observer-case-v2'||!['raw','owned','tainted'].includes(data.mode)||data.mode!==approval.mode||data.consumerDSL!==approval.consumerDSL||data.gradleVersion!==approval.gradleVersion||!['8.11.1','9.2.1'].includes(data.gradleVersion))fail('observer_identity_mismatch');
 if(!same(data.sourcesSha256,approval.sourcesSha256))fail('observer_source_mismatch');
 if(!Array.isArray(data.runs)||data.runs.length!==2||!map(data.fixtureInputsSha256))fail('observer_case_invalid');
 const ids=new Set();
 for(let i=0;i<2;i++){
  const r=data.runs[i];
  if(r.schema!=='osv-mcp.kotlin-full-observer-run-v2'||r.mode!==data.mode||r.consumerDSL!==data.consumerDSL||r.gradleVersion!==data.gradleVersion||r.observe!==Boolean(i)||typeof r.runId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.runId)||ids.has(r.runId)||r.lastTask!=='jar'||r.lastTaskSucceeded!==true||r.maxWorkers!==1||r.parallel!==false||typeof data.eagerCompiler!=='boolean'||r.eagerCompiler!==data.eagerCompiler||data.eagerCompiler!==(approval.eagerCompiler??false))fail('observer_identity_mismatch');
  ids.add(r.runId);
  if(r.collectorSha256!==data.sourcesSha256['src/test/fixtures/gradle-kotlin-observer.init.gradle'])fail('observer_source_mismatch');
  if(!same(r.fixtureInputsSha256,data.fixtureInputsSha256))fail('observer_fixture_mismatch');
  if(!Array.isArray(r.trace)||r.trace.some(e=>typeof e.event!=='string'||typeof e.phase!=='string')||r.trace.some(e=>e.event==='supplier:unused'))fail('observer_trace_invalid');
  let previousEnd=-1;
  for(const t of ['compileKotlin','jar']){
   const frames=[['task:before:'+t,'before:'+t],['action:'+t+':first','before:'+t],['action:'+t+':last','before:'+t],['task:after:'+t,'after:'+t],['observer:begin:'+t,'observer:'+t],['observer:end:'+t,'observer:'+t]];
   for(const [event,phase]of frames){
    const matches=r.trace.map((e,i)=>({e,i})).filter(x=>x.e.event===event);
    if(matches.length!==1||matches[0].e.phase!==phase||matches[0].i<=previousEnd)fail('observer_trace_invalid');
    previousEnd=matches[0].i;
   }
  }
  for(const role of ['libraries','compilerClasspath','compileInput','compileOutput','jarSource','jarInput','jarOutput'])if(!r.trace.some(e=>e.event==='supplier:'+role))fail('observer_trace_invalid');
  if(r.trace.filter(e=>e.event==='plugin-application:proof').length!==1)fail('observer_trace_invalid');
  const tainted=r.trace.some(e=>e.event==='supplier:unownedJarSource');
  if(tainted!==(data.mode==='tainted'))fail('observer_identity_mismatch');
 }
 const observed=data.runs[1],control=data.runs[0];
 if(control.trace.some(e=>e.event.startsWith('supplier:')&&e.phase.startsWith('observer:'))||!Array.isArray(control.receipts)||control.receipts.length)fail('observer_control_contaminated');
 for(const run of data.runs){
  if(!Array.isArray(run.jarEntries)||!run.jarEntries.length||run.jarEntries.some(e=>!object(e)||typeof e.path!=='string'||!e.path||!Number.isSafeInteger(e.size)||e.size<0||!hash(e.sha256))||new Set(run.jarEntries.map(e=>e.path)).size!==run.jarEntries.length)fail('observer_read_evidence_invalid');
 }
 verifyReceipts(observed);
 if(!equal(control.jarEntries,observed.jarEntries))fail('observer_artifact_changed');
 for(const run of data.runs)verifyPolicy(run,data.mode);
 if(data.eagerCompiler)fail('observer_fault_not_reproduced');
 const comparison=compareObserverTraces(control.trace,observed.trace);
 return {...comparison,conditionalCandidate:data.mode==='owned'&&comparison.equal,productionAdopted:false,reason:comparison.equal?(data.mode==='owned'?'producer-owned-baseline-only':'trace-equal-without-ownership-contract'):'supplier_trace_changed'};
}
export function verifyObserverMatrix(data,approval){
 if(data?.schema!=='osv-mcp.kotlin-full-observer-matrix-v2'||data.gradleVersion!==approval.gradleVersion||!Array.isArray(data.cases)||data.cases.length!==6||new Set(data.cases.map(c=>c.consumerDSL+'/'+c.mode)).size!==6)fail('observer_matrix_incomplete');
 const decisions=['Groovy','Kotlin'].flatMap(consumerDSL=>['raw','owned','tainted'].map(mode=>verifyObserverCase(data.cases.find(c=>c.consumerDSL===consumerDSL&&c.mode===mode),{...approval,consumerDSL,mode,eagerCompiler:false})));
 if(!Array.isArray(data.rejections)||data.rejections.length!==2||new Set(data.rejections.map(r=>r?.proof?.consumerDSL)).size!==2)fail('observer_matrix_incomplete');
 for(const consumerDSL of ['Groovy','Kotlin']){
  const r=data.rejections.find(r=>r?.proof?.consumerDSL===consumerDSL);
  if(!r||r.reason!=='observer_policy_early_evaluation'||r.accepted!==false)fail('observer_rejection_invalid');
  let reason;
  try{verifyObserverCase(r.proof,{...approval,consumerDSL,mode:'owned',eagerCompiler:true});}catch(error){reason=error.message;}
  if(reason!=='observer_policy_early_evaluation')fail('observer_rejection_invalid');
 }
 return decisions;
}
