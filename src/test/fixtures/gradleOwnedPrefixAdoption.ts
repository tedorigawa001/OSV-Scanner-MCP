/** Q4 diagnostic adoption gate. No independent registry/current pin backend exists yet. */
import {z} from 'zod';
import {verifyNativeTransportRun} from './gradleOwnedTransport.js';
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const pins=z.object({managerKeyDigest:hash,controllerKeyDigest:hash,manifestDigest:hash,runId:z.string().min(1).max(64)}).strict();
type Pins=z.infer<typeof pins>;
export const PREFIX_ADOPTION_BLOCKERS=Object.freeze([
 'native_storage_isolation_unverified','native_durable_service_unverified','source_checkpoint_issuer_unverified',
 'independent_registry_current_pin_unavailable','distributed_handoff_fencing_unverified',
 'native_suffix_verifier_unverified','approved_runtime_profile_unavailable','authority_migration_bridge_unimplemented',
] as const);
/** Public records establish only the exact B1ct observations checked by its verifier.
 * Approval booleans, a self-signed profile or a cached report cannot grant eligibility. */
export function inspectPrefixAdoption(input?:{record:Buffer;pins:Pins}){
 let transport:ReturnType<typeof verifyNativeTransportRun>|undefined;
 if(input){
  // Unknown fields (self-asserted approvals, removed blockers) are a schema refusal, never a partial accept.
  const result=z.object({record:z.instanceof(Buffer),pins}).strict().safeParse(input);if(!result.success)throw new Error('prefix_adoption_schema');const parsed=result.data;
  transport=verifyNativeTransportRun({...parsed.pins,record:parsed.record});
 }
 return Object.freeze({schema:'osv-mcp.q3q4.diagnostic-adoption.v1',
  authenticatedTransportObserved:transport?.authenticatedTransportObserved??false,
  nativeLaunchBindingsVerified:transport?.nativeLaunchBindingsVerified??0,
  restartFdDrainObserved:transport?.restartFdDrainObserved??false,
  blockers:Object.freeze([...(transport?[]:['authenticated_transport_unverified']),...PREFIX_ADOPTION_BLOCKERS]),
  independentRegistryVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});
}
/** Read-before gate: no source, path resolver or reader callback is accepted here. */
export function requireProductionPrefixBackend(input?:Parameters<typeof inspectPrefixAdoption>[0]):never{
 const result=inspectPrefixAdoption(input);throw new Error('prefix_adoption_'+result.blockers[0]);
}
