import {writeFileSync} from 'node:fs';
import {runCwcCMatrix} from '../fixtures/gradleOwnedCwcCExperiment.js';
import {it,expect,vi} from 'vitest';
import {cwcCApprovalFixture} from '../fixtures/gradleOwnedCwcCApprovalFixture.js';
import {cwcCCase} from '../fixtures/gradleOwnedCwcCCase.js';
import {cprBPCase} from '../fixtures/gradleOwnedCprBP.js';
import {CwcCApprovalRegistry,CwcCWorkLedger,CwcCReadScope,CwcConnectedGrant,cwcCMemory} from '../fixtures/gradleOwnedCwcC.js';
import {CPR_WORK} from '../fixtures/gradleOwnedCprAAdmission.js';
import * as wire from '../fixtures/gradleOwnedCprAWire.js';
import {ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
it('CWC-C01: approved connected session replaces final planned owner/auth wires with root-bound proof',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,variant:'combined'});
 try{const result=await f.transfer();expect(result.clientPlans).toBe(2);expect(result.providerPlans).toBe(result.requests);expect(f.clientWork).toBe(2*CPR_WORK.plan);expect(f.codecPlans).toHaveLength(2);expect(f.provider.codecPlans).toHaveLength(result.requests);
 for(const p of [...f.codecPlans,...f.provider.codecPlans]){expect(p.stats.finalOwners).toBe(0);expect(p.stats.finalFrames).toBe(0);expect(p.stats.layoutOwners).toBe(2);expect(p.stats.layoutFrames).toBe(4);expect(p.codec.encodes).toBe(0);expect(p.grant.prepaidPlanWork).toBe(CPR_WORK.plan);expect(p.grant.memory.reserved).toBeLessThanOrEqual(1048576);}
 }finally{f.close();}
});
it('CWC-C02: connected and original reference maintain commands, bounds, wire and final contents',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,variant:'combined'}),reference=cprBPCase('B-independent',{variant:'combined'});
 try{const x=await reference.transfer(),y=await f.transfer();expect(y.outputDigest).toBe(x.outputDigest);expect(y.planDigest).toBe(x.planDigest);expect(y.wireBytes).toBe(x.wireBytes);expect(y.requests).toBe(x.requests);}finally{f.close();reference.close();}
});
it('CWC-C03: source tampering and even resigned replacement do not bypass the independently pinned registry',()=>{
 const a=cwcCApprovalFixture(),offered=structuredClone(a.envelope);offered.manifest.sourceClosure['src/test/fixtures/gradleOwnedCwcB.ts']=hash('changed');expect(()=>new CwcCApprovalRegistry(a.resign(offered.manifest),a.registry,a.pin,a.sources,()=>a.pin)).toThrow('codec_profile_unsupported');
});
it('CWC-C04: insufficient shared memory refuses before provider storage IO',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,memory:1});try{await expect(f.transfer()).rejects.toThrow('codec_budget_exceeded');expect(f.provider.metrics.loads).toBe(0);}finally{f.close();}
});
it('CWC-C05: all workloads and both roles preserve exact structural work and one fresh source per RPC',async()=>{
 for(const role of ['reader','authority-broker'] as const)for(const sizes of [[600,800,900,1100,1300],[3061,1250,20810,5057,949,635,2072,6745,881],[41456,1,1,1,1]]){const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,variant:'combined',role,sizes,realClock:true});
 try{const r=await f.transfer();expect(r.clientPlans).toBe(2);expect(r.providerPlans).toBe(r.requests);expect(f.provider.metrics.loads).toBe(r.requests+2);expect(f.provider.rows.every(row=>row.spent.work===(row.spent.work>CPR_WORK.source+1?CPR_WORK.total:CPR_WORK.source+1))).toBe(true);expect([...f.codecPlans,...f.provider.codecPlans].every(p=>p.grant.memory.reserved<=1048576)).toBe(true);}finally{f.close();}}
},15000);
it('CWC-C06: final reference materialization is absent, with a positive reference control',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,variant:'combined'}),spies=[vi.spyOn(wire,'exact'),vi.spyOn(wire,'owner'),vi.spyOn(wire,'layout')];try{const r=await f.transfer();expect(spies[0]!).not.toHaveBeenCalled();expect(spies[1]!.mock.calls.filter(args=>args[3]===undefined)).toHaveLength(0);expect(spies[1]!.mock.calls.filter(args=>args[3]!==undefined)).toHaveLength(r.requests);expect(spies[2]).toHaveBeenCalledTimes(r.requests+2);const ref=cprBPCase('B-independent',{variant:'combined'});try{await ref.transfer();expect(spies[0]!.mock.calls.length).toBeGreaterThan(0);}finally{ref.close();}}finally{spies.forEach(s=>s.mockRestore());f.close();}
});
it('CWC-C07: altered source bytes with unchanged independent pin cannot be approved',()=>{
 const a=cwcCApprovalFixture(),sources={...a.sources,'src/test/fixtures/gradleOwnedCwcB.ts':Buffer.from('replaced')};expect(()=>new CwcCApprovalRegistry(a.envelope,a.registry,a.pin,sources,()=>a.pin)).toThrow('codec_profile_unsupported');
});
it('CWC-C08: deleting a required source and resigning does not admit a partial source closure',()=>{
 const a=cwcCApprovalFixture(),m=structuredClone(a.envelope.manifest);delete m.sourceClosure['src/test/fixtures/gradleOwnedCwcCProvider.ts'];const registry={...a.registry,approvedManifest:hash(m)},pin=hash(registry),sources={...a.sources};delete sources['src/test/fixtures/gradleOwnedCwcCProvider.ts'];expect(()=>new CwcCApprovalRegistry(a.resign(m),registry,pin,sources,()=>pin)).toThrow('codec_profile_unsupported');
});
it('CWC-C09: revoked source approval prevents project source reads',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view});a.revoke();try{await expect(f.transfer()).rejects.toThrow('codec_profile_unsupported');expect(f.provider.metrics.loads).toBe(0);}finally{f.close();}
});
it('CWC-C10: insufficient work rejects before fresh source acquisition',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,work:CPR_WORK.total-1});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.loads).toBe(0);expect(f.provider.metrics.plans).toBe(0);}finally{f.close();}
});
it('CWC-C11: pre-live failure retains prepaid plan work without source or part access',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='pre-before'&&f.provider.metrics.calls>=3)f.cancel();}});try{await expect(f.transfer()).rejects.toThrow();const row=f.provider.rows.at(-1)!;expect(row.spent.work).toBe(CPR_WORK.plan);expect(f.provider.metrics.loads).toBe(2);expect(f.provider.codecPlans).toHaveLength(0);}finally{f.close();}
});
it('CWC-C12: changed requested or unrequested source bytes fail full fresh-source verification',async()=>{
 for(const index of [0,3]){const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='load-before'&&f.provider.metrics.calls>=3){if(index===0)f.source.commits[0]=Buffer.alloc(600,0).toString('base64');else f.source.payloads[index]=Buffer.from('modified').toString('base64');}}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.rows.at(-1)!.spent.work).toBe(CPR_WORK.plan+CPR_WORK.source);expect(f.provider.codecPlans).toHaveLength(0);}finally{f.close();}}
});
it('CWC-C13: memory profile is checked before IO and oversized metadata is not silently accepted',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view});f.source.metadata.baseRef.id='日'.repeat(1024);f.source.metadata.binding.authorityId='日'.repeat(1024);try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.plans).toBe(0);}finally{f.close();}
});
it('CWC-C14: cancellation at every provider boundary prevents a successful data reply',async()=>{
 for(const target of ['admission','pre-after','load-after','plan-before','plan-after','parts-after','post-before','post-after','sign-before','enqueue-before'] as const){const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase===target&&f.provider.metrics.calls>=3)f.revoke();}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.replies).toBe(2);}finally{f.close();}}
},15000);
it('CWC-C15: original deadline reached during planning prevents parts and keeps consumed work',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='plan-before')f.setNow(4500);}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.rows.at(-1)).toMatchObject({state:'retired',spent:{work:CPR_WORK.plan+CPR_WORK.source}});expect(f.provider.codecPlans).toHaveLength(0);}finally{f.close();}
});
it('CWC-C16: pin-only change after post is distinct from credential revocation',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='post-after'&&f.provider.metrics.calls>=3)f.cancel();}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.replies).toBe(3);}finally{f.close();}
});
it('CWC-C17: source-store mutation after capture cannot alter the private snapshot for that RPC',async()=>{
 let changed=false;const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='load-after'&&f.provider.metrics.calls>=3&&!changed){changed=true;f.source.payloads[3]=Buffer.alloc(3000,0).toString('base64');}}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.replies).toBe(3);expect(f.provider.codecPlans).toHaveLength(1);}finally{f.close();}
});
it('CWC-C18: old or foreign snapshot handles cannot cross RPC scopes',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view});let first:any,old:any;const original=CwcCReadScope.prototype.load,spy=vi.spyOn(CwcCReadScope.prototype,'load').mockImplementation(function(this:CwcCReadScope,...args){const cap=original.apply(this,args);if(!first){first=this;old=cap;}else expect(()=>this.summary(old)).toThrow('source_binding');return cap;});try{await f.transfer();expect(()=>first.summary(old)).toThrow('owner_closed');}finally{spy.mockRestore();f.close();}
});
it('CWC-C19: returned inventory ArrayBuffers cannot alter private snapshots or call-binding bytes',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view}),original=CwcCReadScope.prototype.summary;let checked=0;const spy=vi.spyOn(CwcCReadScope.prototype,'summary').mockImplementation(function(this:CwcCReadScope,...args){const value=original.apply(this,args),other=original.apply(this,args);if(other.inventory){new Uint8Array(other.inventory.buffer).fill(0);expect(original.apply(this,args).inventory!.equals(value.inventory!)).toBe(true);checked++;}return value;});try{await f.transfer();expect(checked).toBeGreaterThan(0);}finally{spy.mockRestore();f.close();}
});
it('CWC-C20: forged authenticated calls and grants cannot authorize source acquisition',()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view});try{expect(()=>new CwcCReadScope({registry:a.view,context:f.ctx,gate:()=>{},now:()=>0,deadline:4500,call:{kind:'c3b-authenticated-call'},wire:Buffer.from('{}')})).toThrow();expect(()=>new CwcConnectedGrant(Symbol(),{} as any,'provider')).toThrow('codec_fact_binding_mismatch');expect(f.provider.metrics.loads).toBe(0);}finally{f.close();}
});
it('CWC-C21: rehashed modified contents are rejected by unchanged actual receiver checks',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,mutateResult:(body:any)=>{if(body.schema==='osv-mcp.cgp.range-result.v3'){const p=body.parts[0],b=Buffer.from(p.bytes,'base64');b[0]=b[0]!^1;p.bytes=b.toString('base64');p.sha256=createHashForTest(b);}}});try{await expect(f.transfer()).rejects.toThrow();}finally{f.close();}
});
import {ownedSha256 as createHashForTest} from '../../utils/gradleOwnedJson.js';
it('CWC-C22: scalar control keeps the same output and does not construct connected planning proofs',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('S-scoped',{codeApproval:a.view}),ref=cprBPCase('S-scoped');try{const x=await ref.transfer(),y=await f.transfer();expect(y.outputDigest).toBe(x.outputDigest);expect(y.wireBytes).toBe(x.wireBytes);expect(f.codecPlans).toHaveLength(0);expect(f.provider.codecPlans).toHaveLength(0);expect(f.clientWork).toBe(0);}finally{f.close();ref.close();}
});

it('CWC-C23: recorded matrix derives resources and positive controls from actual signed sessions',async()=>{
 const samples=await runCwcCMatrix();expect(samples).toHaveLength(12);expect(new Set(samples.map(s=>s.workload+':'+s.role)).size).toBe(12);for(const s of samples){expect(s.memoryPeak).toBeLessThanOrEqual(1048576);expect(s.remainingDeadlineMs).toBeGreaterThan(0);expect(s.probes.finalOracleCalls).toBe(0);expect(s.probes.referenceOracleCalls).toBe(s.requests*(s.requests+2));}
 if(process.env.CWC_C_EVIDENCE_PATH)writeFileSync(process.env.CWC_C_EVIDENCE_PATH,JSON.stringify(samples));
},30000);
it('CWC-C24: maximum fixture IDs fit the same shared memory cap without enlarging a reservation',()=>{
 const f=cprFixture({largeIds:true,role:'authority-broker'}),m=cwcCMemory(f.ctx);expect(m.reserved).toBeLessThanOrEqual(1048576);expect(m.reserved).toBe(Math.max(m.client,m.provider));expect(m.work).toBe(CPR_WORK.plan);
});
it('CWC-C25: independent source revocation is latched and old views cannot resume after pin restoration',()=>{
 const a=cwcCApprovalFixture();let pin=a.pin;const view=new CwcCApprovalRegistry(a.envelope,a.registry,a.pin,a.sources,()=>pin);pin=hash('revoked');expect(()=>view.assertCurrent()).toThrow('codec_profile_unsupported');pin=a.pin;expect(()=>view.assertCurrent()).toThrow('codec_profile_unsupported');
});
it('CWC-C26: wrong runtime and malformed public key remain profile refusals even when registry is repinned',()=>{
 const a=cwcCApprovalFixture(),m=structuredClone(a.envelope.manifest);m.runtime.node='v0';const registry={...a.registry,approvedManifest:hash(m)},pin=hash(registry);expect(()=>new CwcCApprovalRegistry(a.resign(m),registry,pin,a.sources,()=>pin)).toThrow('codec_profile_unsupported');const bad={...a.registry,operatorSpki:'AAAA'},badPin=hash(bad);expect(()=>new CwcCApprovalRegistry(a.envelope,bad,badPin,a.sources,()=>badPin)).toThrow('codec_profile_unsupported');
});
it('CWC-C27: an exact retry uses a new call, fresh snapshot and new proof while keeping original row spending',async()=>{
 let dropped=false;const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='enqueue-before'&&f.provider.metrics.calls>=3&&!dropped){dropped=true;f.dropNextReplies(1);}}});try{const r=await f.transfer();expect(r.clientPlans).toBe(2);expect(r.providerPlans).toBe(r.requests+1);expect(f.provider.metrics.loads).toBe(r.requests+3);expect(f.provider.rows.filter(row=>row.attempts===2)).toHaveLength(1);expect(f.provider.rows.find(row=>row.attempts===2)!.spent.work).toBe(2*CPR_WORK.total);expect(f.provider.codecPlans[0].requestDigest).toBe(f.provider.codecPlans[1].requestDigest);expect(f.provider.codecPlans[0].grant.scopeId).not.toBe(f.provider.codecPlans[1].grant.scopeId);expect(f.provider.codecPlans[0].grant.steps.root).toBe(1);expect(f.provider.codecPlans[1].grant.steps.root).toBe(1);}finally{f.close();}
});
it('CWC-C28: a connected grant is scope-bound even for two identical authenticated client inventories',()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view}),scope=new CwcCReadScope({registry:a.view,context:f.ctx,now:()=>0,deadline:4500,gate:()=>{}}),other=new CwcCReadScope({registry:a.view,context:f.ctx,now:()=>0,deadline:4500,gate:()=>{}});
 try{const inv=sourceInventory(f.source);scope.clientSnapshot(f.source.metadata,inv.rows);other.clientSnapshot(f.source.metadata,inv.rows);const units={work:0},ledger=new CwcCWorkLedger(units,CPR_WORK.plan,()=>{});const grant=scope.grant('client-initial',scope.reservePlan('client-initial',ledger));expect(()=>grant.assertScope(other)).toThrow('source_binding');expect(units.work).toBe(CPR_WORK.plan);expect(()=>scope.reservePlan('client-initial',ledger)).toThrow();expect(units.work).toBe(CPR_WORK.plan);}finally{scope.close();other.close();f.close();}
});
it('CWC-C29: existing exact per-operation work budget is sufficient and not silently increased',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,work:CPR_WORK.total});try{const r=await f.transfer();expect(r.requests).toBeGreaterThan(0);expect(f.provider.rows.every(row=>row.spent.work<=CPR_WORK.total)).toBe(true);}finally{f.close();}
});
it('CWC-C30: oversized source bytes are rejected after one fresh read with no successful data reply',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='load-before'&&f.provider.metrics.calls>=3)f.source.payloads[0]=Buffer.alloc(41461).toString('base64');}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.loads).toBe(3);expect(f.provider.metrics.replies).toBe(2);expect(f.provider.rows.at(-1)!.spent.work).toBe(CPR_WORK.plan+CPR_WORK.source);}finally{f.close();}
});
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import {sourceInventory} from '../../utils/gradleOwnedSourceSchema.js';

it('CWC-C31: source approval revoked after proof prevents signed data from being enqueued',async()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view,hook:phase=>{if(phase==='enqueue-before'&&f.provider.metrics.calls>=3)a.revoke();}});try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.replies).toBe(2);expect(f.provider.rows.at(-1)!.spent.work).toBe(CPR_WORK.total);}finally{f.close();}
});
it('CWC-C32: connected codec forbids diagnostic wire encoding and cannot reset the prepaid grant',()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view}),scope=new CwcCReadScope({registry:a.view,context:f.ctx,gate:()=>{},now:()=>0,deadline:4500});try{const inv=sourceInventory(f.source);scope.clientSnapshot(f.source.metadata,inv.rows);const balance={work:0},ledger=new CwcCWorkLedger(balance,CPR_WORK.plan,()=>{}),grant=scope.grant('client-initial',scope.reservePlan('client-initial',ledger)),codec=new ClosedCwcBCodec({context:f.ctx,gate:()=>{},now:()=>0,deadline:4500,budget:{bytes:1048576,fragments:4096,work:CPR_WORK.plan},connected:grant});expect(()=>codec.encode('command.full',{})).toThrow('codec_profile_unsupported');expect(()=>new ClosedCwcBCodec({context:f.ctx,gate:()=>{},now:()=>0,deadline:4500,budget:{bytes:1048576,fragments:4096,work:CPR_WORK.plan},connected:grant})).toThrow('codec_budget_exceeded');}finally{scope.close();f.close();}
});
it('CWC-C33: runtime source registry accepts no structural fake authority',()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view});try{expect(()=>new CwcCReadScope({registry:{assertCurrent:()=>{}} as any,context:f.ctx,gate:()=>{},now:()=>0,deadline:4500})).toThrow('codec_profile_unsupported');expect(f.provider.metrics.loads).toBe(0);}finally{f.close();}
});
import {ClosedCwcBCodec} from '../fixtures/gradleOwnedCwcB.js';

it('CWC-C34: fake or cross-scope tickets cannot assert payment and reset balances invalidate live grants',()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view}),scope=new CwcCReadScope({registry:a.view,context:f.ctx,gate:()=>{},now:()=>0,deadline:4500}),other=new CwcCReadScope({registry:a.view,context:f.ctx,gate:()=>{},now:()=>0,deadline:4500}),balance={work:0},ledger=new CwcCWorkLedger(balance,CPR_WORK.plan,()=>{});
 try{const inv=sourceInventory(f.source);scope.clientSnapshot(f.source.metadata,inv.rows);other.clientSnapshot(f.source.metadata,inv.rows);expect(()=>scope.grant('client-initial',{kind:'cwc-c-prepaid-plan'})).toThrow();const ticket=scope.reservePlan('client-initial',ledger);expect(balance.work).toBe(CPR_WORK.plan);expect(()=>other.grant('client-initial',ticket)).toThrow();const grant=scope.grant('client-initial',ticket);balance.work=0;expect(()=>grant.gate()).toThrow('codec_budget_exceeded');expect(()=>scope.grant('client-initial',ticket)).toThrow();}finally{scope.close();other.close();f.close();}
});

it('CWC-C35: grant rejects replacement source approval even with a matching replacement pin',()=>{
 const a=cwcCApprovalFixture(),f=cwcCCase('B-independent',{codeApproval:a.view}),scope=new CwcCReadScope({registry:a.view,context:f.ctx,gate:()=>{},now:()=>0,deadline:4500});
 try{const inv=sourceInventory(f.source);scope.clientSnapshot(f.source.metadata,inv.rows);const ledger=new CwcCWorkLedger({work:0},CPR_WORK.plan,()=>{}),grant=scope.grant('client-initial',scope.reservePlan('client-initial',ledger)),approved=scope.approval('client-initial'),fake=structuredClone(approved.approval);fake.sourceClosureDigest=hash('unapproved source');
 const codec=new ClosedCwcBCodec({context:f.ctx,gate:()=>{},now:()=>0,deadline:4500,budget:{bytes:1048576,fragments:4096,work:CPR_WORK.plan},connected:grant});
 try{expect(()=>new CwcAContract({context:f.ctx,approval:fake,approvalPin:hash(fake),actor:'client-initial',now:()=>0,current:()=>({context:f.ctx,approvalPin:hash(fake)}),parentReservation:{bytes:1048576,fragments:4096,work:CPR_WORK.plan},connected:grant,codec})).toThrow('codec_profile_unsupported');}finally{codec.close();}
 }finally{scope.close();f.close();}
});
it('CWC-C36: resigned source with an unlisted side-effect import fails source closure validation',()=>{
 const a=cwcCApprovalFixture(),sources={...a.sources},path='src/test/fixtures/gradleOwnedCwcB.ts';sources[path]=Buffer.concat([Buffer.from("im"+"port './not-pinned.js';\n"),sources[path]!]);const m=structuredClone(a.envelope.manifest);m.sourceClosure[path]=sha(sources[path]!);const registry={...a.registry,approvedManifest:hash(m)},pin=hash(registry);expect(()=>new CwcCApprovalRegistry(a.resign(m),registry,pin,sources,()=>pin)).toThrow('codec_profile_unsupported');
});

import {CwcAContract} from '../fixtures/gradleOwnedCwcA.js';
