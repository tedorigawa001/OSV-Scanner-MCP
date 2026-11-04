/** C3b-0 static owner assembly. No key loading, filesystem access, dispatch or admission. */
import {createPublicKey} from 'node:crypto';
import {z} from 'zod';
import {cid,chash,cn,currentRoles,currentAPIs,apiPolicy,parsed,need,decodeCurrent,CURRENT_LIMITS} from './gradleOwnedCurrentSchema.js';
import {auxiliaryAPIs,auxiliaryPolicy,currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {canonicalOwnedJson,ownedDigest} from './gradleOwnedJson.js';

export const serviceOwnerRoles=['provider','checkpoint-issuer','lineage-registry','authority-broker','control-anchor'] as const;
export const serviceIdentitySchema=z.object({credentialId:cid,role:z.enum(currentRoles),instanceId:cid,boot:chash,keyEpoch:cn.positive()}).strict();
export type ServiceIdentity=z.infer<typeof serviceIdentitySchema>;
export const serviceAPIs=Object.freeze([...currentAPIs.map(a=>'control.'+a),...auxiliaryAPIs.map(a=>'aux.'+a),'recovery.ReportRecovered','recovery.GetRecoveryStatus','aux.RevokeAuthority','aux.ReadAuthorityState','aux.ReadDelivery','aux.ReadSourceDescriptor','aux.CompleteAuthorityResult','aux.ReadAuthorityResult','aux.FinishAuthorityResult','aux.QueryDelivery','aux.ReportServiceRecovered']);
export const serviceAPISchema=z.string().refine(v=>serviceAPIs.includes(v));
const root=z.object({rootId:cid,device:z.string().regex(/^[0-9]+$/),inode:z.string().regex(/^[0-9]+$/)}).strict();
export const credentialSchema=z.object({identity:serviceIdentitySchema,keyId:cid,direction:z.enum(['request','reply']),spki:z.string().min(1).max(128),endpointId:cid,
 permissions:z.array(z.object({api:serviceAPISchema,purpose:z.enum(['read','publication','maintenance','checkpoint','handoff','enrollment','recovery']),lineage:currentLineageSchema,delegateInstance:cid.nullable()}).strict()).max(64)}).strict();
export const credentialRegistrySchema=z.object({schema:z.literal('osv-mcp.q2.c3b.credentials.v1'),deploymentDigest:chash,enrollmentDigest:chash,profileDigest:chash,credentials:z.array(credentialSchema).min(2).max(64)}).strict();
export type CredentialRegistry=z.infer<typeof credentialRegistrySchema>;
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
export function publicCredentialKey(c:z.infer<typeof credentialSchema>){
 try{const raw=Buffer.from(c.spki,'base64');need(raw.toString('base64')===c.spki,'configuration_invalid');const key=createPublicKey({key:raw,format:'der',type:'spki'});need(key.asymmetricKeyType==='ed25519'&&key.export({format:'der',type:'spki'}).equals(raw),'configuration_invalid');return key;}catch{need(false,'configuration_invalid');}
}
export function credentialAPIRoles(api:string):readonly string[]{
 if(api==='aux.ReportServiceRecovered')return serviceOwnerRoles;
 if(api==='aux.QueryDelivery')return ['provider','authority-broker','reader'];
 if(api==='aux.ReadDelivery')return ['provider','authority-broker','reader'];
 if(['aux.ReadSourceDescriptor','aux.CompleteAuthorityResult','aux.ReadAuthorityResult','aux.FinishAuthorityResult'].includes(api))return ['reader'];
 if(api==='aux.ReadAuthorityState')return ['authority-broker'];
 if(api==='aux.RevokeAuthority')return ['operator'];
 if(['aux.ResolveNamespace','aux.ReadSealedSource'].includes(api))return [...auxiliaryPolicy[api.slice(4) as 'ResolveNamespace'|'ReadSealedSource'].roles,'authority-broker'];
 if(api.startsWith('control.'))return apiPolicy[api.slice(8) as keyof typeof apiPolicy]?.roles??[];
 if(api.startsWith('aux.'))return auxiliaryPolicy[api.slice(4) as keyof typeof auxiliaryPolicy]?.roles??[];
 if(api==='recovery.ReportRecovered')return serviceOwnerRoles;
 if(api==='recovery.GetRecoveryStatus')return [...serviceOwnerRoles,'operator'];return [];
}
export function credentialDestination(api:string){
 if(api==='aux.ReportServiceRecovered')return 'lineage-registry';
 if(['aux.ReadDelivery','aux.QueryDelivery'].includes(api))return 'lineage-registry';
 if(api==='aux.ReadSourceDescriptor')return 'provider';
 if(['aux.CompleteAuthorityResult','aux.ReadAuthorityResult','aux.FinishAuthorityResult'].includes(api))return 'authority-broker';
 if(api==='aux.ReadAuthorityState')return 'lineage-registry';
 if(api==='aux.RevokeAuthority')return 'authority-broker';
 if(api.startsWith('control.'))return ({registry:'lineage-registry',issuer:'checkpoint-issuer',provider:'provider',anchor:'control-anchor'} as const)[apiPolicy[api.slice(8) as keyof typeof apiPolicy].destination];
 if(api.startsWith('aux.'))return ({registry:'lineage-registry',provider:'provider',authority:'authority-broker'} as const)[auxiliaryPolicy[api.slice(4) as keyof typeof auxiliaryPolicy].destination];
 return 'lineage-registry';
}
export function validateCredentialRegistry(value:unknown,expected:{deploymentDigest:string;enrollmentDigest:string;profileDigest:string;registryDigest:string}){
 const r=parsed(credentialRegistrySchema,value);for(const k of ['deploymentDigest','enrollmentDigest','profileDigest'] as const)need(r[k]===expected[k],'binding_mismatch');need(ownedDigest(r)===expected.registryDigest,'binding_mismatch');
 need(new Set(r.credentials.map(c=>c.identity.credentialId)).size===r.credentials.length&&new Set(r.credentials.map(c=>c.keyId)).size===r.credentials.length,'configuration_invalid');
 const keys=new Set<string>();for(const c of r.credentials){publicCredentialKey(c);need(!keys.has(c.spki),'configuration_invalid');keys.add(c.spki);
  need(new Set(c.permissions.map(p=>canonicalOwnedJson(p))).size===c.permissions.length,'configuration_invalid');
  for(const p of c.permissions){need(p.lineage.enrollmentDigest===r.enrollmentDigest&&p.lineage.profileDigest===r.profileDigest,'binding_mismatch');need(c.direction==='request'?credentialAPIRoles(p.api).includes(c.identity.role):credentialDestination(p.api)===c.identity.role,'permission_denied');}
 }
 return r;
}
const client=z.object({role:z.enum(serviceOwnerRoles),instanceId:cid,endpointId:cid,serverCredentialId:cid}).strict();
const ownerBase={schema:z.literal('osv-mcp.q2.c3b.owner.v1'),ownerId:cid,instanceId:cid,boot:chash,storageEpoch:chash,lineage:currentLineageSchema,deploymentDigest:chash,registryDigest:chash,
 roots:z.object({store:root,checkpoint:root}).strict(),journalKeyId:cid,checkpointKeyId:cid,clientCredentialId:cid,serverCredentialId:cid,clients:z.array(client).max(4)};
const ownerSchema=<T extends typeof serviceOwnerRoles[number]>(role:T)=>z.object({...ownerBase,role:z.literal(role)}).strict();
export const ownerConfigSchema=z.discriminatedUnion('role',[ownerSchema('provider'),ownerSchema('checkpoint-issuer'),ownerSchema('lineage-registry'),ownerSchema('authority-broker'),ownerSchema('control-anchor')]);
export type OwnerConfig=z.infer<typeof ownerConfigSchema>;
const requiredClients:Record<typeof serviceOwnerRoles[number],readonly string[]>={provider:['lineage-registry','checkpoint-issuer'],'checkpoint-issuer':['provider','lineage-registry'],'lineage-registry':['checkpoint-issuer','control-anchor'],'authority-broker':['lineage-registry','provider'],'control-anchor':[]};
export type OwnerPlan=Readonly<{kind:'c3b-owner-plan'}>;
const plans=new WeakMap<OwnerPlan,{config:OwnerConfig;registry:CredentialRegistry}>();
/** Only a root application supplies these independent pins. This is static preflight, not OS approval. */
export function validateOwnerPlans(values:unknown,registryValue:unknown,expected:{deploymentDigest:string;enrollmentDigest:string;profileDigest:string;registryDigest:string;plansDigest:string}){
 const registry=validateCredentialRegistry(registryValue,expected),configs=parsed(z.array(ownerConfigSchema).length(5),values);need(ownedDigest(configs)===expected.plansDigest,'binding_mismatch');
 need(new Set(configs.map(c=>c.role)).size===5&&new Set(configs.map(c=>c.ownerId)).size===5&&new Set(configs.map(c=>c.instanceId)).size===5,'configuration_invalid');
 const roots=configs.flatMap(c=>Object.values(c.roots)),keys=configs.flatMap(c=>[c.journalKeyId,c.checkpointKeyId]);need(new Set(roots.map(r=>r.rootId)).size===10&&new Set(roots.map(r=>r.device+':'+r.inode)).size===10&&new Set(keys).size===10,'roots_overlap');
 const out:OwnerPlan[]=[];
 for(const c of configs){need(c.deploymentDigest===expected.deploymentDigest&&c.registryDigest===expected.registryDigest,'binding_mismatch');
  for(const [id,direction] of [[c.clientCredentialId,'request'],[c.serverCredentialId,'reply']] as const){const pin=registry.credentials.find(p=>p.identity.credentialId===id);need(pin&&pin.direction===direction&&pin.identity.role===c.role&&pin.identity.instanceId===c.instanceId&&pin.identity.boot===c.boot,'peer_mismatch');need(c.lineage.enrollmentDigest===registry.enrollmentDigest&&c.lineage.profileDigest===registry.profileDigest,'binding_mismatch');}
  need(same(c.clients.map(p=>p.role).sort(),[...requiredClients[c.role]].sort()),'configuration_invalid');
  for(const peer of c.clients){const target=configs.find(v=>v.role===peer.role),pin=registry.credentials.find(p=>p.identity.credentialId===peer.serverCredentialId);need(target&&pin&&peer.instanceId===target.instanceId&&pin.identity.instanceId===peer.instanceId&&pin.identity.role===peer.role&&pin.direction==='reply'&&pin.endpointId===peer.endpointId&&target.serverCredentialId===peer.serverCredentialId&&same(c.lineage,target.lineage),'peer_mismatch');}
  const handle=Object.freeze({kind:'c3b-owner-plan' as const});plans.set(handle,{config:c,registry});out.push(handle);
 }
 return out;
}
export function ownerPlanFacts(plan:OwnerPlan){const p=plans.get(plan);need(p,'configuration_invalid');return structuredClone(p.config);}
/** Future adapters implement these ports; C3b-0 never calls them. */
export type ScopedSignIntent=Readonly<{kind:'c3b-scoped-sign-intent'}>;
const signIntents=new WeakMap<ScopedSignIntent,{identity:ServiceIdentity;direction:'request'|'reply';bytes:Buffer;domain:string;api:string|null}>();
/** No signatures are produced here. Future signer adapters must consume this scoped handle. */
export function prepareOwnerSignature(plan:OwnerPlan,credentialId:string,value:unknown,body:Buffer){
 const p=plans.get(plan);need(p,'configuration_invalid');const q=parsed(z.object({domain:z.enum(['auth','control','aux','stage','recovery']),direction:z.enum(['request','reply']),api:serviceAPISchema.nullable(),bodyDigest:chash}).strict(),value);
 const c=p.registry.credentials.find(c=>c.identity.credentialId===credentialId);need(c&&[p.config.clientCredentialId,p.config.serverCredentialId].includes(credentialId)&&c.direction===q.direction,'permission_denied');
 const raw:any=decodeCurrent(body,CURRENT_LIMITS.record);need(ownedDigest(raw)===q.bodyDigest,'binding_mismatch');
 if(q.domain==='auth'){need(['client-hello','client-proof','server-hello','ready','challenge-request','challenge','channel'].includes(raw.kind)&&raw[q.direction==='request'?'clientCredentialId':'serverCredentialId']===credentialId,'permission_denied');need(q.direction==='request'?['client-hello','client-proof','challenge-request','channel'].includes(raw.kind):['server-hello','ready','challenge-request','challenge','channel'].includes(raw.kind),'permission_denied');need(['channel','challenge-request','challenge'].includes(raw.kind)?raw.api===q.api:q.api===null,'binding_mismatch');}
 else if(q.domain==='stage'){need(q.direction==='reply'&&raw.schema==='osv-mcp.q2.c3b.stage-record.v1'&&raw.ownerId===p.config.ownerId&&raw.storageEpoch===p.config.storageEpoch,'permission_denied');}
 else {need(q.api&&q.api.startsWith(q.domain+'.')&&raw.api===q.api.slice(q.domain.length+1),'permission_denied');}
 if(q.api)need(q.direction==='request'?credentialAPIRoles(q.api).includes(c.identity.role):credentialDestination(q.api)===c.identity.role,'permission_denied');
 const h=Object.freeze({kind:'c3b-scoped-sign-intent' as const});signIntents.set(h,{identity:c.identity,direction:c.direction,bytes:Buffer.from(body),domain:q.domain,api:q.api});return h;
}
/** Scope is read only after checking the opaque handle and the signer's own identity. */
export function readSigningScope(handle:ScopedSignIntent,identity:ServiceIdentity,direction:'request'|'reply'){readSigningIntent(handle,identity,direction);const v=signIntents.get(handle)!;return {domain:v.domain,api:v.api};}
export function readSigningIntent(handle:ScopedSignIntent,identity:ServiceIdentity,direction:'request'|'reply'){const v=signIntents.get(handle);need(v&&same(v.identity,identity)&&v.direction===direction,'permission_denied');return Buffer.from(v.bytes);}
export interface RoleSigner {identity:ServiceIdentity;direction:'request'|'reply';keyId:string;spki:string;sign(message:ScopedSignIntent):Promise<Buffer>}
export interface OwnedStore {ownerId:string;storageEpoch:string;roots:OwnerConfig['roots'];journalKeyId:string;checkpointKeyId:string;assertOpen():void;assertIdle?():void;recover():Promise<unknown>;readCommitted(ref:unknown):Promise<unknown>;commitStageExact(request:unknown):Promise<unknown>;close():void}
export type OwnerPorts=Readonly<{kind:'c3b-owner-ports'}>;
const bindings=new WeakMap<OwnerPorts,OwnerPlan>();
export function bindOwnerPorts(plan:OwnerPlan,signers:readonly RoleSigner[],store:OwnedStore,clients:readonly {role:string;instanceId:string;endpointId:string;call:(request:unknown)=>Promise<unknown>}[]){
 const facts=plans.get(plan);need(facts,'configuration_invalid');const c=facts.config;need(signers.length===2&&new Set(signers.map(s=>s.direction)).size===2,'configuration_invalid');
 for(const s of signers){const p=facts.registry.credentials.find(p=>p.identity.credentialId===s.identity.credentialId);need(p&&same(p.identity,s.identity)&&p.direction===s.direction&&p.keyId===s.keyId&&p.spki===s.spki&&[c.clientCredentialId,c.serverCredentialId].includes(s.identity.credentialId)&&typeof s.sign==='function','peer_mismatch');}
 need(store.ownerId===c.ownerId&&store.storageEpoch===c.storageEpoch&&same(store.roots,c.roots)&&store.journalKeyId===c.journalKeyId&&store.checkpointKeyId===c.checkpointKeyId,'binding_mismatch');
 need(['assertOpen','recover','readCommitted','commitStageExact','close'].every(k=>typeof (store as any)[k]==='function'),'configuration_invalid');
 need(clients.length===c.clients.length&&clients.every(p=>typeof p.call==='function'&&c.clients.some(e=>e.role===p.role&&e.instanceId===p.instanceId&&e.endpointId===p.endpointId))&&new Set(clients.map(p=>p.role)).size===clients.length,'configuration_invalid');
 const result=Object.freeze({kind:'c3b-owner-ports' as const});bindings.set(result,plan);return result;
}
export function inspectOwnerPorts(handle:OwnerPorts){const p=bindings.get(handle);need(p,'configuration_invalid');return {config:ownerPlanFacts(p),scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};}

export const ownerStateSchema=z.object({ownerId:cid,role:z.enum(serviceOwnerRoles),boot:chash,storageEpoch:chash,
 lifecycle:z.enum(['created','preflight','recovering','control-ready','operational','draining','closed','blocked']),
 lineagePhase:z.enum(['uninitialized','provisioning','serving','draining','frozen','retired']),preflightPassed:z.boolean(),keysLoaded:z.boolean(),storeRecovered:z.boolean(),recoveryReportsVerified:z.boolean(),
 inFlight:cn.max(64),unknownEffects:cn.max(64)}).strict();
export function validateOwnerState(plan:OwnerPlan,value:unknown){const c=ownerPlanFacts(plan),s=parsed(ownerStateSchema,value);need(s.ownerId===c.ownerId&&s.role===c.role&&s.boot===c.boot&&s.storageEpoch===c.storageEpoch,'binding_mismatch');
 if(['created','preflight'].includes(s.lifecycle))need(!s.keysLoaded&&!s.storeRecovered&&!s.recoveryReportsVerified&&s.inFlight===0&&s.unknownEffects===0,'preflight_required');
 if(['recovering','control-ready','operational'].includes(s.lifecycle))need(s.preflightPassed&&s.keysLoaded,'preflight_required');
 if(['control-ready','operational'].includes(s.lifecycle))need(s.storeRecovered,'recovery_required');if(s.lifecycle==='operational')need(s.recoveryReportsVerified,'recovery_required');
 if(s.lifecycle==='closed')need(s.inFlight===0&&s.unknownEffects===0,'effects_pending');return s;}
export function validateOwnerTransition(plan:OwnerPlan,before:unknown,after:unknown){const a=validateOwnerState(plan,before),b=validateOwnerState(plan,after),allowed:Record<typeof a.lifecycle,readonly string[]>={created:['preflight','blocked'],preflight:['recovering','blocked'],recovering:['control-ready','blocked'],'control-ready':['operational','draining','blocked'],operational:['draining','blocked'],draining:['closed','blocked'],closed:[],blocked:[]};
 need(allowed[a.lifecycle].includes(b.lifecycle),'lifecycle_invalid');return {state:b,scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};}
