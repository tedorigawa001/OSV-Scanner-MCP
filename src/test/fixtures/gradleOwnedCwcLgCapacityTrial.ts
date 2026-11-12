/** Synthetic reservation replay only. Does not allocate CWC plans, facts, snapshots or private command windows. */
import {capacityRow} from './gradleOwnedCwcLgCapacity.mjs';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {need,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
export function capacityReservationTrial(input:unknown,role:'reader'|'authority-broker',recipe:string,mode:string,budget=new Lb0Budget()){
 need(['full-input','owned-input'].includes(mode),'codec_profile_unsupported');Lb0Budget.require(budget);
 const audit=capacityRow(input,role,recipe),selected=audit[audit.worstActor],attempts:any[]=[];
 const base=budget.reserve(131072,4096);let scratch:ReturnType<Lb0Budget['reserve']>|undefined;
 try{scratch=budget.reserve(131072);budget.release(scratch);scratch=undefined;for(let index=0;index<2;index++){
  const tickets:ReturnType<Lb0Budget['reserve']>[]=[],labels:string[]=[];let slot:ReturnType<Lb0Budget['reserve']>|undefined;
  let frontier='scope',error:string|null=null,livePeak=0,beforeRelease=budget.stats();
  try{
   for(const [name,bytes]of Object.entries(selected.regions) as [string,number][]){
    if(name==='frames')continue; // The old CLB frame workspace is already inside callBytes.
    frontier='scope.'+name;if(bytes){tickets.push(budget.reserve(bytes));labels.push(frontier);}
   }
   frontier='call-and-binding';slot=budget.reserve(98304+8192,12288,57344,57344,true);tickets.push(slot);labels.push(frontier);
   frontier='lg';tickets.push(budget.reserve(4096,4096));labels.push(frontier);livePeak=budget.stats().heldBytes;
   frontier='logical-gate';budget.reserve(0,0,1);labels.push(frontier);
  }catch(e){if(!(e instanceof CurrentControlError))throw e;error=e.reason;livePeak=budget.stats().heldBytes;}
  finally{beforeRelease=budget.stats();for(const t of tickets.reverse())budget.release(t);if(slot)budget.endSlot(slot);}
  attempts.push({index,error,failedRegion:error?frontier:null,labels,livePeak,beforeRelease,afterRelease:budget.stats()});
  if(error)break;
 }}finally{if(scratch)budget.release(scratch);budget.release(base);}
 return {mode,recipe,role,attempts,final:budget.stats(),scope:{syntheticReservations:true,actualCwcConsumer:false,sourceReads:0,replyPublications:0,admitted:false}};
}
