import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {R1hRuntime,createR1hPorts,observeR1h,R1H_RUNTIME_SCOPE} from '../fixtures/gradleOwnedCwcR1h.js';
import {r1hMatrix} from '../fixtures/gradleOwnedCwcR1hFixture.js';
const modes=['full-input','owned-input'] as const;
it.each(modes)('R1HT20: %s records the normal cancellation reentry and quarantine matrix with finite lifetimes',mode=>{
 const e=r1hMatrix();expect(e.normal).toHaveLength(8);expect(e.rejection).toHaveLength(28);expect(e.cleanup).toHaveLength(4);
 for(const x of e.normal.filter(x=>x.mode===mode)){expect(x.waiting.read!.retainedIdentities).toBe(16);expect(x.waiting.read!.privateBodies).toBe(2);expect(x.waiting.read!.borrowUsesFirstBody).toBe(true);expect(x.waiting.read!.bodyBuffersDistinct).toBe(true);expect(x.earlyRefused&&x.transportRefused&&x.lateRefused&&x.newOwner&&x.newWindow).toBe(true);expect(x.final.allocatedBytes).toBe(x.final.zeroedBytes);expect(x.final.heldBodySlots+x.final.readRows).toBe(0);}
 for(const x of e.rejection.filter(x=>x.mode===mode)){expect(x.denied).toBe(true);expect(x.waiting.publications).toBe(0);expect(x.waiting.authorityLookups).toBe(0);expect(x.waiting.heldBodySlots).toBe(2);expect(x.final.zeroedBytes).toBe(6144);}
 for(const x of e.cleanup.filter(x=>x.mode===mode)){expect(x.denied&&x.fullRefused&&x.lateRefused).toBe(true);expect(x.partial.zeroedBytes).toBe(3072);expect(x.partial.heldBodySlots).toBe(2);expect(x.final.reclaims).toBe(1);expect(x.final.zeroedBytes).toBe(6144);}
 if(mode==='owned-input'&&process.env.CWC_R1H_EVIDENCE_PATH)writeFileSync(process.env.CWC_R1H_EVIDENCE_PATH,JSON.stringify(e));
});
it.each(modes)('R1HT18: %s does not recycle lease identities or let old completions drain a new attempt',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode}),h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first'),oldBorrow=r.beginBorrow(h,w),oldTransport=r.beginTransport(h,w);r.endBorrow(h,oldBorrow);r.endTransport(h,oldTransport);r.closeWindow(h,w);r.openAttempt(h);const second=r.window(h,'first'),borrow=r.beginBorrow(h,second),transport=r.beginTransport(h,second);
 expect(()=>r.endBorrow(h,oldBorrow)).toThrow('borrow');expect(()=>r.endTransport(h,oldTransport)).toThrow('transport');expect(observeR1h(r,h).read!.borrows).toBe(1);expect(observeR1h(r,h).read!.pendingTransport).toBe(1);r.cancel(h);r.endBorrow(h,borrow);expect(()=>r.reclaim(h)).toThrow('early_reclaim');r.endTransport(h,transport);r.reclaim(h);
 for(const kind of ['borrow','transport'] as const){const q=new R1hRuntime({ports:createR1hPorts(),mode}),read=q.beginRead();q.openAttempt(read);const win=q.window(read,'first');if(kind==='borrow'){q.endBorrow(read,q.beginBorrow(read,win));expect(()=>q.beginBorrow(read,win)).toThrow('borrow');}else{q.endTransport(read,q.beginTransport(read,win));expect(()=>q.beginTransport(read,win)).toThrow('transport');}q.reclaim(read);}
});
it.each(modes)('R1HT19: %s publishes each open window at most once',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode}),h=r.beginRead('client');r.openAttempt(h);const w=r.window(h,'first');r.publish(h,w);expect(()=>r.publish(h,w)).toThrow('published');expect(observeR1h(r,h).read!.publications).toBe(1);r.reclaim(h);
});
it.each(modes)('R1HT17: %s avoids inherited numeric setters while constructing private tables and handles',mode=>{
 const ports=createR1hPorts(),d=Object.getOwnPropertyDescriptor(Array.prototype,'0');let calls=0,error:unknown,r:R1hRuntime|undefined,h:any;
 try{Object.defineProperty(Array.prototype,'0',{configurable:true,set(){calls++;}});r=new R1hRuntime({ports,mode});h=r.beginRead();r.openAttempt(h);r.publish(h,r.window(h,'first'));r.closeRead(h);r.reclaim(h);}catch(e){error=e;}finally{if(d)Object.defineProperty(Array.prototype,'0',d);else delete (Array.prototype as any)[0];}
 expect(error).toBeUndefined();expect(calls).toBe(0);expect(observeR1h(r!).readRows).toBe(0);
});
it.each(modes)('R1HT16: %s never dispatches private arrays to replaced Array prototype operations',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode}),h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first'),p=Array.prototype;const original=Object.getOwnPropertyDescriptor(p,'find')!;let calls=0;
 try{Object.defineProperty(p,'find',{...original,value:function(...args:unknown[]){calls++;return Reflect.apply(original.value,this,args);}});r.publish(h,w);}finally{Object.defineProperty(p,'find',original);}
 expect(calls).toBe(0);r.closeRead(h);r.reclaim(h);
 const q=new R1hRuntime({ports:createR1hPorts(),mode}),read=q.beginRead(),saved=globalThis.Error;let errorCalls=0;
 try{globalThis.Error=function(...args:any[]){errorCalls++;return Reflect.apply(saved,undefined,args);} as any;try{q.reclaim(read);}catch{}}finally{globalThis.Error=saved;}
 expect(errorCalls).toBe(0);q.closeRead(read);q.reclaim(read);
});
it.each(modes)('R1HT14: %s rejects foreign hooks ports subclasses and an overflowing deadline before body allocation',mode=>{
 const ports=createR1hPorts();let reads=0;
 for(const input of [{ports,mode,hook:undefined},{get ports(){reads++;return ports;},mode},new Proxy({ports,mode},{get(){reads++;throw Error('getter');}}),{ports:Object.create(Object.getPrototypeOf(ports)),mode}])expect(()=>new R1hRuntime(input as any)).toThrow();expect(reads).toBe(0);
 class Derived extends R1hRuntime {}expect(()=>new Derived({ports,mode})).toThrow('runtime_binding');
 const r=new R1hRuntime({ports,mode});ports.advance(Number.MAX_SAFE_INTEGER);expect(()=>r.beginRead()).toThrow('deadline');const s=observeR1h(r);expect(s.heldBodySlots+s.bufferAllocations+s.readRows).toBe(0);
});
it.each(modes)('R1HT15: %s refuses production adoption and summary export without touching bodies',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode});expect(()=>r.adoptProduction()).toThrow('profile_unsupported');expect(()=>r.exportSummary()).toThrow('summary_unsupported');expect(observeR1h(r).bufferAllocations).toBe(0);expect(R1H_RUNTIME_SCOPE.productionAdopted).toBe(false);expect(R1H_RUNTIME_SCOPE.independentChargeApproved).toBe(false);
});
it.each(modes)('R1HT06: %s normal window close is local while cancellation affects only the selected read',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode,capacity:4}),a=r.beginRead('client'),b=r.beginRead('provider');r.openAttempt(a);r.openAttempt(b);
 const first=r.window(a,'first'),seal=r.window(a,'seal'),other=r.window(b,'first');r.closeWindow(a,first);r.publish(a,seal);expect(observeR1h(r,a).read!.state).toBe('active');
 r.cancel(a);expect(observeR1h(r).authorityLookups).toBe(1);r.publish(b,other);expect(observeR1h(r,b).read!.publications).toBe(1);expect(()=>r.publish(a,seal)).toThrow();r.reclaim(a);r.closeRead(b);r.reclaim(b);expect(observeR1h(r).reclaims).toBe(2);
});
it.each(modes)('R1HT07: %s fixes registry capacity and reuses drained slots without a retained history',mode=>{
 for(const capacity of [1,4]){const r=new R1hRuntime({ports:createR1hPorts(),mode,capacity}),reads=Array.from({length:capacity},()=>r.beginRead());const old=reads[0]!;
  expect(()=>r.beginRead()).toThrow('registry_full');expect(observeR1h(r).bufferAllocations).toBe(2*capacity);
  for(const h of reads){r.closeRead(h);r.reclaim(h);}for(let i=0;i<12;i++){const h=r.beginRead();expect(h).not.toBe(old);r.closeRead(h);r.reclaim(h);}
  const s=observeR1h(r);expect(s.capacity).toBe(capacity);expect(s.readRows).toBe(0);expect(s.heldBodySlots).toBe(0);expect(s.zeroedBytes).toBe(s.allocatedBytes);expect(()=>r.openAttempt(old)).toThrow('binding');expect(observeR1h(r)).toEqual(s);
 }
});
it.each(modes)('R1HT08: %s rejects stale, cloned and foreign window identities without harming another read',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode,capacity:4}),a=r.beginRead(),b=r.beginRead();r.openAttempt(a);r.openAttempt(b);const aw=r.window(a,'first'),bw=r.window(b,'first');
 expect(()=>r.publish(a,bw)).toThrow('window');expect(observeR1h(r,a).read!.state).toBe('retiring');r.publish(b,bw);r.reclaim(a);r.closeRead(b);r.reclaim(b);
 const h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first');r.closeWindow(h,w);r.openAttempt(h);expect(()=>r.publish(h,w)).toThrow('window');expect(observeR1h(r,h).read!.publications).toBe(0);r.reclaim(h);
 const next=r.beginRead();expect(()=>r.openAttempt({...next})).toThrow('binding');expect(observeR1h(r,next).read!.state).toBe('active');r.closeRead(next);r.reclaim(next);expect(aw).not.toBe(bw);
});
it.each(modes)('R1HT09: %s keeps the original deadline across two attempts and denies a third attempt',mode=>{
 const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead();r.openAttempt(h);r.closeWindow(h,r.window(h,'first'));ports.advance(100);r.openAttempt(h);const w=r.window(h,'first');expect(observeR1h(r,h).read!.deadline).toBe(4500);ports.advance(4400);
 expect(()=>r.publish(h,w)).toThrow('expired');expect(observeR1h(r,h).read!.reason).toBe('expired');expect(observeR1h(r).heldBodySlots).toBe(2);r.reclaim(h);
 const q=new R1hRuntime({ports:createR1hPorts(),mode}),read=q.beginRead();for(let i=0;i<2;i++){q.openAttempt(read);q.closeWindow(read,q.window(read,'first'));}expect(()=>q.openAttempt(read)).toThrow('attempt');expect(observeR1h(q,read).read!.attempt).toBe(2);q.reclaim(read);
});
it.each(modes)('R1HT10: %s performs live authorization purpose and pin/revision checks in either immutable-check branch',mode=>{
 for(const fault of ['authority','purpose','restore'] as const){const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first');
  if(fault==='authority')ports.revoke();else if(fault==='purpose')ports.setPurpose('other');else{ports.setPin(2);ports.setPin(1);}
  expect(()=>r.publish(h,w)).toThrow(fault==='restore'?'revision':fault);const s=observeR1h(r,h);expect(s.publications).toBe(0);expect(s.authorityLookups).toBe(0);expect(mode==='full-input'?s.read!.fullChecks:s.read!.ownedChecks).toBeGreaterThan(0);expect(mode==='full-input'?s.read!.ownedChecks:s.read!.fullChecks).toBe(0);r.reclaim(h);
 }
});
it.each(modes)('R1HT11: %s rejects early reclaim without closing a healthy read',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode}),h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first');expect(()=>r.reclaim(h)).toThrow('early_reclaim');expect(observeR1h(r,h).read!.state).toBe('active');expect(observeR1h(r).zeroedBytes).toBe(0);r.publish(h,w);r.closeRead(h);r.reclaim(h);
});
it.each(modes)('R1HT12: %s refuses a second transport and wrong completion identities while retaining the real debt',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode}),h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first'),d=r.beginTransport(h,w);expect(()=>r.endTransport(h,{...d})).toThrow('transport');expect(observeR1h(r,h).read!.pendingTransport).toBe(1);
 expect(()=>r.beginTransport(h,w)).toThrow('transport');expect(()=>r.reclaim(h)).toThrow('early_reclaim');r.endTransport(h,d);r.reclaim(h);expect(observeR1h(r).zeroedBytes).toBe(6144);
});
it.each(modes)('R1HT13: %s closes the final fence after owned-port cancellation expiry revocation or pin restoration',mode=>{
 for(const fault of ['cancel-before-publication','expire-before-publication','revoke-before-publication','pin-restore-before-publication'] as const){
  const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead();r.openAttempt(h);const w=r.window(h,'first');ports.arm(fault);expect(()=>r.publish(h,w)).toThrow();const s=observeR1h(r,h);expect(s.publications).toBe(0);expect(s.authorityLookups).toBe(0);expect(s.read!.privateBodies).toBe(2);r.reclaim(h);
 }
});
it.each(modes)('R1HT01: %s reserves two real bodies and sixteen private identities until normal drain',mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode,capacity:1}),read=r.beginRead('provider');
 r.openAttempt(read);const w=r.window(read,'first');r.publish(read,w);r.closeWindow(read,w);r.closeRead(read);
 const before=observeR1h(r,read);expect(before.read!.privateBodies).toBe(2);expect(before.read!.retainedIdentities).toBe(16);expect(before.read!.distinctIdentities).toBe(16);expect(before.read!.binaryBytes).toBe(6144);expect(before.heldBodySlots).toBe(2);
 r.reclaim(read);const after=observeR1h(r);expect(after.readRows).toBe(0);expect(after.heldBodySlots).toBe(0);expect(after.zeroedBytes).toBe(6144);expect(after.reclaims).toBe(1);expect(after.scope).toEqual(R1H_RUNTIME_SCOPE);
});
it.each(modes)('R1HT05: %s quarantines a partial zero failure and retries cleanup exactly once',mode=>{
 const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead();r.openAttempt(h);r.closeRead(h);ports.arm('cleanup-after-first');
 expect(()=>r.reclaim(h)).toThrow('cleanup');const partial=observeR1h(r,h);expect(partial.authorityLookups).toBe(0);expect(partial.heldBodySlots).toBe(2);expect(partial.read!.privateBodies).toBe(2);expect(partial.read!.state).toBe('retiring');expect(partial.read!.reason).toBe('cleanup');expect(partial.zeroedBytes).toBe(3072);expect(partial.reclaims).toBe(0);expect(()=>r.beginRead()).toThrow('registry_full');
 r.reclaim(h);const end=observeR1h(r);expect(end.reclaims).toBe(1);expect(end.zeroedBytes).toBe(6144);expect(end.heldBodySlots).toBe(0);expect(()=>r.reclaim(h)).toThrow('binding');expect(observeR1h(r)).toEqual(end);
});
it.each(modes)('R1HT04: %s removes authority before transport drains and keeps the occupied registry slot',async mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode,capacity:1}),h=r.beginRead('provider');r.openAttempt(h);const w=r.window(h,'first'),drain=r.beginTransport(h,w);r.cancel(h);
 const before=observeR1h(r,h);expect(before.authorityLookups).toBe(0);expect(before.read!.authorityKeyPresent).toBe(false);expect(before.readRows).toBe(1);expect(before.read!.pendingTransport).toBe(1);expect(before.read!.transportUsesBody).toBe(true);
 expect(()=>r.publish(h,w)).toThrow();expect(()=>r.reclaim(h)).toThrow('early_reclaim');expect(()=>r.beginRead()).toThrow('registry_full');expect(observeR1h(r).bufferAllocations).toBe(2);expect(observeR1h(r).zeroedBytes).toBe(0);
 await Promise.resolve();r.endTransport(h,drain);r.reclaim(h);expect(observeR1h(r).heldBodySlots).toBe(0);expect(()=>r.endTransport(h,drain)).toThrow('binding');
});
it.each(modes)('R1HT03: %s latches caught public reentry and never publishes or frees an active frame',mode=>{
 for(const fault of ['reenter-publish','reenter-reclaim','reenter-open'] as const){
  const ports=createR1hPorts(),r=new R1hRuntime({ports,mode}),h=r.beginRead('provider');r.openAttempt(h);const w=r.window(h,'first');ports.arm(fault);
  expect(()=>r.publish(h,w)).toThrow('reentry');const s=observeR1h(r,h);expect(s.publications).toBe(0);expect(s.read!.state).toBe('retiring');expect(s.authorityLookups).toBe(0);expect(s.heldBodySlots).toBe(2);expect(s.zeroedBytes).toBe(0);
  expect(s.caughtReentries).toBe(1);expect(s.faultFrameCount).toBe(1);expect(s.faultHeldBodies).toBe(2);r.reclaim(h);expect(observeR1h(r).readRows).toBe(0);
 }
});
it.each(modes)('R1HT02: %s keeps both complete bodies when the first attempt still has a real borrow',async mode=>{
 const r=new R1hRuntime({ports:createR1hPorts(),mode,capacity:1}),read=r.beginRead('provider');r.openAttempt(read);const first=r.window(read,'first'),borrow=r.beginBorrow(read,first);
 r.closeWindow(read,first);const secondOwner=r.openAttempt(read),second=r.window(read,'first');expect(first).not.toBe(second);expect(secondOwner).not.toBe(read);
 const kept=observeR1h(r,read);expect(kept.read!.privateBodies).toBe(2);expect(kept.read!.referenceSlots).toBe(96);expect(kept.read!.retainedIdentities).toBe(16);expect(kept.read!.borrows).toBe(1);expect(kept.read!.borrowUsesFirstBody).toBe(true);expect(kept.read!.bodyBuffersDistinct).toBe(true);expect(kept.zeroedBytes).toBe(0);
 r.publish(read,second);r.closeWindow(read,second);r.closeRead(read);expect(()=>r.reclaim(read)).toThrow('early_reclaim');expect(observeR1h(r).heldBodySlots).toBe(2);
 await Promise.resolve();r.endBorrow(read,borrow);r.reclaim(read);expect(observeR1h(r).heldBodySlots).toBe(0);expect(observeR1h(r).zeroedBytes).toBe(6144);
});
