import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {verifyBtaDriverRun,verifyBtaDriverCase,btaDriverRegressions,mutateBtaDriver,btaDriverTargets,hash,btaSources} from '../fixtures/gradleBtaDriverProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
import {btaRecordSchema,btaBindingSemantics,nativeBtaCase,verifyBtaRecordSemantics} from '../manual/btaDriverRecord.mjs';
const published=()=>JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-bta-owned-driver-2026-11-02.json',import.meta.url),'utf8'));
const nativeView=(d:any)=>{verifyBtaRecordSemantics(d);return {...d,matrices:d.matrices.map((m:any)=>({...m,cases:m.cases.map(nativeBtaCase)}))};};
const record=()=>nativeView(published());
it('rejects an empty report rather than claiming a natural receipt',()=>expect(()=>verifyBtaDriverRun({},{})).toThrow('bta_driver_schema_invalid'));
it('replays all native BTA stages, program outputs and rejection evidence',()=>{
 const d=record();expect(d.schema).toBe(btaRecordSchema);expect(d.bindingSemantics).toEqual(btaBindingSemantics);assertNoAbsolutePaths(d);
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

it('publishes only a private IC cache summary with the retained shrunk snapshot',()=>{
 const d=published();for(const m of d.matrices)for(const c of m.cases)for(const r of c.runs){const s=r.program.privateCache;expect(Array.isArray(s)).toBe(false);expect(s.shrunkSnapshot.path).toBe('shrunk-classpath-snapshot.bin');expect(s.entries).toBeGreaterThan(1);}
 expect(d.preReviews.map((p:any)=>p.schema)).toEqual(['osv-mcp.bta-owned-driver-experiment-v1','osv-mcp.bta-owned-driver-experiment-v2']);expect(d.preReviews[1].committedIn).toBe('fd66e03');
});
const cacheFaults:Record<string,(s:any)=>void>={
 'republished inventory':s=>{s.inventory=[s.shrunkSnapshot];},
 'missing shrunk snapshot':s=>{delete s.shrunkSnapshot;},
 'renamed shrunk snapshot':s=>{s.shrunkSnapshot.path='other.bin';},
 'total smaller than retained entry':s=>{s.totalSize=s.shrunkSnapshot.size-1;},
 'invalid inventory digest':s=>{s.inventorySha256='x';},
};
for(const [name,fault]of Object.entries(cacheFaults))it('rejects a published cache summary: '+name,()=>{
 const d=published();fault(d.matrices[0].cases[0].runs[1].program.privateCache);expect(()=>nativeView(d)).toThrow('bta_driver_published_cache_invalid');
});
it('rejects a republished full cache inventory array',()=>{const d=published(),r=d.matrices[0].cases[0].runs[1];r.program.privateCache=[r.program.privateCache.shrunkSnapshot];expect(()=>nativeView(d)).toThrow('bta_driver_published_cache_invalid');});
for(const [name,fault]of Object.entries({'missing semantics':(d:any)=>{delete d.bindingSemantics;},'content-bound claim':(d:any)=>{d.bindingSemantics.snapshotDescriptorSource='parameter-bytes';},'dropped unproven check':(d:any)=>{d.bindingSemantics.nativeUnprovenChecks.pop();},'old schema':(d:any)=>{d.schema='osv-mcp.bta-owned-driver-experiment-v2';}}))it('rejects binding semantics: '+name,()=>{
 const d=published();fault(d);expect(()=>nativeView(d)).toThrow('bta_driver_binding_semantics_invalid');
});
