// Test-only contract proof. No production scanner imports this module.
import {createHash} from 'node:crypto';
export {ownerJdkProfile as offerJdkProfile} from './gradleSnapshotOwnerExpected.mjs';
export const offerLimitations=['offered-inputs-only','no-natural-consumption-receipt','no-all-writer-exclusion','no-compiler-internal-supplier-proof','no-transparent-kgp-integration','snapshot-slot-only','no-compiler-work-witness'];
export const offerPhases=['registration','generation','seal','binding','precheck','call','postcheck','capture'];
const sha=b=>createHash('sha256').update(b).digest('hex');
const fail=(r='schema_invalid')=>{throw Error('owned_offer_'+r);};
const str=x=>typeof x==='string'&&x.length>0&&x.length<=1024;
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);
const keys=(x,allowed,required=allowed)=>{if(!obj(x)||Object.keys(x).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(x,k)))fail();};
const list=(x,p,nonempty=true)=>{if(!Array.isArray(x)||(nonempty&&!x.length)||x.length>4096||!x.every(p))fail();};
const pathOK=p=>str(p)&&!p.includes(String.fromCharCode(0))&&!p.includes('\\')&&!p.startsWith('/')&&p.split('/').every(x=>x&&x!=='.'&&x!=='..')&&!p.includes(':');
const files=x=>list(x,f=>{keys(f,['path','size','sha256']);return pathOK(f.path)&&Number.isSafeInteger(f.size)&&f.size>=0&&digest(f.sha256);},false);
// Producer-recorded failure reasons and the phases where each can legitimately be recorded.
const reasonPhases={compile_failed:['call'],storage_failed:['generation','seal','postcheck','capture'],budget_exceeded:offerPhases,extra_evaluation:offerPhases,binding_mismatch:['binding','precheck'],configuration_unregistered:['precheck'],configuration_reused:['precheck'],ic_state_mismatch:['precheck'],storage_identity_mismatch:['precheck','postcheck','capture'],storage_inventory_mismatch:['seal','precheck','postcheck','capture'],content_mismatch:['precheck','postcheck','capture'],stale:['precheck','postcheck','capture'],path_invalid:['seal','precheck','postcheck','capture']};
// Content claims the reader re-confirms after the trust gate; identity claims rest on the broker.
const reverified=['stale','content_mismatch'];
export const maxPlannedCaptures=8;
function checkEvidence(phase,v){
 if(phase==='registration'){keys(v,['producerSha256','runtimeSha256','profileSha256']);if(!Object.values(v).every(digest))fail();}
 if(phase==='generation'){
  keys(v,['librarySha256','generatorSha256','snapshots']);if(!digest(v.librarySha256)||!digest(v.generatorSha256))fail();
  list(v.snapshots,f=>{keys(f,['id','size','sha256','inputSha256']);return str(f.id)&&Number.isSafeInteger(f.size)&&f.size>0&&digest(f.sha256)&&digest(f.inputSha256);});
 }
 if(phase==='seal'){
  keys(v,['files']);list(v.files,f=>{keys(f,['id','path','baselinePath','size','sha256']);return str(f.id)&&pathOK(f.path)&&pathOK(f.baselinePath)&&Number.isSafeInteger(f.size)&&f.size>0&&digest(f.sha256);});
 }
 if(phase==='binding'){keys(v,['configurationId','parameterId','serviceId','projectId','snapshotIds','sourcePath','sourceSha256','argumentsSha256','outputPath','incrementalStatePath','sourceChanges']);if(![v.configurationId,v.parameterId,v.serviceId,v.projectId].every(str))fail();list(v.snapshotIds,str);if(!pathOK(v.sourcePath)||!digest(v.sourceSha256)||!digest(v.argumentsSha256)||!pathOK(v.outputPath)||!pathOK(v.incrementalStatePath)||!['unknown','known-empty'].includes(v.sourceChanges))fail();}
 if(['precheck','postcheck','capture'].includes(phase)){keys(v,['matched']);if(v.matched!==true)fail('content_mismatch');}
 if(phase==='call'){
  keys(v,['result','configurationId','parameterId','executionEvidence','compilerWorkStatus','outputs']);
  if(v.result!=='COMPILATION_SUCCESS'||!str(v.configurationId)||!str(v.parameterId)||v.executionEvidence!=='bta-call-only'||v.compilerWorkStatus!=='unknown')fail();files(v.outputs);
 }
}
export function validateOwnedOffer(e){
 const common=['schema','executionId','graphId','exportId','project','invocation','stage','slot','profileId','producerState','plannedCaptures','limitations','naturalContentBinding','phases'];
 const extra=e?.producerState==='failed'?['failureReason','failurePhase']:e?.producerState==='unavailable'?['unavailableReason','blockedBeforePhase','noRead']:[];
 if(JSON.stringify(e)?.length>1024**2)fail('budget_exceeded');keys(e,[...common,...extra]);
 if(e.schema!=='osv-mcp.gradle-owned-offer-v1'||!['completed','failed','unavailable'].includes(e.producerState)||!['executionId','graphId','exportId','project','invocation','stage','profileId'].every(k=>str(e[k]))||e.slot!=='snapshot'||!Number.isSafeInteger(e.plannedCaptures)||e.plannedCaptures<0||e.plannedCaptures>maxPlannedCaptures||e.naturalContentBinding!==false||!eq(e.limitations,offerLimitations))fail();
 list(e.phases,x=>obj(x),false);if(e.phases.length>32)fail();
 const successful={};let index=0,captures=0;
 for(let i=0;i<e.phases.length;i+=2){
  const begin=e.phases[i],end=e.phases[i+1],phase=offerPhases[index];
  keys(begin,['phase','outcome']);if(begin.phase!==phase||begin.outcome!=='begin'||!end)fail();
  keys(end,['phase','outcome','evidence']);if(end.phase!==phase)fail();
  if(end.outcome==='failure'){
   keys(end.evidence,phase==='call'?['reason','produced','errorKind','detail']:['reason','produced']);if(phase==='call'&&(!['result','exception'].includes(end.evidence.errorKind)||!str(end.evidence.detail)||end.evidence.reason!=='compile_failed'||(end.evidence.errorKind==='result'&&!['COMPILATION_ERROR','COMPILATION_OOM_ERROR','COMPILER_INTERNAL_ERROR'].includes(end.evidence.detail))))fail();if(e.producerState!=='failed'||end.evidence.reason!==e.failureReason||end.evidence.produced!=='not-produced'||e.failurePhase!==phase||!Object.hasOwn(reasonPhases,e.failureReason)||i+2!==e.phases.length)fail();
   if(!reasonPhases[e.failureReason].includes(phase))fail('claim_mismatch');
  }else{
   if(end.outcome!=='success')fail();checkEvidence(phase,end.evidence);successful[phase]=end.evidence;if(phase==='capture')captures++;
  }
  if(phase!=='capture')index++;
 }
 // completed is terminal: postcheck and every capture fixed at invocation start must have succeeded.
 if(e.producerState==='completed'&&(!successful.postcheck||e.phases.at(-1)?.outcome!=='success'||captures!==e.plannedCaptures))fail('required_evidence_missing');
 if(e.producerState==='failed'&&(e.phases.at(-1)?.outcome!=='failure'||!offerPhases.includes(e.failurePhase)||(e.failurePhase==='capture'?captures+1>e.plannedCaptures:captures!==0)))fail();
 if(e.producerState==='unavailable'){
  if(!['execution_unsupported','evidence_unavailable'].includes(e.unavailableReason)||e.noRead!==true||index>3||captures!==0||e.phases.some(x=>x.outcome==='failure')||e.blockedBeforePhase!==offerPhases[index])fail();
 }
 if(successful.seal){
  const a=successful.generation.snapshots,b=successful.seal.files;
  if(!eq(a.map(x=>({id:x.id,size:x.size,sha256:x.sha256})),b.map(x=>({id:x.id,size:x.size,sha256:x.sha256})))||new Set(b.map(x=>x.id)).size!==b.length)fail('content_mismatch');
 }
 if(successful.binding&&!eq(successful.binding.snapshotIds,successful.seal.files.map(x=>x.id)))fail('binding_mismatch');
 if(successful.call&&(successful.call.configurationId!==successful.binding.configurationId||successful.call.parameterId!==successful.binding.parameterId))fail('binding_mismatch');
 return successful;
}
function inspectOwnedOffer(e,settings,read){
 const evidence=validateOwnedOffer(e);let fileReads=0;
 const result=(importStatus,reason)=>({producerState:e.producerState,importStatus,reason,producerReason:e.failureReason??e.unavailableReason??null,fileReads,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'bta-call-only',compilerWorkStatus:'unknown'});
 if(e.graphId!==settings.graphId||e.exportId!==settings.exportId)fail('claim_mismatch');
 if(!settings.trust)return result('unavailable','owned_offer_trust_disabled');
 const profile=settings.profiles[e.profileId];if(!profile)return result('unavailable','owned_offer_profile_unapproved');
 if(evidence.registration&&!eq(evidence.registration,profile.registration))fail('profile_mismatch');
 if(profile.strategy!=='in-process')return result('unavailable','owned_offer_execution_unsupported');
 if(e.producerState==='unavailable')return result('producer_unavailable',null);
 if(e.producerState==='failed'&&!reverified.includes(e.failureReason))return result('producer_failed',null);
 if(evidence.seal.files.some(f=>f.size>32*1024**2)||evidence.seal.files.reduce((n,f)=>n+2*f.size,0)>128*1024**2)fail('budget_exceeded');
 let matched=true;
 for(const f of evidence.seal.files)for(const p of [f.baselinePath,f.path]){
  const bytes=read(p);fileReads++;if(bytes.length!==f.size||sha(bytes)!==f.sha256)matched=false;
 }
 if(e.producerState==='completed'){if(!matched)fail('content_mismatch');return result('accepted',null);}
 // A recorded content failure is accepted only when the reader also observes the mismatch.
 const source=read(evidence.binding.sourcePath);fileReads++;if(sha(source)!==evidence.binding.sourceSha256)matched=false;
 if(matched)fail('claim_mismatch');
 return result('producer_failed',null);
}

// Classifies fresh Gradle execution evidence before consulting any retained/cached envelope.
export function classifyOfferExecution(w){
 keys(w,['executionId','actionCalls','didWork','skipped','noSource','failed','skipMessage']);
 if(!str(w.executionId)||![w.didWork,w.skipped,w.noSource,w.failed].every(x=>typeof x==='boolean')||![0,1].includes(w.actionCalls))fail('execution_invalid');
 const executed=w.actionCalls===1;
 if(w.failed||(executed?(w.skipped||w.noSource||!w.didWork||w.skipMessage!==null):(!w.skipped||w.didWork||!['FROM-CACHE','SKIPPED','UP-TO-DATE','NO-SOURCE'].includes(w.skipMessage)||w.noSource!==(w.skipMessage==='NO-SOURCE'))))fail('execution_invalid');
 return {executionId:w.executionId,btaTaskActionExecuted:executed,importStatus:executed?'inspect-current-envelope':'unavailable',reason:executed?null:'owned_offer_action_not_executed',executionEvidence:executed?'bta-task-action':'not-called',compilerWorkStatus:'unknown',naturalReady:false};
}

// The only adoption entry point requires caller-supplied execution evidence; its authenticity rests on the caller.
export function readOwnedOffer(e,settings,read){
 const classification=classifyOfferExecution(settings.executionWitness);
 if(!str(settings.executionId)||classification.executionId!==settings.executionId)fail('execution_invalid');
 if(!classification.btaTaskActionExecuted){
  validateOwnedOffer(e);
  return {producerState:e.producerState,importStatus:'unavailable',reason:classification.reason,producerReason:null,fileReads:0,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'not-called',compilerWorkStatus:'unknown'};
 }
 // An executed action must have rewritten the envelope; a retained earlier ID contradicts the claim.
 if(e?.executionId!==classification.executionId)fail('claim_mismatch');
 return inspectOwnedOffer(e,settings,read);
}
