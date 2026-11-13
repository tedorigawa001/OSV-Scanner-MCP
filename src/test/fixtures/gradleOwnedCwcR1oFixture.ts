/** Ownership observations and diagnostic callback faults. No raw producer bytes are returned. */
import {R1oRuntime,type R1oActor,type R1oSite,type R1oHandle} from './gradleOwnedCwcR1o.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {createR1oBudget} from './gradleOwnedCwcR1oBudget.js';
import {Vf0Clock} from './gradleOwnedCwcVf0Authority.js';
export function r1oFixture(o:{role?:'reader'|'authority-broker';boundary?:string;workload?:'small'|'stress';actor?:R1oActor;budget?:Lb0Budget;hook?:NonNullable<ConstructorParameters<typeof R1oRuntime>[0]>['hook']}={}){
 const budget=o.budget??createR1oBudget(),clock=new Vf0Clock(),r=new R1oRuntime({budget,clock,role:o.role,boundary:o.boundary,workload:o.workload,hook:o.hook});
 return {r,budget,clock};
}
export function r1oReady(o:Parameters<typeof r1oFixture>[0]={}){const f=r1oFixture(o),call=f.r.createCall(o.actor??'provider'),source=f.r.registerOwnedIntake(call,'source'),destination=f.r.registerOwnedIntake(call,'destination');f.r.reserveDiagnostic(call);const window=f.r.constructOwnedState(call,source);return {...f,call,source,destination,window};}
export function r1oSuccess(o:Parameters<typeof r1oFixture>[0]={}){
 const f=r1oReady(o),{r,call,source,destination,window}=f;try{
  const before=r.inspectScope(call,source),sourceAlias=r.coreHandle(call,window)===window,borrow=r.beginBorrow(call,window);r.moveOwnedState(call,window,destination);const waiting=r.stats(call);
  r.borrowUpdate(call,borrow,'core','touch');r.completeBorrow(call,borrow);const dest=r.publishOwnedWindow(call),destinationAlias=r.coreHandle(call,dest)===dest,after=r.inspectScope(call,destination);
  r.retireOwnedState(call,window);const published=r.stats(call);r.close(call);const drained=r.stats(call);r.close(call);
  return {role:o.role??'reader',boundary:o.boundary??'normal',workload:o.workload??'small',actor:o.actor??'provider',sourceAlias,destinationAlias,before,after,waiting,published,drained,secondClose:r.stats(call)};
 }finally{r.close(call);}
}
export const R1O_FAULTS=['update','zero','restore-pair','close','expire','reentry','throwing-message'] as const;
export function r1oRefusal(actor:R1oActor,site:Extract<R1oSite,'after-validation'|'before-bind'>,fault:typeof R1O_FAULTS[number]){
 let f:ReturnType<typeof r1oReady>,attempted=false,innerCaught=0,inside:ReturnType<R1oRuntime['stats']>|undefined,diagnosticCalls=0;
 const callback=(r:R1oRuntime,c:R1oHandle,s:R1oHandle)=>{
  const act=(fn:()=>void)=>{attempted=true;try{fn();}catch{innerCaught++;}};
  if(fault==='update')act(()=>r.sourceUpdate(c,s,'core','corrupt'));else if(fault==='zero')act(()=>r.sourceZero(c,s,'context'));
  else if(fault==='restore-pair'){act(()=>r.sourceUpdate(c,s,'core','corrupt'));act(()=>r.sourceUpdate(c,s,'core','restore'));}
  else if(fault==='close'){attempted=true;r.close(c);}else if(fault==='expire'){attempted=true;f.clock.advance(4500);}else if(fault==='reentry')act(()=>r.publishOwnedWindow(c));
  else {attempted=true;const e=new Error('callback');Object.defineProperty(e,'message',{get(){diagnosticCalls++;throw Error('getter');}});throw e;}
  inside=r.stats(c);
 };
 f=r1oReady({actor,hook:(at,r,c,s)=>{if(at===site)callback(r,c,s);}});const {r,call,window,destination}=f;
 try{r.moveOwnedState(call,window,destination);let refused=false;try{r.publishOwnedWindow(call);}catch{refused=true;}const after=r.stats(call);r.close(call);
  return {actor,site,fault,attempted,innerCaught,diagnosticCalls,refused,inside:inside??null,after};
 }finally{r.close(call);}
}
export function r1oMatrix(){return {schema:'cwc-r1o.evidence.v1',successes:(['reader','authority-broker'] as const).flatMap(role=>['normal','registered-maximum','schema-upper'].flatMap(boundary=>(['small','stress'] as const).flatMap(workload=>(['provider','client-initial','client-seal'] as const).map(actor=>r1oSuccess({role,boundary,workload,actor}))))),
 refusals:(['provider','client-initial','client-seal'] as const).flatMap(actor=>(['after-validation','before-bind'] as const).flatMap(site=>R1O_FAULTS.map(fault=>r1oRefusal(actor,site,fault))))};}
/** Actual review fault observations, including pending and rejected ordinary native Promises. */
export async function r1oReviewMatrix(){
 const constructorBudgets=(['derived','fake-reservation','external-balance'] as const).map(kind=>{
  let operationCalls=0,externalReads=0,refused=false,registered=false;class Derived extends Lb0Budget {}
  class Fake extends Lb0Budget {override reserve(){operationCalls++;return Object.freeze({kind:'lb0-memory-reservation' as const});}override release(){operationCalls++;}}
  const balance={work:0,initialization:0,wire:0,attempts:0,get extra(){externalReads++;return 0;}},budget=kind==='derived'?new Derived():kind==='fake-reservation'?new Fake(undefined,0,0):new Lb0Budget(balance);
  try{const r=new R1oRuntime({budget});registered=!!r.createCall();}catch{refused=true;}
  return {kind,operationCalls,externalReads,refused,registered};
 });
 const operationBudgets=[];
 for(const stage of ['ready','before-bind'] as const)for(const style of ['value','getter'] as const)for(const key of ['check','reserve','release','stats'] as const){
  const prototype=Lb0Budget.prototype,original=Object.getOwnPropertyDescriptor(prototype,key)!;let operationCalls=0,refused=false;
  const replacement=function(this:Lb0Budget,...args:unknown[]){operationCalls++;return Reflect.apply(original.value,this,args);};
  const replace=()=>Object.defineProperty(prototype,key,style==='value'?{...original,value:replacement}:{configurable:true,enumerable:original.enumerable,get(){operationCalls++;return replacement;}});
  const f=r1oReady({hook:at=>{if(stage==='before-bind'&&at==='before-bind')replace();}});
  try{if(stage==='ready')replace();f.r.moveOwnedState(f.call,f.window,f.destination);f.r.publishOwnedWindow(f.call);}catch{refused=true;}finally{Object.defineProperty(prototype,key,original);}
  const after=f.r.stats(f.call);f.r.close(f.call);operationBudgets.push({stage,style,key,operationCalls,refused,after});
 }
 const asyncCallbacks=[];
 for(const actor of ['provider','client-initial','client-seal'] as const)for(const site of ['after-validation','before-bind'] as const)for(const outcome of ['fulfilled','rejected'] as const){
  let pending:Promise<void>|undefined,finish:(()=>void)|undefined,completed=false,caught=0,refused=false;
  const f=r1oReady({actor,hook:(at,r,c,s)=>{if(at===site){const gate=new Promise<void>(resolve=>{finish=resolve;});pending=(async()=>{await gate;try{r.sourceZero(c,s,'core');}catch{caught++;}completed=true;if(outcome==='rejected')throw Error('review-callback');})();return pending;}}});
  f.r.moveOwnedState(f.call,f.window,f.destination);try{f.r.publishOwnedWindow(f.call);}catch{refused=true;}
  const waiting=f.r.stats(f.call),completedAtRefusal=completed;f.r.close(f.call);const closed=f.r.stats(f.call);finish!();await pending!.then(()=>{},()=>{});const after=f.r.stats(f.call);
  let lateRejected=false;try{f.r.publishOwnedWindow(f.call);}catch{lateRejected=true;}f.r.close(f.call);
  asyncCallbacks.push({actor,site,outcome,refused,completedAtRefusal,completed,caught,waiting,closed,after,lateRejected,late:f.r.stats(f.call)});
 }
 return {schema:'cwc-r1o.review.v1',constructorBudgets,operationBudgets,asyncCallbacks};
}
