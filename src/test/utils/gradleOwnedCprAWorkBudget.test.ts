import {it,expect,vi} from 'vitest';
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import * as planner from '../fixtures/gradleOwnedCprAPlanner.js';
it('rejects source-only work before admission, source read or provider planning',()=>{
 const f=cprFixture(),q=f.plan().commands[0]!,wire=f.wire(q),call=f.api.openCall(wire),spy=vi.spyOn(planner,'pack');
 try{expect(()=>f.api.admit(call,wire,{wire:81920,work:65536})).toThrow('operation_budget');
 expect(f.api.diagnostics).toEqual([]);expect(f.reads).toBe(0);expect(spy).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}
});

import {CPR_WORK} from '../fixtures/gradleOwnedCprAAdmission.js';
import {wireIntent} from '../fixtures/gradleOwnedCprASchema.js';
it('rechecks work before a load after reservation shrinks',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);
 f.api.shrink(a.scope,{wire:163840,work:CPR_WORK.total-1});
 const before=f.api.diagnostics;
 expect(()=>f.api.load(a.scope)).toThrow('operation_budget');
 expect(f.reads).toBe(0);expect(f.api.metrics).toMatchObject({loads:0,plans:0});expect(f.api.diagnostics).toEqual(before);
});
it('rechecks work before planning and leaves the last finish unit reserved',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);const snap=f.api.load(a.scope);
 f.api.shrink(a.scope,{wire:163840,work:CPR_WORK.source+CPR_WORK.plan});
 const before=f.api.diagnostics,spy=vi.spyOn(planner,'pack');
 try{for(let i=0;i<3;i++)expect(()=>f.api.derive(a.scope,snap)).toThrow('operation_budget');
 expect(spy).not.toHaveBeenCalled();expect(f.api.metrics.plans).toBe(0);expect(f.api.diagnostics).toEqual(before);
 }finally{vi.restoreAllMocks();}
});
it('charges planning before any planner work, retains failures and forbids repeating the attempt',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);const snap=f.api.load(a.scope),original=planner.pack;
 let gates=0;const spy=vi.spyOn(planner,'pack').mockImplementation((c,e,s,t,gate,stats)=>{
  expect(f.api.diagnostics[0]!.spent.work).toBe(CPR_WORK.source+CPR_WORK.plan);
  return original(c,e,s,t,()=>{gate?.();if(++gates===5)throw Error('plan_fault');},stats);
 });
 try{expect(()=>f.api.derive(a.scope,snap)).toThrow('plan_fault');
 const before=f.api.diagnostics;
 expect(before[0]).toMatchObject({state:'complete-refused',attempt:1,remainingAttempts:1,spent:{work:CPR_WORK.source+CPR_WORK.plan}});
 for(let i=0;i<3;i++)expect(()=>f.api.derive(a.scope,snap)).toThrow();
 expect(spy).toHaveBeenCalledTimes(1);expect(f.api.diagnostics).toEqual(before);expect(f.api.metrics).toMatchObject({plans:1,parts:0,replies:0});
 }finally{vi.restoreAllMocks();}
 const before=f.api.diagnostics[0]!,b=f.admitted(a.q);expect(f.api.diagnostics[0]).toMatchObject({k:before.k,d:before.d,deadline:before.deadline,attempt:2,spent:before.spent});
 f.api.pre(b.scope);const next=f.api.load(b.scope);f.api.derive(b.scope,next);
 expect(f.api.diagnostics[0]!.spent.work).toBe(2*(CPR_WORK.source+CPR_WORK.plan));
});
it('retains a mismatching plan charge and refuses repeated planning',()=>{
 const f=cprFixture(),q=structuredClone(f.plan().commands[0]!);q.payload.plan.planDigest='1'.repeat(64);q.requestDigest=wireIntent(q);
 const a=f.admitted(q);f.api.pre(a.scope);const snap=f.api.load(a.scope),spy=vi.spyOn(planner,'pack');
 try{expect(()=>f.api.derive(a.scope,snap)).toThrow('plan_mismatch');const before=f.api.diagnostics;
 expect(before[0]).toMatchObject({state:'complete-refused',spent:{work:CPR_WORK.source+CPR_WORK.plan}});
 expect(()=>f.api.derive(a.scope,snap)).toThrow();expect(spy).toHaveBeenCalledTimes(1);expect(f.api.diagnostics).toEqual(before);
 }finally{vi.restoreAllMocks();}
});
it('does not repeat a successful plan within the same attempt',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);const snap=f.api.load(a.scope),p=f.api.derive(a.scope,snap),before=f.api.diagnostics,spy=vi.spyOn(planner,'pack');
 try{expect(()=>f.api.derive(a.scope,snap)).toThrow();expect(spy).not.toHaveBeenCalled();expect(f.api.diagnostics).toEqual(before);
 f.api.promote(a.scope,snap,p);
 }finally{vi.restoreAllMocks();}
});
it('allows the exact conservative work boundary through completion',()=>{
 const f=cprFixture(),q=f.plan().commands[0]!,wire=f.wire(q),call=f.api.openCall(wire);
 const lease=f.api.admit(call,wire,{wire:81920,work:CPR_WORK.total}),scope=f.api.scope(lease);
 f.api.pre(scope);const snap=f.api.load(scope),plan=f.api.derive(scope,snap),permit=f.api.promote(scope,snap,plan);
 f.api.parts(permit);f.api.finish(permit);
 expect(f.api.diagnostics[0]).toMatchObject({state:'complete-success',spent:{work:CPR_WORK.total},remaining:{work:0}});
});

import * as codec from '../fixtures/gradleOwnedCprAWire.js';
it('rejects the complete reservation minus one unit without reading',()=>{
 const f=cprFixture(),q=f.plan().commands[0]!,wire=f.wire(q),call=f.api.openCall(wire);
 expect(()=>f.api.admit(call,wire,{wire:81920,work:CPR_WORK.total-1})).toThrow('operation_budget');
 expect(f.reads).toBe(0);expect(f.api.diagnostics).toEqual([]);
});
it('retains the prepaid plan charge when a final codec check throws',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);const snap=f.api.load(a.scope),spy=vi.spyOn(codec,'exact').mockImplementation(()=>{throw Error('codec_fault');});
 try{expect(()=>f.api.derive(a.scope,snap)).toThrow('codec_fault');const before=f.api.diagnostics;
 expect(before[0]).toMatchObject({state:'complete-refused',spent:{work:CPR_WORK.source+CPR_WORK.plan}});
 expect(()=>f.api.derive(a.scope,snap)).toThrow();expect(spy).toHaveBeenCalledTimes(1);expect(f.api.diagnostics).toEqual(before);
 }finally{vi.restoreAllMocks();}
});
it('retains work and retired state when the original deadline arrives inside planning',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);const snap=f.api.load(a.scope),original=planner.pack;
 const spy=vi.spyOn(planner,'pack').mockImplementation((c,e,s,t,gate,stats)=>{
  let calls=0;return original(c,e,s,t,()=>{if(++calls===5)f.setNow(4500);gate?.();},stats);
 });
 try{expect(()=>f.api.derive(a.scope,snap)).toThrow('request_expired');const before=f.api.diagnostics;
 expect(before[0]).toMatchObject({state:'retired',spent:{work:CPR_WORK.source+CPR_WORK.plan}});
 expect(()=>f.api.derive(a.scope,snap)).toThrow();expect(spy).toHaveBeenCalledTimes(1);expect(f.api.diagnostics).toEqual(before);
 }finally{vi.restoreAllMocks();}
});
it('does not reset work by starting a fresh exact retry after failure',()=>{
 const f=cprFixture(),q=f.plan().commands[0]!,wire=f.wire(q),call=f.api.openCall(wire);
 const lease=f.api.admit(call,wire,{wire:81920,work:CPR_WORK.total}),scope=f.api.scope(lease);
 f.api.pre(scope);const snap=f.api.load(scope),spy=vi.spyOn(planner,'pack').mockImplementation(()=>{throw Error('plan_fault');});
 try{expect(()=>f.api.derive(scope,snap)).toThrow('plan_fault');}finally{vi.restoreAllMocks();}
 const before=f.api.diagnostics;
 expect(()=>f.api.admit(f.api.openCall(wire),wire)).toThrow('operation_budget');
 expect(f.api.diagnostics).toEqual(before);expect(f.reads).toBe(1);expect(f.api.metrics.plans).toBe(1);
});
