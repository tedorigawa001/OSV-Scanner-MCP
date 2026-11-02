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
const reasons=['compile_failed','storage_failed','budget_exceeded','extra_evaluation','binding_mismatch','configuration_unregistered','configuration_reused','content_mismatch','stale','path_invalid'];
const integrity=['binding_mismatch','configuration_unregistered','configuration_reused','content_mismatch','stale','path_invalid'];
function checkEvidence(phase,v){
 if(phase==='registration'){keys(v,['producerSha256','runtimeSha256','profileSha256']);if(!Object.values(v).every(digest))fail();}
 if(phase==='generation'){
  keys(v,['librarySha256','generatorSha256','snapshots']);if(!digest(v.librarySha256)||!digest(v.generatorSha256))fail();
  list(v.snapshots,f=>{keys(f,['id','size','sha256','inputSha256']);return str(f.id)&&Number.isSafeInteger(f.size)&&f.size>0&&digest(f.sha256)&&digest(f.inputSha256);});
 }
 if(phase==='seal'){
  keys(v,['files']);list(v.files,f=>{keys(f,['id','path','baselinePath','size','sha256']);return str(f.id)&&pathOK(f.path)&&pathOK(f.baselinePath)&&Number.isSafeInteger(f.size)&&f.size>0&&digest(f.sha256);});
 }
 if(phase==='binding'){keys(v,['configurationId','parameterId','serviceId','projectId','snapshotIds','sourceSha256','argumentsSha256','outputPath']);if(![v.configurationId,v.parameterId,v.serviceId,v.projectId].every(str))fail();list(v.snapshotIds,str);if(!digest(v.sourceSha256)||!digest(v.argumentsSha256)||!pathOK(v.outputPath))fail();}
 if(['precheck','postcheck','capture'].includes(phase)){keys(v,['matched']);if(v.matched!==true)fail('content_mismatch');}
 if(phase==='call'){
  keys(v,['result','configurationId','parameterId','executionEvidence','compilerWorkStatus','outputs']);
  if(v.result!=='COMPILATION_SUCCESS'||!str(v.configurationId)||!str(v.parameterId)||v.executionEvidence!=='bta-call-only'||v.compilerWorkStatus!=='unknown')fail();files(v.outputs);
 }
}
export function validateOwnedOffer(e){
 const common=['schema','graphId','exportId','project','invocation','stage','slot','profileId','producerState','limitations','naturalContentBinding','phases'];
 const extra=e?.producerState==='failed'?['failureReason','failurePhase']:e?.producerState==='unavailable'?['unavailableReason','blockedBeforePhase','noRead']:[];
 if(JSON.stringify(e)?.length>1024**2)fail('budget_exceeded');keys(e,[...common,...extra]);
 if(e.schema!=='osv-mcp.gradle-owned-offer-v1'||!['completed','failed','unavailable'].includes(e.producerState)||!['graphId','exportId','project','invocation','stage','profileId'].every(k=>str(e[k]))||e.slot!=='snapshot'||e.naturalContentBinding!==false||!eq(e.limitations,offerLimitations))fail();
 list(e.phases,x=>obj(x),false);if(e.phases.length>32)fail();
 const successful={};let index=0;
 for(let i=0;i<e.phases.length;i+=2){
  const begin=e.phases[i],end=e.phases[i+1],phase=offerPhases[index];
  keys(begin,['phase','outcome']);if(begin.phase!==phase||begin.outcome!=='begin'||!end)fail();
  keys(end,['phase','outcome','evidence']);if(end.phase!==phase)fail();
  if(end.outcome==='failure'){
   keys(end.evidence,phase==='call'?['reason','produced','errorKind','detail']:['reason','produced']);if(phase==='call'&&(!['result','exception'].includes(end.evidence.errorKind)||!str(end.evidence.detail)||end.evidence.reason!=='compile_failed'||(end.evidence.errorKind==='result'&&!['COMPILATION_ERROR','COMPILATION_OOM_ERROR','COMPILER_INTERNAL_ERROR'].includes(end.evidence.detail))))fail();if(e.producerState!=='failed'||end.evidence.reason!==e.failureReason||end.evidence.produced!=='not-produced'||e.failurePhase!==phase||!reasons.includes(e.failureReason)||i+2!==e.phases.length)fail();
  }else{
   if(end.outcome!=='success')fail();checkEvidence(phase,end.evidence);successful[phase]=end.evidence;
  }
  if(phase!=='capture')index++;
 }
 if(e.producerState==='completed'&&(!successful.postcheck||e.phases.at(-1)?.outcome!=='success'))fail('required_evidence_missing');
 if(e.producerState==='failed'&&(e.phases.at(-1)?.outcome!=='failure'||!offerPhases.includes(e.failurePhase)))fail();
 if(e.producerState==='unavailable'){
  if(!['execution_unsupported','evidence_unavailable'].includes(e.unavailableReason)||e.noRead!==true||index>5||e.phases.some(x=>x.outcome==='failure')||e.blockedBeforePhase!==offerPhases[index])fail();
 }
 if(successful.seal){
  const a=successful.generation.snapshots,b=successful.seal.files;
  if(!eq(a.map(x=>({id:x.id,size:x.size,sha256:x.sha256})),b.map(x=>({id:x.id,size:x.size,sha256:x.sha256})))||new Set(b.map(x=>x.id)).size!==b.length)fail('content_mismatch');
 }
 if(successful.binding&&!eq(successful.binding.snapshotIds,successful.seal.files.map(x=>x.id)))fail('binding_mismatch');
 if(successful.call&&(successful.call.configurationId!==successful.binding.configurationId||successful.call.parameterId!==successful.binding.parameterId))fail('binding_mismatch');
 if(e.producerState==='failed'&&integrity.includes(e.failureReason))fail(e.failureReason);
 return successful;
}
export function readOwnedOffer(e,settings,read){
 const evidence=validateOwnedOffer(e);let fileReads=0;
 const result=(importStatus,reason)=>({producerState:e.producerState,importStatus,reason,fileReads,naturalReady:false,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',executionEvidence:'bta-call-only',compilerWorkStatus:'unknown'});
 if(e.graphId!==settings.graphId||e.exportId!==settings.exportId)fail('binding_mismatch');
 if(!settings.trust)return result('unavailable','owned_offer_trust_disabled');
 const profile=settings.profiles[e.profileId];if(!profile)return result('unavailable','owned_offer_profile_unapproved');
 if(evidence.registration&&!eq(evidence.registration,profile.registration))fail('profile_mismatch');
 if(e.producerState==='unavailable')return result('unavailable','owned_offer_'+e.unavailableReason);
 // Failed prefix is schema checked but never accepted as successful content or read back.
 if(e.producerState==='failed')return result('failed','owned_offer_'+e.failureReason);
 if(profile.strategy!=='in-process')return result('unavailable','owned_offer_execution_unsupported');
 if(evidence.seal.files.some(f=>f.size>32*1024**2)||evidence.seal.files.reduce((n,f)=>n+2*f.size,0)>128*1024**2)fail('budget_exceeded');
 for(const f of evidence.seal.files)for(const p of [f.baselinePath,f.path]){
  const bytes=read(p);fileReads++;if(bytes.length!==f.size||sha(bytes)!==f.sha256)fail('content_mismatch');
 }
 return result('accepted',null);
}
