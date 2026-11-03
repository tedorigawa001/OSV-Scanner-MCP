/** C3b-0 session syntax/signature correspondence only. No nonce consumption, socket or live authority. */
import {verify} from 'node:crypto';
import {z} from 'zod';
import {cid,chash,cn,parsed,need,decodeCurrent,currentBindingSchema} from './gradleOwnedCurrentSchema.js';
import {currentLineageSchema,auxiliaryValues} from './gradleOwnedCurrentAuxiliary.js';
import {serviceAPISchema,validateCredentialRegistry,publicCredentialKey,credentialAPIRoles,credentialDestination,type CredentialRegistry} from './gradleOwnedServiceOwners.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from './gradleOwnedJson.js';
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b);
export const SERVICE_SESSION_LIMITS=Object.freeze({lifetimeMs:30000,rpcMs:5000,requests:256,peerPending:16,pending:64,recoveries:1,innerBytes:8192,frameBytes:16384,messages:512});
const common={clientCredentialId:cid,serverCredentialId:cid,deploymentDigest:chash,enrollmentDigest:chash,profileDigest:chash,registryDigest:chash,endpointId:cid,clientBoot:chash,serverBoot:chash,clientKeyEpoch:cn.positive(),serverKeyEpoch:cn.positive()};
const sessionFields={...common,clientNonce:chash,serverNonce:chash,sessionId:chash};
export const authMessageSchema=z.discriminatedUnion('kind',[
 z.object({...common,kind:z.literal('client-hello'),clientNonce:chash}).strict(),
 z.object({...sessionFields,kind:z.literal('server-hello'),clientHelloDigest:chash,lifetimeMs:z.literal(30000)}).strict(),
 z.object({...sessionFields,kind:z.literal('client-proof'),transcriptDigest:chash}).strict(),
 z.object({...sessionFields,kind:z.literal('ready'),transcriptDigest:chash,clientProofDigest:chash}).strict(),
 z.object({...sessionFields,kind:z.literal('challenge-request'),transcriptDigest:chash,sequence:cn.positive().max(512),requestId:chash,api:serviceAPISchema,originDigest:chash,ttlMs:cn.positive().max(5000)}).strict(),
 z.object({...sessionFields,kind:z.literal('challenge'),transcriptDigest:chash,sequence:cn.positive().max(512),requestId:chash,api:serviceAPISchema,originDigest:chash,challenge:chash,ttlMs:cn.positive().max(5000)}).strict(),
 z.object({...sessionFields,kind:z.literal('channel'),transcriptDigest:chash,sequence:cn.positive().max(512),challenge:chash,api:serviceAPISchema,originDigest:chash,innerWireDigest:chash,ttlMs:cn.positive().max(5000)}).strict(),
]);
export const authEnvelopeSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.auth.v1'),direction:z.enum(['request','reply']),keyId:cid,body:authMessageSchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
type Message=z.infer<typeof authMessageSchema>;
function authenticate(bytes:Buffer,registry:CredentialRegistry,direction:'request'|'reply',credentialId:string){const e=parsed(authEnvelopeSchema,decodeCurrent(bytes)),c=registry.credentials.find(c=>c.identity.credentialId===credentialId);need(c&&c.direction===direction&&e.direction===direction&&e.keyId===c.keyId,'peer_mismatch');const sig=Buffer.from(e.signature,'base64');need(sig.toString('base64')===e.signature&&verify(null,Buffer.from(canonicalOwnedJson({domain:e.schema,direction,keyId:e.keyId,body:e.body})),publicCredentialKey(c),sig),'signature_invalid');return e.body;}
export type StaticSession=Readonly<{kind:'c3b-static-session'}>;
type SessionFacts={base:z.infer<z.ZodObject<typeof common>>;clientNonce:string;serverNonce:string;sessionId:string;transcriptDigest:string;registry:CredentialRegistry};
const sessions=new WeakMap<StaticSession,SessionFacts>();
type RegistryPins=Parameters<typeof validateCredentialRegistry>[1];
export function validateSessionTranscript(frames:readonly Buffer[],registryValue:unknown,pins:RegistryPins,expected:{clientCredentialId:string;serverCredentialId:string;endpointId:string}){
 const registry=validateCredentialRegistry(registryValue,pins);need(frames.length===4,'schema_invalid');
 const client=registry.credentials.find(c=>c.identity.credentialId===expected.clientCredentialId),server=registry.credentials.find(c=>c.identity.credentialId===expected.serverCredentialId);need(client?.direction==='request'&&server?.direction==='reply'&&server.endpointId===expected.endpointId,'peer_mismatch');
 const messages=frames.map((f,i)=>authenticate(f,registry,i%2===0?'request':'reply',i%2===0?expected.clientCredentialId:expected.serverCredentialId));
 const [hello,offer,proof,ready]=messages;need(hello?.kind==='client-hello'&&offer?.kind==='server-hello'&&proof?.kind==='client-proof'&&ready?.kind==='ready','schema_invalid');
 const base={...expected,deploymentDigest:pins.deploymentDigest,enrollmentDigest:pins.enrollmentDigest,profileDigest:pins.profileDigest,registryDigest:pins.registryDigest,clientBoot:client.identity.boot,serverBoot:server.identity.boot,clientKeyEpoch:client.identity.keyEpoch,serverKeyEpoch:server.identity.keyEpoch};
 for(const m of messages)for(const [k,v]of Object.entries(base))need((m as any)[k]===v,'binding_mismatch');
 need(offer.clientHelloDigest===ownedSha256(frames[0]!)&&offer.clientNonce===hello.clientNonce,'binding_mismatch');
 const transcriptDigest=ownedDigest({domain:'osv-mcp.q2.c3b.transcript.v1',clientHello:ownedSha256(frames[0]!),serverHello:ownedSha256(frames[1]!)});
 for(const m of [proof,ready])need(m.sessionId===offer.sessionId&&m.clientNonce===offer.clientNonce&&m.serverNonce===offer.serverNonce&&m.transcriptDigest===transcriptDigest,'binding_mismatch');
 need(ready.clientProofDigest===ownedSha256(frames[2]!),'binding_mismatch');
 const handle=Object.freeze({kind:'c3b-static-session' as const});sessions.set(handle,{base,clientNonce:offer.clientNonce,serverNonce:offer.serverNonce,sessionId:offer.sessionId,transcriptDigest,registry});return handle;
}
export function inspectStaticSession(handle:StaticSession){const s=sessions.get(handle);need(s,'configuration_invalid');const {registry,...facts}=s;return {...structuredClone(facts),scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};}
/** Expectations must come from the future SessionClient/Server pending table, never the frame itself. */
export function validateChannelFrame(bytes:Buffer,inner:Buffer,handle:StaticSession,expectation:unknown){
 const s=sessions.get(handle);need(s,'configuration_invalid');const x=parsed(z.object({direction:z.enum(['request','reply']),sequence:cn.positive(),challenge:chash,api:serviceAPISchema,originDigest:chash,ttlMs:cn.positive().max(5000),purpose:z.enum(['read','publication','maintenance','checkpoint','handoff','enrollment','recovery']),lineage:currentLineageSchema}).strict(),expectation);
 const m=authenticate(bytes,s.registry,x.direction,x.direction==='request'?s.base.clientCredentialId:s.base.serverCredentialId);need(m.kind==='channel','schema_invalid');
 for(const [k,v]of Object.entries({...s.base,clientNonce:s.clientNonce,serverNonce:s.serverNonce,sessionId:s.sessionId,transcriptDigest:s.transcriptDigest,...Object.fromEntries(Object.entries(x).filter(([k])=>!['direction','purpose','lineage'].includes(k)))}))need((m as any)[k]===v,'binding_mismatch');
 const c=s.registry.credentials.find(c=>c.identity.credentialId===s.base.clientCredentialId)!,server=s.registry.credentials.find(c=>c.identity.credentialId===s.base.serverCredentialId)!;
 need(credentialAPIRoles(m.api).includes(c.identity.role)&&credentialDestination(m.api)===server.identity.role,'permission_denied');
 need(inner.length<=SERVICE_SESSION_LIMITS.innerBytes&&m.innerWireDigest===ownedSha256(inner),'budget_exceeded');const raw:any=decodeCurrent(inner,SERVICE_SESSION_LIMITS.innerBytes);
 const [domain,...apiParts]=m.api.split('.'),api=apiParts.join('.');const schemas={control:'osv-mcp.q2.current-control.envelope.v1',aux:'osv-mcp.q2.current-aux.envelope.v1',recovery:'osv-mcp.q2.c3b.recovery.envelope.v1'};
 need(raw?.schema===schemas[domain as keyof typeof schemas]&&raw.direction===x.direction&&raw.body?.api===api,'binding_mismatch');
 const binding=raw.body.binding??raw.body.lineage;need(binding&&Object.entries(x.lineage).every(([k,v])=>binding[k]===v),'binding_mismatch');
 need(c.permissions.some(p=>p.api===m.api&&p.purpose===x.purpose&&same(p.lineage,x.lineage)&&(p.delegateInstance===null||p.delegateInstance===server.identity.instanceId)),'permission_denied');
 // The domain-specific kernel must still verify/authorize the complete inner payload and live binding.
 return {api:m.api,innerWireDigest:m.innerWireDigest,scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};
}
export function validateChallengeExchange(request:Buffer,reply:Buffer,handle:StaticSession,expected:unknown){
 const s=sessions.get(handle);need(s,'configuration_invalid');const x=parsed(z.object({requestId:chash,api:serviceAPISchema,originDigest:chash,requestSequence:cn.positive().max(512),replySequence:cn.positive().max(512),ttlMs:cn.positive().max(5000)}).strict(),expected);
 const a=authenticate(request,s.registry,'request',s.base.clientCredentialId),b=authenticate(reply,s.registry,'reply',s.base.serverCredentialId);need(a.kind==='challenge-request'&&b.kind==='challenge','schema_invalid');
 for(const m of [a,b])for(const [k,v]of Object.entries({...s.base,clientNonce:s.clientNonce,serverNonce:s.serverNonce,sessionId:s.sessionId,transcriptDigest:s.transcriptDigest,requestId:x.requestId,api:x.api,originDigest:x.originDigest,ttlMs:x.ttlMs}))need((m as any)[k]===v,'binding_mismatch');
 need(a.sequence===x.requestSequence&&b.sequence===x.replySequence,'binding_mismatch');const c=s.registry.credentials.find(c=>c.identity.credentialId===s.base.clientCredentialId)!,server=s.registry.credentials.find(c=>c.identity.credentialId===s.base.serverCredentialId)!;
 need(credentialAPIRoles(x.api).includes(c.identity.role)&&credentialDestination(x.api)===server.identity.role&&c.permissions.some(p=>p.api===x.api),'permission_denied');
 return {challenge:b.challenge,scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};
}
export const authenticatedOutcomeSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('committed'),operationKey:chash,requestDigest:chash,resultDigest:chash,appliedRevision:cn.positive(),live:z.literal(false)}).strict(),
 z.object({kind:z.literal('pending'),operationKey:chash,requestDigest:chash,live:z.literal(false)}).strict(),
 z.object({kind:z.literal('definitive-rejection'),operationKey:chash,requestDigest:chash,reason:cid,mutated:z.literal(false),live:z.literal(false)}).strict(),
 z.object({kind:z.literal('unknown'),operationKey:chash,requestDigest:chash,live:z.literal(false)}).strict(),
]);
export const recoveryReportSchema=z.discriminatedUnion('api',[
 z.object({schema:z.literal('osv-mcp.q2.c3b.recovery.body.v1'),api:z.literal('ReportRecovered'),lineage:currentLineageSchema,recoveryRun:chash,instanceId:cid,boot:chash,rootDigest:chash,headDigest:chash,outcome:z.enum(['recovered','blocked']),managerRegistrationDigest:chash,operatorApprovalDigest:chash}).strict(),
 z.object({schema:z.literal('osv-mcp.q2.c3b.recovery.body.v1'),api:z.literal('GetRecoveryStatus'),lineage:currentLineageSchema,recoveryRun:chash,instanceId:cid}).strict(),
]);
export const recoveryReplySchema=z.discriminatedUnion('api',[
 z.object({schema:z.literal('osv-mcp.q2.c3b.recovery.reply.v1'),api:z.literal('ReportRecovered'),lineage:currentLineageSchema,recoveryRun:chash,instanceId:cid,boot:chash,reportDigest:chash,liveGrant:z.literal(false)}).strict(),
 z.object({schema:z.literal('osv-mcp.q2.c3b.recovery.reply.v1'),api:z.literal('GetRecoveryStatus'),lineage:currentLineageSchema,recoveryRun:chash,instanceId:cid,
  states:z.array(z.object({instanceId:cid,boot:chash,lifecycle:z.enum(['recovering','control-ready','operational','draining','blocked','closed']),lineagePhase:z.enum(['uninitialized','provisioning','serving','draining','frozen','retired'])}).strict()).max(32),liveGrant:z.literal(false)}).strict(),
]);
const recoveryEnvelopeSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.recovery.envelope.v1'),direction:z.enum(['request','reply']),keyId:cid,keyEpoch:cn.positive(),body:z.unknown(),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
/** Syntax only; the channel and role-specific recovery authorizer still authenticate the caller. */
export function parseRecoveryEnvelope(bytes:Buffer){const e=parsed(recoveryEnvelopeSchema,decodeCurrent(bytes));return {...e,body:e.direction==='request'?parsed(recoveryReportSchema,e.body):parsed(recoveryReplySchema,e.body)};}
const floorSchema=z.object({controlRevision:cn,selectionRevision:cn,revocationEpoch:cn}).strict();
export class ServiceContextFloor {
 readonly #lineage:z.infer<typeof currentLineageSchema>;#floor:z.infer<typeof floorSchema>|null=null;
 constructor(lineage:unknown){this.#lineage=parsed(currentLineageSchema,lineage);}
 observe(value:unknown){const v:any=parsed(auxiliaryValues.ReadContext,value),b=parsed(currentBindingSchema,v.binding);for(const [k,x]of Object.entries(this.#lineage))need((b as any)[k]===x,'binding_mismatch');need(v.controlRevision===v.anchorRevision&&same(v.record,v.anchorRecord)&&(v.controlRevision===0)===(v.record===null),'binding_mismatch');
  const next={controlRevision:v.controlRevision,selectionRevision:b.selectionRevision,revocationEpoch:b.revocationEpoch};if(this.#floor)for(const k of Object.keys(next) as (keyof typeof next)[])need(next[k]>=this.#floor[k],'rollback_detected');this.#floor=next;return this.snapshot();}
 snapshot(){return structuredClone(this.#floor);}
}
const recoveryState=z.object({clientCredentialId:cid,serverCredentialId:cid,sessionId:chash,clientNonce:chash,serverNonce:chash,transcriptDigest:chash,serverBoot:chash,keyEpoch:cn.positive(),clientBoot:chash,clientKeyEpoch:cn.positive(),deploymentDigest:chash,registryDigest:chash,endpointId:cid,operationKey:chash,requestDigest:chash,bindingDigest:chash,payloadDigest:chash,lineage:currentLineageSchema,floor:floorSchema.nullable(),operationStartedMs:cn,deadlineMs:cn,pinExpiresMs:cn,bootRequestsUsed:cn.max(256),recoveries:cn.max(1),status:z.enum(['abandoned','ready']),requestSequence:cn.positive(),replySequence:cn.positive()}).strict();
export const sessionRecoverySchema=z.object({schema:z.literal('osv-mcp.q2.c3b.session-recovery.v1'),old:recoveryState,next:recoveryState,nowMs:cn}).strict();
export function validateSessionRecovery(value:unknown){const r=parsed(sessionRecoverySchema,value),a=r.old,b=r.next;
 need(a.status==='abandoned'&&b.status==='ready'&&a.recoveries===0&&b.recoveries===1,'recovery_required');
 for(const k of ['clientCredentialId','serverCredentialId','serverBoot','keyEpoch','clientBoot','clientKeyEpoch','deploymentDigest','registryDigest','endpointId','operationKey','requestDigest','bindingDigest','payloadDigest','operationStartedMs','deadlineMs','pinExpiresMs'] as const)need(a[k]===b[k],'binding_mismatch');need(same(a.lineage,b.lineage),'binding_mismatch');
 need(a.sessionId!==b.sessionId&&a.clientNonce!==b.clientNonce&&a.serverNonce!==b.serverNonce&&a.transcriptDigest!==b.transcriptDigest&&b.requestSequence===1&&b.replySequence===1&&b.bootRequestsUsed>a.bootRequestsUsed,'binding_mismatch');
 need(r.nowMs>=a.operationStartedMs&&r.nowMs<a.deadlineMs&&r.nowMs<a.pinExpiresMs&&a.deadlineMs-a.operationStartedMs<=5000&&a.pinExpiresMs-a.operationStartedMs<=5000,'request_expired');
 if(a.floor){need(b.floor,'rollback_detected');for(const k of Object.keys(a.floor) as (keyof NonNullable<typeof a.floor>)[])need(b.floor[k]>=a.floor[k],'rollback_detected');}
 return {operationKey:a.operationKey,requestDigest:a.requestDigest,floor:structuredClone(b.floor),scope:'static-contract-only' as const,backendEligible:false,originalReadsSkipped:0};
}
