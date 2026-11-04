/** Cooperative runtime drain. No UID, kernel FD, process-stop or native fencing claim. */
import {SessionClient,SessionServer,assertSessionInventory} from './gradleOwnedSessionRuntime.js';
import {ownerPlanFacts,type OwnerPlan,type RoleSigner} from './gradleOwnedServiceOwners.js';
import {runtimeDrainedProofSchema} from './gradleOwnedRegistrySchema.js';
import {signOwnerValue} from './gradleOwnedRoleSigner.js';
import {cref,parsed,need,type CurrentRef} from './gradleOwnedCurrentSchema.js';
import {ownedSha256} from './gradleOwnedJson.js';
export interface DrainableOwner {beginDrain():void;assertDrained():void}
/** Constructed only by the trusted root with the exact incoming and outgoing session objects. */
export class ServiceDrain {
 #started=false;#barrier?:CurrentRef;#wire?:Buffer;
 readonly #resources:readonly (SessionServer|SessionClient)[];
 constructor(readonly plan:OwnerPlan,readonly signer:RoleSigner,readonly owner:DrainableOwner,resources:readonly (SessionServer|SessionClient)[]){const c=ownerPlanFacts(plan);need(signer.identity.credentialId===c.clientCredentialId&&signer.direction==='request','peer_mismatch');need(resources.length>0&&resources.length<=64&&new Set(resources).size===resources.length&&resources.every(r=>r instanceof SessionServer||r instanceof SessionClient),'configuration_invalid');this.#resources=Object.freeze([...resources]);}
 async drain(barrier:CurrentRef){parsed(cref('barrier'),barrier);if(this.#barrier)need(this.#barrier.id===barrier.id&&this.#barrier.sha256===barrier.sha256&&this.#barrier.byteLength===barrier.byteLength,'binding_mismatch');else this.#barrier=structuredClone(barrier);if(this.#wire)return Buffer.from(this.#wire);
  assertSessionInventory(this.signer.identity,this.#resources);if(!this.#started){this.owner.beginDrain();this.#started=true;for(const resource of this.#resources)resource.close();}
  // close invalidates old awaits, but is not their completion. Do not sign until their actual finally ran.
  this.owner.assertDrained();for(const r of this.#resources)need(r instanceof SessionServer?r.diagnostics.activeChannels===0:r.diagnostics.pending===0&&!r.diagnostics.busy,'effects_pending');
  const c=ownerPlanFacts(this.plan),body=parsed(runtimeDrainedProofSchema,{schema:'osv-mcp.q2.c3b.runtime-drained.v1',api:'ConfirmFenced',barrier:this.#barrier,subject:c.instanceId,boot:c.boot,inFlight:0,effects:0,activeChannels:0,admissionClosed:true,scope:'cooperative-runtime'}),wire=await signOwnerValue(this.plan,this.signer,'control','control.ConfirmFenced',body);assertSessionInventory(this.signer.identity,this.#resources);this.owner.assertDrained();for(const r of this.#resources)need(r instanceof SessionServer?r.diagnostics.activeChannels===0:r.diagnostics.pending===0&&!r.diagnostics.busy,'effects_pending');this.#wire=Buffer.from(wire);return wire;
 }
 get diagnostics(){return {admissionClosed:this.#started,proofSaved:!!this.#wire,scope:'cooperative-runtime',nativeIsolationVerified:false};}
}
export const drainEvidenceRef=(bytes:Buffer):CurrentRef=>({role:'fence-evidence',id:ownedSha256(bytes),sha256:ownedSha256(bytes),byteLength:bytes.length});
