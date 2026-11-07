import {plannerContext,plannerCost,plannerGate,type PlanMeasure} from './gradleOwnedCgpI2PProfile.js';
import type {KeyObject} from 'node:crypto';
import {ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import type {CgpI0Authority,I0Session,I0Inventory,I0VerifiedPlan} from './gradleOwnedCgpI2PAuthority.js';
import {i0Manifest,i0MakeBatch,i0Need,type I0Range} from './gradleOwnedCgpI0Schema.js';
import {i0Wire,i0ValidateReply} from './gradleOwnedCgpI2PWire.js';
export function i0Plan(authority:CgpI0Authority,session:I0Session,inventory:I0Inventory,transferId:string,operationBase=transferId){
 const profile=plannerContext(),measure:PlanMeasure={wallMs:0,otherMs:0,status:'running',costs:{},probes:[]},started=performance.now();profile.measure.plans.push(measure);profile.active=measure;try{const {verified,context,scope,m}=plannerCost('setup',()=>({verified:authority.inventory(session,inventory),context:authority.check(session),scope:authority.scope(),m:i0Manifest(authority.manifest)}));i0Need(['B*','AB*'].includes(m.mode),'mode_mismatch');
 const total=verified.entries.reduce((n,e)=>n+e.byteLength,0);
 const make=(ranges:I0Range[],batch:number,planDigest='0'.repeat(64))=>i0MakeBatch({schema:'osv-mcp.cgp.source-command.v2',api:'aux.ReadSourceRanges',purpose:'read',operationId:ownedDigest({domain:'cgp-i0-batch-operation',transferId:operationBase,batch}),peer:context.peer,lineage:scope.lineage,binding:scope.binding,payload:{snapshot:scope.binding.selected!.snapshot,checkpoint:scope.binding.selected!.checkpoint,pin:scope.pin,...(context.peer.role==='reader'?{}:{origin:scope.reader}),transferId,planDigest,ranges,byteBudget:ranges.reduce((n,r)=>n+r.length,0)}});
 const probe=(ranges:I0Range[],batch:number,kind:'max'|'binary'|'final')=>{const q=plannerCost('command',()=>make(ranges,batch)),intent=plannerCost('authorization',()=>authority.authorizeEstimate(session,q));const event={ordinal:measure.probes.length+1,kind,length:ranges.at(-1)!.length,commandDigest:q.requestDigest,fit:false,wireBytes:0};measure.probes.push(event);try{const wire=plannerCost('wire',()=>i0Wire(intent));event.fit=true;event.wireBytes=wire.total;return true;}catch(error){if(!String(error).includes('cgp_i0_wire_budget'))throw error;return false;}};
 const groups:I0Range[][]=[];let group:I0Range[]=[];
 for(const e of verified.entries){let offset=0;while(offset<e.byteLength){if(group.length===4||group.reduce((n,r)=>n+r.length,0)===4096){groups.push(group);group=[];}
  let lo=1,hi=Math.min(e.byteLength-offset,4096-group.reduce((n,r)=>n+r.length,0)),best=0;
  const range=(length:number):I0Range=>({ordinal:group.length,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
  if(profile.strategy==='max-first'&&probe([...group,range(hi)],groups.length,'max')){best=hi;lo=hi+1;}else if(profile.strategy==='max-first')hi--;
  while(lo<=hi){const mid=Math.floor((lo+hi)/2);if(probe([...group,range(mid)],groups.length,'binary')){best=mid;lo=mid+1;}else hi=mid-1;}
  if(!best){i0Need(group.length>0,'plan_no_fit');groups.push(group);group=[];continue;}group.push(range(best));offset+=best;
  i0Need(groups.length<m.readPlan.maxBatches,'plan_budget');
 }}if(group.length)groups.push(group);
 const planDigest=plannerCost('digest',()=>ownedDigest({domain:'cgp-i0-range-plan',inventory:verified.digest,transferId,binding:scope.binding,groups})),commands=groups.map((ranges,i)=>plannerCost('command',()=>make(ranges,i,planDigest)));let wireBytes=0,workUnits=0;
 for(const command of commands){const intent=plannerCost('authorization',()=>authority.authorizeEstimate(session,command)),wire=plannerCost('wire',()=>i0Wire(intent));measure.probes.push({ordinal:measure.probes.length+1,kind:'final',length:command.payload.ranges.at(-1)!.length,commandDigest:command.requestDigest,fit:true,wireBytes:wire.total});wireBytes+=wire.total;workUnits+=wire.request.length+command.payload.ranges.length;}
 i0Need(commands.length<=m.readPlan.maxBatches&&wireBytes<=m.readPlan.maxWireBytes&&workUnits<=m.readPlan.maxWorkUnits,'plan_budget');
 const result={planDigest,commands,wireBytes,workUnits,sourceBytes:total};measure.outputDigest=plannerCost('outputDigest',()=>ownedDigest(result));plannerGate('plan-return');measure.status='complete';return result;}catch(error){measure.status='failed';throw error;}finally{measure.wallMs=performance.now()-started;measure.otherMs=measure.wallMs-Object.values(measure.costs).reduce((n,t)=>n+t.ms,0);profile.active=undefined;}
}

/** Releases entries only when every planned reply is valid and every entry matches its verified digest. */
export function i0ReceiveTransfer(authority:CgpI0Authority,session:I0Session,inventory:I0Inventory,plan:I0VerifiedPlan,wires:Buffer[],publicKey:KeyObject){
 const verified=authority.inventory(session,inventory),commands=authority.planCommands(session,plan);i0Need(wires.length===commands.length,'transfer_incomplete');
 const chunks=new Map<string,Buffer[]>();
 commands.forEach((q,i)=>{const parts=i0ValidateReply(authority.authorize(session,q,plan),wires[i]!,publicKey);q.payload.ranges.forEach((r,j)=>{const key=r.kind+':'+r.index,list=chunks.get(key)??[];list.push(parts[j]!);chunks.set(key,list);});});
 const entries=new Map<string,Buffer>();
 for(const e of verified.entries){const key=e.kind+':'+e.index,data=Buffer.concat(chunks.get(key)??[]);i0Need(data.length===e.byteLength&&ownedSha256(data)===e.sha256,'transfer_entry_mismatch');entries.set(key,data);}
 return entries;
}
