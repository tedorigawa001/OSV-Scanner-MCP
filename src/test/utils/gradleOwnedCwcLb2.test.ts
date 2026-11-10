import {it,expect,afterAll,vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {cwcLb2Case} from '../fixtures/gradleOwnedCwcLb2Case.js';
import {lb2ApprovalFixture} from '../fixtures/gradleOwnedCwcLb2Approval.js';
import {cwcCApprovalFixture} from '../fixtures/gradleOwnedCwcCApprovalFixture.js';
import {LB0_MODES} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {verifiedServiceOutcome,inspectAuthenticatedCall} from '../fixtures/gradleOwnedCprBSession.js';
import * as session from '../fixtures/gradleOwnedCprBSession.js';
import * as protocol from '../fixtures/gradleOwnedCprBProtocol.js';
import {sourceInventory,encodeSourceBundle,parseSourceBundle} from '../../utils/gradleOwnedSourceSchema.js';
import {sourceOwnerFixture} from '../fixtures/gradleOwnedSourceFixture.js';
import {verifyOwnerValue} from '../fixtures/gradleOwnedCprBSigner.js';
import {ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {authorityOwnerFixture} from '../fixtures/gradleOwnedAuthorityOwnerFixture.js';
const capture=(id:string,mode:string,f:ReturnType<typeof setup>,extra:any={})=>proofs.push({id,mode,calls:f.link.diagnostics,server:f.server.diagnostics,client:f.client.diagnostics,provider:{...f.provider.metrics},clientRows:f.clientRows,...extra});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const samples:any[]=[],proofs:any[]=[];
// LB202/213/214 transfer every batch of H0/large workloads or drive the authority/source owners through real sessions.
// They take 10-65 s alone and exceeded their timeouts under a parallel full run, so the default npm test skips them.
// The evidence runner (CWC_LB2_EVIDENCE_PATH) always runs them; OSV_CWC_HEAVY=1 runs them locally.
const heavy=it.runIf(process.env.CWC_LB2_EVIDENCE_PATH!==undefined||process.env.OSV_CWC_HEAVY==='1');
afterAll(()=>{if(process.env.CWC_LB2_EVIDENCE_PATH)writeFileSync(process.env.CWC_LB2_EVIDENCE_PATH,JSON.stringify({schema:'cwc-lb2.samples.v1',samples,proofs}));});
const setup=(bindingMode:typeof LB0_MODES[number],extra:Partial<Parameters<typeof cwcLb2Case>[1]>={})=>cwcLb2Case('B-independent',{bindingMode,approval:lb2ApprovalFixture().view,codeApproval:cwcCApprovalFixture().view,variant:'combined',planEvents:false,...extra});
it('LB201: all batches traverse the actual SessionServer and reconstruct every entry before binding reclamation',async()=>{
 for(const mode of LB0_MODES){const f=setup(mode);try{const result=await f.transfer();expect(result.requests).toBeGreaterThan(1);expect(f.server.diagnostics.dispatches).toBe(result.requests+2);expect(f.link.unfinished).toBe(0);for(const r of f.link.diagnostics){expect(r.finalChecks).toBe(1);expect(r.bytesAtFinal).toBeGreaterThan(0);expect(r.control.bytesHeld).toBe(0);expect(r.control.metrics.publications).toBe(1);expect(r.events.indexOf('transport-final')).toBeLessThan(r.events.indexOf('binding-settled'));expect(r.budget.heldBytes).toBe(0);}samples.push({mode,role:'reader',workload:'default',approval:f.link.approvalRecord,inventory:sourceInventory(f.reconstructed!),metadata:f.reconstructed!.metadata,plans:structuredClone(f.provider.codecPlans),result,calls:f.link.diagnostics,server:f.server.diagnostics,client:f.client.diagnostics});}finally{f.close();}}
},15000);

heavy('LB202: broker, H0 and large-entry transfers retain all entry reconstruction and per-batch fresh roots',async()=>{
 for(const mode of LB0_MODES)for(const [workload,sizes]of Object.entries({h0:[3061,1250,20810,5057,949,635,2072,6745,881],large:[41456,1,1,1,1]})){
  const f=setup(mode,{role:'authority-broker',sizes});try{const result=await f.transfer();expect(f.provider.metrics.loads).toBe(result.requests+2);expect(f.provider.codecPlans).toHaveLength(result.requests);expect(new Set(f.provider.codecPlans.map(p=>p.grant.scopeId)).size).toBe(result.requests);expect(f.link.diagnostics.every(r=>r.control.bytesHeld===0&&r.budget.heldBytes===0)).toBe(true);samples.push({mode,workload,role:'authority-broker',approval:f.link.approvalRecord,inventory:sourceInventory(f.reconstructed!),metadata:f.reconstructed!.metadata,plans:structuredClone(f.provider.codecPlans),result,calls:f.link.diagnostics,server:f.server.diagnostics,client:f.client.diagnostics});}finally{f.close();}
 }
},300000);

it('LB203: loss after a signed successful reply retries with new channel/call/root and retained operation spending',async()=>{
 for(const mode of LB0_MODES){const f=setup(mode);try{const qs=await f.commands(),before=f.link.diagnostics.length;f.dropNextReplies(1);await f.run(qs[0]!);const rows=f.provider.rows.filter(r=>r.attempts===2);expect(rows).toHaveLength(1);expect(rows[0]!.deadline).toBe(4500);expect(rows[0]!.spent.work).toBe(2*222515);expect(f.client.diagnostics.recoveries).toBe(1);const calls=f.link.diagnostics.slice(before);expect(calls).toHaveLength(2);expect(calls.every(c=>c.control.metrics.publications===1&&c.budget.heldBytes===0)).toBe(true);expect(calls[1]!.budget.attempts).toBe(2);const [first,retry]=calls.map(c=>c.accounting);expect(first!.before).toEqual({initialization:0,work:0,wire:0,attempts:0});expect(first!.after).toEqual(retry!.before);expect(first!.captured.initialization).toBe(12288);expect(first!.after!.initialization).toBe(16384);expect(retry!.after).toEqual({initialization:32768,work:first!.input.inner+retry!.input.inner,wire:first!.input.inner+first!.input.outer+retry!.input.inner+retry!.input.outer,attempts:2});expect(retry!.after).toEqual({initialization:retry!.reservations!.at(-1)!.after.initialization,work:retry!.reservations!.at(-1)!.after.work,wire:retry!.reservations!.at(-1)!.after.wire,attempts:retry!.reservations!.at(-1)!.after.attempts});capture('response-lost',mode,f);}finally{f.close();}}
});

it('LB204: actual SessionServer final validation and actual client channel validation remain active',async()=>{
 for(const mode of LB0_MODES){const f=setup(mode),inspect=vi.spyOn(session,'inspectAuthenticatedCall'),channel=vi.spyOn(protocol,'validateChannelFrame');try{await f.transfer();expect(inspect.mock.calls.length).toBeGreaterThan(f.link.diagnostics.length*2);const replies=channel.mock.calls.filter(c=>(c[3] as any).direction==='reply');expect(replies).toHaveLength(2*f.link.diagnostics.length);capture('transport-validators',mode,f,{inspections:inspect.mock.calls.length,replyChecks:replies.length});}finally{inspect.mockRestore();channel.mockRestore();f.close();}}
});

it('LB205: source corruption remains a signed refused service outcome, not success or a binding-derived effect decision',async()=>{
 for(const mode of LB0_MODES){const f=setup(mode);try{const qs=await f.commands();f.source.payloads[3]=Buffer.from('corrupt').toString('base64');const e=await f.run(qs[0]!).catch(e=>e);expect(verifiedServiceOutcome(e)).toMatchObject({outcome:'refused',reason:'source_integrity'});expect(f.link.diagnostics.at(-1)!.control.metrics.publications).toBe(0);capture('signed-refused',mode,f,{outcome:verifiedServiceOutcome(e)});}finally{f.close();}}
});

it('LB206: an explicit possible-effect failure stays authenticated unknown and cannot be retried into success',async()=>{
 for(const mode of LB0_MODES){const f=setup(mode,{providerFault:'unknown'});try{const e=await f.commands().catch(e=>e);expect(verifiedServiceOutcome(e)).toMatchObject({outcome:'unknown',reason:'response_lost'});expect(f.link.diagnostics[0]!.control.metrics.publications).toBe(0);capture('signed-unknown',mode,f,{outcome:verifiedServiceOutcome(e)});}finally{f.close();}}
});

it('LB207: cancellation while provider work is pending reclaims private bytes before that work drains and rejects its late result',async()=>{
 for(const mode of LB0_MODES){const blocked=deferred(),reached=deferred(),f=setup(mode);try{const qs=await f.commands();f.setHook(phase=>{if(phase==='load-before'){reached.resolve();return blocked.promise;}});const response=f.run(qs[0]!).catch(e=>e);await reached.promise;f.cancel();const expired=f.link.diagnostics.at(-1)!;expect(expired.control.bytesHeld).toBe(0);expect(expired.control.lookupPresent).toBe(false);expect(expired.control.pendingDispatch).toBe(true);expect(expired.control.budget.occupiedSlots).toBe(1);blocked.resolve();await response;await f.link.settle();const last=f.link.diagnostics.at(-1)!;expect(last.control.pendingDispatch).toBe(false);expect(last.control.metrics.late).toBe(1);expect(last.control.metrics.publications).toBe(0);expect(last.budget.heldBytes).toBe(0);capture('cancel-pending',mode,f,{expired});}finally{blocked.resolve();f.close();}}
});

it('LB208: endpoint close during pending work never restores a binding or publishes a late reply',async()=>{
 for(const mode of LB0_MODES){const blocked=deferred(),reached=deferred(),f=setup(mode);try{const qs=await f.commands();f.setHook(phase=>{if(phase==='load-before'){reached.resolve();return blocked.promise;}});const response=f.run(qs[0]!).catch(e=>e);await reached.promise;f.close();expect(f.link.diagnostics.at(-1)!.control.bytesHeld).toBe(0);blocked.resolve();await response;await f.link.settle();expect(f.link.diagnostics.at(-1)!.control.metrics.publications).toBe(0);expect(f.link.diagnostics.at(-1)!.control.metrics.late).toBe(1);capture('close-pending',mode,f);}finally{blocked.resolve();f.close();}}
});

it('LB209: the original deadline expires pending work without waiting for the producer or accepting its late continuation',async()=>{
 for(const mode of LB0_MODES){vi.useFakeTimers();const blocked=deferred(),reached=deferred(),f=setup(mode);try{const qs=await f.commands();f.setHook(phase=>{if(phase==='load-before'){reached.resolve();return blocked.promise;}});const response=f.run(qs[0]!).catch(e=>e);await reached.promise;f.setNow(4500);await vi.advanceTimersByTimeAsync(4500);expect(String(await response)).toContain('request_expired');const expired=f.link.diagnostics.at(-1)!;expect(expired.control.bytesHeld).toBe(0);expect(expired.control.pendingDispatch).toBe(true);expect(expired.control.lookupPresent).toBe(false);blocked.resolve();await vi.runAllTimersAsync();await f.link.settle();expect(f.link.diagnostics.at(-1)!.control.metrics.publications).toBe(0);expect(f.link.diagnostics.at(-1)!.budget.heldBytes).toBe(0);capture('deadline-pending',mode,f,{expired});}finally{blocked.resolve();f.close();vi.useRealTimers();}}
});

it('LB210: transport finalization keeps private bytes until validation and rejects deadline/cancel after provider return',async()=>{
 for(const mode of LB0_MODES)for(const fault of ['deadline','cancel'] as const){let enabled=false;const f=setup(mode,{afterTransport:()=>{if(enabled){if(fault==='deadline')f.setNow(4500);else f.cancel();}}});try{const qs=await f.commands(),priorCalls=f.link.diagnostics.length;enabled=true;await expect(f.run(qs[0]!)).rejects.toThrow();await f.link.settle();const last=f.link.diagnostics[priorCalls]!;expect(f.link.diagnostics.slice(priorCalls).every(c=>c.control.metrics.publications===0)).toBe(true);expect(last.bytesAtFinal).toBeGreaterThan(0);expect(last.control.bytesHeld).toBe(0);expect(last.control.metrics.publications).toBe(0);capture('transport-'+fault,mode,f,{priorCalls,targetCallId:last.id});}finally{f.close();}}
});

it('LB211: a provider owner signature modified before real transport final verification cannot produce a success response',async()=>{
 for(const mode of LB0_MODES){let enabled=false;const f=setup(mode,{mutatePacket:p=>p});try{const qs=await f.commands(),before=f.link.diagnostics.length;const execute=f.provider.execute.bind(f.provider),spy=vi.spyOn(f.provider,'execute').mockImplementation(async(...args)=>{const bytes=await execute(...args);if(enabled)bytes[bytes.length-4]=bytes[bytes.length-4]!^1;return bytes;});enabled=true;try{await expect(f.run(qs[0]!)).rejects.toThrow();await f.link.settle();expect(f.link.diagnostics.length).toBeGreaterThan(before);expect(f.link.diagnostics.slice(before).every(r=>r.finalChecks===0&&r.control.metrics.publications===0&&r.control.bytesHeld===0)).toBe(true);capture('invalid-owner-reply',mode,f);}finally{spy.mockRestore();}}finally{f.close();}}
});

it('LB212: changed reply content remains rejected by reconstruction even with a valid owner signature',async()=>{
 for(const mode of LB0_MODES){let enabled=false;const f=setup(mode,{mutateResult:body=>{if(enabled&&body.parts)body.parts[0].sha256=sha('wrong');}});try{const qs=await f.commands();enabled=true;await expect(f.run(qs[0]!)).rejects.toThrow();capture('invalid-content',mode,f);}finally{f.close();}}
});

heavy('LB213: a reconstructed bound source feeds the real authority, durable provider use, result delivery and exact ACK path',async()=>{
 for(const mode of LB0_MODES){const f=await authorityOwnerFixture(),links:ReturnType<typeof setup>[]=[];try{const p=await f.selected();let transferResult:any;
  f.hooks.source=async(bundle:any)=>{const link=setup(mode,{role:'authority-broker',ownedSource:{bundle,registry:f.r.f.registry,pins:f.r.f.pins(),binding:p.binding,lineage:f.f.lineage,snapshot:p.candidate.snapshot,checkpoint:p.prepared.checkpoint,pin:p.pin}});links.push(link);transferResult=await link.transfer('authority-bound');expect(link.reconstructed).toEqual(bundle);return link.reconstructed;};
  const prepared=await f.call('aux.PrepareAuthorityResult',p.payload,'reader',p.binding),complete=await f.call('aux.CompleteAuthorityResult',{pin:p.pin,gate:prepared.body.result.gate,result:prepared.body.result.result,witness:p.payload.witness,useId:p.payload.useId},'reader',p.binding),d=complete.body.result;
  const parts:Buffer[]=[];for(let offset=0;offset<d.result.byteLength;){const n=Math.min(4096,d.result.byteLength-offset),chunk=(await f.call('aux.ReadAuthorityResult',{pin:p.pin,delivery:d.delivery,useId:p.payload.useId,result:d.result,receipt:d.receipt,transferId:'clb2-result',offset,maxBytes:n},'reader',p.binding)).body.result,b=Buffer.from(chunk.bytes,'base64');expect(sha(b)).toBe(chunk.sha256);parts.push(b);offset+=b.length;}
  const receiptWire=await f.f.provider.readUse(d.receipt),use:any=verifyOwnerValue(receiptWire,f.r.f.registry,{role:'provider',instanceId:'provider',direction:'reply',domain:'aux',api:'aux.RecordUse'}).body;expect(sha(receiptWire)).toBe(d.receipt.sha256);expect(use.delivery).toEqual(d.delivery);expect(use.result).toEqual(d.result);
  const result=Buffer.concat(parts);expect(sha(result)).toBe(d.result.sha256);expect(JSON.parse(result.toString())).toEqual(p.facts.document);
  await expect(f.r.call('control.AcknowledgeDelivery',{pin:p.pin,delivery:d.delivery,useId:p.payload.useId,result:d.result,receipt:{...d.receipt,sha256:sha('forged')},resultDigest:sha(result),effect:null},'reader',p.binding)).rejects.toThrow();
  const ack=await f.r.call('control.AcknowledgeDelivery',{pin:p.pin,delivery:d.delivery,useId:p.payload.useId,result:d.result,receipt:d.receipt,resultDigest:sha(result),effect:null},'reader',p.binding);expect(ack.body.result.phase).toBe('released');await f.call('aux.FinishAuthorityResult',{pin:p.pin,delivery:d.delivery,useId:p.payload.useId,result:d.result,receipt:d.receipt},'reader',p.binding);expect(f.authority.diagnostics.unresolved).toBe(0);
  proofs.push({id:'use-ack',mode,transferResult,calls:links[0]!.link.diagnostics,receipt:d.receipt,resultDigest:sha(result),expectedDigest:d.result.sha256,ack:ack.body.result.phase,unresolved:f.authority.diagnostics.unresolved,forgedAckRejected:true,useReceiptDigest:sha(receiptWire),useResultDigest:use.result.sha256});
 }finally{for(const l of links)l.close();await f.cleanup();}}
},300000);

heavy('LB214: an adopted advanced snapshot retains every commit and payload through all batches',async()=>{
 for(const mode of LB0_MODES){const owner=await sourceOwnerFixture();let f:ReturnType<typeof setup>|undefined;try{
  await owner.genesis();const advanced=await owner.advance(),pin=(await owner.f.call('control.AcquireReadPin',{operationBinding:sha('operation')},'reader')).body.result.pin,binding=(await owner.f.call('aux.ReadContext',{purpose:'read',floor:null})).body.result.binding,bundle=parseSourceBundle(encodeSourceBundle(advanced.input));expect(bundle.commits).toHaveLength(2);
  f=setup(mode,{ownedSource:{bundle,registry:owner.f.f.registry,pins:owner.f.f.pins(),binding,lineage:owner.lineage,snapshot:advanced.candidate.snapshot,checkpoint:advanced.prepared.checkpoint,pin}});
  expect(f.source).toEqual(bundle);const result=await f.transfer('advanced');expect(f.reconstructed).toEqual(bundle);expect(result.requests).toBeGreaterThan(1);expect(f.provider.metrics.loads).toBe(result.requests+2);expect(f.link.diagnostics.every(c=>c.control.metrics.publications===1&&c.control.bytesHeld===0&&c.budget.heldBytes===0)).toBe(true);
  proofs.push({id:'advanced-snapshot',mode,calls:f.link.diagnostics,result,inventory:sourceInventory(f.reconstructed!),metadata:bundle.metadata,expected:{commits:bundle.commits.map(t=>sha(Buffer.from(t,'base64'))),payloads:bundle.payloads.map(t=>sha(Buffer.from(t,'base64')))},reconstructed:{commits:f.reconstructed!.commits.map(t=>sha(Buffer.from(t,'base64'))),payloads:f.reconstructed!.payloads.map(t=>sha(Buffer.from(t,'base64')))},adopted:binding.selected,checkpoint:advanced.prepared.checkpoint});
 }finally{f?.close();await owner.cleanup();}}
},180000);
