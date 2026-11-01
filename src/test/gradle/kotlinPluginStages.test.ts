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
 it.each([
  ['missing-compile','kotlin_compile_missing'],['no-work','kotlin_compile_missing'],['duplicate-compile','kotlin_compile_missing'],
  ['wrong-producer','kotlin_producer_ambiguous'],['source-changed','kotlin_source_input_mismatch'],
  ['missing-generator','kotlin_adapter_lineage_missing'],['generator-after-compile','kotlin_adapter_lineage_missing'],
  ['adapter-hash','kotlin_adapter_input_mismatch'],['foreign-adapter','kotlin_adapter_input_mismatch'],
  ['missing-classes','kotlin_classes_missing'],['missing-jar','kotlin_package_missing'],
  ['archive-producer','kotlin_package_artifact_mismatch'],['archive-invocation','kotlin_package_artifact_mismatch'],['archive-path','kotlin_package_artifact_mismatch'],['archive-hash','kotlin_package_artifact_mismatch'],
  ['compile-class-hash','kotlin_compile_package_mismatch'],['package-input-hash','kotlin_compile_package_mismatch'],['jar-class-hash','kotlin_compile_package_mismatch'],
  ['extra-class','kotlin_package_class_set_mismatch'],['loaded-class-hash','kotlin_loaded_class_mismatch'],
 ])("rejects incomplete lineage: %s",(mutation,reason)=>{
  const r:any=sample(),tasks=r.builds[0].receipts;
  if(mutation==='missing-compile')tasks.splice(1,1);
  if(mutation==='no-work')tasks[1].didWork=false;
  if(mutation==='duplicate-compile')tasks.splice(2,0,structuredClone(tasks[1]));
  if(mutation==='wrong-producer')r.builds[0].build='other';
  if(mutation==='source-changed')r.inputs.changed=[source];
  if(mutation==='missing-generator')tasks.shift();
  // Move only the generator, so the compile-to-package order stays valid.
  if(mutation==='generator-after-compile')tasks.splice(1,0,tasks.shift());
  if(mutation==='adapter-hash')tasks[1].declaredInputs[adapter]='changed';
  if(mutation==='foreign-adapter')tasks[0].outputs={'other/build/Plugin.kt':'adapter-hash'};
  if(mutation==='missing-classes')tasks[1].outputs={};
  if(mutation==='missing-jar')tasks.pop();
  if(mutation==='archive-producer')r.kotlinPackage.producer='other';
  if(mutation==='archive-invocation')r.kotlinPackage.invocationId='other';
  if(mutation==='archive-path')r.kotlinPackage.archivePath='buildSrc/build/libs/other.jar';
  if(mutation==='archive-hash')r.kotlinPackage.sha256='changed';
  if(mutation==='compile-class-hash')tasks[1].outputs['buildSrc/build/classes/kotlin/main/ProofPlugin.class']='changed';
  if(mutation==='package-input-hash')tasks[2].declaredInputs={'buildSrc/build/classes/kotlin/main/ProofPlugin.class':'changed'};
  if(mutation==='jar-class-hash')r.kotlinPackage.entries[0].sha256='changed';
  if(mutation==='extra-class')r.kotlinPackage.entries.push({path:'Extra.class',sha256:'extra-hash'});
  if(mutation==='loaded-class-hash')r.projects.registered.applications[0].loadedClassSha256='changed';
  const result=assessKotlinStages(r,'buildSrc',source,true);
  expect(result.complete).toBe(false);expect(result.reasons).toContain(reason);
 });
 it('does not require generated adapters for an ordinary Kotlin binary plugin',()=>{
  const r=sample();r.builds[0]!.receipts.shift();
  expect(assessKotlinStages(r,'buildSrc',source,false).complete).toBe(true);
 });
});
