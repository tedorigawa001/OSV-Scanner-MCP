import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {snapshotOwnerFacts,verifySnapshotOwnerSurvey,digest,ownerSources,ownerSourceExcerpts,ownerSourceNotice} from '../fixtures/gradleSnapshotOwnerProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
const record=()=>JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-snapshot-owner-survey-2026-11-01.json',import.meta.url),'utf8'));
const reference=()=>JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-kgp-availability-2026-11-01.json',import.meta.url),'utf8'));
it('does not promote a Task callback into a natural-consumption hook',()=>{
 expect(()=>snapshotOwnerFacts({gate:{line:1,text:'fun doFirst() {}'}},'public void doFirst();')).toThrow('snapshot_owner_consumption_evidence_missing');
});
it('revalidates published signatures, source/bytecode branches and actual public constructor probes',()=>{
 const d=record();assertNoAbsolutePaths(d);
 const sources=Object.fromEntries(Object.keys(d.sourcesSha256).map(p=>[p,digest(readFileSync(new URL('../../../'+p,import.meta.url)))]));
 expect(Object.keys(sources)).toEqual([...ownerSources,'src/test/manual/kgpRecordPaths.mjs','src/test/manual/kgpRecordPaths.d.mts']);
 expect(d.referenceRecord.sha256).toBe(digest(readFileSync(new URL('../../../'+d.referenceRecord.path,import.meta.url))));
 expect(verifySnapshotOwnerSurvey(d,reference(),sources)).toMatchObject({existingKgp:'unsupported-owner-hook-not-established',bta:'new-owner-driver-required',approvedRecipes:0});
});
for(const version of ['8.11.1','9.2.1']){
 const survey=()=>record().surveys.find((s:any)=>s.gradleVersion===version);
 it(version+' requires the private consuming method in the source',()=>{const s=survey(),e=s.tagSource.excerpts;e.privateDeclaration.text=e.privateDeclaration.text.replace('private fun getClasspathChanges','fun getClasspathChanges');expect(()=>snapshotOwnerFacts(e,s.compileBytecode)).toThrow('snapshot_owner_consumption_evidence_missing');});
 it(version+' requires the actual guarded bytecode branch',()=>{const s=survey();expect(()=>snapshotOwnerFacts(s.tagSource.excerpts,s.compileBytecode.replace('ifeq','ifne'))).toThrow('snapshot_owner_consumption_evidence_missing');});
 it(version+' rejects an unguarded source attribution',()=>{const s=survey(),e=s.tagSource.excerpts;e.gate.text=e.gate.text.replace('val icEnv = if (isIncrementalCompilationEnabled())','val icEnv = if (true)');expect(()=>snapshotOwnerFacts(e,s.compileBytecode)).toThrow('snapshot_owner_consumption_evidence_missing');});
}
const mutations:Array<[string,(d:any)=>void,string]>=[
 ['different Gradle runtime API',d=>d.surveys[0].artifacts.gradle.sha256=d.surveys[1].artifacts.gradle.sha256,'artifact'],
 ['different KGP implementation',d=>d.surveys[0].artifacts.implementation.sha256=d.surveys[1].artifacts.implementation.sha256,'artifact'],
 ['different BTA artifact',d=>d.surveys[0].artifacts.bta.sha256=d.surveys[1].artifacts.bta.sha256,'artifact'],
 ['missing public type',d=>d.surveys[0].api.pop(),'api'],
 ['missing class identity',d=>delete d.surveys[0].api[0].classSha256,'api'],
 ['invented owner hook witness',d=>d.surveys[0].facts.receiptHookEstablished=true,'consumption_evidence_missing'],
 ['changed public signature',d=>d.surveys[0].api[0].signature+='changed','api'],
 ['changed source excerpt',d=>d.surveys[0].tagSource.excerpts.snapshotRead.text+=' ','tag_source'],
 ['excerpt moved within the source',d=>d.surveys[0].tagSource.excerpts.snapshotRead.line++,'tag_source'],
 ['republished full source bytes',d=>d.surveys[0].tagSource.bytesBase64=Buffer.from('fake').toString('base64'),'tag_source'],
 ['changed license',d=>d.surveys[0].tagSource.license='MIT','tag_source'],
 ['dropped license notice',d=>delete d.surveys[0].tagSource.notice,'tag_source'],
 ['changed JDK profile',d=>{d.jdkTools.javap.version='17.0.1';d.jdkTools.javap.sha256='0'.repeat(64);},'jdk'],
 ['missing JDK profile',d=>delete d.jdkTools,'jdk'],
 ['changed bytecode',d=>d.surveys[0].compileBytecode+='changed','consumption_evidence_missing'],
 ['probe bound to another artifact',d=>d.surveys[0].parameterProbe.btaArtifact='other.jar','parameter_probe'],
 ['false defensive copy result',d=>d.surveys[0].parameterProbe.defensiveCopyStable=false,'parameter_probe'],
 ['missing actual alias result',d=>delete d.surveys[0].parameterProbe.mutableConstructorAliased,'parameter_probe'],
 ['synthetic path called a compiler proof',d=>d.surveys[0].parameterProbe.naturalContentBinding=true,'parameter_probe'],
 ['unobserved compiler invocation',d=>d.surveys[0].parameterProbe.compilerInvocations=1,'parameter_probe'],
 ['API survey called runtime hook proof',d=>d.surveys[0].btaArtifactRole='selected-by-kgp','tuple'],
 ['inflated Gradle build count',d=>d.scope.newGradleBuilds=4,'scope'],
 ['unrun DSL matrix',d=>d.scope.groovyKotlinMatrixAdded=true,'scope'],
 ['unapproved recipe',d=>d.decision.approvedRecipes=1,'decision'],
 ['old verification source',d=>d.sourcesSha256[ownerSources[0]!]='0'.repeat(64),'source'],
];
for(const [name,mutate,reason] of mutations)it('rejects '+name,()=>{const d=record(),sources={...d.sourcesSha256};mutate(d);expect(()=>verifySnapshotOwnerSurvey(d,reference(),sources)).toThrow('snapshot_owner_'+reason+(reason==='consumption_evidence_missing'?'':'_invalid'));});

for(const version of ['8.11.1','9.2.1']){
 it(version+' rejects a read moved before the guard',()=>{
  const s=record().surveys.find((s:any)=>s.gradleVersion===version);
  const changed=s.compileBytecode.replace(/^(\s*)\d+(: invokespecial[^\n]*Method getClasspathChanges:)/m,'$11$2');
  expect(()=>snapshotOwnerFacts(s.tagSource.excerpts,changed)).toThrow('snapshot_owner_consumption_evidence_missing');
 });
 it(version+' rejects removal of a public accessor even with its self hash updated',()=>{
  const d=record(),s=d.surveys.find((s:any)=>s.gradleVersion===version),api=s.api[1];
  api.signature=api.signature.split('\n').filter((line:string)=>!line.includes(' getClasspathSnapshot();')).join('\n');api.signatureSha256=digest(api.signature);
  expect(()=>verifySnapshotOwnerSurvey(d,reference(),d.sourcesSha256)).toThrow('snapshot_owner_api_invalid');
 });
 it(version+' rejects changed bytecode even with its self hash updated',()=>{
  const d=record(),s=d.surveys.find((s:any)=>s.gradleVersion===version);
  s.compileBytecode=s.compileBytecode.replace('getFiles:', 'fakeReceiver.getFiles:');s.compileBytecodeSha256=digest(s.compileBytecode);
  expect(()=>verifySnapshotOwnerSurvey(d,reference(),d.sourcesSha256)).toThrow('snapshot_owner_consumption_evidence_missing');
 });
 it(version+' rejects another well formed class digest',()=>{
  const d=record(),s=d.surveys.find((s:any)=>s.gradleVersion===version);s.api[0].classSha256='0'.repeat(64);
  expect(()=>verifySnapshotOwnerSurvey(d,reference(),d.sourcesSha256)).toThrow('snapshot_owner_api_invalid');
 });
}

for(const version of ['8.11.1','9.2.1']){
 it(version+' rejects a sorted instruction stream whose read precedes the guard',()=>{
  const s=record().surveys.find((s:any)=>s.gradleVersion===version);
  const bytecode=`  public void callCompilerAsync$probe(K2JVMCompilerArguments);
    Code:
       0: aload_0
       1: aload_1
       2: invokespecial #1 // Method getClasspathChanges:()LX;
       5: aload_0
       6: invokevirtual #2 // Method isIncrementalCompilationEnabled:()Z
       9: ifeq 15
      12: goto 16
      15: aconst_null
      16: return
  private final X getClasspathChanges(X);
    Code:
       0: invokevirtual #3 // Method getClasspathSnapshot:()LX;
       3: invokeinterface #4 // Method getFiles:()LX;
       8: areturn
`;
  expect(()=>snapshotOwnerFacts(s.tagSource.excerpts,bytecode)).toThrow('snapshot_owner_consumption_evidence_missing');
 });
 it(version+' rejects duplicate instruction offsets',()=>{
  const s=record().surveys.find((s:any)=>s.gradleVersion===version);
  const changed=s.compileBytecode.replace(/(\n\s*0: [^\n]+\n)/,'$1       0: nop\n');
  expect(()=>snapshotOwnerFacts(s.tagSource.excerpts,changed)).toThrow('snapshot_owner_consumption_evidence_missing');
 });
 it(version+' rejects an altered accessor with all recorded identity hashes replaced',()=>{
  const d=record(),s=d.surveys.find((s:any)=>s.gradleVersion===version),api=s.api[1];
  api.signature=api.signature.replace('getClasspathSnapshot()', 'getForgedSnapshot()');api.signatureSha256=digest(api.signature);api.classSha256=digest(api.signature+'class');
  expect(()=>verifySnapshotOwnerSurvey(d,reference(),d.sourcesSha256)).toThrow('snapshot_owner_api_invalid');
 });
}

it('extracts only unique excerpts from a source with the retained notice',()=>{
 const body=ownerSourceNotice+'\nclass K {\n val icEnv = if (isIncrementalCompilationEnabled()) {\n  x(getClasspathChanges(inputChanges))\n } else null\n private fun getClasspathChanges(i: I) =\n  classpathSnapshotProperties.classpathSnapshot.files.toList()\n}\n';
 expect(ownerSourceExcerpts(body)).toMatchObject({gate:{line:6},privateDeclaration:{line:9,text:' private fun getClasspathChanges(i: I) ='},snapshotRead:{line:10}});
 expect(()=>ownerSourceExcerpts(body.replace(ownerSourceNotice,'// no notice'))).toThrow('snapshot_owner_consumption_evidence_missing');
 expect(()=>ownerSourceExcerpts(body+' private fun getClasspathChanges(x)\n')).toThrow('snapshot_owner_consumption_evidence_missing');
});
it('does not republish the full tag sources',()=>{
 for(const s of record().surveys){expect(s.tagSource.bytesBase64).toBeUndefined();expect(JSON.stringify(s.tagSource.excerpts).length).toBeLessThan(4096);}
});
