import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {offerSources,offerVerificationSources,verifyOfferCase} from '../fixtures/btaOfferProof.mjs';
import {assertNoAbsolutePaths} from '../manual/kgpRecordPaths.mjs';
import {readOwnedOffer,offerLimitations,classifyOfferExecution} from '../fixtures/btaOfferContract.mjs';
const unavailable=()=>({schema:'osv-mcp.gradle-owned-offer-v1',executionId:'unit-execution',graphId:'graph',exportId:'export',project:':',invocation:'one',stage:'consumer',slot:'snapshot',profileId:'test',producerState:'unavailable',plannedCaptures:0,limitations:[...offerLimitations],naturalContentBinding:false,phases:[],unavailableReason:'execution_unsupported',blockedBeforePhase:'registration',noRead:true});
it('accepts a legal unavailable envelope with no source or file reads',()=>{
 const result=readOwnedOffer(unavailable(),{...settings(),trust:false,profiles:{}},()=>{throw Error('unexpected file read');});
 expect(result).toMatchObject({producerState:'unavailable',importStatus:'unavailable',reason:'owned_offer_trust_disabled',fileReads:0,naturalReady:false});
});

it('rejects unavailable with an invented successful call even when trust is disabled',()=>{
 const e:any=unavailable();e.phases=[{phase:'call',outcome:'success',evidence:{}}];
 expect(()=>readOwnedOffer(e,{...settings(),trust:false,profiles:{}},()=>{throw Error('read');})).toThrow('owned_offer_schema_invalid');
});

// Synthetic schema fixtures exercise the static reader; they are not native compilation evidence.
const bytes=Buffer.from('snapshot');
const sha=createHash('sha256').update(bytes).digest('hex');
const source=Buffer.from('fun main() {}\n'),sourceSha=createHash('sha256').update(source).digest('hex');
const registration={producerSha256:'a'.repeat(64),runtimeSha256:'b'.repeat(64),profileSha256:'c'.repeat(64)};
const settings=()=>({executionId:'unit-execution',executionWitness:{executionId:'unit-execution',actionCalls:1,didWork:true,skipped:false,noSource:false,failed:false,skipMessage:null},trust:true,profiles:{test:{registration,strategy:'in-process'}},graphId:'graph',exportId:'export'});
function complete():any{
 const e:any=unavailable();delete e.unavailableReason;delete e.blockedBeforePhase;delete e.noRead;e.producerState='completed';
 const evidence:any={registration,generation:{librarySha256:'d'.repeat(64),generatorSha256:'e'.repeat(64),snapshots:[{id:'lib',size:bytes.length,sha256:sha,inputSha256:'d'.repeat(64)}]},seal:{files:[{id:'lib',path:'staging/lib',baselinePath:'evidence/lib',size:bytes.length,sha256:sha}]},binding:{configurationId:'c',parameterId:'p',serviceId:'s',projectId:'project',snapshotIds:['lib'],sourcePath:'src/Consumer.kt',sourceSha256:sourceSha,argumentsSha256:'1'.repeat(64),outputPath:'classes',incrementalStatePath:'ic',sourceChanges:'unknown'},precheck:{matched:true},call:{result:'COMPILATION_SUCCESS',configurationId:'c',parameterId:'p',executionEvidence:'bta-call-only',compilerWorkStatus:'unknown',outputs:[]},postcheck:{matched:true}};
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
 const e=failed('seal',reason);expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({producerState:'failed',importStatus:'producer_failed',reason:null,producerReason:reason,fileReads:0});
});
it('accepts a call result failure with its real error kind and result',()=>{
 const e=failed('call','compile_failed');Object.assign(e.phases.at(-1).evidence,{errorKind:'result',detail:'COMPILATION_ERROR'});
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({importStatus:'producer_failed',fileReads:0});
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
it('rejects a different export as a reader claim mismatch instead of importing past evidence',()=>expect(()=>readOwnedOffer(complete(),{...settings(),exportId:'other'},()=>bytes)).toThrow('owned_offer_claim_mismatch'));
it('rejects changed saved bytes and the first capture after modification against the original digest',()=>{
 const e=complete();expect(()=>readOwnedOffer(e,settings(),()=>Buffer.from('changed!'))).toThrow('owned_offer_content_mismatch');
 expect(readOwnedOffer(e,settings(),()=>bytes).importStatus).toBe('accepted');
 expect(()=>readOwnedOffer(e,settings(),()=>Buffer.from('changed!'))).toThrow('owned_offer_content_mismatch');
});
for(const reason of ['binding_mismatch','configuration_unregistered','configuration_reused'])it('accepts a producer-recorded identity refusal as producer_failed without a graph rejection: '+reason,()=>{
 const e=failed('precheck',reason);
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({producerState:'failed',importStatus:'producer_failed',reason:null,producerReason:reason,fileReads:0});
 expect(readOwnedOffer(e,{...settings(),trust:false},()=>{throw Error('read');})).toMatchObject({importStatus:'unavailable',reason:'owned_offer_trust_disabled',fileReads:0});
});
const stale=(phase:string)=>{const e=failed(phase,'stale');if(phase==='capture'){const f=complete();f.plannedCaptures=1;f.phases.push({phase:'capture',outcome:'begin'},{phase:'capture',outcome:'failure',evidence:{reason:'stale',produced:'not-produced'}});Object.assign(f,{producerState:'failed',failurePhase:'capture',failureReason:'stale'});return f;}return e;};
const reader=(staging:Buffer,src=source)=>(p:string)=>p==='src/Consumer.kt'?src:p.startsWith('staging/')?staging:bytes;
for(const phase of ['precheck','postcheck','capture'])it('accepts a recorded stale refusal only after the reader re-reads a mismatch: '+phase,()=>{
 expect(readOwnedOffer(stale(phase),settings(),reader(Buffer.from('changed!')))).toMatchObject({importStatus:'producer_failed',producerReason:'stale',fileReads:3});
 expect(readOwnedOffer(stale(phase),settings(),reader(bytes,Buffer.from('changed source')))).toMatchObject({importStatus:'producer_failed',fileReads:3});
 expect(()=>readOwnedOffer(stale(phase),settings(),reader(bytes))).toThrow('owned_offer_claim_mismatch');
});
it('rejects an identity refusal relabelled as stale when the reader sees unchanged content',()=>{
 const e=failed('precheck','binding_mismatch');e.failureReason='stale';e.phases.at(-1).evidence.reason='stale';
 expect(()=>readOwnedOffer(e,settings(),reader(bytes))).toThrow('owned_offer_claim_mismatch');
});
for(const [phase,reason] of [['seal','stale'],['precheck','compile_failed'],['postcheck','binding_mismatch'],['generation','configuration_reused']])it('rejects a producer reason moved to an impossible phase: '+reason+'@'+phase,()=>{
 expect(()=>readOwnedOffer(failed(phase!,reason!),{...settings(),trust:false},()=>{throw Error('read');})).toThrow('owned_offer_claim_mismatch');
});
const captureFaults:Record<string,(e:any)=>void>={
 'planned capture missing':e=>{e.plannedCaptures=1;},
 'capture beyond plan':e=>{e.phases.push({phase:'capture',outcome:'begin'},{phase:'capture',outcome:'success',evidence:{matched:true}});},
 'interim pending state':e=>{e.producerState='pending';},
 'plan over budget':e=>{e.plannedCaptures=99;},
 'plan missing':e=>{delete e.plannedCaptures;},
};
for(const [name,fault]of Object.entries(captureFaults))it('rejects a non-terminal or inconsistent completed capture plan: '+name,()=>{
 const e=complete();fault(e);expect(()=>readOwnedOffer(e,{...settings(),trust:false},()=>{throw Error('read');})).toThrow(/^owned_offer_(schema_invalid|required_evidence_missing)$/);
});
it('rejects a capture failure without a planned capture',()=>{const e=stale('capture');e.plannedCaptures=0;expect(()=>readOwnedOffer(e,{...settings(),trust:false},()=>{throw Error('read');})).toThrow('owned_offer_schema_invalid');});
it('rejects unavailable after binding because the reader-no-read claim no longer holds',()=>{
 const e=complete();e.producerState='unavailable';e.phases=e.phases.slice(0,10);Object.assign(e,{unavailableReason:'evidence_unavailable',blockedBeforePhase:'call',noRead:true});
 expect(()=>readOwnedOffer(e,{...settings(),trust:false},()=>{throw Error('read');})).toThrow('owned_offer_schema_invalid');
});

it('accepts an unavailable prefix stopped before binding, with no reader file accesses',()=>{
 const e=complete();e.producerState='unavailable';e.phases=e.phases.slice(0,6);Object.assign(e,{unavailableReason:'evidence_unavailable',blockedBeforePhase:'binding',noRead:true});
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');})).toMatchObject({importStatus:'producer_unavailable',reason:null,producerReason:'evidence_unavailable',fileReads:0});
});
it('rejects a claimed snapshot size over the per-file budget before calling a reader',()=>{
 const e=complete();e.phases[3].evidence.snapshots[0].size=40*1024**2;e.phases[5].evidence.files[0].size=40*1024**2;
 expect(()=>readOwnedOffer(e,settings(),()=>{throw Error('read');})).toThrow('owned_offer_budget_exceeded');
});

const published=()=>JSON.parse(readFileSync(new URL('../../../docs/validation/gradle-bta-offer-contract-2026-11-02.json',import.meta.url),'utf8'));
it('replays the native envelopes and gates with their original implementation fingerprints',()=>{
 const d=published();expect(d.schema).toBe('osv-mcp.bta-offer-contract-experiment-v6');expect(d.preReviews.map((p:any)=>p.schema)).toEqual(['osv-mcp.bta-offer-contract-experiment-v1','osv-mcp.bta-offer-contract-experiment-v2','osv-mcp.bta-offer-contract-experiment-v3','osv-mcp.bta-offer-contract-experiment-v4','osv-mcp.bta-offer-contract-experiment-v5']);expect(d.preReviews.map((p:any)=>p.committedIn??null)).toEqual([null,'a6d5409','d1f8557',null,'c555f4f']);expect(d.scope.readerIntegrityRejections).toBe(0);assertNoAbsolutePaths(d);
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
 'producer refusal forged as graph rejection':c=>{c.decisions.find((d:any)=>d.invocation==='post-failed').trusted={rejected:'owned_offer_stale'};},
 'stale refusal without re-read':c=>{c.decisions.find((d:any)=>d.invocation==='stale-precheck').trusted.fileReads=0;},
 'binding refusal reported as accepted':c=>{c.decisions.find((d:any)=>d.invocation==='foreign-paths').trusted.importStatus='accepted';},
 'capture plan removed':c=>{c.report.envelopes.find((e:any)=>e.invocation==='capture-failed').plannedCaptures=0;},
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
 const s={executionId:e.executionId,executionWitness:c.executionEvidence[0].witness,trust:true,profiles:{[e.profileId]:{registration:c.registration,strategy:'in-process'}},graphId:e.graphId,exportId:e.exportId};
 const d=c.decisions.find((d:any)=>d.invocation===name);d.trusted=readOwnedOffer(e,s,()=>{throw Error('read');});d.gates=[{...s,trust:false},{...s,profiles:{}}].map(g=>readOwnedOffer(e,g,()=>{throw Error('read');}));
 expect(()=>verifyOfferCase(c)).toThrow('bta_offer_record_invalid');
});

for(const detail of ['COMPILATION_ERROR','COMPILATION_OOM_ERROR','COMPILER_INTERNAL_ERROR'])it('retains a known non-success BTA result: '+detail,()=>{
 const e=failed('call','compile_failed');Object.assign(e.phases.at(-1).evidence,{errorKind:'result',detail});
 expect(readOwnedOffer(e,settings(),()=>{throw Error('read');}).importStatus).toBe('producer_failed');
});
for(const field of ['failurePhase','failureReason'])it('rejects a different expected failure '+field,()=>{
 const c=published().cases[0],e=c.report.envelopes.find((e:any)=>e.invocation==='call-failed');e[field]=field==='failurePhase'?'seal':'storage_failed';expect(()=>verifyOfferCase(c)).toThrow();
});
for(const field of ['libraryCalls','btaConsumerCalls','generatedSnapshots'])it('checks the reported counter against verified evidence: '+field,()=>{
 const c=published().cases[0];c.report[field]++;expect(()=>verifyOfferCase(c)).toThrow('bta_offer_record_invalid');
});

it('does not adopt a restored success report when the BTA task action did not execute',()=>{
 const witness={executionId:'cache',actionCalls:0,didWork:false,skipped:true,noSource:false,failed:false,skipMessage:'FROM-CACHE'};
 expect(classifyOfferExecution(witness)).toEqual({executionId:'cache',btaTaskActionExecuted:false,importStatus:'unavailable',reason:'owned_offer_action_not_executed',executionEvidence:'not-called',compilerWorkStatus:'unknown',naturalReady:false});
});

for(const mode of ['skip','cache'])it('does not let '+mode+' reuse a cached success as a new BTA call',()=>{
 const c=published().cases[0],e=c.executionEvidence.find((e:any)=>e.mode===mode);e.classification.importStatus='accepted';expect(()=>verifyOfferCase(c)).toThrow();
});
for(const key of ['sourcePath','sourceSha256','incrementalStatePath','projectId','argumentsSha256'])it('requires unchanged-call binding to retain '+key,()=>{
 const c=published().cases[0],e=c.report.envelopes.find((e:any)=>e.invocation==='unchanged'),b=e.phases.find((p:any)=>p.phase==='binding'&&p.outcome==='success').evidence;
 b[key]=key.endsWith('Sha256')?'0'.repeat(64):'different';expect(()=>verifyOfferCase(c)).toThrow();
});
for(const kind of ['configuration','parameter'])it('requires a new '+kind+' identity for the unchanged invocation',()=>{
 const c=published().cases[0],first=c.report.envelopes[0],e=c.report.envelopes.find((e:any)=>e.invocation==='unchanged'),key=kind+'Id',original=first.phases.find((p:any)=>p.phase==='binding'&&p.outcome==='success').evidence[key];
 for(const p of e.phases)if(p.outcome==='success'&&['binding','call'].includes(p.phase))p.evidence[key]=original;
 expect(()=>verifyOfferCase(c)).toThrow();
});
it('does not accept an unknown-change recompile as the known-empty unchanged experiment',()=>{
 const c=published().cases[0],e=c.report.envelopes.find((e:any)=>e.invocation==='unchanged');e.phases.find((p:any)=>p.phase==='binding'&&p.outcome==='success').evidence.sourceChanges='unknown';expect(()=>verifyOfferCase(c)).toThrow();
});
for(const field of ['actionCalls','didWork','skipped','noSource','failed','skipMessage','executionId'])it('rejects missing execution witness field '+field,()=>{
 const w:any={executionId:'cache',actionCalls:0,didWork:false,skipped:true,noSource:false,failed:false,skipMessage:'FROM-CACHE'};delete w[field];expect(()=>classifyOfferExecution(w)).toThrow('owned_offer_schema_invalid');
});
it('rejects a FROM-CACHE witness that also claims to have executed the BTA task action',()=>expect(()=>classifyOfferExecution({executionId:'cache',actionCalls:1,didWork:false,skipped:true,noSource:false,failed:false,skipMessage:'FROM-CACHE'})).toThrow('owned_offer_execution_invalid'));
it('marks a real task action only as eligible for envelope inspection, not as compiler work',()=>expect(classifyOfferExecution({executionId:'seed',actionCalls:1,didWork:true,skipped:false,noSource:false,failed:false,skipMessage:null})).toMatchObject({importStatus:'inspect-current-envelope',compilerWorkStatus:'unknown',naturalReady:false}));

for(const skipMessage of ['SKIPPED','FROM-CACHE'])it('refuses a success envelope at the actual reader entry point for '+skipMessage,()=>{
 const witness={executionId:'current',actionCalls:0,didWork:false,skipped:true,noSource:false,failed:false,skipMessage};let reads=0;
 const result=readOwnedOffer(complete(),{...settings(),executionId:'current',executionWitness:witness},()=>{reads++;throw Error('unexpected-read');});
 expect(result).toEqual({producerState:'completed',importStatus:'unavailable',reason:'owned_offer_action_not_executed',producerReason:null,fileReads:0,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'not-called',compilerWorkStatus:'unknown'});expect(reads).toBe(0);
});
it('refuses an old success envelope under a fresh executed witness as a claim mismatch',()=>{
 const e=complete();e.executionId='old';const witness={executionId:'new',actionCalls:1,didWork:true,skipped:false,noSource:false,failed:false,skipMessage:null};
 expect(()=>readOwnedOffer(e,{...settings(),executionId:'new',executionWitness:witness},()=>bytes)).toThrow('owned_offer_claim_mismatch');
});

for(const name of ['ic-delete','ic-modify','ic-reset'])it('replays a real precheck IC refusal with no BTA retry: '+name,()=>{
 const c=published().cases[0],check=c.report.icChecks.find((x:any)=>x.invocation===name),e=c.report.envelopes.find((x:any)=>x.invocation===name);
 expect(check.matched).toBe(false);expect(c.report.icBaselines.find((x:any)=>x.invocation===check.seedInvocation).snapshot).not.toEqual(check.beforeCall);expect(check.callsAfterCheck).toBe(check.callsBefore);expect(e.phases.some((x:any)=>x.phase==='call')).toBe(false);expect(verifyOfferCase(c).icStateRejections).toBe(3);
});
const icFaults:Record<string,(c:any)=>void>={
 'missing IC baseline':c=>c.report.icBaselines.pop(),
 'missing pre-call IC snapshot':c=>delete c.report.icChecks[0].beforeCall,
 'fault declared matched':c=>c.report.icChecks[1].matched=true,
 'fault baseline replaced by current state':c=>{const check=c.report.icChecks[1];c.report.icBaselines.find((x:any)=>x.invocation===check.seedInvocation).snapshot=check.beforeCall;},
 'duplicated baseline republished in a check':c=>{const check=c.report.icChecks[0];check.baseline=c.report.icBaselines.find((x:any)=>x.invocation===check.seedInvocation).snapshot;},
 'raw device/inode file key':c=>{c.report.icChecks[0].beforeCall.entries[0].fileKey='(dev=1,ino=2)';},
 'raw device/inode root key':c=>{c.report.icBaselines[0].snapshot.rootKey='(dev=1,ino=2)';},
 'IC descriptor digest modified':c=>{c.report.icChecks[0].beforeCall.entries.find((x:any)=>x.kind==='file').sha256='0'.repeat(64);},
 'IC snapshot recaptured after deletion':c=>{const check=c.report.icChecks[1];c.report.icBaselines.find((x:any)=>x.invocation===check.seedInvocation).snapshot=check.beforeCall;check.matched=true;},
 'unexpected BTA call during IC check':c=>c.report.icChecks[1].callsAfterCheck++,
 'skipped adoption accepted':c=>c.executionEvidence[1].adoption.importStatus='accepted',
 'cached adoption reader invoked':c=>c.executionEvidence[2].adoptionFileReads=1,
 'restored envelope execution relabeled':c=>c.executionEvidence[2].envelopeExecutionId=c.executionEvidence[2].witness.executionId,
};
for(const [name,fault]of Object.entries(icFaults))it('rejects IC / execution-gate record mutation: '+name,()=>{const c=published().cases[0];fault(c);expect(()=>verifyOfferCase(c)).toThrow();});
it('requires an execution witness at the sole adoption entry point',()=>{const s:any=settings();delete s.executionWitness;expect(()=>readOwnedOffer(complete(),s,()=>bytes)).toThrow('owned_offer_schema_invalid');});
it('binds execution witness to an independently expected invocation id',()=>expect(()=>readOwnedOffer(complete(),{...settings(),executionId:'other'},()=>bytes)).toThrow('owned_offer_execution_invalid'));
it('validates a retained envelope even when the action did not execute, still without file reads',()=>{
 const e=complete();e.limitations.pop();const witness={executionId:'current',actionCalls:0,didWork:false,skipped:true,noSource:false,failed:false,skipMessage:'SKIPPED'};
 expect(()=>readOwnedOffer(e,{...settings(),executionId:'current',executionWitness:witness},()=>{throw Error('read');})).toThrow('owned_offer_schema_invalid');
});
it('adopts whatever witness the caller supplies: authenticity rests on the caller',()=>{
 const e=complete();e.executionId='old';const forged={executionId:'old',actionCalls:1,didWork:true,skipped:false,noSource:false,failed:false,skipMessage:null};
 expect(readOwnedOffer(e,{...settings(),executionId:'old',executionWitness:forged},()=>bytes).importStatus).toBe('accepted');
});
