/** C3a synthetic evidence runner. Never admits native isolation, a grant or a read skip. */
import {verify,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {cid,chash,cn,need,parsed,decodeCurrent} from '../../utils/gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
const nonroot=['provider','checkpoint-issuer','lineage-registry','authority-broker','reader','writer','operator'] as const;
const cap=z.string().regex(/^[a-f0-9]{16}$/),ids=z.tuple([cn,cn,cn]);
const caps=z.object({CapInh:cap,CapPrm:cap,CapEff:cap,CapBnd:cap,CapAmb:cap}).strict();
const phase=z.object({role:z.enum([...nonroot,'manager','controller']),instanceId:cid,boot:chash,phase:z.enum(['provision','pre-drop','launcher','runtime','observe']),pid:cn.positive(),uid:ids,gid:ids,groups:z.array(cn).max(16),capabilities:caps,noNewPrivileges:z.boolean(),
 executableDigest:chash,argv:z.array(z.string().max(1024)).max(16),environment:z.record(cid,z.string().max(1024)),rootDigest:chash,listenerDigest:chash}).strict();
const endpoint=z.object({destination:z.enum(['provider','issuer','registry','authority']),role:z.enum(nonroot),clientRole:z.enum(nonroot),instanceId:cid,boot:chash,ownerUid:z.literal(0),ownerGid:z.literal(0),groupGid:cn.positive(),mode:z.literal(0o660),device:cid,inode:cid,fd:cn.min(3).max(63),passcred:z.literal(true),custodian:z.literal('manager')}).strict();
const expectedCase=z.object({caseId:cid,condition:z.string().regex(/^CN(?:0[1-9]|[12][0-9]|3[0-9]|40)$/),kind:z.enum(['allow','deny']),reason:cid,requiredPreconditions:z.array(cid).min(1).max(16),forbiddenIO:z.literal(0),forbiddenWrites:z.literal(0),forbiddenDeliveries:z.literal(0)}).strict();
export const c3DeploymentSchema=z.object({schema:z.literal('osv-mcp.q2.c3a.deployment.v1'),scope:z.literal('synthetic-static-only'),runId:cid,profileDigest:chash,enrollmentDigest:chash,keySetDigest:chash,serviceKeySetDigest:chash,phases:z.array(phase).min(17).max(32),endpoints:z.array(endpoint).min(4).max(64),cases:z.array(expectedCase).min(1).max(128)}).strict();
const launchSchema=z.object({schema:z.literal('osv-mcp.q2.c3a.launch.v1'),runId:cid,deploymentDigest:chash,profileDigest:chash,phases:z.array(phase).max(32),endpoints:z.array(endpoint).min(4).max(64)}).strict();
const observation=expectedCase.extend({preconditions:z.array(cid).min(1).max(16),observedReason:cid,sourceIO:cn,writes:cn,deliveries:cn,controlStarted:z.literal(true)}).strict();
const recordSchema=z.object({schema:z.literal('osv-mcp.q2.c3a.record.v1'),scope:z.literal('synthetic-static-only'),runId:cid,launchDigest:chash,deploymentDigest:chash,phases:z.array(phase).max(32),bootstraps:z.array(z.object({role:z.enum(nonroot),bytes:z.string().max(16384),sha256:chash,fd:cn.min(3).max(63),ownerUid:z.literal(0),ownerGid:z.literal(0),mode:z.literal(0o400),readOnly:z.literal(true),seals:z.literal(15)}).strict()).length(7),cases:z.array(observation).min(1).max(128),nativeTrials:z.literal(0),nativeIsolationVerified:z.literal(false),profileApproved:z.literal(false),backendEligible:z.literal(false),originalReadsSkipped:z.literal(0)}).strict();
const bootstrap=z.object({schema:z.literal('osv-mcp.q2.c3a.bootstrap.v1'),runId:cid,deploymentDigest:chash,launchDigest:chash,profileDigest:chash,enrollmentDigest:chash,keySetDigest:chash,role:z.enum(nonroot),instanceId:cid,boot:chash,rootDigest:chash,listenerDigest:chash,runtimeDigest:chash}).strict();
const envelope=z.object({schema:z.literal('osv-mcp.q2.c3a.evidence.v1'),signer:z.enum(['manager','controller']),keyId:cid,body:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
export interface C3SignerPin {keyId:string;publicKey:KeyObject}
function authenticated(bytes:Buffer,signer:'manager'|'controller',pin:C3SignerPin){const e=parsed(envelope,decodeCurrent(bytes,256*1024));need(e.signer===signer&&e.keyId===pin.keyId&&pin.publicKey.type==='public'&&pin.publicKey.asymmetricKeyType==='ed25519','peer_mismatch');const signature=Buffer.from(e.signature,'base64');need(signature.toString('base64')===e.signature&&verify(null,Buffer.from(canonicalOwnedJson({domain:e.schema,signer,keyId:e.keyId,body:e.body})),pin.publicKey,signature),'signature_invalid');return e.body;}
/** Hash the complete server-owned listener inventory, with a domain and deterministic order. */
export function c3ListenerDigest(subject:unknown,endpoints:unknown){
 const identity=parsed(z.object({role:z.enum(nonroot),instanceId:cid,boot:chash}).strict(),subject),all=parsed(z.array(endpoint).max(64),endpoints);
 const listeners=all.filter(e=>e.role===identity.role&&e.instanceId===identity.instanceId).sort((a,b)=>{const x=canonicalOwnedJson(a),y=canonicalOwnedJson(b);return x<y?-1:x>y?1:0;});
 return ownedDigest({domain:'osv-mcp.q2.c3a.listener-inventory.v1',...identity,listeners});
}
export function c3DeploymentProfileDigest(plan:unknown){
 const m=parsed(c3DeploymentSchema,plan);
 return ownedDigest({domain:'osv-mcp.q2.c3a.phase-profile.v1',enrollmentDigest:m.enrollmentDigest,keySetDigest:m.keySetDigest,serviceKeySetDigest:m.serviceKeySetDigest,
  phases:m.phases.map(({pid,boot,instanceId,rootDigest,listenerDigest,...profile})=>profile),
  endpoints:m.endpoints.map(({instanceId,boot,device,inode,...profile})=>profile)});
}
export function verifyC3StaticRun(input:{manifest:Buffer;expectedManifestDigest:string;expectedProfileDigest:string;launch:Buffer;record:Buffer;manager:C3SignerPin;controller:C3SignerPin}){
 need(ownedSha256(input.manifest)===input.expectedManifestDigest,'binding_mismatch');
 const m=parsed(c3DeploymentSchema,decodeCurrent(input.manifest,256*1024));need(m.profileDigest===input.expectedProfileDigest&&c3DeploymentProfileDigest(m)===input.expectedProfileDigest,'profile_unapproved');
 need(input.manager.publicKey.type==='public'&&input.controller.publicKey.type==='public'&&!input.manager.publicKey.export({type:'spki',format:'der'}).equals(input.controller.publicKey.export({type:'spki',format:'der'})),'peer_mismatch');
 need(m.keySetDigest===ownedDigest({domain:'osv-mcp.q2.c3a.public-key-set.v1',serviceKeySetDigest:m.serviceKeySetDigest,
  manager:{keyId:input.manager.keyId,spki:input.manager.publicKey.export({type:'spki',format:'der'}).toString('base64')},
  controller:{keyId:input.controller.keyId,spki:input.controller.publicKey.export({type:'spki',format:'der'}).toString('base64')}}),'peer_mismatch');
 const l=parsed(launchSchema,authenticated(input.launch,'manager',input.manager)),r=parsed(recordSchema,authenticated(input.record,'controller',input.controller));
 need(l.runId===m.runId&&r.runId===m.runId&&l.profileDigest===m.profileDigest&&l.deploymentDigest===input.expectedManifestDigest&&r.deploymentDigest===input.expectedManifestDigest&&r.launchDigest===ownedSha256(input.launch),'binding_mismatch');
 need(same(l.phases,m.phases)&&same(l.endpoints,m.endpoints)&&same(r.phases,m.phases),'phase_mismatch');
 for(const p of m.phases)need(Object.keys(p.environment).every(k=>['LANG','LC_ALL','CREDENTIALS_DIRECTORY','LISTEN_PID','LISTEN_FDS','LISTEN_FDNAMES','INVOCATION_ID','JOURNAL_STREAM','SYSTEMD_EXEC_PID'].includes(k)),'environment_invalid');
 for(const p of m.phases)if(nonroot.includes(p.role as typeof nonroot[number]))need(p.listenerDigest===c3ListenerDigest({role:p.role,instanceId:p.instanceId,boot:p.boot},m.endpoints),'listener_mismatch');
 need(new Set(r.bootstraps.map(b=>b.role)).size===nonroot.length,'bootstrap_mismatch');
 for(const entry of r.bootstraps){const raw=Buffer.from(entry.bytes,'base64');need(raw.toString('base64')===entry.bytes&&ownedSha256(raw)===entry.sha256,'bootstrap_mismatch');const b=parsed(bootstrap,decodeCurrent(raw)),runtime=m.phases.find(p=>p.role===entry.role&&p.phase==='runtime');need(runtime,'bootstrap_mismatch');
  need(b.runId===m.runId&&b.deploymentDigest===input.expectedManifestDigest&&b.launchDigest===ownedSha256(input.launch)&&b.profileDigest===m.profileDigest&&b.enrollmentDigest===m.enrollmentDigest&&b.keySetDigest===m.keySetDigest&&b.role===entry.role&&b.instanceId===runtime.instanceId&&b.boot===runtime.boot&&b.rootDigest===runtime.rootDigest&&b.listenerDigest===runtime.listenerDigest&&b.runtimeDigest===runtime.executableDigest,'bootstrap_mismatch');
  need(!m.endpoints.some(e=>e.instanceId===runtime.instanceId&&e.fd===entry.fd),'bootstrap_mismatch');
 }
 const keys=m.phases.map(p=>p.role+':'+p.phase);need(same(keys,['manager:provision','manager:pre-drop',...nonroot.flatMap(role=>[role+':launcher',role+':runtime']),'controller:observe']),'phase_mismatch');
 const uids=new Set<number>(),gids=new Set<number>();
 for(const role of nonroot){
  const stages=m.phases.filter(p=>p.role===role);need(stages.length===2&&stages[0]!.phase==='launcher'&&stages[1]!.phase==='runtime','phase_mismatch');const first=stages[0]!;
  need(first.uid[0]>0&&first.gid[0]>0&&!uids.has(first.uid[0])&&!gids.has(first.gid[0]),'principal_invalid');uids.add(first.uid[0]);gids.add(first.gid[0]);
  for(const p of stages)need(p.uid.every(v=>v===first.uid[0])&&p.gid.every(v=>v===first.gid[0])&&!p.groups.length&&p.noNewPrivileges&&Object.values(p.capabilities).every(v=>v==='0000000000000000')&&p.pid===first.pid&&p.instanceId===first.instanceId&&p.boot===first.boot&&p.rootDigest===first.rootDigest&&p.listenerDigest===first.listenerDigest,'principal_invalid');
 }
 const managers=m.phases.filter(p=>p.role==='manager');need(managers.length===2&&managers[0]!.phase==='provision'&&managers[1]!.phase==='pre-drop','phase_mismatch');
 for(const p of managers)need(p.uid.every(v=>v===0)&&p.gid.every(v=>v===0),'principal_invalid');
 const last=managers[1]!;need(!last.groups.length&&last.noNewPrivileges&&Object.values(last.capabilities).every(v=>v==='00000000000001c0'),'principal_invalid');
 const controllers=m.phases.filter(p=>p.role==='controller');need(controllers.length===1&&controllers[0]!.phase==='observe','phase_mismatch');
 // Root provision/controller exact values come from the independently pinned plan, never a zero-capability blanket rule.
 need(new Set(nonroot.map(role=>m.phases.find(p=>p.role===role)!.rootDigest)).size===nonroot.length,'root_mismatch');
 need(new Set(m.endpoints.map(e=>e.destination)).size===4&&new Set(m.endpoints.map(e=>e.device+':'+e.inode)).size===m.endpoints.length&&new Set(m.endpoints.map(e=>e.instanceId+':'+e.fd)).size===m.endpoints.length,'listener_mismatch');
 const serverRoles={provider:'provider',issuer:'checkpoint-issuer',registry:'lineage-registry',authority:'authority-broker'} as const;
 for(const e of m.endpoints){const p=m.phases.find(p=>p.role===serverRoles[e.destination]&&p.phase==='runtime');const client=m.phases.find(p=>p.role===e.clientRole&&p.phase==='runtime');need(p&&client&&e.groupGid===client.gid[0]&&e.role===p.role&&e.instanceId===p.instanceId&&e.boot===p.boot,'listener_mismatch');}
 need(new Set(m.cases.map(c=>c.caseId)).size===m.cases.length&&r.cases.length===m.cases.length,'case_mismatch');
 for(let i=0;i<m.cases.length;i++){const c=m.cases[i]!,o=r.cases[i]!;const {preconditions,observedReason,sourceIO,writes,deliveries,controlStarted,...expected}=o;
  need(same(expected,c)&&same(preconditions,c.requiredPreconditions)&&observedReason===c.reason&&controlStarted,'case_mismatch');
  if(c.kind==='deny')need(sourceIO===0&&writes===0&&deliveries===0,'forbidden_io');
 }
 return Object.freeze({scope:'synthetic-static-only' as const,casesVerified:r.cases.length,conditions:[...new Set(m.cases.map(c=>c.condition))],planDigest:ownedDigest(m),nativeTrials:0 as const,nativeIsolationVerified:false as const,independentRegistryVerified:false as const,profileApproved:false as const,backendEligible:false as const,originalReadsSkipped:0 as const});
}
