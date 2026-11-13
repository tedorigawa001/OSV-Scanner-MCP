/** Independent record checks. These checks do not approve the diagnostic runtime. */
import {createHash} from 'node:crypto';
import {co0Canonical as canonical} from './gradleOwnedCwcCo0Validation.mjs';
const need=(v,r)=>{if(!v)throw Error('r1o_record_'+r);};
export const r1oHash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const keys=(x,n)=>need(x&&Object.getPrototypeOf(x)===Object.prototype&&canonical(Object.keys(x).sort())===canonical(n.split(' ').sort()),'shape');
const same=(a,b)=>need(canonical(a)===canonical(b),'equality');
const digest=x=>need(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'digest');
const expectedScope={diagnosticOnly:true,closedLocalProducer:true,realPrivateBuffers:true,realRetainedBorrow:true,fixedClock:true,sameProcess:true,oneBorrowPerCall:true,ownedBudgetFactoryOnly:true,fixedBudgetOperations:true,synchronousCallbacksOnly:true,ordinaryPromiseRejectionDrain:true,originalFullSchemaValidator:true,unboundedOracleWorkspace:true,nativeHash:true,diagnosticCapacityOnly:true,actualAuthenticatedCall:false,actualReadScope:false,freshSourceIO:false,independentApproval:false,bridgeChargeProved:false,codecOverlayProved:false,nativeHashBoundProved:false,completeWorkCoverage:false,actualParentLedgerVector:false,handleRoleLayoutProved:false,wholeBudgetCoexistenceProved:false,r1Exit:false,productionAdopted:false};
const statKeys='actor phase alive released reason revision epoch custodian constructs bufferAllocations allocatedBytes freshSourceReads validations schemaChecks inventoryChecks binds publications writes zeroWrites deniedWrites borrows borrowReferences borrowUsesPinnedStore frames pendingCallbacks privateBuffers pinned exclusive sourceBuffers destinationBuffers zeroedBytes zeroVerified reservations releases handleCapacity scopeAllocations sameSourceScope sameDestinationScope sameStore sameLease sourceRemoved lateSourceRetired contextDigest coreDigest budget trace scope';
const bools='alive released borrowUsesPinnedStore pinned exclusive zeroVerified sameSourceScope sameDestinationScope sameStore sameLease sourceRemoved lateSourceRetired'.split(' ');
const numbers='revision epoch constructs bufferAllocations allocatedBytes freshSourceReads validations schemaChecks inventoryChecks binds publications writes zeroWrites deniedWrites borrows borrowReferences frames pendingCallbacks privateBuffers sourceBuffers destinationBuffers zeroedBytes reservations releases handleCapacity scopeAllocations'.split(' ');
const budgetKeys='work initialization wire attempts heldBytes peakBytes occupiedSlots memoryLimit workLimit';
const prefix=['call','register:source','register:destination','diagnostic-reserve','enter:producer','exit:producer','hydrate-source'];
const full=['drain-existing-borrows','acquire-exclusive-handoff','enter:complete-validation','exit:complete-validation','final-complete-validation'];
const successes=[...prefix,'borrow-open','pin-and-stop-source','write:touch','borrow-close',...full,'final-fence','bind-destination','publish-window','retire-old-source'];
const faults=['update','zero','restore-pair','close','expire','reentry','throwing-message'];
const reason=f=>['update','zero','restore-pair'].includes(f)?'mutation_blocked':f==='throwing-message'?'operation_failed':f==='expire'?'expired':f==='close'?'closed':'reentry';
function stats(s,actor){
 keys(s,statKeys);same(s.scope,expectedScope);need(s.actor===actor,'actor');for(const k of bools)need(typeof s[k]==='boolean','boolean');for(const k of numbers)need(Number.isSafeInteger(s[k])&&s[k]>=0,'counter');
 need(s.constructs===1&&s.bufferAllocations===2&&s.allocatedBytes>0&&s.allocatedBytes<=73728&&s.freshSourceReads===0&&s.reservations===1&&s.handleCapacity===8&&s.scopeAllocations===2&&s.sameSourceScope,'construction');
 keys(s.budget,budgetKeys);for(const n of Object.values(s.budget))need(Number.isSafeInteger(n)&&n>=0,'budget');
 same(s.budget,{work:4096,initialization:4096,wire:0,attempts:0,heldBytes:s.released?0:196608,peakBytes:196608,occupiedSlots:0,memoryLimit:1048576,workLimit:156978});
 need(Array.isArray(s.trace)&&s.trace.length<4096,'trace');let frames=0,borrows=0,revision=0,epoch=1,pending=0;
 for(const [i,e]of s.trace.entries()){
  keys(e,'seq kind borrows frames revision epoch');need(e.seq===i&&typeof e.kind==='string','sequence');
  if(e.kind.startsWith('enter:'))frames++;if(e.kind==='borrow-open')borrows++;if(e.kind==='borrow-close')borrows--;
  if(e.kind==='pin-and-stop-source'||e.kind.startsWith('fatal:'))epoch++;if(e.kind.startsWith('write:'))revision++;
  if(e.kind==='callback-pending')pending++;if(e.kind==='callback-settled')pending--;need(pending>=0&&pending<=1,'pending');
  same({frames:e.frames,borrows:e.borrows,revision:e.revision,epoch:e.epoch},{frames,borrows,revision,epoch});
  need(frames>=0&&frames<=1&&borrows>=0&&borrows<=1,'frame');if(e.kind==='exit:producer'||e.kind==='exit:complete-validation')frames--;
  if(e.kind==='enter:complete-validation')need(borrows===0,'borrow_drain');
 }
 need(frames===s.frames&&borrows===s.borrows&&revision===s.revision&&epoch===s.epoch&&pending===s.pendingCallbacks,'trace_end');
 for(const k of ['contextDigest','coreDigest'])if(s[k]!==null)digest(s[k]);
}
function drained(s){need(!s.alive&&s.released&&s.phase==='drained'&&s.custodian==='none'&&s.releases===1&&s.zeroVerified&&s.zeroedBytes===s.allocatedBytes,'drain');
 need(s.privateBuffers+s.sourceBuffers+s.destinationBuffers+s.borrowReferences+s.borrows+s.frames+s.pendingCallbacks===0&&!s.pinned&&!s.exclusive,'retained_reference');}
export function validateR1oEvidence(e){
 keys(e,'schema successes refusals');need(e.schema==='cwc-r1o.evidence.v1'&&Array.isArray(e.successes)&&Array.isArray(e.refusals),'schema');
 const matrix=['reader','authority-broker'].flatMap(role=>['normal','registered-maximum','schema-upper'].flatMap(boundary=>['small','stress'].flatMap(workload=>['provider','client-initial','client-seal'].map(actor=>({role,boundary,workload,actor})))));
 need(e.successes.length===matrix.length&&e.refusals.length===42,'case_count');
 for(const [i,r]of e.successes.entries()){
  keys(r,'role boundary workload actor sourceAlias destinationAlias before after waiting published drained secondClose');same({role:r.role,boundary:r.boundary,workload:r.workload,actor:r.actor},matrix[i]);
  need(r.sourceAlias===true&&r.destinationAlias===true,'alias');keys(r.before,'context core');keys(r.after,'context core');same(r.before,r.after);digest(r.before.context);digest(r.before.core);
  for(const s of [r.waiting,r.published,r.drained,r.secondClose])stats(s,r.actor);
  const w=r.waiting,p=r.published,d=r.drained;
  need(w.alive&&!w.released&&w.phase==='quiescing'&&w.custodian==='pin'&&w.borrows===1&&w.borrowReferences===2&&w.borrowUsesPinnedStore&&w.pinned&&!w.exclusive&&w.privateBuffers===2&&w.sourceBuffers===2&&w.destinationBuffers===0&&w.validations+w.binds+w.publications+w.zeroedBytes+w.writes===0,'waiting');
  same(w.trace.map(x=>x.kind),[...prefix,'borrow-open','pin-and-stop-source']);
  need(p.alive&&!p.released&&p.phase==='published'&&p.custodian==='destination'&&p.validations===1&&p.schemaChecks===2&&p.inventoryChecks===1&&p.binds===1&&p.publications===1&&p.writes===1&&p.zeroWrites+p.deniedWrites+p.zeroedBytes+p.borrows+p.frames===0,'published');
  need(p.privateBuffers===2&&p.sourceBuffers===0&&p.destinationBuffers===2&&!p.pinned&&!p.exclusive&&p.sameStore&&p.sameLease&&p.sameDestinationScope&&p.sourceRemoved&&p.lateSourceRetired,'custody');
  same({context:p.contextDigest,core:p.coreDigest},r.after);same(p.trace.map(x=>x.kind),successes);
  drained(d);same(d.trace.map(x=>x.kind),[...successes,'fatal:closed','drained']);same({...d,alive:p.alive,released:p.released,phase:p.phase,reason:p.reason,epoch:p.epoch,custodian:p.custodian,privateBuffers:p.privateBuffers,destinationBuffers:p.destinationBuffers,zeroedBytes:p.zeroedBytes,zeroVerified:p.zeroVerified,releases:p.releases,budget:p.budget,trace:p.trace},p);same(d,r.secondClose);
 }
 const expected=['provider','client-initial','client-seal'].flatMap(actor=>['after-validation','before-bind'].flatMap(site=>faults.map(fault=>({actor,site,fault}))));
 for(const [i,r]of e.refusals.entries()){
  keys(r,'actor site fault attempted innerCaught diagnosticCalls refused inside after');same({actor:r.actor,site:r.site,fault:r.fault},expected[i]);need(r.attempted===true&&r.refused===true&&r.diagnosticCalls===0,'fault');
  const count=r.fault==='restore-pair'?2:['update','zero','reentry'].includes(r.fault)?1:0;need(r.innerCaught===count,'caught');
  const s=r.after;stats(s,r.actor);drained(s);need(s.validations===1&&s.schemaChecks===2&&s.inventoryChecks===1&&s.binds+s.publications+s.writes+s.zeroWrites===0&&s.deniedWrites===(['update','zero','restore-pair'].includes(r.fault)?count:0)&&s.reason===reason(r.fault),'refusal');
  same(s.trace.map(x=>x.kind),[...prefix,'pin-and-stop-source',...full,'fatal:'+reason(r.fault),'drained']);
  if(r.fault==='throwing-message')need(r.inside===null,'exception');else{stats(r.inside,r.actor);need(r.inside.privateBuffers===2&&r.inside.sourceBuffers===2&&r.inside.destinationBuffers===0&&r.inside.pinned&&r.inside.exclusive&&!r.inside.released&&r.inside.zeroedBytes+r.inside.zeroWrites+r.inside.binds+r.inside.publications===0,'callback_lifetime');}
 }
 return {successes:36,refusals:42,scope:'ownership-only',actualAuthenticatedCall:false,allParentReservationProved:false,r1Exit:false,productionAdopted:false};
}
export function compareR1oReplay(saved,fresh){validateR1oEvidence(saved);validateR1oEvidence(fresh);same(saved,fresh);}
export function validateR1oReview(e){
 keys(e,'schema constructorBudgets operationBudgets asyncCallbacks');need(e.schema==='cwc-r1o.review.v1','review_schema');
 need(Array.isArray(e.constructorBudgets)&&e.constructorBudgets.length===3&&Array.isArray(e.operationBudgets)&&e.operationBudgets.length===16&&Array.isArray(e.asyncCallbacks)&&e.asyncCallbacks.length===12,'review_count');
 for(const [i,r]of e.constructorBudgets.entries()){
  keys(r,'kind operationCalls externalReads refused registered');need(r.kind===['derived','fake-reservation','external-balance'][i]&&r.refused===true&&r.registered===false&&r.operationCalls===0&&r.externalReads===0,'constructor_budget');
 }
 const operations=['ready','before-bind'].flatMap(stage=>['value','getter'].flatMap(style=>['check','reserve','release','stats'].map(key=>({stage,style,key}))));
 for(const [i,r]of e.operationBudgets.entries()){
  keys(r,'stage style key operationCalls refused after');same({stage:r.stage,style:r.style,key:r.key},operations[i]);need(r.refused===true&&r.operationCalls===0,'operation_budget');const s=r.after;stats(s,'provider');drained(s);
  need(s.binds+s.publications+s.writes+s.zeroWrites+s.deniedWrites===0&&s.reason==='operation_failed'&&s.validations===(r.stage==='ready'?0:1)&&s.schemaChecks===2*s.validations&&s.inventoryChecks===s.validations,'budget_result');
  same(s.trace.map(x=>x.kind),[...prefix,...(r.stage==='ready'?[]:['pin-and-stop-source',...full]),'fatal:operation_failed','drained']);
 }
 const callbacks=['provider','client-initial','client-seal'].flatMap(actor=>['after-validation','before-bind'].flatMap(site=>['fulfilled','rejected'].map(outcome=>({actor,site,outcome}))));
 for(const [i,r]of e.asyncCallbacks.entries()){
  keys(r,'actor site outcome refused completedAtRefusal completed caught waiting closed after lateRejected late');same({actor:r.actor,site:r.site,outcome:r.outcome},callbacks[i]);need(r.refused===true&&r.completedAtRefusal===false&&r.completed===true&&r.caught===1&&r.lateRejected===true,'callback_result');
  for(const s of [r.waiting,r.closed,r.after,r.late]){stats(s,r.actor);need(s.reason==='async_callback_unsupported'&&!s.alive&&s.binds+s.publications+s.writes+s.zeroWrites===0&&s.validations===1&&s.schemaChecks===2&&s.inventoryChecks===1,'callback_publication');}
  const w=r.waiting,a=r.after;need(w.pendingCallbacks===1&&!w.released&&w.phase==='retiring'&&w.privateBuffers===2&&w.sourceBuffers===2&&w.destinationBuffers===0&&w.zeroedBytes+w.releases+w.deniedWrites+w.frames+w.borrows===0&&w.pinned&&!w.exclusive,'pending_lifetime');same(w,r.closed);
  const trace=[...prefix,'pin-and-stop-source',...full,'fatal:async_callback_unsupported','callback-pending'];same(w.trace.map(x=>x.kind),trace);
  drained(a);need(a.deniedWrites===1,'late_mutation');same(a.trace.map(x=>x.kind),[...trace,'callback-settled','drained']);same(a,r.late);
 }
 return {constructorRefusals:e.constructorBudgets.length,operationRefusals:e.operationBudgets.length,asyncRefusals:e.asyncCallbacks.length,changedOperationsInvoked:e.operationBudgets.reduce((n,r)=>n+r.operationCalls,0),callbackPublications:e.asyncCallbacks.reduce((n,r)=>n+r.after.publications,0),callbackBytesWritten:e.asyncCallbacks.reduce((n,r)=>n+r.after.zeroWrites+r.after.writes,0),r1Exit:false,productionAdopted:false};
}
export function compareR1oReview(saved,fresh){validateR1oReview(saved);validateR1oReview(fresh);same(saved,fresh);}
