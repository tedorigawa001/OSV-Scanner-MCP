import {ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
export function executionFixture(){
 const hash=ownedSha256('pin');
 const authorization={authorityId:'authority',jdkImageProfileDigest:hash,nodeImageProfileDigest:hash,platformProfileDigest:hash,executorProfileDigest:hash,loaderProfileDigest:hash};
 const binding={authorityId:'authority',sessionId:'session',nonce:'nonce',graphId:'graph',exportId:'export',executionId:'execution',coreGraphDigest:hash,project:'project',context:'runtime',invocation:'invocation',profileDigest:hash,recipeDigest:hash,rootRegistryDigest:hash};
 const state={producerState:'unavailable',completedThrough:'none',approvalStatus:'approved',profileDigest:hash,recipeDigest:hash,blockedStage:'prepare',unavailableReason:'image_unsupported'};
 const claim:any={...binding,witnessId:'witness',taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:0,captures:0,bundleDigest:hash,envelopeDigest:hash,state,stages:[],processes:[]};
 const scope={project:'project',context:'runtime',invocation:'invocation',taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:0,profileDigest:hash,recipeDigest:hash};
 const session={schema:'osv-mcp.gradle-owned-session-v1',authorityId:'authority',sessionId:'session',nonce:'nonce',graphId:'graph',exportId:'export',executionId:'execution',coreGraphDigest:hash,rootRegistryDigest:hash,isolationEvidenceRef:hash,status:'current',scopes:[scope],leases:[]};
 const witness={schema:'osv-mcp.gradle-owned-execution-witness-v1',witnessId:'witness',binding,task:{taskId:'task',actionId:'action',actionCalls:1,executed:true,didWork:true,skipped:false,noSource:false,failed:false,skipMessage:null},brokerInstanceId:'broker',plannedCaptures:0,captures:0,bundleDigest:hash,envelopeDigest:hash,state,stageExecutions:[]};
 const result:any={status:'verified',witness};
 const caller:any={backend:'caller-owned-receipt-store-v1',session,lookup:()=>result};
 return {authorization,claim,session,witness,result,caller};
}

import {ownedPolicyFixture} from './gradleOwnedPolicyFixture.js';
import {ownedFixture,rewriteOwned} from './gradleOwnedFixture.js';
import {parseOwnedSettings,createOwnedRegistry} from '../../utils/gradleOwnedPolicy.js';
import {ownedStages,stateSchema,type OwnedState} from '../../utils/gradleOwnedSchema.js';
export function ownedExecutionCase(state='completed',through='offer',phase?:string,reason?:string,lockHash?:string){
 const f=ownedPolicyFixture(),base=ownedFixture(state,through,phase,reason);if(lockHash)base.coreGraph.lockfiles[0].sha256=lockHash;const doc=rewriteOwned(base,()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedDigest(base.coreGraph);if('coreGraphDigest'in v)v.coreGraphDigest=ownedDigest(base.coreGraph);if(v.profileDigest)v.profileDigest=f.claim.profileDigest;if(v.recipeDigest)v.recipeDigest=f.claim.recipeDigest;});
 const objects=doc.ownedOfferObjects.map((c:any)=>({ref:c.objectDigest,value:JSON.parse(c.bytes)}));
 const e=objects.find((c:any)=>c.value.schema==='osv-mcp.gradle-owned-offer-v2').value,b=objects.find((c:any)=>c.value.schema==='osv-mcp.gradle-owned-manifest-bundle-v1').value;
 const x=executionFixture();const session:any=x.session,w:any=x.witness;
 Object.assign(session,{graphId:e.graphId,exportId:e.exportId,executionId:e.executionId,coreGraphDigest:e.coreGraphDigest,authorityId:f.profile.authorityId});
 Object.assign(session.scopes[0],{project:e.project,context:e.context,invocation:e.invocation,profileDigest:e.profileDigest,recipeDigest:e.recipeDigest,plannedCaptures:e.plannedCaptures});
 w.binding={...Object.fromEntries(['authorityId','sessionId','nonce','graphId','exportId','executionId','coreGraphDigest','rootRegistryDigest'].map(k=>[k,session[k]])),project:e.project,context:e.context,invocation:e.invocation,profileDigest:e.profileDigest,recipeDigest:e.recipeDigest};
 const stateValue=stateSchema.parse(Object.fromEntries(Object.keys(stateSchema.shape).filter(k=>b[k]!==undefined).map(k=>[k,b[k]])));
 Object.assign(w,{state:stateValue,bundleDigest:doc.ownedOfferBundles[0].bundleRef.objectDigest,envelopeDigest:doc.ownedOfferBundles[0].envelopeRef.objectDigest,plannedCaptures:e.plannedCaptures,captures:e.phases.filter((p:any)=>p.phase==='capture'&&p.outcome==='success').length});
 const n=through==='none'?-1:ownedStages.indexOf(through as any);
 const stages:any[]=ownedStages.slice(0,n+1).map(stage=>({stage,outcome:'success'}));
 if(state==='failed')stages.push({stage:b.failureStage,outcome:'failed'});
 if(state==='unavailable'&&e.phases.length)stages.push({stage:b.blockedStage,outcome:'unavailable'});
 const knownRoles:Record<string,string>={'build-receipt':'build','runtime-selection':'runtime-selection','generation-receipt':'snapshot-generation'};
 const processRecords:any[]=[];
 for(const o of objects){const stage=knownRoles[o.value.role];if(stage)for(const r of o.value.evidence??[])if(r.kind==='process')processRecords.push({stage,record:r});}
 for(const p of e.phases)if(p.evidenceRef){const o=objects.find((o:any)=>o.ref===p.evidenceRef.objectDigest);for(const r of o.value.evidence)if(r.kind==='process')processRecords.push({stage:'offer',record:r});}
 const leaseFields:Record<string,string>={jdk:'jdkImageProfileDigest',node:'nodeImageProfileDigest',platform:'platformProfileDigest',executor:'executorProfileDigest',loader:'loaderProfileDigest'};
 session.leases=Object.entries(leaseFields).map(([kind,key])=>({id:kind,kind,profileDigest:f.profile[key],holderId:kind==='jdk'||kind==='loader'?'instance':'broker',status:'active'}));
 w.stageExecutions=stages.map((s:any,i:number)=>({...s,begin:i*10+1,end:i*10+9,processes:processRecords.filter(p=>p.stage===s.stage).map((p:any,j:number)=>({record:p.record,begin:i*10+2+j*2,end:i*10+3+j*2,leases:{jdk:'jdk',node:'node',platform:'platform',executor:'executor',...(['jvm-start','snapshot-generator','bta-call'].includes(p.record.operation)?{loader:'loader'}:{})}}))}));
 const policy={settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)};
 const claim:any={...e,bundleDigest:w.bundleDigest,envelopeDigest:w.envelopeDigest,plannedCaptures:w.plannedCaptures,captures:w.captures,state:stateValue,stages,...(state==='unavailable'&&!e.phases.length?{optionalBlockedStage:b.blockedStage}:{}),processes:processRecords};
 return {...x,authorization:policy.registry.authorization(f.claim,policy.settings)!,claim,doc,policy,session,witness:w};
}
