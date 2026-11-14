/** Synthetic keys/evidence ONLY; these are not a provisioned authority, tool image or reservation. */
import {generateKeyPairSync,sign} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as digest} from '../../utils/gradleOwnedJson.js';
import {P0Verifier,P0_ROLES,P0_CAPACITY,P0_VERIFIER_FLAGS,P0_COMPILER_FLAGS,
 type P0Lock,type P0Approval,type P0Preflight,type P0Trust,p0LiveSchema} from '../../utils/gradleOwnedP0Contract.js';
import type {z} from 'zod';

const keys=P0_ROLES.map(()=>generateKeyPairSync('ed25519'));
export function p0Fixture(){
 const roles=P0_ROLES.map((role,i)=>({role,principal:'principal-'+i,keyId:'key-'+i,spki:keys[i]!.publicKey.export({format:'der',type:'spki'}).toString('base64'),store:'store-'+i,aclDigest:digest('acl-'+i)}));
 const configuration:P0Lock['configuration']={verifierPath:'/sealed/bin/cbmc',compilerPath:'/sealed/bin/clang',entrypoint:'kernel',inputPath:'/job/input/kernel.c',outputPath:'/job/output/kernel.o',
  verifierArgv:['/sealed/bin/cbmc',...P0_VERIFIER_FLAGS,'--function','kernel','--unwindset','kernel.0:3073','/job/input/kernel.c'],
  compilerArgv:['/sealed/bin/clang',...P0_COMPILER_FLAGS,'/job/input/kernel.c','-o','/job/output/kernel.o'],
  environment:{LC_ALL:'C',TZ:'UTC',TMPDIR:'/job/tmp'},cwd:'/job',shell:false,network:false,
  effectiveDefaultsDigest:digest('defaults'),capabilityReceiptDigest:digest('capabilities'),preprocessorDigest:digest('preprocess'),headerClosureDigest:digest('headers'),
  outputSchemaDigest:digest('output-schema'),sealedInputDigest:digest('sealed-input'),properties:['bounds','overflow'],loops:[{id:'kernel.0',bound:3073,includesFinalCondition:true}]};
 const lock:P0Lock={schema:'cwc.e2-p0.acquisition-lock.v1',acquisition:'official-tagged-source',sourceCommit:'a'.repeat(40),
  verifier:{version:'6.8.0',tag:'cbmc-6.8.0',origin:'https://github.com/diffblue/cbmc/releases/tag/cbmc-6.8.0'},
  compiler:{version:'21.1.8',tag:'llvmorg-21.1.8',origin:'https://github.com/llvm/llvm-project/releases/tag/llvmorg-21.1.8',sourceCommit:digest('llvm-commit'),sourceArchiveDigest:digest('llvm-archive')},
  profile:'cwc.e2-p0.linux-x86_64.v1',imagePlatform:'linux/amd64',abi:'LP64-little-endian-char8',
  digests:{sourceArchiveDigest:digest('archive'),dependencyLockDigest:digest('dependencies'),builderImageDigest:digest('builder'),buildArgvDigest:digest('build'),baseImageDigest:digest('base'),
   sysrootDigest:digest('sysroot'),verifierBinaryDigest:digest('cbmc'),compilerBinaryDigest:digest('clang'),linkerBinaryDigest:digest('ld'),sharedLibraryClosureDigest:digest('shared'),
   loaderDigest:digest('loader'),runnerImageDigest:digest('runner'),rootfsDigest:digest('rootfs'),runtimeKernelProfile:digest('kernel-profile'),methodProfileDigest:digest('method-profile'),
   quarantineReceiptDigest:digest('quarantine'),custodyReservationDigest:digest('custody')},
  solver:{kind:'embedded-MiniSat-only',componentVersion:'fixture-component',sourceDigest:digest('minisat-source'),buildDigest:digest('minisat-build'),containingBinaryDigest:digest('cbmc'),containingImageDigest:digest('runner'),externalFallback:false},configuration};
 const signApproval=(p:P0Approval['payload'],index:number):P0Approval=>({payload:p,signature:sign(null,Buffer.from(canonical(p)),keys[index]!.privateKey).toString('base64')});
 const method=signApproval({domain:'cwc.e2-p0.approval.v1',approvalKind:'method',issuer:roles[2]!.principal,keyId:roles[2]!.keyId,subjectDigest:digest('method-subject'),methodOrEnvironmentProfileDigest:digest('method-profile'),validFrom:0,validUntil:3600000,registryRevision:7,limitations:['synthetic-static-fixture-only'],signatureAlgorithm:'Ed25519'},2);
 const environment=signApproval({...method.payload,approvalKind:'environment',issuer:roles[3]!.principal,keyId:roles[3]!.keyId,subjectDigest:digest('environment-subject'),methodOrEnvironmentProfileDigest:digest('environment-profile')},3);
 const ref=(id:string)=>({id,sha256:digest(id),byteLength:512});
 const job={jobId:'job-1',nonce:digest('nonce'),incarnation:'controller-1',sequence:1,sourceDigest:digest('source'),inputManifestDigest:digest('input-manifest'),admittedAt:0,leaseDeadline:900000};
 const reservations={job:ref('job-reservation'),store:ref('store-reservation'),controller:ref('controller-reservation'),watchdog:ref('watchdog-reservation'),bootstrap:ref('bootstrap-reservation')};
 const preflight:P0Preflight={payload:{domain:'cwc.e2-p0.preflight.v1',issuer:roles[4]!.principal,keyId:roles[4]!.keyId,signatureAlgorithm:'Ed25519',job,registryRevision:7,registryPinDigest:digest('registry-pin'),
  toolLockDigest:digest(lock),methodApprovalDigest:digest(method),environmentApprovalDigest:digest(environment),workspaceProfile:'cwc.e2-p0.workspace.v1',limits:{...P0_CAPACITY},reservations,
  enforcementWitness:ref('enforcement'),clockMappingReceipt:ref('clock'),bootstrapCapacity:ref('bootstrap'),controllerRevision:1,reservationFence:3,sealedInputDigest:configuration.sealedInputDigest,
  phase:'reserved',result:null,drainWitness:null,sealWitness:null},signature:''};
 const resignPreflight=()=>{preflight.signature=sign(null,Buffer.from(canonical(preflight.payload)),keys[4]!.privateKey).toString('base64');};resignPreflight();
 const trust:P0Trust={schema:'cwc.e2-p0.trusted-pins.v1',registryRevision:7,registryPinDigest:digest('registry-pin'),lockDigest:digest(lock),
  method:{subjectDigest:method.payload.subjectDigest,profileDigest:method.payload.methodOrEnvironmentProfileDigest,envelopeDigest:digest(method)},
  environment:{subjectDigest:environment.payload.subjectDigest,profileDigest:environment.payload.methodOrEnvironmentProfileDigest,envelopeDigest:digest(environment)},job:structuredClone(job),roles,
  reservationDigest:digest(reservations),enforcementDigest:digest(preflight.payload.enforcementWitness),bootstrapDigest:digest(preflight.payload.bootstrapCapacity),clockReceiptDigest:digest(preflight.payload.clockMappingReceipt),
  controllerRevision:1,reservationFence:3,clock:{monoAt:0,utcAt:0,errorMs:1000}};
 const live:z.infer<typeof p0LiveSchema>={schema:'cwc.e2-p0.live.v1',now:1000,registryRevision:7,registryPinDigest:trust.registryPinDigest,controllerRevision:1,reservationFence:3,incarnation:job.incarnation,
  methodRevoked:false,environmentRevoked:false,stopping:false,fatal:false,reservationDigest:trust.reservationDigest,enforcementDigest:trust.enforcementDigest,bootstrapDigest:trust.bootstrapDigest,clockReceiptDigest:trust.clockReceiptDigest};
 const packet={schema:'cwc.e2-p0.control.v1' as const,lock,method,environment,preflight};
 return {lock,method,environment,preflight,trust,live,packet,wire:()=>JSON.stringify(packet),resignPreflight,signApproval,
  verifier:(port:()=>string|null=()=>JSON.stringify(live))=>new P0Verifier(JSON.stringify(trust),port)};
}
