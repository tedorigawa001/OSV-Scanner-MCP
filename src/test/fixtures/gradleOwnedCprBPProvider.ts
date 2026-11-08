/** CPR-B only: real authenticated-call authority; mock Saved/store and live pin. */
import {type KeyObject} from 'node:crypto';
import {inspectAuthenticatedCall,noteAuthenticatedNoEffect,type AuthenticatedSessionCall} from './gradleOwnedCprBSession.js';
import {verifyOwnerValue} from './gradleOwnedCprBSigner.js';
import {type CredentialRegistry} from './gradleOwnedCgpI2Owners.js';
import {context,checkCommand,keys,same,type CprContext,type CprCommand} from './gradleOwnedCprASchema.js';
import {pack} from './gradleOwnedCprBPPlanner.js';
import {CPR_WORK} from './gradleOwnedCprAAdmission.js';
import {result,owner} from './gradleOwnedCprAWire.js';
import {sourceInventory,inventoryBytes,sourceBundleSchema,canonicalBase64,validateSourceCommand,sourceOperationKey,sourceResultSchema,type SourceBundle} from '../../utils/gradleOwnedSourceSchema.js';
import {ownedDigest as digest,ownedSha256 as sha,canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
import {need,parsed,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';

export const CPR_B_PHASES=['admission','pre-before','pre-after','load-before','load-after','plan-before','plan-after','parts-after','post-before','post-after','sign-before','enqueue-before'] as const;
export type CprBPhase=typeof CPR_B_PHASES[number];
export type CprBMode='S-scoped'|'B-independent';
import {type PlannerVariant} from './gradleOwnedCprBPPlanner.js';
export type ProviderOptions={variant:PlannerVariant;mode:CprBMode;context:CprContext;registry:CredentialRegistry;privateKey:KeyObject;
 now:()=>number;deadline:number;current:()=>void;live:()=>void;read:()=>SourceBundle;
 expected:{metadataDigest:string;inventoryDigest:string;inventorySha256:string;inventoryBytes:number;sourceBytes:number;entries:number};
 planEvents?:boolean;mutateResult?:(body:any)=>void;hook?:(phase:CprBPhase)=>void|Promise<void>;work?:number;slots?:number};
type Row={k:string;d:string;deadline:number;attempts:number;spent:{wire:number;work:number};state:'admitted'|'verified'|'complete'|'refused'|'unknown'|'retired'};

export class CprBPProvider {
 readonly #o:ProviderOptions;readonly #c:CprContext;readonly #rows=new Map<string,Row>();#busy=false;#requests=0;
 readonly metrics={calls:0,pre:0,post:0,loads:0,plans:0,planMs:0,validatedBytes:0,parts:0,replies:0};
 readonly plans:{requestDigest:string;batchOrdinal:number;call:number;inventoryDigest:string;inputDigest:string;planDigest:string;commands:number;work:number;ms:number}[]=[];
 constructor(options:ProviderOptions){need(['reference','max-first','single-check','combined'].includes(options.variant)&&['S-scoped','B-independent'].includes(options.mode)&&Number.isSafeInteger(options.work??1048576)&&(options.work??1048576)>0&&(options.work??1048576)<=67108864&&Number.isSafeInteger(options.slots??512)&&(options.slots??512)>0&&(options.slots??512)<=512,'configuration_invalid');this.#c=context(options.context);this.#o={...options,context:this.#c,expected:structuredClone(options.expected)};}
 get rows(){return structuredClone([...this.#rows.values()]);}
 async execute(wire:Buffer,call:AuthenticatedSessionCall){
  const initial=inspectAuthenticatedCall(call,wire);need(!this.#busy,'busy');this.#busy=true;let row:Row|undefined;
  let snapshot:SourceBundle|undefined;let data:Buffer[]|undefined;
  const o=this.#o,c=this.#c;
  const gate=()=>{o.current();const a=inspectAuthenticatedCall(call,wire);need(same(a.peer,c.peer)&&same(a.server,c.provider),'peer_mismatch');need(o.now()<Math.min(o.deadline,a.deadline,row?.deadline??Infinity),'request_expired');};
  const step=async(phase:CprBPhase)=>{gate();await o.hook?.(phase);gate();};
  const spend=(work:number,bytes=0)=>{gate();need(row&&row.spent.work+work<=(o.work??1048576)&&row.spent.wire+bytes<=163840,'operation_budget');row.spent.work+=work;row.spent.wire+=bytes;};
  try{
   noteAuthenticatedNoEffect(call);gate();
   const envelope=verifyOwnerValue(wire,o.registry,{role:c.peer.role,instanceId:c.peer.instanceId,direction:'request',domain:'aux',api:initial.api});
   const raw:any=(envelope.body as any).command;
   const batch=initial.api==='aux.ReadSourceRanges';
   need(!batch||o.mode==='B-independent','permission_denied');
   const q:any=batch?raw:validateSourceCommand(raw);
   need(['aux.ReadSourceRanges','aux.ReadSealedSource','aux.ReadSourceDescriptor'].includes(initial.api)&&q.api===initial.api,'permission_denied');
   if(batch)checkCommand(c,q);
   else{
    need(same(q.peer,c.peer)&&same(q.lineage,c.lineage)&&same(q.binding,c.binding)&&same(q.payload.snapshot,c.snapshot)&&same(q.payload.checkpoint,c.checkpoint)&&same(q.payload.pin,c.pin),'binding_mismatch');
    if(q.api==='aux.ReadSealedSource')need(same(q.payload.origin,c.origin),'binding_mismatch');
   }
   const kd=batch?keys(c,q):{k:sourceOperationKey(q),d:digest({domain:'cpr-b.scalar-intent',request:q.requestDigest,manifest:c.manifest})};
   const old=this.#rows.get(kd.k);row=old??{...kd,deadline:Math.min(o.deadline,initial.deadline),attempts:0,spent:{wire:0,work:0},state:'refused'};
   need(row.d===kd.d,'intent_conflict');need(!['admitted','verified','unknown','retired'].includes(row.state),'operation_busy');
   need(o.now()<row.deadline&&row.attempts<2,'operation_budget');
   need(row.spent.work+CPR_WORK.total<=(o.work??1048576)&&row.spent.wire+81920<=163840,'operation_budget');
   need(old||this.#rows.size<(o.slots??512),'slot_budget');need(this.#requests<256,'session_budget');gate();
   row.deadline=Math.min(row.deadline,initial.deadline);row.attempts++;row.state='admitted';this.#rows.set(row.k,row);this.#requests++;this.metrics.calls++;
   spend(0,wire.length);await step('admission');await step('pre-before');this.metrics.pre++;o.live();await step('pre-after');
   await step('load-before');spend(CPR_WORK.source);this.metrics.loads++;
   snapshot=parsed(sourceBundleSchema,JSON.parse(canonical(o.read(),262144)));gate();
   const inventory=sourceInventory(snapshot),ib=inventoryBytes(snapshot),expected=o.expected;
   need(inventory.rows.length<=9&&inventory.size<=41460&&ib.length<=4096&&inventory.rows.length===expected.entries&&inventory.size===expected.sourceBytes&&digest(snapshot.metadata)===expected.metadataDigest&&inventory.digest===expected.inventoryDigest&&sha(ib)===expected.inventorySha256&&ib.length===expected.inventoryBytes,'source_integrity');
   data=[...snapshot.commits,...snapshot.payloads].map(canonicalBase64);this.metrics.validatedBytes+=inventory.size;await step('load-after');
   let body:any;let ranges:any[]=[];
   if(batch){
    await step('plan-before');spend(CPR_WORK.plan);this.metrics.plans++;
    const start=o.planEvents===false?0:performance.now();
    const p=pack(c,inventory.rows,q.payload.plan.seed,q.payload.transferId,gate,undefined,{variant:o.variant,actor:'provider',witness:{call:this.metrics.calls,requestDigest:q.requestDigest,batchOrdinal:q.payload.plan.batchOrdinal}});
    const ms=o.planEvents===false?0:performance.now()-start;this.metrics.planMs+=ms;
    if(o.planEvents!==false)this.plans.push({requestDigest:q.requestDigest,batchOrdinal:q.payload.plan.batchOrdinal,call:this.metrics.calls,inventoryDigest:inventory.digest,inputDigest:digest(inventory.rows),planDigest:p.planDigest,commands:p.commands.length,work:p.workUnits+p.stats.arithmeticTrials,ms});
    need(p.workUnits+p.stats.arithmeticTrials<=CPR_WORK.plan,'planner_work_bound');
    need(same(p.commands[q.payload.plan.batchOrdinal],q),'plan_mismatch');await step('plan-after');
    row.state='verified';ranges=q.payload.ranges;
   }else if(q.api==='aux.ReadSourceDescriptor'){
    row.state='verified';body={metadata:snapshot.metadata,inventory:{sha256:sha(ib),byteLength:ib.length},inventoryDigest:inventory.digest,entries:inventory.rows.length,sourceBytes:inventory.size};
   }else{
    const p=q.payload,isInventory=p.kind==='inventory';
    const entry=isInventory?{kind:'inventory',index:0,sha256:sha(ib),byteLength:ib.length}:inventory.rows.find(e=>e.kind===p.kind&&e.index===p.index);
    need(entry&&(!isInventory||p.index===0)&&p.offset<entry.byteLength,'range_invalid');
    const length=Math.min(p.maxBytes,entry.byteLength-p.offset);
    // Scalar control uses one exact, non-overlapping maximal chunk, not arbitrary packing.
    need(p.maxBytes===length,'range_invalid');row.state='verified';
    const bytes=isInventory?ib:data[inventory.rows.findIndex(e=>e.kind===p.kind&&e.index===p.index)]!;
    const b=Buffer.from(bytes.subarray(p.offset,p.offset+length));
    body={snapshot:c.snapshot,inventoryDigest:inventory.digest,transferId:p.transferId,entry,offset:p.offset,totalBytes:entry.byteLength,bytes:b.toString('base64'),sha256:sha(b)};
   }
   const parts=ranges.map(r=>{gate();const i=inventory.rows.findIndex(e=>e.kind===r.kind&&e.index===r.index);need(i>=0,'source_integrity');return Buffer.from(data![i]!.subarray(r.offset,r.offset+r.length));});
   this.metrics.parts+=batch?parts.length:q.api==='aux.ReadSealedSource'?1:0;await step('parts-after');
   await step('post-before');this.metrics.post++;o.live();await step('post-after');
   await step('sign-before');need(row.state==='verified','lease_state');spend(CPR_WORK.finish);
   const value=batch?result(c,q as CprCommand,parts):parsed(sourceResultSchema,{schema:'osv-mcp.q2.c3b.source-result.v1',api:q.api.slice(4),lineage:c.lineage,requestDigest:q.requestDigest,operationKey:sourceOperationKey(q),mode:'observed',result:body,live:false});
   // Actual provider key only. No caller's private key, map or plan handle is held here.
   o.mutateResult?.(value);
   const reply=batch?owner(c,'reply',value,o.privateKey):signScalar(c,q.api,value,o.privateKey);
   need(reply.length<=8192,'wire_budget');spend(0,reply.length);await step('enqueue-before');row.state='complete';this.metrics.replies++;return reply;
  }catch(error){
   if(row&&this.#rows.get(row.k)===row&&['admitted','verified'].includes(row.state)){
    row.state=o.now()>=row.deadline?'retired':error instanceof CurrentControlError?'refused':'unknown';
   }throw error;
  }finally{snapshot=undefined;data=undefined;this.#busy=false;}
 }
}
import {sign} from 'node:crypto';
function signScalar(c:CprContext,api:string,body:unknown,key:KeyObject){const payload={schema:'osv-mcp.q2.c3b.owner-envelope.v1',identity:c.provider,keyId:c.replyKeyId,direction:'reply',domain:'aux',api,body};return Buffer.from(canonical({...payload,signature:sign(null,Buffer.from(canonical(payload)),key).toString('base64')}));}
