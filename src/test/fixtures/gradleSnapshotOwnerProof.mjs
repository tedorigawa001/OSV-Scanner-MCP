import {createHash} from 'node:crypto';
import {ownerTupleArtifacts,ownerArtifactEvidence,ownerJdkProfile} from './gradleSnapshotOwnerExpected.mjs';
export const ownerTuples=[{gradleVersion:'8.11.1',kgpVersion:'2.0.20',btaSha256:'57ed50220e78ec39e8a80014330f295e5485b5638c1129af9ed7d53d7858c5c2',sourceSha256:'a08a2c2c343b94dbde3469232032c00f9041e1c22c4628b5267aefc31568313b',sourceExcerptsSha256:'f88e60b774f4df12b3b7ffc5b0c7871b451a315778529dffb8f87fc3d8737e33'},{gradleVersion:'9.2.1',kgpVersion:'2.2.20',btaSha256:'fd9947b3a17621a86fabd953af87f34bd2bb7f8b26dae92c1ed7be7472f44c3b',sourceSha256:'290eafae283e6a12d559ebe036d4373bc2d4fa1160cce3392b27c51fa941d03d',sourceExcerptsSha256:'731b59e773dda53f51329f6888f58e6396a5f118141eea6956e897521ec1afb5'}];
export const ownerSources=['src/test/fixtures/gradleSnapshotOwnerParameters.java','src/test/fixtures/gradleSnapshotOwnerProof.mjs','src/test/fixtures/gradleSnapshotOwnerProof.d.mts','src/test/fixtures/gradleSnapshotOwnerExpected.mjs','src/test/manual/gradleSnapshotOwnerSurvey.mjs','src/test/gradle/snapshotOwner.test.ts'];
export const ownerTypes=[['implementation','org.jetbrains.kotlin.gradle.tasks.KotlinCompile'],['implementation','org.jetbrains.kotlin.gradle.tasks.KotlinCompile$ClasspathSnapshotProperties'],['kgp','org.jetbrains.kotlin.gradle.plugin.KotlinCompilerPluginSupportPlugin'],['implementation','org.jetbrains.kotlin.gradle.plugin.KotlinCompilerArgumentsProducer'],['gradle','org.gradle.api.Task'],['gradle','org.gradle.api.tasks.TaskInputs'],['gradle','org.gradle.work.InputChanges'],['events','org.gradle.build.event.BuildEventsListenerRegistry'],['tooling','org.gradle.tooling.events.task.TaskFinishEvent'],['tooling','org.gradle.tooling.events.task.TaskSuccessResult'],['gradle','org.gradle.api.artifacts.transform.TransformAction'],['bta','org.jetbrains.kotlin.buildtools.api.CompilationService'],['bta','org.jetbrains.kotlin.buildtools.api.jvm.JvmCompilationConfiguration'],['bta','org.jetbrains.kotlin.buildtools.api.jvm.ClasspathSnapshotBasedIncrementalCompilationApproachParameters']];
export const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=m=>{throw Error(m)};
export function ownerMethod(bytecode,pattern){
 const headers=[...bytecode.matchAll(/^  (?:public|protected|private)[^\n]+\([^\n]*\);$/gm)];
 const index=headers.findIndex(h=>pattern.test(h[0]));if(index<0)fail('snapshot_owner_consumption_evidence_missing');
 return bytecode.slice(headers[index].index,index+1<headers.length?headers[index+1].index:bytecode.length).trimEnd();
}
const gatePattern=/val icEnv = if \(isIncrementalCompilationEnabled\(\)\) \{([\s\S]*?)\} else null/;
export const ownerSourceNotice='/*\n * Copyright 2010-2023 JetBrains s.r.o. and Kotlin Programming Language contributors.\n * Use of this source code is governed by the Apache 2.0 license that can be found in the license/LICENSE.txt file.\n */';
// Only the three excerpts the facts depend on are published; the full tag source is digest-checked at collection.
export function ownerSourceExcerpts(source){
 const lineOf=index=>source.slice(0,index).split('\n').length,lines=source.split('\n');
 const gate=source.match(gatePattern),one=text=>{const at=source.indexOf(text);if(at<0||source.indexOf(text,at+1)>=0)fail('snapshot_owner_consumption_evidence_missing');const line=lineOf(at);return {line,text:lines[line-1]};};
 if(!gate||!source.startsWith(ownerSourceNotice))fail('snapshot_owner_consumption_evidence_missing');
 return {gate:{line:lineOf(gate.index),text:gate[0]},privateDeclaration:one('private fun getClasspathChanges('),snapshotRead:one('classpathSnapshotProperties.classpathSnapshot.files.toList()')};
}
export function snapshotOwnerFacts(excerpts,bytecode){
 const call=ownerMethod(bytecode,/callCompilerAsync\$.*K2JVMCompilerArguments/),privateRead=ownerMethod(bytecode,/private .* getClasspathChanges\(/);
 const {gate,privateDeclaration:declaration,snapshotRead:read}=excerpts??{};
 if([gate,declaration,read].some(x=>!Number.isSafeInteger(x?.line)||x.line<1||typeof x.text!=='string')||!(gate.line<declaration.line&&declaration.line<read.line))fail('snapshot_owner_consumption_evidence_missing');
 const sourceGate=gate.text.match(gatePattern);
 if(sourceGate?.[0]!==gate.text||!sourceGate[1].includes('getClasspathChanges(inputChanges)')||!declaration.text.trimStart().startsWith('private fun getClasspathChanges(')||!read.text.includes('classpathSnapshotProperties.classpathSnapshot.files.toList()'))fail('snapshot_owner_consumption_evidence_missing');
 const guard=call.match(/^\s*(\d+): invokevirtual[^\n]*isIncrementalCompilationEnabled[^\n]*\n\s*(\d+): ifeq\s+(\d+)/m);
 for(const method of [call,privateRead]){
  const offsets=[...method.matchAll(/^\s*(\d+):\s+[a-z][a-z0-9_]*/gm)].map(m=>Number(m[1]));
  if(!offsets.length||offsets.some((offset,i)=>!Number.isSafeInteger(offset)||i>0&&offset<=offsets[i-1]))fail('snapshot_owner_consumption_evidence_missing');
 }
 const reads=[...call.matchAll(/^\s*(\d+): invokespecial[^\n]*Method getClasspathChanges:/gm)];
 if(!guard||reads.length!==1||!(Number(guard[1])<Number(guard[2])&&Number(guard[2])<Number(reads[0][1])&&Number(reads[0][1])<Number(guard[3]))||!new RegExp('^\\s*'+guard[3]+': aconst_null','m').test(call)||!privateRead.includes('getClasspathSnapshot:')||!privateRead.includes('getFiles:'))fail('snapshot_owner_consumption_evidence_missing');
 return {classpathChangesVisibility:'private',compilerEnvironmentGate:'isIncrementalCompilationEnabled',disabledBranch:'null-incremental-environment',snapshotPathRead:'inside-private-classpathChanges',receiptHookEstablished:false};
}
export function verifySnapshotOwnerSurvey(d,reference,sources){
 if(d?.schema!=='osv-mcp.snapshot-owner-survey-v3'||!Array.isArray(d.surveys)||d.surveys.length!==2)fail('snapshot_owner_schema_invalid');
 const scope={publicTypesPerTuple:ownerTypes.length,tagSources:2,standaloneParameterProbes:2,newGradleBuilds:0,newCompilerInvocations:0,groovyKotlinMatrixAdded:false,syntheticFilesAreKgpSnapshots:false,sourceSurveyIsExhaustive:false};
 if(JSON.stringify(d.scope)!==JSON.stringify(scope))fail('snapshot_owner_scope_invalid');
 if(JSON.stringify(d.jdkTools)!==JSON.stringify(ownerJdkProfile))fail('snapshot_owner_jdk_invalid');
 if(JSON.stringify(d.sourcesSha256)!==JSON.stringify(sources)||ownerSources.some(p=>!sources[p]))fail('snapshot_owner_source_invalid');
 for(let i=0;i<2;i++){
  const s=d.surveys[i],tuple=ownerTuples[i],prior=reference.matrices.find(m=>m.gradleVersion===tuple.gradleVersion)?.cases[0].runs[0];
  if(s.gradleVersion!==tuple.gradleVersion||s.kgpVersion!==tuple.kgpVersion||s.btaArtifactRole!=='available-api-not-proven-selected-by-kgp')fail('snapshot_owner_tuple_invalid');
  for(const [role,expected] of Object.entries({gradle:prior.apiArtifacts.gradle.sha256,kgp:prior.apiArtifacts.kgp.sha256,implementation:prior.implementation.sha256}))if(s.artifacts?.[role]?.sha256!==expected)fail('snapshot_owner_artifact_invalid');
  for(const [role,expected] of Object.entries(ownerTupleArtifacts[tuple.gradleVersion]))if(s.artifacts?.[role]?.sha256!==expected)fail('snapshot_owner_artifact_invalid');
  if(s.artifacts.bta?.sha256!==tuple.btaSha256)fail('snapshot_owner_artifact_invalid');
  const t=s.tagSource;
  if(Object.keys(t??{}).sort().join()!=='binding,excerpts,license,licenseUrl,notice,sha256,url'||t.sha256!==tuple.sourceSha256||digest(JSON.stringify(t.excerpts))!==tuple.sourceExcerptsSha256||t.license!=='Apache-2.0'||t.notice!==ownerSourceNotice||t.licenseUrl!==`https://github.com/JetBrains/kotlin/blob/v${tuple.kgpVersion}/license/LICENSE.txt`||t.url!==`https://raw.githubusercontent.com/JetBrains/kotlin/v${tuple.kgpVersion}/libraries/tools/kotlin-gradle-plugin/src/common/kotlin/org/jetbrains/kotlin/gradle/tasks/KotlinCompile.kt`)fail('snapshot_owner_tag_source_invalid');
  if(!Array.isArray(s.api)||s.api.length!==ownerTypes.length)fail('snapshot_owner_api_invalid');
  for(let j=0;j<ownerTypes.length;j++){
   const [role,type]=ownerTypes[j],api=s.api[j],expected=ownerArtifactEvidence[s.artifacts[role].sha256]?.[type];
   if(!expected||api.classSha256!==expected.classSha256||api.signatureSha256!==expected.signatureSha256||!/^[a-f0-9]{64}$/.test(api.classSha256)||api.type!==type||api.artifactSha256!==s.artifacts[role]?.sha256||api.signatureSha256!==digest(api.signature)||!api.signature.includes('interface '+type)&&!api.signature.includes('class '+type))fail('snapshot_owner_api_invalid');
  }
  if(s.compileBytecodeSha256!==ownerArtifactEvidence[s.artifacts.implementation.sha256]?.['org.jetbrains.kotlin.gradle.tasks.KotlinCompile']?.compileBytecodeSha256||s.compileBytecodeSha256!==digest(s.compileBytecode)||JSON.stringify(snapshotOwnerFacts(t.excerpts,s.compileBytecode))!==JSON.stringify(s.facts))fail('snapshot_owner_consumption_evidence_missing');
  const p=s.parameterProbe;
  if(p?.schema!=='osv-mcp.snapshot-owner-parameter-probe-v1'||p.btaArtifact!==s.artifacts.bta.path||p.stdlibArtifact!==s.artifacts.stdlib.path||p.btaSha256!==s.artifacts.bta.sha256||p.stdlibSha256!==s.artifacts.stdlib.sha256||['mutableConstructorAliased','returnedListMutable','defensiveCopyStable','defensiveResultRejectsMutation','retainedConcreteFile','nonemptyFile'].some(k=>p[k]!==true)||p.fileBytesSha256!==digest('snapshot-probe-not-valid-classpath-snapshot\n')||p.compilerInvocations!==0||p.naturalContentBinding!==false)fail('snapshot_owner_parameter_probe_invalid');
 }
 const decision={existingKgp:'unsupported-owner-hook-not-established',bta:'new-owner-driver-required',producerContract:'designed-not-proven',approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0};
 if(JSON.stringify(d.decision)!==JSON.stringify(decision))fail('snapshot_owner_decision_invalid');
 return decision;
}
