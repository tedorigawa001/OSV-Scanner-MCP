import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {R1oRuntime,R1O_SCOPE} from '../fixtures/gradleOwnedCwcR1o.js';
import {r1oFixture,r1oReady,r1oSuccess,r1oRefusal,r1oMatrix,r1oReviewMatrix} from '../fixtures/gradleOwnedCwcR1oFixture.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {createR1oBudget} from '../fixtures/gradleOwnedCwcR1oBudget.js';
const drained=(s:ReturnType<R1oRuntime['stats']>)=>{expect(s.alive).toBe(false);expect(s.released).toBe(true);expect(s.privateBuffers).toBe(0);expect(s.sourceBuffers+s.destinationBuffers+s.borrowReferences+s.frames).toBe(0);expect(s.pinned||s.exclusive).toBe(false);expect(s.zeroVerified).toBe(true);expect(s.zeroedBytes).toBe(s.allocatedBytes);expect(s.budget.heldBytes).toBe(0);};
it('R1OT01: registration allocates the same shells before content construction and uses existing window aliases',()=>{
 const f=r1oFixture(),c=f.r.createCall(),s=f.r.registerOwnedIntake(c,'source'),d=f.r.registerOwnedIntake(c,'destination');const initial=f.r.stats(c);expect(initial.constructs+initial.bufferAllocations+initial.validations).toBe(0);expect(initial.scopeAllocations).toBe(2);
 f.r.reserveDiagnostic(c);const w=f.r.constructOwnedState(c,s);expect(f.r.coreHandle(c,w)).toBe(w);expect(f.r.stats(c).sameSourceScope).toBe(true);f.r.moveOwnedState(c,w,d);const out=f.r.publishOwnedWindow(c);expect(f.r.coreHandle(c,out)).toBe(out);expect(f.r.stats(c).sameDestinationScope).toBe(true);f.r.close(c);drained(f.r.stats(c));
});
it('R1OT02: all role/context/workload/actor observations preserve byte identity and reject callback faults',()=>{
 const e=r1oMatrix();expect(e.successes).toHaveLength(36);expect(e.refusals).toHaveLength(42);
 for(const row of e.successes){expect(row.before).toEqual(row.after);expect(row.sourceAlias&&row.destinationAlias).toBe(true);expect(row.waiting.borrowUsesPinnedStore).toBe(true);expect(row.published.sameStore&&row.published.sameLease&&row.published.sourceRemoved).toBe(true);expect(row.published.publications).toBe(1);drained(row.drained);expect(row.drained).toEqual(row.secondClose);}
 for(const row of e.refusals){expect(row.refused&&row.attempted).toBe(true);expect(row.diagnosticCalls).toBe(0);expect(row.after.binds+row.after.publications).toBe(0);expect(row.after.writes+row.after.zeroWrites).toBe(0);drained(row.after);}
 if(process.env.CWC_R1O_EVIDENCE_PATH)writeFileSync(process.env.CWC_R1O_EVIDENCE_PATH,JSON.stringify(e));
},60000);
it('R1OT03: a pre-hydration data read rejects before any producer or content allocation',()=>{
 const {r}=r1oFixture(),c=r.createCall(),s=r.registerOwnedIntake(c,'source');expect(()=>r.inspectScope(c,s)).toThrow('not_hydrated');const z=r.stats(c);expect(z.constructs+z.bufferAllocations+z.freshSourceReads).toBe(0);drained(z);
});
it('R1OT04: construction without a diagnostic capacity ticket does not touch source data',()=>{
 const {r}=r1oFixture(),c=r.createCall(),s=r.registerOwnedIntake(c,'source');r.registerOwnedIntake(c,'destination');expect(()=>r.constructOwnedState(c,s)).toThrow('capacity_required');expect(r.stats(c).constructs+r.stats(c).bufferAllocations).toBe(0);drained(r.stats(c));
});
it('R1OT05: raw graphs, caller complete flags and getters cannot register an owned producer',()=>{
 let reads=0;for(const value of [{get context(){reads++;return {};},complete:true},new Proxy({},{get(){reads++;throw Error('proxy');}})]){
  const {r}=r1oFixture(),c=r.createCall();expect(()=>r.registerOwnedIntake(c,'source',value)).toThrow('raw_input_unsupported');expect(r.stats(c).constructs).toBe(0);drained(r.stats(c));
 }const {r}=r1oFixture(),c=r.createCall(),s=r.registerOwnedIntake(c,'source');r.registerOwnedIntake(c,'destination');r.reserveDiagnostic(c);expect(()=>r.constructOwnedState(c,s,{complete:true})).toThrow('raw_input_unsupported');expect(r.stats(c).constructs).toBe(0);drained(r.stats(c));expect(reads).toBe(0);
});
it('R1OT06: cloned/cross-call claims do not select a destination or change the other call',()=>{
 for(const foreign of [false,true]){const f=r1oReady(),c2=f.r.createCall(),d2=f.r.registerOwnedIntake(c2,'destination');const bad=foreign?d2:{...f.destination};expect(()=>f.r.moveOwnedState(f.call,f.window,bad)).toThrow('binding');drained(f.r.stats(f.call));expect(f.r.stats(c2).alive).toBe(true);f.r.close(c2);}
});
it('R1OT07: a real existing borrow can finish across a turn before exclusive validation starts',async()=>{
 const f=r1oReady(),b=f.r.beginBorrow(f.call,f.window);f.r.moveOwnedState(f.call,f.window,f.destination);const s=f.r.stats(f.call);expect(s.borrowReferences).toBe(2);expect(s.borrowUsesPinnedStore).toBe(true);expect(s.validations).toBe(0);await Promise.resolve();
 f.r.borrowUpdate(f.call,b,'core','touch');f.r.completeBorrow(f.call,b);f.r.publishOwnedWindow(f.call);expect(f.r.stats(f.call).validations).toBe(1);f.r.close(f.call);drained(f.r.stats(f.call));
});
it('R1OT08: early validation refusal retains pinned buffers and capacity until the old borrow exits',()=>{
 const f=r1oReady(),b=f.r.beginBorrow(f.call,f.window);f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow('borrow_active');let s=f.r.stats(f.call);expect(s.validations+s.zeroedBytes).toBe(0);expect(s.privateBuffers).toBe(2);expect(s.borrowReferences).toBe(2);expect(s.budget.heldBytes).toBe(196608);
 f.r.completeBorrow(f.call,b);drained(f.r.stats(f.call));const z=f.r.stats(f.call).zeroedBytes;expect(()=>f.r.completeBorrow(f.call,b)).toThrow();expect(f.r.stats(f.call).zeroedBytes).toBe(z);
});
it('R1OT09: source new-entry updates are stopped while existing borrow references still live',()=>{
 const f=r1oReady(),b=f.r.beginBorrow(f.call,f.window);f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.sourceUpdate(f.call,f.window,'core','corrupt')).toThrow('mutation_blocked');expect(f.r.stats(f.call).writes).toBe(0);expect(f.r.stats(f.call).zeroedBytes).toBe(0);f.r.completeBorrow(f.call,b);drained(f.r.stats(f.call));
});
it('R1OT10: close during quiescence does not zero a borrowed store or refund work',()=>{
 const f=r1oReady(),b=f.r.beginBorrow(f.call,f.window),paid=f.budget.stats();f.r.moveOwnedState(f.call,f.window,f.destination);f.r.close(f.call);expect(f.r.stats(f.call).zeroedBytes).toBe(0);expect(f.r.stats(f.call).pinned).toBe(true);f.r.completeBorrow(f.call,b);drained(f.r.stats(f.call));expect(f.budget.stats().work).toBe(paid.work);expect(f.budget.stats().initialization).toBe(paid.initialization);
});
it('R1OT11: retiring the transferred source does not zero or release destination data',()=>{
 const row=r1oSuccess();expect(row.published.sourceBuffers).toBe(0);expect(row.published.destinationBuffers).toBe(2);expect(row.published.zeroedBytes).toBe(0);expect(row.published.releases).toBe(0);expect(row.published.lateSourceRetired).toBe(true);expect(row.published.bufferAllocations).toBe(2);expect(row.drained.releases).toBe(1);
});
it.each(['context','core'] as const)('R1OT12: %s bytes are read again by final validation rather than a cached complete flag',part=>{
 const f=r1oReady();f.r.sourceUpdate(f.call,f.window,part,'corrupt');f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow();expect(f.r.stats(f.call).validations).toBe(1);expect(f.r.stats(f.call).publications).toBe(0);drained(f.r.stats(f.call));
});
it.each(['core-schema','core-inventory','context-binding'] as const)('R1OT13: valid JSON with %s corruption fails full schema/snapshot/context binding',fault=>{
 const f=r1oReady();f.r.sourceUpdate(f.call,f.window,fault==='context-binding'?'context':'core',fault);f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow();const z=f.r.stats(f.call);expect(z.validations).toBe(1);expect(z.schemaChecks).toBe(fault==='core-schema'?1:2);expect(z.inventoryChecks).toBe(fault==='core-schema'?0:1);expect(z.binds+z.publications).toBe(0);drained(z);
});
it('R1OT14: a caught corrupt-and-restore callback cannot clear fatal state or publish',()=>{
 const x=r1oRefusal('provider','after-validation','restore-pair');expect(x.innerCaught).toBe(2);expect(x.after.deniedWrites).toBe(2);expect(x.after.writes+x.after.zeroWrites+x.after.publications).toBe(0);expect(x.inside!.privateBuffers).toBe(2);expect(x.inside!.zeroedBytes).toBe(0);drained(x.after);
});
it('R1OT15: zero at the final callback is refused before writing and cleanup runs only after it returns',()=>{
 const x=r1oRefusal('provider','before-bind','zero');expect(x.innerCaught).toBe(1);expect(x.inside!.exclusive).toBe(true);expect(x.inside!.zeroWrites+x.inside!.zeroedBytes).toBe(0);expect(x.after.zeroedBytes).toBeGreaterThan(0);expect(x.after.publications).toBe(0);drained(x.after);
});
it('R1OT16: callback reentry/exception and expiry preserve failure cleanup and the original deadline',()=>{
 for(const fault of ['reentry','throwing-message','expire','close'] as const){const x=r1oRefusal('client-seal','before-bind',fault);expect(x.after.publications).toBe(0);expect(x.diagnosticCalls).toBe(0);if(fault==='expire')expect(x.after.reason).toBe('expired');drained(x.after);}
});
it('R1OT17: missing R1-M/W/G proof always refuses production adoption before producer access',()=>{
 const {r}=r1oFixture(),c=r.createCall();r.registerOwnedIntake(c,'source');r.registerOwnedIntake(c,'destination');expect(()=>r.adoptProduction(c)).toThrow('profile_unsupported');const s=r.stats(c);expect(s.constructs+s.bufferAllocations+s.validations+s.reservations).toBe(0);expect(s.scope).toEqual(R1O_SCOPE);drained(s);
});
it('R1OT18: capacity/work shortage is refused before any target construction',()=>{
 for(const [memory,work]of [[196607,156978],[1048576,8191]]){const budget=createR1oBudget(memory,work),{r}=r1oFixture({budget}),c=r.createCall();r.registerOwnedIntake(c,'source');r.registerOwnedIntake(c,'destination');expect(()=>r.reserveDiagnostic(c)).toThrow('codec_budget_exceeded');expect(r.stats(c).constructs+r.stats(c).bufferAllocations).toBe(0);drained(r.stats(c));}
});
it('R1OT19: late handles/repeated bind cannot republish or release memory twice',()=>{
 const f=r1oReady();f.r.moveOwnedState(f.call,f.window,f.destination);f.r.publishOwnedWindow(f.call);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow();drained(f.r.stats(f.call));const n=f.r.stats(f.call).zeroedBytes;expect(()=>f.r.coreHandle(f.call,f.window)).toThrow();f.r.close(f.call);expect(f.r.stats(f.call).zeroedBytes).toBe(n);expect(f.r.stats(f.call).releases).toBe(1);
});
it('R1OT20: no callback occurs between the final fence, custody bind and publication',()=>{
 const x=r1oSuccess(),t=x.published.trace.map(e=>e.kind),at=t.indexOf('final-fence');expect(t.slice(at,at+3)).toEqual(['final-fence','bind-destination','publish-window']);expect(x.published.sameStore&&x.published.sameLease&&x.published.sameSourceScope&&x.published.sameDestinationScope).toBe(true);
});
it('R1OT21: derived budgets cannot bypass a zero real reservation',()=>{
 let calls=0;class FakeBudget extends Lb0Budget {override reserve(){calls++;return Object.freeze({kind:'lb0-memory-reservation' as const});}override release(){calls++;}}
 const b=new FakeBudget(undefined,0,0);expect(()=>new R1oRuntime({budget:b})).toThrow('budget_binding');expect(calls).toBe(0);
 class Derived extends Lb0Budget {}expect(()=>new R1oRuntime({budget:new Derived()})).toThrow('budget_binding');
});
it.each(['check','reserve','release','stats'] as const)('R1OT22: replacement of %s is refused before the changed operation executes',key=>{
 const f=r1oReady(),p=Lb0Budget.prototype,d=Object.getOwnPropertyDescriptor(p,key)!;let calls=0;
 try{Object.defineProperty(p,key,{...d,value:function(...args:unknown[]){calls++;return Reflect.apply(d.value,this,args);}});expect(()=>f.r.moveOwnedState(f.call,f.window,f.destination)).toThrow('budget_binding');}
 finally{Object.defineProperty(p,key,d);}expect(calls).toBe(0);expect(f.r.stats(f.call).publications).toBe(0);drained(f.r.stats(f.call));
});
it.each(['after-validation','before-bind'] as const)('R1OT23: an unfinished native Promise at %s prevents publication and delays reclamation',async site=>{
 let pending:Promise<void>|undefined,completed=false,caught=0;
 const f=r1oReady({hook:(at,r,c,s)=>{if(at===site){pending=(async()=>{await Promise.resolve();try{r.sourceZero(c,s,'core');}catch{caught++;}completed=true;})();return pending;}}});
 try{f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow('async_callback_unsupported');const z=f.r.stats(f.call);expect(completed).toBe(false);expect(z.publications+z.binds+z.zeroedBytes).toBe(0);expect(z.privateBuffers).toBe(2);f.r.close(f.call);expect(f.r.stats(f.call).zeroedBytes).toBe(0);}
 finally{await pending;f.r.close(f.call);}expect(completed).toBe(true);expect(caught).toBe(1);expect(f.r.stats(f.call).publications).toBe(0);drained(f.r.stats(f.call));
});
it('R1OT24: a check replacement from the final callback cannot close after publication or run at all',()=>{
 const original=Object.getOwnPropertyDescriptor(Lb0Budget.prototype,'check')!;let calls=0;
 const f=r1oReady({hook:(at,r,c)=>{if(at==='before-bind')Object.defineProperty(Lb0Budget.prototype,'check',{...original,value(){calls++;r.close(c);}});}});
 try{f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow('budget_binding');}finally{Object.defineProperty(Lb0Budget.prototype,'check',original);}
 expect(calls).toBe(0);expect(f.r.stats(f.call).binds+f.r.stats(f.call).publications).toBe(0);drained(f.r.stats(f.call));
});
it('R1OT25: operation accessor replacements and unregistered base budgets do not execute getters',()=>{
 let reads=0;const p=Lb0Budget.prototype,d=Object.getOwnPropertyDescriptor(p,'stats')!,f=r1oReady();
 try{Object.defineProperty(p,'stats',{configurable:true,get(){reads++;return d.value;}});expect(()=>f.r.moveOwnedState(f.call,f.window,f.destination)).toThrow('budget_binding');}finally{Object.defineProperty(p,'stats',d);}
 drained(f.r.stats(f.call));const balance={work:0,initialization:0,wire:0,attempts:0,get extra(){reads++;return 0;}},b=new Lb0Budget(balance);expect(()=>new R1oRuntime({budget:b})).toThrow('budget_binding');expect(reads).toBe(0);
});
it('R1OT26: a returned thenable is refused without evaluating its then getter',()=>{
 let reads=0;const f=r1oReady({hook:at=>{if(at==='before-bind')return {get then(){reads++;throw Error('getter');}};}});
 f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow('async_callback_unsupported');expect(reads).toBe(0);expect(f.r.stats(f.call).publications).toBe(0);drained(f.r.stats(f.call));
});
it('R1OT27: rejected native callbacks drain without a caller then getter or an unhandled rejection',async()=>{
 let pending:Promise<void>|undefined,reads=0;
 const f=r1oReady({hook:at=>{if(at==='before-bind'){pending=(async()=>{await Promise.resolve();throw Error('async-fault');})();Object.defineProperty(pending,'then',{get(){reads++;throw Error('then');}});return pending;}}});
 f.r.moveOwnedState(f.call,f.window,f.destination);expect(()=>f.r.publishOwnedWindow(f.call)).toThrow('async_callback_unsupported');expect(f.r.stats(f.call).pendingCallbacks).toBe(1);
 await new Promise<void>(resolve=>Reflect.apply(Promise.prototype.then,pending!,[()=>resolve(),()=>resolve()]));expect(reads).toBe(0);expect(f.r.stats(f.call).pendingCallbacks).toBe(0);expect(f.r.stats(f.call).publications).toBe(0);drained(f.r.stats(f.call));
});
it('R1OT28: all review fault cases preserve capacity, pending lifetime and zero publication',async()=>{
 const e=await r1oReviewMatrix();expect(e.constructorBudgets).toHaveLength(3);expect(e.operationBudgets).toHaveLength(16);expect(e.asyncCallbacks).toHaveLength(12);
 for(const r of e.constructorBudgets){expect(r.refused).toBe(true);expect(r.operationCalls+r.externalReads).toBe(0);expect(r.registered).toBe(false);}
 for(const r of e.operationBudgets){expect(r.refused).toBe(true);expect(r.operationCalls+r.after.binds+r.after.publications).toBe(0);drained(r.after);}
 for(const r of e.asyncCallbacks){expect(r.refused&&r.completed&&r.lateRejected).toBe(true);expect(r.completedAtRefusal).toBe(false);expect(r.caught).toBe(1);expect(r.waiting.pendingCallbacks).toBe(1);expect(r.waiting.privateBuffers).toBe(2);expect(r.waiting.zeroedBytes+r.closed.zeroedBytes+r.after.publications).toBe(0);expect(r.after.pendingCallbacks).toBe(0);drained(r.after);expect(r.after).toEqual(r.late);}
 if(process.env.CWC_R1O_REVIEW_PATH)writeFileSync(process.env.CWC_R1O_REVIEW_PATH,JSON.stringify(e));
});
