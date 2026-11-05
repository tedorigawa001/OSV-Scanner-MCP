import {readFile} from 'node:fs/promises';
import {manifestCase,I0_WORKLOAD} from '../fixtures/gradleOwnedCgpI0Case.js';
import {it,expect} from 'vitest';
import {ownedDigest as h,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {I0_FLAGS,I0_GUARD_POLICY,i0Bootstrap,i0CheckPrimary,i0Manifest,type I0Mode} from '../fixtures/gradleOwnedCgpI0Schema.js';

it('CGI01/28 pins a strict fixture manifest and rejects guard-off and wrong mode even with re-pinning',()=>{
 const {manifest,pins}=manifestCase();expect(i0Manifest(i0Bootstrap(manifest,pins)).mode).toBe('B*');
 for(const change of [(m:any)=>m.guard.enabled=false,(m:any)=>m.facts=true,(m:any)=>m.readPlan.algorithm='scalar-control-v1',(m:any)=>m.extra=true,(m:any)=>m.fixtureApproved=false]){const m=structuredClone(manifest);change(m);const p={...pins,manifestDigest:h(m),guardDigest:h(m.guard)};m.guardDigest=p.guardDigest;p.manifestDigest=h(m);expect(()=>i0Bootstrap(m,p)).toThrow();}
});
it('CGI28 keeps policy and limits common to all primary modes and ignores no source/profile differences',()=>{
 const cases=(['S*','A*','B*','AB*'] as const).map(mode=>manifestCase(mode));expect(i0CheckPrimary(cases.map(c=>i0Bootstrap(c.manifest,c.pins)))).toBe(true);
 const changed=manifestCase('S*');changed.manifest.guard.maxSlots=511;changed.manifest.guardDigest=h(changed.manifest.guard);changed.pins.guardDigest=changed.manifest.guardDigest;changed.pins.manifestDigest=h(changed.manifest);
 expect(()=>i0CheckPrimary([i0Bootstrap(changed.manifest,changed.pins),...cases.slice(1).map(c=>i0Bootstrap(c.manifest,c.pins))])).toThrow('primary_policy_mismatch');
});
it('keeps the validation record equal to the fixtures it describes',async()=>{
 const record=JSON.parse(await readFile('docs/validation/gradle-c3b-cgp-i0-2026-11-05.json','utf8'));
 expect(Object.keys(record.sources).length).toBeGreaterThan(0);
 for(const [file,sha]of Object.entries(record.sources))expect([file,ownedSha256(await readFile(file))]).toEqual([file,sha]);
 expect(record.guard).toEqual(I0_GUARD_POLICY);expect(record.workload).toEqual(I0_WORKLOAD);expect(record.flags).toEqual(I0_FLAGS);
});
