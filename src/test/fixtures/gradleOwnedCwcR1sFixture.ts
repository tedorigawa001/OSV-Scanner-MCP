/** Finite record/oracle observer. Its copied packet arrays and snapshots have no admitted charge. */
import {R1sDelivery,observeR1s,copyR1sPacket,R1S_SCOPE,type SummaryHandle} from './gradleOwnedCwcR1s.js';
const modes=['full-input','owned-input'] as const;
const denied=(fn:()=>unknown)=>{try{fn();return false;}catch{return true;}};
export function r1sMatrix(){
 const normal=[];for(const mode of modes)for(const capacity of [1,4])for(const attempts of [1,2]){
  const r=new R1sDelivery(mode,capacity),h=r.beginRead(),peers=Array.from({length:capacity-1},()=>r.beginRead());r.finishMain(h,'success');const reserved=observeR1s(r,h),packets:number[][]=[],stages=[];
  for(let a=1;a<=attempts;a++){const t=r.emit(h,a as 1|2)!;packets.push(copyR1sPacket(r,h,t));r.dispatch(h,t,r.recipient());r.receive(h,t);r.completeTransfer(h,t);const borrow=r.borrowConsumer(h,t);r.consume(h,borrow);const held=observeR1s(r,h),early=denied(()=>r.reclaim(h));r.releaseConsumer(h,borrow);
   r.dispatch(h,t,r.recipient());const duplicate=r.receive(h,t);r.ack(h,t);r.completeTransfer(h,t);stages.push({attempt:a,held,early,duplicate,drained:observeR1s(r,h)});
  }
  const ready=observeR1s(r,h);r.reclaim(h);const released=observeR1s(r,h),late=denied(()=>r.emit(h,1));for(const p of peers){r.finishMain(p,'success');r.reclaim(p);}
  normal.push({id:`${mode}/${capacity}/${attempts}`,mode,capacity,attempts,reserved,packets,stages,ready,released,late,final:observeR1s(r)});
 }
 const rejection=[];const faults=['header','counter','digest','reserved','generation','receive-reentry','expiry','revoke'] as const;
 for(const mode of modes)for(const fault of faults){const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');if(fault!=='expiry'&&fault!=='revoke')r.faultNext(fault);r.dispatch(h,t,r.recipient());if(fault==='expiry')r.advance(6000);if(fault==='revoke')r.revokeRecipient();const refused=denied(()=>r.receive(h,t)),waiting=observeR1s(r,h),early=denied(()=>r.reclaim(h));r.completeTransfer(h,t);r.reclaim(h);rejection.push({id:`${mode}/${fault}`,mode,fault,refused,waiting,early,final:observeR1s(r)});}
 const cancelled=[];for(const mode of modes)for(const borrowed of [false,true]){const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.receive(h,t);const lease:SummaryHandle|undefined=borrowed?r.borrowConsumer(h,t):undefined;r.cancelDiagnostics(h);const waiting=observeR1s(r,h),early=denied(()=>r.reclaim(h));r.completeTransfer(h,t);const stillHeld=observeR1s(r,h);if(lease)r.releaseConsumer(h,lease);else r.discardConsumer(h,t);r.reclaim(h);cancelled.push({id:`${mode}/${borrowed?'borrowed':'queued'}`,mode,borrowed,waiting,early,stillHeld,final:observeR1s(r)});}
 const unavailable=[];for(const mode of modes){const r=new R1sDelivery(mode),h=r.beginRead();r.finishMain(h,'success');r.faultNext('encode-fail');const noRecord=r.emit(h,1)===undefined,again=denied(()=>r.emit(h,1)),waiting=observeR1s(r,h);r.reclaim(h);unavailable.push({id:mode,mode,noRecord,again,waiting,final:observeR1s(r)});}
 return {schema:'cwc-r1s.observation.v1',scope:R1S_SCOPE,normal,rejection,cancelled,unavailable,limits:{records:2,bytesPerRecord:256,senderBytes:512,transferBytes:256,receiverBytes:512,totalBinaryPerRead:1280,readsPerEpoch:64,ordinaryEntries:240,cleanupEntries:16,sendsPerRecord:2},unproved:{wrapperUpperBytes:null,observerCopyUpperBytes:null,originalUnitCounterMapping:null,physicalHeapUpperBytes:null,wholeReadUpperBytes:null}};
}
