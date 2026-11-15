/** PB0 closed metadata graph validation; refs are claims, not external durability witnesses. */
import {z} from 'zod';
import {canonicalOwnedJson as canonical,ownedSha256,ownedDigest} from './gradleOwnedJson.js';
import {pb0Decode,pb0Need,pb0RefSchema as ref,pb0JobDescriptorSchema,pb0EpochVectorSchema,pb0SubjectSchema,pb0OriginSchema,PB0_JOB_STATES,PB0_READ_POLICY,pb0ParseRequest} from './gradleOwnedP0StateContract.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),n=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const refs=z.array(ref).max(128).refine(a=>new Set(a.map(x=>x.id)).size===a.length,'duplicate-refs');
const counters=z.object({calls:n,wireBytes:n,work:n}).strict();
const base={schema:z.literal('cwc.e2-p0.pb0-record.v1'),id,realmId:id};
const node=<K extends string,S extends z.ZodType>(kind:K,value:S)=>z.object({...base,kind:z.literal(kind),value}).strict();
export const pb0RecordSchema=z.discriminatedUnion('kind',[
 node('source-facts',z.object({subjectDigest:hash,artifactDigest:hash}).strict()),
 node('job',pb0JobDescriptorSchema),
 node('approval',z.object({approvalKind:z.enum(['method','environment']),subjectDigest:hash,profileDigest:hash,approvalEnvelopeRef:ref}).strict()),
 node('reservation',z.object({jobRef:ref,priorPinRef:ref.nullable(),capacityDigest:hash}).strict()),
 node('current-pin',z.object({jobRef:ref,approvalRefs:z.array(ref).length(2),custodyRef:ref,reservationRefs:refs,predecessorRef:ref.nullable(),epochVector:pb0EpochVectorSchema,selectionRevision:n.positive()}).strict()),
 node('preflight',z.object({jobRef:ref,pinRef:ref,reservationRefs:refs,phase:z.enum(['reserved','copied','sealed']),metadataDigest:hash}).strict()),
 node('reader-grant',z.object({jobRef:ref,pinRef:ref,preflightRef:ref.nullable(),credential:id,keyEpoch:n.positive(),spkiDigest:hash,
  apiSet:z.array(z.enum(['ReadPins','ReadAcquisition','ReadPreflight','ReadLive'])).min(1).max(4),purposeSet:z.array(id).min(1).max(4),sourceRefs:refs,
  authRevision:n.positive(),selectionRevision:n.positive(),epochVectorDigest:hash,workflowLimit:n.positive().max(4),originalDeadline:n,issuer:id,keyId:id}).strict()),
 node('init-descriptor',z.object({initId:id,jobRef:ref,beginControlKey:hash,t0:n,originalDeadline:n,reservationRefs:refs}).strict()),
 node('init-seal',z.object({descriptorRef:ref,beginControlKey:hash,controlIntentDigest:hash}).strict()),
 node('workflow',z.object({workflowId:id,jobRef:ref,grantRef:ref,initSealRef:ref,originalDeadline:n,ticketRefs:z.array(ref).length(8),reservationRefs:refs}).strict()),
 node('response-body',z.object({requestDigest:hash,jobRef:ref,workflowRef:ref,sourceRefs:refs,bodyDigest:hash}).strict()),
 node('response-ready',z.object({responseBodyRef:ref,workflowRef:ref,consumption:counters}).strict()),
 node('response-may-have-escaped',z.object({responseReadyRef:ref,mayHaveEscaped:z.literal(true)}).strict()),
 node('delivery',z.object({escapeRef:ref,requestDigest:hash,nonce:hash,serverBoot:hash,deliveryEnvelopeDigest:hash}).strict()),
 node('auth-state',z.discriminatedUnion('kind',[
  z.object({kind:z.literal('job'),jobRef:ref,revision:n.positive(),authRevision:n.positive(),state:z.enum(PB0_JOB_STATES),revokedGrantIds:z.array(id).max(64)}).strict(),
  z.object({kind:z.literal('realm'),revision:n.positive(),revocationRevision:n}).strict()
 ])),
 node('owner-journal',z.object({ownerId:id,ownerRole:z.enum(['registry','custodian','controller']),storageEpoch:hash,ownerRevision:n.positive(),previousRef:ref.nullable(),
  operationDomain:z.enum(['metadata-read','control']),targetSubject:pb0SubjectSchema,authStateRef:ref,operationKey:hash,intentDigest:hash,stageId:id,transitionDigest:hash,payloadRef:ref,consumptionDelta:counters}).strict()),
 node('epoch-anchor',z.object({anchorRevision:n.positive(),previousRef:ref.nullable(),epochVector:pb0EpochVectorSchema,currentPinRef:ref.nullable(),revocationRevision:n,
  headRefs:z.object({registry:ref,custodian:ref,controller:ref}).strict()}).strict()),
 node('adoption',z.object({anchorRef:ref,headRef:ref}).strict()),
 node('origin-tombstone',z.object({originDomain:z.enum(['metadata-read','control']),owner:z.enum(['registry','custodian','controller','epoch-anchor']),subject:pb0SubjectSchema,operationKey:hash}).strict()),
 node('tombstone-receipt',z.object({tombstoneRef:ref,anchorRef:ref,adoptionRef:ref}).strict()),
 node('replay',z.object({origin:pb0OriginSchema,stage:z.enum(['intent-reserved','source-captured','response-ready','response-may-have-escaped','failed-or-unknown','historical']),receiptRef:ref.nullable(),capturedRefs:refs,originalDeadline:n}).strict()),
 node('debt',z.object({jobRef:ref,workflowRef:ref,originalEpochVector:pb0EpochVectorSchema,reservationRefs:refs,heldCapacity:n,spentCounters:counters,unknownEffectFloor:counters,pendingWriteRefs:refs,sourceCaptureRefs:refs,replyReadyRef:ref.nullable(),fenceRefs:refs,drainRefs:refs,reconciliationRef:ref.nullable()}).strict()),
 node('control-debt',z.object({ownerId:id,targetSubject:pb0SubjectSchema,controlOperationKey:hash,controlIntentDigest:hash,
  budget:z.discriminatedUnion('kind',[z.object({kind:z.literal('init'),initAdmissionRef:ref}).strict(),z.object({kind:z.literal('maintenance'),maintenanceRef:ref}).strict()]),
  reservationRefs:refs,heldCapacity:n,spentCounters:counters,unknownEffectFloor:counters,fenceRefs:refs,drainRefs:refs,reconciliationRef:ref.nullable(),joinedWorkflowRef:ref.nullable()}).strict())
]);
type RecordNode=z.infer<typeof pb0RecordSchema>;type Ref=z.infer<typeof ref>;
const bundle=z.object({schema:z.literal('cwc.e2-p0.pb0-bundle.v1'),realmId:id,roots:z.array(ref).min(1).max(256),nodes:z.array(pb0RecordSchema).min(1).max(256)}).strict();
function reference(r:RecordNode){const wire=canonical(r,1048576);return {id:r.id,sha256:ownedSha256(wire),byteLength:Buffer.byteLength(wire)};}
export function pb0RecordRef(wire:string){return reference(pb0Decode(pb0RecordSchema,wire));}
function edges(value:unknown,path:string[]=[],out:{ref:Ref;path:string[]}[]=[]){
 if(!value||typeof value!=='object')return out;
 if('id' in value&&'sha256' in value&&'byteLength' in value){out.push({ref:value as Ref,path});return out;}
 for(const [k,v]of Object.entries(value))edges(v,[...path,k],out);return out;
}
const fieldKinds:Readonly<Record<string,readonly string[]>>={jobRef:['job'],approvalEnvelopeRef:['source-facts'],approvalRefs:['approval'],custodyRef:['source-facts'],reservationRefs:['reservation'],priorPinRef:['current-pin'],predecessorRef:['current-pin'],pinRef:['current-pin'],currentPinRef:['current-pin'],preflightRef:['preflight'],sourceRefs:['source-facts'],grantRef:['reader-grant'],descriptorRef:['init-descriptor'],initSealRef:['init-seal'],initAdmissionRef:['init-descriptor'],maintenanceRef:['source-facts'],ticketRefs:['source-facts'],workflowRef:['workflow'],joinedWorkflowRef:['workflow'],responseBodyRef:['response-body'],responseReadyRef:['response-ready'],replyReadyRef:['response-ready'],escapeRef:['response-may-have-escaped'],authStateRef:['auth-state'],headRef:['owner-journal'],headRefs:['owner-journal'],anchorRef:['epoch-anchor'],adoptionRef:['adoption'],tombstoneRef:['origin-tombstone'],receiptRef:['response-ready','response-may-have-escaped','adoption','tombstone-receipt'],capturedRefs:['source-facts'],sourceCaptureRefs:['source-facts'],pendingWriteRefs:['owner-journal'],fenceRefs:['source-facts'],drainRefs:['source-facts'],reconciliationRef:['source-facts']};
export function pb0ValidateBundle(wire:string){
 const b=pb0Decode(bundle,wire),map=new Map(b.nodes.map(n=>[n.id,n]));pb0Need(map.size===b.nodes.length,'duplicate-record');
 const links=new Map(b.nodes.map(n=>[n.id,edges(n.value)])),totalRefs=b.roots.length+[...links.values()].reduce((s,a)=>s+a.length,0);pb0Need(totalRefs<=256,'bundle-ref-budget');
 const active=new Set<string>(),seen=new Set<string>();
 function walk(id:string){pb0Need(!active.has(id),'reference-cycle');if(seen.has(id))return;pb0Need(map.has(id),'reference-missing');active.add(id);
  for(const e of links.get(id)!)walk(e.ref.id);active.delete(id);seen.add(id);}
 pb0Need(new Set(b.roots.map(r=>r.id)).size===b.roots.length,'duplicate-root');for(const r of b.roots)walk(r.id);pb0Need(seen.size===map.size,'unreachable-record');
 function exact(r:Ref){const node=map.get(r.id);pb0Need(node,'reference-missing');const actual=reference(node);pb0Need(r.sha256===actual.sha256&&r.byteLength===actual.byteLength,'reference-content');return node;}
 for(const r of b.roots)exact(r);
 const sealed=new Set<string>(),workflowIdentities=new Set<string>(),claimedInits=new Set<string>(),ticketOwners=new Map<string,string>(),grantWorkflowCounts=new Map<string,number>();
 for(const n of b.nodes){
  pb0Need(n.realmId===b.realmId,'record-realm');
  for(const e of links.get(n.id)!){const target=exact(e.ref);let allowed=e.path.map(k=>Object.hasOwn(fieldKinds,k)?fieldKinds[k]:undefined).find(Boolean);
   if(e.path[0]==='previousRef')allowed=[n.kind];
   if(e.path[0]==='payloadRef')allowed=['job','source-facts','approval','reservation','current-pin','preflight','reader-grant','workflow','init-descriptor','init-seal','auth-state','origin-tombstone','response-body','response-ready','response-may-have-escaped','debt','control-debt','replay'];
   pb0Need(allowed?.includes(target.kind),'reference-kind');
  }
  if(n.kind==='job')pb0Need(n.value.jobId.realmId===b.realmId,'job-realm');
  for(const s of [n.kind==='control-debt'||n.kind==='owner-journal'?n.value.targetSubject:null,n.kind==='origin-tombstone'?n.value.subject:null,n.kind==='replay'?n.value.origin.subject:null])if(s?.kind==='realm')pb0Need(s.realmId===b.realmId,'subject-realm');
  if(n.kind==='control-debt'&&n.value.targetSubject.kind==='realm')pb0Need(n.value.budget.kind==='maintenance'&&n.value.joinedWorkflowRef===null,'realm-control-debt');
  if(n.kind==='current-pin'){
   pb0Need(new Set(n.value.approvalRefs.map(r=>r.id)).size===2,'approval-duplicate');
   const kinds=n.value.approvalRefs.map(r=>(exact(r) as Extract<RecordNode,{kind:'approval'}>).value.approvalKind);pb0Need(new Set(kinds).size===2,'approval-kinds');
   const job=exact(n.value.jobRef) as Extract<RecordNode,{kind:'job'}>;
   for(const r of n.value.approvalRefs){const a=exact(r) as Extract<RecordNode,{kind:'approval'}>;pb0Need(a.value.subjectDigest===job.value.requestedApprovalSubjects[a.value.approvalKind],'approval-subject');}
   for(const r of n.value.reservationRefs){const v=exact(r) as Extract<RecordNode,{kind:'reservation'}>;pb0Need(v.value.jobRef.sha256===n.value.jobRef.sha256,'reservation-job');}
   if(n.value.predecessorRef){const old=exact(n.value.predecessorRef) as Extract<RecordNode,{kind:'current-pin'}>;pb0Need(n.value.selectionRevision===old.value.selectionRevision+1&&n.value.jobRef.sha256===old.value.jobRef.sha256,'pin-predecessor');}
   else pb0Need(n.value.selectionRevision===1,'initial-pin-revision');
  }
  if(n.kind==='init-descriptor')pb0Need(n.value.originalDeadline>n.value.t0&&n.value.originalDeadline<=n.value.t0+5000,'init-deadline');
  if(n.kind==='init-seal'){
   const d=exact(n.value.descriptorRef) as Extract<RecordNode,{kind:'init-descriptor'}>;
   pb0Need(n.value.beginControlKey===d.value.beginControlKey&&!sealed.has(d.id),'init-seal-binding');sealed.add(d.id);
  }
  if(n.kind==='workflow'){
   pb0Need(new Set(n.value.ticketRefs.map(r=>r.id)).size===8,'ticket-duplicate');
   const seal=exact(n.value.initSealRef) as Extract<RecordNode,{kind:'init-seal'}>,d=exact(seal.value.descriptorRef) as Extract<RecordNode,{kind:'init-descriptor'}>;
   pb0Need(n.value.originalDeadline===d.value.originalDeadline&&n.value.jobRef.sha256===d.value.jobRef.sha256,'workflow-init-binding');
   const grant=exact(n.value.grantRef) as Extract<RecordNode,{kind:'reader-grant'}>;pb0Need(grant.value.jobRef.sha256===n.value.jobRef.sha256&&n.value.originalDeadline<=grant.value.originalDeadline,'workflow-grant-binding');
   const job=exact(n.value.jobRef) as Extract<RecordNode,{kind:'job'}>,jobDigest=ownedDigest(job.value),logicalID=canonical([jobDigest,n.value.workflowId]);
   pb0Need(!workflowIdentities.has(logicalID),'workflow-identity-reused');workflowIdentities.add(logicalID);
   // One immutable workflow per descriptor / seal / logical admission / original Begin operation.
   // These are bundle-local claims; persistence and actual parent ownership remain PB1 / PB2 work.
   for(const key of ['descriptor:'+d.id,'seal:'+seal.id,'init-id:'+canonical([jobDigest,d.value.initId]),'begin:'+d.value.beginControlKey]){
    pb0Need(!claimedInits.has(key),'workflow-init-reused');claimedInits.add(key);
   }
   for(const ticket of n.value.ticketRefs){pb0Need(!ticketOwners.has(ticket.id),'workflow-ticket-reused');ticketOwners.set(ticket.id,n.id);}
   const count=(grantWorkflowCounts.get(grant.id)??0)+1;pb0Need(count<=grant.value.workflowLimit,'grant-workflow-limit');grantWorkflowCounts.set(grant.id,count);
  }
  if(n.kind==='reader-grant'){
   const g=n.value;pb0Need(new Set(g.apiSet).size===g.apiSet.length&&new Set(g.purposeSet).size===g.purposeSet.length,'grant-duplicate');
   pb0Need(canonical([...g.apiSet.map(a=>PB0_READ_POLICY[a].purpose)].sort())===canonical([...g.purposeSet].sort()),'grant-purpose');
   const p=exact(g.pinRef) as Extract<RecordNode,{kind:'current-pin'}>;pb0Need(p.value.jobRef.sha256===g.jobRef.sha256&&g.selectionRevision===p.value.selectionRevision&&g.epochVectorDigest===ownedDigest(p.value.epochVector),'grant-pin-binding');
   if(g.preflightRef){const f=exact(g.preflightRef) as Extract<RecordNode,{kind:'preflight'}>;pb0Need(f.value.jobRef.sha256===g.jobRef.sha256&&f.value.pinRef.sha256===g.pinRef.sha256,'grant-preflight-binding');}
  }
  if(n.kind==='preflight'){const p=exact(n.value.pinRef) as Extract<RecordNode,{kind:'current-pin'}>;pb0Need(p.value.jobRef.sha256===n.value.jobRef.sha256,'preflight-job');for(const r of n.value.reservationRefs){const v=exact(r) as Extract<RecordNode,{kind:'reservation'}>;pb0Need(v.value.jobRef.sha256===n.value.jobRef.sha256,'preflight-reservation-job');}}
  if(n.kind==='response-body'){const w=exact(n.value.workflowRef) as Extract<RecordNode,{kind:'workflow'}>;pb0Need(w.value.jobRef.sha256===n.value.jobRef.sha256,'response-job');}
  if(n.kind==='response-ready'){const body=exact(n.value.responseBodyRef) as Extract<RecordNode,{kind:'response-body'}>;pb0Need(body.value.workflowRef.sha256===n.value.workflowRef.sha256,'ready-workflow');}
  if(n.kind==='owner-journal'){
   const s=n.value.targetSubject,a=exact(n.value.authStateRef) as Extract<RecordNode,{kind:'auth-state'}>;
   pb0Need((n.value.operationDomain==='control'||s.kind==='job')&&a.value.kind===s.kind,'journal-domain-scope');
   if(s.kind==='job'&&a.value.kind==='job'){const j=exact(a.value.jobRef) as Extract<RecordNode,{kind:'job'}>;pb0Need(ownedDigest(j.value)===s.jobDigest,'journal-job');}
   if(n.value.previousRef){const p=exact(n.value.previousRef) as Extract<RecordNode,{kind:'owner-journal'}>;pb0Need(p.value.ownerId===n.value.ownerId&&p.value.ownerRole===n.value.ownerRole&&p.value.storageEpoch===n.value.storageEpoch&&n.value.ownerRevision===p.value.ownerRevision+1,'journal-predecessor');}
   else pb0Need(n.value.ownerRevision===1,'journal-initial-revision');
  }
  if(n.kind==='epoch-anchor'){
   if(n.value.previousRef){const p=exact(n.value.previousRef) as Extract<RecordNode,{kind:'epoch-anchor'}>;pb0Need(n.value.anchorRevision===p.value.anchorRevision+1,'anchor-predecessor');}else pb0Need(n.value.anchorRevision===1,'anchor-initial-revision');
   for(const role of ['registry','custodian','controller'] as const){const h=exact(n.value.headRefs[role]) as Extract<RecordNode,{kind:'owner-journal'}>;pb0Need(h.value.ownerRole===role&&h.value.ownerId===n.value.epochVector[role].principal&&h.value.storageEpoch===n.value.epochVector[role].storageEpoch,'anchor-head-owner');}
  }
 }
 return {schema:'cwc.e2-p0.pb0-graph-result.v1' as const,records:b.nodes.length,refs:totalRefs,jobPermitIssued:false as const,runtimeAdmitted:false as const};
}
/** Join the already sealed Begin request to the immutable descriptor and its separate D seal. No reservation is created. */
export function pb0BindInit(requestWire:string,bundleWire:string){
 const r=pb0ParseRequest(requestWire);pb0Need(r.domain==='cwc.e2-p0.backend-control.v1'&&r.api==='BeginWorkflow'&&r.targetSubject.kind==='job','begin-required');
 pb0ValidateBundle(bundleWire);const b=pb0Decode(bundle,bundleWire),d=b.nodes.find(n=>n.id===r.payload.initAdmissionRef.id);
 pb0Need(d?.kind==='init-descriptor'&&b.realmId===r.realmId,'init-descriptor');
 pb0Need(canonical(reference(d))===canonical(r.payload.initAdmissionRef)&&d.value.beginControlKey===r.operationKey&&d.value.originalDeadline===r.originalControlDeadline,'init-request-binding');
 const job=b.nodes.find(n=>n.id===d.value.jobRef.id);pb0Need(job?.kind==='job'&&ownedDigest(job.value)===r.targetSubject.jobDigest,'init-job-binding');
 const seals=b.nodes.filter(n=>n.kind==='init-seal'&&n.value.descriptorRef.id===d.id);
 pb0Need(seals.length===1&&seals[0]?.kind==='init-seal'&&seals[0].value.controlIntentDigest===r.intentDigest,'init-D-seal');
 return {staticInitBindingVerified:true as const,realReservationVerified:false as const,jobPermitIssued:false as const,runtimeAdmitted:false as const};
}
