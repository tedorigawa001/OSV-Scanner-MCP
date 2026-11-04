/** Explicit authenticated-session ports. No filesystem handles or foreign private keys. */
import {randomBytes} from 'node:crypto';
import {ownerPlanFacts,type OwnerPlan,type RoleSigner,type ServiceIdentity} from './gradleOwnedServiceOwners.js';
import {makeRegistryCommand,sameRegistryValue as same} from './gradleOwnedRegistrySchema.js';
import {makeSourceCommand,sourceResultSchema,type SourceCommand} from './gradleOwnedSourceSchema.js';
import {registryResultSchema,signOwnerValue} from './gradleOwnedRoleSigner.js';
import {parsed,need,type CurrentBinding,type CurrentRef} from './gradleOwnedCurrentSchema.js';
export type AuthenticatedOwnerRPC=(api:string,wire:Buffer)=>Promise<unknown>;
export interface SourceBindingPort {check:(binding:CurrentBinding,target:CurrentRef,origin:ServiceIdentity,purpose:'checkpoint'|'source-read'|'handoff',snapshot:CurrentRef|null)=>Promise<void>}
export class SourceRegistryClient implements SourceBindingPort {
 constructor(readonly plan:OwnerPlan,readonly signer:RoleSigner,readonly rpc:AuthenticatedOwnerRPC){}
 async check(binding:CurrentBinding,target:CurrentRef,origin:ServiceIdentity,purpose:'checkpoint'|'source-read'|'handoff',snapshot:CurrentRef|null){const c=ownerPlanFacts(this.plan);need(['provider','checkpoint-issuer','authority-broker'].includes(c.role)&&this.signer.identity.credentialId===c.clientCredentialId,'permission_denied');const command=makeRegistryCommand({api:'control.CheckLiveBinding',operationId:'live-'+randomBytes(16).toString('hex'),peer:this.signer.identity,lineage:c.lineage,binding,payload:{target,purpose,origin,delegateInstance:c.instanceId,snapshot}}),wire=await signOwnerValue(this.plan,this.signer,'control',command.api,{api:'CheckLiveBinding',command}),reply=parsed(registryResultSchema,await this.rpc(command.api,wire));need(reply.requestDigest===command.requestDigest&&same(reply.lineage,c.lineage)&&reply.mode==='observed','binding_mismatch');const result:any=reply.result;need(result.phase==='active'&&same(result.target,target)&&result.selectionRevision===binding.selectionRevision,'grant_revoked');}
}
export interface SourcePeerPort {call:(api:SourceCommand['api'],payload:unknown,binding:CurrentBinding,operationId?:string)=>Promise<unknown>;remaining:()=>number}
export class SourcePeerClient implements SourcePeerPort {
 constructor(readonly plan:OwnerPlan,readonly signer:RoleSigner,readonly rpc:AuthenticatedOwnerRPC,readonly remaining:()=>number){}
 async call(api:SourceCommand['api'],payload:unknown,binding:CurrentBinding,operationId='source-'+randomBytes(16).toString('hex')){const c=ownerPlanFacts(this.plan);need(this.signer.identity.credentialId===c.clientCredentialId,'peer_mismatch');const command=makeSourceCommand({api,operationId,peer:this.signer.identity,lineage:c.lineage,binding,payload}),domain=api.startsWith('aux.')?'aux':'control',wire=await signOwnerValue(this.plan,this.signer,domain,api,{api:api.slice(api.indexOf('.')+1),command}),reply=parsed(sourceResultSchema,await this.rpc(api,wire));need(reply.requestDigest===command.requestDigest&&same(reply.lineage,c.lineage),'binding_mismatch');return reply.result;}
}
