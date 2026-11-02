import {canonicalOwnedJson,ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {ownedStages,successFields,stageRoles,phases,ownedLimitations} from '../../utils/gradleOwnedSchema.js';
import {graphFixture} from './gradleGraphFixture.js';
export function ownedFixture(state='completed',through='offer',phase?:string,reason?:string):any {
 const core=graphFixture(),n=through==='none'?-1:ownedStages.indexOf(through as any),next=ownedStages[n+1];
 const bind={graphId:'graph',exportId:'export',project:'main::',context:'runtime',executionId:'execution',invocation:'invocation',profileId:'profile',recipeId:'recipe',coreGraphDigest:ownedDigest(core)};
 const info:any={producerState:state,completedThrough:through,approvalStatus:'approved',profileDigest:ownedSha256('profile'),recipeDigest:ownedSha256('recipe')};
 if(state==='failed')Object.assign(info,{failureStage:next,failurePhase:phase??(['seal','compiler','verify','generate','precheck'][n+1]),failureReason:reason??(['input_changed','build_failed','input_changed','input_changed','snapshot_stale'][n+1])});
 if(state==='unavailable')Object.assign(info,{blockedStage:next,unavailableReason:['image_unsupported','build_recipe_unsupported','loader_unsupported','generation_unsupported','execution_unsupported'][n+1]});
 const wrapper:any={schema:'osv-mcp.gradle-graph',schemaVersion:4,graphId:bind.graphId,exportId:bind.exportId,coreGraph:core,ownedOfferBundles:[],ownedOfferObjects:[]};
 const file={rootId:'source',path:'日本語 空白/%/Driver.java',size:6,sha256:ownedSha256('source')};
 const snapshot={rootId:'staging',path:'snapshot-0',size:8,sha256:ownedSha256('snapshot')};
 const add=(role:string,value:any)=>{const bytes=canonicalOwnedJson(value),ref={role,objectDigest:ownedSha256(bytes),byteLength:Buffer.byteLength(bytes)};wrapper.ownedOfferObjects.push({role,objectDigest:ref.objectDigest,bytes});return ref;};
 const object=(role:string,evidence:any[]=[],refs:any[]=[],envelopeRef?:any)=>add(role,{schema:'osv-mcp.gradle-owned-object-v1',role,binding:bind,refs,evidence,...(envelopeRef?{envelopeRef}:{})});
 const inventory=(inputRole:string,files:any[])=>({kind:'inventory',inputRole,files,directories:[],complete:true});
 const process=(operation:string,result='success')=>({kind:'process',operation,instanceId:'instance',result,started:true,finished:true,...(operation==='bta-call'?{configurationId:'c',parameterId:'p'}:{})});
 const b:any={schema:'osv-mcp.gradle-owned-manifest-bundle-v1',completenessDomain:'owned-recipe-inputs',...bind,...info,limitations:[...ownedLimitations]};
 for(let i=0;i<=Math.min(n,3);i++)b[successFields[i]!]=object(stageRoles[i]!,i===0?[inventory('driver-sources',[file])]:[process(['javac','jvm-start','snapshot-generator'][i-1]!)],i?[b[successFields[i-1]!]]:[]);
 const events:any[]=[];
 if(n===4||info.failureStage==='offer'||info.blockedStage==='offer'){
  for(const p of phases){
   if(p==='capture'&&state!=='completed'&&info.failurePhase!=='capture')break;
   let evidence:any[]=[];const refs=p==='generation-binding'?[b.generationReceiptRef]:[];
   if(p==='seal')evidence=[inventory('snapshot-generation',[snapshot])];
   if(p==='binding')evidence=[{kind:'binding',serviceId:'s',projectId:bind.project,configurationId:'c',parameterId:'p',source:file,arguments:[],snapshotIds:[snapshot.path],singleUse:true}];
   if(['precheck','postcheck','capture'].includes(p))evidence=[{kind:'observation',phase:p,matched:true,files:[snapshot]}];
   if(p==='call')evidence=[process('bta-call','COMPILATION_SUCCESS')];
   const failed=state==='failed'&&info.failurePhase===p;
   if(failed)evidence=[{kind:'failure',stage:'offer',phase:p,reason:info.failureReason,notProduced:[]},...(p==='call'?[process('bta-call','COMPILATION_ERROR')]:[])];
   if(state==='unavailable')break;
   const evidenceRef=object('evidence',evidence,refs);events.push({phase:p,outcome:'begin'},{phase:p,outcome:failed?'failure':'success',evidenceRef});if(failed)break;
  }
 }
 const envelopeRef=add('offer-envelope',{schema:'osv-mcp.gradle-owned-offer-v2',...bind,...info,witnessId:'witness',stage:'consumer',slot:'snapshot',plannedCaptures:n===4||(info.failureStage==='offer'&&info.failurePhase==='capture')?1:0,naturalContentBinding:false,consumptionStatus:'offered-inputs-only',compilerWorkStatus:'unknown',limitations:[...ownedLimitations],...(info.blockedStage==='offer'?{blockedBeforePhase:'registration'}:{}),phases:events});
 if(n===4)b.offerReceiptRef=object('offer-receipt',[],[b.generationReceiptRef],envelopeRef);
 if(state==='failed')b.failureReceiptRef=object('failure-receipt',[{kind:'failure',stage:info.failureStage,phase:info.failurePhase,reason:info.failureReason,notProduced:[]}],successFields.slice(0,n+1).map(k=>b[k]),envelopeRef);
 if(state==='unavailable')b.unavailableEvidenceRef=object('unavailable-evidence',[{kind:'unavailable',stage:info.blockedStage,reason:info.unavailableReason,...(info.blockedStage==='offer'?{phase:'registration'}:{}),notAttemptedRoles:['snapshot-generation']}],successFields.slice(0,n+1).map(k=>b[k]),envelopeRef);
 const inventoryRefs=wrapper.ownedOfferObjects.map((c:any)=>({role:c.role,objectDigest:c.objectDigest,byteLength:Buffer.byteLength(c.bytes)}));
 b.evidenceIndexRef=object('evidence-index',[],inventoryRefs);
 const bundleRef=add('manifest-bundle',b);wrapper.ownedOfferBundles.push({project:bind.project,context:bind.context,invocation:bind.invocation,bundleRef,envelopeRef});return wrapper;
}
export function rewriteOwned(wrapper:any,select:(v:any)=>boolean,change:(v:any)=>void):any {
 const updated=new Map<string,any>();
 function replace(v:any):any {if(Array.isArray(v))return v.map(replace);if(v&&typeof v==='object'){if('objectDigest'in v&&'byteLength'in v)return updated.get(v.objectDigest)??v;return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,replace(x)]));}return v;}
 wrapper.ownedOfferObjects=wrapper.ownedOfferObjects.map((c:any)=>{let v=JSON.parse(c.bytes);if(select(v))change(v);v=replace(v);const bytes=canonicalOwnedJson(v),objectDigest=ownedSha256(bytes);updated.set(c.objectDigest,{role:c.role,objectDigest,byteLength:Buffer.byteLength(bytes)});return {role:c.role,objectDigest,bytes};});
 wrapper.ownedOfferBundles=replace(wrapper.ownedOfferBundles);return wrapper;
}
