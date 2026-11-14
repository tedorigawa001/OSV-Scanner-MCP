/** Acquire authenticated metadata and run preflight. Candidate acquisition/execution is deliberately absent. */
import {z} from 'zod';
import {ownedDigest as digest} from './gradleOwnedJson.js';
import {P0Verifier,p0ControlSchema,p0TrustSchema,p0LiveSchema} from './gradleOwnedP0Contract.js';
import {readP0Backend,closeP0Backend,finishP0Backend,inspectP0Backend,p0BackendOwners,p0Decode,P0BackendError,type P0Backend} from './gradleOwnedP0Backend.js';
const acquisitionSchema=p0ControlSchema.omit({schema:true,preflight:true});
const preflightSchema=z.object({preflight:p0ControlSchema.shape.preflight}).strict();
export const p0RunnerResultSchema=z.object({schema:z.literal('cwc.e2-p0.runner-result.v1'),status:z.enum(['unsupported','invalid','revoked-or-expired','workspace-budget-exceeded','failed-no-success-envelope']),
 reasons:z.array(z.string().max(256)).min(1).max(16),calls:z.number().int().nonnegative().max(8),wireBytes:z.number().int().nonnegative().max(8388608),
 staticMetadataVerified:z.boolean(),jobPermitIssued:z.literal(false),runtimeAdmitted:z.literal(false),
 candidateOperations:z.object({reads:z.literal(0),copies:z.literal(0),execs:z.literal(0),publications:z.literal(0)}).strict()}).strict();
export async function runP0Preflight(backend:P0Backend|null,jobDigest:string){
 const result=(status:z.infer<typeof p0RunnerResultSchema>['status'],reasons:string[],staticMetadataVerified=false)=>{
  const usage=backend?inspectP0Backend(backend):{calls:0,wireBytes:0};
  return p0RunnerResultSchema.parse({schema:'cwc.e2-p0.runner-result.v1',status,reasons,calls:usage.calls,wireBytes:usage.wireBytes,staticMetadataVerified,
   jobPermitIssued:false,runtimeAdmitted:false,candidateOperations:{reads:0,copies:0,execs:0,publications:0}});
 };
 if(!backend)return result('unsupported',['independent-backend-unconfigured']);
 const read=async(api:Parameters<typeof readP0Backend>[1])=>{
  const r=await readP0Backend(backend,api,jobDigest);if(r.status==='unavailable')throw new P0BackendError(r.reason);return r.wire;
 };
 try{
  if(!/^[a-f0-9]{64}$/.test(jobDigest))return result('invalid',['job-digest-invalid']);
  const pinsWire=await read('ReadPins'),pins=p0Decode(p0TrustSchema,pinsWire),owners=p0BackendOwners(backend);
  if(digest(pins.job)!==jobDigest)throw new P0BackendError('backend-job-mismatch');
  for(const [peer,role] of [['registry','registry-authority'],['custodian','acquisition-custodian'],['controller','workspace-controller']] as const){
   const owner=pins.roles.find(r=>r.role===role),p=owners.peers[peer];
   if(!owner||owner.principal!==p.principal||owner.keyId!==p.keyId||owner.spki!==p.spki)throw new P0BackendError('backend-owner-pin-mismatch');
  }
  const acquisition=p0Decode(acquisitionSchema,await read('ReadAcquisition'));
  const missing=new P0Verifier(pinsWire,()=>null).check(JSON.stringify({schema:'cwc.e2-p0.control.v1',...acquisition,preflight:null}));
  if(missing.status!=='unsupported')return result(missing.status==='static-valid'?'unsupported':missing.status,missing.reasons);
  if(!acquisition.lock||!acquisition.method||!acquisition.environment||missing.reasons.some(r=>r==='tool-image-unavailable'||r==='solver-identity-unavailable'))return result('unsupported',missing.reasons);
  // Fresh signed authority views bracket controller metadata acquisition; no candidate IO between them.
  const beforeWire=await read('ReadLive'),before=p0Decode(p0LiveSchema,beforeWire);
  const mapped=(until:number)=>pins.clock.monoAt+(until-pins.clock.utcAt)-pins.clock.errorMs;
  const deadline=Math.min(pins.job.admittedAt+600000,pins.job.leaseDeadline,mapped(acquisition.method.payload.validUntil),mapped(acquisition.environment.payload.validUntil));
  const utc=pins.clock.utcAt+(before.now-pins.clock.monoAt)-pins.clock.errorMs;
  const fields=['registryRevision','registryPinDigest','controllerRevision','reservationFence','reservationDigest','enforcementDigest','bootstrapDigest','clockReceiptDigest'] as const;
  if(!Number.isSafeInteger(deadline)||before.now<pins.job.admittedAt||before.now>=deadline||utc<acquisition.method.payload.validFrom||utc<acquisition.environment.payload.validFrom||
   before.incarnation!==pins.job.incarnation||before.methodRevoked||before.environmentRevoked||before.stopping||before.fatal||fields.some(k=>before[k]!==pins[k]))throw new P0BackendError('backend-authority-revoked');
  const preflight=p0Decode(preflightSchema,await read('ReadPreflight'));
  const afterWire=await read('ReadLive'),after=p0Decode(p0LiveSchema,afterWire);
  const packet=JSON.stringify({schema:'cwc.e2-p0.control.v1',...acquisition,...preflight}),verifier=new P0Verifier(pinsWire,()=>beforeWire);
  const first=verifier.check(packet);
  if(first.status!=='static-valid')return result(first.status,first.reasons);
  if(after.now<before.now)throw new P0BackendError('backend-live-rollback');
  const final=new P0Verifier(pinsWire,()=>afterWire).check(packet);
  if(final.status!=='static-valid')return result(final.status,final.reasons);
  const completed=result('unsupported',['independent-enforcement-validation-unavailable','candidate-acquisition-and-job-admission-disabled'],true);
  finishP0Backend(backend);
  return completed;
 }catch(e){
  const reason=e instanceof P0BackendError?e.reason:'backend-metadata-invalid';
  const unavailable=['evidence-unavailable','approval-unavailable','reservation-unavailable','backend-recovering','backend-unavailable','backend-service-unavailable'];
  return result(['backend-timeout','backend-expired-or-closed','backend-live-rollback','backend-authority-revoked','backend-service-expired'].includes(reason)?'revoked-or-expired':unavailable.includes(reason)?'unsupported':'invalid',[reason]);
 }finally{closeP0Backend(backend);}
}
