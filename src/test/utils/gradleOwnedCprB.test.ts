import {it,expect} from 'vitest';
import {cprBCase} from '../fixtures/gradleOwnedCprB.js';
for(const role of ['reader','authority-broker'] as const)for(const mode of ['S-scoped','B-independent'] as const)it('transfers on real signed sessions '+mode+' '+role,async()=>{
 const f=cprBCase(mode,{role});try{const r=await f.transfer();expect(r.requests).toBeGreaterThan(0);expect(r.clientPlans).toBe(mode==='B-independent'?2:0);expect(r.providerPlans).toBe(mode==='B-independent'?r.requests:0);expect(f.provider.metrics.loads).toBe(r.requests+2);expect(f.provider.metrics.pre).toBe(r.requests+2);expect(f.provider.metrics.post).toBe(r.requests+2);expect(f.clientRows.every(x=>x.state==='complete')).toBe(true);expect(f.frames.every(x=>x.frame<=16384&&x.inner<=8192)).toBe(true);}finally{f.close();}
});

import {CPR_B_PHASES} from '../fixtures/gradleOwnedCprBProvider.js';
import {wireIntent} from '../fixtures/gradleOwnedCprASchema.js';
import {inspectAuthenticatedCall} from '../fixtures/gradleOwnedCprBSession.js';
for(const mode of ['S-scoped','B-independent'] as const)for(const phase of CPR_B_PHASES.filter(p=>mode==='B-independent'||!p.startsWith('plan-')))for(const fault of ['deadline','revoke','cancel'])it('retains '+fault+' at '+mode+' '+phase,async()=>{
 const f=cprBCase(mode);try{const q=(await f.commands())[0]!,before={...f.provider.metrics};
 f.setHook(p=>{if(p===phase){if(fault==='deadline')f.setNow(4500);else if(fault==='revoke')f.revoke();else f.changePolicy();}});
 await expect(f.run(q)).rejects.toThrow();expect(f.provider.metrics.replies).toBe(before.replies);
 if(['admission','pre-before','pre-after','load-before'].includes(phase))expect(f.provider.metrics.loads).toBe(before.loads);
 expect(f.clientRows.at(-1)!.deadline).toBe(f.parentDeadline);
 }finally{f.close();}
});
it('separates client approval from provider independent plan verification',async()=>{
 const f=cprBCase('B-independent');try{const q:any=structuredClone((await f.commands())[0]!);q.payload.plan.planDigest='1'.repeat(64);q.requestDigest=wireIntent(q);
 const before=f.provider.metrics.loads;await expect(f.run(q)).rejects.toThrow('client_plan_unapproved');expect(f.provider.metrics.loads).toBe(before);
 await expect(f.sendUnapprovedForTest(q)).rejects.toThrow('plan_mismatch');expect(f.provider.metrics.plans).toBe(1);expect(f.provider.rows.at(-1)!.state).toBe('refused');expect(f.provider.rows.at(-1)!.spent.work).toBe(222514);
 const row=f.provider.rows.at(-1)!;await expect(f.sendUnapprovedForTest(q)).rejects.toThrow('plan_mismatch');expect(f.provider.rows.at(-1)).toMatchObject({k:row.k,d:row.d,deadline:row.deadline,attempts:2,spent:{work:445028}});
 await expect(f.sendUnapprovedForTest(q)).rejects.toThrow('operation_budget');expect(f.provider.metrics.plans).toBe(2);
 }finally{f.close();}
});
it('gets inventory only through two signed RPCs and rejects changed mock store bytes',async()=>{
 const f=cprBCase('B-independent');try{const qs=await f.commands();expect(f.provider.metrics.loads).toBe(2);expect(f.provider.metrics.plans).toBe(0);
 f.source.payloads[3]=Buffer.alloc(3000,0).toString('base64');await expect(f.run(qs[0]!)).rejects.toThrow('source_integrity');expect(f.provider.metrics.plans).toBe(0);expect(f.provider.metrics.replies).toBe(2);
 }finally{f.close();}
});
it('keeps the original deadline and counts fresh loads when a reply is lost and retried',async()=>{
 const f=cprBCase('B-independent',{dropReplyOnce:true});try{const r=await f.transfer();expect(f.client.diagnostics.recoveries).toBe(1);expect(f.provider.metrics.loads).toBe(r.requests+3);expect(f.provider.rows[0]).toMatchObject({attempts:2,deadline:f.parentDeadline});expect(f.clientRows[0]).toMatchObject({attempts:2,deadline:f.parentDeadline});}finally{f.close();}
});
it('rejects work shortage before the first mock source read',async()=>{
 const f=cprBCase('B-independent',{work:222514});try{await expect(f.transfer()).rejects.toThrow('operation_budget');expect(f.provider.metrics.loads).toBe(0);expect(f.provider.metrics.plans).toBe(0);}finally{f.close();}
});
it('rejects wire shortage before any signed packet is sent',async()=>{
 const f=cprBCase('B-independent',{wireBudget:1});try{await expect(f.transfer()).rejects.toThrow('wire_budget');expect(f.frames).toHaveLength(0);expect(f.provider.metrics.loads).toBe(0);}finally{f.close();}
});
it('checks credential API permission before loading source',async()=>{
 const f=cprBCase('B-independent',{denyPermission:true});try{const qs=await f.commands();const before=f.provider.metrics.loads;await expect(f.run(qs[0]!)).rejects.toThrow('permission_denied');expect(f.provider.metrics.loads).toBe(before);}finally{f.close();}
});
it('requires a real call brand and the exact wire',()=>{
 expect(()=>inspectAuthenticatedCall({kind:'c3b-authenticated-call'},Buffer.from('{}'))).toThrow('peer_mismatch');
});
it('refuses a resigned source/pin mutation before provider IO',async()=>{
 const f=cprBCase('B-independent');try{const q:any=structuredClone((await f.commands())[0]!);q.payload.pin.id='0'.repeat(64);q.requestDigest=wireIntent(q);const before=f.provider.metrics.loads;
 await expect(f.sendUnapprovedForTest(q)).rejects.toThrow('binding_mismatch');expect(f.provider.metrics.loads).toBe(before);}finally{f.close();}
});

for(const mode of ['S-scoped','B-independent'] as const)it('keeps post-live observations nonlive after a later pin change '+mode,async()=>{
 const f=cprBCase(mode);try{const q=(await f.commands())[0]!;f.setHook(p=>{if(p==='post-after')f.cancel();});expect((await f.run(q)).live).toBe(false);}finally{f.close();}
});
it('replans from a fresh snapshot on the exact batch retry after reply loss',async()=>{
 const f=cprBCase('B-independent');try{const q=(await f.commands())[0]!,before=f.provider.metrics.loads;f.dropNextReplies(1);await f.run(q);
 expect(f.provider.metrics.plans).toBe(2);expect(f.provider.metrics.loads).toBe(before+2);expect(f.provider.rows.at(-1)).toMatchObject({attempts:2,deadline:f.parentDeadline,spent:{work:445030}});
 expect(f.provider.plans[0]!.planDigest).toBe(f.provider.plans[1]!.planDigest);expect(f.clientRows.at(-1)!.attempts).toBe(2);
 }finally{f.close();}
});
it('keeps an unresolved reply loss unknown without resetting attempts or wire',async()=>{
 const f=cprBCase('B-independent');try{const q=(await f.commands())[0]!;f.dropNextReplies(2);await expect(f.run(q)).rejects.toThrow('response_lost');const rows=f.clientRows,metrics={...f.provider.metrics};
 await expect(f.run(q)).rejects.toThrow('operation_busy');expect(f.clientRows).toEqual(rows);expect(f.provider.metrics).toEqual(metrics);expect(f.provider.metrics.plans).toBe(2);
 }finally{f.close();}
});
it('rejects an oversized inner before dispatch',async()=>{
 const f=cprBCase('B-independent',{mutatePacket:p=>p.inner?{...p,inner:Buffer.alloc(8193)}:p});try{await expect(f.transfer()).rejects.toThrow('wire_budget');expect(f.provider.metrics.loads).toBe(0);}finally{f.close();}
});
it('rejects signed but incorrect part bytes at the client',async()=>{
 const f=cprBCase('B-independent',{mutateResult:b=>{if(b.parts)b.parts[0].bytes='AAAA';}});try{await expect(f.transfer()).rejects.toThrow('binding_mismatch');expect(f.provider.metrics.plans).toBe(1);expect(f.clientRows.at(-1)!.state).toBe('unknown');}finally{f.close();}
});
it('rejects a replayed authenticated channel before a second batch dispatch',async()=>{
 let first:any;const f=cprBCase('B-independent',{mutatePacket:p=>{const m=JSON.parse(p.wire.toString()).body;if(p.inner&&m.api==='aux.ReadSourceRanges'){if(!first)first={wire:Buffer.from(p.wire),inner:Buffer.from(p.inner)};else return first;}return p;}});
 try{await expect(f.transfer()).rejects.toThrow();expect(f.provider.metrics.plans).toBe(1);}finally{f.close();}
});
it('rejects forged provider calls without poisoning later legitimate admission',async()=>{
 const f=cprBCase('B-independent');try{await expect(f.provider.execute(Buffer.from('{}'),{kind:'c3b-authenticated-call'})).rejects.toThrow('peer_mismatch');await f.transfer();}finally{f.close();}
});

it('keeps provider verification and wire limits in the quiet observation bridge',async()=>{
 const f=cprBCase('B-independent',{planEvents:false});try{const r=await f.transfer();expect(r.providerPlans).toBe(r.requests);expect(f.provider.plans).toHaveLength(0);expect(f.provider.metrics.loads).toBe(r.requests+2);expect(f.provider.rows.slice(2).every(r=>r.spent.work===222515)).toBe(true);}finally{f.close();}
});

for(const work of [NaN,-1,67108865])it('rejects invalid work configuration '+work,()=>expect(()=>cprBCase('B-independent',{work})).toThrow('configuration_invalid'));
for(const wireBudget of [NaN,-1,67108865])it('rejects invalid wire configuration '+wireBudget,()=>expect(()=>cprBCase('B-independent',{wireBudget})).toThrow('configuration_invalid'));

it('uses a private loaded snapshot and revalidates the next RPC',async()=>{
 const f=cprBCase('B-independent');try{const qs=await f.commands();f.setHook(p=>{if(p==='load-after')f.source.commits[0]=Buffer.alloc(600,0).toString('base64');});await f.run(qs[0]!);
 await expect(f.run(qs[1]!)).rejects.toThrow('source_integrity');expect(f.provider.metrics.plans).toBe(1);
 }finally{f.close();}
});
it('retains K and rejects a changed D before another source read',async()=>{
 const f=cprBCase('B-independent');try{const q:any=structuredClone((await f.commands())[0]!);await f.run(q);const rows=f.clientRows,loads=f.provider.metrics.loads;
 q.payload.plan.planDigest='1'.repeat(64);q.requestDigest=wireIntent(q);await expect(f.sendUnapprovedForTest(q)).rejects.toThrow('intent_conflict');expect(f.clientRows).toEqual(rows);expect(f.provider.metrics.loads).toBe(loads);
 }finally{f.close();}
});
it('checks the original deadline after a held async boundary and starts no new load',async()=>{
 const f=cprBCase('B-independent');let release!:()=>void,entered!:()=>void;
 const wait=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 try{const q=(await f.commands())[0]!,loads=f.provider.metrics.loads;f.setHook(async p=>{if(p==='load-before'){entered();await wait;}});
 const pending=f.run(q);await ready;f.setNow(4500);release();await expect(pending).rejects.toThrow('request_expired');expect(f.provider.metrics.loads).toBe(loads);
 }finally{release?.();f.close();}
});
