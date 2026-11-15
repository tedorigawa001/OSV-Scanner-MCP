/** PB0 static, wire-only contracts. No store, current authority, job admission or IO capability. */
import {z} from 'zod';
import {visit} from 'jsonc-parser';
import {createPublicKey} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as digest,ownedSha256,parseOwnedJson} from './gradleOwnedJson.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=uint.positive();
export const PB0_LIMITS=Object.freeze({request:16384,reply:1048576,queryReply:65536,header:4,parentWire:8388608,
 initCalls:2,metadataCalls:8,initWire:163856,metadataWire:8224752,worstMetadataWire:6553664,worstCombinedWire:6717520,deadlineMs:5000,depth:24,nodes:65536,refs:256});
export const PB0_PROFILE_DIGEST=digest({domain:'cwc.e2-p0.backend-state.v2',contract:'PB0-static-v1',limits:PB0_LIMITS});
const profile=z.literal(PB0_PROFILE_DIGEST),owner=z.enum(['registry','custodian','controller','epoch-anchor']);
export const pb0RefSchema=z.object({id,sha256:hash,byteLength:positive.max(1048576)}).strict();
const refs=z.array(pb0RefSchema).max(128).superRefine((xs,c)=>{if(new Set(xs.map(x=>x.id)).size!==xs.length)c.addIssue({code:'custom',message:'duplicate-ref'});});
const epoch=z.object({principal:id,instanceId:id,bootEpoch:hash,storageEpoch:hash,keyEpoch:positive,rootPairDigest:hash}).strict();
export const pb0EpochVectorSchema=z.object({registry:epoch,custodian:epoch,controller:epoch}).strict().superRefine((v,c)=>{
 if(new Set(Object.values(v).map(x=>x.principal)).size!==3)c.addIssue({code:'custom',message:'epoch-owner-alias'});
});
export const pb0SubjectSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('job'),jobDigest:hash}).strict(),z.object({kind:z.literal('realm'),realmId:id}).strict()
]);
const expectedState=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('job-absent')}).strict(),
 z.object({kind:z.literal('job-exact-revision'),revision:positive}).strict(),
 z.object({kind:z.literal('realm-exact-revision'),revision:positive}).strict()
]);
export const pb0OriginSchema=z.object({domain:z.enum(['metadata-read','control']),owner,subject:pb0SubjectSchema,operationKey:hash,intentDigest:hash}).strict().superRefine((v,c)=>{if(v.domain==='metadata-read'&&v.subject.kind!=='job')c.addIssue({code:'custom',message:'read-origin-job-required'});});
const slice=z.object({kind:z.enum(['init-control','metadata-read','metadata-retry','metadata-audit','maintenance']),sha256:hash}).strict();
const delivery={serverBoot:hash,session:hash,sequence:positive.max(256),nonce:hash,maxWaitMs:positive.max(5000)};
const common={profileDigest:profile,realmId:id,targetOwner:owner,clientCredentialId:id,clientKeyEpoch:positive,operationId:id,...delivery};
export const PB0_READ_POLICY=Object.freeze({
 ReadPins:{owner:'registry',purpose:'job-pins'},ReadAcquisition:{owner:'custodian',purpose:'job-acquisition'},
 ReadPreflight:{owner:'controller',purpose:'job-preflight'},ReadLive:{owner:'registry',purpose:'job-live'}
} as const);
export const PB0_CONTROL_POLICY=Object.freeze({
 RegisterJob:{owner:'registry',role:'producer-registration',purpose:'register-unapproved',subject:'job'},
 InstallApproval:{owner:'registry',role:'approval-ingest',purpose:'install-exact-approval',subject:'job'},
 RecordReservation:{owner:'controller',role:'workspace-controller',purpose:'record-reservation',subject:'job'},
 PublishCurrentPin:{owner:'registry',role:'registry-activation',purpose:'select-metadata',subject:'job'},
 IssueReaderGrant:{owner:'registry',role:'job-access-issuer',purpose:'delegate-exact-job',subject:'job'},
 BeginWorkflow:{owner:'registry',role:'job-reader',purpose:'reserve-metadata-workflow',subject:'job'},
 RevokeReaderGrant:{owner:'registry',role:'job-access-revoker',purpose:'revoke-grant',subject:'job'},
 RevokeJob:{owner:'registry',role:'job-revoker',purpose:'revoke-job',subject:'job'},
 QueryOperation:{owner:'origin',role:'recovery-auditor',purpose:'audit-origin-operation',subject:'origin'},
 ReconcileDebt:{owner:'registry',role:'debt-reconciler',purpose:'settle-exact-debt',subject:'job'},
 ReportBootPrepared:{owner:'registry',role:'registered-service-owner',purpose:'report-recovery',subject:'realm'},
 ActivateEpoch:{owner:'epoch-anchor',role:'bootstrap-authority',purpose:'activate-recovered-vector',subject:'realm'},
 ReadRecoveryStatus:{owner:'registry',role:'recovery-auditor',purpose:'audit-recovery',subject:'realm'}
} as const);
export const pb0JobDescriptorSchema=z.object({schema:z.literal('cwc.e2-p0.job-descriptor.v2'),
 jobId:z.object({realmId:id,controllerJobId:id,randomNonce:hash}).strict(),sourceDigest:hash,inputManifestDigest:hash,toolLockDigest:hash,
 requestedApprovalSubjects:z.object({method:hash,environment:hash}).strict(),initialEpochVector:pb0EpochVectorSchema,
 admittedAt:uint,clockDomain:id,originalWallDeadline:uint,originalLeaseDeadline:uint
}).strict().superRefine((v,c)=>{if(v.originalLeaseDeadline<=v.admittedAt||v.originalWallDeadline<=v.admittedAt)c.addIssue({code:'custom',message:'job-deadline'});});
const readRaw=z.object({...common,domain:z.literal('cwc.e2-p0.backend-request.v2'),
 api:z.enum(['ReadPins','ReadAcquisition','ReadPreflight','ReadLive']),purpose:id,jobDigest:hash,workflowId:id,grantRef:hash,
 currentPinRef:hash,authRevision:positive,selectionRevision:positive,exactSourceRefs:refs,
 expectedEpochVector:pb0EpochVectorSchema,originalDeadline:uint,budgetSliceRef:slice
}).strict();
const controlCommon={...common,domain:z.literal('cwc.e2-p0.backend-control.v1'),purpose:id,targetSubject:pb0SubjectSchema,
 controlGrantRef:hash,expectedState,expectedOwnerHead:hash,originalEpochVector:pb0EpochVectorSchema,originalControlDeadline:uint,controlBudgetSliceRef:slice};
const grantSpec=z.object({credential:id,spkiDigest:hash,keyEpoch:positive,apiSet:z.array(z.enum(['ReadPins','ReadAcquisition','ReadPreflight','ReadLive'])).min(1).max(4),
 purposeSet:z.array(id).min(1).max(4),sourceRefSet:refs,authRevision:positive,selectionRevision:positive,epochVectorDigest:hash,workflowLimit:positive.max(4),originalDeadline:uint}).strict();
const control=<A extends keyof typeof PB0_CONTROL_POLICY,S extends z.ZodType>(api:A,payload:S)=>z.object({...controlCommon,api:z.literal(api),payload}).strict();
const controlRaw=z.discriminatedUnion('api',[
 control('RegisterJob',z.object({descriptor:pb0JobDescriptorSchema}).strict()),
 control('InstallApproval',z.object({approvalKind:z.enum(['method','environment']),approvalRef:pb0RefSchema}).strict()),
 control('RecordReservation',z.object({reservationRef:pb0RefSchema}).strict()),
 control('PublishCurrentPin',z.object({pinRef:pb0RefSchema,expectedSelection:positive}).strict()),
 control('IssueReaderGrant',z.object({grant:grantSpec}).strict()),
 control('BeginWorkflow',z.object({initAdmissionRef:pb0RefSchema,ticketPlanDigest:hash}).strict()),
 control('RevokeReaderGrant',z.object({grantId:id,expectedAuthRevision:positive}).strict()),
 control('RevokeJob',z.object({jobDigest:hash,expectedAuthRevision:positive}).strict()),
 control('QueryOperation',z.object({origin:pb0OriginSchema}).strict()),
 control('ReconcileDebt',z.object({debtRefs:refs.min(1),fenceRefs:refs.length(3),drainRefs:refs.length(3),allocatorRefs:refs.min(1),storeRefs:refs.min(1)}).strict()),
 control('ReportBootPrepared',z.object({owner:z.enum(['registry','custodian','controller']),bootRef:pb0RefSchema,recoveryRefs:refs.min(1),fenceRefs:refs.min(1)}).strict()),
 control('ActivateEpoch',z.object({bootApprovalRef:pb0RefSchema,preparedRefs:refs.length(3),fenceRefs:refs.length(3),expectedVector:pb0EpochVectorSchema,newVector:pb0EpochVectorSchema}).strict()),
 control('ReadRecoveryStatus',z.object({owners:z.array(z.enum(['registry','custodian','controller'])).min(1).max(3)}).strict())
]);
type Draft=z.infer<typeof readRaw>|z.infer<typeof controlRaw>;
export class PB0ContractError extends Error{constructor(readonly reason:string){super('pb0_'+reason);}}
export function pb0Need(ok:unknown,reason:string):asserts ok{if(!ok)throw new PB0ContractError(reason);}
const same=(a:unknown,b:unknown)=>canonical(a,1048576)===canonical(b,1048576);
export function pb0Decode<T>(schema:z.ZodType<T>,wire:string,cap=1048576):T{
 pb0Need(typeof wire==='string'&&Buffer.byteLength(wire)<=cap,'wire-budget');
 let nodes=0,depth=0;const count=()=>pb0Need(++nodes<=PB0_LIMITS.nodes,'wire-nodes');
 visit(wire,{onObjectBegin:()=>{count();pb0Need(++depth<=24,'wire-depth');},onArrayBegin:()=>{count();pb0Need(++depth<=24,'wire-depth');},onObjectEnd:()=>{depth--;},onArrayEnd:()=>{depth--;},onLiteralValue:count});
 try{return schema.parse(parseOwnedJson(wire,cap));}catch(e){if(e instanceof PB0ContractError)throw e;throw new PB0ContractError('schema-invalid');}
}
function identity(r:Draft){
 if(r.domain==='cwc.e2-p0.backend-request.v2'){
  const operationKey=digest({domain:'cwc.e2-p0.read-operation-key.v1',profileDigest:r.profileDigest,realmId:r.realmId,jobDigest:r.jobDigest,clientCredentialId:r.clientCredentialId,clientKeyEpoch:r.clientKeyEpoch,workflowId:r.workflowId,api:r.api,operationId:r.operationId});
  return {operationKey,intentDigest:digest({domain:'cwc.e2-p0.read-intent.v1',operationKeyDigest:operationKey,purpose:r.purpose,exactSourceRefs:r.exactSourceRefs,currentPinRef:r.currentPinRef,authRevision:r.authRevision,originalEpochVector:r.expectedEpochVector,originalDeadline:r.originalDeadline,budgetSliceRef:r.budgetSliceRef})};
 }
 const operationKey=digest({domain:'cwc.e2-p0.control-operation-key.v1',profileDigest:r.profileDigest,realmId:r.realmId,targetOwner:r.targetOwner,targetSubject:r.targetSubject,clientCredentialId:r.clientCredentialId,clientKeyEpoch:r.clientKeyEpoch,api:r.api,operationId:r.operationId});
 return {operationKey,intentDigest:digest({domain:'cwc.e2-p0.control-intent.v1',operationKeyDigest:operationKey,purpose:r.purpose,controlGrantRef:r.controlGrantRef,apiPayloadCanonicalDigest:digest(r.payload),expectedState:r.expectedState,expectedOwnerHead:r.expectedOwnerHead,originalEpochVector:r.originalEpochVector,originalControlDeadline:r.originalControlDeadline,controlBudgetSliceRef:r.controlBudgetSliceRef})};
}
function consistent(r:Draft){
 if(r.domain==='cwc.e2-p0.backend-request.v2'){
  const p=PB0_READ_POLICY[r.api];pb0Need(r.targetOwner===p.owner&&r.purpose===p.purpose,'read-api-purpose');
  pb0Need(['metadata-read','metadata-retry'].includes(r.budgetSliceRef.kind),'read-slice');return;
 }
 const p=PB0_CONTROL_POLICY[r.api];pb0Need(r.purpose===p.purpose&&(p.owner==='origin'||r.targetOwner===p.owner),'control-api-purpose');
 pb0Need(p.subject==='origin'||r.targetSubject.kind===p.subject,'control-subject');
 if(r.targetSubject.kind==='realm')pb0Need(r.targetSubject.realmId===r.realmId&&r.expectedState.kind==='realm-exact-revision','realm-state');
 else pb0Need(r.expectedState.kind===(r.api==='RegisterJob'?'job-absent':'job-exact-revision'),'job-state');
 if(r.api==='RegisterJob')pb0Need(r.targetSubject.kind==='job'&&r.targetSubject.jobDigest===digest(r.payload.descriptor)&&r.payload.descriptor.jobId.realmId===r.realmId,'descriptor-binding');
 if(r.api==='RevokeJob')pb0Need(r.targetSubject.kind==='job'&&r.payload.jobDigest===r.targetSubject.jobDigest,'revoke-job-binding');
 if(r.api==='BeginWorkflow')pb0Need(r.controlBudgetSliceRef.kind==='init-control','begin-slice');
 else if(r.api==='QueryOperation'){
  pb0Need(r.payload.origin.owner===r.targetOwner&&same(r.payload.origin.subject,r.targetSubject),'origin-owner-subject');
  pb0Need(r.controlBudgetSliceRef.kind!=='metadata-read'&&r.controlBudgetSliceRef.kind!=='metadata-retry','query-slice');
  if(r.controlBudgetSliceRef.kind==='metadata-audit')pb0Need(r.payload.origin.domain==='metadata-read','query-origin-slice');
  if(r.controlBudgetSliceRef.kind==='init-control')pb0Need(r.payload.origin.domain==='control','init-origin-slice');
  pb0Need(r.payload.origin.operationKey!==identity(r).operationKey,'query-own-origin-alias');
 }else pb0Need(r.controlBudgetSliceRef.kind==='maintenance','maintenance-slice');
 if(r.api==='IssueReaderGrant'){
  const g=r.payload.grant;pb0Need(new Set(g.apiSet).size===g.apiSet.length&&new Set(g.purposeSet).size===g.purposeSet.length,'grant-duplicates');
  pb0Need(same([...g.apiSet.map(a=>PB0_READ_POLICY[a].purpose)].sort(),[...g.purposeSet].sort()),'grant-purpose-set');
 }
 if(r.api==='ReadRecoveryStatus')pb0Need(new Set(r.payload.owners).size===r.payload.owners.length,'owner-duplicates');
 if(r.api==='ActivateEpoch')pb0Need(same(r.payload.expectedVector,r.originalEpochVector),'epoch-cas-binding');
}
const draft=z.union([readRaw,controlRaw]);
const readFull=readRaw.extend({operationKey:hash,intentDigest:hash});
const fullOptions=controlRaw.options.map(s=>s.extend({operationKey:hash,intentDigest:hash}));
const controlFull=z.discriminatedUnion('api',[fullOptions[0]!,...fullOptions.slice(1)]);
export const pb0RequestSchema=z.union([readFull,controlFull]);
export type PB0Request=z.infer<typeof pb0RequestSchema>;
export function pb0SealRequest(wire:string):string{const r=pb0Decode(draft,wire,16384);consistent(r);return canonical({...r,...identity(r)},16384);}
export function pb0ParseRequest(wire:string):PB0Request{
 const r=pb0Decode(pb0RequestSchema,wire,16384);consistent(r);const i=identity(r);pb0Need(r.operationKey===i.operationKey&&r.intentDigest===i.intentDigest,'K-D-mismatch');return r;
}
export function pb0Identity(wire:string){const r=pb0ParseRequest(wire);return {operationKey:r.operationKey,intentDigest:r.intentDigest};}
for(const p of [...Object.values(PB0_READ_POLICY),...Object.values(PB0_CONTROL_POLICY)])Object.freeze(p);
export const PB0_JOB_STATES=['registered','awaiting-approval','metadata-ready','preflight-ready','revoking','fenced','quarantined','settled'] as const;
export const PB0_SERVICE_STATES=['created','recovering','control-ready','operational','draining','closed','blocked'] as const;
const api=z.enum([...Object.keys(PB0_READ_POLICY),...Object.keys(PB0_CONTROL_POLICY)] as [string,...string[]]);
export const pb0PolicySchema=z.object({schema:z.literal('cwc.e2-p0.pb0-policy.v1'),profileDigest:profile,realmId:id,targetOwner:owner,subject:pb0SubjectSchema,
 credentialId:id,credentialKeyEpoch:positive,spki:z.string().min(1).max(128),spkiDigest:hash,
 role:z.enum(['job-reader','producer-registration','approval-ingest','workspace-controller','registry-activation','job-access-issuer','job-access-revoker','job-revoker','recovery-auditor','debt-reconciler','registered-service-owner','bootstrap-authority']),
 grantRef:hash,apiSet:z.array(api).min(1).max(17),purposeSet:z.array(id).min(1).max(17),sourceRefs:refs,allowedOrigins:z.array(pb0OriginSchema).max(256),
 realmRevision:positive,ownerHead:hash,epochVector:pb0EpochVectorSchema,anchorBoot:hash,
 jobView:z.object({state:z.enum(PB0_JOB_STATES),revision:positive,authRevision:positive,selectionRevision:positive,currentPinRef:hash,originalDeadline:uint}).strict().nullable(),
 validFrom:uint,validUntil:uint,revoked:z.boolean(),stopping:z.boolean(),fatal:z.boolean(),serviceState:z.enum(PB0_SERVICE_STATES),
 prerequisites:z.object({bootstrapRef:hash.nullable(),capacityRef:hash.nullable(),currentAnchorRef:hash.nullable()}).strict(),
 separatedKeys:z.array(hash).min(6).max(16),ownedService:z.enum(['registry','custodian','controller']).nullable(),delegation:grantSpec.nullable()
}).strict();
export function pb0ParsePolicy(wire:string){const p=pb0Decode(pb0PolicySchema,wire);pb0Need(p.validFrom<p.validUntil,'policy-deadline');
 pb0Need(new Set(p.apiSet).size===p.apiSet.length&&new Set(p.purposeSet).size===p.purposeSet.length&&new Set(p.separatedKeys).size===p.separatedKeys.length,'policy-duplicates');
 try{const b=Buffer.from(p.spki,'base64'),k=createPublicKey({key:b,format:'der',type:'spki'});pb0Need(k.asymmetricKeyType==='ed25519'&&k.export({format:'der',type:'spki'}).toString('base64')===p.spki&&ownedSha256(b)===p.spkiDigest,'policy-key');}
 catch{throw new PB0ContractError('policy-key');}return p;}
const staticResult=()=>({schema:'cwc.e2-p0.pb0-check.v1' as const,status:'static-valid' as const,jobPermitIssued:false as const,runtimeAdmitted:false as const,candidateReads:0 as const});
/** Assumed-authenticated, caller-supplied policy fixture. A successful check is NOT a live authorization receipt. */
export function pb0Authorize(requestWire:string,policyWire:string,now:number){
 const r=pb0ParseRequest(requestWire),p=pb0ParsePolicy(policyWire);pb0Need(uint.safeParse(now).success,'clock-invalid');
 pb0Need(Object.values(p.prerequisites).every(x=>x!==null),'unsupported-prerequisite');
 pb0Need(!p.revoked&&!p.stopping&&!p.fatal&&now>=p.validFrom&&now<p.validUntil,'revoked-or-expired');
 pb0Need(r.realmId===p.realmId&&r.targetOwner===p.targetOwner&&r.clientCredentialId===p.credentialId&&r.clientKeyEpoch===p.credentialKeyEpoch,'credential-scope');
 pb0Need(p.apiSet.includes(r.api)&&p.purposeSet.includes(r.purpose),'api-grant');
 if(p.role==='job-reader'||p.role==='recovery-auditor')pb0Need(!p.separatedKeys.includes(p.spkiDigest),'reader-owner-key-alias');
 const v=r.domain==='cwc.e2-p0.backend-request.v2'?r.expectedEpochVector:r.originalEpochVector;
 pb0Need(same(v,p.epochVector),'old-epoch');
 pb0Need(r.serverBoot===(r.targetOwner==='epoch-anchor'?p.anchorBoot:p.epochVector[r.targetOwner].bootEpoch),'server-boot');
 if(r.domain==='cwc.e2-p0.backend-request.v2'){
  pb0Need(p.serviceState==='operational'&&p.role==='job-reader'&&p.subject.kind==='job'&&p.subject.jobDigest===r.jobDigest&&p.grantRef===r.grantRef,'read-scope');
  const s=p.jobView;pb0Need(s&&['metadata-ready','preflight-ready'].includes(s.state)&&(r.api!=='ReadPreflight'||s.state==='preflight-ready'),'read-job-state');
  pb0Need(r.authRevision===s.authRevision&&r.selectionRevision===s.selectionRevision&&r.currentPinRef===s.currentPinRef,'read-pin-revision');
  const sorted=(xs:z.infer<typeof refs>)=>[...xs].sort((a,b)=>a.id.localeCompare(b.id));pb0Need(same(sorted(r.exactSourceRefs),sorted(p.sourceRefs)),'source-ref-set');
  pb0Need(now<r.originalDeadline&&r.originalDeadline<=Math.min(p.validUntil,s.originalDeadline),'original-deadline');
 }else{
  pb0Need(p.role===PB0_CONTROL_POLICY[r.api].role&&same(p.subject,r.targetSubject)&&r.controlGrantRef===p.grantRef,'control-scope');
  const recovery=['QueryOperation','ReadRecoveryStatus','ReportBootPrepared','ActivateEpoch'].includes(r.api);
  pb0Need(p.serviceState==='operational'||(recovery&&p.serviceState==='control-ready'),'control-service-state');
  pb0Need(now<r.originalControlDeadline&&r.originalControlDeadline<=p.validUntil,'original-control-deadline');
  if(r.api==='BeginWorkflow'||r.api==='IssueReaderGrant')pb0Need(p.jobView&&['metadata-ready','preflight-ready'].includes(p.jobView.state)&&r.originalControlDeadline<=p.jobView.originalDeadline,'control-job-not-live');
  if(r.api==='ReportBootPrepared')pb0Need(p.ownedService===r.payload.owner,'boot-report-owner');
  if(r.api==='IssueReaderGrant'){
   const g=r.payload.grant,c=p.delegation;pb0Need(c&&g.credential===c.credential&&g.spkiDigest===c.spkiDigest&&g.keyEpoch===c.keyEpoch,'delegation-credential');
   pb0Need(g.apiSet.every(a=>c.apiSet.includes(a))&&g.purposeSet.every(s=>c.purposeSet.includes(s))&&g.sourceRefSet.every(r=>c.sourceRefSet.some(x=>same(x,r))),'delegation-scope');
   pb0Need(g.workflowLimit<=c.workflowLimit&&g.originalDeadline<=Math.min(c.originalDeadline,p.validUntil,p.jobView!.originalDeadline)&&g.authRevision===p.jobView!.authRevision&&g.selectionRevision===p.jobView!.selectionRevision&&g.epochVectorDigest===digest(p.epochVector),'delegation-budget-revision');
  }
  if(r.api==='QueryOperation'){
   pb0Need(p.allowedOrigins.some(x=>same(x,r.payload.origin)),'origin-grant');
   if(r.targetSubject.kind==='job')pb0Need(p.jobView&&r.expectedState.kind==='job-exact-revision'&&r.expectedState.revision===p.jobView.revision,'audit-current-state');
   else pb0Need(r.expectedState.kind==='realm-exact-revision'&&r.expectedState.revision===p.realmRevision,'audit-current-state');
  }
 }
 return staticResult();
}
/** Called only for a NEW operation after origin lookup, never as a prerequisite to historical lookup. */
export function pb0ValidateNewCAS(requestWire:string,policyWire:string,now:number){
 pb0Authorize(requestWire,policyWire,now);const r=pb0ParseRequest(requestWire),p=pb0ParsePolicy(policyWire);
 pb0Need(r.domain==='cwc.e2-p0.backend-control.v1'&&r.api!=='QueryOperation'&&r.api!=='ReadRecoveryStatus','mutation-required');
 pb0Need(r.expectedOwnerHead===p.ownerHead,'CAS-owner-head');
 if(r.expectedState.kind==='job-absent')pb0Need(p.jobView===null,'CAS-job-exists');
 else if(r.expectedState.kind==='job-exact-revision')pb0Need(p.jobView&&r.expectedState.revision===p.jobView.revision,'CAS-job-revision');
 else pb0Need(r.expectedState.revision===p.realmRevision,'CAS-realm-revision');
 if(r.api==='RevokeJob'||r.api==='RevokeReaderGrant')pb0Need(p.jobView&&r.payload.expectedAuthRevision===p.jobView.authRevision,'CAS-auth-revision');
 if(r.api==='PublishCurrentPin')pb0Need(p.jobView&&r.payload.expectedSelection===p.jobView.selectionRevision,'CAS-selection-revision');
 return staticResult();
}
const originRecord=z.object({schema:z.literal('cwc.e2-p0.pb0-origin-record.v1'),origin:pb0OriginSchema,
 stage:z.enum(['intent-reserved','source-captured','response-ready','response-may-have-escaped','failed-or-unknown','historical','control-committed','unknown','absent-tombstoned']),
 originalRequestWire:z.string().max(16384).nullable(),receiptRef:pb0RefSchema.nullable(),
 tombstoneRef:pb0RefSchema.nullable(),anchorRef:pb0RefSchema.nullable(),adoptionRef:pb0RefSchema.nullable()
}).strict();
function originOf(r:PB0Request){return {domain:r.domain==='cwc.e2-p0.backend-request.v2'?'metadata-read' as const:'control' as const,owner:r.targetOwner,
 subject:r.domain==='cwc.e2-p0.backend-request.v2'?{kind:'job' as const,jobDigest:r.jobDigest}:r.targetSubject,operationKey:r.operationKey,intentDigest:r.intentDigest};}
function ledger(wire:string){
 const l=pb0Decode(originRecord,wire);
 if(l.stage==='absent-tombstoned')pb0Need(l.originalRequestWire===null&&l.receiptRef===null&&l.tombstoneRef&&l.anchorRef&&l.adoptionRef,'durable-tombstone-required');
 else if(l.stage==='unknown')pb0Need(l.originalRequestWire===null&&l.receiptRef===null&&l.tombstoneRef===null,'unknown-not-absent');
 else {pb0Need(l.originalRequestWire!==null&&l.tombstoneRef===null,'origin-record');pb0Need(same(originOf(pb0ParseRequest(l.originalRequestWire)),l.origin),'saved-origin-binding');
  if(l.stage==='control-committed')pb0Need(l.origin.domain==='control','origin-stage-domain');
  if(['historical','control-committed','response-ready','response-may-have-escaped'].includes(l.stage))pb0Need(l.receiptRef&&l.anchorRef&&l.adoptionRef,'saved-receipt-required');
  else pb0Need(l.receiptRef===null,'pending-receipt-forbidden');
 }
 return l;
}
export function pb0CheckOrigin(queryWire:string,recordWire:string,now:number){
 const q=pb0ParseRequest(queryWire);pb0Need(q.domain==='cwc.e2-p0.backend-control.v1'&&q.api==='QueryOperation','query-required');
 pb0Need(uint.safeParse(now).success&&now<q.originalControlDeadline,'query-expired');const l=ledger(recordWire);pb0Need(same(q.payload.origin,l.origin),'origin-mismatch');
 return {...staticResult(),status:l.stage==='absent-tombstoned'?'absent' as const:l.receiptRef?'historical' as const:'pending' as const,origin:l.origin,receiptRef:l.receiptRef,reapply:false as const};
}
export function pb0CheckReplay(requestWire:string,recordWire:string){
 const r=pb0ParseRequest(requestWire),l=ledger(recordWire),o=originOf(r);
 pb0Need(o.domain===l.origin.domain&&o.owner===l.origin.owner&&same(o.subject,l.origin.subject)&&o.operationKey===l.origin.operationKey,'origin-key-mismatch');
 pb0Need(l.stage!=='absent-tombstoned','origin-tombstoned');pb0Need(o.intentDigest===l.origin.intentDigest,'operation-conflict');
 return {...staticResult(),status:l.receiptRef?'historical' as const:'pending' as const,reapply:false as const};
}
