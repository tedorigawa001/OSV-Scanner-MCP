import {manifestCase} from '../fixtures/gradleOwnedCgpI0Case.js';
import {it,expect} from 'vitest';
import {ownedDigest as h,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {I0_GUARD_POLICY,i0Bootstrap,i0CheckPrimary,i0Manifest,type I0Mode} from '../fixtures/gradleOwnedCgpI0Schema.js';

it('CGI01/28 pins a strict fixture manifest and rejects guard-off and wrong mode even with re-pinning',()=>{
 const {manifest,pins}=manifestCase();expect(i0Manifest(i0Bootstrap(manifest,pins)).mode).toBe('B*');
 for(const change of [(m:any)=>m.guard.enabled=false,(m:any)=>m.facts=true,(m:any)=>m.readPlan.algorithm='scalar-control-v1',(m:any)=>m.extra=true,(m:any)=>m.fixtureApproved=false]){const m=structuredClone(manifest);change(m);const p={...pins,manifestDigest:h(m),guardDigest:h(m.guard)};m.guardDigest=p.guardDigest;p.manifestDigest=h(m);expect(()=>i0Bootstrap(m,p)).toThrow();}
});
it('CGI28 keeps policy and limits common to all primary modes and ignores no source/profile differences',()=>{
 const cases=(['S*','A*','B*','AB*'] as const).map(mode=>manifestCase(mode));expect(i0CheckPrimary(cases.map(c=>i0Bootstrap(c.manifest,c.pins)))).toBe(true);
 const changed=manifestCase('S*');changed.manifest.guard.maxSlots=511;changed.manifest.guardDigest=h(changed.manifest.guard);changed.pins.guardDigest=changed.manifest.guardDigest;changed.pins.manifestDigest=h(changed.manifest);
 expect(()=>i0CheckPrimary([i0Bootstrap(changed.manifest,changed.pins),...cases.slice(1).map(c=>i0Bootstrap(c.manifest,c.pins))])).toThrow('primary_policy_mismatch');
});
