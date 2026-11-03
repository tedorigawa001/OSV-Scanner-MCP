/** Verifies a limited single-seal native storage diagnostic; never grants authority. */
import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {canonicalOwnedJson,ownedDigest,ownedSha256,parseOwnedJson} from '../../utils/gradleOwnedJson.js';
import {verifyB1cNativeLaunchBinding} from './gradleOwnedDeployment.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/),n=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),b64=z.string().max(4*1024*1024);
const triple=z.tuple([n,n,n]),zero=z.literal('0000000000000000');
const identity=z.object({uid:triple,gid:triple,groups:z.array(n).length(0),capabilities:z.object({CapInh:zero,CapPrm:zero,CapEff:zero,CapBnd:zero,CapAmb:zero}).strict(),noNewPrivileges:z.literal(true)}).strict();
const pinsSchema=z.object({schema:z.literal('osv-mcp.q2b.auth-pins.v1'),runId:z.string().max(64),keys:z.object({manager:b64,provider:b64,reader:b64,upload:b64,publish:b64}).strict()}).strict();
const syncs=z.object({file:n,directory:n}).strict();
const callSchema=z.object({case:z.string().max(64),identity,actorPid:n.min(2),response:z.unknown(),request:z.unknown(),proof:z.unknown(),challenge:z.unknown(),providerCredentials:z.array(triple).min(4).max(1024),clientProofFrames:z.literal(1),providerBoot:hash}).strict();
const bootSchema=z.object({caseId:z.string().max(64),launch:b64,phases:z.array(z.unknown()).length(3),execs:z.array(z.unknown()).length(2),storage:z.unknown(),recoveryAnchor:z.object({sealDigest:hash.nullable()}).strict(),serviceState:z.string().max(128)}).strict();
const rootSchema=z.object({device:z.string().regex(/^[0-9]+$/),inode:z.string().regex(/^[0-9]+$/)}).strict();
const recordSchema=z.object({schema:z.literal('osv-mcp.q2b.storage.public-record.v1'),managerPublicKeyDer:b64,controllerPublicKeyDer:b64,authPins:pinsSchema,
 launches:z.array(z.object({launch:b64,diagnostic:b64}).strict()).length(24),evidence:b64}).strict();
const observationSchema=z.object({schema:z.literal('osv-mcp.q2b.native-storage-observation.v1'),runId:z.string().max(64),manifest:z.unknown(),manifestDigest:hash,artifacts:z.array(z.unknown()).max(128),
 boots:z.array(bootSchema).length(24),calls:z.array(callSchema).length(31),
 staleRequest:z.object({identity,actorPid:n.min(2),replayRejected:z.literal(true),connectionEnd:z.enum(['eof','reset-unread-data']),requestDigest:hash,providerBoot:hash,providerCredentials:z.array(triple).min(4).max(1024),clientProofFrames:z.literal(1),serverRejection:z.unknown()}).strict(),
 malformedRequest:z.object({identity,actorPid:n.min(2),replayRejected:z.literal(true),connectionEnd:z.enum(['eof','reset-unread-data']),request:z.unknown(),providerBoot:hash,providerCredentials:z.array(triple).min(4).max(1024),clientProofFrames:z.literal(1),serverRejection:z.unknown()}).strict(),
 isolation:z.array(z.object({identity,actorPid:n.min(2),principalIndex:n.min(1).max(5),allowControl:z.literal(true),denied:z.array(z.object({operation:z.string().max(64),errno:z.union([z.literal(1),z.literal(13)])}).strict()).length(13)}).strict()).length(5),
 faults:z.array(z.object({fault:z.string().max(64),recoveryRejected:z.literal(true),successRecordsAddedDuringRecovery:z.literal(0),partialInventory:z.array(z.string().max(64)).max(5),reason:z.string().max(128)}).strict()).length(8),
 tampering:z.array(z.object({mutation:z.string().max(64),recoveryRejected:z.literal(true),reason:z.string().max(128)}).strict()).length(3),
 sealedEvidence:z.array(z.object({seal:b64,selected:b64,intent:b64,payload:b64,root:rootSchema}).strict()).length(4),events:z.array(z.unknown()).max(256),
 mount:z.object({filesystem:z.literal('ext4'),options:z.array(z.string().max(128)).max(32)}).strict(),payloadDigest:hash,serviceRestartRecoveryObserved:z.literal(true),vmPowerLossTested:z.literal(false),
 nativeIsolationVerified:z.literal(false),independentRegistryVerified:z.literal(false),profileApproved:z.literal(false),backendEligible:z.literal(false),originalReadsSkipped:z.literal(0)}).strict();
function need(ok:unknown,reason:string):asserts ok{if(!ok)throw new Error('storage_native_'+reason);}
function decode(raw:Buffer,max=4*1024*1024){need(raw.length<=max,'budget');const value=parseOwnedJson(raw.toString('utf8'),max);need(canonicalOwnedJson(value,max)===raw.toString('utf8'),'canonical');return value;}
function bytes(value:string){const raw=Buffer.from(value,'base64');need(raw.toString('base64')===value,'encoding');return raw;}
function publicKey(der:Buffer){const key=createPublicKey({key:der,format:'der',type:'spki'});need(key.asymmetricKeyType==='ed25519','key_type');return key;}
function rawKey(encoded:string){const raw=bytes(encoded);need(raw.length===32,'key_size');return publicKey(Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),raw]));}
function envelope(raw:Buffer,key:KeyObject,kind:'controller'|'auth'|'seal',role='provider'):any{
 const value=decode(raw) as any;
 if(kind==='controller')need(Object.keys(value).sort().join()===['body','keyId','role','schema','signature'].sort().join()&&value.schema==='osv-mcp.q2b.evidence.v1'&&value.role==='controller'&&value.keyId==='controller-native','envelope');
 if(kind==='auth')need(Object.keys(value).sort().join()===['body','keyId','schema','signature'].sort().join()&&value.schema==='osv-mcp.q2b.auth-frame.v1'&&value.keyId===role,'envelope');
 if(kind==='seal')need(Object.keys(value).sort().join()===['body','schema','signature'].sort().join()&&value.schema==='osv-mcp.q2b.storage-seal.v1','envelope');
 const {signature,...unsigned}=value;need(typeof signature==='string'&&verify(null,Buffer.from(canonicalOwnedJson(unsigned,4*1024*1024)),key,bytes(signature)),'signature');return value.body;
}
export const STORAGE_FAULTS=Object.freeze(['write','file-limit','file-sync','directory-sync','after-data','after-seal','after-selection','before-response']);
export const STORAGE_ISOLATION_OPERATIONS=Object.freeze(['read','write','create','unlink','rename','hardlink','symlink','root-rename','proc-fd','ptrace','pidfd-getfd','signal','mount-namespace']);
export function verifyStorageNativeRun(input:{record:Buffer;managerKeyDigest:string;controllerKeyDigest:string;manifestDigest:string;runId:string}){
 try{return verifyRun(input);}catch(error){if(error instanceof Error&&/^(storage_native_|q2b_)/.test(error.message))throw error;throw new Error('storage_native_schema');}
}
function verifyRun(input:Parameters<typeof verifyStorageNativeRun>[0]){
 need(Buffer.isBuffer(input.record)&&input.record.length<=8*1024*1024,'budget');
 // The public archive is pretty JSON. Canonical bytes are mandatory for signed
 // envelopes inside it, not the unsigned archival wrapper.
 const r=recordSchema.parse(parseOwnedJson(new TextDecoder('utf-8',{fatal:true}).decode(input.record),8*1024*1024)),managerDer=bytes(r.managerPublicKeyDer),controllerDer=bytes(r.controllerPublicKeyDer);
 need(ownedSha256(managerDer)===input.managerKeyDigest&&ownedSha256(controllerDer)===input.controllerKeyDigest&&!managerDer.equals(controllerDer),'independent_key_pin');
 const manager=publicKey(managerDer),controller=publicKey(controllerDer);
 const run=z.object({schema:z.literal('osv-mcp.q2b.storage.controller-run.v1'),observation:observationSchema,environment:z.object({
  imageUrl:z.literal('https://cloud-images.ubuntu.com/minimal/releases/noble/release/ubuntu-24.04-minimal-cloudimg-arm64.img'),imageSha256:z.literal('6e971c7935c62c8ea7796b085e4ea038e2301a067f8c853e154133f8df192c85'),imageBytes:z.literal(224002048),
  qemu:z.string(),outerKernel:z.string(),guestNetwork:z.literal('restricted-user-network-hostfwd-loopback-ssh-only'),hostKeySha256:hash,acceleration:z.literal('tcg'),managerKeyProvisioned:z.literal(true),profile:z.literal('single-seal-native-storage-diagnostic-only')}).strict(),
  sources:z.array(z.object({path:z.string().regex(/^q2b(?:_b1c|_b1ct|_storage)?\/[a-z_]+\.(?:py|c|h)$/),sha256:hash}).strict()).length(23)}).strict().parse(envelope(bytes(r.evidence),controller,'controller'));
 const o=run.observation,manifestRaw=Buffer.from(canonicalOwnedJson(o.manifest)),manifest=o.manifest as any;
 need(ownedSha256(manifestRaw)===input.manifestDigest&&o.manifestDigest===input.manifestDigest&&o.runId===input.runId&&r.authPins.runId===input.runId,'manifest_pin');
 need(manifest.platform.filesystem==='ext4'&&['rw','nosuid','nodev','noexec'].every(x=>o.mount.options.includes(x)),'mount');
 need(manifest.artifacts.some((a:any)=>a.path==='/opt/osv-q2b/b1ct/auth-pins.json'&&a.sha256===ownedDigest(r.authPins)),'auth_pin');
 need(bytes(r.authPins.keys.manager).equals(managerDer.subarray(-32)),'manager_pin');
 need(new Set(Object.values(r.authPins.keys)).size===5,'independent_role_keys');
 const provider=rawKey(r.authPins.keys.provider),boots=new Map<string,{body:any;boot:typeof o.boots[number];digest:string}>(),cookies=new Set<string>(),caseIds=new Set<string>();
 const expectedBoots=['native-boot-1','storage-recovered',...Array.from({length:3},(_,i)=>['tamper-'+i+'-new','tamper-'+i+'-recovery']).flat(),...STORAGE_FAULTS.flatMap((_,i)=>['fault-'+i+'-new','fault-'+i+'-recovery'])];
 need(canonicalOwnedJson(o.boots.map(b=>b.caseId))===canonicalOwnedJson(expectedBoots),'boot_plan');
 for(const [i,boot]of o.boots.entries()){
  const saved=r.launches[i]!;need(saved.launch===boot.launch&&!caseIds.has(boot.caseId),'boot');caseIds.add(boot.caseId);
  const launchRaw=bytes(boot.launch),body=(decode(launchRaw) as any).body,diagnostic=envelope(bytes(saved.diagnostic),controller,'controller');
  need(canonicalOwnedJson(diagnostic.phases)===canonicalOwnedJson(boot.phases)&&canonicalOwnedJson(diagnostic.execs)===canonicalOwnedJson(boot.execs)&&canonicalOwnedJson(diagnostic.artifacts)===canonicalOwnedJson(o.artifacts),'observation_binding');
  verifyB1cNativeLaunchBinding({manifest:manifestRaw,expectedManifestDigest:input.manifestDigest,launch:launchRaw,diagnostic:bytes(saved.diagnostic),
   manager:{keyId:'manager-native',publicKey:manager},controller:{keyId:'controller-native',publicKey:controller},runId:input.runId,caseId:boot.caseId,diagnosticFilesystem:'ext4'});
  need(!boots.has(body.providerBoot),'boot_reused');for(const l of body.listeners){need(!cookies.has(l.cookie),'cookie_reused');cookies.add(l.cookie);}
  const digest=ownedSha256(launchRaw);boots.set(body.providerBoot,{body,boot,digest});
  const ready=z.object({kind:z.literal('storage-ready'),recovered:z.boolean(),syncs,launchDigest:hash}).strict();
  const failed=z.object({kind:z.literal('recovery-rejected'),reason:z.string().max(128),launchDigest:hash}).strict();
  const event=z.union([ready,failed]).parse(boot.storage);need(event.launchDigest===digest,'storage_boot');
  const stateLines=boot.serviceState.split('\n'),state=Object.fromEntries(stateLines.map(line=>line.split('=')));
  need(stateLines.length===2&&stateLines.every(line=>/^(?:ActiveState=(?:active|failed)|ExecMainStatus=[0-9]+)$/.test(line))&&Object.keys(state).sort().join()==='ActiveState,ExecMainStatus','service_state');
  if(event.kind==='recovery-rejected')need(state.ActiveState==='failed'&&state.ExecMainStatus==='1','failed_process');
  else {need(state.ActiveState==='active'&&state.ExecMainStatus==='0','ready_process');need(event.syncs.file===(event.recovered?4:0)&&event.syncs.directory===(event.recovered?1:0),'recovery_sync');need(event.recovered===(boot.caseId==='storage-recovered'),'recovery_state');}
 }
 const plan=new Map<string,{role:string;operation:string;ok:boolean}>();const add=(name:string,role:string,operation:string,ok=true)=>plan.set(name,{role,operation,ok});
 add('empty','reader','read-state');add('stage','upload','stage');add('seal','publish','seal');add('wrong-role','reader','stage',false);add('read-sealed','reader','read-state');add('read-recovered','reader','read-state');
 for(const mutation of ['data','unknown-entry','symlink']){add(mutation+'-stage','upload','stage');add(mutation+'-seal','publish','seal');}
 for(const fault of STORAGE_FAULTS){const op=['write','file-limit','file-sync','directory-sync','after-data'].includes(fault)?'stage':'seal';if(op==='seal')add(fault+'-stage','upload','stage');add(fault,op==='stage'?'upload':'publish',op,false);add(fault+'-stopped','reader','read-state',false);}
 const seen=new Set<string>(),responses=new Map<string,any>();
 for(const c of o.calls){const expected=plan.get(c.case);need(expected&&!seen.has(c.case),'case_closure');seen.add(c.case);
  const index=['reader','upload','publish'].indexOf(expected.role)+1;need(c.identity.uid.every(x=>x===1101+index)&&c.identity.gid.every(x=>x===1201+index),'principal');
  const boot=boots.get(c.providerBoot);need(boot&&c.providerCredentials.every(p=>p[0]===boot.body.pid&&p[1]===1101&&p[2]===1201),'credentials');
  const client=rawKey(r.authPins.keys[expected.role as 'reader'|'upload'|'publish']),request=envelope(Buffer.from(canonicalOwnedJson(c.request)),client,'auth',expected.role),response=envelope(Buffer.from(canonicalOwnedJson(c.response)),provider,'auth');
  const challenge=envelope(Buffer.from(canonicalOwnedJson(c.challenge)),provider,'auth'),proof=envelope(Buffer.from(canonicalOwnedJson(c.proof)),client,'auth',expected.role);
  const context={manifestDigest:input.manifestDigest,launchDigest:boot.digest,providerBoot:c.providerBoot,providerPid:boot.body.pid,runId:input.runId,caseId:boot.boot.caseId,instanceId:'b1ct',profileDigest:manifest.policyDigest};
  need(canonicalOwnedJson(challenge)===canonicalOwnedJson({kind:'server-challenge',...context,role:expected.role,clientPid:c.actorPid,clientUid:1101+index,clientGid:1201+index,serverNonce:challenge.serverNonce,sequence:0})&&/^[a-f0-9]{64}$/.test(challenge.serverNonce),'challenge');
  need(canonicalOwnedJson(proof)===canonicalOwnedJson({kind:'client-proof',challengeDigest:ownedDigest(c.challenge),serverNonce:challenge.serverNonce,clientNonce:proof.clientNonce,role:expected.role,providerBoot:c.providerBoot,launchDigest:boot.digest,sequence:0})&&/^[a-f0-9]{64}$/.test(proof.clientNonce),'proof');
  const session=ownedDigest({context,role:expected.role,peer:[c.actorPid,1101+index,1201+index],serverNonce:proof.serverNonce,clientNonce:proof.clientNonce});
  need(Object.keys(request).sort().join()===['kind','sessionId','sequence','operation','requestId','argument'].sort().join()&&request.kind==='request'&&request.sequence===1&&request.sessionId===session&&request.operation===expected.operation&&/^[a-f0-9]{64}$/.test(request.requestId),'request');
  need(Object.keys(response).sort().join()===['kind','sessionId','sequence','requestDigest','operation','outcome','reason','result','backendEligible','originalReadsSkipped'].sort().join()&&response.kind==='storage-response'&&response.sessionId===session&&response.sequence===1&&response.requestDigest===ownedDigest(c.request)&&response.operation===expected.operation&&response.outcome===(expected.ok?'accepted':'rejected')&&response.backendEligible===false&&response.originalReadsSkipped===0,'response');
  if(!expected.ok){const reason=c.case==='wrong-role'?'storage-role':c.case.endsWith('-stopped')?'storage-unavailable':c.case==='file-limit'?'File too large':'injected-'+c.case;need(response.result===null&&typeof response.reason==='string'&&response.reason.includes(reason),'rejection');}
  else {
   need(response.reason===null,'result');
   const head={sealDigest:hash,dataDigest:hash,size:n.min(1).max(512),generation:z.literal(1)};
   if(expected.operation==='stage'){
    const result=z.object({phase:z.literal('staged'),dataDigest:hash,size:n.min(1).max(512)}).strict().parse(response.result),argument=z.object({payload:b64}).strict().parse(request.argument),data=bytes(argument.payload);
    need(data.length===result.size&&ownedSha256(data)===result.dataDigest&&result.dataDigest===o.payloadDigest,'stage_content');
   }else {
    need(canonicalOwnedJson(request.argument)==='{}','argument');
    if(expected.operation==='seal')z.object({phase:z.literal('sealed'),...head}).strict().parse(response.result);
    else if(c.case==='empty')z.object({phase:z.literal('empty'),recovered:z.literal(false)}).strict().parse(response.result);
    else {const result=z.object({phase:z.literal('sealed'),...head,recovered:z.boolean(),payload:b64}).strict().parse(response.result);need(result.recovered===(c.case==='read-recovered')&&ownedSha256(bytes(result.payload))===result.dataDigest&&bytes(result.payload).length===result.size,'read_content');}
   }
  }
  responses.set(c.case,response);
 }
 need(seen.size===plan.size,'case_closure');
 const seal=responses.get('seal').result,recovered=responses.get('read-recovered').result;
 need(seal.phase==='sealed'&&seal.dataDigest===o.payloadDigest&&recovered.recovered===true&&recovered.sealDigest===seal.sealDigest&&ownedSha256(bytes(recovered.payload))===o.payloadDigest,'recovered_content');
 for(const boot of o.boots){const index=/^tamper-([0-2])-recovery$/.exec(boot.caseId),expected=boot.caseId==='storage-recovered'?seal.sealDigest:index?responses.get(['data','unknown-entry','symlink'][Number(index[1])]+'-seal').result.sealDigest:null;need(boot.recoveryAnchor.sealDigest===expected,'recovery_anchor');}
 const stale=o.staleRequest,stage=o.calls.find(c=>c.case==='stage')!,staleBoot=boots.get(stale.providerBoot);
 need(staleBoot?.boot.caseId==='storage-recovered'&&stale.requestDigest===ownedDigest(stage.request)&&stale.identity.uid.every(x=>x===1103)&&stale.identity.gid.every(x=>x===1203)&&stale.providerCredentials.every(p=>p[0]===staleBoot.body.pid&&p[1]===1101&&p[2]===1201),'stale_request');
 need(canonicalOwnedJson(stale.serverRejection)===canonicalOwnedJson({kind:'rejected',role:'upload',peer:[stale.actorPid,1103,1203],reason:'request-binding',launchDigest:staleBoot.digest}),'stale_request');
 const malformed=o.malformedRequest,malformedBoot=boots.get(malformed.providerBoot),malformedBody=envelope(Buffer.from(canonicalOwnedJson(malformed.request)),rawKey(r.authPins.keys.upload),'auth','upload');
 need(malformedBoot?.boot.caseId==='storage-recovered'&&canonicalOwnedJson(malformedBody)==='[{}]'&&malformed.identity.uid.every(x=>x===1103)&&malformed.identity.gid.every(x=>x===1203)&&malformed.providerCredentials.every(p=>p[0]===malformedBoot.body.pid&&p[1]===1101&&p[2]===1201),'malformed_request');
 need(canonicalOwnedJson(malformed.serverRejection)===canonicalOwnedJson({kind:'rejected',role:'upload',peer:[malformed.actorPid,1103,1203],reason:'signature-domain',launchDigest:malformedBoot.digest}),'malformed_request');
 for(const [i,c]of o.isolation.entries())need(c.principalIndex===i+1&&c.identity.uid.every(x=>x===1102+i)&&c.identity.gid.every(x=>x===1202+i)&&canonicalOwnedJson(c.denied.map(x=>x.operation))===canonicalOwnedJson(STORAGE_ISOLATION_OPERATIONS),'isolation');
 need(canonicalOwnedJson(o.faults.map(f=>f.fault))===canonicalOwnedJson(STORAGE_FAULTS),'fault_closure');
 for(const [i,f]of o.faults.entries()){const boot=o.boots.find(b=>b.caseId==='fault-'+i+'-recovery');need(boot&&(boot.storage as any).kind==='recovery-rejected'&&(boot.storage as any).reason===f.reason,'fault_recovery');
  const files=['lock','intent.json',...(['after-data','after-seal','after-selection','before-response'].includes(f.fault)?['data.bin']:[]),...(['after-seal','after-selection','before-response'].includes(f.fault)?['seal.json']:[]),...(['after-selection','before-response'].includes(f.fault)?['selected.json']:[])].sort();
  need(canonicalOwnedJson(f.partialInventory)===canonicalOwnedJson(files),'partial_inventory');
 }
 need(canonicalOwnedJson(o.tampering.map(f=>f.mutation))===canonicalOwnedJson(['data','unknown-entry','symlink']),'tamper_closure');
 for(const [i,t]of o.tampering.entries()){const boot=o.boots.find(b=>b.caseId==='tamper-'+i+'-recovery');need(boot&&(boot.storage as any).kind==='recovery-rejected'&&(boot.storage as any).reason===t.reason,'tamper_recovery');}
 need(new Set(o.sealedEvidence.map(e=>ownedSha256(bytes(e.seal)))).size===4,'seal_closure');
 for(const e of o.sealedEvidence){const raw=bytes(e.seal),body=envelope(raw,provider,'seal'),selected=envelope(bytes(e.selected),provider,'seal'),intent=decode(bytes(e.intent));
  need(body.runId===input.runId&&body.manifestDigest===input.manifestDigest&&body.dataDigest===o.payloadDigest&&body.intentDigest===ownedDigest(intent)&&body.size===bytes(e.payload).length&&ownedSha256(bytes(e.payload))===o.payloadDigest&&canonicalOwnedJson(body.root)===canonicalOwnedJson(e.root)&&body.generation===1,'seal_content');
  need(canonicalOwnedJson(selected)===canonicalOwnedJson({sealDigest:ownedSha256(raw),root:e.root,generation:1}),'selection');
  need(o.calls.some(c=>(c.response as any).body.operation==='seal'&&(c.response as any).body.result?.sealDigest===ownedSha256(raw)&&c.providerBoot===body.originBoot),'seal_receipt');
 }
 const eventSchema=z.union([
  z.object({kind:z.literal('storage-ready'),recovered:z.boolean(),syncs,launchDigest:hash}).strict(),
  z.object({kind:z.literal('recovery-rejected'),reason:z.string().max(128),launchDigest:hash}).strict(),
  z.object({kind:z.literal('rejected'),role:z.literal('upload'),peer:triple,reason:z.enum(['request-binding','signature-domain']),launchDigest:hash}).strict(),
  z.object({kind:z.literal('storage-operation'),role:z.string(),operation:z.string(),requestDigest:hash,peer:triple,result:z.unknown(),syncs,launchDigest:hash}).strict(),
  z.object({kind:z.literal('storage-rejected'),role:z.string(),operation:z.string(),reason:z.string().max(128),peer:triple,launchDigest:hash}).strict()]);
 const events=o.events.map(e=>eventSchema.parse(e));
 need(events.length===57&&new Set(events.map(e=>ownedDigest(e))).size===57,'event_closure');
 for(const boot of o.boots)need(events.filter(e=>canonicalOwnedJson(e)===canonicalOwnedJson(boot.storage)).length===1,'boot_event');
 for(const c of o.calls){const response=(c.response as any).body,boot=boots.get(c.providerBoot)!;
  const matching=events.filter(e=>'peer'in e&&'operation'in e&&e.peer[0]===c.actorPid&&e.launchDigest===boot.digest&&e.operation===response.operation);need(matching.length===1,'operation_event');const event=matching[0]!;
  need('peer'in event&&'role'in event&&canonicalOwnedJson(event.peer)===canonicalOwnedJson([c.actorPid,c.identity.uid[0],c.identity.gid[0]])&&event.role===plan.get(c.case)!.role,'operation_event');
  if(response.outcome==='accepted'){need(event.kind==='storage-operation'&&event.requestDigest===ownedDigest(c.request)&&canonicalOwnedJson(event.result)===canonicalOwnedJson(response.result),'operation_event');
   const expectedSync=c.case==='empty'?[0,0]:response.operation==='stage'?[2,2]:response.operation==='seal'?[8,5]:c.case==='read-recovered'?[8,2]:[12,6];
   need(event.syncs.file===expectedSync[0]&&event.syncs.directory===expectedSync[1],'seal_sync');}
  else need(event.kind==='storage-rejected'&&event.reason===response.reason,'rejection_event');
 }
 need(events.some(e=>canonicalOwnedJson(e)===canonicalOwnedJson(stale.serverRejection)),'stale_request_event');
 need(events.some(e=>canonicalOwnedJson(e)===canonicalOwnedJson(malformed.serverRejection)),'malformed_request_event');
 need(new Set(run.sources.map(s=>s.path)).size===run.sources.length,'source_closure');
 const sourcePlan=['q2b/build_fixture.py','q2b/launcher.c','q2b/native_probe.py','q2b/provider.py',
  ...['build_fixture.py','guest_deploy.py','guest_probe.py','vm_runner.py'].map(p=>'q2b_b1c/'+p),
  ...['auth.py','build_fixture.py','client_probe.py','guest_deploy.py','guest_probe.py','manager.h','provider_tail.py','vm_runner.py'].map(p=>'q2b_b1ct/'+p),
  ...['build_fixture.py','guest_deploy.py','guest_probe.py','storage.py','storage_client.py','storage_regression.py','vm_runner.py'].map(p=>'q2b_storage/'+p)];
 need(canonicalOwnedJson(run.sources.map(s=>s.path).sort())===canonicalOwnedJson(sourcePlan.sort()),'source_closure');
 return Object.freeze({authenticatedStorageCalls:o.calls.length,successfulStorageCalls:o.calls.filter(c=>(c.response as any).body.outcome==='accepted').length,
  nativeLaunchBindingsVerified:o.boots.length,isolationRefusals:o.isolation.reduce((n,c)=>n+c.denied.length,0),allowControls:o.isolation.length,
  storageFaultsVerified:o.faults.length,tamperRecoveriesRejected:o.tampering.length,serviceRestartRecoveryObserved:true,vmPowerLossTested:false,
  nativeIsolationVerified:false,independentRegistryVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});
}
