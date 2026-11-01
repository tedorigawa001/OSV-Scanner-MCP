import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {verifyBtaDriverRun,verifyBtaDriverCase,btaDriverRegressions,mutateBtaDriver,btaDriverTargets,hash,btaSources} from '../fixtures/gradleBtaDriverProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
const record=()=>JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-bta-owned-driver-2026-11-02.json',import.meta.url),'utf8'));
it('rejects an empty report rather than claiming a natural receipt',()=>expect(()=>verifyBtaDriverRun({},{})).toThrow('bta_driver_schema_invalid'));
it('replays all native BTA stages, program outputs and rejection evidence',()=>{
 const d=record();expect(d.schema).toBe('osv-mcp.bta-owned-driver-experiment-v2');assertNoAbsolutePaths(d);
 for(const group of ['sourcesSha256','verificationSourcesSha256'])for(const [p,h]of Object.entries(d[group]))expect(hash(readFileSync(new URL('../../../'+p,import.meta.url))),p).toBe(h);
 expect(Object.keys(d.sourcesSha256)).toEqual(btaSources);
 expect(d.matrices.map((m:any)=>m.gradleVersion)).toEqual(['8.11.1','9.2.1']);let builds=0,calls=0,snapshots=0,offered=0,stale=0,storage=0,extra=0,rejections=0,configurationRejections=0;
 for(const m of d.matrices){expect(m.cases.map((c:any)=>c.dsl)).toEqual(['Groovy','Kotlin']);for(const c of m.cases){
  const a={gradleVersion:m.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,sourcesSha256:d.sourcesSha256};expect(c.javaSha256).toBe(d.javaSha256);
  const decision=verifyBtaDriverCase(c,a);expect(decision).toEqual(c.decision);expect(btaDriverRegressions(c,a)).toEqual(c.regressions);
  builds+=c.runs.length;rejections+=c.regressions.length;snapshots+=c.runs.reduce((n:number,r:any)=>n+r.program.snapshots.length,0);
  for(const r of decision.runs){calls+=r.kotlinCompilerCalls;if(r.offeredInputsVerified)offered++;if(r.reason==='kotlin_derived_snapshot_stale')stale++;if(r.reason==='kotlin_pipeline_snapshot_storage_mismatch')storage++;if(r.reason==='bta_driver_extra_evaluation')extra++;if(r.reason==='bta_driver_configuration_unregistered'||r.reason==='bta_driver_configuration_binding_mismatch')configurationRejections++;}
 }}
 expect(d.scope).toEqual({gradleBuilds:builds,kotlinCompilerCalls:calls,generatedSnapshots:snapshots,offeredInputCandidates:offered,staleRejections:stale,storageRejections:storage,extraEvaluationRejections:extra,configurationRejections,recordMutationRejections:rejections,approvedRecipes:0,naturalContentBindings:0,productionAdoptions:0});
});
for(const target of btaDriverTargets)it('rejects '+target.kind,()=>{
 const d=record(),c=d.matrices[0].cases[0];expect(()=>verifyBtaDriverRun(mutateBtaDriver(c,target),{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,fixtureInputsSha256:c.fixtureInputsSha256})).toThrow(target.reason);
});
for(const phase of ['configuration','natural','action'])it('rejects a phase-forged supplier in an observer interval: '+phase,()=>{
 const d=record(),c=d.matrices[0].cases[0],r=structuredClone(c.runs[5]),i=r.gradle.events.findIndex((e:any)=>e.phase==='observer'&&e.event==='supplier:begin');r.gradle.events[i].phase=phase;r.gradle.events[i+1].phase=phase;
 expect(()=>verifyBtaDriverRun(r,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,fixtureInputsSha256:c.fixtureInputsSha256})).toThrow('bta_driver_extra_evaluation');
});
it('rejects reused run IDs',()=>{const d=record(),c=d.matrices[0].cases[0];c.runs[1].runId=c.runs[0].runId;expect(()=>verifyBtaDriverCase(c,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,sourcesSha256:d.sourcesSha256})).toThrow('bta_driver_identity_invalid');});

for(const who of ['gradle','program'])it('rejects a different JVM even when the approval field is rewritten: '+who,()=>{
 const d=record(),c=d.matrices[0].cases[0],r=structuredClone(c.runs[1]);r[who].javaExecutableSha256='0'.repeat(64);
 expect(()=>verifyBtaDriverRun(r,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:'0'.repeat(64),fixtureInputsSha256:c.fixtureInputsSha256})).toThrow('bta_driver_scope_invalid');
});
it('rejects an unknown Java compiler executable',()=>{const d=record(),c=d.matrices[0].cases[0],r=structuredClone(c.runs[1]);r.gradle.javacExecutableSha256='0'.repeat(64);expect(()=>verifyBtaDriverRun(r,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,fixtureInputsSha256:c.fixtureInputsSha256})).toThrow('bta_driver_scope_invalid');});

it('rejects missing configuration binding evidence',()=>{
 const d=record(),c=d.matrices[0].cases[0],r=structuredClone(c.runs[1]);delete r.program.configurationBindings;
 expect(()=>verifyBtaDriverRun(r,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,fixtureInputsSha256:c.fixtureInputsSha256})).toThrow('bta_driver_configuration_invalid');
});
it('rejects a consumer attributed to a different configuration',()=>{
 const d=record(),c=d.matrices[0].cases[0],r=structuredClone(c.runs[1]);r.program.compilations[2].configurationId='config-foreign';
 expect(()=>verifyBtaDriverRun(r,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,fixtureInputsSha256:c.fixtureInputsSha256})).toThrow('bta_driver_configuration_invalid');
});

for(const mode of ['default-config','unregistered-config','foreign-config'])it('keeps the rejected final configuration separate from warm outputs: '+mode,()=>{
 const d=record(),c=d.matrices[0].cases[0],r=c.runs.find((r:any)=>r.mode===mode);const last=r.program.configurationChecks.at(-1);
 expect(last.expectedConfigurationId).toBe('config-3');expect(last.actualConfigurationId).toBe('config-4');expect(last.configurationIdentity).toBe(false);
 expect(r.program.compilations).toHaveLength(2);expect(r.execution).toEqual({stage:'warm',code:0,stdout:'library-value:v1'});expect(r.program.finalOutputs).toEqual([]);
 expect(last.registered).toBe(mode==='foreign-config');expect(last.snapshotBindingsMatch).toBe(mode!=='default-config');
});
it('requires a foreign configuration to be rejected even when its snapshot values are equal',()=>{
 const d=record(),c=d.matrices[0].cases[0],r=structuredClone(c.runs[8]);r.program.configurationChecks[2].parameterIdentity=true;
 expect(()=>verifyBtaDriverRun(r,{gradleVersion:c.gradleVersion,dsl:c.dsl,javaSha256:d.javaSha256,fixtureInputsSha256:c.fixtureInputsSha256})).toThrow('bta_driver_configuration_invalid');
});
