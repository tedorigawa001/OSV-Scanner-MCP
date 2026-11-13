/** Independent finite lifecycle-record checks. No charge/GC/native/work/adoption certificate. */
import {types} from 'node:util';
import {co0Canonical as canonical,co0Hash as hash} from './gradleOwnedCwcCo0Validation.mjs';
export const r1hHash=hash;
const need=(v,r)=>{if(!v)throw Error('r1h_record_'+r);};
function data(root){let nodes=0;const seen=new Set();function visit(v,d){need(++nodes<=524288&&d<=64,'data_budget');if(v===null||typeof v==='boolean'||typeof v==='string')return;if(typeof v==='number'){need(Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0),'number');return;}
 need(v&&typeof v==='object'&&!types.isProxy(v)&&!seen.has(v),'type');const a=Array.isArray(v);need(Object.getPrototypeOf(v)===(a?Array.prototype:Object.prototype),'prototype');seen.add(v);const names=Reflect.ownKeys(v);if(a)need(names.length===v.length+1,'array');for(const k of names){need(typeof k==='string','key');const p=Object.getOwnPropertyDescriptor(v,k);need(p&&'value'in p,'accessor');if(a&&k==='length')continue;need(p.enumerable,'enumerable');visit(p.value,d+1);}seen.delete(v);}visit(root,0);}
const equal=(a,b,why)=>need(canonical(a)===canonical(b),why),keys=(v,s)=>equal(Object.keys(v).sort(),s.split(' ').sort(),'keys');
export const R1H0_SCOPE_EXPECTED={limitedLifecycleFixture:true,closedOwnedPorts:true,fixedClock:true,sameProcess:true,realBinaryBuffers:true,twoCompleteWindowBodiesReserved:true,sixteenPrivateIdentities:true,
 bothFixtureModeBranches:true,oneBorrowAndTransportPerAttempt:true,arbitraryCallbacksSupported:false,diagnosticObserverOutsideAdmittedPath:true,diagnosticCallerChargeProved:false,actualAuthenticatedCall:false,actualReadScope:false,cwcRootFactConnected:false,freshSnapshot:false,
 fullRoleLayoutProved:false,independentChargeApproved:false,physicalHeapBound:false,actualParentLedgerVector:false,originalUnitWorkCoverage:false,summaryExportImplemented:false,r1mExit:false,r1Exit:false,productionAdopted:false,performanceMeasured:false};
const modes=['full-input','owned-input'],actors=['provider','client'],faults=['reenter-publish','reenter-reclaim','reenter-open','cancel-before-publication','expire-before-publication','revoke-before-publication','pin-restore-before-publication'];
function snapshot(s,mode,capacity){
 keys(s,'mode capacity readRows authorityLookups heldBodySlots bufferAllocations allocatedBytes zeroedBytes reclaims publications reentryRefusals caughtReentries faultFrameCount faultHeldBodies read scope');
 equal(s.scope,R1H0_SCOPE_EXPECTED,'scope');need(s.mode===mode&&s.capacity===capacity&&s.readRows<=capacity&&s.authorityLookups<=s.readRows,'registry');need(s.heldBodySlots===2*s.readRows,'hold');need(s.bufferAllocations===2*(s.reclaims+s.readRows)&&s.allocatedBytes===3072*s.bufferAllocations,'allocation');need(s.zeroedBytes<=s.allocatedBytes&&s.zeroedBytes%3072===0,'zero');
 if(s.read){const r=s.read;keys(r,'sequence actor state authorityKeyPresent reason attempt deadline frames privateBodies binaryBytes referenceSlots retainedIdentities distinctIdentities borrows borrowUsesFirstBody bodyBuffersDistinct pendingTransport transportUsesBody publications fullChecks ownedChecks');
  need(r.sequence===1&&actors.includes(r.actor)&&['active','closing','retiring'].includes(r.state)&&r.attempt<=2&&r.deadline===4500&&r.frames===0&&r.authorityKeyPresent===(r.state==='active'),'binding');need(r.privateBodies===2&&r.binaryBytes===6144&&r.referenceSlots===96&&r.retainedIdentities===16&&r.distinctIdentities===16&&r.bodyBuffersDistinct===true,'two_bodies');need(r.borrows<=2&&r.pendingTransport<=1&&s.readRows>0,'debt');need(mode==='full-input'?r.ownedChecks===0:r.fullChecks===0,'mode_branch');
 }
}
function drained(s,mode,capacity,rows,zeroed,reclaims){snapshot(s,mode,capacity);need(s.read===null&&s.readRows===rows&&s.heldBodySlots===rows*2&&s.authorityLookups===rows&&s.zeroedBytes===zeroed&&s.reclaims===reclaims,'drain');}
export function validateR1hEvidence(e){
 data(e);keys(e,'schema scope normal rejection cleanup limits unproved');need(e.schema==='cwc-r1h0.observation.v1','schema');equal(e.scope,R1H0_SCOPE_EXPECTED,'scope');
 equal(e.limits,{registryCapacity:4,attemptsPerRead:2,bodiesPerRead:2,binaryBytesPerBody:3072,referenceSlotsPerBody:48,opaquePerBody:8,opaquePerRead:16,pendingTransportPerRead:1},'limits');
 equal(e.unproved,{bridgeUpperBytes:null,wrapperUpperBytes:null,frameUpperBytes:null,diagnosticCallerUpperBytes:null,physicalHeapUpperBytes:null,wholeReadUpperBytes:null,originalUnitWork:null},'unknown');
 equal(e.normal.map(x=>x.id),modes.flatMap(mode=>actors.flatMap(actor=>[1,4].map(c=>`${mode}/${actor}/${c}`))),'normal_cases');
 for(const x of e.normal){keys(x,'id mode actor capacity reserved firstClosed waiting earlyRefused stillTransport transportRefused drained lateRefused newOwner newWindow final');need(x.id===`${x.mode}/${x.actor}/${x.capacity}`,'normal_binding');need(x.earlyRefused&&x.transportRefused&&x.lateRefused&&x.newOwner&&x.newWindow,'normal_refusal');
  for(const s of [x.reserved,x.firstClosed,x.waiting,x.stillTransport])snapshot(s,x.mode,x.capacity);
  need(x.reserved.read.state==='active'&&x.reserved.read.attempt===0&&x.reserved.readRows===x.capacity&&x.reserved.authorityLookups===x.capacity&&x.reserved.zeroedBytes===0,'reserve');
  need(x.firstClosed.read.state==='active'&&x.firstClosed.read.attempt===1&&x.firstClosed.read.borrows===1&&x.firstClosed.read.pendingTransport===0&&x.firstClosed.zeroedBytes===0,'first_attempt');
  for(const s of [x.waiting,x.stillTransport])need(s.read.state==='closing'&&s.read.attempt===2&&s.authorityLookups===x.capacity-1&&s.read.pendingTransport===1&&s.read.transportUsesBody&&s.zeroedBytes===0&&s.read.publications===(x.actor==='client'?4:2),'waiting');
  need(x.waiting.read.borrows===1&&x.waiting.read.borrowUsesFirstBody&&x.stillTransport.read.borrows===0&&!x.stillTransport.read.borrowUsesFirstBody,'borrow');need((x.mode==='full-input'?x.waiting.read.fullChecks:x.waiting.read.ownedChecks)>0,'live_checks');
  drained(x.drained,x.mode,x.capacity,x.capacity-1,6144,1);drained(x.final,x.mode,x.capacity,0,6144*x.capacity,x.capacity);
 }
 equal(e.rejection.map(x=>x.id),modes.flatMap(mode=>actors.flatMap(actor=>faults.map(f=>`${mode}/${actor}/${f}`))),'rejection_cases');
 for(const x of e.rejection){keys(x,'id mode actor fault denied waiting final');need(x.id===`${x.mode}/${x.actor}/${x.fault}`&&x.denied,'rejection_binding');const s=x.waiting;snapshot(s,x.mode,1);
  const reason=x.fault.startsWith('reenter-')?'reentry':x.fault==='cancel-before-publication'?'cancelled':x.fault==='expire-before-publication'?'expired':x.fault==='revoke-before-publication'?'authority':'revision';need(s.read.actor===x.actor&&s.read.state==='retiring'&&s.read.reason===reason&&s.read.attempt===1&&s.publications===0&&s.read.publications===0&&s.authorityLookups===0&&s.readRows===1&&s.heldBodySlots===2&&s.zeroedBytes===0,'fatal');
  if(x.fault.startsWith('reenter-'))need(s.caughtReentries===1&&s.reentryRefusals===1&&s.faultFrameCount===1&&s.faultHeldBodies===2,'reentry');else need(s.caughtReentries+s.reentryRefusals+s.faultFrameCount+s.faultHeldBodies===0,'no_reentry');drained(x.final,x.mode,1,0,6144,1);need(x.final.publications===0,'late_publication');
 }
 equal(e.cleanup.map(x=>x.id),modes.flatMap(mode=>actors.map(actor=>`${mode}/${actor}`)),'cleanup_cases');
 for(const x of e.cleanup){keys(x,'id mode actor denied partial fullRefused lateRefused final');need(x.id===`${x.mode}/${x.actor}`&&x.denied&&x.fullRefused&&x.lateRefused,'cleanup_binding');const s=x.partial;snapshot(s,x.mode,1);need(s.read.actor===x.actor&&s.read.state==='retiring'&&s.read.reason==='cleanup'&&s.readRows===1&&s.authorityLookups===0&&s.zeroedBytes===3072&&s.reclaims===0&&s.heldBodySlots===2,'quarantine');drained(x.final,x.mode,1,0,6144,1);}
 return {normal:8,rejection:28,cleanup:4,modes:2,realBinaryBytesPerRead:6144,referenceSlotsPerRead:96,opaquePerRead:16,scope:'limited-lifecycle',chargeProved:false,actualParentLedgerVector:false,r1mExit:false,productionAdopted:false};
}
export function compareR1hReplay(saved,fresh){validateR1hEvidence(saved);validateR1hEvidence(fresh);equal(saved,fresh,'fresh_replay');return true;}
