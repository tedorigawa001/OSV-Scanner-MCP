/** Stored evidence checker. Never interprets a fixture result as provider/Session admission. */
import {createHash,createPublicKey,verify} from 'node:crypto';
import {validateLg0Context} from './gradleOwnedCwcLg0Context.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex'),need=(ok,r)=>{if(!ok)throw Error('lg0_'+r);};
const n=x=>Number.isSafeInteger(x)&&x>=0;
const same=(a,b)=>canonical(a)===canonical(b);
export const LG0_SCENARIOS=['normal','normal-then-revoke','timeout-pending','reentry-caught','failed-mutation','capture-pool-overflow','retry','uncaptured-finish','unsealed-finish'];
export const LG0_SCOPE={standalone:true,fixedClock:true,ownedBudget:true,logicalLayoutOnly:true,existingProvider:false,actualReadScope:false,actualSession:false,actualSourceIO:false,actualSignatureOnReply:false,actualOutcomeUseAck:false,performanceMeasured:false,primaryAndBridgeExecuted:false,productionAdopted:false};
const keys=(o,expected,reason)=>need(o&&typeof o==='object'&&!Array.isArray(o)&&same(Object.keys(o).sort(),expected.split(',').sort()),reason);
/** Independent reproduction of the existing CWC-C logical layout, without invoking new LG code. */
export function lg0MemoryBound(c){
 const entry={sha256:'f'.repeat(64),byteLength:41460},range={ordinal:3,kind:'payload',index:8,offset:41460,length:4096,entry};
 const raw={schema:'osv-mcp.cgp.source-command.v3',api:'aux.ReadSourceRanges',purpose:'read',operationId:'f'.repeat(64),peer:c.peer,lineage:c.lineage,binding:c.binding,payload:{snapshot:c.snapshot,checkpoint:c.checkpoint,pin:c.pin,...(c.origin?{origin:c.origin}:{}),transferId:'t'.repeat(128),plan:{specDigest:'f'.repeat(64),seed:'s'.repeat(128),batchOrdinal:18,batchCount:19,planDigest:'f'.repeat(64),inventoryDigest:c.inventoryDigest},ranges:[range,range,range,range],byteBudget:4096},requestDigest:'f'.repeat(64)};
 const commandBytes=Buffer.byteLength(canonical(raw)),coreBytes=Buffer.byteLength(canonical({domain:'cpr.plan-core.v3',specDigest:'f'.repeat(64),catalog:c.catalog,peer:c.peer,provider:c.provider,...(c.origin?{origin:c.origin}:{}),lineage:c.lineage,binding:c.binding,snapshot:c.snapshot,checkpoint:c.checkpoint,pin:c.pin,metadataDigest:c.metadataDigest,inventoryDigest:c.inventoryDigest,seed:'s'.repeat(128),transferId:'t'.repeat(128),groups:Array.from({length:19},()=>[range,range,range,range])}));
 const contexts=3*Buffer.byteLength(canonical(c)),common=393216+3*coreBytes+contexts+32768+16384;
 const client=common+3*19*commandBytes+8192,provider=common+2*19*commandBytes+65536+2*41460+4096+8192;
 return {commandBytes,coreBytes,client,provider,reserved:Math.max(client,provider),fragments:4096,work:156978};
}
function budget(b){
 keys(b,'work,initialization,wire,attempts,heldBytes,peakBytes,occupiedSlots,memoryLimit,workLimit','budget_schema');
 need(Object.values(b).every(n)&&b.work+b.initialization<=156978&&b.wire<=163840&&b.heldBytes<=b.peakBytes&&b.peakBytes<=1048576&&b.memoryLimit===1048576&&b.workLimit===156978,'budget');
}
function approval(a,sources,policy){
 keys(a,'envelope,registry,pin','approval_schema');const {envelope:e,registry:r}=a;
 need(hash(r)===a.pin&&hash(e.manifest)===r.manifestDigest&&e.manifest.policyDigest===hash(policy)&&e.manifest.node===process.version,'approval_binding');
 const key=createPublicKey({key:Buffer.from(r.operatorSpki,'base64'),format:'der',type:'spki'});
 need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(e.manifest)),key,Buffer.from(e.signature,'base64')),'approval_signature');
 need(Object.keys(e.manifest.sources).length>0,'approval_sources');for(const [p,h]of Object.entries(e.manifest.sources))need(sources[p]===h,'approval_source_'+p);
}
function stats(s,row,expectedMetrics,expectedSpent,peak,held,late=0){
 keys(s,'mode,state,reason,claimed,localGeneration,scopeGeneration,lookup,readers,pendingDispatch,drained,actual,metrics,normalizer,budget','stats_schema');
 need(s.mode===row.mode&&s.claimed===(row.scenario!=='uncaptured-finish')&&s.lookup===false&&s.readers===0,'terminal');budget(s.budget);
 need(same(s.metrics,{...expectedMetrics,lateRejected:late}),'metrics');
 need(!s.actual.open&&!s.actual.lookup&&!s.actual.channelOpen&&s.actual.generation===(row.error?2:1),'actual_terminal');
 need(s.budget.initialization===expectedSpent.initialization&&s.budget.work===expectedSpent.work&&s.budget.wire===expectedSpent.wire&&s.budget.attempts===expectedSpent.attempts&&s.budget.peakBytes===peak&&s.budget.heldBytes===held,'spent');
 if(['capture-pool-overflow','uncaptured-finish'].includes(row.scenario))need(s.normalizer===null,'failed_normalizer');else{
  const p=s.normalizer,count=row.role==='reader'?18:17,k=Buffer.byteLength(canonical(row.context.lineage));
  keys(p,'work,poolBytes,temporaryBytes,rows','normalizer_schema');
  need(p&&p.rows===count&&p.poolBytes===k&&p.temporaryBytes===k*(count+1),'normalizer_rows');
  need(same(p.work,{nodeVisits:8+11*count,freezeNodes:count+1,tupleWrites:4*count,canonicalCalls:count+1,fixedOperations:512})&&Object.values(p.work).reduce((a,b)=>a+b,0)<=3137,'normalizer_work');
 }
}
export function validateLg0Evidence(e,sources,policy){
 keys(e,'schema,proofs,layouts,scope','evidence_schema');need(e.schema==='cwc-lg0.evidence.v2'&&same(e.scope,LG0_SCOPE),'scope');
 need(Array.isArray(e.proofs)&&e.proofs.length===4*LG0_SCENARIOS.length&&Array.isArray(e.layouts)&&e.layouts.length===4,'matrix');
 const ids=new Set(),peakByRole={},errors={normal:null,'normal-then-revoke':'codec_profile_unsupported','timeout-pending':'request_expired','reentry-caught':'reentrant','failed-mutation':'permission_denied','capture-pool-overflow':'codec_profile_unsupported',retry:null,'uncaptured-finish':'codec_fact_binding_mismatch','unsealed-finish':'codec_fact_binding_mismatch'};
 for(const row of e.proofs){
  keys(row,'id,mode,role,scenario,error,context,memory,normalRelease,prior,owner,beforeClose,afterClose,afterDrain,approval','proof_schema');
  need(['full-input','owned-input'].includes(row.mode)&&['reader','authority-broker'].includes(row.role)&&LG0_SCENARIOS.includes(row.scenario),'case');
  need(row.id===`${row.mode}/${row.role}/${row.scenario}`&&!ids.has(row.id)&&row.error===errors[row.scenario],'case_id');ids.add(row.id);
  validateLg0Context(row.context,row.role);approval(row.approval,sources,policy);const mem=lg0MemoryBound(row.context);need(same(row.memory,mem),'memory_recipe');
  const uncaptured=row.scenario==='uncaptured-finish',unsealed=row.scenario==='unsealed-finish';
  const peak=mem.reserved-32768+131072+98304+8192+(uncaptured?0:4096);need(peak<=1048576,'memory_cap');peakByRole[row.role]=Math.max(peakByRole[row.role]??0,peak);
  const success=row.error===null,pool=row.scenario==='capture-pool-overflow',matched=['normal','normal-then-revoke','retry'].includes(row.scenario),logical=matched||row.scenario==='reentry-caught'?1:0;
  const metrics={captures:pool||uncaptured?0:1,seals:pool||uncaptured||unsealed?0:1,logical,live:{normal:19,'normal-then-revoke':14,'timeout-pending':9,'reentry-caught':10,'failed-mutation':9,'capture-pool-overflow':3,retry:19,'uncaptured-finish':0,'unsealed-finish':5}[row.scenario],normalizations:pool||uncaptured?0:1,fullPermissionCopies:matched&&row.mode==='full-input'?1:0,matches:matched?1:0,publications:success?1:0,use:success?1:0,ack:success?1:0,lgReleases:uncaptured?0:1,reads:0,signs:success?1:0,lateRejected:0,finalFull:success?1:0,privateReferences:0};
  const retry=row.scenario==='retry',pending=row.scenario==='timeout-pending';
  const spent={initialization:retry?36864:row.scenario==='failed-mutation'?24576:uncaptured?16384:20480,work:(retry?114688:57344)+(retry?2:logical),wire:retry?114688:57344,attempts:retry?2:1};
  for(const [part,held,late]of [['beforeClose',pending?peak-4096:131072,0],['afterClose',pending?peak-4096:0,0],['afterDrain',0,pending?1:0]]){
   stats(row[part],row,metrics,spent,peak,held,late);const s=row[part];need(s.pendingDispatch===(pending&&part!=='afterDrain')&&s.drained===(!pending||part==='afterDrain'),'drain');
   need(s.state===(success?'released':'invalid')&&s.reason===(success?'normal-scope-end':errors[row.scenario]),'reason');
  }
  if(matched){const a=row.normalRelease?.before,b=row.normalRelease?.after;need(a&&b&&a.state==='ready'&&b.state==='released'&&a.actual.open&&same(a.actual,b.actual)&&a.budget.heldBytes-b.budget.heldBytes===4096&&b.metrics.lgReleases===1&&b.lookup===false&&b.localGeneration===a.localGeneration+1,'normal_release');}
  else need(row.normalRelease===null,'unexpected_release');
  if(retry){const prior=row.prior;need(prior&&prior.metrics.publications===1&&prior.budget.initialization===20480&&prior.budget.work===57345&&prior.budget.wire===57344&&prior.budget.attempts===1&&prior.budget.heldBytes===131072,'retry_retention');}
  else need(row.prior===null,'unexpected_prior');
  need(row.owner.updating===(row.scenario==='failed-mutation')&&row.owner.revision===(row.scenario==='failed-mutation'?1:0),'owner');
 }
 const layoutIds=new Set();for(const r of e.layouts){
  keys(r,'mode,role,context,status,error,budget','layout_schema');const id=r.mode+'/'+r.role;need(['full-input','owned-input'].includes(r.mode)&&['reader','authority-broker'].includes(r.role)&&!layoutIds.has(id),'layout_id');layoutIds.add(id);
  validateLg0Context(r.context,r.role,true);
  const mem=lg0MemoryBound(r.context),required=mem.reserved-32768+131072+98304+8192+4096;
  need(required>1048576&&r.status==='unsupported'&&r.error==='codec_budget_exceeded','maximum_rejection');budget(r.budget);
  need(r.budget.heldBytes===0&&r.budget.work===0&&r.budget.wire===0&&r.budget.attempts===0&&r.budget.initialization===4096,'maximum_no_capture');
 }
 return {proofs:ids.size,completed:e.proofs.filter(r=>r.error===null).length,refused:e.proofs.filter(r=>r.error!==null).length,
  schemaMaximumRejected:layoutIds.size,peakByRole,normalizationWorkPrepaid:4096,arenaBytes:4096,
  maximumLayoutAdoptionEstablished:false,lg0ExitEstablished:false,nextStageAdmitted:false,productionAdopted:false};
}
