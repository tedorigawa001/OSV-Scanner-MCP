import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {offerSources,offerVerificationSources,verifyOfferCase} from '../fixtures/btaOfferProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
import {readOwnedOffer,offerLimitations} from '../fixtures/btaOfferContract.mjs';
const unavailable=()=>({schema:'osv-mcp.gradle-owned-offer-v1',graphId:'graph',exportId:'export',project:':',invocation:'one',stage:'consumer',slot:'snapshot',profileId:'test',producerState:'unavailable',limitations:[...offerLimitations],naturalContentBinding:false,phases:[],unavailableReason:'execution_unsupported',blockedBeforePhase:'registration',noRead:true});
it('accepts a legal unavailable envelope with no source or file reads',()=>{
 const result=readOwnedOffer(unavailable(),{trust:false,profiles:{},graphId:'graph',exportId:'export'},()=>{throw Error('unexpected file read');});
 expect(result).toMatchObject({producerState:'unavailable',importStatus:'unavailable',reason:'owned_offer_trust_disabled',fileReads:0,naturalReady:false});
});

it('rejects unavailable with an invented successful call even when trust is disabled',()=>{
 const e:any=unavailable();e.phases=[{phase:'call',outcome:'success',evidence:{}}];
 expect(()=>readOwnedOffer(e,{trust:false,profiles:{}},()=>{throw Error('read');})).toThrow('owned_offer_schema_invalid');
});

// Synthetic schema fixtures exercise the static reader; they are not native compilation evidence.
const bytes=Buffer.from('snapshot');
const sha=createHash('sha256').update(bytes).digest('hex');
const registration={producerSha256:'a'.repeat(64),runtimeSha256:'b'.repeat(64),profileSha256:'c'.repeat(64)};
const settings=()=>({trust:true,profiles:{test:{registration,strategy:'in-process'}},graphId:'graph',exportId:'export'});
function complete():any{
 const e:any=unavailable();delete e.unavailableReason;delete e.blockedBeforePhase;delete e.noRead;e.producerState='completed';
 const evidence:any={registration,generation:{librarySha256:'d'.repeat(64),generatorSha256:'e'.repeat(64),snapshots:[{id:'lib',size:bytes.length,sha256:sha,inputSha256:'d'.repeat(64)}]},seal:{files:[{id:'lib',path:'staging/lib',baselinePath:'evidence/lib',size:bytes.length,sha256:sha}]},binding:{configurationId:'c',parameterId:'p',serviceId:'s',projectId:'project',snapshotIds:['lib'],sourceSha256:'f'.repeat(64),argumentsSha256:'1'.repeat(64),outputPath:'classes'},precheck:{matched:true},call:{result:'COMPILATION_SUCCESS',configurationId:'c',parameterId:'p',executionEvidence:'bta-call-only',compilerWorkStatus:'unknown',outputs:[]},postcheck:{matched:true}};
 e.phases=Object.entries(evidence).flatMap(([phase,evidence])=>[{phase,outcome:'begin'},{phase,outcome:'success',evidence}]);return e;
}
it('checks original bytes on every import without upgrading empty outputs to compiler work',()=>{
 const seen:string[]=[];const result=readOwnedOffer(complete(),settings(),p=>{seen.push(p);return bytes;});
 expect(seen).toEqual(['evidence/lib','staging/lib']);expect(result).toMatchObject({importStatus:'accepted',compilerWorkStatus:'unknown',fileReads:2,naturalReady:false});
});

function failed(phase:string,reason:string):any{
 const e=complete(),i=e.phases.findIndex((x:any)=>x.phase===phase);e.phases=e.phases.slice(0,i+1);e.phases.push({phase,outcome:'failure',evidence:{reason,produced:'not-produced'}});e.producerState='failed';e.failurePhase=phase;e.failureReason=reason;return e;
}
it('rejects call failure lacking a result or exception witness',()=>expect(()=>readOwnedOffer(failed('call','compile_failed'),settings(),()=>bytes)).toThrow('owned_offer_schema_invalid'));

for(const phase of ['registration','generation','seal','binding','precheck','call','postcheck'])it('rejects a missing completed phase with trust disabled: '+phase,()=>{
 const e=complete();e.phases=e.phases.filter((x:any)=>x.phase!==phase);
 expect(()=>readOwnedOffer(e,{...settings(),trust:false},()=>{throw Error('read');})).toThrow(/^owned_offer_/);
});
for(const reason of ['storage_failed','budget_exceeded','extra_evaluation'])it('accepts a failed seal prefix without later compile evidence: '+reason,()=>{
 const e=failed('seal',reason);expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({producerState:'failed',importStatus:'failed',fileReads:0});
});
it('accepts a call result failure with its real error kind and result',()=>{
 const e=failed('call','compile_failed');Object.assign(e.phases.at(-1).evidence,{errorKind:'result',detail:'COMPILATION_ERROR'});
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({importStatus:'failed',fileReads:0});
});
for(const state of ['completed','failed','unavailable'])it('does not confuse reader trust status with producer state: '+state,()=>{
 const e=state==='completed'?complete():state==='failed'?failed('seal','storage_failed'):unavailable();
 for(const gate of [{...settings(),trust:false},{...settings(),profiles:{}},{...settings(),profiles:{test:{registration,strategy:'daemon'}}}]){
  const r=readOwnedOffer(e,gate,()=>{throw Error('read');});expect(r.producerState).toBe(state);expect(r.fileReads).toBe(0);
 }
});
const faults:Record<string,(e:any)=>void>={
 'unknown schema':e=>e.schema='unknown',
 'missing limitation':e=>e.limitations.pop(),
 'status elevation':e=>e.naturalContentBinding=true,
 'compiler work elevation':e=>e.phases[11].evidence.compilerWorkStatus='performed',
 'call-only claim missing':e=>delete e.phases[11].evidence.executionEvidence,
 'different configuration':e=>e.phases[11].evidence.configurationId='other',
 'different parameter':e=>e.phases[11].evidence.parameterId='other',
 'snapshot list replacement':e=>e.phases[7].evidence.snapshotIds=['other'],
 'baseline escape':e=>e.phases[5].evidence.files[0].baselinePath='../escape',
 'absolute source path':e=>e.phases[5].evidence.files[0].path='/etc/passwd',
 'content swapped':e=>e.phases[5].evidence.files[0].sha256='0'.repeat(64),
 'failure fields on completed':e=>e.failureReason='storage_failed',
 'invented success after failure':e=>{const f=failed('seal','storage_failed');Object.assign(e,f);e.phases.push({phase:'binding',outcome:'begin'});},
 'fake failure phase':e=>{Object.assign(e,failed('seal','storage_failed'));e.failurePhase='call';},
 'failed reclassified as unavailable':e=>{Object.assign(e,failed('seal','storage_failed'));e.producerState='unavailable';},
};
for(const [name,fault]of Object.entries(faults))it('rejects envelope contradiction before any read: '+name,()=>{
 const e=complete();fault(e);let reads=0;expect(()=>readOwnedOffer(e,{...settings(),trust:false},()=>{reads++;return bytes;})).toThrow(/^owned_offer_/);expect(reads).toBe(0);
});
it('rejects an existing approved profile with a different producer digest without reading files',()=>{
 const e=complete();e.phases[1].evidence={...registration,producerSha256:'0'.repeat(64)};
 expect(()=>readOwnedOffer(e,settings(),()=>{throw Error('read');})).toThrow('owned_offer_profile_mismatch');
});
it('rejects a different export instead of importing past evidence',()=>expect(()=>readOwnedOffer(complete(),{...settings(),exportId:'other'},()=>bytes)).toThrow('owned_offer_binding_mismatch'));
it('rejects changed saved bytes and the first capture after modification against the original digest',()=>{
 const e=complete();expect(()=>readOwnedOffer(e,settings(),()=>Buffer.from('changed!'))).toThrow('owned_offer_content_mismatch');
 expect(readOwnedOffer(e,settings(),()=>bytes).importStatus).toBe('accepted');
 expect(()=>readOwnedOffer(e,settings(),()=>Buffer.from('changed!'))).toThrow('owned_offer_content_mismatch');
});
it('rejects a known integrity failure even when the producer honestly marks it failed',()=>expect(()=>readOwnedOffer(failed('precheck','binding_mismatch'),{...settings(),trust:false},()=>bytes)).toThrow('owned_offer_binding_mismatch'));

it('accepts an unavailable prefix stopped before binding, with no reader file accesses',()=>{
 const e=complete();e.producerState='unavailable';e.phases=e.phases.slice(0,6);Object.assign(e,{unavailableReason:'evidence_unavailable',blockedBeforePhase:'binding',noRead:true});
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({importStatus:'unavailable',reason:'owned_offer_evidence_unavailable',fileReads:0});
});
it('rejects a claimed snapshot size over the per-file budget before calling a reader',()=>{
 const e=complete();e.phases[3].evidence.snapshots[0].size=40*1024**2;e.phases[5].evidence.files[0].size=40*1024**2;
 expect(()=>readOwnedOffer(e,settings(),()=>{throw Error('read');})).toThrow('owned_offer_budget_exceeded');
});

const published=()=>JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-bta-offer-contract-2026-11-02.json',import.meta.url),'utf8'));
it('replays the native envelopes and gates with their original implementation fingerprints',()=>{
 const d=published();expect(d.schema).toBe('osv-mcp.bta-offer-contract-experiment-v2');assertNoAbsolutePaths(d);
 expect(Object.keys(d.sourcesSha256)).toEqual(offerSources);expect(Object.keys(d.verificationSourcesSha256)).toEqual(offerVerificationSources);
 for(const group of ['sourcesSha256','verificationSourcesSha256'])for(const [p,h]of Object.entries(d[group]))expect(createHash('sha256').update(readFileSync(new URL('../../../'+p,import.meta.url))).digest('hex'),p).toBe(h);
 const scope:Record<string,number>={};for(const c of d.cases){expect(c.sourceHashes).toEqual(d.sourcesSha256);for(const [k,v]of Object.entries(verifyOfferCase(c)))scope[k]=(scope[k]??0)+v;}
 expect(d.cases.map((c:any)=>c.gradleVersion+':'+c.dsl)).toEqual(['8.11.1:Groovy','8.11.1:Kotlin','9.2.1:Groovy','9.2.1:Kotlin']);expect(d.scope).toEqual(scope);
});
const recordFaults:Record<string,(c:any)=>void>={
 'missing rejection':c=>c.report.rejections.pop(),
 'extra call on reused handle':c=>c.report.rejections[2].callsAfter++,
 'different profile':c=>c.registration.producerSha256='0'.repeat(64),
 'natural receipt claim':c=>c.report.naturalContentBinding=true,
 'production adoption claim':c=>c.report.productionAdopted=true,
 'missing phase evidence':c=>c.report.envelopes[0].phases.splice(4,2),
 'gate read':c=>c.decisions[0].gates[0].fileReads++,
 'forged compiler work':c=>c.decisions[0].trusted.compilerWorkStatus='performed',
 'different actual JVM':c=>c.report.javaSha256='0'.repeat(64),
 'missing executed class':c=>c.report.driverClasses.pop(),
};
for(const [name,fault]of Object.entries(recordFaults))it('rejects published native evidence mutation: '+name,()=>{
 const c=published().cases[0];fault(c);expect(()=>verifyOfferCase(c)).toThrow();
});

for(const detail of ['COMPILATION_SUCCESS','UNKNOWN_RESULT'])it('rejects contradictory or unknown call failure result: '+detail,()=>{
 const e=failed('call','compile_failed');Object.assign(e.phases.at(-1).evidence,{errorKind:'result',detail});
 expect(()=>readOwnedOffer(e,settings(),()=>{throw Error('read');})).toThrow('owned_offer_schema_invalid');
});
for(const name of ['storage-failed','call-failed'])it('rejects failed reclassified as unavailable even with all decisions rewritten: '+name,()=>{
 const c=published().cases[0],e=c.report.envelopes.find((e:any)=>e.invocation===name);
 delete e.failurePhase;delete e.failureReason;Object.assign(e,{producerState:'unavailable',phases:[],unavailableReason:'execution_unsupported',blockedBeforePhase:'registration',noRead:true});
 const s={trust:true,profiles:{[e.profileId]:{registration:c.registration,strategy:'in-process'}},graphId:e.graphId,exportId:e.exportId};
 const d=c.decisions.find((d:any)=>d.invocation===name);d.trusted=readOwnedOffer(e,s,()=>{throw Error('read');});d.gates=[{...s,trust:false},{...s,profiles:{}}].map(g=>readOwnedOffer(e,g,()=>{throw Error('read');}));
 expect(()=>verifyOfferCase(c)).toThrow('bta_offer_record_invalid');
});

for(const detail of ['COMPILATION_ERROR','COMPILATION_OOM_ERROR','COMPILER_INTERNAL_ERROR'])it('retains a known non-success BTA result: '+detail,()=>{
 const e=failed('call','compile_failed');Object.assign(e.phases.at(-1).evidence,{errorKind:'result',detail});
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');}).importStatus).toBe('failed');
});
for(const field of ['failurePhase','failureReason'])it('rejects a different expected failure '+field,()=>{
 const c=published().cases[0],e=c.report.envelopes.find((e:any)=>e.invocation==='call-failed');e[field]=field==='failurePhase'?'seal':'storage_failed';expect(()=>verifyOfferCase(c)).toThrow();
});
for(const field of ['libraryCalls','btaConsumerCalls','generatedSnapshots'])it('checks the reported counter against verified evidence: '+field,()=>{
 const c=published().cases[0];c.report[field]++;expect(()=>verifyOfferCase(c)).toThrow('bta_offer_record_invalid');
});
