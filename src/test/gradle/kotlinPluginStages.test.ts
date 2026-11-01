import {describe,it,expect} from 'vitest';
import {assessKotlinStages} from '../fixtures/gradleKotlinProof.js';
const source='buildSrc/src/main/kotlin/proof.gradle.kts',adapter='buildSrc/build/generated/ProofPlugin.kt';
function sample(){return {invocationId:'run',kotlinPackage:{producer:'buildSrc',invocationId:'run',archivePath:'buildSrc/build/libs/logic.jar',sha256:'jar-hash',entries:[{path:'ProofPlugin.class',sha256:'class-hash'}]},projects:{registered:{applications:[{implementationClass:'ProofPlugin',loadedClassSha256:'class-hash',builtJarPath:'buildSrc/build/libs/logic.jar'}]}},inputs:{baseline:{[source]:'source-hash'},changed:[]},builds:[{build:'buildSrc',receipts:[
 {task:':generateScriptPluginAdapters',didWork:true,skipped:false,failure:null,declaredInputs:{[source]:'source-hash'},outputs:{[adapter]:'adapter-hash'}},
 {task:':compileKotlin',didWork:true,skipped:false,failure:null,declaredInputs:{[source]:'source-hash',[adapter]:'adapter-hash'},outputs:{'buildSrc/build/classes/kotlin/main/ProofPlugin.class':'class-hash'}},
 {task:':jar',didWork:true,skipped:false,failure:null,archivePath:'buildSrc/build/libs/logic.jar',declaredInputs:{'buildSrc/build/classes/kotlin/main/ProofPlugin.class':'class-hash'},outputs:{'buildSrc/build/libs/logic.jar':'jar-hash'}}]}]};}
describe('Kotlin source to generated adapter lineage',()=>{
 it('links the physical script through generated source and the completed Kotlin compile',()=>{
  expect(assessKotlinStages(sample(),'buildSrc',source,true).complete).toBe(true);
 });
 it.each(['missing-compile','no-work','wrong-producer','source-changed','missing-generator','generator-after-compile','adapter-hash','foreign-adapter','missing-classes','missing-jar','compile-class-hash','package-input-hash','jar-class-hash','loaded-class-hash'])("rejects incomplete lineage: %s",mutation=>{
  const r:any=sample(),tasks=r.builds[0].receipts;
  if(mutation==='missing-compile')tasks.splice(1,1);
  if(mutation==='no-work')tasks[1].didWork=false;
  if(mutation==='wrong-producer')r.builds[0].build='other';
  if(mutation==='source-changed')r.inputs.changed=[source];
  if(mutation==='missing-generator')tasks.shift();
  if(mutation==='generator-after-compile')tasks.reverse();
  if(mutation==='adapter-hash')tasks[1].declaredInputs[adapter]='changed';
  if(mutation==='foreign-adapter')tasks[0].outputs={'other/build/Plugin.kt':'adapter-hash'};
  if(mutation==='missing-classes')tasks[1].outputs={};
  if(mutation==='missing-jar')tasks.pop();
  if(mutation==='compile-class-hash')tasks[1].outputs['buildSrc/build/classes/kotlin/main/ProofPlugin.class']='changed';
  if(mutation==='package-input-hash')tasks[2].declaredInputs={'buildSrc/build/classes/kotlin/main/ProofPlugin.class':'changed'};
  if(mutation==='jar-class-hash')r.kotlinPackage.entries[0].sha256='changed';
  if(mutation==='loaded-class-hash')r.projects.registered.applications[0].loadedClassSha256='changed';
  expect(assessKotlinStages(r,'buildSrc',source,true).complete).toBe(false);
 });
 it('does not require generated adapters for an ordinary Kotlin binary plugin',()=>{
  const r=sample();r.builds[0]!.receipts.shift();
  expect(assessKotlinStages(r,'buildSrc',source,false).complete).toBe(true);
 });
});
