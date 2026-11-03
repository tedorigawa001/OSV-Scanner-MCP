import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {inspectPrefixAdoption,requireProductionPrefixBackend,PREFIX_ADOPTION_BLOCKERS} from '../fixtures/gradleOwnedPrefixAdoption.js';
const dir=new URL('../../../docs/validation/',import.meta.url);
const input=()=>({record:readFileSync(new URL('gradle-q2b-b1ct-transport-2026-11-03.json',dir)),pins:JSON.parse(readFileSync(new URL('gradle-q2b-b1ct-transport-2026-11-03.bindings.json',dir),'utf8'))});
it('does not open production reads without authenticated evidence',()=>{
 expect(inspectPrefixAdoption()).toMatchObject({authenticatedTransportObserved:false,backendEligible:false,originalReadsSkipped:0});expect(()=>requireProductionPrefixBackend()).toThrow('authenticated_transport_unverified');
});
it('recognizes verified native transport without upgrading it to storage isolation or approval',()=>{
 const result=inspectPrefixAdoption(input());expect(result).toMatchObject({authenticatedTransportObserved:true,nativeLaunchBindingsVerified:2,restartFdDrainObserved:true,independentRegistryVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0});expect(result.blockers).toEqual(PREFIX_ADOPTION_BLOCKERS);expect(()=>requireProductionPrefixBackend(input())).toThrow('native_storage_isolation_unverified');
});
for(const field of ['managerKeyDigest','controllerKeyDigest','manifestDigest','runId'])it('requires independent pin '+field,()=>{
 const value=input();value.pins[field]=field==='runId'?'wrong-run':'1'.repeat(64);
 expect(()=>inspectPrefixAdoption(value)).toThrow(field==='managerKeyDigest'||field==='controllerKeyDigest'?/^q2b_transport_independent_key_pin$/:/^q2b_transport_independent_manifest_pin$/);
});
for(const field of ['profileApproved','backendEligible','independentRegistryVerified'])it('rejects self asserted '+field,()=>{
 const value=input();Object.assign(value,{[field]:true});expect(()=>inspectPrefixAdoption(value)).toThrow(/^prefix_adoption_schema$/);
});
it('does not accept caller-authored blocker removal or profile into pin settings',()=>{
 const value=input();value.pins.blockers=[];value.pins.profileApproved=true;expect(()=>inspectPrefixAdoption(value)).toThrow(/^prefix_adoption_schema$/);
});
