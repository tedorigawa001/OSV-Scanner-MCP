import {it,expect,vi,afterAll} from 'vitest';
import {R0Tokens} from '../fixtures/gradleOwnedCwcR0Tokens.js';
import {R0_COMMAND} from '../fixtures/gradleOwnedCwcR0Grammar.js';
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import {canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
import {ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import {R0Core,R0Sink,emitCore,emitOperation,emitCommand,checkOwnedCommand} from '../fixtures/gradleOwnedCwcR0Engine.js';
import {cwcCMemory} from '../fixtures/gradleOwnedCwcC.js';
import {r0Fixture,r0Matrix} from '../fixtures/gradleOwnedCwcR0Fixture.js';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {r0Differential} from '../fixtures/gradleOwnedCwcR0Differential.js';
import {R0Owner} from '../fixtures/gradleOwnedCwcR0.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {Vf0Clock} from '../fixtures/gradleOwnedCwcVf0Authority.js';
import {planCore} from '../fixtures/gradleOwnedCprAPlanner.js';
import * as legacyJson from '../../utils/gradleOwnedJson.js';
import * as legacySchema from '../fixtures/gradleOwnedCprASchema.js';
import {validateR0Evidence,validateR0Differential} from '../fixtures/gradleOwnedCwcR0Validation.mjs';
import {R0_EXCEPTION_FAULTS,R0_PARSER_FAULTS,r0ExceptionFailure,r0ParserFailure} from '../fixtures/gradleOwnedCwcR0FailureCases.js';
const reviewRows:unknown[]=[];
afterAll(()=>{if(process.env.CWC_R0_REVIEW_PATH)writeFileSync(process.env.CWC_R0_REVIEW_PATH,JSON.stringify({schema:'cwc-r0.review-regressions.v1',rows:reviewRows}));});
function open(f:ReturnType<typeof r0Fixture>,actor:'provider'|'client-initial'='provider'){return f.owner.open(f.owner.claim(actor));}
function capture(f:ReturnType<typeof r0Fixture>,h:ReturnType<typeof open>){for(let i=0;i<f.commands.length;i++)f.owner.capture(h);}
function drained(f:ReturnType<typeof r0Fixture>){const s=f.owner.stats();expect(s.released).toBe(true);expect(s.lookup).toBe(false);expect(s.liveBuffers).toBe(0);expect(s.slotLive).toBe(0);expect(s.liveFrames).toBe(0);expect(s.nativeViewLive).toBe(0);expect(s.zeroVerified).toBe(true);expect(s.budget.heldBytes).toBe(0);expect(s.proofs+s.publications).toBe(0);}
it('R0T01: bounded command parser retains token offsets instead of returning a command object',()=>{
 const f=cprFixture({sizes:[1,1,1,1,1]}),q=f.plan().commands[0]!,bytes=Buffer.from(canonical(q)),storage=Buffer.alloc(8192),p=new R0Tokens(storage);
 const root=p.parse(bytes,bytes.length,R0_COMMAND);expect(root).toBe(0);expect(p.count).toBeLessThanOrEqual(512);
 expect(p.field(root,'payload')).toBeGreaterThan(0);expect(p.number(p.field(p.field(root,'payload'),'byteBudget'))).toBe(q.payload.byteBudget);
 p.clear();expect(storage.every(x=>x===0)).toBe(true);expect(p.count).toBe(0);
});
it('R0T03: the real CoreHandle is the same window object and only n reserved rows are processed',()=>{
 const f=r0Fixture(),h=f.owner.open(f.owner.claim('provider'));expect(f.owner.coreHandle(h)).toBe(h);
 for(let i=0;i<2;i++)f.owner.capture(h);for(let i=0;i<2;i++)f.owner.process(h);
 const s=f.owner.stats();expect(s.compared).toBe(2);expect(s.children[0]!.reservedRows).toBe(19);expect(s.children[0]!.reservedBytes).toBe(19*s.width);
 expect(s.slotPeak).toBe(3);expect(s.slotLive).toBe(0);expect(s.liveFrames).toBe(0);expect(s.sinkActive).toBe(false);expect(s.coreHandleAllocations).toBe(0);
 expect(f.owner.diagnosticRows(h).map(b=>b.toString())).toEqual(f.commands.map(q=>canonical(q)));f.owner.close();expect(f.budget.stats().heldBytes).toBe(0);expect(()=>f.owner.coreHandle(h)).toThrow();
});
it('R0T04: all role/context/size/client-provider cases match the independent full schema and canonical oracle',()=>{
 const e=r0Matrix();validateR0Evidence(e);expect(e.rows).toHaveLength(24);let commands=0;
 for(const r of e.rows){expect(r.error).toBeNull();expect(r.alias).toBe(true);expect(r.before.children.every(c=>c.processed===r.n)).toBe(true);
  expect(r.after.budget.heldBytes).toBe(0);expect(r.after.slotLive).toBe(0);expect(r.after.liveFrames).toBe(0);commands+=r.before.compared;}
 expect(commands).toBe(378);if(process.env.CWC_R0_EVIDENCE_PATH)writeFileSync(process.env.CWC_R0_EVIDENCE_PATH,JSON.stringify(e));
},60000);
it('R0T02: packed producer and streaming projection agree with original core, operation and wire digests',()=>{
 const f=cprFixture({sizes:[1,1,1,1,1]}),p=f.plan(),ctx=Buffer.from(canonical(f.ctx)),bounds=cwcCMemory(f.ctx),c=new R0Core(Buffer.alloc(bounds.coreBytes),ctx.length,ctx,p.core.groups,p.core.seed,p.core.transferId),s=new R0Sink(Buffer.alloc(4096),()=>{});
 s.begin();emitCore(s,c);const digest=s.end() as string;expect(digest).toBe(hash(p.core));c.setDigest(digest);
 for(let i=0;i<c.n;i++){
  s.begin();emitOperation(s,c,i);const op=s.end() as string;expect(op).toBe(p.commands[i]!.operationId);
  s.begin();s.literal('{"command":');emitCommand(s,c,i,op);s.literal(',"domain":"cpr.wire-intent.v3"}');const request=s.end() as string;expect(request).toBe(p.commands[i]!.requestDigest);
  const row=Buffer.alloc(8192);s.begin(row,0,8192);emitCommand(s,c,i,op,request);const n=s.end() as number;expect(row.toString('utf8',0,n)).toBe(canonical(p.commands[i]));
  const t=new R0Tokens(Buffer.alloc(8192));t.parse(row,n,R0_COMMAND);checkOwnedCommand(t,c,s);t.clear();
 }
 expect(s.viewLive).toBe(0);expect(s.targetLive).toBe(false);expect(s.active).toBe(false);c.clear();expect(c.arena.every(x=>x===0)).toBe(true);
});
it('R0T05: nested schema boundaries and repaired semantic mutations match the legacy oracles',()=>{
 const e=r0Differential();validateR0Differential(e);expect(e.rows.length).toBeGreaterThan(4000);expect(e.rows.every(r=>r.legacy===r.owned&&r.frames===0&&r.tokensAfter===0)).toBe(true);
 expect(e.rows.some(r=>r.id==='semantic:seed'&&r.owned)).toBe(true);expect(e.rows.some(r=>r.id==='semantic:ordinal'&&!r.owned)).toBe(true);
 if(process.env.CWC_R0_DIFFERENTIAL_PATH)writeFileSync(process.env.CWC_R0_DIFFERENTIAL_PATH,JSON.stringify(e));
},60000);
it('R0T06: complete command paths do not invoke the original object parser/schema/canonical helpers',()=>{
 const f=r0Fixture(),h=open(f),spies=[vi.spyOn(JSON,'parse').mockImplementation(()=>{throw Error('forbidden JSON.parse');}),vi.spyOn(legacyJson,'canonicalOwnedJson').mockImplementation(()=>{throw Error('forbidden canonical');}),vi.spyOn(legacySchema,'checkCommand').mockImplementation(()=>{throw Error('forbidden checkCommand');})];
 try{capture(f,h);for(let i=0;i<f.commands.length;i++)f.owner.process(h);expect(f.owner.stats().compared).toBe(2);for(const s of spies)expect(s).not.toHaveBeenCalled();}finally{spies.forEach(s=>s.mockRestore());f.owner.close();}drained(f);
});
it('R0T07: mutations of caller context/groups after construction cannot change owned output',()=>{
 const f=r0Fixture(),expected=f.commands.map(q=>canonical(q)),h=open(f);f.context.peer.instanceId='changed';f.groups[0]![0]!.entry.sha256='0'.repeat(64);f.groups.length=0;
 for(let i=0;i<expected.length;i++)f.owner.capture(h);for(let i=0;i<expected.length;i++)f.owner.process(h);expect(f.owner.diagnosticRows(h).map(b=>b.toString())).toEqual(expected);f.owner.close();drained(f);
});
it('R0T08: captured buffer intrinsics cannot be replaced to borrow private storage',()=>{
 const f=r0Fixture(),h=open(f),spies=['copy','fill','subarray','readUInt16LE','writeUInt16LE','readUInt32LE','writeUInt32LE'].map(k=>vi.spyOn(Buffer.prototype,k as any).mockImplementation(()=>{throw Error('replaced buffer intrinsic');}));
 try{capture(f,h);for(let i=0;i<f.commands.length;i++)f.owner.process(h);for(const s of spies)expect(s).not.toHaveBeenCalled();}finally{spies.forEach(s=>s.mockRestore());f.owner.close();}drained(f);
});
it('R0T09: processing before complete capture rejects and keeps prepaid consumption',()=>{
 const f=r0Fixture(),h=open(f);f.owner.capture(h);const work=f.budget.stats().work;expect(()=>f.owner.process(h)).toThrow('ordinal');drained(f);expect(f.budget.stats().work).toBe(work);
});
it('R0T10: processing only n rows does not allow capture of reserved but unused rows',()=>{
 const f=r0Fixture(),h=open(f);capture(f,h);expect(()=>f.owner.capture(h)).toThrow('ordinal');drained(f);expect(f.owner.stats().trace.filter(e=>e.kind==='captured')).toHaveLength(2);
});
it('R0T11: copied window and cross-owner handles do not select a core',()=>{
 for(const foreign of [false,true]){const f=r0Fixture(),h=open(f),g=foreign?r0Fixture():undefined,other=g?open(g):{...h};expect(()=>f.owner.coreHandle(other)).toThrow('binding');drained(f);g?.owner.close();}
});
it('R0T12: seal cannot precede initial completion and consumed claims cannot be reopened',()=>{
 const f=r0Fixture({kind:'client'});expect(()=>f.owner.open(f.owner.claim('client-seal'))).toThrow('initial_incomplete');drained(f);
 const g=r0Fixture(),claim=g.owner.claim('provider');g.owner.open(claim);expect(()=>g.owner.open(claim)).toThrow('state');drained(g);
});
it.each(['provider','client'] as const)('R0T13: %s independent expected catches a valid but different producer',kind=>{
 const f=r0Fixture({kind,fault:'expected-seed'}),h=open(f,kind==='provider'?'provider':'client-initial');capture(f,h);expect(()=>f.owner.process(h)).toThrow('expected_mismatch');expect(f.owner.stats().compared).toBe(0);drained(f);
});
it('R0T14: live token borrow refuses expected construction before a fourth representation appears',()=>{
 const f=r0Fixture({fault:'retained-index'}),h=open(f);capture(f,h);expect(()=>f.owner.process(h)).toThrow('index_borrow_live');expect(f.owner.stats().trace.some(e=>e.kind==='enter:expected')).toBe(false);drained(f);
});
it('R0T15: changing the retained source row after normalization fails the three-way comparison',()=>{
 const f=r0Fixture({fault:'row-after-normalize'}),h=open(f);capture(f,h);expect(()=>f.owner.process(h)).toThrow('expected_mismatch');expect(f.owner.stats().compared).toBe(0);drained(f);
});
it.each(['provider','client'] as const)('R0T16: %s caught callback reentry still invalidates the outer comparison',kind=>{
 let attempted=false;const f=r0Fixture({kind,hook:(site,o)=>{if(site==='compare-after'){attempted=true;try{o.claim('provider');}catch{}}}}),h=open(f,kind==='provider'?'provider':'client-initial');capture(f,h);
 expect(()=>f.owner.process(h)).toThrow('reentry');expect(attempted).toBe(true);expect(f.owner.stats().compared).toBe(0);drained(f);
});
it.each(['deadline','close'] as const)('R0T17: %s after the last callback prevents completed comparison',cause=>{
 let ready=false;const f=r0Fixture({hook:(site,o)=>{if(ready&&site==='compare-after'){if(cause==='close')o.close();else f.clock.advance(4500);}}}),h=open(f);capture(f,h);ready=true;
 expect(()=>f.owner.process(h)).toThrow();expect(f.owner.stats().compared).toBe(0);drained(f);expect(()=>f.owner.coreHandle(h)).toThrow();
});
it('R0T18: insufficient memory/work refuses construction without refunding earlier initialization',()=>{
 for(const [memory,work]of [[131072,156978],[1048576,4096]]){const b=new Lb0Budget(undefined,memory,work);expect(()=>r0Fixture({budget:b})).toThrow('codec_budget_exceeded');expect(b.stats().heldBytes).toBe(0);expect(b.stats().initialization).toBe(4096);expect(b.stats().work).toBe(0);}
});
it('R0T19: getters and incomplete/unknown range input reject during bootstrap with no retained storage',()=>{
 const f=r0Fixture();f.owner.close();let reads=0;const ctx=structuredClone(f.context);Object.defineProperty(ctx,'catalog',{get(){reads++;return f.context.catalog;}});
 const unknown=structuredClone(f.groups);Object.assign(unknown[0]![0]!,{unknown:0});
 for(const [context,groups]of [[ctx,f.groups],[f.context,[f.groups[0]]],[f.context,unknown]]){const b=new Lb0Budget();expect(()=>new R0Owner({context,groups,seed:'s',transferId:'t',kind:'provider',budget:b,clock:new Vf0Clock()})).toThrow();expect(b.stats().heldBytes).toBe(0);}expect(reads).toBe(0);
});
it('R0T20: token/byte caps and malformed canonical input leave no source borrow or parser frame',()=>{
 const f=r0Fixture(),bytes=Buffer.from(canonical(f.commands[0])),p=new R0Tokens(Buffer.alloc(16),1);expect(()=>p.parse(bytes,bytes.length,R0_COMMAND)).toThrow('tokens');expect(p.count).toBe(0);expect(p.metrics.frames).toBe(0);
 expect(()=>p.parse(Buffer.alloc(65536),65536,R0_COMMAND)).toThrow('input');expect(p.count).toBe(0);expect(p.metrics.frames).toBe(0);f.owner.close();
});
it('R0T21: storage equality is not a proof, permit or production admission',()=>{
 const f=r0Fixture(),h=open(f);capture(f,h);for(let i=0;i<f.commands.length;i++)f.owner.process(h);expect(()=>f.owner.finish()).toThrow('proof_unavailable');drained(f);expect(f.owner.stats().scope.co0Exit).toBe(false);
});
it('R0T22: reversed input key insertion order produces identical canonical bytes',()=>{
 const f=r0Fixture({role:'authority-broker'});f.owner.close();const reverse=(v:any):any=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;
 const budget=new Lb0Budget(),o=new R0Owner({context:reverse(f.context),groups:reverse(f.groups),seed:f.core.seed,transferId:f.core.transferId,kind:'provider',budget,clock:new Vf0Clock()}),h=o.open(o.claim('provider'));
 for(let i=0;i<f.commands.length;i++)o.capture(h);for(let i=0;i<f.commands.length;i++)o.process(h);expect(o.diagnosticRows(h).map(b=>b.toString())).toEqual(f.commands.map(q=>canonical(q)));o.close();expect(budget.stats().heldBytes).toBe(0);
});
it('R0T23: captured hash primitives cannot be replaced to retain borrowed chunk views',()=>{
 const f=r0Fixture(),h=open(f),proto=Object.getPrototypeOf(createHash('sha256')),spies=['update','digest'].map(k=>vi.spyOn(proto,k).mockImplementation(()=>{throw Error('replaced hash primitive');}));
 try{capture(f,h);for(let i=0;i<f.commands.length;i++)f.owner.process(h);expect(f.owner.stats().nativeViewLive).toBe(0);f.owner.close();for(const s of spies)expect(s).not.toHaveBeenCalled();}finally{spies.forEach(s=>s.mockRestore());f.owner.close();}drained(f);
});
it('R0T24: constructor rejects non-string identity coercion and core/context layout mismatch',()=>{
 const f=r0Fixture();f.owner.close();let calls=0;const budget=new Lb0Budget(),o={context:f.context,groups:f.groups,seed:{toString(){calls++;return 'seed';}},transferId:'t',kind:'provider',budget,clock:new Vf0Clock()};
 expect(()=>new R0Owner(o as any)).toThrow('input');expect(calls).toBe(0);expect(budget.stats().initialization).toBe(0);
 const ctx=Buffer.from(canonical(f.context));expect(()=>new R0Core(Buffer.alloc(65536),ctx.length-1,ctx,f.groups,'s','t')).toThrow('core_capacity');
 const bad=Buffer.from(canonical(f.commands[0]));bad[1]=255;const p=new R0Tokens(Buffer.alloc(8192));expect(()=>p.parse(bad,bad.length,R0_COMMAND)).toThrow();expect(p.metrics.frames).toBe(0);expect(p.count).toBe(0);
});
it.each([16379,16382])('R0T25: diagnostic capacity %s leaves room for frame unwind and terminal cleanup',limit=>{
 const f=r0Fixture(),h=open(f);let count=f.owner.stats().trace.length;for(;count<limit;count++)f.owner.coreHandle(h);
 expect(()=>limit===16382?f.owner.coreHandle(h):f.owner.capture(h)).toThrow('trace_limit');drained(f);const s=f.owner.stats();expect(s.trace.length).toBeLessThanOrEqual(16384);expect(s.trace.slice(-2).map(e=>e.kind)).toEqual(['failed','drained']);
});
it('R0T26: all 76 packed ranges across 19 four-range commands agree with the original full core oracle',()=>{
 const f=cprFixture({sizes:[9,9,9,9,8,8,8,8,8]}),flat=f.entries.flatMap(e=>Array.from({length:e.byteLength},(_,offset)=>({ordinal:0,kind:e.kind,index:e.index,offset,length:1,entry:{sha256:e.sha256,byteLength:e.byteLength}}))),groups=Array.from({length:19},(_,i)=>flat.slice(i*4,i*4+4).map((r,ordinal)=>({...r,ordinal}))),core=planCore(f.ctx,'seed','transfer',groups),digest=hash(core),budget=new Lb0Budget(),o=new R0Owner({context:f.ctx,groups,seed:'seed',transferId:'transfer',kind:'provider',budget,clock:new Vf0Clock()}),h=o.open(o.claim('provider'));
 expect(flat).toHaveLength(76);for(let i=0;i<19;i++)o.capture(h);for(let i=0;i<19;i++)o.process(h);
 expect(o.diagnosticRows(h).map(b=>b.toString())).toEqual(groups.map((rs,i)=>canonical(legacySchema.makeCommand(f.ctx,'seed','transfer',i,19,digest,rs))));expect(o.stats().slotPeak).toBe(3);o.close();expect(o.stats().zeroVerified).toBe(true);expect(budget.stats().heldBytes).toBe(0);
});
it.each((['provider','client'] as const).flatMap(kind=>R0_EXCEPTION_FAULTS.map(fault=>({kind,fault}))))('R0T27: $kind/$fault cannot prevent invalidation, zeroization or memory release',({kind,fault})=>{
 const r=r0ExceptionFailure(kind,fault);reviewRows.push(r);
 expect(r.alive).toBe(false);expect(r.lookup).toBe(false);expect(r.released).toBe(true);expect(r.zeroVerified).toBe(true);expect(r.originalRethrown).toBe(true);expect(r.diagnosticCalls).toBe(0);
 for(const key of ['compared','publications','proofs','slots','frames','buffers','nativeViews','heldBytes'] as const)expect(r[key]).toBe(0);
 expect(r.sinkActive).toBe(false);expect(r.work).toBe(r.prepaidWork);expect(r.initialization).toBe(r.prepaidInitialization);expect(r.lateHandleRefused).toBe(true);expect(r.oneRelease).toBe(true);
});
it.each(R0_PARSER_FAULTS)('R0T28: successful parse followed by %s rejection clears old tokens and source',fault=>{
 const r=r0ParserFailure(fault);reviewRows.push(r);expect(r.prior).toBeGreaterThan(0);expect(r.previousSourceBound).toBe(true);expect(r.refused).toBe(true);
 expect(r.tokensAfter).toBe(0);expect(r.sourceBound).toBe(false);expect(r.frames).toBe(0);expect(r.tableZero).toBe(true);expect(r.oldReadable).toBe(false);expect(r.reusable).toBe(true);
});
