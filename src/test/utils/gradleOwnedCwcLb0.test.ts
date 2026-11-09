import {it,expect,vi,afterAll} from 'vitest';
import {writeFileSync} from 'node:fs';
import * as protocol from '../fixtures/gradleOwnedCprBProtocol.js';
import * as signer from '../fixtures/gradleOwnedCprBSigner.js';
import {lb0Fixture,lb0ApprovalFixture} from '../fixtures/gradleOwnedCwcLb0Fixture.js';
import {Lb0Budget,LB0_MODES,LB0_POLICY,Lb0Approval} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {CwcLb0Session} from '../fixtures/gradleOwnedCwcLb0.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {signedServiceFrame} from '../fixtures/gradleOwnedServiceContract.js';
let matrixEvidence:any;const proofs:any[]=[];
afterAll(()=>{if(process.env.CWC_LB0_EVIDENCE_PATH){expect(matrixEvidence.samples).toHaveLength(12);expect(proofs).toHaveLength(13);writeFileSync(process.env.CWC_LB0_EVIDENCE_PATH,JSON.stringify({...matrixEvidence,proofs}));}});

it('LB001: both modes use private bytes and full signed protocol/owner checks',()=>{
 const approval=lb0ApprovalFixture(),samples:any[]=[];
 for(const mode of LB0_MODES)for(const role of ['reader','authority-broker'] as const)for(const api of ['aux.ReadSourceDescriptor','aux.ReadSealedSource','aux.ReadSourceRanges'] as const){
  const f=lb0Fixture({mode,role,api,approval});try{const {call}=f.issue(),b=f.bind(call);f.session.check(b.bound,b.owner,b.scope);const command=f.session.readCommand(b.bound,b.owner,b.scope);expect(command).toEqual(f.command);f.session.closeScope(b.scope);const closed=f.session.stats(call);expect(closed.bytesHeld).toBeGreaterThan(0);f.session.finishCall(call);const s=f.session.stats(call);expect(s.lookupPresent).toBe(false);expect(s.reclaimed).toBe(true);expect(s.metrics.fullChecks).toBe(s.metrics.wireIdentityHashes);expect(s.metrics.fullChecks).toBe(s.metrics.channelChecks);expect(s.metrics.challengeChecks).toBe(s.metrics.fullChecks+1);expect(s.metrics.ownerChecks).toBe(s.metrics.fullChecks+s.metrics.copies);expect(s.metrics.publications).toBe(1);f.close();samples.push({mode,role,api,sourceApprovalPin:approval.pin,expectedCommandDigest:hash(f.command),commandDigest:hash(command),scopeClosed:closed,completed:s,budgetAfterClose:f.budget.stats()});}finally{f.close();}
 }
 matrixEvidence={schema:'cwc-lb0.samples.v1',samples,sourceApproval:{pin:approval.pin,envelope:approval.envelope,registry:approval.registry}};
});
it('LB004: invalid/shared/proxy buffers and packet getters are refused before copy',()=>{
 for(const kind of ['shared','oversize','proxy','getter','packet-proxy']){
  const f=lb0Fixture();let gets=0;try{const p=f.prepare(),packet:any={...p.packet};
   if(kind==='shared')packet.inner=Buffer.from(new SharedArrayBuffer(8));
   if(kind==='oversize')packet.inner=Buffer.alloc(8193);
   if(kind==='proxy')packet.inner=new Proxy(p.packet.inner,{get(){gets++;throw Error('getter');}});
   if(kind==='getter')Object.defineProperty(packet,'inner',{get(){gets++;return p.packet.inner;}});
   const value=kind==='packet-proxy'?new Proxy(packet,{getPrototypeOf(){gets++;return Object.prototype;}}):packet;
   const alloc=vi.spyOn(Buffer,'alloc');try{expect(()=>f.session.receive(p.pending,value)).toThrow();expect(alloc).not.toHaveBeenCalled();expect(gets).toBe(0);expect(f.session.counts.lookup).toBe(0);}finally{alloc.mockRestore();}
  }finally{f.close();}
 }
});
it('LB005: base, capture and binding budgets are reserved before copies or projection getters',()=>{
 const f=lb0Fixture();try{const clone=vi.spyOn(globalThis,'structuredClone');try{expect(()=>new CwcLb0Session({...f.sessionOptions,budget:new Lb0Budget(undefined,LB0_POLICY.baseBytes-1)})).toThrow('codec_budget_exceeded');expect(clone).not.toHaveBeenCalled();}finally{clone.mockRestore();}}finally{f.close();}
 for(const kind of ['capture','work','binding']){
  const balance={work:0,initialization:0,wire:0,attempts:0},memory=kind==='capture'?LB0_POLICY.baseBytes+LB0_POLICY.callBytes-1:kind==='binding'?LB0_POLICY.baseBytes+LB0_POLICY.callBytes+LB0_POLICY.bindingBytes-1:1048576;
  const f=lb0Fixture({budget:new Lb0Budget(balance,memory,kind==='work'?4096:156978)});try{
   if(kind!=='binding'){const alloc=vi.spyOn(Buffer,'alloc');try{expect(()=>f.prepare()).toThrow('codec_budget_exceeded');expect(alloc).not.toHaveBeenCalled();expect(balance.attempts).toBe(0);}finally{alloc.mockRestore();}}
   else{const {call}=f.issue(),owner=f.session.owner(),scope=f.session.scope(owner),draft=f.session.begin(call,owner).draft,row=f.session.operationRow(draft,owner);let gets=0;const projection={get peer(){gets++;return f.peer;}};expect(()=>f.session.seal(draft,owner,scope,row,projection)).toThrow('codec_budget_exceeded');expect(gets).toBe(0);expect(f.session.stats(call).claimHeld).toBe(true);expect(balance.work+balance.initialization).toBeGreaterThan(0);}
  }finally{f.close();}
 }
});
it('LB006: independently permitted purpose changes still mismatch the issued and bound purpose',()=>{
 for(const mode of LB0_MODES){const f=lb0Fixture({mode});try{const {call}=f.issue(),b=f.bind(call);expect(f.permissions.some((p:any)=>p.api===f.api&&p.purpose==='publication')).toBe(true);f.setPurpose('publication');expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow('permission_denied');f.setPurpose('read');expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow();const s=f.session.stats(call);expect(s.lookupPresent).toBe(false);expect(s.reclaimed).toBe(true);expect(s.metrics.publications).toBe(0);proofs.push({id:'purpose',mode,after:s});}finally{f.close();}}
});
it('LB017: rollback of actual work, initialization, wire or attempt balances is never accepted',()=>{
 for(const key of ['work','initialization','wire','attempts'] as const){const balance={work:0,initialization:0,wire:0,attempts:0},f=lb0Fixture({budget:new Lb0Budget(balance)});try{const {call}=f.issue(),b=f.bind(call),value=balance[key];balance[key]=value-1;expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow('codec_budget_exceeded');balance[key]=value;expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow();expect(f.session.stats(call).metrics.publications).toBe(0);}finally{f.close();}}
});
it('LB018: timeout removes lookup and bytes before blocked dispatch resolves or rejects',async()=>{
 for(const mode of LB0_MODES)for(const outcome of ['resolve','reject'] as const){vi.useFakeTimers();const f=lb0Fixture({mode});let resolve!:(x:unknown)=>void,reject!:(x:unknown)=>void;
  const blocked=new Promise((a,b)=>{resolve=a;reject=b;});
  try{const {call}=f.issue(),b=f.bind(call);const response=f.session.dispatch(call,()=>blocked).then(value=>({ok:true,value,error:null}),error=>({ok:false,value:null,error}));
   await vi.advanceTimersByTimeAsync(4500);const r=await response;expect(r.ok).toBe(false);expect(String(r.error)).toContain('request_expired');
   const expired=f.session.stats(call);expect(expired.lookupPresent).toBe(false);expect(expired.bytesHeld).toBe(0);expect(expired.pendingDispatch).toBe(true);expect(expired.slotReleased).toBe(false);expect(expired.budget.occupiedSlots).toBe(1);expect(expired.metrics.publications).toBe(0);expect(()=>f.session.inspectCall(call,f.inner)).toThrow('peer_mismatch');expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow();
   if(outcome==='resolve')resolve({late:true});else reject(Error('late failure'));await vi.runAllTimersAsync();
   const drained=f.session.stats(call);expect(drained.metrics.late).toBe(1);expect({...drained.metrics,late:0}).toEqual(expired.metrics);expect(drained.metrics.publications).toBe(0);expect(drained.metrics.reclaims).toBe(1);expect(drained.metrics.byteReleases).toBe(1);expect(drained.pendingDispatch).toBe(false);expect(drained.budget.occupiedSlots).toBe(0);expect(drained.scratchReleased).toBe(true);
   const names=drained.events.map(x=>x.name);expect(names.indexOf('lookup-removed')).toBeLessThan(names.indexOf('bytes-reclaimed'));expect(names.indexOf('bytes-reclaimed')).toBeLessThan(names.indexOf('late-'+outcome));
   proofs.push({id:'timeout-'+outcome,mode,expired,drained});
  }finally{resolve({cleanup:true});await vi.runAllTimersAsync();f.close();vi.useRealTimers();}
 }
});
it('LB019: an in-progress private reader defers zero and releases exactly once when drained',()=>{
 const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call);f.session.faultNextRead(call);expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow('request_expired');const s=f.session.stats(call),held=s.events.find(x=>x.name==='reader-still-held')!,released=s.events.find(x=>x.name==='bytes-reclaimed')!;expect(held.readers).toBe(1);expect(held.bytes).toBeGreaterThan(0);expect(released.readers).toBe(0);expect(released.bytes).toBe(0);expect(s.metrics.reclaims).toBe(1);f.session.cancel(call);f.session.closeScope(b.scope);expect(f.session.stats(call).metrics.byteReleases).toBe(1);proofs.push({id:'reader-expiry',mode:f.mode,after:f.session.stats(call)});}finally{f.close();}
});
it('LB020: timed-out uncompleted dispatch stays within shared capacity while bytes can be reclaimed',async()=>{
 vi.useFakeTimers();const budget=new Lb0Budget(undefined,1048576,156978,1),a=lb0Fixture({budget}),b=lb0Fixture({budget});let resume!:(v:unknown)=>void;
 try{const call=a.issue().call;a.bind(call);const waiting=new Promise(r=>resume=r),response=a.session.dispatch(call,()=>waiting).catch(e=>e);await vi.advanceTimersByTimeAsync(4500);await response;expect(a.session.stats(call).bytesHeld).toBe(0);expect(budget.stats().occupiedSlots).toBe(1);expect(()=>b.prepare()).toThrow('codec_budget_exceeded');resume({late:true});await vi.runAllTimersAsync();expect(budget.stats().occupiedSlots).toBe(0);const p=b.prepare();expect(p.pending.kind).toBe('clb0-pending');}finally{resume({cleanup:true});await vi.runAllTimersAsync();a.close();b.close();vi.useRealTimers();}
});
it('LB021: prepared or failed Drafts cannot dispatch work, publish, or supply a bound command',()=>{
 for(const stage of ['issued','draft','released']){const f=lb0Fixture();try{const {call}=f.issue(),owner=f.session.owner();let work=0;if(stage!=='issued'){const draft=f.session.begin(call,owner).draft;if(stage==='released')f.session.releaseDraft(draft,owner);}
  expect(()=>f.session.finishCall(call)).toThrow('source_binding');expect(()=>f.session.dispatch(call,async()=>{work++;return {ok:true};})).toThrow('source_binding');expect(work).toBe(0);expect(f.session.stats(call).metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LB022: falsy and non-Error callback failures settle as rejection and never become success',async()=>{
 for(const error of [undefined,null,false,0,'']){const f=lb0Fixture();try{const call=f.issue().call;f.bind(call);const r=await f.session.dispatch(call,async()=>{throw error;}).then(()=>({ok:true,error:undefined}),error=>({ok:false,error}));expect(r.ok).toBe(false);expect(r.error).toBe(error);const s=f.session.stats(call);expect(s.lookupPresent).toBe(false);expect(s.reclaimed).toBe(true);expect(s.metrics.publications).toBe(0);expect(s.budget.occupiedSlots).toBe(0);}finally{f.close();}}
});
it('LB023: the ordinary inspect entry still rejects arbitrary changed wire after binding',()=>{
 const f=lb0Fixture();try{const call=f.issue().call;f.bind(call);f.session.inspectCall(call,f.inner);const modified=Buffer.from(f.inner);modified[0]=0;expect(()=>f.session.inspectCall(call,modified)).toThrow('peer_mismatch');expect(f.session.stats(call).reclaimed).toBe(true);}finally{f.close();}
});
it('LB024: an authoritative shorter deadline advances the watchdog without waiting for dispatch',async()=>{
 vi.useFakeTimers();const f=lb0Fixture();let resume!:(x:unknown)=>void;
 try{const call=f.issue().call;f.bind(call);const blocked=new Promise(r=>resume=r),response=f.session.dispatch(call,()=>blocked).catch(e=>e);f.setNow(100);f.session.tighten(call,200);await vi.advanceTimersByTimeAsync(99);expect(f.session.stats(call).lookupPresent).toBe(true);await vi.advanceTimersByTimeAsync(1);expect(String(await response)).toContain('request_expired');expect(f.session.stats(call).bytesHeld).toBe(0);resume({late:true});await vi.runAllTimersAsync();}finally{resume({cleanup:true});await vi.runAllTimersAsync();f.close();vi.useRealTimers();}
});
it('LB025: independent approval rejects changed pin, signature, policy, source bytes or closure',()=>{
 const a=lb0ApprovalFixture();
 for(const kind of ['pin','signature','policy','source','closure']){const e=structuredClone(a.envelope),r=structuredClone(a.registry),sources={...a.sources};let pin=a.pin;
  if(kind==='pin')pin='0'.repeat(64);if(kind==='signature')e.signature='A'.repeat(86)+'==';if(kind==='policy'){e.manifest.policyDigest='0'.repeat(64);r.manifestDigest=hash(e.manifest);}
  if(kind==='source')sources['src/test/fixtures/gradleOwnedCwcLb0.ts']=Buffer.from('changed');
  if(kind==='closure')delete sources['src/test/fixtures/gradleOwnedCwcLb0Contract.ts'];
  expect(()=>new Lb0Approval(e,r,pin,sources,()=>pin)).toThrow();
 }
 a.revoke();expect(()=>a.view.assertCurrent()).toThrow('codec_profile_unsupported');a.restore();expect(()=>a.view.assertCurrent()).toThrow('codec_profile_unsupported');
});
it('LB026: ArrayBuffer-wide input mutation and authority view writes cannot change private identities or wire',()=>{
 const f=lb0Fixture();try{const p=f.issue(),b=f.bind(p.call);new Uint8Array(p.packet.inner.buffer).fill(0);let frozen=false;f.hooks.credential=view=>{frozen=Object.isFrozen(view);try{(view as any).boot='0'.repeat(64);}catch{}};expect(f.session.readCommand(b.bound,b.owner,b.scope)).toEqual(f.command);expect(frozen).toBe(true);expect(f.session.identities.peer.boot).toBe(f.command.peer.boot);expect(f.session.stats(p.call).lookupPresent).toBe(true);}finally{f.close();}
});
it('LB027: packet replay and mismatched projection or operation row cannot mint another binding',()=>{
 const f=lb0Fixture();try{const p=f.issue();expect(()=>f.session.receive(p.pending,p.packet)).toThrow('source_binding');const owner=f.session.owner(),scope=f.session.scope(owner),draft=f.session.begin(p.call,owner).draft,row=f.session.operationRow(draft,owner);expect(()=>f.session.seal(draft,owner,scope,row,{...f.session.identities,api:f.api,purpose:'publication',actor:'provider'})).toThrow();expect(f.session.stats(p.call).lookupPresent).toBe(false);}finally{f.close();}
 const a=lb0Fixture(),b=lb0Fixture();try{const ca=a.issue().call,cb=b.issue().call,oa=a.session.owner(),ob=b.session.owner(),da=a.session.begin(ca,oa).draft,db=b.session.begin(cb,ob).draft,row=b.session.operationRow(db,ob);expect(()=>a.session.seal(da,oa,a.session.scope(oa),row,{...a.session.identities,api:a.api,purpose:'read',actor:'provider'})).toThrow('source_binding');}finally{a.close();b.close();}
});
it('LB028: successful async dispatch after normal scope closure publishes one copied result',async()=>{
 const f=lb0Fixture();try{const call=f.issue().call,b=f.bind(call);let worked=0;const value={done:true,nested:{n:1}};const out:any=await f.session.dispatch(call,async()=>{worked++;f.session.closeScope(b.scope);return value;});expect(worked).toBe(1);expect(out).toEqual(value);expect(out).not.toBe(value);out.nested.n=2;expect(value.nested.n).toBe(1);const s=f.session.stats(call);expect(s.metrics.publications).toBe(1);expect(s.metrics.reclaims).toBe(1);expect(s.lookupPresent).toBe(false);expect(s.budget.occupiedSlots).toBe(0);}finally{f.close();}
});
it('LB029: unsafe budget rows and projection getters are rejected without getter evaluation',()=>{
 let gets=0;const balance:any={work:0,initialization:0,wire:0,attempts:0};Object.defineProperty(balance,'work',{get(){gets++;return 0;}});expect(()=>new Lb0Budget(balance)).toThrow('codec_budget_exceeded');expect(gets).toBe(0);
 const f=lb0Fixture();try{const call=f.issue().call,owner=f.session.owner(),scope=f.session.scope(owner),draft=f.session.begin(call,owner).draft,row=f.session.operationRow(draft,owner);const p={get peer(){gets++;return f.peer;}};expect(()=>f.session.seal(draft,owner,scope,row,p)).toThrow('schema_invalid');expect(gets).toBe(0);}finally{f.close();}
});
it('LB030: actual validator entry counts match recorded checks in both full-verification modes',()=>{
 for(const mode of LB0_MODES){const f=lb0Fixture({mode}),owners=vi.spyOn(signer,'verifyOwnerValue'),channels=vi.spyOn(protocol,'validateChannelFrame'),challenges=vi.spyOn(protocol,'validateChallengeExchange');try{const call=f.issue().call,b=f.bind(call);f.session.nestedChecks(b.bound,b.owner,b.scope);f.session.readCommand(b.bound,b.owner,b.scope);f.session.closeScope(b.scope);f.session.finishCall(call);const s=f.session.stats(call);expect(s.metrics.ownerChecks).toBe(owners.mock.calls.length);expect(s.metrics.channelChecks).toBe(channels.mock.calls.length);expect(s.metrics.challengeChecks).toBe(challenges.mock.calls.length);expect(s.metrics.wireIdentityHashes).toBe(s.metrics.fullChecks);expect(s.metrics.fullChecks).toBeGreaterThan(4);}finally{f.close();owners.mockRestore();channels.mockRestore();challenges.mockRestore();}}
});
it('LB031: false or asynchronous current-gate claims and unknown modes cannot enable the profile',()=>{
 const f=lb0Fixture();try{expect(()=>new CwcLb0Session({...f.sessionOptions,mode:'legacy' as any,budget:new Lb0Budget()})).toThrow('codec_profile_unsupported');}finally{f.close();}
 for(const value of [false,0,Promise.resolve(undefined)]){const f=lb0Fixture();try{const call=f.issue().call,b=f.bind(call);f.hooks.current=()=>value;expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow('schema_invalid');expect(f.session.stats(call).metrics.publications).toBe(0);}finally{f.close();}}
});
it('LB032: repeated cancellation and late finally release each reservation once without refunding spend',async()=>{
 vi.useFakeTimers();const f=lb0Fixture();let resume!:(x:unknown)=>void;
 try{const call=f.issue().call,b=f.bind(call),waiting=new Promise(r=>resume=r),response=f.session.dispatch(call,()=>waiting).catch(e=>e);const spent=f.budget.stats();await vi.advanceTimersByTimeAsync(4500);await response;f.session.cancel(call);f.session.closeScope(b.scope);f.close();f.close();expect(f.budget.stats().occupiedSlots).toBe(1);resume({late:true});await vi.runAllTimersAsync();const s=f.session.stats(call);expect(s.metrics.byteReleases).toBe(1);expect(s.metrics.reclaims).toBe(1);expect(s.budget.heldBytes).toBe(0);expect(s.budget.occupiedSlots).toBe(0);for(const key of ['work','initialization','wire','attempts'] as const)expect(s.budget[key]).toBe(spent[key]);}finally{resume({cleanup:true});await vi.runAllTimersAsync();f.close();vi.useRealTimers();}
});
it('LB007: live permission, delegation, lineage, credentials, source approval and owner are rechecked',()=>{
 for(const fault of ['permission','delegation','lineage','peer','server','approval','owner']){const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call);
  if(fault==='permission')f.setPermissions(f.permissions.filter((p:any)=>p.api!==f.api));
  if(fault==='delegation')f.setPermissions(f.permissions.map((p:any)=>({...p,delegateInstance:'other'})));
  if(fault==='lineage')f.setPermissions(f.permissions.map((p:any)=>({...p,lineage:{...p.lineage,lineageId:'other'}})));
  if(fault==='peer')f.revoke();if(fault==='server')f.revoke(f.server.credentialId);if(fault==='approval')f.approval.revoke();if(fault==='owner')f.stop();
  expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow();expect(f.session.stats(call).metrics.publications).toBe(0);expect(f.session.stats(call).lookupPresent).toBe(false);
 }finally{f.close();}}
});
it('LB008: expiry, noninteger/backward clocks and attempted deadline extension terminate the call',()=>{
 for(const fault of ['expired','negative','fraction','backwards','shortened','extension']){const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call);
  if(fault==='backwards'){f.setNow(10);f.session.check(b.bound,b.owner,b.scope);f.setNow(9);}
  if(fault==='expired')f.setNow(4500);if(fault==='negative')f.setNow(-1);if(fault==='fraction')f.setNow(1.5);
  if(fault==='shortened'){f.setNow(100);f.session.tighten(call,200);f.setNow(201);}
  if(fault==='extension')expect(()=>f.session.tighten(call,5000)).toThrow('request_expired');else expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow();
  expect(f.session.stats(call).lookupPresent).toBe(false);expect(f.session.stats(call).metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LB009: outer signature, inner digest and resigned outer with a bad owner signature all reject',()=>{
 for(const fault of ['outer','digest','owner']){const f=lb0Fixture();try{const p=f.prepare();
  if(fault==='outer'){const x=JSON.parse(p.packet.outer.toString());x.signature='A'.repeat(86)+'==';p.packet.outer=Buffer.from(canonical(x));}
  else{const inner=JSON.parse(p.packet.inner.toString());inner.signature='A'.repeat(86)+'==';p.packet.inner=Buffer.from(canonical(inner));if(fault==='owner'){const body=JSON.parse(p.packet.outer.toString()).body;body.innerWireDigest=sha(p.packet.inner);p.packet.outer=signedServiceFrame(body,'request',f.peer.credentialId);}}
  expect(()=>f.session.receive(p.pending,p.packet)).toThrow();expect(f.session.counts.lookup).toBe(0);expect(f.budget.stats().occupiedSlots).toBe(0);
 }finally{f.close();}}
});
it('LB010: genuine handles cannot move between equal-byte sessions, owners, scopes or rows',()=>{
 const a=lb0Fixture(),b=lb0Fixture();try{const ca=a.issue().call,cb=b.issue().call,ba=a.bind(ca),bb=b.bind(cb);expect(a.inner.equals(b.inner)).toBe(true);expect(()=>b.session.check(ba.bound,ba.owner,ba.scope)).toThrow('source_binding');expect(()=>a.session.begin(cb,a.session.owner())).toThrow('peer_mismatch');expect(()=>a.session.check(ba.bound,bb.owner,bb.scope)).toThrow('source_binding');}finally{a.close();b.close();}
});
it('LB011: begin claims precede callbacks and a swallowed recursive begin cannot publish a Draft',()=>{
 const f=lb0Fixture();try{const {call}=f.issue(),owner=f.session.owner();let reentered=false;f.hooks.current=()=>{f.hooks.current=undefined;try{f.session.begin(call,owner);}catch{reentered=true;}};expect(()=>f.session.begin(call,owner)).toThrow('call_reused');expect(reentered).toBe(true);const s=f.session.stats(call);expect(s.claimHeld).toBe(true);expect(s.bindingState).toBe('closed');expect(s.metrics.publications).toBe(0);expect(s.events.findIndex(x=>x.name==='claim')).toBeLessThan(s.events.findIndex(x=>x.name==='expired-or-refused'));}finally{f.close();}
});
it('LB012: duplicate begin, second seal and failed Draft reuse are terminal',()=>{
 for(const fault of ['begin','seal','draft']){const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call);
  if(fault==='begin')expect(()=>f.session.begin(call,f.session.owner())).toThrow('call_reused');
  if(fault==='seal')expect(()=>f.session.seal(b.draft,b.owner,b.scope,b.row,b.projection)).toThrow('source_binding');
  if(fault==='draft'){f.session.releaseDraft(b.draft,b.owner);expect(()=>f.session.seal(b.draft,b.owner,b.scope,b.row,b.projection)).toThrow('source_binding');}
  expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow();expect(f.session.stats(call).metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LB013: reentry from current, clock, credential, purpose or permissions invalidates outer success',()=>{
 for(const key of ['current','now','credential','purpose','permissions'] as const){const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call);f.hooks[key]=()=>{f.hooks[key]=undefined;try{f.session.check(b.bound,b.owner,b.scope);}catch{}};expect(()=>f.session.check(b.bound,b.owner,b.scope)).toThrow('source_binding');const s=f.session.stats(call);expect(s.bindingState).toBe('closed');expect(s.metrics.publications).toBe(0);expect(s.reclaimed).toBe(true);}finally{f.close();}}
});
it('LB014: private nested frames rerun full checks and a caller frame never supplies authority',()=>{
 const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call),before=f.session.stats(call).metrics;f.session.nestedChecks(b.bound,b.owner,b.scope);const after=f.session.stats(call).metrics;expect(after.fullChecks-before.fullChecks).toBe(4);expect(after.liveChecks-before.liveChecks).toBe(4);expect(after.purposeChecks-before.purposeChecks).toBe(4);expect(after.credentialChecks-before.credentialChecks).toBe(8);expect(()=>(f.session.check as any)(b.bound,b.owner,b.scope,{kind:'frame',authorized:true})).toThrow('source_binding');expect(f.session.stats(call).bindingState).toBe('closed');}finally{f.close();}
});
it('LB015: normal scope closure preserves bytes for the final complete inspection only',()=>{
 const f=lb0Fixture();try{const {call}=f.issue(),b=f.bind(call);f.session.closeScope(b.scope);const before=f.session.stats(call);expect(before.bytesHeld).toBeGreaterThan(0);expect(before.lookupPresent).toBe(true);f.session.finishCall(call);const after=f.session.stats(call);expect(after.metrics.fullChecks).toBe(before.metrics.fullChecks+1);expect(after.metrics.byteReleases).toBe(1);expect(after.bytesHeld).toBe(0);expect(()=>f.session.readCommand(b.bound,b.owner,b.scope)).toThrow();}finally{f.close();}
});
it('LB016: callbacks closing during begin/seal/check cannot produce a ready handle or output',()=>{
 for(const phase of ['begin','seal','check']){const f=lb0Fixture();try{const {call}=f.issue(),owner=f.session.owner(),scope=f.session.scope(owner);
  if(phase==='begin'){f.hooks.current=()=>{f.hooks.current=undefined;f.session.cancel(call);};expect(()=>f.session.begin(call,owner)).toThrow('owner_closed');}
  else{const draft=f.session.begin(call,owner).draft,row=f.session.operationRow(draft,owner);if(phase==='seal'){f.hooks.current=()=>{f.hooks.current=undefined;f.session.closeScope(scope);};expect(()=>f.session.seal(draft,owner,scope,row,{...f.session.identities,api:f.api,purpose:'read',actor:'provider'})).toThrow();}else{const bound=f.session.seal(draft,owner,scope,row,{...f.session.identities,api:f.api,purpose:'read',actor:'provider'});f.hooks.current=()=>{f.hooks.current=undefined;f.session.cancel(call);};expect(()=>f.session.check(bound,owner,scope)).toThrow('owner_closed');}}
  expect(f.session.stats(call).metrics.publications).toBe(0);
 }finally{f.close();}}
});
it('LB002: fake keys, calls, drafts and bound handles fail closed',()=>{
 const f=lb0Fixture();try{const {call}=f.issue();expect(()=>f.session.begin({...call},f.session.owner())).toThrow('peer_mismatch');const b=f.bind(call);expect(()=>f.session.check({...b.bound},b.owner,b.scope)).toThrow('source_binding');expect(()=>f.session.operationRow({...b.draft},b.owner)).toThrow('source_binding');}finally{f.close();}
});
it('LB003: caller buffers, identity and returned command copies cannot mutate private facts',()=>{
 const f=lb0Fixture();try{const p=f.issue(),b=f.bind(p.call);p.packet.inner.fill(0);p.packet.outer.fill(0);f.frames[0]!.fill(0);f.registry.credentials[0].identity.boot='0'.repeat(64);f.peer.boot='0'.repeat(64);const view=f.session.identities;view.peer.keyEpoch=9;const q=f.session.readCommand(b.bound,b.owner,b.scope);q.operationId='changed';expect(f.session.readCommand(b.bound,b.owner,b.scope)).toEqual(f.command);f.session.check(b.bound,b.owner,b.scope);}finally{f.close();}
});

it('LB033: replaced Buffer copy cannot receive a private destination in either mode',()=>{
 for(const mode of LB0_MODES){const cases:any[]=[];
  for(const field of ['inner','outer'] as const){const f=lb0Fixture({mode});let calls=0;const aliases:Buffer[]=[];
   try{const p=f.prepare();p.packet[field].copy=function(target:Uint8Array,...args:any[]){calls++;aliases.push(target as Buffer);return Reflect.apply(Buffer.prototype.copy,this,[target,...args]);};
    const alloc=vi.spyOn(Buffer,'alloc');try{expect(()=>f.session.receive(p.pending,p.packet)).toThrow('schema_invalid');expect(alloc).not.toHaveBeenCalled();}finally{alloc.mockRestore();}
    expect(calls).toBe(0);expect(aliases).toHaveLength(0);const after=f.session.pendingStats(p.pending);expect(after.lookupPresent).toBe(false);expect(after.bytesHeld).toBe(0);expect(after.metrics.publications).toBe(0);expect(f.session.counts.lookup).toBe(0);
    cases.push({field,callbacks:calls,aliases:aliases.length,after});
   }finally{f.close();}
  }
  proofs.push({id:'buffer-copy',mode,cases});
 }
});

it('LB034: shadowed SAB backing metadata is rejected before capture in either mode',()=>{
 for(const mode of LB0_MODES){const cases:any[]=[];
  for(const field of ['inner','outer'] as const)for(const shape of ['value','getter','prototype']){const f=lb0Fixture({mode});let getters=0;
   try{const p=f.prepare(),source=p.packet[field],shared=Buffer.from(new SharedArrayBuffer(source.length));source.copy(shared);
    if(shape==='prototype')Object.setPrototypeOf(shared.buffer,ArrayBuffer.prototype);
    else Object.defineProperty(shared,'buffer',shape==='value'?{value:new ArrayBuffer(source.length)}:{get(){getters++;return new ArrayBuffer(source.length);}});const packet:{inner:Buffer;outer:Buffer}={...p.packet,[field]:shared};
    const alloc=vi.spyOn(Buffer,'alloc');try{expect(()=>f.session.receive(p.pending,packet)).toThrow();expect(alloc).not.toHaveBeenCalled();}finally{alloc.mockRestore();}
    expect(getters).toBe(0);const after=f.session.pendingStats(p.pending);expect(after.lookupPresent).toBe(false);expect(after.bytesHeld).toBe(0);expect(after.metrics.publications).toBe(0);expect(f.session.counts.lookup).toBe(0);
    cases.push({field,shape,getters,after});
   }finally{f.close();}
  }
  proofs.push({id:'shared-buffer',mode,cases});
 }
});

it('LB035: swallowed receive reentry invalidates outer issuance and publication in both modes',()=>{
 for(const mode of LB0_MODES){const cases:any[]=[];
  for(const hook of ['current','now','credential','purpose','permissions'] as const){const f=lb0Fixture({mode});let inner:unknown,outer:unknown,issued:ReturnType<typeof f.session.receive>|undefined;
   try{const p=f.prepare(),before=f.budget.stats();f.hooks[hook]=()=>{f.hooks[hook]=undefined;try{f.session.receive(p.pending,p.packet);}catch(e){inner=e;}};
    try{issued=f.session.receive(p.pending,p.packet);}catch(e){outer=e;}
    expect(inner).toBeInstanceOf(Error);expect(outer).toBe(inner);expect(String(outer)).toContain('source_binding');expect(issued).toBeUndefined();
    const after=f.session.pendingStats(p.pending);expect(after.state).toBe('closed');expect(after.generation).toBe(2);expect(after.lookupPresent).toBe(false);expect(after.bytesHeld).toBe(0);expect(after.metrics.publications).toBe(0);expect(after.events.some(e=>e.name==='call-issued'||e.name==='output')).toBe(false);expect(f.session.counts.lookup).toBe(0);
    expect(()=>f.session.receive(p.pending,p.packet)).toThrow('source_binding');const repeated=f.session.pendingStats(p.pending);expect(repeated).toEqual(after);
    for(const key of ['work','initialization','wire','attempts'] as const)expect(after.budget[key]).toBe(before[key]);
    cases.push({hook,innerReason:'source_binding',outerReason:'source_binding',issued:issued!==undefined,before,after,repeated});
   }finally{f.close();}
  }
  proofs.push({id:'receive-reentry',mode,cases});
 }
});

it('LB036: Buffer length, offset and copy accessors are never evaluated for either mode',()=>{
 for(const mode of LB0_MODES)for(const key of ['length','byteLength','byteOffset','copy']){const f=lb0Fixture({mode});let gets=0;
  try{const p=f.prepare();Object.defineProperty(p.packet.inner,key,{get(){gets++;return key==='copy'?()=>0:1048577;}});
   const alloc=vi.spyOn(Buffer,'alloc');try{expect(()=>f.session.receive(p.pending,p.packet)).toThrow('schema_invalid');expect(alloc).not.toHaveBeenCalled();}finally{alloc.mockRestore();}
   expect(gets).toBe(0);expect(f.session.counts.lookup).toBe(0);expect(f.session.pendingStats(p.pending).metrics.publications).toBe(0);
  }finally{f.close();}
 }
});
