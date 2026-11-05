import {ownedDigest} from '../../utils/gradleOwnedJson.js';
import {CgpI0Authority,type I0Session,type I0Inventory} from './gradleOwnedCgpI0Authority.js';
import {i0Manifest,i0MakeBatch,i0Need,i0Same,type I0Range} from './gradleOwnedCgpI0Schema.js';
import {i0Wire} from './gradleOwnedCgpI0Wire.js';
export function i0Plan(authority:CgpI0Authority,session:I0Session,inventory:I0Inventory,transferId:string){
 const verified=authority.inventory(session,inventory),context=authority.check(session),scope=authority.scope(),m=i0Manifest(authority.manifest);i0Need(['B*','AB*'].includes(m.mode),'mode_mismatch');
 const total=verified.entries.reduce((n,e)=>n+e.byteLength,0);i0Need(total<=m.readPlan.maxDataBytes&&verified.entries.length<=m.readPlan.maxEntries,'plan_budget');
 const make=(ranges:I0Range[],batch:number,planDigest='0'.repeat(64))=>i0MakeBatch({schema:'osv-mcp.cgp.source-command.v2',api:'aux.ReadSourceRanges',purpose:'read',operationId:ownedDigest({domain:'cgp-i0-batch-operation',transferId,batch}),peer:context.peer,lineage:scope.lineage,binding:scope.binding,payload:{snapshot:scope.binding.selected!.snapshot,checkpoint:scope.binding.selected!.checkpoint,pin:scope.pin,...(context.peer.role==='reader'?{}:{origin:scope.reader}),transferId,planDigest,ranges,byteBudget:ranges.reduce((n,r)=>n+r.length,0)}});
 const groups:I0Range[][]=[];let group:I0Range[]=[];
 for(const e of verified.entries){let offset=0;while(offset<e.byteLength){if(group.length===4||group.reduce((n,r)=>n+r.length,0)===4096){groups.push(group);group=[];}
  let lo=1,hi=Math.min(e.byteLength-offset,4096-group.reduce((n,r)=>n+r.length,0)),best=0;
  const range=(length:number):I0Range=>({ordinal:group.length,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
  while(lo<=hi){const mid=Math.floor((lo+hi)/2);try{i0Wire(authority.authorize(session,make([...group,range(mid)],groups.length)));best=mid;lo=mid+1;}catch(error){if(!String(error).includes('wire_budget'))throw error;hi=mid-1;}}
  if(!best){i0Need(group.length>0,'plan_no_fit');groups.push(group);group=[];continue;}group.push(range(best));offset+=best;
  i0Need(groups.length<m.readPlan.maxBatches,'plan_budget');
 }}if(group.length)groups.push(group);
 const planDigest=ownedDigest({domain:'cgp-i0-range-plan',inventory:verified.digest,transferId,binding:scope.binding,groups}),commands=groups.map((ranges,i)=>make(ranges,i,planDigest));let wireBytes=0,workUnits=0;
 for(const command of commands){const wire=i0Wire(authority.authorize(session,command));wireBytes+=wire.total;workUnits+=wire.request.length+command.payload.ranges.length;}
 i0Need(commands.length<=m.readPlan.maxBatches&&commands.length<=m.guard.maxSlots&&wireBytes<=m.readPlan.maxWireBytes&&workUnits<=m.readPlan.maxWorkUnits,'plan_budget');
 return {planDigest,commands,wireBytes,workUnits,sourceBytes:total};
}

/** Independent deterministic replanning rejects rehashed caller plans; no response is released here. */
export function i0ValidatePlan(authority:CgpI0Authority,session:I0Session,inventory:I0Inventory,transferId:string,plan:unknown){i0Need(i0Same(i0Plan(authority,session,inventory,transferId),plan),'plan_mismatch');}
