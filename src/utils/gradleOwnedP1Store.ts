/** PB1 cooperative single-owner disk storage. No job admission, OS isolation or tool IO. */
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as digest,ownedSha256,parseOwnedJson} from './gradleOwnedJson.js';
import {pb0Need as need} from './gradleOwnedP0StateContract.js';
import {OwnedJournalDisk} from './gradleOwnedStoreDisk.js';
import {RootedJournalIO,type DiskFault} from './gradleOwnedStoreFs.js';
import {type JournalFault,type JournalHead,type JournalRecord} from './gradleOwnedStoreJournal.js';
import {PB1_LIMITS as L,PB1_PROFILE,pb1Command,pb1Reserve,pb1StreamSchema,pb1AnchorPinSchema,pb1VerifyAnchor,pb1VerifyReceipt,pb1Genesis,pb1Same,pb1OriginKey,type PB1Command,type PB1Stream,type PB1AnchorPort,type PB1AnchorPin,type PB1Proposal,type PB1Origin} from './gradleOwnedP1Contract.js';

export type PB1Area='journal'|'checkpoint'|'adoption'|'adoptionCheckpoint';
export type PB1Fault='after-local-checkpoint'|'after-anchor'|'after-adoption'|'before-ack';
export interface PB1StoreOptions {
 stream:PB1Stream;mode:'create'|'open';roots:Record<PB1Area,string>;keys:Record<PB1Area,Buffer>;
 anchor:PB1AnchorPort;anchorPin:PB1AnchorPin;
 /** Trusted caller port, NOT an implementation of the PB2 live authorizer. Recovery has its own grant. */
 authorize:(requestWire:string|null,phase:'before-io'|'before-ack'|'recovery')=>void|Promise<void>;
 now:()=>number;
 fault?:(point:PB1Fault)=>void|Promise<void>;
 diskFault?:(area:PB1Area,point:DiskFault,name:string)=>void|Promise<void>;
 journalFault?:(area:'journal'|'adoption',point:JournalFault)=>void|Promise<void>;
}
export interface PB1Receipt {schema:'cwc.e2-p0.pb1-durable-receipt.v1';transactionKey:string;intentDigest:string;stage:string;origin:PB1Origin;appliedHead:JournalHead;anchorWire:string;adoptionHead:JournalHead;jobPermitIssued:false;runtimeAdmitted:false}
type Entry={c:PB1Command;head:JournalHead;proposal:PB1Proposal;receipt?:PB1Receipt};
const roles=['session-manifest','session-index','event-ledger','operation-result'] as const;
const wire=(v:unknown)=>Buffer.from(canonical(v,L.command));
const records=(manifest:unknown,index:unknown,event:unknown,result:unknown):JournalRecord[]=>[manifest,index,event,result].map((v,i)=>({id:String(i),role:roles[i]!,bytes:wire(v)}));
const parsed=(r:JournalRecord)=>parseOwnedJson(r.bytes.toString(),L.command);
const areas:PB1Area[]=['journal','checkpoint','adoption','adoptionCheckpoint'];
/** Refused before this call made any durable write. The instance stays usable: no stage, anchor or ACK effect exists. */
export class PB1Rejection extends Error {}
async function rejectBeforeWrite<T>(f:()=>T|Promise<T>):Promise<T>{try{return await f();}catch(e){throw e instanceof PB1Rejection?e:new PB1Rejection(e instanceof Error?e.message:String(e),{cause:e});}}
export class PB1Store {
 readonly #main:OwnedJournalDisk;readonly #adoptions:OwnedJournalDisk;readonly #stream:PB1Stream;readonly #pin:PB1AnchorPin;readonly #anchor:PB1AnchorPort;
 readonly #authorize:PB1StoreOptions['authorize'];readonly #now:()=>number;readonly #fault?:PB1StoreOptions['fault'];
 readonly #roots:PB1StoreOptions['roots'];
 #busy=false;#blocked=false;#closed=false;#poison=false;#last=0;
 private constructor(main:OwnedJournalDisk,adoptions:OwnedJournalDisk,o:PB1StoreOptions){this.#main=main;this.#adoptions=adoptions;this.#stream=o.stream;this.#pin=o.anchorPin;this.#anchor=o.anchor;this.#authorize=o.authorize;this.#now=o.now;this.#fault=o.fault;this.#roots=o.roots;}
 static async open(input:PB1StoreOptions){
  const stream=pb1StreamSchema.parse(input.stream),pin=pb1AnchorPinSchema.parse(input.anchorPin);
  need(input.mode==='create'||input.mode==='open','pb1-mode');need(typeof input.authorize==='function'&&typeof input.now==='function','pb1-authority-port');
  const keys={} as Record<PB1Area,Buffer>,roots={} as Record<PB1Area,string>;
  for(const a of areas){need(Buffer.isBuffer(input.keys[a])&&input.keys[a].length===32,'pb1-key');keys[a]=Buffer.from(input.keys[a]);roots[a]=path.resolve(input.roots[a]);}
  need(new Set(Object.values(keys).map(ownedSha256)).size===4,'pb1-key-alias');
  for(const a of areas)for(const b of areas)if(a!==b)need(roots[a]!==roots[b]&&!roots[a].startsWith(roots[b]+path.sep),'pb1-roots-overlap');
  // Capture trusted ports and configuration before the first asynchronous boundary.
  const anchor={head:input.anchor.head.bind(input.anchor),query:input.anchor.query.bind(input.anchor),compareAndSwap:input.anchor.compareAndSwap.bind(input.anchor)};
  const o={...input,stream,anchorPin:pin,anchor,keys,roots};await o.authorize(null,'recovery');
  let main:OwnedJournalDisk|undefined,adoptions:OwnedJournalDisk|undefined;
  const disk=(adopt:boolean)=>{const a=adopt?'adoption':'journal',cp=adopt?'adoptionCheckpoint':'checkpoint';return {authorityId:stream.authorityId+(adopt?'.adoption':''),storeEpoch:stream.storeEpoch,keyId:stream.keyId+(adopt?'.adoption':''),checkpointKeyId:stream.keyId+'.'+cp,key:keys[a],checkpointKey:keys[cp],mode:o.mode,
   store:{root:roots[a],maxBytes:adopt?L.adoption:L.payload+L.journal,fault:(p:DiskFault,n:string)=>o.diskFault?.(a,p,n)},
   checkpoint:{root:roots[cp],maxBytes:L.checkpoint/2,fault:(p:DiskFault,n:string)=>o.diskFault?.(cp,p,n)},fault:(p:JournalFault)=>o.journalFault?.(a,p)};};
  try{main=await OwnedJournalDisk.open(disk(false));adoptions=await OwnedJournalDisk.open(disk(true));const store=new PB1Store(main,adoptions,o);await store.#run(()=>store.#recover());return store;}
  catch(e){adoptions?.close();main?.close();throw e;}
 }
 #manifest(adoption=false){return {schema:'cwc.e2-p0.pb1-owner.v1',profileDigest:PB1_PROFILE,stream:this.#stream,adoption,anchorPin:this.#pin};}
 #entry():void{
  // Reentry must poison the outer operation even if the inner input cannot be parsed.
  if(this.#busy){this.#poison=true;throw Error('pb1_reentrant');}
  need(!this.#closed,'pb1-closed');need(!this.#blocked,'pb1-blocked-recovery-required');
 }
 async #run<T>(f:()=>Promise<T>):Promise<T>{
  this.#entry();this.#busy=true;this.#poison=false;
  try{const out=await f();need(!this.#poison&&!this.#closed,'pb1-reentrant-or-closed');return out;}
  // Only a pre-write refusal of a non-poisoned call stays non-fatal. Storage/anchor/final-gate failures leave durable state unknown.
  catch(e){if(this.#poison||!(e instanceof PB1Rejection))this.#blocked=true;throw e;}finally{this.#busy=false;}
 }
 async #live(c:PB1Command,phase:'before-io'|'before-ack'){
  // failed-or-unknown is the cleanup record needed after expiry/revocation. It uses the recovery grant, not the original deadline.
  const cleanup=c.command.kind==='stage'&&c.stage==='failed-or-unknown';
  await this.#authorize(c.command.kind==='stage'?c.command.requestWire:c.command.queryWire,cleanup?'recovery':phase);
  const now=this.#now(),deadline=c.request.domain==='cwc.e2-p0.backend-request.v2'?c.request.originalDeadline:c.request.originalControlDeadline;
  need(Number.isSafeInteger(now)&&now>=this.#last&&(cleanup||now<deadline),'pb1-revoked-or-expired');this.#last=now;need(!this.#poison&&!this.#closed,'pb1-reentrant-or-closed');
 }
 #streamCheck(c:PB1Command){need(c.request.realmId===this.#stream.realmId&&c.origin.owner===this.#stream.owner&&c.request.targetOwner===this.#stream.owner,'pb1-owner');need(c.command.expectedHead.authorityId===this.#stream.authorityId&&c.command.expectedHead.storeEpoch===this.#stream.storeEpoch,'pb1-head-identity');}
 #proposal(c:PB1Command,head:JournalHead):PB1Proposal{return {schema:'cwc.e2-p0.pb1-anchor-cas.v1',profileDigest:PB1_PROFILE,stream:this.#stream,transactionKey:c.transactionKey,intentDigest:c.intentDigest,previousHead:c.command.expectedHead,head};}
 #transition(c:PB1Command,entries:Entry[]){
  this.#streamCheck(c);const same=entries.filter(e=>e.c.originKey===c.originKey),last=same.at(-1);
  // A tombstone is indexed by the OLD origin; also retain the QueryOperation's OWN control K/D.
  for(const e of entries)if(e.c.request.operationKey===c.request.operationKey)need(e.c.request.intentDigest===c.request.intentDigest,'pb1-query-operation-conflict');
  if(c.request.domain==='cwc.e2-p0.backend-control.v1')need(c.request.expectedOwnerHead===c.command.expectedHead.headDigest,'pb1-control-head');
  if(c.command.kind==='tombstone'){need(!last,'pb1-origin-not-absent');return;}
  need(!same.some(e=>e.c.command.kind==='tombstone'),'pb1-origin-tombstoned');
  need(same.every(e=>e.c.origin.intentDigest===c.origin.intentDigest),'pb1-operation-conflict');
  if(!last){need(c.stage==='intent-reserved'||c.stage==='mutation-committed','pb1-stage-order');need(c.command.previousStageRef===null,'pb1-stage-previous');}
  else{
   const allowed:Record<string,string[]>={'intent-reserved':['source-captured','failed-or-unknown'],'source-captured':['response-ready','failed-or-unknown'],'response-ready':['response-may-have-escaped','failed-or-unknown'],'response-may-have-escaped':[], 'failed-or-unknown':[], 'mutation-committed':[]};
   need(allowed[last.c.stage]?.includes(c.stage),'pb1-stage-order');need(last.receipt&&pb1Same(c.command.previousStageRef,this.receiptRef(last.receipt)),'pb1-stage-previous');
   // Every stage carries the exact original wire; nonce/session changes require a different operation.
   need(last.c.command.kind==='stage'&&last.c.command.requestWire===c.command.requestWire,'pb1-original-request-changed');
  }
 }
 #capacity(c:PB1Command,entries:Entry[]){
  // Conservative per-stage reservations also cover the local adoption, both checkpoints and one scratch.
  // These are local byte quotas, not physical JS/work upper bounds or an independent capacity certificate.
  pb1Reserve(entries.map(e=>e.c),c);
  const future={...c.command.expectedHead,revision:c.command.expectedHead.revision+1,headDigest:'f'.repeat(64)},proposal=this.#proposal(c,future);
  // A receipt's hashes/signature have fixed encoded lengths. Reserve its actual strict codec layout before IO.
  const anchorWire=canonical({schema:'cwc.e2-p0.pb1-anchor-signed.v1',anchorId:this.#pin.anchorId,keyId:this.#pin.keyId,value:{kind:'receipt',proposal},signature:'A'.repeat(86)+'=='},L.anchorWire);
  const overhead=[this.#manifest(),this.#index(c),this.#result(c)].reduce<number>((n,v)=>n+wire(v).length,0);
  const adoptionBytes=records(this.#manifest(true),this.#index(c),{anchorWire},{sha256:'f'.repeat(64),byteLength:Buffer.byteLength(anchorWire)}).reduce((n,r)=>n+r.bytes.length,0);
  // 8 KiB covers the fixed four-descriptor authenticated journal header (at most five chunk refs).
  need(overhead+8192<=32768&&adoptionBytes+8192<=16384,'pb1-budget-codec');
 }
 async #inventory(disk:OwnedJournalDisk,root:string,rows:Awaited<ReturnType<OwnedJournalDisk['journal']['readHistory']>>){
  // The generic journal allows unreferenced blobs after a crash. PB1 must not silently refund that attempt.
  // This read-only FD shares the exact held root identity; the writer lock remains owned by disk.
  const io=await RootedJournalIO.open({root});try{
   need(pb1Same(io.rootIdentity(),disk.rootIdentities[0]),'pb1-root-changed');const expected=new Set(['journal.meta']);
   for(const [i,row]of rows.entries()){
    expected.add('commit-'+String(i+1).padStart(8,'0')+'.json');
    for(const r of row.records)for(let at=0;at<r.bytes.length;at+=1048576)expected.add('blob-'+ownedSha256(r.bytes.subarray(at,at+1048576))+'.bin');
   }
   const files=await io.list(4096);need(files.length===expected.size&&files.every(f=>expected.has(f.name)),'pb1-unaccounted-tail');need(pb1Same(io.rootIdentity(),disk.rootIdentities[0]),'pb1-root-changed');
  }finally{io.close();}
 }
 async #history():Promise<Entry[]>{
  await this.#main.assertNoPendingTail();await this.#adoptions.assertNoPendingTail();
  const rows=await this.#main.journal.readHistory(),adopts=await this.#adoptions.journal.readHistory();
  await this.#inventory(this.#main,this.#roots.journal,rows);await this.#inventory(this.#adoptions,this.#roots.adoption,adopts);
  need(adopts.length<=rows.length,'pb1-adoption-ahead');const entries:Entry[]=[];
  for(const [i,row]of rows.entries()){
   need(row.records.length===4&&row.records.every((r,j)=>r.id===String(j)&&r.role===roles[j]),'pb1-journal-shape');need(pb1Same(parsed(row.records[0]!),this.#manifest()),'pb1-manifest');
   const c=pb1Command(canonical(parsed(row.records[2]!),L.command));this.#transition(c,entries);this.#capacity(c,entries);
   need(pb1Same(c.command.expectedHead,i?rows[i-1]!.head:pb1Genesis(this.#stream)),'pb1-chain-head');
   need(row.operationId===c.transactionKey&&row.requestDigest===c.intentDigest&&pb1Same(parsed(row.records[1]!),this.#index(c))&&pb1Same(parsed(row.records[3]!),this.#result(c)),'pb1-journal-intent');
   const e:Entry={c,head:row.head,proposal:this.#proposal(c,row.head)},a=adopts[i];
   if(a){
    need(a.records.length===4&&a.records.every((r,j)=>r.id===String(j)&&r.role===roles[j])&&a.operationId===c.transactionKey&&a.requestDigest===c.intentDigest,'pb1-adoption-shape');
    need(pb1Same(parsed(a.records[0]!),this.#manifest(true))&&pb1Same(parsed(a.records[1]!),this.#index(c)),'pb1-adoption-owner');
    const ev=parsed(a.records[2]!) as {anchorWire?:unknown};need(ev&&typeof ev==='object'&&Object.keys(ev).length===1&&typeof ev.anchorWire==='string','pb1-adoption-event');
    const ref=pb1VerifyReceipt(ev.anchorWire,this.#pin,e.proposal);need(pb1Same(parsed(a.records[3]!),ref),'pb1-adoption-result');
    e.receipt=this.#receipt(e,ev.anchorWire,a.head);
   }
   entries.push(e);
  }
  need(rows.length-adopts.length<=1,'pb1-unadopted-gap');return entries;
 }
 #index(c:PB1Command){return {transactionKey:c.transactionKey,intentDigest:c.intentDigest,originKey:c.originKey,stage:c.stage};}
 #result(c:PB1Command){return {schema:'cwc.e2-p0.pb1-local-result.v1',...this.#index(c),jobPermitIssued:false,runtimeAdmitted:false};}
 #receipt(e:Entry,anchorWire:string,adoptionHead:JournalHead):PB1Receipt{return {schema:'cwc.e2-p0.pb1-durable-receipt.v1',transactionKey:e.c.transactionKey,intentDigest:e.c.intentDigest,stage:e.c.stage,origin:e.c.origin,appliedHead:e.head,anchorWire,adoptionHead,jobPermitIssued:false,runtimeAdmitted:false};}
 receiptRef(r:PB1Receipt){return {sha256:ownedSha256(r.anchorWire),byteLength:Buffer.byteLength(r.anchorWire)};}
 async #anchorHead(){const challenge=randomBytes(32).toString('hex'),v=pb1VerifyAnchor(await this.#anchor.head(canonical(this.#stream),challenge),this.#pin);need(v.kind==='head'&&pb1Same(v.stream,this.#stream)&&v.challenge===challenge,'pb1-anchor-stream-or-challenge');return v.head;}
 async #adopt(e:Entry){
  const challenge=randomBytes(32).toString('hex'),queried=pb1VerifyAnchor(await this.#anchor.query(canonical(this.#stream),e.c.transactionKey,challenge),this.#pin);need(queried.kind==='origin'&&pb1Same(queried.stream,this.#stream)&&queried.transactionKey===e.c.transactionKey&&queried.challenge===challenge,'pb1-anchor-origin');
  // On an unknown CAS response stop now. A fresh reopen queries this exact transaction; never blindly repeats it.
  const anchorWire=queried.receiptWire??await this.#anchor.compareAndSwap(canonical(e.proposal));
  const ref=pb1VerifyReceipt(anchorWire,this.#pin,e.proposal);await this.#fault?.('after-anchor');
  const a=await this.#adoptions.journal.commit({operationId:e.c.transactionKey,requestDigest:e.c.intentDigest,expectedHead:this.#adoptions.journal.head,
   records:records(this.#manifest(true),this.#index(e.c),{anchorWire},ref)});
  await this.#fault?.('after-adoption');e.receipt=this.#receipt(e,anchorWire,{authorityId:this.#adoptions.journal.head.authorityId,storeEpoch:this.#stream.storeEpoch,revision:a.revision,headDigest:a.headDigest});
 }
 async #recover(){
  await this.#main.revalidate();await this.#adoptions.revalidate();const entries=await this.#history(),head=await this.#anchorHead(),last=entries.at(-1);
  if(last&&!last.receipt){need(pb1Same(head,last.head)||pb1Same(head,last.proposal.previousHead),'pb1-anchor-conflict');await this.#adopt(last);}
  need(pb1Same(await this.#anchorHead(),this.#main.journal.head),'pb1-rollback-or-anchor-conflict');
  await this.#authorize(null,'recovery');need(!this.#poison,'pb1-reentrant');return entries;
 }
 async commit(wireInput:string):Promise<PB1Receipt>{
  this.#entry();
  const c=pb1Command(wireInput);return this.#run(async()=>{
   await rejectBeforeWrite(()=>this.#live(c,'before-io'));const entries=await this.#history();need(entries.every(e=>e.receipt),'pb1-recovery-required');need(pb1Same(await this.#anchorHead(),this.#main.journal.head),'pb1-rollback-or-anchor-conflict');
   const old=entries.find(e=>e.c.transactionKey===c.transactionKey);
   if(old){await rejectBeforeWrite(()=>need(old.c.wire===c.wire&&old.receipt,'pb1-operation-conflict'));await this.#fault?.('before-ack');await this.#live(c,'before-ack');return old.receipt!;}
   await rejectBeforeWrite(async()=>{this.#transition(c,entries);this.#capacity(c,entries);need(pb1Same(c.command.expectedHead,this.#main.journal.head),'pb1-cas-conflict');await this.#live(c,'before-io');});
   const saved=await this.#main.journal.commit({operationId:c.transactionKey,requestDigest:c.intentDigest,expectedHead:c.command.expectedHead,records:records(this.#manifest(),this.#index(c),parseOwnedJson(c.wire,L.command),this.#result(c))});
   const head={...c.command.expectedHead,revision:saved.revision,headDigest:saved.headDigest},e:Entry={c,head,proposal:this.#proposal(c,head)};
   await this.#fault?.('after-local-checkpoint');await this.#adopt(e);need(pb1Same(await this.#anchorHead(),head),'pb1-anchor-conflict');await this.#fault?.('before-ack');await this.#live(c,'before-ack');return e.receipt!;
  });
 }
 /** Audit only. An absent result is made durable by commit(kind=tombstone), never by an unrecorded lookup. */
 async audit(queryWire:string){
  this.#entry();
  // Reuse strict tombstone validation to bind current QueryOperation authorization to its old origin.
  const raw=parseOwnedJson(queryWire,16384) as {payload?:{origin?:unknown}};
  const c=pb1Command(canonical({schema:'cwc.e2-p0.pb1-command.v1',kind:'tombstone',queryWire,origin:raw?.payload?.origin,expectedHead:this.#main.journal.head,previousStageRef:null},L.command));
  return this.#run(async()=>{await rejectBeforeWrite(async()=>{this.#streamCheck(c);await this.#live(c,'before-io');});const entries=await this.#history();need(entries.every(e=>e.receipt),'pb1-recovery-required');need(pb1Same(await this.#anchorHead(),this.#main.journal.head),'pb1-rollback-or-anchor-conflict');const same=entries.filter(e=>e.c.originKey===pb1OriginKey(c.origin)),last=same.at(-1);
   if(last&&last.c.command.kind!=='tombstone')await rejectBeforeWrite(()=>need(last.c.origin.intentDigest===c.origin.intentDigest,'pb1-operation-conflict'));
   await this.#live(c,'before-ack');return {outcome:!last?'pending':last.c.command.kind==='tombstone'?'absent':'historical',receipt:last?.receipt??null,reapply:false,jobPermitIssued:false,runtimeAdmitted:false};});
 }
 get head():JournalHead{need(!this.#closed&&!this.#busy,'pb1-unavailable');return this.#main.journal.head;}
 get diagnostics(){return {blocked:this.#blocked,closed:this.#closed,localDisk:true,independentAnchorVerified:false,jobPermitIssued:false,runtimeAdmitted:false};}
 close(){need(!this.#busy,'pb1-busy');if(!this.#closed){this.#closed=true;this.#adoptions.close();this.#main.close();}}
}
