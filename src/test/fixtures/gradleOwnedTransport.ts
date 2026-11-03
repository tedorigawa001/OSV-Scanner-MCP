/** Archive verifier for the B1ct VM diagnostic. Never enables production adoption. */
import {createPublicKey,verify} from 'node:crypto';
import {z} from 'zod';
import {canonicalOwnedJson,ownedSha256,parseOwnedJson} from '../../utils/gradleOwnedJson.js';
import {verifyB1cNativeLaunchBinding} from './gradleOwnedDeployment.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),n=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),pid=n.min(2),b64=z.string().max(512*1024);
const triple=z.tuple([n,n,n]),zero=z.literal('0000000000000000');
const identity=z.object({uid:triple,gid:triple,groups:z.array(n).length(0),capabilities:z.object({CapInh:zero,CapPrm:zero,CapEff:zero,CapBnd:zero,CapAmb:zero}).strict(),noNewPrivileges:z.literal(true)}).strict();
export const transportCasePlan=Object.freeze([
 ['preflight-queued-data',1,'rejected',0],['honest-reader',1,'accepted',2],['honest-upload',2,'accepted',2],['honest-publish',3,'accepted',2],
 ['wrong-role',1,'rejected',0],['server-proof',1,'rejected',0],['response-replay',1,'rejected',2],['request-replay',1,'rejected',1],
 ['proof-replay',1,'rejected',0],['session-replay',1,'rejected',0],
 ...['unknown-field','role-escalation','duplicate-key','noncanonical','invalid-integer','oversized','truncated','slow-drip','ancillary-fd','ancillary-many-fds'].map(name=>[name,1,'rejected',0]),
 ['same-uid-forward',1,'accepted',1],['cross-uid-fd-forward',2,'rejected',0],['cross-uid-fragment',2,'rejected',0],
 ['wrong-custodian',1,'rejected',0],['wrong-provider',1,'rejected',0],['restart-old-proof',1,'rejected',0],
 ['restart-old-response',1,'rejected',1],['restart-honest-reader',1,'accepted',2],
].map(row=>Object.freeze({case:row[0] as string,actor:row[1] as number,outcome:row[2] as string,operations:row[3] as number})));
const caseSchema=z.object({case:z.string().max(64),outcome:z.enum(['accepted','rejected']),verified:z.literal(true),acceptedOperations:n.max(2),identity,
 actorPid:pid.optional(),reason:z.string().max(128).optional(),providerCredentials:z.array(triple).max(1024).optional(),clientProofFrames:n.max(2).optional(),
 custodian:triple.optional(),elapsedMs:n.max(3500).optional(),providerFdCountAfter:z.literal(7).optional(),authenticated:z.boolean().optional(),
 serverRejectionReasons:z.array(z.string().max(128)).max(4).optional(),initialIdentity:identity.optional(),impostorIdentity:identity.optional()}).strict();
const ref=z.object({pid,fd:n.max(511),device:z.string().regex(/^[0-9]+$/),inode:z.string().regex(/^[0-9]+$/)}).strict();
const lifecycle=z.object({serviceOnlyRestartRejected:z.literal(true),oldProviderKilled:z.literal(true),oldConnectionEof:z.literal(true),oldConnectionReferenceObserved:z.literal(true),
 controllerPid:pid,holderPid:pid,holderIdentity:identity,referencesWithOldClient:z.array(ref).min(2).max(16),referencesBeforeReclaim:z.array(ref).min(1).max(16),
 referencesAfterHolderExit:z.array(ref).length(0),reclaimedKnownLeaves:z.literal(3),backendEligible:z.literal(false)}).strict();
const bodySchema=z.object({schema:z.literal('osv-mcp.q2b.native-transport-run.v1'),observation:z.object({schema:z.literal('osv-mcp.q2b.b1ct.native-observation.v1'),runId:z.string().max(64),
 manifestDigest:hash,manifest:z.unknown(),artifacts:z.array(z.unknown()).max(128),boots:z.array(z.object({caseId:z.enum(['native-boot-1','native-boot-2']),launch:b64,phases:z.array(z.unknown()).length(3),execs:z.array(z.unknown()).length(2)}).strict()).length(2),
 cases:z.array(caseSchema).length(28),verifiedCases:z.literal(28),lifecycle,nativeIsolationVerified:z.literal(false),backendEligible:z.literal(false),profileApproved:z.literal(false),originalReadsSkipped:z.literal(0)}).strict(),
 environment:z.object({imageUrl:z.literal('https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-arm64.img'),
 imageSha256:z.literal('6e971c7935c62c8ea7796b085e4ea038e2301a067f8c853e154133f8df192c85'),imageBytes:z.literal(224002048),
 qemu:z.string().max(256),outerKernel:z.string().max(128),guestNetwork:z.literal('restricted-user-network-hostfwd-loopback-ssh-only'),hostKeySha256:hash,
 acceleration:z.literal('tcg'),managerKeyProvisioned:z.literal(true),profile:z.literal('b1ct-native-diagnostic-only')}).strict(),
 sources:z.array(z.object({path:z.string().regex(/^q2b(?:_b1c|_b1ct)?\/[a-z_]+\.(?:py|c|h)$/),sha256:hash}).strict()).length(16)}).strict();
const recordSchema=z.object({schema:z.literal('osv-mcp.q2b.b1ct.public-record.v1'),manifest:b64,managerPublicKeyDer:b64,controllerPublicKeyDer:b64,
 launches:z.array(z.object({launch:b64,diagnostic:b64}).strict()).length(2),transportEvidence:b64}).strict();
const envelopeSchema=z.object({schema:z.literal('osv-mcp.q2b.evidence.v1'),role:z.literal('controller'),keyId:z.literal('controller-native'),body:z.unknown(),signature:b64}).strict();
function need(value:unknown,reason:string):asserts value{if(!value)throw new Error('q2b_transport_'+reason);}
function bytes(encoded:string){const value=Buffer.from(encoded,'base64');need(value.toString('base64')===encoded,'encoding');return value;}
function envelope(encoded:string,key:ReturnType<typeof createPublicKey>){const raw=bytes(encoded);need(raw.length<=512*1024,'budget');const value=envelopeSchema.parse(parseOwnedJson(raw.toString('utf8'),512*1024));need(canonicalOwnedJson(value,512*1024)===raw.toString('utf8'),'canonical');const {signature,...unsigned}=value;need(verify(null,Buffer.from(canonicalOwnedJson(unsigned,512*1024)),key,bytes(signature)),'signature');return value.body;}
type TransportInput={record:Buffer;managerKeyDigest:string;controllerKeyDigest:string;manifestDigest:string;runId:string};
/** All rejections carry a q2b_ reason: B1a binding errors pass through, parse/schema failures become q2b_transport_schema. */
export function verifyNativeTransportRun(input:TransportInput){
 try{return verifyRun(input);}catch(error){if(error instanceof Error&&error.message.startsWith('q2b_'))throw error;throw new Error('q2b_transport_schema');}
}
function verifyRun(input:TransportInput){
 need(Buffer.isBuffer(input.record)&&input.record.length<=1024*1024,'budget');const r=recordSchema.parse(parseOwnedJson(input.record.toString('utf8'),1024*1024));
 const managerDer=bytes(r.managerPublicKeyDer),controllerDer=bytes(r.controllerPublicKeyDer);
 need(ownedSha256(managerDer)===input.managerKeyDigest&&ownedSha256(controllerDer)===input.controllerKeyDigest&&!managerDer.equals(controllerDer),'independent_key_pin');
 const manager=createPublicKey({key:managerDer,format:'der',type:'spki'}),controller=createPublicKey({key:controllerDer,format:'der',type:'spki'});
 need(manager.asymmetricKeyType==='ed25519'&&controller.asymmetricKeyType==='ed25519','key_type');
 const body=bodySchema.parse(envelope(r.transportEvidence,controller)),o=body.observation,manifest=bytes(r.manifest);
 need(ownedSha256(manifest)===input.manifestDigest&&o.manifestDigest===input.manifestDigest&&o.runId===input.runId&&canonicalOwnedJson(o.manifest)===manifest.toString('utf8'),'independent_manifest_pin');
 const launches=r.launches.map((entry,i)=>{
  const boot=o.boots[i]!;need(boot.caseId==='native-boot-'+(i+1)&&entry.launch===boot.launch,'boot_binding');
  const diagnostic=envelope(entry.diagnostic,controller) as Record<string,unknown>;
  need(canonicalOwnedJson(diagnostic.phases)===canonicalOwnedJson(boot.phases)&&canonicalOwnedJson(diagnostic.execs)===canonicalOwnedJson(boot.execs)&&canonicalOwnedJson(diagnostic.artifacts)===canonicalOwnedJson(o.artifacts),'observation_binding');
  return verifyB1cNativeLaunchBinding({manifest,expectedManifestDigest:input.manifestDigest,launch:bytes(entry.launch),diagnostic:bytes(entry.diagnostic),
   manager:{keyId:'manager-native',publicKey:manager},controller:{keyId:'controller-native',publicKey:controller},runId:input.runId,caseId:boot.caseId});
 });
 const launchBodies=r.launches.map(e=>(parseOwnedJson(bytes(e.launch).toString('utf8')) as {body:{providerBoot:string;listeners:{cookie:string}[];pid:number}}).body);
 need(launchBodies[0]!.providerBoot!==launchBodies[1]!.providerBoot&&launchBodies[0]!.listeners.every(a=>launchBodies[1]!.listeners.every(b=>a.cookie!==b.cookie)),'generation_reused');
 need(new Set(o.cases.map(c=>c.case)).size===transportCasePlan.length,'case_closure');
 const rejection:Record<string,string>={'request-replay':'request-binding','session-replay':'request-binding','proof-replay':'proof-binding','restart-old-proof':'proof-binding',
  'unknown-field':'request-binding','role-escalation':'request-binding','invalid-integer':'request-binding','duplicate-key':'duplicate-key','noncanonical':'noncanonical',
  oversized:'frame-budget',truncated:'credential-missing','ancillary-fd':'ancillary-invalid','ancillary-many-fds':'ancillary-invalid'};
 for(const expected of transportCasePlan){const c=o.cases.find(c=>c.case===expected.case);need(c&&c.outcome===expected.outcome&&c.acceptedOperations===expected.operations,'case_expectation');
  need(c.identity.uid.every(n=>n===1101+expected.actor)&&c.identity.gid.every(n=>n===1201+expected.actor),'actor');
  const special=['preflight-queued-data','same-uid-forward','cross-uid-fd-forward','cross-uid-fragment','wrong-custodian','wrong-provider'].includes(c.case);
  if(!special){need(c.providerFdCountAfter===7&&c.authenticated===!['wrong-role','server-proof','restart-old-proof'].includes(c.case),'incomplete_case');
   const frames=c.case==='wrong-role'||c.case==='server-proof'?0:c.case==='proof-replay'||c.case==='session-replay'?2:1;need(c.clientProofFrames===frames,'proof_boundary');
   const provider=launchBodies[c.case.startsWith('restart-')?1:0]!.pid;
   need(c.providerCredentials&&(c.case==='wrong-role'?c.providerCredentials.length===0:c.providerCredentials.length>=2),'provider_credential');
   need(c.providerCredentials?.every(peer=>peer[0]===provider&&peer[1]===1101&&peer[2]===1201),'provider_credential');}
  if(rejection[c.case])need(c.serverRejectionReasons?.includes(rejection[c.case]!), 'rejection_not_exercised');
  if(c.case==='server-proof')need(c.reason==='signature-invalid','server_proof');
  if(['response-replay','restart-old-response'].includes(c.case))need(c.reason==='response-binding','response_binding');
  if(c.case==='slow-drip')need(c.elapsedMs!>=1500&&c.serverRejectionReasons?.some(r=>r==='deadline'||r==='timed out'),'deadline');
  if(c.case==='preflight-queued-data')need(c.clientProofFrames===0,'queued_data');
  if(c.case.startsWith('cross-uid-'))need(c.initialIdentity?.uid.every(n=>n===1102)&&c.initialIdentity.gid.every(n=>n===1202)&&c.serverRejectionReasons?.includes('credential-mismatch'),'fd_forward');
  if(c.case==='same-uid-forward')need(c.initialIdentity?.uid.every(n=>n===1102)&&c.initialIdentity.gid.every(n=>n===1202),'same_principal');
  if(c.case==='wrong-custodian')need(c.reason==='custodian-mismatch'&&c.clientProofFrames===0&&c.custodian?.[1]===1102&&c.custodian?.[2]===1202&&c.impostorIdentity?.uid.every(n=>n===1102)&&c.impostorIdentity.gid.every(n=>n===1202),'custodian');
  if(c.case==='wrong-provider')need(c.reason==='credential-mismatch'&&c.clientProofFrames===0&&c.custodian?.[1]===0&&c.custodian?.[2]===0&&c.impostorIdentity?.uid.every(n=>n===1103)&&c.impostorIdentity.gid.every(n=>n===1203),'provider_sender');
 }
 const life=o.lifecycle;need(life.holderIdentity.uid.every(n=>n===1102)&&life.holderIdentity.gid.every(n=>n===1202)&&life.holderPid!==life.controllerPid&&
  life.referencesWithOldClient.some(r=>r.pid===life.controllerPid)&&life.referencesBeforeReclaim.every(r=>r.pid===life.holderPid),'fd_drain');
 need(new Set(body.sources.map(s=>s.path)).size===body.sources.length,'source_closure');
 const sourcePlan=['q2b/build_fixture.py','q2b/launcher.c','q2b/native_probe.py','q2b/provider.py',
  ...['build_fixture.py','guest_deploy.py','guest_probe.py','vm_runner.py'].map(p=>'q2b_b1c/'+p),
  ...['auth.py','build_fixture.py','client_probe.py','guest_deploy.py','guest_probe.py','manager.h','provider_tail.py','vm_runner.py'].map(p=>'q2b_b1ct/'+p)];
 need(canonicalOwnedJson(body.sources.map(s=>s.path).sort())===canonicalOwnedJson(sourcePlan.sort()),'source_closure');
 return Object.freeze({verifiedCases:o.cases.length,acceptedCases:o.cases.filter(c=>c.outcome==='accepted').length,
  nativeLaunchBindingsVerified:launches.length,authenticatedTransportObserved:true as const,restartFdDrainObserved:true as const,
  nativeIsolationVerified:false as const,profileApproved:false as const,backendEligible:false as const,originalReadsSkipped:0 as const});
}
