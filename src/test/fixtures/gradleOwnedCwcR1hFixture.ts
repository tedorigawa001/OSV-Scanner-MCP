/** Finite observer/oracle owner, outside an admitted runtime. All copied records/caller graphs remain uncharged. */
import {R1hRuntime,createR1hPorts,observeR1h,R1H_RUNTIME_SCOPE,type R1hMode,type R1hActor} from './gradleOwnedCwcR1h.js';
const modes=['full-input','owned-input'] as const,actors=['provider','client'] as const;
function refused(fn:()=>unknown){try{fn();return false;}catch{return true;}}
function closeAttempt(r:R1hRuntime,h:ReturnType<R1hRuntime['beginRead']>,actor:R1hActor){r.closeWindow(h,r.window(h,'first'));if(actor==='client'){const seal=r.window(h,'seal');r.publish(h,seal);r.closeWindow(h,seal);}}
export function r1hMatrix(){
 const normal=[];for(const mode of modes)for(const actor of actors)for(const capacity of [1,4]){
  const ports=createR1hPorts(),r=new R1hRuntime({ports,mode,capacity}),h=r.beginRead(actor),peers=Array.from({length:capacity-1},()=>r.beginRead('provider'));
  const reserved=observeR1h(r,h);r.openAttempt(h);const first=r.window(h,'first'),borrow=r.beginBorrow(h,first);r.publish(h,first);closeAttempt(r,h,actor);
  const firstClosed=observeR1h(r,h);ports.advance(10);const owner2=r.openAttempt(h),second=r.window(h,'first'),transport=r.beginTransport(h,second);r.publish(h,second);closeAttempt(r,h,actor);r.closeRead(h);
  const waiting=observeR1h(r,h),earlyRefused=refused(()=>r.reclaim(h));r.endBorrow(h,borrow);const stillTransport=observeR1h(r,h),transportRefused=refused(()=>r.reclaim(h));r.endTransport(h,transport);r.reclaim(h);const drained=observeR1h(r,h),lateRefused=refused(()=>r.publish(h,second));
  for(const peer of peers){r.closeRead(peer);r.reclaim(peer);}normal.push({id:`${mode}/${actor}/${capacity}`,mode,actor,capacity,reserved,firstClosed,waiting,earlyRefused,stillTransport,transportRefused,drained,lateRefused,newOwner:owner2!==h,newWindow:first!==second,final:observeR1h(r)});
 }
 const rejection=[];const faults=['reenter-publish','reenter-reclaim','reenter-open','cancel-before-publication','expire-before-publication','revoke-before-publication','pin-restore-before-publication'] as const;
 for(const mode of modes)for(const actor of actors)for(const fault of faults){const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead(actor);r.openAttempt(h);const w=r.window(h,'first');ports.arm(fault);const denied=refused(()=>r.publish(h,w)),waiting=observeR1h(r,h);r.reclaim(h);rejection.push({id:`${mode}/${actor}/${fault}`,mode,actor,fault,denied,waiting,final:observeR1h(r)});}
 const cleanup=[];for(const mode of modes)for(const actor of actors){const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead(actor);r.openAttempt(h);r.closeRead(h);ports.arm('cleanup-after-first');const denied=refused(()=>r.reclaim(h)),partial=observeR1h(r,h),fullRefused=refused(()=>r.beginRead());r.reclaim(h);const final=observeR1h(r),lateRefused=refused(()=>r.reclaim(h));cleanup.push({id:`${mode}/${actor}`,mode,actor,denied,partial,fullRefused,lateRefused,final});}
 return {schema:'cwc-r1h0.observation.v1',scope:R1H_RUNTIME_SCOPE,normal,rejection,cleanup,
  limits:{registryCapacity:4,attemptsPerRead:2,bodiesPerRead:2,binaryBytesPerBody:3072,referenceSlotsPerBody:48,opaquePerBody:8,opaquePerRead:16,pendingTransportPerRead:1},
  unproved:{bridgeUpperBytes:null,wrapperUpperBytes:null,frameUpperBytes:null,diagnosticCallerUpperBytes:null,physicalHeapUpperBytes:null,wholeReadUpperBytes:null,originalUnitWork:null}};
}
export type R1hObservation=ReturnType<typeof r1hMatrix>;
