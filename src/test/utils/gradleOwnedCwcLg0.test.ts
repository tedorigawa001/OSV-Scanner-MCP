import {afterAll,it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {lg0Fixture,lg0ApprovalFixture,lg0MaximumInput} from '../fixtures/gradleOwnedCwcLg0Fixture.js';
import {Lg0Approval} from '../fixtures/gradleOwnedCwcLg0Approval.js';
import {Lg0Session} from '../fixtures/gradleOwnedCwcLg0.js';
import {LG0_POLICY,lgOwnedCopy,lgOwnedView,lgNormalize} from '../fixtures/gradleOwnedCwcLg0Contract.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {cwcCMemory} from '../fixtures/gradleOwnedCwcC.js';
import {ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
const modes=['full-input','owned-input'] as const;

it('LG001: capture and seal private inputs in both modes; normal scope release preserves final processing',()=>{
 for(const mode of ['full-input','owned-input'] as const){
  const f=lg0Fixture({mode});try{
   const call=f.open();const handle=call.capture();expect(Object.keys(handle)).toEqual(['kind']);
   expect(call.stats().state).toBe('verified-unbound');call.seal(handle,call.scope);
   call.inspect(handle);call.closeScope();expect(()=>call.inspect(handle)).toThrow();
   // A released LG handle is unusable, but a normal final full-input path is still available.
   expect(call.finalize()).toBe('complete');expect(call.stats().actual.open).toBe(false);
   expect(call.stats().metrics.publications).toBe(1);
  }finally{f.close();}
 }
});
it('LG004: normal release affects only local generation, lookup and ticket and does not restore handles',()=>{
 for(const mode of modes){const f=lg0Fixture({mode});try{const {call,handle}=f.ready(),before=call.stats(),owner=f.authority.snapshot();
  call.closeScope();call.closeScope();const released=call.stats();expect(released.actual).toEqual(before.actual);expect(f.authority.snapshot()).toEqual(owner);
  expect(released.localGeneration).toBe(before.localGeneration+1);expect(released.lookup).toBe(false);expect(released.metrics.privateReferences).toBe(0);expect(released.metrics.lgReleases).toBe(1);
  expect(released.budget.heldBytes).toBe(before.budget.heldBytes-4096);expect(()=>call.inspect(handle)).toThrow();expect(call.finalize()).toBe('complete');
 }finally{f.close();}}
});
it('LG005: input aliases and returned diagnostic copies cannot change the owned policy',()=>{
 for(const mode of modes){const f=lg0Fixture({mode});try{const {call,handle}=f.ready();(f.input.view as any).permissions.length=0;(f.input.context as any).lineage.lineageId='changed';
  const stats=call.stats();stats.normalizer!.work.nodeVisits=0;stats.actual.open=false;call.inspect(handle);call.closeScope();expect(call.finalize()).toBe('complete');
 }finally{f.close();}}
});
it('LG006: descriptor-only copy refuses unsafe inputs before evaluating getters or hooks',()=>{
 let reads=0;const getter=Object.defineProperty({},'peer',{enumerable:true,get(){reads++;return true;}}),toJSON={toJSON(){reads++;return {};}};
 const cycle:any={};cycle.self=cycle;
 for(const value of [getter,toJSON,new Proxy({},{}),Buffer.from('x'),new SharedArrayBuffer(8),new Map(),new Set(),new Date(),cycle,Object.create(null),{[Symbol('x')]:1}])expect(()=>lgOwnedCopy(value)).toThrow();
 expect(reads).toBe(0);const f=lg0Fixture();try{for(const value of [{...f.input.view as any,valid:true},{...f.input.view as any,permissions:undefined}])expect(()=>lgOwnedView(value)).toThrow('schema_invalid');}finally{f.close();}
});
it('LG007: capture and seal are once-only claims and do not resurrect released or failed calls',()=>{
 for(const mode of modes)for(const stage of ['capture','seal','released-before-capture']){const f=lg0Fixture({mode});try{const call=f.open();
  if(stage==='released-before-capture'){call.closeScope();expect(()=>call.capture()).toThrow();}
  else{const h=call.capture();if(stage==='capture')expect(()=>call.capture()).toThrow('call_reused');else{call.seal(h,call.scope);expect(()=>call.seal(h,call.scope)).toThrow();}}
  expect(call.stats().actual.open).toBe(false);expect(call.stats().metrics.publications).toBe(0);expect(()=>call.capture()).toThrow();
 }finally{f.close();}}
});
it('LG008: opaque handles, scopes and same-value associations from other calls cannot be rebound',()=>{
 for(const mode of modes)for(const fault of ['copy','spread','prototype','scope','association','unbound']){const f=lg0Fixture({mode});try{
  const call=f.open(),h=call.capture();
  expect(()=>{if(fault==='unbound')call.inspect(h);else call.seal(fault==='copy'?structuredClone(h):fault==='spread'?{...h}:fault==='prototype'?Object.create(h):h,fault==='scope'?{...call.scope}:call.scope,fault==='association'?{...call.association}:call.association);}).toThrow();
  expect(call.stats().actual.open).toBe(false);expect(call.stats().metrics.seals).toBe(0);
 }finally{f.close();}}
});
it('LG009: owner/verification/clock/profile registration requires exact references and closes before capture',()=>{
 for(const target of ['owner','verification','clock','approval']){const f=lg0Fixture({register:false});try{
  expect(()=>f.session.registerOwnedLivePort(target==='owner'?{} as any:f.authority,target==='verification'?{}:f.session.verificationOwner,target==='clock'?{} as any:f.clock,target==='approval'?{} as any:f.approval.approval)).toThrow('codec_profile_unsupported');
  f.session.registerOwnedLivePort(f.authority,f.session.verificationOwner,f.clock,f.approval.approval);const {call}=f.ready();
  expect(()=>f.session.registerOwnedLivePort(f.authority,f.session.verificationOwner,f.clock,f.approval.approval)).toThrow();call.closeScope();call.finalize();
 }finally{f.close();}}
});
it('LG010: every authoritative mutation invalidates old calls before validation and restoration cannot revive them',()=>{
 for(const mode of modes)for(const domain of ['peer','server','peerKeyEpoch','serverKeyEpoch','permissions','purpose','registryPin','sourcePin','profilePin','callbackPolicy']){const f=lg0Fixture({mode});try{
  const {call,handle}=f.ready(),changed:any=structuredClone(f.input.view);
  changed[domain]=domain==='peer'||domain==='server'?false:domain==='permissions'?[]:domain==='purpose'?'publication':domain.endsWith('Pin')?'f'.repeat(64):2;
  f.authority.replace(changed);expect(call.stats().actual.open).toBe(false);f.authority.replace(f.input.view);expect(()=>call.inspect(handle)).toThrow();expect(call.stats().metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LG011: failed mutation poisons old calls and new admission without invoking an input accessor',()=>{
 for(const mode of modes){const f=lg0Fixture({mode});try{const {call}=f.ready();let reads=0;
  const bad=Object.defineProperty({},'permissions',{enumerable:true,get(){reads++;return [];}});
  expect(()=>f.authority.replace(bad)).toThrow('schema_invalid');expect(reads).toBe(0);expect(f.authority.snapshot().updating).toBe(true);
  expect(call.stats().actual.open).toBe(false);expect(()=>f.open()).toThrow('owner_closed');
 }finally{f.close();}}
});
it('LG012: caught external reentry poisons capture, seal, permission checks and final publication',()=>{
 for(const mode of modes)for(const site of ['capture-before','capture-after','seal','permissions-before','permissions-after','final-before']){const f=lg0Fixture({mode});try{
  const call=f.open();f.hooks[site]=()=>{try{call.inspect({kind:'fake'});}catch{}};
  expect(()=>{const h=call.capture();call.seal(h,call.scope);call.inspect(h);call.closeScope();call.finalize();}).toThrow();
  expect(call.stats().reason).toBe('reentrant');expect(call.stats().metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LG013: fixed internal nested checks preserve logical debits without authorizing external frames',()=>{
 for(const mode of modes){const f=lg0Fixture({mode});try{const {call,handle}=f.ready(),before=f.budget.stats();call.nested(handle);const s=call.stats();
  expect(s.metrics.logical).toBe(2);expect(s.metrics.matches).toBe(2);expect(s.budget.work-before.work).toBe(2);expect(s.metrics.fullPermissionCopies).toBe(mode==='full-input'?2:0);
  call.closeScope();call.finalize();
 }finally{f.close();}}
});
it('LG014: the original clock deadline is not renewed at capture, seal, check or final callback',()=>{
 for(const mode of modes)for(const site of ['capture-before','seal','permissions-after','final-before']){const f=lg0Fixture({mode});try{
  const call=f.open();f.hooks[site]=()=>f.clock.advance(4500);
  expect(()=>{const h=call.capture();call.seal(h,call.scope);call.inspect(h);call.closeScope();call.finalize();}).toThrow('request_expired');expect(call.stats().metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LG015: late fatal invalidation dominates normal finally and blocks final outcome/use/ACK',()=>{
 for(const mode of modes)for(const reason of ['request_expired','cancelled','codec_profile_unsupported','reentrant','validation_failure']){const f=lg0Fixture({mode});try{
  const {call}=f.ready();call.closeScope();call.invalidate(reason);call.closeScope();expect(()=>call.finalize()).toThrow(reason);
  const s=call.stats();expect(s.reason).toBe(reason);expect(s.metrics.lgReleases).toBe(1);expect(s.metrics.use+s.metrics.ack+s.metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LG016: arena and initialization reservations fail before normalizer callbacks and keep past consumption',()=>{
 for(const mode of modes)for(const axis of ['memory','work']){let entered=0;const warm=lg0Fixture({mode});const base=warm.ready().call.stats().budget.peakBytes;warm.close();
  const budget=axis==='memory'?new Lb0Budget(undefined,base-1):new Lb0Budget(undefined,1048576,77823);
  const f=lg0Fixture({mode,budget});try{const call=f.open(),before=budget.stats();f.hooks['capture-before']=()=>{entered++;};expect(()=>call.capture()).toThrow('codec_budget_exceeded');
   expect(entered).toBe(0);expect(call.stats().metrics.normalizations).toBe(0);expect(budget.stats().initialization).toBe(before.initialization);expect(budget.stats().work).toBe(before.work);expect(()=>call.capture()).toThrow('codec_budget_exceeded');
  }finally{f.close();}expect(budget.stats().heldBytes).toBe(0);
 }
});
it('LG017: independent ledger decreases and logical-limit excess cannot be hidden',()=>{
 for(const mode of modes){const balance={work:0,initialization:0,wire:0,attempts:0},f=lg0Fixture({mode,budget:new Lb0Budget(balance)});try{
  const {call,handle}=f.ready();call.inspect(handle);balance.initialization--;expect(()=>call.inspect(handle)).toThrow('codec_budget_exceeded');
 }finally{f.close();}}
 const f=lg0Fixture();try{const {call,handle}=f.ready();for(let i=0;i<4096;i++)call.inspect(handle);expect(()=>call.inspect(handle)).toThrow('codec_budget_exceeded');expect(call.stats().metrics.matches).toBe(4096);}finally{f.close();}
});
it('LG018: sixty-four rows, maximum single-lineage strings and exact canonical key ordering are preserved',()=>{
 const f=lg0Fixture();try{
  const v=structuredClone(f.input.view) as any,p=structuredClone(v.permissions.find((p:any)=>p.api==='aux.ReadSourceRanges'));
  p.lineage.authorityId='a'.repeat(128);p.lineage.lineageId='b'.repeat(128);v.permissions=[p];
  const owned=lgOwnedView(v),max=lgNormalize(owned,p.lineage);expect(max.poolBytes).toBeLessThanOrEqual(1024);expect(Object.isFrozen(owned.permissions[0]!.lineage)).toBe(true);
  expect(()=>{(owned.permissions[0]!.lineage as any).authorityId='write';}).toThrow();
  const short=structuredClone(f.input.view) as any;short.permissions=Array.from({length:64},()=>structuredClone(f.permissions.find((p:any)=>p.api==='aux.ReadSourceRanges')));
  const projection=lgNormalize(lgOwnedView(short),f.context.lineage);expect(projection.rows).toHaveLength(64);expect(projection.work.tupleWrites).toBe(256);expect(projection.work.canonicalCalls).toBe(65);
  const reversed=Object.fromEntries(Object.entries(f.context.lineage).reverse());expect(lgNormalize(lgOwnedView(short),reversed).expectedKey).toBe(projection.expectedKey);
  for(const p of [max,projection]){expect(Object.values(p.work).reduce((a,b)=>a+b,0)).toBeLessThanOrEqual(3137);expect(p.temporaryBytes).toBeLessThanOrEqual(32768);}
 }finally{f.close();}
});
it('LG019: oversized lineage pool, raw bytes, node count and depth reject without fallback',()=>{
 for(const mode of modes){const f=lg0Fixture({mode,configure:o=>{const v=o.view as any;v.permissions=Array.from({length:10},(_,i)=>({...structuredClone(v.permissions[0]),lineage:{...v.permissions[0].lineage,authorityId:'a'.repeat(120)+i}}));}});try{
  const call=f.open();expect(()=>call.capture()).toThrow('codec_profile_unsupported');expect(call.stats().metrics.captures).toBe(0);expect(f.budget.stats().initialization).toBe(20480);
 }finally{f.close();}}
 let deep:any={};for(let i=0;i<13;i++)deep={deep};expect(()=>lgOwnedCopy(deep)).toThrow('codec_budget_exceeded');expect(()=>lgOwnedCopy(Array.from({length:2048},()=>true))).toThrow();expect(()=>lgOwnedCopy('x'.repeat(32769),32768)).toThrow();
});
it('LG020: source approval refuses bad signatures, changed closure, wrong policy and forged brands',()=>{
 const a=lg0ApprovalFixture();for(const fault of ['signature','source','policy','pin','missing-import']){
  const e=structuredClone(a.envelope),sources={...a.sources};let pin=a.pin;
  if(fault==='signature')e.signature='A'.repeat(86)+'==';if(fault==='source')sources['src/test/fixtures/gradleOwnedCwcLg0.ts']=Buffer.from('forged');
  if(fault==='policy')e.manifest.policyDigest='f'.repeat(64);if(fault==='pin')pin='f'.repeat(64);if(fault==='missing-import')delete sources['src/test/fixtures/gradleOwnedCwcLg0Contract.ts'];
  expect(()=>new Lg0Approval(e,a.registry,pin,sources)).toThrow('codec_profile_unsupported');
 }
 expect(()=>Lg0Approval.require({...a.approval} as any)).toThrow('codec_profile_unsupported');
 for(const field of ['approval','clock','budget'])expect(()=>lg0Fixture({configure:o=>{(o as any)[field]={};}})).toThrow();
});
it('LG021: approval revocation and authority restart cannot be undone by a same-value view',()=>{
 for(const mode of modes)for(const fault of ['approval','restart']){const f=lg0Fixture({mode});try{
  const {call,handle}=f.ready();if(fault==='approval')f.approval.approval.revoke();else f.authority.restart();expect(()=>call.inspect(handle)).toThrow();expect(call.stats().actual.open).toBe(false);
 }finally{f.close();}}
});
it('LG022: both roles and both modes reserve distinct arenas alongside existing layouts over two attempts',()=>{
 for(const mode of modes)for(const role of ['reader','authority-broker'] as const){const f=lg0Fixture({mode,role});try{
  const memory=cwcCMemory(f.context),expected=memory.reserved-32768+131072+98304+8192+4096;
  expect(Object.values(LG0_POLICY.callLayout).reduce((s,n)=>s+n,0)).toBe(98304);expect(LG0_POLICY.callLayout.vfMetadata).toBe(4096);
  expect(expected,role+' maximum live layout').toBeLessThanOrEqual(1048576);
  for(let i=0;i<2;i++){const {call,handle}=f.ready();expect(call.stats().budget.heldBytes).toBe(expected);expect(expected).toBeLessThanOrEqual(1048576);call.inspect(handle);call.closeScope();call.finalize();}
  const s=f.budget.stats();expect(s.initialization).toBe(36864);expect(s.work).toBe(114690);expect(s.wire).toBe(114688);expect(s.attempts).toBe(2);expect(s.work+s.initialization).toBeLessThanOrEqual(156978);expect(s.heldBytes).toBe(131072);
 }finally{f.close();}expect(f.budget.stats().heldBytes).toBe(0);}
});
it('LG023: a pending quarantined attempt cannot borrow its own memory for a new attempt',()=>{
 for(const mode of modes){const f=lg0Fixture({mode});try{const {call}=f.ready();call.holdDispatch();call.invalidate('cancelled');const held=f.budget.stats().heldBytes;
  expect(()=>f.open()).toThrow('codec_budget_exceeded');expect(f.budget.stats().heldBytes).toBe(held);call.settleDispatch();const next=f.ready();next.call.closeScope();expect(next.call.finalize()).toBe('complete');
 }finally{f.close();}}
});
it('LG024: options getters and extra fields cannot substitute authority or budget during construction',()=>{
 const f=lg0Fixture();try{let reads=0;const options={...f.input};Object.defineProperty(options,'approval',{enumerable:true,get(){reads++;return f.approval.approval;}});
  expect(()=>new Lg0Session(options)).toThrow('schema_invalid');expect(reads).toBe(0);expect(()=>new Lg0Session({...f.input,valid:true} as any)).toThrow('schema_invalid');
 }finally{f.close();}
});
const layouts:any[]=[],proofs:any[]=[];
it('LG027: first/middle/last row matches and every predicate field retain permission meaning',()=>{
 for(const mode of modes)for(const position of [0,31,63]){const f=lg0Fixture({mode,configure:o=>{const v=o.view as any,p=structuredClone(v.permissions.find((p:any)=>p.api==='aux.ReadSourceRanges'));v.permissions=Array.from({length:64},()=>({...structuredClone(p),api:'aux.ReadSourceDescriptor'}));v.permissions[position]=p;}});try{
  const {call,handle}=f.ready();call.inspect(handle);expect(call.stats().normalizer!.rows).toBe(64);call.closeScope();expect(call.finalize()).toBe('complete');
 }finally{f.close();}}
 for(const mode of modes)for(const field of ['api','purpose','delegateInstance','lineage']){const f=lg0Fixture({mode,configure:o=>{const v=o.view as any,p=structuredClone(v.permissions.find((p:any)=>p.api==='aux.ReadSourceRanges'));p[field]=field==='api'?'aux.ReadSourceDescriptor':field==='purpose'?'publication':field==='delegateInstance'?'wrong-provider':{...p.lineage,lineageId:'wrong'};v.permissions=[p];}});try{
  const call=f.open(),h=call.capture();expect(()=>call.seal(h,call.scope)).toThrow('permission_denied');expect(call.stats().metrics.seals).toBe(0);
 }finally{f.close();}}
});
it('LG028: a different call with independent parent capacity remains usable during another operation',()=>{
 for(const mode of modes){const a=lg0Fixture({mode}),b=lg0Fixture({mode});try{
  const first=a.ready(),second=b.ready();let entered=0;
  a.hooks['permissions-before']=()=>{entered++;second.call.inspect(second.handle);};first.call.inspect(first.handle);
  expect(entered).toBe(1);expect(first.call.stats().actual.open).toBe(true);expect(second.call.stats().actual.open).toBe(true);
  for(const {call}of [first,second]){call.closeScope();expect(call.finalize()).toBe('complete');}
 }finally{a.close();b.close();}}
});
it('LG029: ledger method substitution never fabricates prepayment or invokes substituted getters',()=>{
 for(const mode of modes)for(const site of ['capture-before','permissions-before'])for(const method of ['reserve','check'] as const){
  const f=lg0Fixture({mode}),original=Object.getOwnPropertyDescriptor(Lb0Budget.prototype,method)!;let invoked=0;
  try{const call=f.open();f.hooks[site]=()=>Object.defineProperty(Lb0Budget.prototype,method,{configurable:true,get(){invoked++;return ()=>({kind:'forged-ticket'});}});
   expect(()=>{const h=call.capture();call.seal(h,call.scope);call.inspect(h);}).toThrow('codec_profile_unsupported');
   expect(invoked).toBe(0);expect(call.stats().metrics.publications).toBe(0);expect(call.stats().metrics.lgReleases).toBe(1);
  }finally{Object.defineProperty(Lb0Budget.prototype,method,original);f.close();}expect(f.budget.stats().heldBytes).toBe(0);
 }
 expect(Object.isFrozen(Lg0Session.prototype)).toBe(true);expect(Object.isFrozen(Lg0Approval)).toBe(true);
});
it('LG030: uncaptured and unsealed calls abort and never publish success, including after scope cleanup',()=>{
 for(const mode of modes)for(const captured of [false,true])for(const cleaned of [false,true]){const f=lg0Fixture({mode});try{
  const call=f.open();if(captured)call.capture();const before=f.budget.stats();
  if(cleaned)call.closeScope();expect(()=>call.finalize()).toThrow('codec_fact_binding_mismatch');
  call.closeScope();const s=call.stats();expect(s.actual.open).toBe(false);expect(s.state).toBe('invalid');expect(s.reason).toBe('codec_fact_binding_mismatch');
  expect(s.metrics.captures).toBe(captured?1:0);expect(s.metrics.seals).toBe(0);expect(s.metrics.publications+s.metrics.signs+s.metrics.use+s.metrics.ack).toBe(0);
  expect(s.metrics.lgReleases).toBe(captured?1:0);expect(s.budget.initialization).toBe(before.initialization);expect(s.budget.work).toBe(before.work);
  expect(()=>call.capture()).toThrow('codec_fact_binding_mismatch');expect(s.budget.heldBytes).toBe(131072);
 }finally{f.close();}expect(f.budget.stats().heldBytes).toBe(0);}
});
it('LG025: schema-maximum contexts never bypass the parent cap, even on a second attempt',()=>{
 for(const mode of modes)for(const role of ['reader','authority-broker'] as const){const f=lg0Fixture({mode,role,configure:lg0MaximumInput});let error:string|null=null;try{
  for(let i=0;i<2;i++){const {call}=f.ready();call.closeScope();call.finalize();}
 }catch(e){error=(e as any).reason;expect(error).toBe('codec_budget_exceeded');}
 finally{f.close();}expect(f.budget.stats().heldBytes).toBe(0);expect(f.budget.stats().peakBytes).toBeLessThanOrEqual(1048576);
 layouts.push({mode,role,context:f.context,status:error?'unsupported':'admitted',error,budget:f.budget.stats()});
 }
});
it('LG026: emits independently checkable mode/role/lifecycle and retry evidence',()=>{
 for(const mode of modes)for(const role of ['reader','authority-broker'] as const)for(const scenario of ['normal','normal-then-revoke','timeout-pending','reentry-caught','failed-mutation','capture-pool-overflow','retry','uncaptured-finish','unsealed-finish']){
  const f=lg0Fixture({mode,role,configure:scenario==='capture-pool-overflow'?o=>{const v=o.view as any,p=v.permissions[0];v.permissions=Array.from({length:10},(_,i)=>({...structuredClone(p),lineage:{...p.lineage,authorityId:'a'.repeat(120)+i}}));}:undefined});
  let call:ReturnType<typeof f.open>|undefined,prior:any=null,error:string|null=null,normalRelease:any=null;const memory=cwcCMemory(f.context);
  try{call=f.open();if(scenario==='uncaptured-finish'){call.closeScope();call.finalize();}
   const h=call.capture();if(scenario==='unsealed-finish'){call.closeScope();call.finalize();}call.seal(h,call.scope);
   if(scenario==='reentry-caught')f.hooks['permissions-before']=()=>{try{call!.inspect(h);}catch{}};
   if(scenario==='failed-mutation'){try{f.authority.replace({invalid:true});}catch{}}
   if(scenario==='timeout-pending'){call.holdDispatch();f.clock.advance(4500);}
   call.inspect(h);const beforeRelease=call.stats();call.closeScope();normalRelease={before:beforeRelease,after:call.stats()};
   if(scenario==='normal-then-revoke')f.approval.approval.revoke();call.finalize();
   if(scenario==='retry'){prior=call.stats();call=f.open();const next=call.capture();call.seal(next,call.scope);call.inspect(next);call.closeScope();call.finalize();}
  }catch(e){error=(e as any).reason;expect(error).toBeTruthy();}
  expect(call).toBeDefined();const beforeClose=call!.stats(),owner=f.authority.snapshot();f.close();const afterClose=call!.stats();
  if(scenario==='timeout-pending')expect(call!.settleDispatch()).toBe('late-rejected');const afterDrain=call!.stats();
  expect(afterDrain.budget.heldBytes).toBe(0);expect(error===null).toBe(scenario==='normal'||scenario==='retry');
  proofs.push({id:`${mode}/${role}/${scenario}`,mode,role,scenario,error,context:f.context,memory,normalRelease,prior,owner,beforeClose,afterClose,afterDrain,
   approval:{envelope:f.approval.envelope,registry:f.approval.registry,pin:f.approval.pin}});
 }
});
afterAll(()=>{if(process.env.CWC_LG0_EVIDENCE_PATH)writeFileSync(process.env.CWC_LG0_EVIDENCE_PATH,JSON.stringify({schema:'cwc-lg0.evidence.v2',policy:LG0_POLICY,proofs,layouts,
 scope:{standalone:true,fixedClock:true,ownedBudget:true,logicalLayoutOnly:true,existingProvider:false,actualReadScope:false,actualSession:false,
  actualSourceIO:false,actualSignatureOnReply:false,actualOutcomeUseAck:false,performanceMeasured:false,primaryAndBridgeExecuted:false,productionAdopted:false}}));});
it('LG003: fatal close releases only LG bytes before pending dispatch drains, including session ownership',()=>{
 for(const mode of ['full-input','owned-input'] as const){const f=lg0Fixture({mode}),{call,handle}=f.ready();
  call.holdDispatch();const before=f.budget.stats();f.close();
  expect(f.budget.stats().heldBytes).toBe(before.heldBytes-4096);
  expect(call.stats().actual).toEqual({open:false,generation:2,lookup:false,channelOpen:false});
  expect(()=>call.inspect(handle)).toThrow();expect(()=>call.read()).toThrow();expect(()=>call.finalize()).toThrow();
  expect(call.settleDispatch()).toBe('late-rejected');expect(f.budget.stats().heldBytes).toBe(0);
  expect(call.stats().metrics.lgReleases).toBe(1);expect(call.stats().metrics.publications).toBe(0);
 }
});
it('LG002: scope release from a foreign callback poisons the outer operation even if caught',()=>{
 for(const mode of ['full-input','owned-input'] as const)for(const site of ['capture-after','seal','permissions-before']){const f=lg0Fixture({mode});try{
  const call=f.open();f.hooks[site]=()=>{try{call.closeScope();}catch{}};
  expect(()=>{const handle=call.capture();call.seal(handle,call.scope);call.inspect(handle);}).toThrow();expect(call.stats().state).toBe('invalid');expect(call.stats().reason).toBe('reentrant');expect(call.stats().metrics.publications).toBe(0);
 }finally{f.close();}}
});
