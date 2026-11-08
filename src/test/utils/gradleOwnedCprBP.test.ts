import {it,expect,vi} from 'vitest';
import {cprBCase} from '../fixtures/gradleOwnedCprB.js';
import {cprBPCase} from '../fixtures/gradleOwnedCprBP.js';
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import {pack as original} from '../fixtures/gradleOwnedCprAPlanner.js';
import {pack,type PlannerVariant} from '../fixtures/gradleOwnedCprBPPlanner.js';
import {collectPlans,type PlanTrace} from '../fixtures/gradleOwnedCprBPProfile.js';
import {instrumentPlans} from '../fixtures/gradleOwnedCprBPInstrumentation.js';
const variants:PlannerVariant[]=['reference','max-first','single-check','combined'];
const workloads=[[600,700,1600,2000,3000],[100,200,300,400,500,600,700,800,900],[3061,1250,20810,5057,949,635,2072,6745,881],[41456,1,1,1,1]];
const semantic=(p:ReturnType<typeof pack>)=>{const {stats,...rest}=p;return rest;};
for(const sizes of workloads)for(const role of ['reader','authority-broker'] as const)for(const variant of variants)it('preserves complete plan/commands/bounds for '+variant+' '+role+' '+sizes,()=>{
 const f=cprFixture({sizes,role,largeIds:true}),ref=original(f.ctx,f.entries,'seed','transfer'),p=pack(f.ctx,f.entries,'seed','transfer',undefined,undefined,{variant,actor:'unit'});
 expect(semantic(p)).toEqual(semantic(ref));expect(p.stats).toMatchObject({packingCommands:0,packingAuthorization:0,packingOwners:0,packingFrames:0,finalCommands:ref.commands.length,finalAuthorization:ref.commands.length,finalOwners:2*ref.commands.length,finalFrames:4*ref.commands.length});
 if(variant==='max-first'||variant==='combined')expect(p.stats.arithmeticTrials).toBeLessThan(ref.stats.arithmeticTrials);
});
for(const variant of variants)it('uses independent fresh provider plans on signed sessions '+variant,async()=>{
 const f=cprBPCase('B-independent',{variant});try{const r=await f.transfer();expect(r.providerPlans).toBe(r.requests);expect(f.provider.metrics.loads).toBe(r.requests+2);expect(r.clientPlans).toBe(2);expect(f.provider.rows.slice(2).every(x=>x.spent.work===222515)).toBe(true);}finally{f.close();}
});
it('bridges the reference fork against the original signed-session case',async()=>{
 const ref=cprBCase('B-independent'),fork=cprBPCase('B-independent',{variant:'reference'});
 try{const a=await ref.transfer(),b=await fork.transfer();expect(a.outputDigest).toBe(b.outputDigest);expect(a.planDigest).toBe(b.planDigest);expect(a.wireBytes).toBe(b.wireBytes);expect(ref.provider.metrics.calls).toBe(fork.provider.metrics.calls);expect(ref.provider.plans.map(x=>x.planDigest)).toEqual(fork.provider.plans.map(x=>x.planDigest));}finally{ref.close();fork.close();}
});
for(const variant of ['reference','combined'] as const)it('partitions diagnostic time without nested double counting '+variant,async()=>{
 const traces:PlanTrace[]=[],restore=instrumentPlans(),f=cprBPCase('B-independent',{variant});
 try{const r=await collectPlans(traces,()=>f.transfer());expect(traces).toHaveLength(2+r.requests);expect(traces.map(t=>t.actor)).toEqual(['client-initial','client-seal',...Array(r.requests).fill('provider')]);
 for(const t of traces){expect(t.failed).toBe(false);expect(t.otherMs).toBeGreaterThanOrEqual(-0.001);expect(t.buckets['schema']!.calls).toBeGreaterThan(0);expect(t.buckets['hash.digest']!.calls).toBeGreaterThan(0);expect(t.buckets['codec']!.calls).toBe(t.commands+1);expect(t.buckets['command']!.calls).toBe(t.commands);expect(Math.abs(t.wallMs-t.otherMs-Object.values(t.buckets).reduce((n,b)=>n+b.exclusiveMs,0))).toBeLessThan(0.01);}
 }finally{f.close();restore();}
});

import * as wire from '../fixtures/gradleOwnedCprAWire.js';
it('preserves binary fallback and the full plan under a tighter diagnostic layout cap',()=>{
 const f=cprFixture(),base=wire.layout;let failures=0;
 const spy=vi.spyOn(wire,'layout').mockImplementation((...args)=>{const value=base(...args);return {bound(rs){const b=value.bound(rs),fits=b.fits&&rs.reduce((n,r)=>n+r.length,0)<=1000;if(!fits)failures++;return {...b,fits};}};});
 try{const a=original(f.ctx,f.entries,'seed','transfer'),b=pack(f.ctx,f.entries,'seed','transfer',undefined,undefined,{variant:'combined',actor:'unit'});expect(failures).toBeGreaterThan(0);expect(semantic(a)).toEqual(semantic(b));}finally{spy.mockRestore();}
});
it('does not turn a non-wire layout failure into a packing fallback',()=>{
 const f=cprFixture(),spy=vi.spyOn(wire,'layout').mockReturnValue({bound(){throw Error('permission_denied');}});
 try{expect(()=>pack(f.ctx,f.entries,'seed','transfer',undefined,undefined,{variant:'combined',actor:'unit'})).toThrow('permission_denied');}finally{spy.mockRestore();}
});
for(const variant of variants)for(const when of [1,3,10])it('stops at the original planner gate '+variant+' '+when,()=>{
 const f=cprFixture();let gates=0;expect(()=>pack(f.ctx,f.entries,'seed','transfer',()=>{if(++gates===when)throw Error('request_expired');},undefined,{variant,actor:'unit'})).toThrow('request_expired');expect(gates).toBe(when);
});
it('reduces schema/digest duplicates while keeping every final codec check',async()=>{
 const summaries:PlanTrace[]=[];
 for(const variant of ['reference','single-check'] as const){const out:PlanTrace[]=[],restore=instrumentPlans(),f=cprBPCase('B-independent',{variant});try{await collectPlans(out,()=>f.transfer());summaries.push(out.find(x=>x.actor==='provider')!);}finally{f.close();restore();}}
 const [a,b]=summaries;expect(b!.buckets.schema!.calls).toBe(a!.buckets.schema!.calls-a!.commands);
 expect(b!.buckets['hash.digest']!.calls).toBe(a!.buckets['hash.digest']!.calls-a!.commands);
 expect(b!.buckets.codec!.calls).toBe(a!.buckets.codec!.calls);expect(b!.buckets.gate!.calls).toBe(a!.buckets.gate!.calls);
});

it('keeps completed commands independent from each other and the core',()=>{
 const f=cprFixture(),p=pack(f.ctx,f.entries,'seed','transfer',undefined,undefined,{variant:'combined',actor:'unit'}),second=structuredClone(p.commands[1]!),core=structuredClone(p.core);
 p.commands[0]!.peer.instanceId='mutated';p.commands[0]!.payload.ranges[0]!.entry.sha256='0'.repeat(64);
 expect(p.commands[1]).toEqual(second);expect(p.core).toEqual(core);
});
it('copies untrusted planner inputs before any gate can mutate them',()=>{
 const f=cprFixture(),expected=semantic(original(f.ctx,f.entries,'seed','transfer'));let changed=false;
 const p=pack(f.ctx,f.entries,'seed','transfer',()=>{if(!changed){changed=true;f.ctx.peer.instanceId='changed';f.entries[0]!.sha256='0'.repeat(64);}},undefined,{variant:'combined',actor:'unit'});
 expect(semantic(p)).toEqual(expected);
});

let random=0xbadc0de;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
for(let i=0;i<40;i++){const sizes=Array.from({length:5+next()%5},()=>1+next()%4500),role=i%2?'reader' as const:'authority-broker' as const,chars=1+next()%128;
 it('preserves generated plan '+i,()=>{const f=cprFixture({sizes,role,largeIds:i%3===0}),seed='s'.repeat(chars),transfer='t'.repeat(chars),a=original(f.ctx,f.entries,seed,transfer),b=pack(f.ctx,f.entries,seed,transfer,undefined,undefined,{variant:'combined',actor:'unit'});expect(semantic(b)).toEqual(semantic(a));expect(b.workUnits+b.stats.arithmeticTrials).toBeLessThanOrEqual(156978);});
}
it('rejects an unknown planner variant before signed IO',()=>{expect(()=>cprBPCase('B-independent',{variant:'unknown' as PlannerVariant})).toThrow('configuration_invalid');});
