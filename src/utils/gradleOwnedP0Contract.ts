/** Metadata-only E2-P0 contract. No installer, candidate IO, job permit or physical-bound claim. */
import {createPublicKey,verify} from 'node:crypto';
import {visit} from 'jsonc-parser';
import {z} from 'zod';
import {canonicalOwnedJson,ownedDigest,parseOwnedJson} from './gradleOwnedJson.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const commit=z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const path=z.string().regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/).max(256)
 .refine(p=>!p.split('/').some(s=>s==='.'||s==='..'));
const signature=z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const text=z.string().max(256);
const ref=z.object({id,sha256:hash,byteLength:uint.positive().max(1048576)}).strict();
export const P0_ROLES=['producer','acquisition-custodian','method-review-authority','environment-review-authority',
 'workspace-controller','runner','registry-authority','evidence-store'] as const;
export const P0_VERIFIER_FLAGS=Object.freeze(['--c17','--LP64','--little-endian','--bounds-check','--pointer-check',
 '--div-by-zero-check','--signed-overflow-check','--unsigned-overflow-check','--undefined-shift-check','--unwinding-assertions','--json-ui','--trace']);
export const P0_COMPILER_FLAGS=Object.freeze(['-std=c17','--target=x86_64-unknown-linux-gnu','--sysroot=/sealed/sysroot',
 '-ffreestanding','-fno-builtin','-fno-lto','-fno-stack-protector','-O0','-g0','-fno-ident','-c']);
export const P0_CAPACITY=Object.freeze({runnerMemory:8589934592,swap:0,pids:64,cpuQuota:200000,cpuPeriod:100000,
 scratch:1073741824,evidence:1073741824,disk:2147483648,inodes:8192,stdout:16777216,stderr:16777216,
 bootstrap:16777216,controller:268435456,watchdog:67108864,descriptor:16777216,streamQueue:262144,
 store:8589934592,storeInodes:32768,activeJobs:1,outstandingJobs:4});
const capacitySchema=z.object(Object.fromEntries(Object.keys(P0_CAPACITY).map(k=>[k,uint])) as {[K in keyof typeof P0_CAPACITY]:typeof uint}).strict();
const configurationSchema=z.object({verifierPath:path,compilerPath:path,entrypoint:id,inputPath:path,outputPath:path,
 verifierArgv:z.array(text).min(1).max(256),compilerArgv:z.array(text).min(1).max(256),
 environment:z.object({LC_ALL:z.literal('C'),TZ:z.literal('UTC'),TMPDIR:z.literal('/job/tmp')}).strict(),
 cwd:z.literal('/job'),shell:z.literal(false),network:z.literal(false),
 effectiveDefaultsDigest:hash,capabilityReceiptDigest:hash,preprocessorDigest:hash,headerClosureDigest:hash,
 outputSchemaDigest:hash,sealedInputDigest:hash,
 properties:z.array(id).min(1).max(128),loops:z.array(z.object({id,bound:uint.positive(),includesFinalCondition:z.literal(true)}).strict()).min(1).max(128)
}).strict();
const digestNames=['sourceArchiveDigest','dependencyLockDigest','builderImageDigest','buildArgvDigest','baseImageDigest',
 'sysrootDigest','verifierBinaryDigest','compilerBinaryDigest','linkerBinaryDigest','sharedLibraryClosureDigest',
 'loaderDigest','runnerImageDigest','rootfsDigest','runtimeKernelProfile','methodProfileDigest','quarantineReceiptDigest','custodyReservationDigest'] as const;
const digestsSchema=z.object(Object.fromEntries(digestNames.map(k=>[k,hash.nullable()])) as {[K in typeof digestNames[number]]:z.ZodNullable<typeof hash>}).strict();
export const p0LockSchema=z.object({schema:z.literal('cwc.e2-p0.acquisition-lock.v1'),
 acquisition:z.literal('official-tagged-source'),sourceCommit:commit.nullable(),
 verifier:z.object({version:z.literal('6.8.0'),tag:z.literal('cbmc-6.8.0'),origin:z.literal('https://github.com/diffblue/cbmc/releases/tag/cbmc-6.8.0')}).strict(),
 compiler:z.object({version:z.literal('21.1.8'),tag:z.literal('llvmorg-21.1.8'),origin:z.literal('https://github.com/llvm/llvm-project/releases/tag/llvmorg-21.1.8'),sourceCommit:commit,sourceArchiveDigest:hash}).strict(),
 profile:z.literal('cwc.e2-p0.linux-x86_64.v1'),imagePlatform:z.literal('linux/amd64'),abi:z.literal('LP64-little-endian-char8'),
 digests:digestsSchema,solver:z.object({kind:z.literal('embedded-MiniSat-only'),componentVersion:id,sourceDigest:hash,buildDigest:hash,containingBinaryDigest:hash,containingImageDigest:hash,externalFallback:z.literal(false)}).strict().nullable(),
 configuration:configurationSchema.nullable()
}).strict();
export type P0Lock=z.infer<typeof p0LockSchema>;
export const p0ApprovalPayloadSchema=z.object({domain:z.literal('cwc.e2-p0.approval.v1'),approvalKind:z.enum(['method','environment']),
 issuer:id,subjectDigest:hash,methodOrEnvironmentProfileDigest:hash,validFrom:uint,validUntil:uint,
 registryRevision:uint.positive(),limitations:z.array(text).max(16),signatureAlgorithm:z.literal('Ed25519'),keyId:id
}).strict();
export const p0ApprovalSchema=z.object({payload:p0ApprovalPayloadSchema,signature}).strict();
export type P0Approval=z.infer<typeof p0ApprovalSchema>;
const jobSchema=z.object({jobId:id,nonce:hash,incarnation:id,sequence:uint.positive(),sourceDigest:hash,inputManifestDigest:hash,
 admittedAt:uint,leaseDeadline:uint}).strict();
export const p0PreflightPayloadSchema=z.object({domain:z.literal('cwc.e2-p0.preflight.v1'),issuer:id,keyId:id,signatureAlgorithm:z.literal('Ed25519'),
 job:jobSchema,registryRevision:uint.positive(),registryPinDigest:hash,toolLockDigest:hash,
 methodApprovalDigest:hash,environmentApprovalDigest:hash,workspaceProfile:z.literal('cwc.e2-p0.workspace.v1'),
 limits:capacitySchema,reservations:z.object({job:ref,store:ref,controller:ref,watchdog:ref,bootstrap:ref}).strict().nullable(),
 enforcementWitness:ref.nullable(),clockMappingReceipt:ref.nullable(),bootstrapCapacity:ref.nullable(),
 controllerRevision:uint.positive(),reservationFence:uint.positive(),sealedInputDigest:hash,
 phase:z.enum(['reserved','copied','result-validated','drained','sealed']),
 result:z.object({status:z.enum(['success','failed','unknown']),propertyClosureDigest:hash,loopClosureDigest:hash}).strict().nullable(),
 drainWitness:ref.nullable(),sealWitness:ref.nullable()
}).strict().superRefine((p,ctx)=>{
 const failed=()=>ctx.addIssue({code:'custom',message:'full-success-result-required',params:{p0Refusal:'failed-no-success-envelope'}});
 const inconsistent=()=>ctx.addIssue({code:'custom',message:'phase-evidence-mismatch'});
 // A failed/unknown result is never a valid preflight, regardless of the requested gate.
 if(p.result!==null&&p.result.status!=='success'){failed();return;}
 if(p.phase==='reserved'||p.phase==='copied'){
  if(p.result!==null||p.drainWitness!==null||p.sealWitness!==null)inconsistent();
  return;
 }
 if(p.result===null){failed();return;}
 if(p.phase==='result-validated'&&(p.drainWitness!==null||p.sealWitness!==null))inconsistent();
 if(p.phase==='drained'&&(p.drainWitness===null||p.sealWitness!==null))inconsistent();
 if(p.phase==='sealed'&&(p.drainWitness===null||p.sealWitness===null))inconsistent();
});
export const p0PreflightSchema=z.object({payload:p0PreflightPayloadSchema,signature}).strict();
export type P0Preflight=z.infer<typeof p0PreflightSchema>;
export const p0ControlSchema=z.object({schema:z.literal('cwc.e2-p0.control.v1'),lock:p0LockSchema.nullable(),
 method:p0ApprovalSchema.nullable(),environment:p0ApprovalSchema.nullable(),preflight:p0PreflightSchema.nullable()}).strict();
const pin=z.object({subjectDigest:hash,profileDigest:hash,envelopeDigest:hash}).strict();
/** Supplied ONLY by the independent registry owner, never from the submitted control packet. */
export const p0TrustSchema=z.object({schema:z.literal('cwc.e2-p0.trusted-pins.v1'),registryRevision:uint.positive(),registryPinDigest:hash,
 lockDigest:hash,method:pin,environment:pin,job:jobSchema,
 roles:z.array(z.object({role:z.enum(P0_ROLES),principal:id,keyId:id,spki:z.string().min(1).max(256),store:id,aclDigest:hash}).strict()).length(8),
 reservationDigest:hash,enforcementDigest:hash,bootstrapDigest:hash,clockReceiptDigest:hash,
 controllerRevision:uint.positive(),reservationFence:uint.positive(),
 clock:z.object({monoAt:uint,utcAt:uint,errorMs:uint.max(1000)}).strict()
}).strict();
export type P0Trust=z.infer<typeof p0TrustSchema>;
export const p0LiveSchema=z.object({schema:z.literal('cwc.e2-p0.live.v1'),now:uint,registryRevision:uint.positive(),registryPinDigest:hash,
 controllerRevision:uint.positive(),reservationFence:uint.positive(),incarnation:id,
 methodRevoked:z.boolean(),environmentRevoked:z.boolean(),stopping:z.boolean(),fatal:z.boolean(),
 reservationDigest:hash,enforcementDigest:hash,bootstrapDigest:hash,clockReceiptDigest:hash}).strict();
const gateStatus=z.enum(['static-valid','unsupported','invalid','revoked-or-expired','workspace-budget-exceeded','failed-no-success-envelope']);
export const p0GateResultSchema=z.object({schema:z.literal('cwc.e2-p0.gate-result.v1'),status:gateStatus,reasons:z.array(text).min(1).max(16),
 phase:z.enum(['pre-copy','pre-exec','pre-publish']),effectiveDeadline:uint.nullable(),
 jobPermitIssued:z.literal(false),runtimeAdmitted:z.literal(false),physicalBoundProved:z.literal(false),credit:z.literal(0),
 operations:z.object({candidateReads:z.literal(0),copies:z.literal(0),execs:z.literal(0),publications:z.literal(0)}).strict()}).strict();
export type P0GateResult=z.infer<typeof p0GateResultSchema>;
class Rejected extends Error{constructor(readonly status:z.infer<typeof gateStatus>,readonly reason:string){super(reason);}}
function need(ok:unknown,reason:string):asserts ok{if(!ok)throw new Rejected('invalid',reason);}
/** Wire-only input avoids evaluating producer getters / toJSON / proxy callbacks. */
function decode<T>(schema:z.ZodType<T>,wire:string):T{
 need(typeof wire==='string','metadata-wire-required');
 if(Buffer.byteLength(wire)>1048576)throw new Rejected('workspace-budget-exceeded','metadata-bytes-exceeded');
 let depth=0,nodes=0;
 const node=()=>{if(++nodes>65536)throw new Rejected('workspace-budget-exceeded','metadata-nodes-exceeded');};
 const enter=()=>{node();if(++depth>24)throw new Rejected('workspace-budget-exceeded','metadata-depth-exceeded');};
 visit(wire,{onObjectBegin:enter,onArrayBegin:enter,onObjectEnd:()=>{depth--;},onArrayEnd:()=>{depth--;},onLiteralValue:node});
 const p=schema.safeParse(parseOwnedJson(wire,1048576));
 if(!p.success){
  // Only schema-generated semantic failure issues get the failure status; malformed shape stays invalid.
  if(p.error.issues.every(i=>i.code==='custom'&&i.params?.p0Refusal==='failed-no-success-envelope'))throw new Rejected('failed-no-success-envelope','full-success-result-required');
  throw new Rejected('invalid','schema-subject-argv-or-signature-mismatch');
 }
 return p.data;
}
const equal=(a:unknown,b:unknown)=>canonicalOwnedJson(a,1048576)===canonicalOwnedJson(b,1048576);
function checkConfig(lock:P0Lock){
 const c=lock.configuration;if(!c)return;
 need(c.verifierPath==='/sealed/bin/cbmc'&&c.compilerPath==='/sealed/bin/clang','absolute-tool-path-mismatch');
 need(c.inputPath.startsWith('/job/input/')&&c.outputPath.startsWith('/job/output/'),'input-output-path-mismatch');
 const loops=c.loops.map(l=>l.id+':'+l.bound).join(',');
 need(new Set(c.properties).size===c.properties.length&&new Set(c.loops.map(l=>l.id)).size===c.loops.length,'closure-duplicate');
 need(equal(c.verifierArgv,[c.verifierPath,...P0_VERIFIER_FLAGS,'--function',c.entrypoint,'--unwindset',loops,c.inputPath]),'verifier-argv-mismatch');
 need(equal(c.compilerArgv,[c.compilerPath,...P0_COMPILER_FLAGS,c.inputPath,'-o',c.outputPath]),'compiler-argv-mismatch');
 if(lock.solver&&lock.digests.verifierBinaryDigest&&lock.digests.runnerImageDigest)need(lock.solver.containingBinaryDigest===lock.digests.verifierBinaryDigest&&lock.solver.containingImageDigest===lock.digests.runnerImageDigest,'solver-binding-mismatch');
}
/**
 * In-memory, metadata-only refusal gate. The trusted live port supplies mapped monotonic time and
 * current registry/fences. This class does NOT authenticate that port or deploy/observe native quotas.
 * No stamp is returned that can authorize IO: even static-valid requires independent runtime evidence.
 */
export class P0Verifier{
 #trust:P0Trust|null;#live:()=>string|null;#busy=false;#fatal=false;#lastTime=0;
 constructor(trustedPins:string|null,live:()=>string|null){
  this.#trust=trustedPins===null?null:decode(p0TrustSchema,trustedPins);this.#live=live;
  if(this.#trust){
   const roles=this.#trust.roles;
   for(const key of ['role','principal','keyId','spki','store'] as const)need(new Set(roles.map(r=>r[key])).size===8,'role-owner-separation-required');
   need(P0_ROLES.every(r=>roles.some(p=>p.role===r)),'role-missing');
   for(const r of roles){const k=createPublicKey({key:Buffer.from(r.spki,'base64'),format:'der',type:'spki'});need(k.asymmetricKeyType==='ed25519','approval-key-type-mismatch');
    need(k.export({format:'der',type:'spki'}).toString('base64')===r.spki,'approval-key-encoding-invalid');}
   need(this.#trust.job.leaseDeadline>this.#trust.job.admittedAt,'original-deadline-invalid');
   this.#lastTime=this.#trust.job.admittedAt;
  }
 }
 check(wire:string,phase:'pre-copy'|'pre-exec'|'pre-publish'='pre-copy'):P0GateResult{
  let deadline:number|null=null;
  const result=(s:z.infer<typeof gateStatus>,reasons:string[]):P0GateResult=>p0GateResultSchema.parse({schema:'cwc.e2-p0.gate-result.v1',status:s,reasons,phase,effectiveDeadline:deadline,
   jobPermitIssued:false,runtimeAdmitted:false,physicalBoundProved:false,credit:0,operations:{candidateReads:0,copies:0,execs:0,publications:0}});
  if(this.#busy){this.#fatal=true;return result('revoked-or-expired',['reentrant-gate']);}
  this.#busy=true;
  try{
   if(this.#fatal)throw new Rejected('revoked-or-expired','gate-invalidated');
   const c=decode(p0ControlSchema,wire),t=this.#trust,missing:string[]=[];
   if(!c.lock||c.lock.sourceCommit===null||Object.values(c.lock.digests).some(v=>v===null)||!c.lock.configuration)missing.push('tool-image-unavailable');
   if(!c.lock?.solver)missing.push('solver-identity-unavailable');
   if(!c.method)missing.push('independent-method-unapproved');
   if(!c.environment)missing.push('environment-unapproved');
   if(!t)missing.push('registry-current-pin-unavailable');
   if(!c.preflight?.payload.reservations)missing.push('workspace-unavailable');
   if(!c.preflight?.payload.enforcementWitness||!c.preflight?.payload.clockMappingReceipt)missing.push('enforcement-unavailable');
   if(!c.preflight?.payload.bootstrapCapacity)missing.push('bootstrap-capacity-unavailable');
   // Validate all present signatures even when another group is missing.
   if(c.lock)checkConfig(c.lock);
   if(t){
    const signing=(payload:{issuer:string;keyId:string},sig:string,role:typeof P0_ROLES[number])=>{
     const owner=t.roles.find(r=>r.role===role)!;need(payload.issuer===owner.principal&&payload.keyId===owner.keyId,'signer-role-mismatch');
     need(Buffer.from(sig,'base64').toString('base64')===sig,'signature-encoding-invalid');
     need(verify(null,Buffer.from(canonicalOwnedJson(payload,1048576)),createPublicKey({key:Buffer.from(owner.spki,'base64'),format:'der',type:'spki'}),Buffer.from(sig,'base64')),'signature-invalid');
    };
    for(const kind of ['method','environment'] as const){const a=c[kind];if(!a)continue;
     signing(a.payload,a.signature,kind==='method'?'method-review-authority':'environment-review-authority');
     need(a.payload.approvalKind===kind&&a.payload.subjectDigest===t[kind].subjectDigest&&a.payload.methodOrEnvironmentProfileDigest===t[kind].profileDigest&&ownedDigest(a)===t[kind].envelopeDigest,'approval-subject-profile-pin-mismatch');
     need(a.payload.validFrom<a.payload.validUntil,'approval-validity-invalid');
     if(a.payload.registryRevision!==t.registryRevision)throw new Rejected('revoked-or-expired','approval-registry-stale');
    }
    if(c.lock&&!missing.includes('tool-image-unavailable')&&!missing.includes('solver-identity-unavailable')){
     need(ownedDigest(c.lock)===t.lockDigest&&c.lock.digests.methodProfileDigest===t.method.profileDigest,'tool-lock-pin-mismatch');
    }
    if(c.preflight){const p=c.preflight.payload;signing(p,c.preflight.signature,'workspace-controller');
     need(equal(p.job,t.job)&&p.toolLockDigest===t.lockDigest&&p.methodApprovalDigest===t.method.envelopeDigest&&p.environmentApprovalDigest===t.environment.envelopeDigest,'preflight-job-subject-mismatch');
     need(p.registryRevision===t.registryRevision&&p.registryPinDigest===t.registryPinDigest&&p.controllerRevision===t.controllerRevision&&p.reservationFence===t.reservationFence,'preflight-fence-mismatch');
     if(!equal(p.limits,P0_CAPACITY))throw new Rejected('workspace-budget-exceeded','workspace-profile-mismatch');
     if(p.reservations)need(ownedDigest(p.reservations)===t.reservationDigest,'reservation-pin-mismatch');
     if(p.enforcementWitness)need(ownedDigest(p.enforcementWitness)===t.enforcementDigest,'enforcement-pin-mismatch');
     if(p.bootstrapCapacity)need(ownedDigest(p.bootstrapCapacity)===t.bootstrapDigest,'bootstrap-pin-mismatch');
     if(p.clockMappingReceipt)need(ownedDigest(p.clockMappingReceipt)===t.clockReceiptDigest,'clock-pin-mismatch');
     if(c.lock?.configuration)need(p.sealedInputDigest===c.lock.configuration.sealedInputDigest,'sealed-input-mismatch');
     if(phase==='pre-exec')need(p.phase==='copied','post-copy-evidence-required');
     if(phase==='pre-publish'){
      if(p.result?.status!=='success')throw new Rejected('failed-no-success-envelope','full-success-result-required');
      need(p.phase==='sealed'&&p.drainWitness!==null&&p.sealWitness!==null,'drain-seal-evidence-required');
      need(c.lock?.configuration&&p.result.propertyClosureDigest===ownedDigest(c.lock.configuration.properties)&&p.result.loopClosureDigest===ownedDigest(c.lock.configuration.loops),'result-closure-mismatch');
     }
    }
   }
   if(missing.length)return result('unsupported',missing);
   need(t&&c.method&&c.environment,'metadata-incomplete');
   // Mapping is independently pinned, conservative and never recalculated from a retry packet.
   const mapped=(until:number)=>t.clock.monoAt+(until-t.clock.utcAt)-t.clock.errorMs;
   const mappedDeadline=Math.min(t.job.admittedAt+600000,t.job.leaseDeadline,mapped(c.method.payload.validUntil),mapped(c.environment.payload.validUntil));
   // Never place an unrepresentable deadline in the strict result, including the catch path.
   need(Number.isSafeInteger(mappedDeadline),'clock-mapping-invalid');
   if(mappedDeadline<0){this.#fatal=true;throw new Rejected('revoked-or-expired','approval-expired-before-clock-origin');}
   deadline=mappedDeadline;
   const wireLive=this.#live();
   if(wireLive===null)return result('unsupported',['registry-current-pin-unavailable']);
   const l=decode(p0LiveSchema,wireLive);
   if(this.#fatal||l.now<this.#lastTime||l.now>=deadline||l.stopping||l.fatal||l.methodRevoked||l.environmentRevoked||
    l.registryRevision!==t.registryRevision||l.registryPinDigest!==t.registryPinDigest||l.controllerRevision!==t.controllerRevision||
    l.reservationFence!==t.reservationFence||l.incarnation!==t.job.incarnation||l.reservationDigest!==t.reservationDigest||
    l.enforcementDigest!==t.enforcementDigest||l.bootstrapDigest!==t.bootstrapDigest||l.clockReceiptDigest!==t.clockReceiptDigest){
    this.#fatal=true;throw new Rejected('revoked-or-expired','current-authority-deadline-or-fence-rejected');
   }
   this.#lastTime=l.now;
   const utc=t.clock.utcAt+(l.now-t.clock.monoAt)-t.clock.errorMs;
   if(utc<c.method.payload.validFrom||utc<c.environment.payload.validFrom)throw new Rejected('revoked-or-expired','approval-not-yet-valid');
   return result('static-valid',['independent-validation-required-not-ready']);
  }catch(e){return result(e instanceof Rejected?e.status:'invalid',[e instanceof Rejected?e.reason:'schema-subject-argv-or-signature-mismatch']);}
  finally{this.#busy=false;}
 }
}
