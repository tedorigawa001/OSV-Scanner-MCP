/** R1-S: bounded in-process diagnostic delivery with a SYNTHETIC producer receipt. No real read/approval/IPC/charge. */
import {types} from 'node:util';
import {writeSummaryAt,checkSummaryAt,type SummaryRecord} from './gradleOwnedCwcR1sWire.js';
const NativeError=Error,Bytes=Uint8Array,NativeArray=Array,freeze=Object.freeze,define=Object.defineProperty,fill=Uint8Array.prototype.fill,apply=Reflect.apply,isProxy=types.isProxy,isSafe=Number.isSafeInteger,is=Object.is,proto=Object.getPrototypeOf;
function need(v:unknown,why:string):asserts v{if(!v)throw NativeError('r1s_'+why);}
const integer=(n:unknown):n is number=>typeof n==='number'&&isSafe(n)&&n>=0&&!is(n,-0);
function make<T>(n:number,fn:(i:number)=>T){const a=new NativeArray<T>(n);for(let i=0;i<n;i++)define(a,i,{value:fn(i),writable:true,enumerable:true,configurable:true});return a;}
function clear(b:Uint8Array,offset:number,n:number){for(let i=0;i<n;i++)b[offset+i]=0;}
function zero(b:Uint8Array,n:number){for(let i=0;i<n;i++)need(b[i]===0,'zero');}
export type SummaryHandle=Readonly<{kind:'summary-read'|'summary-record'|'summary-borrow'|'summary-recipient'}>;
export type SummaryMode='full-input'|'owned-input';
type Outcome='success'|'failed'|'cancelled'|'expired';
type Fault='encode-fail'|'header'|'counter'|'digest'|'reserved'|'generation'|'receive-reentry';
type Item={token:SummaryHandle;lease:SummaryHandle;issued:boolean;unavailable:boolean;receipt?:SummaryRecord;ownedReceipt?:SummaryRecord;delivered:boolean;consumerPending:boolean;borrowIssued:boolean;borrow?:Uint8Array;acked:boolean;sends:number;consumed:boolean;receives:number;copies:number};
type Row={read:SummaryHandle;seq:number;sender:Uint8Array;receiver:Uint8Array;flight:Uint8Array;items:Item[];inflight:number;next:number;deadline:number;main:Outcome|null;retiring:boolean;ops:number;cleanup:number;fullChecks:number;ownedChecks:number};
type Op='emit'|'dispatch'|'receive'|'ack'|'complete'|'borrow'|'consume'|'release'|'discard'|'finish'|'cancel'|'reclaim';
export const R1S_SCOPE=freeze({limitedDeliveryFixture:true,sameProcess:true,fixedClock:true,realBinaryStorage:true,closedRecipient:true,fixedTwoRecordQueue:true,syntheticProducerReceipt:true,syntheticDigestBindings:true,
 summaryIsAuthorityEvidence:false,summaryHashing:false,summaryCanonicalization:false,counterOriginalUnitMapping:false,realCoreReceipt:false,realCoreConnected:false,authenticatedIPC:false,independentRecipientApproval:false,actualParentLedgerVector:false,fullRoleSeparation:false,diagnosticCopyChargeProved:false,physicalHeapBound:false,wholeBudgetFit:false,productionAdopted:false,performanceMeasured:false});
const sourceDigest='1111111111111111111111111111111111111111111111111111111111111111',profileDigest='2222222222222222222222222222222222222222222222222222222222222222',layoutDigest='3333333333333333333333333333333333333333333333333333333333333333';
export class R1sDelivery {
 readonly #mode:SummaryMode;readonly #rows:(Row|undefined)[];readonly #peer:SummaryHandle=freeze({kind:'summary-recipient'});#now=0;#next=0;#busy=false;#active?:Row;#fault?:Fault;#revoked=false;#purpose=true;
 #allocated=0;#zeroed=0;#reclaims=0;#copies=0;#deliveries=0;#dedup=0;#sends=0;#mainSuccesses=0;#denials=0;#caught=0;#unavailable=0;
 constructor(mode:SummaryMode,capacity=1){need(new.target===R1sDelivery,'owner');need(mode==='full-input'||mode==='owned-input','mode');need(integer(capacity)&&capacity>=1&&capacity<=4,'capacity');this.#mode=mode;this.#rows=make(capacity,()=>undefined);freeze(this);}
 recipient(){return this.#peer;}
 advance(ms:number){need(integer(ms)&&integer(this.#now+ms),'clock');this.#now+=ms;}
 revokeRecipient(){this.#revoked=true;}
 setDiagnosticPurpose(enabled:boolean){need(typeof enabled==='boolean','purpose');this.#purpose=enabled;}
 faultNext(fault:Fault){need(this.#fault===undefined&&(fault==='encode-fail'||fault==='header'||fault==='counter'||fault==='digest'||fault==='reserved'||fault==='generation'||fault==='receive-reentry'),'fault');this.#fault=fault;}
 #deny(why:string):never{if(this.#denials>=64)throw 'r1s_denial_budget';this.#denials++;throw NativeError('r1s_'+why);}
 #guard(){if(this.#busy){if(this.#active)this.#active.retiring=true;this.#deny('reentry');}}
 #row(h:SummaryHandle){if(!h||typeof h!=='object'||isProxy(h))return this.#deny('binding');for(let i=0;i<this.#rows.length;i++){const r=this.#rows[i];if(r?.read===h)return r;}return this.#deny('binding');}
 #item(r:Row,t:SummaryHandle,lease=false){for(let i=0;i<2;i++)if((lease?r.items[i]!.lease:r.items[i]!.token)===t)return i;return this.#deny('record_binding');}
 #live(r:Row){if(r.retiring)this.#deny('retired');if(this.#now>=r.deadline){r.retiring=true;this.#deny('expired');}if(this.#revoked||!this.#purpose){r.retiring=true;this.#deny('recipient_revoked');}}
 beginRead(){this.#guard();if(this.#next>=64)this.#deny('epoch_budget');let slot=-1;for(let i=0;i<this.#rows.length;i++)if(this.#rows[i]===undefined){slot=i;break;}if(slot<0)this.#deny('registry_full');need(integer(this.#now+6000),'deadline');
  // Known binary preallocation only. Includes transfer and receiver copies, never claims full charge.
  const sender=new Bytes(512),receiver=new Bytes(512),flight=new Bytes(256),seq=++this.#next;
  const items=make<Item>(2,()=>({token:freeze({kind:'summary-record'}),lease:freeze({kind:'summary-borrow'}),issued:false,unavailable:false,receipt:undefined,ownedReceipt:undefined,delivered:false,consumerPending:false,borrowIssued:false,borrow:undefined,acked:false,sends:0,consumed:false,receives:0,copies:0}));
  const read=freeze({kind:'summary-read' as const});this.#rows[slot]={read,seq,sender,receiver,flight,items,inflight:-1,next:0,deadline:this.#now+6000,main:null,retiring:false,ops:0,cleanup:0,fullChecks:0,ownedChecks:0};this.#allocated+=1280;return read;
 }
 #receipt(r:Row,attempt:number,reason:number):SummaryRecord{return freeze({readSeq:r.seq,attempt,generation:2*(r.seq-1)+attempt,reason,captured:2*attempt,proved:2*attempt,work:17*attempt,initialization:3*attempt,wire:256*attempt,attempts:attempt,heldBytes:6144,pending:0,borrow:0,zeroedBytes:0,exportOrdinal:attempt,sourceDigest,profileDigest,layoutDigest});}
 #run(op:Op,h:SummaryHandle,arg?:unknown,extra?:unknown):any{
  this.#guard();const r=this.#row(h),completion=op==='ack'||op==='complete'||op==='release'||op==='discard'||op==='finish'||op==='cancel'||op==='reclaim';
  if(completion){if(r.cleanup>=16){r.retiring=true;this.#deny('cleanup_budget');}r.cleanup++;}else{if(r.ops>=240){r.retiring=true;this.#deny('entry_budget');}r.ops++;}
  this.#busy=true;this.#active=r;
  try{
   if(!completion)this.#live(r);
   if(op==='finish'){need(r.main===null&&(arg==='success'||arg==='failed'||arg==='cancelled'||arg==='expired'),'main_state');r.main=arg;if(arg==='success')this.#mainSuccesses++;return;}
   if(op==='cancel'){r.retiring=true;return;}
   if(op==='emit'){
    need((arg===1||arg===2)&&arg===r.next+1,'ordinal');need(integer(extra)&&extra<=3,'reason');const i=arg-1,item=r.items[i]!;need(!item.issued,'ordinal');item.issued=true;r.next++;const receipt=this.#receipt(r,arg,extra);
    writeSummaryAt(r.sender,i*256,receipt);if(this.#fault==='encode-fail'){this.#fault=undefined;clear(r.sender,i*256,256);item.unavailable=true;this.#unavailable++;return undefined;}
    item.receipt=receipt;item.ownedReceipt=receipt;return item.token;
   }
   if(op==='reclaim'){
    need(r.main!==null&&r.inflight<0,'early_reclaim');for(let i=0;i<2;i++){const item=r.items[i]!;need(!item.borrow&&!item.consumerPending&&(!item.issued||item.unavailable||item.acked||r.retiring),'early_reclaim');}
    apply(fill,r.sender,[0]);apply(fill,r.receiver,[0]);apply(fill,r.flight,[0]);zero(r.sender,512);zero(r.receiver,512);zero(r.flight,256);
    for(let i=0;i<2;i++){r.items[i]!.receipt=undefined;r.items[i]!.ownedReceipt=undefined;r.items[i]!.borrow=undefined;}for(let i=0;i<this.#rows.length;i++)if(this.#rows[i]===r)this.#rows[i]=undefined;this.#zeroed+=1280;this.#reclaims++;return;
   }
   const i=this.#item(r,arg as SummaryHandle,op==='release'||op==='consume'),item=r.items[i]!;need(item.issued&&!item.unavailable&&item.receipt,'unavailable');
   if(!completion){if(this.#mode==='full-input'){r.fullChecks++;need(item.receipt.readSeq===r.seq&&item.receipt.attempt===i+1&&item.receipt.generation===2*(r.seq-1)+i+1&&item.receipt.exportOrdinal===i+1,'receipt_binding');}else{r.ownedChecks++;need(item.receipt===item.ownedReceipt,'receipt_binding');}}
   if(op==='dispatch'){
    need(extra===this.#peer,'recipient_binding');need(r.inflight<0&&item.sends<2,'transport_budget');item.sends++;this.#sends++;checkSummaryAt(r.sender,i*256,item.receipt);
    for(let j=0;j<256;j++)r.flight[j]=r.sender[i*256+j]!;r.inflight=i;
    const fault=this.#fault;if(fault&&fault!=='receive-reentry'&&fault!=='encode-fail'){this.#fault=undefined;const at=fault==='header'?5:fault==='counter'?47:fault==='digest'?128:fault==='reserved'?224:31;r.flight[at]=r.flight[at]!^1;}return;
   }
   if(op==='receive'){
    need(r.inflight===i,'transport_binding');if(this.#fault==='receive-reentry'){this.#fault=undefined;try{this.reclaim(h);}catch{this.#caught++;}this.#live(r);}
    try{checkSummaryAt(r.flight,0,item.receipt);}catch(e){r.retiring=true;throw e;}
    // Dedup before copying or lending. A released consumer is never silently re-created.
    item.receives++;if(item.delivered){this.#dedup++;return 'duplicate';}
    for(let j=0;j<256;j++)r.receiver[i*256+j]=r.flight[j]!;item.delivered=true;item.consumerPending=true;item.copies++;this.#copies++;this.#deliveries++;return 'delivered';
   }
   if(op==='ack'){need(item.delivered,'ack_before_delivery');item.acked=true;return;}
   if(op==='complete'){need(r.inflight===i,'transport_binding');clear(r.flight,0,256);r.inflight=-1;return;}
   if(op==='borrow'){need(item.delivered&&item.consumerPending&&!item.borrowIssued,'consumer_state');item.borrowIssued=true;item.borrow=r.receiver;return item.lease;}
   if(op==='consume'){need(item.borrow===r.receiver&&item.consumerPending&&!item.consumed,'consumer_state');checkSummaryAt(r.receiver,i*256,item.receipt);item.consumed=true;return;}
   if(op==='release'){need(item.borrow===r.receiver&&item.consumerPending,'consumer_state');item.borrow=undefined;item.consumerPending=false;clear(r.receiver,i*256,256);return;}
   if(op==='discard'){need(item.delivered&&item.consumerPending&&!item.borrow,'consumer_state');item.consumerPending=false;clear(r.receiver,i*256,256);return;}
   throw NativeError('r1s_operation');
  }finally{this.#active=undefined;this.#busy=false;}
 }
 emit(h:SummaryHandle,attempt:1|2,reason=0):SummaryHandle|undefined{return this.#run('emit',h,attempt,reason);}
 dispatch(h:SummaryHandle,t:SummaryHandle,recipient:SummaryHandle){this.#run('dispatch',h,t,recipient);}
 receive(h:SummaryHandle,t:SummaryHandle):'delivered'|'duplicate'{return this.#run('receive',h,t);}
 ack(h:SummaryHandle,t:SummaryHandle){this.#run('ack',h,t);}
 completeTransfer(h:SummaryHandle,t:SummaryHandle){this.#run('complete',h,t);}
 borrowConsumer(h:SummaryHandle,t:SummaryHandle):SummaryHandle{return this.#run('borrow',h,t);}
 consume(h:SummaryHandle,t:SummaryHandle){this.#run('consume',h,t);}
 releaseConsumer(h:SummaryHandle,t:SummaryHandle){this.#run('release',h,t);}
 discardConsumer(h:SummaryHandle,t:SummaryHandle){this.#run('discard',h,t);}
 finishMain(h:SummaryHandle,outcome:Outcome){this.#run('finish',h,outcome);}
 cancelDiagnostics(h:SummaryHandle){this.#run('cancel',h);}
 reclaim(h:SummaryHandle){this.#run('reclaim',h);}
 adoptProduction():never{this.#guard();throw NativeError('r1s_profile_unsupported');}
 static copySender(r:R1sDelivery,h:SummaryHandle,t:SummaryHandle){need(r&&typeof r==='object'&&!isProxy(r)&&proto(r)===R1sDelivery.prototype,'owner');let row:Row|undefined;for(let i=0;i<r.#rows.length;i++)if(r.#rows[i]?.read===h)row=r.#rows[i];need(row,'binding');let index=-1;for(let i=0;i<2;i++)if(row.items[i]!.token===t)index=i;need(index>=0&&row.items[index]!.receipt,'unavailable');return make(256,i=>row!.sender[index*256+i]!);}
 static observe(r:R1sDelivery,h?:SummaryHandle){need(r&&typeof r==='object'&&!isProxy(r)&&proto(r)===R1sDelivery.prototype,'owner');let row:Row|undefined;for(let i=0;i<r.#rows.length;i++)if(r.#rows[i]?.read===h)row=r.#rows[i];let rows=0;for(let i=0;i<r.#rows.length;i++)if(r.#rows[i])rows++;
  return {mode:r.#mode,capacity:r.#rows.length,rows,allocatedBytes:r.#allocated,zeroedBytes:r.#zeroed,reclaims:r.#reclaims,receiverCopies:r.#copies,deliveries:r.#deliveries,deduplicated:r.#dedup,sends:r.#sends,mainSuccesses:r.#mainSuccesses,denials:r.#denials,caughtReentries:r.#caught,unavailable:r.#unavailable,
   read:row?{seq:row.seq,main:row.main,retiring:row.retiring,binaryBytes:1280,senderBytes:512,receiverBytes:512,transferBytes:256,pendingTransfer:row.inflight<0?0:1,issued:row.next,deadline:row.deadline,ops:row.ops,cleanup:row.cleanup,fullChecks:row.fullChecks,ownedChecks:row.ownedChecks,
    items:make(2,i=>{const a=row!.items[i]!;return {issued:a.issued,unavailable:a.unavailable,delivered:a.delivered,consumerPending:a.consumerPending,borrowed:a.borrow!==undefined,realBorrow:a.borrow!==undefined&&a.borrow===row!.receiver,acked:a.acked,sends:a.sends,receives:a.receives,copies:a.copies,consumed:a.consumed};})}:null,scope:R1S_SCOPE};
 }
}
freeze(R1sDelivery.prototype);freeze(R1sDelivery);
/** Harness-only scalar/copy observation, not an admitted diagnostic API or memory bound. */
export function observeR1s(r:R1sDelivery,h?:SummaryHandle){return R1sDelivery.observe(r,h);}
export function copyR1sPacket(r:R1sDelivery,h:SummaryHandle,t:SummaryHandle){return R1sDelivery.copySender(r,h,t);}
