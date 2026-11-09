/** CWC-C approved connected planner: identical groups/bounds; A facts use B length proof. */
import {parsed,need,cid} from '../../utils/gradleOwnedCurrentSchema.js';
import {ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {cprEntry,context,checkCommand,operation,wireIntent,CPR_SPEC,CPR_SPEC_DIGEST,type CprContext,type CprRange,type CprCommand} from './gradleOwnedCprASchema.js';
import {planCore,CPR_PLAN_WORK_BOUND} from './gradleOwnedCprAPlanner.js';
import {makeTracked,newStats,exact,type Stats} from './gradleOwnedCprAWire.js';
import {CwcAContract} from './gradleOwnedCwcA.js';
import {ClosedCwcBCodec} from './gradleOwnedCwcB.js';
import {type CwcConnectedGrant} from './gradleOwnedCwcC.js';
import {span,planRoot} from './gradleOwnedCprBPProfile.js';
export {CPR_PLAN_WORK_BOUND};
export type PlannerVariant='reference'|'max-first'|'single-check'|'combined';
export type PlannerConfig={variant:PlannerVariant;actor:'client-initial'|'client-seal'|'provider'|'unit';witness?:{call:number;requestDigest:string;batchOrdinal:number}};
function built(c:CprContext,seed:string,transferId:string,ordinal:number,count:number,digest:string,ranges:CprRange[],s:Stats){
 // Private assembly from parsed context and private numeric ranges. One complete
 // public checkCommand still validates schema, wire intent, context and operation.
 return span('command',()=>{
  s.finalCommands++;
  const q:CprCommand={schema:'osv-mcp.cgp.source-command.v3',api:'aux.ReadSourceRanges',purpose:'read',operationId:operation(c,seed,transferId,ordinal),peer:c.peer,lineage:c.lineage,binding:c.binding,
   payload:{snapshot:c.snapshot,checkpoint:c.checkpoint,pin:c.pin,...(c.origin?{origin:c.origin}:{}),transferId,plan:{specDigest:CPR_SPEC_DIGEST,seed,batchOrdinal:ordinal,batchCount:count,planDigest:digest,inventoryDigest:c.inventoryDigest},ranges,byteBudget:ranges.reduce((n,r)=>n+r.length,0)},requestDigest:'0'.repeat(64)};
  q.requestDigest=wireIntent(q);s.finalAuthorization++;checkCommand(c,q);return structuredClone(q);
 });
}
export function pack(input:unknown,entriesInput:unknown[],seedInput:string,transferInput:string,gate:()=>void=()=>{},s:Stats=newStats(),config:PlannerConfig={variant:'reference',actor:'unit'},connection?:{referenceOracle?:boolean;grant:CwcConnectedGrant;approval:unknown;pin:string;now:()=>number;initial?:Readonly<{kind:string}>}){
 need(connection,'codec_profile_unsupported');
 need(['reference','max-first','single-check','combined'].includes(config.variant),'configuration_invalid');
 if(config.actor==='provider')need(config.witness&&Number.isSafeInteger(config.witness.call)&&config.witness.call>0&&/^[a-f0-9]{64}$/.test(config.witness.requestDigest)&&Number.isSafeInteger(config.witness.batchOrdinal)&&config.witness.batchOrdinal>=0&&config.witness.batchOrdinal<19,'configuration_invalid');
 return planRoot(config.variant,config.actor,()=>{
  const check=()=>span('gate',gate),c=context(input),seed=parsed(cid,seedInput),transferId=parsed(cid,transferInput),entries=entriesInput.map(e=>parsed(cprEntry,e));
  need(entries.length>=5&&entries.length<=9&&entries.reduce((n,e)=>n+e.byteLength,0)<=41460,'capacity_exhausted');
  let commits=0,payloads=0,payloadStarted=false;
  for(const e of entries){if(e.kind==='commit')need(!payloadStarted&&e.index===commits++,'inventory_invalid');else{payloadStarted=true;need(e.index===payloads++,'inventory_invalid');}}
  need(commits>0&&payloads>=4,'inventory_invalid');check();
  const sizing=span('codec',()=>connection.grant.sizing(c,seed,transferId,s)),groups:CprRange[][]=[];
  let group:CprRange[]=[],used=0;s.phase='packing';
  for(const e of entries){let offset=0;while(offset<e.byteLength){
   check();if(group.length===4||used===4096){groups.push(group);group=[];used=0;}need(groups.length<19,'capacity_exhausted');
   const upper=Math.min(e.byteLength-offset,4096-used),range=(length:number):CprRange=>({ordinal:group.length,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
   let lo=1,hi=upper,best=0;
   if(['max-first','combined'].includes(config.variant)){check();if(sizing.bound([...group,range(upper)]).fits)best=upper;else hi=upper-1;}
   if(!best)while(lo<=hi){check();const n=Math.floor((lo+hi)/2);if(sizing.bound([...group,range(n)]).fits){best=n;lo=n+1;}else hi=n-1;}
   if(!best){need(group.length>0,'wire_budget');groups.push(group);group=[];used=0;continue;}
   group.push(range(best));offset+=best;used+=best;
  }}
  if(group.length)groups.push(group);need(groups.length<=19,'capacity_exhausted');s.phase='final';check();
  const core=planCore(c,seed,transferId,groups),digest=hash(core);
  const commands=groups.map((rs,i)=>{check();return ['single-check','combined'].includes(config.variant)?built(c,seed,transferId,i,groups.length,digest,rs,s):span('command',()=>makeTracked(c,seed,transferId,i,groups.length,digest,rs,s));});
  const grant=connection.grant;
  const codec=new ClosedCwcBCodec({context:c,gate:check,now:connection.now,deadline:grant.identity.originalDeadline,budget:{bytes:1048576,fragments:4096,work:156978},connected:grant});
  let owner:CwcAContract|undefined;
  try{owner=new CwcAContract({context:c,approval:connection.approval,approvalPin:connection.pin,actor:grant.actor,now:connection.now,current:()=>{check();return {context:c,approvalPin:connection.pin};},parentReservation:{bytes:1048576,fragments:4096,work:156978},connected:grant,codec});
  const scope=owner.openScope(grant.identity,{bytes:1048576,fragments:4096,work:156978},connection.initial),root=owner.openCodecRoot(scope,core),aLayout=owner.compilePlanLayout(root),facts:Readonly<{kind:string}>[]=[];
  let wireBytes=0,workUnits=0,referenceOracleCalls=0;
   const bounds=commands.map(q=>{check();const fact=owner!.encodeCheckedCommand(root,aLayout,q);facts.push(fact);const receipt=owner!.provePlannedOwnerAndAuth(root,aLayout,fact);const actual=owner!.connectedWidths(root,receipt,grant);const bound=sizing.bound(q.payload.ranges);
    // Widths come only from the same A-root-bound B proof; no owner/auth wire materialization.
    if(connection.referenceOracle){check();const oracle=exact(c,q,newStats());referenceOracleCalls++;need(oracle.request===actual.request&&oracle.reply===actual.reply&&oracle.frames.every((n,i)=>n===actual.frames[i])&&oracle.total<=81920,'codec_layout_mismatch');check();}
    const requestBytes=actual.request;wireBytes+=bound.total;workUnits+=requestBytes+q.payload.ranges.length;return bound;
   });
   need(wireBytes<=CPR_SPEC.wireBytes&&workUnits+s.arithmeticTrials<=CPR_PLAN_WORK_BOUND,'capacity_exhausted');check();
   return {core,planDigest:digest,commands,bounds,wireBytes,workUnits,stats:s,connection:{owner,scope,root,facts,codec,grant,referenceOracleCalls}};
  }catch(e){owner?.close();codec.close();throw e;}

 },config.witness);
}
