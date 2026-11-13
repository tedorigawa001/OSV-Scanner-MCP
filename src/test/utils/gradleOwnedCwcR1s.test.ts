import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {writeSummaryAt,checkSummaryAt,SUMMARY_FIELDS,type SummaryRecord} from '../fixtures/gradleOwnedCwcR1sWire.js';
import {R1sDelivery,observeR1s,R1S_SCOPE} from '../fixtures/gradleOwnedCwcR1s.js';
import {r1sMatrix} from '../fixtures/gradleOwnedCwcR1sFixture.js';
const modes=['full-input','owned-input'] as const;
function sample():SummaryRecord{return {readSeq:1,attempt:1,generation:1,reason:0,captured:2,proved:2,work:17,initialization:3,wire:256,attempts:1,heldBytes:6144,pending:0,borrow:0,zeroedBytes:0,exportOrdinal:1,sourceDigest:'1'.repeat(64),profileDigest:'2'.repeat(64),layoutDigest:'3'.repeat(64)};}
it.each(modes)('R1ST01: %s writes the exact 256-byte schema and validates all counters and fixed bindings',()=>{
 const b=new Uint8Array(512),record=sample();writeSummaryAt(b,256,record);checkSummaryAt(b,256,record);expect([...b.slice(256,264)]).toEqual([82,49,72,83,0,1,0,0]);
 const v=new DataView(b.buffer);for(let i=0;i<15;i++)expect(Number(v.getBigUint64(264+i*8,false))).toBe(record[SUMMARY_FIELDS[i]!] as number);expect([...b.slice(480)]).toEqual(Array(32).fill(0));expect([...b.slice(384,416)]).toEqual(Array(32).fill(17));
});
it.each(modes)('R1ST20: %s replays normal loss cancellation and unavailable cases with immutable packet bytes',mode=>{
 const e=r1sMatrix();expect([e.normal.length,e.rejection.length,e.cancelled.length,e.unavailable.length]).toEqual([8,16,4,2]);
 for(const row of e.normal.filter(r=>r.mode===mode)){expect(row.packets).toHaveLength(row.attempts);for(const stage of row.stages){expect(stage.early).toBe(true);expect(stage.duplicate).toBe('duplicate');expect(stage.held.read!.items[stage.attempt-1]!.realBorrow).toBe(true);}expect(row.late).toBe(true);expect(row.final.rows).toBe(0);expect(row.final.receiverCopies).toBe(row.attempts);expect(row.final.zeroedBytes).toBe(row.final.allocatedBytes);}
 for(const row of e.rejection.filter(r=>r.mode===mode)){expect(row.refused&&row.early).toBe(true);expect(row.waiting.receiverCopies).toBe(0);expect(row.waiting.read!.main).toBe('success');expect(row.final.rows).toBe(0);}for(const row of e.cancelled.filter(r=>r.mode===mode)){expect(row.early).toBe(true);expect(row.stillHeld.read!.items[0]!.consumerPending).toBe(true);expect(row.final.rows).toBe(0);}for(const row of e.unavailable.filter(r=>r.mode===mode))expect(row.noRecord&&row.again).toBe(true);
 if(mode==='owned-input'&&process.env.CWC_R1S_EVIDENCE_PATH)writeFileSync(process.env.CWC_R1S_EVIDENCE_PATH,JSON.stringify(e));
});
it.each(modes)('R1ST10: %s treats summary generation failure as unavailable without changing main success',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead();r.finishMain(h,'success');r.faultNext('encode-fail');expect(r.emit(h,1)).toBeUndefined();expect(()=>r.emit(h,1)).toThrow('ordinal');expect(observeR1s(r,h).read!.main).toBe('success');expect(observeR1s(r).unavailable).toBe(1);r.reclaim(h);expect(observeR1s(r).mainSuccesses).toBe(1);
});
it.each(modes)('R1ST11: %s keeps fixed capacities and local epoch issuance without a history of live rows',mode=>{
 for(const capacity of [1,4]){const r=new R1sDelivery(mode,capacity),reads=Array.from({length:capacity},()=>r.beginRead());expect(()=>r.beginRead()).toThrow('registry_full');expect(observeR1s(r).allocatedBytes).toBe(1280*capacity);for(const h of reads){r.finishMain(h,'success');r.reclaim(h);}const next=r.beginRead();expect(next).not.toBe(reads[0]);expect(()=>r.finishMain(reads[0]!,'success')).toThrow('binding');r.finishMain(next,'success');r.reclaim(next);expect(observeR1s(r).rows).toBe(0);}
 const r=new R1sDelivery(mode);for(let i=0;i<64;i++){const h=r.beginRead();r.finishMain(h,'success');r.reclaim(h);}expect(()=>r.beginRead()).toThrow('epoch_budget');expect(observeR1s(r).zeroedBytes).toBe(64*1280);
});
it.each(modes)('R1ST12: %s separates duplicate issuance from two bounded replay attempts',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;expect(()=>r.emit(h,1)).toThrow('ordinal');r.emit(h,2);expect(()=>r.emit(h,2)).toThrow('ordinal');expect(()=>r.emit(h,3 as any)).toThrow('ordinal');r.finishMain(h,'success');
 for(let i=0;i<2;i++){r.dispatch(h,t,r.recipient());r.receive(h,t);r.completeTransfer(h,t);}expect(()=>r.dispatch(h,t,r.recipient())).toThrow('transport_budget');expect(observeR1s(r).receiverCopies).toBe(1);r.cancelDiagnostics(h);r.discardConsumer(h,t);r.reclaim(h);
});
it.each(modes)('R1ST13: %s validates every counter digest and reserved byte and rejects malformed owned records before writing',()=>{
 const src=sample(),b=new Uint8Array(256);writeSummaryAt(b,0,src);const positions=[0,4,5,6,7,128,160,192,224,255,...Array.from({length:15},(_,i)=>8+i*8+7)];for(const at of positions){const bad=b.slice();bad[at]=bad[at]!^1;expect(()=>checkSummaryAt(bad,0,src)).toThrow();}
 const wide={...src,work:Number.MAX_SAFE_INTEGER};writeSummaryAt(b,0,wide);checkSummaryAt(b,0,wide);const overflow=b.slice();overflow[8+6*8]=255;expect(()=>checkSummaryAt(overflow,0,wide)).toThrow('counter');
 for(const n of [-1,-0,NaN,Infinity,1.5]){const empty=new Uint8Array(256);expect(()=>writeSummaryAt(empty,0,{...src,work:n})).toThrow();expect([...empty]).toEqual(Array(256).fill(0));}expect(()=>checkSummaryAt(new Uint8Array(255),0,src)).toThrow('length');
});
it.each(modes)('R1ST14: %s rejects getters proxies shared backing and coercion without evaluating them',()=>{
 let calls=0;const input={...sample()};Object.defineProperty(input,'work',{get(){calls++;return 1;},enumerable:true});expect(()=>writeSummaryAt(new Uint8Array(256),0,input)).toThrow('accessor');
 const proxy=new Proxy(sample(),{ownKeys(){calls++;return [];}});expect(()=>writeSummaryAt(new Uint8Array(256),0,proxy)).toThrow();
 const shared=new Uint8Array(new SharedArrayBuffer(256));Object.defineProperty(shared,'buffer',{get(){calls++;return new ArrayBuffer(256);}});expect(()=>writeSummaryAt(shared,0,sample())).toThrow('shared_buffer');
 expect(()=>writeSummaryAt(new Uint8Array(256),0,{...sample(),work:{[Symbol.toPrimitive](){calls++;return 1;}}} as any)).toThrow();expect(calls).toBe(0);
});
it.each(modes)('R1ST15: %s catches reentry internally but refuses the outer delivery before any receiver copy',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.faultNext('receive-reentry');expect(()=>r.receive(h,t)).toThrow('retired');expect(observeR1s(r).receiverCopies).toBe(0);expect(observeR1s(r).caughtReentries).toBe(1);expect(observeR1s(r,h).read!.main).toBe('success');expect(()=>r.reclaim(h)).toThrow('early_reclaim');r.completeTransfer(h,t);r.reclaim(h);
});
it.each(modes)('R1ST16: %s uses an independent diagnostic deadline and drains after expiry or recipient revocation',mode=>{
 for(const how of ['expiry','revoke','purpose'] as const){const r=new R1sDelivery(mode),h=r.beginRead();r.advance(4500);r.finishMain(h,'expired');const t=r.emit(h,1,3)!;r.dispatch(h,t,r.recipient());if(how==='expiry')r.advance(1500);else if(how==='revoke')r.revokeRecipient();else r.setDiagnosticPurpose(false);
  expect(()=>r.receive(h,t)).toThrow();expect(observeR1s(r,h).read!.main).toBe('expired');r.completeTransfer(h,t);r.reclaim(h);expect(observeR1s(r).mainSuccesses).toBe(0);
 }
});
it.each(modes)('R1ST17: %s rejects tampering before receiver copying and still reclaims without altering the core outcome',mode=>{
 for(const fault of ['header','counter','digest','reserved','generation'] as const){const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.faultNext(fault);r.dispatch(h,t,r.recipient());expect(()=>r.receive(h,t)).toThrow('r1s_wire');expect(observeR1s(r).receiverCopies).toBe(0);expect(observeR1s(r,h).read!.retiring).toBe(true);r.completeTransfer(h,t);r.reclaim(h);expect(observeR1s(r).mainSuccesses).toBe(1);}
});
it.each(modes)('R1ST18: %s retains spent ordinary and cleanup quotas and quarantines exhausted cleanup capacity',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead();for(let i=0;i<240;i++)expect(()=>r.emit(h,2)).toThrow('ordinal');expect(()=>r.emit(h,1)).toThrow('entry_budget');r.finishMain(h,'success');r.reclaim(h);expect(observeR1s(r).zeroedBytes).toBe(1280);
 const q=new R1sDelivery(mode),read=q.beginRead();q.finishMain(read,'success');q.emit(read,1);for(let i=0;i<15;i++)expect(()=>q.reclaim(read)).toThrow('early_reclaim');expect(()=>q.reclaim(read)).toThrow('cleanup_budget');const s=observeR1s(q,read);expect(s.read!.cleanup).toBe(16);expect(s.read!.retiring).toBe(true);expect(s.rows).toBe(1);expect(s.zeroedBytes).toBe(0);
});
it.each(modes)('R1ST19: %s proves only synthetic local delivery and never exports authority or adopts production',mode=>{
 const r=new R1sDelivery(mode);expect(()=>r.adoptProduction()).toThrow('profile_unsupported');expect(observeR1s(r).allocatedBytes).toBe(0);expect(R1S_SCOPE.syntheticProducerReceipt&&R1S_SCOPE.syntheticDigestBindings).toBe(true);for(const k of ['realCoreReceipt','authenticatedIPC','independentRecipientApproval','actualParentLedgerVector','physicalHeapBound','wholeBudgetFit','productionAdopted'] as const)expect(R1S_SCOPE[k]).toBe(false);
});
it.each(modes)('R1ST09: %s discards an unborrowed queued record after cancellation without restoring delivery rights',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.receive(h,t);r.cancelDiagnostics(h);r.completeTransfer(h,t);expect(()=>r.reclaim(h)).toThrow('early_reclaim');r.discardConsumer(h,t);r.reclaim(h);expect(observeR1s(r).mainSuccesses).toBe(1);expect(observeR1s(r).rows).toBe(0);
});
it.each(modes)('R1ST03: %s keeps the read slot after ACK until the actual consumer borrow ends',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.receive(h,t);r.ack(h,t);r.completeTransfer(h,t);const lease=r.borrowConsumer(h,t);
 expect(()=>r.reclaim(h)).toThrow('early_reclaim');expect(()=>r.beginRead()).toThrow('registry_full');const s=observeR1s(r,h);expect(s.read!.items[0]!.realBorrow).toBe(true);expect(s.rows).toBe(1);expect(s.read!.main).toBe('success');
 r.consume(h,lease);r.releaseConsumer(h,lease);r.reclaim(h);expect(observeR1s(r).zeroedBytes).toBe(1280);
});
it.each(modes)('R1ST04: %s replays immutable bytes after response loss without another receive copy',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.receive(h,t);r.completeTransfer(h,t);
 r.dispatch(h,t,r.recipient());expect(r.receive(h,t)).toBe('duplicate');r.ack(h,t);r.completeTransfer(h,t);expect(observeR1s(r).receiverCopies).toBe(1);expect(observeR1s(r).deduplicated).toBe(1);expect(observeR1s(r).sends).toBe(2);
 const b=r.borrowConsumer(h,t);r.consume(h,b);r.releaseConsumer(h,b);r.reclaim(h);expect(()=>r.dispatch(h,t,r.recipient())).toThrow('binding');
});
it.each(modes)('R1ST05: %s does not recreate a freed consumer copy when an ACK is lost',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.receive(h,t);r.completeTransfer(h,t);const b=r.borrowConsumer(h,t);r.consume(h,b);r.releaseConsumer(h,b);
 expect(()=>r.reclaim(h)).toThrow('early_reclaim');r.dispatch(h,t,r.recipient());expect(r.receive(h,t)).toBe('duplicate');r.ack(h,t);r.completeTransfer(h,t);expect(()=>r.borrowConsumer(h,t)).toThrow('consumer_state');expect(observeR1s(r).receiverCopies).toBe(1);r.reclaim(h);
});
it.each(modes)('R1ST06: %s diagnostic cancellation waits for transfer and consumer debts without changing the main outcome',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.finishMain(h,'success');r.dispatch(h,t,r.recipient());r.receive(h,t);const b=r.borrowConsumer(h,t);r.cancelDiagnostics(h);expect(()=>r.reclaim(h)).toThrow('early_reclaim');expect(()=>r.receive(h,t)).toThrow('retired');
 r.completeTransfer(h,t);expect(()=>r.reclaim(h)).toThrow('early_reclaim');r.releaseConsumer(h,b);r.reclaim(h);expect(observeR1s(r).mainSuccesses).toBe(1);
});
it.each(modes)('R1ST07: %s rejects recipient clones and cross-owner records before transferring bytes',mode=>{
 const r=new R1sDelivery(mode,2),other=new R1sDelivery(mode),a=r.beginRead(),b=r.beginRead(),t=r.emit(a,1)!;expect(()=>r.dispatch(a,t,other.recipient())).toThrow('recipient_binding');expect(()=>r.dispatch(a,t,{...r.recipient()})).toThrow('recipient_binding');expect(()=>r.dispatch(b,t,r.recipient())).toThrow('record_binding');expect(observeR1s(r).sends).toBe(0);
 r.finishMain(a,'cancelled');r.cancelDiagnostics(a);r.reclaim(a);r.finishMain(b,'cancelled');r.reclaim(b);
});
it.each(modes)('R1ST08: %s validates receipt bindings in the selected mode without reducing full wire validation',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),t=r.emit(h,1)!;r.dispatch(h,t,r.recipient());r.receive(h,t);const b=r.borrowConsumer(h,t);r.consume(h,b);const s=observeR1s(r,h).read!;
 expect(mode==='full-input'?s.fullChecks:s.ownedChecks).toBeGreaterThan(0);expect(mode==='full-input'?s.ownedChecks:s.fullChecks).toBe(0);r.finishMain(h,'success');r.ack(h,t);r.completeTransfer(h,t);r.releaseConsumer(h,b);r.reclaim(h);
});
it.each(modes)('R1ST02: %s preallocates sender transfer receiver storage and delivers two fixed records',mode=>{
 const r=new R1sDelivery(mode),h=r.beginRead(),peer=r.recipient();r.finishMain(h,'success');const a=r.emit(h,1)!,b=r.emit(h,2)!;expect(observeR1s(r,h).read!.binaryBytes).toBe(1280);
 const leases=[];for(const token of [a,b]){r.dispatch(h,token,peer);expect(r.receive(h,token)).toBe('delivered');r.ack(h,token);r.completeTransfer(h,token);leases.push(r.borrowConsumer(h,token));}
 expect(observeR1s(r,h).read!.items.every(i=>i.realBorrow)).toBe(true);expect(()=>r.reclaim(h)).toThrow('early_reclaim');
 r.consume(h,leases[0]!);r.releaseConsumer(h,leases[0]!);r.consume(h,leases[1]!);r.releaseConsumer(h,leases[1]!);
 r.reclaim(h);const s=observeR1s(r);expect(s.rows).toBe(0);expect(s.reclaims).toBe(1);expect(s.zeroedBytes).toBe(1280);expect(s.mainSuccesses).toBe(1);
});
