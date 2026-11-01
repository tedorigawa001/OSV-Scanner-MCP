import {describe,it,expect} from "vitest";
import {compareObserverTraces,verifyObserverCase,verifyObserverMatrix} from "../fixtures/gradleKotlinObserverProof.mjs";
describe('full observer non-interference decision',()=>{
 it('requires exact trace equality for the producer-owned candidate',()=>{
  const trace=[{event:'supplier:libraries',phase:'before:compileKotlin'},{event:'observer:begin:compileKotlin',phase:'observer:compileKotlin'},{event:'observer:end:compileKotlin',phase:'observer:compileKotlin'}];
  expect(compareObserverTraces(trace,structuredClone(trace))).toEqual({equal:true,extraEvaluations:[],outsideObserverChanged:false});
  const changed=structuredClone(trace);changed.splice(2,0,{event:'supplier:compileInput',phase:'observer:compileKotlin'});
  expect(compareObserverTraces(trace,changed)).toEqual({equal:false,extraEvaluations:[{event:'supplier:compileInput',phase:'observer:compileKotlin'}],outsideObserverChanged:false});
 });
});

const hash='a'.repeat(64),sources={'src/test/fixtures/gradle-kotlin-observer.init.gradle':hash};
function fixture(){
 const roles=['libraries','compilerClasspath','compileInput','compileOutput','jarSource','jarInput','jarOutput'];
 const registration=(role:string)=>['registration:begin:','registration:end:'].map(e=>({event:e+role,phase:'configuration-or-unbound'}));
 const policy=(name:string,rs:string[])=>[{event:'policy:begin:'+name,phase:'configuration-or-unbound'},...rs.flatMap(registration),{event:'policy:end:'+name,phase:'configuration-or-unbound'}];
 const trace=[...policy('compilerClasspath',['compilerClasspath']),...policy('compileKotlin',['libraries','compileInput','compileOutput']),...policy('jar',['jarSource','jarInput','jarOutput']),
  ...roles.map(role=>({event:'supplier:'+role,phase:'configuration'})),
  ...['compileKotlin','jar'].flatMap(t=>[{event:'task:before:'+t,phase:'before:'+t},{event:'action:'+t+':first',phase:'before:'+t},{event:'action:'+t+':last',phase:'before:'+t},{event:'task:after:'+t,phase:'after:'+t},{event:'observer:begin:'+t,phase:'observer:'+t},{event:'observer:end:'+t,phase:'observer:'+t}]),{event:'plugin-application:proof',phase:'configuration'}];
 const inputs={'build.gradle':hash};
 const file=(id:string,size=1)=>({id,name:id.split('/').at(-1)!,size,sha256:hash});
 const dir=(id:string)=>({id,name:id.split('/').at(-1)!,size:null,sha256:null});
 const manifest=file('build-logic/build/tmp/jar/MANIFEST.MF',25),archive=file('build-logic/build/libs/observer-proof.jar');
 const jarEntries=['META-INF/MANIFEST.MF','META-INF/gradle-plugins/proof.properties','META-INF/observer-proof.kotlin_module','proof/Proof.class','proof-resource.txt'].map(path=>({path,size:path.endsWith('MANIFEST.MF')?25:1,sha256:hash}));
 const receipts=[
  {task:'pre-compileKotlin',classes:{},javaSources:{}},
  {task:'compileKotlin',didWork:true,noSource:false,settings:{incremental:false,strategy:'IN_PROCESS',fallback:false},readSlots:{libraries:[file('lib.jar')],snapshots:[file('snapshot.bin')],compilerClasspath:[file('compiler.jar')],plugins:[{type:'KotlinPlugin',origin:'file:plugin.jar'}],taskInputs:[file('Proof.kt')],taskOutputs:[dir('build-logic/build/classes/kotlin/main')]}},
  {task:'compileJava',didWork:false,noSource:true,javaOutputs:{},readSlots:{taskInputs:[],taskOutputs:[dir('build-logic/build/classes/java/main')]}},
  {task:'pluginDescriptors',didWork:true,noSource:false,readSlots:{declarations:[{id:'proof',implementationClass:'proof.Proof'}],taskInputs:[],taskOutputs:[file('proof.properties')]}},
  {task:'processResources',didWork:true,noSource:false,readSlots:{taskInputs:[file('proof-resource.txt')],taskOutputs:[dir('build-logic/build/resources/main')]}},
  {task:'jar',didWork:true,noSource:false,temporaryRoot:'jar',manifest:{size:25,sha256:hash},archive:{name:archive.name,sha256:hash},readSlots:{taskInputs:[manifest],taskOutputs:[archive]}}
 ];
 const runs=[false,true].map((observe,i)=>({schema:'osv-mcp.kotlin-full-observer-run-v2',runId:`00000000-0000-4000-8000-00000000000${i}`,gradleVersion:'9.2.1',mode:'owned',consumerDSL:'Groovy',eagerCompiler:false,observe,lastTask:'jar',lastTaskSucceeded:true,maxWorkers:1,parallel:false,collectorSha256:hash,fixtureInputsSha256:inputs,trace:structuredClone(trace),jarEntries:structuredClone(jarEntries),receipts:observe?structuredClone(receipts):[]}));
 return {schema:'osv-mcp.kotlin-full-observer-case-v2',gradleVersion:'9.2.1',mode:'owned',consumerDSL:'Groovy',eagerCompiler:false,sourcesSha256:sources,fixtureInputsSha256:inputs,runs};
}
const approval={gradleVersion:'9.2.1',mode:'owned',consumerDSL:'Groovy',sourcesSha256:sources};
describe('full reader evidence validation',()=>{
 it('accepts equality only as a conditional producer-owned candidate',()=>{
  const result=verifyObserverCase(fixture(),approval);
  expect(result.conditionalCandidate).toBe(true);expect(result.productionAdopted).toBe(false);
 });
 it('rejects a fabricated phase order even when both runs match',()=>{
  const data=fixture();
  for(const r of data.runs)r.trace.reverse();
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_trace_invalid');
 });
});

describe('whole-reader regression guards',()=>{
 it.each(['libraries','snapshots','compilerClasspath','plugins','taskInputs','taskOutputs'])('rejects missing compile read evidence: %s',slot=>{
  const data:any=fixture();delete data.runs[1].receipts.find((r:any)=>r.task==='compileKotlin').readSlots[slot];
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
 it.each(['taskInputs','taskOutputs'])('rejects missing Jar read evidence: %s',slot=>{
  const data:any=fixture();delete data.runs[1].receipts.find((r:any)=>r.task==='jar').readSlots[slot];
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
 it.each(['version','mode','observe','run-id','source','collector','fixture','unused','frame','artifact','control-read'])('rejects invalid full-reader evidence: %s',mutation=>{
  const data:any=structuredClone(fixture());
  let reason='observer_identity_mismatch';
  if(mutation==='version')data.runs[1].gradleVersion='8.11.1';
  if(mutation==='mode')data.runs[1].mode='raw';
  if(mutation==='observe')data.runs[1].observe=false;
  if(mutation==='run-id')data.runs[1].runId=data.runs[0].runId;
  if(mutation==='source'){data.sourcesSha256={...sources,stale:'b'.repeat(64)};reason='observer_source_mismatch';}
  if(mutation==='collector'){data.runs[1].collectorSha256='b'.repeat(64);reason='observer_source_mismatch';}
  if(mutation==='fixture'){data.runs[1].fixtureInputsSha256={'build.gradle':'b'.repeat(64)};reason='observer_fixture_mismatch';}
  if(mutation==='unused'){data.runs[1].trace.push({event:'supplier:unused',phase:'observer:jar'});reason='observer_trace_invalid';}
  if(mutation==='frame'){data.runs[1].trace.find((e:any)=>e.event==='task:after:jar').phase='before:jar';reason='observer_trace_invalid';}
  if(mutation==='artifact'){data.runs[1].jarEntries.find((e:any)=>e.path.endsWith('.class')).sha256='b'.repeat(64);reason='observer_artifact_changed';}
  if(mutation==='control-read'){data.runs[0].receipts=data.runs[1].receipts;reason='observer_control_contaminated';}
  expect(()=>verifyObserverCase(data,approval)).toThrow(reason);
 });
 it('never promotes a producer-owned candidate when a supplier fires in the observer',()=>{
  const data=fixture(),trace=data.runs[1]!.trace;
  trace.splice(trace.findIndex(e=>e.event==='observer:end:jar'),0,{event:'supplier:jarSource',phase:'observer:jar'});
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_policy_invalid');
 });
 it('detects changed action/plugin phases outside the observer too',()=>{
  const data=fixture();data.runs[1]!.trace.push({event:'plugin-class-applied:Extra',phase:'configuration'});
  expect(verifyObserverCase(data,approval)).toMatchObject({equal:false,outsideObserverChanged:true,conditionalCandidate:false});
 });
 it('requires all DSL and policy combinations before consolidating a matrix',()=>{
  const cases=['Groovy','Kotlin'].flatMap(consumerDSL=>['raw','owned','tainted'].map(mode=>{
   const data:any=structuredClone(fixture());data.consumerDSL=consumerDSL;data.mode=mode;
   for(const r of data.runs){r.consumerDSL=consumerDSL;r.mode=mode;if(mode==='tainted')r.trace.push({event:'supplier:unownedJarSource',phase:'configuration'});}
   return data;
  }));
  const rejections=['Groovy','Kotlin'].map(consumerDSL=>{const proof:any=structuredClone(fixture());proof.consumerDSL=consumerDSL;proof.eagerCompiler=true;for(const r of proof.runs){r.consumerDSL=consumerDSL;r.eagerCompiler=true;const [event]=r.trace.splice(r.trace.findIndex((e:any)=>e.event==='supplier:compilerClasspath'),1);r.trace.splice(r.trace.findIndex((e:any)=>e.event==='registration:end:compilerClasspath'),0,event);}return {proof,accepted:false,reason:'observer_policy_early_evaluation'};});
  const matrix={schema:'osv-mcp.kotlin-full-observer-matrix-v2',gradleVersion:'9.2.1',cases,rejections};
  expect(verifyObserverMatrix(matrix,approval)).toHaveLength(6);
  expect(()=>verifyObserverMatrix({...matrix,cases:cases.slice(1)},approval)).toThrow('observer_matrix_incomplete');
  expect(()=>verifyObserverMatrix({...matrix,cases:[cases[0],...cases.slice(0,5)]},approval)).toThrow('observer_matrix_incomplete');
 });
});

describe('nested task context regression',()=>{
 it('accepts a restored compile context and rejects the old overwritten global phase',()=>{
  const data=fixture();
  for(const run of data.runs){
   const at=run.trace.findIndex(e=>e.event==='action:compileKotlin:last');
   run.trace.splice(at,0,{event:'task:before:processResources',phase:'before:processResources'},{event:'task:after:processResources',phase:'after:processResources'},{event:'observer:end:processResources',phase:'observer:processResources'});
  }
  expect(verifyObserverCase(data,approval).equal).toBe(true);
  data.runs[1]!.trace.find(e=>e.event==='action:compileKotlin:last')!.phase='done:processResources';
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_trace_invalid');
 });
 it.each(['maxWorkers','parallel'])('rejects a run outside the serial recipe: %s',field=>{
  const data:any=fixture();data.runs[1][field]=field==='maxWorkers'?2:true;
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_identity_mismatch');
 });
});

describe('review regressions',()=>{
 it('rejects compilerClasspath evaluation during its registration even for identical traces',()=>{
  const data=fixture();
  for(const run of data.runs){const index=run.trace.findIndex(e=>e.event==='supplier:compilerClasspath');const [event]=run.trace.splice(index,1);run.trace.splice(run.trace.findIndex(e=>e.event==='registration:end:compilerClasspath'),0,event!);}
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_policy_early_evaluation');
 });
 it('rejects the former compile/Jar-only evidence subset',()=>{
  const data:any=fixture();data.runs[1].receipts=data.runs[1].receipts.filter((r:any)=>['compileKotlin','jar'].includes(r.task));
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
});

describe('mandatory complete observer evidence',()=>{
 it.each(['pre-compileKotlin','compileKotlin','compileJava','pluginDescriptors','processResources','jar'])('rejects a missing required receipt: %s',task=>{
  const data=fixture();data.runs[1]!.receipts=data.runs[1]!.receipts.filter(r=>r.task!==task);
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
 it.each([['pre-compileKotlin','classes'],['pre-compileKotlin','javaSources'],['compileKotlin','settings'],['compileJava','javaOutputs'],['pluginDescriptors','readSlots'],['processResources','readSlots'],['jar','manifest'],['jar','archive'],['jar','temporaryRoot']])('rejects missing %s.%s',(task,field)=>{
  const data:any=fixture();delete data.runs[1].receipts.find((r:any)=>r.task===task)[field!];
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
 it.each(['incremental','strategy','fallback'])('rejects an invalid execution setting: %s',field=>{
  const data:any=fixture();data.runs[1].receipts.find((r:any)=>r.task==='compileKotlin').settings[field]=field==='strategy'?'DAEMON':true;
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_execution_invalid');
 });
 it.each(['pre-output','java-output','declaration','manifest-binding','archive-binding'])('rejects invalid mandatory evidence: %s',mutation=>{
  const data:any=fixture(),get=(task:string)=>data.runs[1].receipts.find((r:any)=>r.task===task);
  let reason='observer_precondition_invalid';
  if(mutation==='pre-output')get('pre-compileKotlin').classes={'Old.class':hash};
  if(mutation==='java-output')get('compileJava').javaOutputs={'Old.class':hash};
  if(mutation==='declaration'){get('pluginDescriptors').readSlots.declarations[0].implementationClass='Wrong';reason='observer_declaration_invalid';}
  if(mutation==='manifest-binding'){get('jar').manifest.sha256='b'.repeat(64);reason='observer_read_evidence_invalid';}
  if(mutation==='archive-binding'){get('jar').archive.sha256='b'.repeat(64);reason='observer_read_evidence_invalid';}
  expect(()=>verifyObserverCase(data,approval)).toThrow(reason);
 });
 it.each(['missing-registration','missing-policy','registration-phase','policy-phase'])('rejects an invalid producer lifecycle: %s',mutation=>{
  const data=fixture();
  for(const run of data.runs){
   if(mutation==='missing-registration')run.trace=run.trace.filter(e=>e.event!=='registration:end:compilerClasspath');
   if(mutation==='missing-policy')run.trace=run.trace.filter(e=>e.event!=='policy:end:compilerClasspath');
   if(mutation==='registration-phase')run.trace.find(e=>e.event==='registration:end:compilerClasspath')!.phase='before:compileKotlin';
   if(mutation==='policy-phase')run.trace.find(e=>e.event==='policy:end:compilerClasspath')!.phase='before:compileKotlin';
  }
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_policy_invalid');
 });
});

describe('all stage and registration boundaries',()=>{
 it.each(['compilerClasspath','libraries','compileInput','compileOutput','jarSource','jarInput','jarOutput'])('rejects eager evaluation within registration: %s',role=>{
  const data=fixture();
  for(const run of data.runs){const [event]=run.trace.splice(run.trace.findIndex(e=>e.event==='supplier:'+role),1);event!.phase='configuration-or-unbound';run.trace.splice(run.trace.findIndex(e=>e.event==='registration:end:'+role),0,event!);}
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_policy_early_evaluation');
 });
 it.each([['compileJava','taskInputs'],['compileJava','taskOutputs'],['pluginDescriptors','taskInputs'],['pluginDescriptors','taskOutputs'],['pluginDescriptors','declarations'],['processResources','taskInputs'],['processResources','taskOutputs']])('requires %s.readSlots.%s',(task,slot)=>{
  const data:any=fixture();delete data.runs[1].receipts.find((r:any)=>r.task===task).readSlots[slot!];
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
 it.each(['compileKotlin','compileJava','pluginDescriptors','processResources','jar'])('requires observed execution state: %s',task=>{
  const data:any=fixture();delete data.runs[1].receipts.find((r:any)=>r.task===task).didWork;
  expect(()=>verifyObserverCase(data,approval)).toThrow('observer_read_inventory_incomplete');
 });
});
