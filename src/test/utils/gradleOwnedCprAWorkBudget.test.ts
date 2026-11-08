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

it('rechecks the reply reservation before post or signing and ends a short finish as refused',()=>{
 const f=cprFixture(),v=f.verified();f.api.parts(v.permit);const d=f.api.diagnostics[0]!;
 f.api.shrink(v.scope,{wire:d.spent.wire,work:d.spent.work+CPR_WORK.finish});
 const sign=vi.spyOn(codec,'owner');
 try{expect(()=>f.api.finish(v.permit)).toThrow('operation_budget');expect(sign).not.toHaveBeenCalled();}finally{vi.restoreAllMocks();}
 const before=f.api.diagnostics;expect(before[0]).toMatchObject({state:'complete-refused',spent:d.spent});
 expect(()=>f.api.finish(v.permit)).toThrow();expect(f.api.diagnostics).toEqual(before);expect(f.api.metrics.replies).toBe(0);
});
it('keeps the work unit for finish reserved after promotion',()=>{
 const f=cprFixture(),v=f.verified();f.api.parts(v.permit);const d=f.api.diagnostics[0]!;
 f.api.shrink(v.scope,{wire:d.limit.wire,work:d.spent.work});
 expect(()=>f.api.finish(v.permit)).toThrow('operation_budget');
 expect(f.api.diagnostics[0]).toMatchObject({state:'complete-refused',spent:d.spent});expect(f.api.metrics.replies).toBe(0);
});
it('ends a failed source load as refused, retains the source charge and permits an exact retry',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);const good=f.source.payloads[3]!;f.source.payloads[3]=Buffer.from('changed').toString('base64');
 expect(()=>f.api.load(a.scope)).toThrow('source_integrity');const before=f.api.diagnostics;
 expect(before[0]).toMatchObject({state:'complete-refused',attempt:1,remainingAttempts:1,spent:{work:CPR_WORK.source}});
 expect(()=>f.api.load(a.scope)).toThrow();expect(f.reads).toBe(1);expect(f.api.diagnostics).toEqual(before);
 f.api.closeCall(a.call);expect(f.api.diagnostics[0]!.state).toBe('complete-refused');
 f.source.payloads[3]=good;const b=f.admitted(a.q);f.api.pre(b.scope);f.api.load(b.scope);
 expect(f.api.diagnostics[0]).toMatchObject({k:before[0]!.k,deadline:before[0]!.deadline,attempt:2,spent:{work:2*CPR_WORK.source}});
});
it('ends a failed source read callback as refused without a snapshot',()=>{
 const f=cprFixture(),a=f.admitted();f.api.pre(a.scope);(f.source as any).commits=null;
 expect(()=>f.api.load(a.scope)).toThrow();expect(f.api.diagnostics[0]).toMatchObject({state:'complete-refused',spent:{work:CPR_WORK.source}});
 expect(f.api.metrics).toMatchObject({loads:1,plans:0});
});
it('ends a post failure as refused and does not repeat post',()=>{
 const f=cprFixture(),v=f.verified();f.api.parts(v.permit);f.cancelPost();
 expect(()=>f.api.finish(v.permit)).toThrow('pin_revoked');const before=f.api.diagnostics;
 expect(before[0]!.state).toBe('complete-refused');expect(()=>f.api.finish(v.permit)).toThrow();expect(f.api.diagnostics).toEqual(before);expect(f.api.metrics.replies).toBe(0);
});
