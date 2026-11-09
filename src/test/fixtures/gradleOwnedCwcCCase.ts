/** CWC-C limited in-process connection. Mock pin/store, independently pinned code approval, real session. */
import {z} from 'zod';
import {type CredentialRegistry} from './gradleOwnedCprBOwners.js';
import {SessionClient,SessionServer,SessionBootQuota,verifiedServiceOutcome,type PeerChannel,type SessionPacket} from './gradleOwnedCprBSession.js';
import {ServiceContextFloor} from './gradleOwnedCprBProtocol.js';
import {serviceContractFixture,serviceTestKeys} from './gradleOwnedServiceContract.js';
import {i0Case} from './gradleOwnedCgpI0Case.js';
import {CwcCProvider,type CprBMode,type CprBPhase} from './gradleOwnedCwcCProvider.js';
import {context,same,keys,cprEntry,type CprCommand} from './gradleOwnedCprASchema.js';
import {pack} from './gradleOwnedCwcCPlanner.js';
import {checkResult} from './gradleOwnedCprAWire.js';
import {makeSourceCommand,sourceOperationKey,sourceBundleSchema,sourceMetadataSchema,sourceChunkSchema,inventoryManifestSchema} from '../../utils/gradleOwnedSourceSchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as digest,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,decodeCurrent,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';

import {CWC_C_POLICY,cwcCMemory,CwcCReadScope,CwcCWorkLedger,type CwcCApprovalRegistry} from './gradleOwnedCwcC.js';
import {type PlannerVariant} from './gradleOwnedCwcCPlanner.js';
type Command=ReturnType<typeof makeSourceCommand>|CprCommand;
export type CwcCOptions={codeApproval:CwcCApprovalRegistry;memory?:number;comparisonProfile?:boolean;referenceOracle?:boolean;variant?:PlannerVariant;sizes?:number[];role?:'reader'|'authority-broker';realClock?:boolean;
 hook?:(phase:CprBPhase)=>void|Promise<void>;work?:number;wireBudget?:number;
 planEvents?:boolean;dropReplyOnce?:boolean;mutateResult?:(body:any)=>void;mutatePacket?:(packet:SessionPacket)=>SessionPacket;denyPermission?:boolean};
const descriptorSchema=z.object({metadata:sourceMetadataSchema,inventory:z.object({sha256:z.string(),byteLength:z.number().int().positive().max(4096)}).strict(),inventoryDigest:z.string(),entries:z.number().int().min(5).max(9),sourceBytes:z.number().int().positive().max(41460)}).strict();
export function cwcCCase(mode:CprBMode,options:CwcCOptions){
 options.codeApproval.assertCurrent();
 need(['reference','max-first','single-check','combined'].includes(options.variant??'reference')&&['S-scoped','B-independent'].includes(mode)&&Number.isSafeInteger(options.wireBudget??67108864)&&(options.wireBudget??67108864)>0&&(options.wireBudget??67108864)<=67108864,'configuration_invalid');
 const f=i0Case('B*',options.sizes),role=options.role??'reader',peer=f.identity(role),base=serviceContractFixture();
 const registry:CredentialRegistry=structuredClone(base.registry);registry.profileDigest=f.lineage.profileDigest;registry.enrollmentDigest=f.lineage.enrollmentDigest;
 const apis=['aux.ReadSourceRanges','aux.ReadSealedSource','aux.ReadSourceDescriptor'];
 for(const credential of registry.credentials){for(const p of credential.permissions)p.lineage=structuredClone(f.lineage);
  if([peer.credentialId,'provider-reply'].includes(credential.identity.credentialId))for(const api of apis)
   if(!credential.permissions.some(p=>p.api===api))credential.permissions.push({api,purpose:'read',lineage:structuredClone(f.lineage),delegateInstance:credential.direction==='request'?'provider':null});
 }
 if(options.denyPermission){const p=registry.credentials.find(c=>c.identity.credentialId===peer.credentialId)!;p.permissions=p.permissions.filter(x=>x.api!=='aux.ReadSourceRanges');}
 const pins={...base.pins(),registryDigest:digest(registry),profileDigest:registry.profileDigest,enrollmentDigest:registry.enrollmentDigest};
 const ctx=context({catalog:f.lineage.profileDigest,manifest:digest({schema:'cwc-c.approved-variant.v1',sourceApproval:options.codeApproval.digest,policy:digest(CWC_C_POLICY),mode,variant:options.variant??'reference',guard:'retained-512-2',observer:options.planEvents===false?'quiet-plan-events':'observed-plan-events',source:'mock-owned',comparisonProfile:options.comparisonProfile??false,codec:options.referenceOracle?'cwc-reference':'cpr-b-v3'}),registryDigest:pins.registryDigest,deploymentDigest:registry.deploymentDigest,endpointId:registry.credentials.find(x=>x.identity.credentialId==='provider-reply')!.endpointId!,requestKeyId:registry.credentials.find(x=>x.identity.credentialId===peer.credentialId)!.keyId,replyKeyId:registry.credentials.find(x=>x.identity.credentialId==='provider-reply')!.keyId,peer,provider:f.server,...(role==='authority-broker'?{origin:f.reader}:{}),lineage:f.lineage,binding:f.binding,snapshot:f.snapshot,checkpoint:f.checkpoint,pin:f.pin,metadataDigest:digest(f.metadata),inventoryDigest:f.inventoryPin.inventoryDigest});
 if(options.comparisonProfile)need(cwcCMemory(ctx).reserved+81920<=(options.memory??1048576),'codec_budget_exceeded');
 // The assembly distributes public pins, then gives each actor disjoint private state.
 const clientContext=structuredClone(ctx),providerContext=structuredClone(ctx);
 const mockSaved={metadataDigest:ctx.metadataDigest,inventoryDigest:ctx.inventoryDigest,inventorySha256:f.inventoryPin.ref.sha256,inventoryBytes:f.inventory.length,sourceBytes:f.inventoryPin.sourceBytes,entries:f.entries.length};
 let store=sourceBundleSchema.parse({schema:'osv-mcp.q2.c3b.source-bundle.v1',metadata:f.metadata,commits:[f.data[0]!.toString('base64')],payloads:f.data.slice(1).map(b=>b.toString('base64'))});
 let time=0,live=true,open=true,policy=true,revoked=false,hook=options.hook,drops=options.dropReplyOnce?1:0;
 const clock=options.realClock?()=>Math.floor(performance.now()):()=>time;
 const parentDeadline=clock()+4500;
 const current=()=>{options.codeApproval.assertCurrent();need(open,'owner_closed');need(policy,'policy_changed');need(!revoked,'permission_denied');need(clock()<parentDeadline,'request_expired');};
 const environment={now:clock,assertOpen:()=>{options.codeApproval.assertCurrent();need(open&&policy,'owner_closed');},credentialCurrent:()=>!revoked};
 const provider=new CwcCProvider({codeApproval:options.codeApproval,memory:options.memory,referenceOracle:options.referenceOracle,variant:options.variant??'reference',mode,context:providerContext,registry:structuredClone(registry),privateKey:serviceTestKeys['provider-reply']!.privateKey,now:clock,deadline:parentDeadline,current,live:()=>need(live,'pin_revoked'),read:()=>store,expected:mockSaved,work:options.work,planEvents:options.planEvents,mutateResult:options.mutateResult,hook:phase=>hook?.(phase)});
 let channel:PeerChannel|undefined;
 const server=new SessionServer({registry:structuredClone(registry),pins,credentialId:'provider-reply',privateKey:serviceTestKeys['provider-reply']!.privateKey,lineage:f.lineage,environment,business:{outcomes:true,apis,purpose:()=> 'read'}},async()=>[],(wire,call)=>provider.execute(wire,call));
 const frames:{direction:string;kind:string;api:string|null;inner:number;frame:number;operation:string|null}[]=[];
 const clientRows=new Map<string,{k:string;d:string;deadline:number;attempts:number;wire:number;state:string}>();
 const clientBounds=new Map<string,ReturnType<typeof pack>['bounds'][number]>();let activeBound:ReturnType<typeof pack>['bounds'][number]|undefined;
 let active:ReturnType<typeof clientRows.get>,totalWire=0,clientPlans=0,clientPlanMs=0,sealMs=0,clientWork={work:0},clientPlanDigest:string|null=null;
 const approved=new Map<string,Command>();const codecPlans:any[]=[];let clientScope:CwcCReadScope|undefined,clientInitial:ReturnType<typeof pack>['connection']|undefined,clientSeal:ReturnType<typeof pack>['connection']|undefined;
 const charge=(packet:SessionPacket,direction:string)=>{
  current();const body:any=decodeCurrent(packet.wire),kind=body.body.kind;
  need(packet.wire.length<=16384&&(!packet.inner||packet.inner.length<=8192),'wire_budget');
  if(activeBound&&body.body.api==='aux.ReadSourceRanges'){
   const index=kind==='challenge-request'?0:kind==='challenge'?1:direction==='request'?2:3;
   need(packet.wire.length<=activeBound.frames[index]!&&(!packet.inner||packet.inner.length<=(direction==='request'?activeBound.request:activeBound.reply)),'layout_mismatch');
  }
  const n=packet.wire.length+(packet.inner?.length??0);
  need(totalWire+n<=(options.wireBudget??67108864),'wire_budget');
  if(body.body.api){need(active&&clock()<active.deadline,'request_expired');need(active.wire+n<=163840,'operation_budget');
   if(direction==='request'&&kind==='challenge-request'){need(active.attempts<2,'operation_budget');active.attempts++;}
   active.wire+=n;
  }
  totalWire+=n;frames.push({direction,kind,api:body.body.api??null,inner:packet.inner?.length??0,frame:packet.wire.length,operation:active?.k??null});
 };
 const client=new SessionClient({registry:structuredClone(registry),pins,credentialId:peer.credentialId,privateKey:serviceTestKeys[peer.credentialId]!.privateKey,lineage:f.lineage,environment,business:{outcomes:true,apis,purpose:()=> 'read'}},'provider-reply',{
  async open(){channel=server.openPeer(peer.credentialId,{mode:'synthetic-local-process',credentialId:peer.credentialId,instanceId:peer.instanceId,boot:peer.boot});},
  async exchange(original){const packet=options.mutatePacket?.(original)??original;charge(packet,'request');const reply=await server.receive(channel!,packet);charge(reply,'reply');
   if(drops>0&&packet.inner){drops--;throw new CurrentControlError('response_lost');}return reply;},
  close(){if(channel){server.closePeer(channel);channel=undefined;}}
 },new SessionBootQuota(peer),new ServiceContextFloor(f.lineage));
 const freeze=(v:any):void=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(client.registry);freeze(server.registry);
 const rootPayload=()=>({snapshot:clientContext.snapshot,checkpoint:clientContext.checkpoint,pin:clientContext.pin});
 const approve=(q:Command)=>{approved.set(q.requestDigest,structuredClone(q));return q;};
 function scalar(kind:'inventory'|'commit'|'payload',index:number,offset:number,maxBytes:number,id:string,transferId:string){return makeSourceCommand({api:'aux.ReadSealedSource',operationId:digest({domain:'cpr-b.scalar-operation',id,kind,index,offset}),peer:clientContext.peer,lineage:clientContext.lineage,binding:clientContext.binding,payload:{...rootPayload(),...(clientContext.origin?{origin:clientContext.origin}:{}),kind,index,offset,maxBytes,transferId}});}
 async function send(q:Command,unapproved=false){
  need(!active,'busy');current();need(totalWire+163840+131072<=(options.wireBudget??67108864),'wire_budget');need(unapproved||same(approved.get(q.requestDigest),q),'client_plan_unapproved');
  const kd=q.api==='aux.ReadSourceRanges'?keys(clientContext,q as CprCommand):{k:sourceOperationKey(q as any),d:digest({request:q.requestDigest,manifest:clientContext.manifest})};
  const old=clientRows.get(kd.k),row=old??{...kd,deadline:parentDeadline,attempts:0,wire:0,state:'new'};
  need(row.d===kd.d,'intent_conflict');need(!['active','unknown'].includes(row.state),'operation_busy');need(clock()<row.deadline&&row.attempts<2,'operation_budget');need(old||clientRows.size<512,'slot_budget');
  clientRows.set(kd.k,row);active=row;activeBound=clientBounds.get(q.requestDigest);row.state='active';
  try{if(q.api==='aux.ReadSourceRanges'){need(clientSeal,'client_plan_unapproved');const ordinal=(q as CprCommand).payload.plan.batchOrdinal;const fact=clientSeal.owner.readClientCommandFact(clientSeal.scope,clientSeal.facts[ordinal]!,ordinal);need(fact.toString()===canonical(q),'client_plan_unapproved');}const wire=client.signBusinessCommand(q),body:any=await client.execute(client.prepareBusiness(q.api,wire,row.deadline));current();need(clock()<row.deadline,'request_expired');
   if(q.api==='aux.ReadSourceRanges'){
    const ranges=(q as CprCommand).payload.ranges,parts=checkResult(clientContext,q as CprCommand,body);
    parts.forEach((b,i)=>{const r=ranges[i]!;need(r.offset!==0||r.length!==r.entry.byteLength||sha(b)===r.entry.sha256,'binding_mismatch');});
   }
   else{
    need(body.requestDigest===q.requestDigest&&body.operationKey===sourceOperationKey(q as any)&&same(body.lineage,clientContext.lineage)&&body.mode==='observed'&&body.live===false,'binding_mismatch');
    if(q.api==='aux.ReadSourceDescriptor')checkDescriptor(body.result);
    else{
     const p=q.payload as any,entry=p.kind==='inventory'?{kind:'inventory',index:0,sha256:mockSaved.inventorySha256,byteLength:mockSaved.inventoryBytes}:clientInventory?.find(e=>e.kind===p.kind&&e.index===p.index);
     need(entry,'inventory_invalid');checkChunk(q,body,entry);
    }
   }
   current();need(clock()<row.deadline,'request_expired');row.state='complete';return body;
  }catch(e){row.state=verifiedServiceOutcome(e)?.outcome==='refused'?'refused':'unknown';throw e;}finally{active=undefined;activeBound=undefined;}
 }
 function checkChunk(q:any,body:any,entry:{kind:string;index:number;sha256:string;byteLength:number}){
  const part=parsed(sourceChunkSchema,body.result),bytes=Buffer.from(part.bytes,'base64');
  need(same(part.snapshot,clientContext.snapshot)&&part.inventoryDigest===clientContext.inventoryDigest&&part.transferId===q.payload.transferId&&same(part.entry,entry)&&part.offset===q.payload.offset&&part.totalBytes===entry.byteLength&&bytes.length===q.payload.maxBytes&&sha(bytes)===part.sha256&&bytes.toString('base64')===part.bytes,'binding_mismatch');need(q.payload.offset!==0||q.payload.maxBytes!==entry.byteLength||sha(bytes)===entry.sha256,'binding_mismatch');return bytes;
 }
 let descriptorMetadata:unknown;
 let clientInventory:ReturnType<typeof cprEntry.parse>[]|undefined;
 function checkDescriptor(value:unknown){
  const descriptor=parsed(descriptorSchema,value);
  need(digest(descriptor.metadata)===clientContext.metadataDigest&&descriptor.inventoryDigest===clientContext.inventoryDigest&&descriptor.inventory.sha256===mockSaved.inventorySha256&&descriptor.inventory.byteLength===mockSaved.inventoryBytes&&descriptor.entries===mockSaved.entries&&descriptor.sourceBytes===mockSaved.sourceBytes,'inventory_invalid');return descriptor;
 }
 async function inventory(id:string){
  current();const q=approve(makeSourceCommand({api:'aux.ReadSourceDescriptor',operationId:digest({id,api:'descriptor'}),peer:clientContext.peer,lineage:clientContext.lineage,binding:clientContext.binding,payload:rootPayload()}));
  const descriptor=checkDescriptor((await send(q)).result);descriptorMetadata=descriptor.metadata;
  const chunks=[];for(let offset=0;offset<descriptor.inventory.byteLength;offset+=4096){const request=approve(scalar('inventory',0,offset,Math.min(4096,descriptor.inventory.byteLength-offset),id+'-inventory','inventory'));
   chunks.push(checkChunk(request,await send(request),{kind:'inventory',index:0,...descriptor.inventory}));}
  const bytes=Buffer.concat(chunks);need(bytes.length===descriptor.inventory.byteLength&&sha(bytes)===descriptor.inventory.sha256,'inventory_invalid');
  const inv=parsed(inventoryManifestSchema,decodeCurrent(bytes,4096)),entries=inv.entries.map(e=>parsed(cprEntry,e));
  need(inv.metadataDigest===clientContext.metadataDigest&&entries.length===descriptor.entries&&entries.reduce((n,e)=>n+e.byteLength,0)===descriptor.sourceBytes&&digest({domain:'c3b-source-inventory-v1',metadata:descriptor.metadata,entries})===clientContext.inventoryDigest,'inventory_invalid');current();clientInventory=entries;return entries;
 }
 async function commands(id='transfer'){
  need(!active,'busy');clientInitial?.owner.close();clientSeal?.owner.close();clientScope?.close();clientScope=new CwcCReadScope({registry:options.codeApproval,context:clientContext,gate:current,now:clock,deadline:parentDeadline});need(clientScope.memory.reserved<=(options.memory??1048576),'codec_budget_exceeded');const entries=await inventory(id);current();clientScope.clientSnapshot(descriptorMetadata!,entries);
  if(mode==='S-scoped')return entries.flatMap(e=>{const out:Command[]=[];for(let offset=0;offset<e.byteLength;offset+=4096)out.push(approve(scalar(e.kind,e.index,offset,Math.min(4096,e.byteLength-offset),id,'transfer')));return out;});
  need(clientWork.work+2*156978<=67108864,'operation_budget');const ledger=new CwcCWorkLedger(clientWork,67108864,current);const initialGrant=clientScope.grant('client-initial',clientScope.reservePlan('client-initial',ledger));const initialApproval=clientScope.approval('client-initial');
  let start=performance.now();const p=pack(clientContext,entries,id,'transfer',current,undefined,{variant:options.variant??'reference',actor:'client-initial'},{referenceOracle:options.referenceOracle,grant:initialGrant,approval:initialApproval.approval,pin:initialApproval.pin,now:clock});clientInitial=p.connection;initialGrant.finish(p.connection.owner,p.connection.root);const initialEvidence=p.connection.owner.registerInitialPlan(p.connection.root);codecPlans.push({actor:'client-initial',referenceOracleCalls:p.connection.referenceOracleCalls,grant:initialGrant.diagnostics,codec:p.connection.codec.diagnostics,helper:p.connection.owner.metrics,stats:p.stats});p.connection.owner.disposeCodecRoot(p.connection.root);p.connection.codec.close();clientPlanMs+=performance.now()-start;clientPlans++;
  const sealGrant=clientScope.grant('client-seal',clientScope.reservePlan('client-seal',ledger)),sealApproval=clientScope.approval('client-seal');start=performance.now();const sealed=pack(clientContext,entries,id,'transfer',current,undefined,{variant:options.variant??'reference',actor:'client-seal'},{referenceOracle:options.referenceOracle,grant:sealGrant,approval:sealApproval.approval,pin:sealApproval.pin,now:clock,initial:initialEvidence});clientSeal=sealed.connection;sealGrant.finish(sealed.connection.owner,sealed.connection.root);sealed.connection.owner.verifyClientSeal(sealed.connection.root,initialEvidence);for(const fact of sealed.connection.facts)sealed.connection.owner.retainClientCommandFact(sealed.connection.root,fact);codecPlans.push({actor:'client-seal',referenceOracleCalls:sealed.connection.referenceOracleCalls,grant:sealGrant.diagnostics,codec:sealed.connection.codec.diagnostics,helper:sealed.connection.owner.metrics,stats:sealed.stats});sealed.connection.owner.disposeCodecRoot(sealed.connection.root);sealed.connection.codec.close();sealMs+=performance.now()-start;clientPlans++;
  need(same(p.core,sealed.core)&&same(p.commands,sealed.commands)&&same(p.bounds,sealed.bounds)&&p.workUnits===sealed.workUnits&&p.wireBytes===sealed.wireBytes,'plan_mismatch');clientPlanDigest=sealed.planDigest;for(const [i,q] of sealed.commands.entries()){approve(q);clientBounds.set(q.requestDigest,sealed.bounds[i]!);}return sealed.commands;
 }
 async function transfer(id='transfer'){
  const start=performance.now(),frameStart=frames.length,providerPlanStart=provider.metrics.planMs;
  const qs=await commands(id),planned=performance.now();
  // Reserve all exchanges before the data transfer, including possible retry and handshake.
  need(totalWire+qs.length*(163840+131072)<=(options.wireBudget??67108864),'wire_budget');
  const chunks=new Map<string,Buffer[]>();for(const q of qs){const body=await send(q);const parts=q.api==='aux.ReadSourceRanges'?checkResult(clientContext,q as CprCommand,body):[checkChunk(q,body,clientInventory!.find(e=>e.kind===(q.payload as any).kind&&e.index===(q.payload as any).index)!)];
   for(const [i,bytes]of parts.entries()){const r=q.api==='aux.ReadSourceRanges'?(q as CprCommand).payload.ranges[i]!:(q.payload as any),key=r.kind+':'+r.index,list=chunks.get(key)??[];list.push(bytes);chunks.set(key,list);}}
  const reconstructionStarted=performance.now();
  const output=clientInventory!.map(e=>{const b=Buffer.concat(chunks.get(e.kind+':'+e.index)??[]);need(b.length===e.byteLength&&sha(b)===e.sha256,'source_integrity');return sha(b);});
  const outputDigest=digest(output),inputDigest=digest(clientInventory),wireBytes=frames.slice(frameStart).reduce((n,f)=>n+f.frame+f.inner,0);
  current();const end=performance.now();return {mode,timing:{start,planned,reconstructionStarted,end},finalizationMs:end-reconstructionStarted,wallMs:end-start,setupAndClientPlanMs:planned-start,dispatchAndReconstructionMs:end-planned,clientPlanMs,sealMs,providerPlanMs:provider.metrics.planMs-providerPlanStart,requests:qs.length,clientPlans,providerPlans:provider.metrics.plans,wireBytes,outputDigest,inventoryDigest:clientContext.inventoryDigest,inputDigest,planDigest:clientPlanDigest};
 }
 return {mode,transfer,commands,codecPlans,get clientWork(){return clientWork.work;},get liveCodecState(){return {initial:clientInitial?.grant.diagnostics,seal:clientSeal?.grant.diagnostics};},run:(q:Command)=>send(q),sendUnapprovedForTest:(q:Command)=>send(q,true),client,server,provider,frames,
  get clientRows(){return structuredClone([...clientRows.values()]);},get ctx(){return structuredClone(clientContext);},get source(){return store;},
  dropNextReplies(n:number){drops=n;},setNow(n:number){time=n;},setHook(h:typeof hook){hook=h;},cancel(){live=false;},revoke(){revoked=true;},changePolicy(){policy=false;},
  close(){clientInitial?.owner.close();clientSeal?.owner.close();clientScope?.close();client.close();server.close();open=false;store=undefined as any;},parentDeadline};
}
