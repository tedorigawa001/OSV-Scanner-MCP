/** Consumer-only authenticated adapter. It never obtains a broker/provider private key or actor factory. */
import {SessionClient,verifiedServiceOutcome} from './gradleOwnedSessionRuntime.js';
import {makeRegistryCommand,sameRegistryValue as same} from './gradleOwnedRegistrySchema.js';
import {makeSourceCommand,sourceAPIs} from './gradleOwnedSourceSchema.js';
import {makeAuthorityCommand,authorityOwnerAPIs} from './gradleOwnedAuthorityOwnerSchema.js';
import {currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {credentialDestination} from './gradleOwnedServiceOwners.js';
import {currentOperation} from './gradleOwnedCurrentClient.js';
import {parsed,need,type CurrentBinding} from './gradleOwnedCurrentSchema.js';
export class ConsumerServiceClient {
 readonly #sessions:ReadonlyMap<string,SessionClient>;readonly lineage;readonly identity;readonly #intents=new Map<string,{api:string;wire:Buffer;target:string;id:string}>();#closed=false;
 constructor(sessions:ReadonlyMap<string,SessionClient>,lineage:unknown){this.lineage=parsed(currentLineageSchema,lineage);need(['lineage-registry','provider','checkpoint-issuer','authority-broker'].every(role=>sessions.has(role)),'configuration_invalid');const list=[...sessions.values()];this.identity=structuredClone(list[0]!.credential.identity);need(this.identity.role==='reader'&&list.every(c=>c instanceof SessionClient&&same(c.credential.identity,this.identity)&&same(c.lineage,this.lineage)),'peer_mismatch');this.#sessions=new Map(sessions);}
 assertOpen(){need(!this.#closed,'owner_closed');}
 async call(api:string,payload:unknown,binding:unknown,id=currentOperation(),deadline?:number){this.assertOpen();let intent=this.#intents.get(id);const common={api:api as any,operationId:id,peer:this.identity,lineage:this.lineage,binding:binding as CurrentBinding,payload},command=sourceAPIs.includes(api as any)?makeSourceCommand(common):authorityOwnerAPIs.includes(api as any)?makeAuthorityCommand(common):makeRegistryCommand(common),target=credentialDestination(api),session=this.#sessions.get(target)!;need(session,'permission_denied');const wire=session.signBusinessCommand(command);if(intent)need(intent.api===api&&intent.wire.equals(wire)&&intent.target===target,'idempotency_conflict');else{need(this.#intents.size<8,'capacity_exhausted');intent={api,wire,target,id};this.#intents.set(id,intent);}try{const body:any=await session.execute(session.prepareBusiness(api,intent.wire,deadline));this.assertOpen();need(body.requestDigest===command.requestDigest,'binding_mismatch');if(body.mode==='pending')throw Error('business_pending');this.#intents.delete(id);return body;}catch(error){if(verifiedServiceOutcome(error)?.outcome==='refused')this.#intents.delete(id);throw error;}}
 async context(deadline?:number){const reply=await this.call('aux.ReadContext',{purpose:'read',floor:null},this.lineage,undefined,deadline);return reply.result.binding as CurrentBinding;}
 get diagnostics(){return {pendingIntents:this.#intents.size,backendEligible:false,originalReadsSkipped:0};}
 close(){this.#closed=true;for(const c of this.#sessions.values())c.close();}
}
