import {it,expect,vi} from 'vitest';
import {CwcAContract,CWC_LIMITS,cwcApprovalSchema,type CwcActor,type CwcBudget} from '../fixtures/gradleOwnedCwcA.js';
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import {CPR_SPEC_DIGEST,wireIntent} from '../fixtures/gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
import * as wire from '../fixtures/gradleOwnedCprAWire.js';
const budget:CwcBudget={bytes:1048576,fragments:4096,work:67108864};
function fixture(actor:CwcActor='provider',config:{parent?:CwcBudget;approvalMutation?:(a:any)=>void;parentRead?:Readonly<{kind:string}>;seed?:string}={}){
 const f=cprFixture(),p=f.plan(config.seed??'seed');let now=0,allowed=true,currentContext=structuredClone(f.ctx),pin:string;
 const approval:any={schema:'cwc.implementation-approval.v1',codecVariantDigest:hash('fixture-only-cwc-a-reference'),sourceClosureDigest:hash('fixture-only-source-pin'),schemaFamily:'cpr.v3.owner-auth.v1',canonicalVersion:'owned-json.v1',semanticSpecDigest:CPR_SPEC_DIGEST,layoutVersion:'cpr.actual-codec-bound.v1',actor,limits:{...CWC_LIMITS}};
 // Independent trusted expected pin stays unchanged when the offered approval is mutated.
 pin=hash(approval);config.approvalMutation?.(approval);
 let hook:()=>void=()=>{};
 const owner=new CwcAContract({context:f.ctx,actor,approval,approvalPin:pin,now:()=>now,current:()=>{expect(allowed,'permission_denied').toBe(true);hook();return {context:currentContext,approvalPin:pin};},parentReservation:config.parent??budget});
 let sequence=0;
 const identity=()=>({actor,scopeId:'scope-'+(++sequence),callId:'call-'+sequence,clockDomain:'fixture-clock',originalDeadline:4500,contextFingerprint:hash(f.ctx)});
 const scope=(b=budget)=>owner.openScope(identity(),b,config.parentRead);
 function opened(b=budget){const s=scope(b),root=owner.openCodecRoot(s,p.core);return {scope:s,root};}
 function compiled(b=budget){const a=opened(b),layout=owner.compilePlanLayout(a.root);return {...a,layout};}
 function proved(){const a=compiled(),facts=p.commands.map(q=>owner.encodeCheckedCommand(a.root,a.layout,q)),receipts=facts.map(h=>owner.provePlannedOwnerAndAuth(a.root,a.layout,h));return {...a,facts,receipts};}
 return {f,p,owner,approval,identity,scope,opened,compiled,proved,setNow:(n:number)=>now=n,revoke:()=>allowed=false,context:currentContext,setPin:()=>pin=hash('new-pin'),hook:(h:()=>void)=>hook=h};
}
function initialProof(seed='seed'){
 const initial=fixture('client-initial',{seed}),a=initial.proved(),evidence=initial.owner.registerInitialPlan(a.root);
 initial.owner.disposeCodecRoot(a.root);return {initial,a,evidence};
}
function approvedSeal(){const parent=initialProof(),f=fixture('client-seal',{parentRead:parent.evidence}),a=f.proved();f.owner.verifyClientSeal(a.root,parent.evidence);return {...f,a,parent};}
it('CWA01: strict approval rejects unknown keys, family/version/source changes and actor mismatches before work',()=>{
 for(const mutate of [(a:any)=>a.extra=true,(a:any)=>a.sourceClosureDigest=hash('new-source'),(a:any)=>a.canonicalVersion='v2',(a:any)=>a.actor='client-initial',(a:any)=>a.limits.bytes++])expect(()=>fixture('provider',{approvalMutation:mutate})).toThrow();
 expect(cwcApprovalSchema.safeParse({}).success).toBe(false);
});
it('CWA02: simulated owner issues opaque roots and rejects fabricated or foreign scope/layout/fact',()=>{
 const a=fixture(),b=fixture(),s=a.scope();expect(()=>b.owner.openCodecRoot(s,a.p.core)).toThrow('codec_fact_binding_mismatch');expect(()=>a.owner.openCodecRoot({kind:'cwc-a-simulated-scope'},a.p.core)).toThrow();const root=a.owner.openCodecRoot(s,a.p.core),x={root,layout:a.owner.compilePlanLayout(root)},y=b.compiled();expect(()=>a.owner.encodeCheckedCommand(x.root,y.layout,a.p.commands[0])).toThrow();expect(()=>a.owner.compilePlanLayout({kind:'cwc-root'})).toThrow();
});
it('CWA03: scope identity is strict and bound to actor, complete context and original deadline',()=>{
 const f=fixture();for(const patch of [{actor:'client-seal'},{contextFingerprint:hash('other')},{originalDeadline:4501},{originalDeadline:0},{extra:true}])expect(()=>f.owner.openScope({...f.identity(),...patch},budget)).toThrow();expect(f.owner.metrics.roots).toBe(0);
});
it('CWA04: all commands are completely checked and reference-backed receipts preserve full codecs',()=>{
 const f=fixture(),a=f.proved(),n=f.p.commands.length;expect(f.owner.diagnostics(a.scope).state).toBe('all-commands-proved');expect(a.receipts).toHaveLength(n);expect(f.owner.metrics).toEqual({roots:1,compiles:1,commands:n,proofs:n,referenceOwners:2+2*n,referenceFrames:4+4*n,referenceLayouts:1});expect(f.f.reads).toBe(0);
});
it('CWA05: input insertion order is accepted with identical canonical command bytes',()=>{
 const f=fixture(),a=f.compiled();function reverse(v:any):any{return Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;}const q=f.p.commands[0]!,fact=f.owner.encodeCheckedCommand(a.root,a.layout,reverse(q));expect(f.owner.readCommandFact(a.root,fact).toString()).toBe(canonical(q));
});
it('CWA06: generated noncanonical bytes differ from the oracle; A does not claim a composition rejection implementation',()=>{
 const f=fixture(),a=f.compiled(),q=f.p.commands[0]!,fact=f.owner.encodeCheckedCommand(a.root,a.layout,q),bytes=f.owner.readCommandFact(a.root,fact);expect(bytes.equals(Buffer.from(canonical(q)))).toBe(true);expect(bytes.equals(Buffer.from(JSON.stringify(q)))).toBe(false);
});
it('CWA07: command, returned Buffer and ArrayBuffer aliases cannot alter private facts or sibling commands',()=>{
 const f=fixture(),a=f.compiled(),q=structuredClone(f.p.commands[0]!),fact=f.owner.encodeCheckedCommand(a.root,a.layout,q),expected=canonical(q);q.payload.ranges[0]!.length=1;const out=f.owner.readCommandFact(a.root,fact);out.subarray(0,4).fill(0);new Uint8Array(out.buffer,out.byteOffset,out.byteLength).fill(1);expect(f.owner.readCommandFact(a.root,fact).toString()).toBe(expected);expect(canonical(f.p.commands[0])).toBe(expected);
 // Node pools small Buffers in one shared ArrayBuffer. Overwriting the whole backing store of a returned copy must not reach the private bytes.
 const whole=f.owner.readCommandFact(a.root,fact);expect(whole.buffer.byteLength).toBe(whole.length);new Uint8Array(whole.buffer).fill(0x41);expect(f.owner.readCommandFact(a.root,fact).toString()).toBe(expected);
});
it('CWA08: getter/toJSON/prototype/coercion/extra/missing inputs fail without evaluating getters',()=>{
 let reads=0;for(const change of [(q:any)=>Object.defineProperty(q,'evil',{enumerable:true,get(){reads++;return 1;}}),(q:any)=>q.toJSON=()=>{reads++;return q;},(q:any)=>Object.setPrototypeOf(q,{extra:1}),(q:any)=>q.payload.byteBudget=String(q.payload.byteBudget),(q:any)=>q.extra=1,(q:any)=>delete q.payload]){const f=fixture(),a=f.compiled(),q:any=structuredClone(f.p.commands[0]);change(q);expect(()=>f.owner.encodeCheckedCommand(a.root,a.layout,q)).toThrow();expect(f.owner.diagnostics(a.scope).state).toBe('disposed');}expect(reads).toBe(0);
});
it('CWA09: domain substitutions cannot mint or read a command fact',()=>{
 for(const d of ['wireIntent.preimage','owner.request.unsigned','owner.reply.signed','auth.channel.request.signed','unknown']){const f=fixture(),a=f.compiled();expect(()=>f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0],d)).toThrow();}const f=fixture(),a=f.compiled(),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]);expect(()=>f.owner.readCommandFact(a.root,fact,'owner.request.signed')).toThrow();
});
it('CWA10: call-local roots cannot share facts/layouts even with matching context and plan digest',()=>{
 const f=fixture('provider',{parent:{bytes:1048576,fragments:4096,work:67108864}}),half={bytes:524288,fragments:2048,work:33554432},a=f.compiled(half),b=f.compiled(half),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]);expect(()=>f.owner.provePlannedOwnerAndAuth(b.root,b.layout,fact)).toThrow();expect(f.owner.readCommandFact(a.root,fact).length).toBeGreaterThan(0);
});
it('CWA11: bad wireIntent, operation and inventory/plan digest cannot become verified facts',()=>{
 for(const mutate of [(q:any)=>q.requestDigest=hash('wrong'),(q:any)=>{q.operationId=hash('wrong');q.requestDigest=wireIntent(q);},(q:any)=>{q.payload.plan.inventoryDigest=hash('wrong');q.requestDigest=wireIntent(q);},(q:any)=>{q.payload.plan.planDigest=hash('wrong');q.requestDigest=wireIntent(q);}]){const f=fixture(),a=f.compiled(),q=structuredClone(f.p.commands[0]!);mutate(q);expect(()=>f.owner.encodeCheckedCommand(a.root,a.layout,q)).toThrow();}
});
it('CWA12: missing/reordered/duplicate commands and proofs cannot reach all-commands-proved',()=>{
 const f=fixture(),a=f.compiled();expect(f.p.commands.length).toBeGreaterThan(1);expect(()=>f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[1])).toThrow();const g=fixture(),b=g.compiled(),fact=g.owner.encodeCheckedCommand(b.root,b.layout,g.p.commands[0]);g.owner.provePlannedOwnerAndAuth(b.root,b.layout,fact);expect(g.owner.diagnostics(b.scope).state).toBe('compiled');expect(()=>g.owner.provePlannedOwnerAndAuth(b.root,b.layout,fact)).toThrow();
});
it('CWA13: mutated planCore cannot bypass context binding or full coverage',()=>{
 for(const change of [(p:any)=>p.groups.pop(),(p:any)=>p.pin.id='different',(p:any)=>p.inventoryDigest=hash('wrong'),(p:any)=>p.extra=1]){const f=fixture(),s=f.scope(),p=structuredClone(f.p.core);change(p);expect(()=>f.owner.openCodecRoot(s,p)).toThrow();expect(f.owner.diagnostics(s).state).toBe('disposed');expect(f.owner.diagnostics(s).spent.work).toBe(156978);}
});
it('CWA14: same-length context and pin changes revoke existing facts before reading',()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>f.context.endpointId='another', (f:ReturnType<typeof fixture>)=>f.context.requestKeyId='other-key',(f:ReturnType<typeof fixture>)=>f.context.peer.boot=hash('newboot'),(f:ReturnType<typeof fixture>)=>f.setPin()]){const f=fixture(),a=f.compiled(),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]);change(f);expect(()=>f.owner.readCommandFact(a.root,fact)).toThrow();expect(f.owner.diagnostics(a.scope).state).toBe('disposed');}
});
it('CWA15: compile post-gate rejects expiry reached inside the reference codec',()=>{
 const f=fixture(),a=f.opened(),original=wire.layout;const spy=vi.spyOn(wire,'layout').mockImplementation((...args)=>{const v=original(...args);f.setNow(4500);return v;});try{expect(()=>f.owner.compilePlanLayout(a.root)).toThrow('request_expired');expect(f.owner.diagnostics(a.scope).state).toBe('disposed');expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978+81920);}finally{spy.mockRestore();}
});
it('CWA16: cancellation and original deadline reject before compile without consuming compile work',()=>{
 for(const cancel of ['revoke','expire'] as const){const f=fixture(),a=f.opened();if(cancel==='revoke')f.revoke();else f.setNow(4500);expect(()=>f.owner.compilePlanLayout(a.root)).toThrow();expect(f.owner.metrics.compiles).toBe(0);expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978);}
});
it('CWA17: owner close/restart, explicit scope close and terminal disposal reject old handles',()=>{
 for(const close of ['owner','scope','root'] as const){const f=fixture(),a=f.compiled(),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]);if(close==='owner')f.owner.close();else if(close==='scope')f.owner.closeScope(a.scope);else f.owner.disposeCodecRoot(a.root);expect(()=>f.owner.readCommandFact(a.root,fact)).toThrow();expect(()=>fixture().owner.readCommandFact(a.root,fact)).toThrow();expect(()=>f.owner.openCodecRoot(a.scope,f.p.core)).toThrow();}
});
it('CWA18: only complete client seal can move child ownership, and children die with the parent read',()=>{
 const f=approvedSeal(),a=f.a,child=f.owner.retainClientCommandFact(a.root,a.facts[0]!);expect(f.parent.initial.owner.metrics.roots).toBe(1);expect(f.owner.metrics.roots).toBe(1);expect(f.parent.initial.owner.metrics.commands).toBe(f.p.commands.length);expect(f.owner.metrics.commands).toBe(f.p.commands.length);f.owner.disposeCodecRoot(a.root);const out=f.owner.readClientCommandFact(a.scope,child,0);expect(out.toString()).toBe(canonical(f.p.commands[0]));expect(out.buffer.byteLength).toBe(out.length);new Uint8Array(out.buffer).fill(0x41);expect(f.owner.readClientCommandFact(a.scope,child,0).toString()).toBe(canonical(f.p.commands[0]));expect(()=>f.owner.readClientCommandFact(a.scope,child,1)).toThrow();expect(()=>f.owner.readClientCommandFact({kind:'scope'},child,0)).toThrow();f.owner.closeScope(a.scope);expect(()=>f.owner.readClientCommandFact(a.scope,child,0)).toThrow();expect(f.owner.diagnostics(a.scope).children).toBe(0);
});
it('CWA19: initial/provider/incomplete seal cannot retain a child or promote it to dispatch authority',()=>{
 for(const actor of ['client-initial','provider'] as const){const f=fixture(actor),a=f.proved();expect(()=>f.owner.retainClientCommandFact(a.root,a.facts[0]!)).toThrow();}const f=fixture('client-seal'),a=f.compiled(),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]);expect(()=>f.owner.retainClientCommandFact(a.root,fact)).toThrow();expect(Object.getOwnPropertyNames(CwcAContract.prototype)).not.toContain('promote');
});
it('CWA20: parent memory/work reservations reject overcommit and are not refunded by disposal/new scope',()=>{
 const f=fixture(),a=f.opened();f.owner.disposeCodecRoot(a.root);expect(()=>f.scope()).toThrow('codec_budget_exceeded');expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978);for(const key of ['bytes','fragments','work'] as const){const g=fixture(),b={...budget,[key]:CWC_LIMITS[key]+1};expect(()=>g.scope(b)).toThrow();}
});
it('CWA21: insufficient work/bytes/fragments prevents plan parsing and codec execution',()=>{
 for(const b of [{...budget,work:156977},{...budget,bytes:262143},{...budget,fragments:63}]){const f=fixture(),s=f.scope(b);let reads=0;const input=Object.defineProperty({},'groups',{get(){reads++;throw Error('must not read');}});expect(()=>f.owner.openCodecRoot(s,input)).toThrow('codec_budget_exceeded');expect(reads).toBe(0);expect(f.owner.metrics.compiles).toBe(0);expect(f.owner.diagnostics(s).spent).toEqual({bytes:0,fragments:0,work:0});expect(()=>f.owner.openCodecRoot(s,f.p.core)).toThrow();}
});
it('CWA22: compile budget failure preserves earlier spending and forbids retry on the same root/scope',()=>{
 const f=fixture(),a=f.opened({...budget,work:156978+81919});expect(()=>f.owner.compilePlanLayout(a.root)).toThrow('codec_budget_exceeded');expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978);expect(()=>f.owner.compilePlanLayout(a.root)).toThrow();expect(()=>f.owner.openCodecRoot(a.scope,f.p.core)).toThrow();
});
it('CWA23: semantic failure keeps prepaid encode work and cannot be repeatedly executed',()=>{
 const f=fixture(),a=f.compiled(),before=f.owner.diagnostics(a.scope).spent.work,q=structuredClone(f.p.commands[0]!);q.requestDigest=hash('bad');expect(()=>f.owner.encodeCheckedCommand(a.root,a.layout,q)).toThrow();expect(f.owner.diagnostics(a.scope).spent.work).toBe(before+24576);expect(()=>f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0])).toThrow();
});
it('CWA24: proof budget failure prevents exact codec evaluation and retains prior consumption',()=>{
 const f=fixture(),a=f.compiled({...budget,work:156978+81920+24576+32767}),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]),before=f.owner.metrics;expect(()=>f.owner.provePlannedOwnerAndAuth(a.root,a.layout,fact)).toThrow('codec_budget_exceeded');expect(f.owner.metrics).toEqual(before);expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978+81920+24576);
});
it('CWA25: diagnostic/caller context and approval copies cannot mutate an opened owner',()=>{
 const f=fixture(),a=f.opened();f.approval.actor='client-seal';f.f.ctx.endpointId='mutated';const d=f.owner.diagnostics(a.scope);d.identity.originalDeadline=999999;d.spent.work=0;expect(f.owner.diagnostics(a.scope).identity.originalDeadline).toBe(4500);expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978);expect(()=>f.owner.compilePlanLayout(a.root)).not.toThrow();
});
it('CWA26: backwards clocks and read-time expiry invalidate child facts',()=>{
 const f=approvedSeal(),a=f.a,child=f.owner.retainClientCommandFact(a.root,a.facts[0]!);f.owner.disposeCodecRoot(a.root);f.setNow(4499);f.owner.readClientCommandFact(a.scope,child,0);f.setNow(4498);expect(()=>f.owner.readClientCommandFact(a.scope,child,0)).toThrow('clock_invalid');const g=approvedSeal(),b=g.a,c=g.owner.retainClientCommandFact(b.root,b.facts[0]!);g.owner.disposeCodecRoot(b.root);g.setNow(4500);expect(()=>g.owner.readClientCommandFact(b.scope,c,0)).toThrow('request_expired');
});
it('CWA27: reentrant work or close inside a current gate cannot return a successful fact',()=>{
 const f=fixture(),a=f.opened();f.hook(()=>f.owner.compilePlanLayout(a.root));expect(()=>f.owner.compilePlanLayout(a.root)).toThrow('codec_fact_binding_mismatch');expect(f.owner.metrics.compiles).toBe(0);const g=fixture(),b=g.opened();g.hook(()=>g.owner.close());expect(()=>g.owner.compilePlanLayout(b.root)).toThrow('owner_closed');
});
it('CWA28: child facts cannot cross client initial/seal owners, scopes or domains',()=>{
 const f=approvedSeal(),a=f.a,child=f.owner.retainClientCommandFact(a.root,a.facts[0]!);f.owner.disposeCodecRoot(a.root);const other=fixture('client-initial'),s=other.scope();expect(()=>other.owner.readClientCommandFact(s,child,0)).toThrow();expect(()=>f.owner.readClientCommandFact(a.scope,child,0,'wireIntent.preimage')).toThrow();
});
it('CWA29: duplicate call/scope enrollment cannot reset a failed root reservation or original deadline',()=>{
 const f=fixture(),half={bytes:524288,fragments:2048,work:33554432},identity=f.identity(),s=f.owner.openScope(identity,half),root=f.owner.openCodecRoot(s,f.p.core);f.owner.disposeCodecRoot(root);for(const patch of [{},{scopeId:'new-scope'},{callId:'new-call'}])expect(()=>f.owner.openScope({...identity,...patch},half)).toThrow('codec_fact_binding_mismatch');
});
it('CWA30: reference receipt is root-bound, expires and cannot assert composition or authority',()=>{
 const f=fixture(),a=f.proved(),receipt=a.receipts[0]!;expect(f.owner.inspectReferenceReceipt(a.root,receipt)).toEqual({referenceOnly:true,compositionProven:false,authorityGranted:false,ordinal:0});expect(()=>f.owner.inspectReferenceReceipt(a.root,{kind:'cwc-reference-only-receipt'})).toThrow();const g=fixture(),b=g.proved();expect(()=>g.owner.inspectReferenceReceipt(b.root,receipt)).toThrow();f.owner.disposeCodecRoot(a.root);expect(()=>f.owner.inspectReferenceReceipt(a.root,receipt)).toThrow();
});
it('CWA31: post-proof expiry exposes no successful receipt and keeps the reference codec charge',()=>{
 const f=fixture(),a=f.compiled(),fact=f.owner.encodeCheckedCommand(a.root,a.layout,f.p.commands[0]),original=wire.exact,spy=vi.spyOn(wire,'exact').mockImplementation((...args)=>{const result=original(...args);f.setNow(4500);return result;});try{expect(()=>f.owner.provePlannedOwnerAndAuth(a.root,a.layout,fact)).toThrow('request_expired');expect(f.owner.diagnostics(a.scope).state).toBe('disposed');expect(f.owner.diagnostics(a.scope).spent.work).toBe(156978+81920+24576+32768);}finally{spy.mockRestore();}
});
it('CWA32: max input string budget and depth/cycle checks refuse before unbounded copying',()=>{
 for(const input of ['x'.repeat(262145),(()=>{const x:any={};x.self=x;return x;})(),(()=>{let x:any={};for(let i=0;i<34;i++)x={child:x};return x;})()]){const f=fixture(),s=f.scope();expect(()=>f.owner.openCodecRoot(s,input)).toThrow();expect(f.owner.diagnostics(s).state).toBe('disposed');expect(f.owner.metrics.compiles).toBe(0);}
});

it('CWA33: same-scope root issuance rejects reentry before the current callback',()=>{
 const f=fixture(),s=f.scope();let inner:any;
 f.hook(()=>{f.hook(()=>{});inner=f.owner.openCodecRoot(s,f.p.core);});
 expect(()=>f.owner.openCodecRoot(s,f.p.core)).toThrow('codec_fact_binding_mismatch');
 expect(inner).toBeUndefined();expect(f.owner.metrics.roots).toBe(0);
 expect(()=>f.owner.openCodecRoot(s,f.p.core)).toThrow();
});
it('CWA34: a client seal without initial evidence cannot move a child',()=>{
 const f=fixture('client-seal'),a=f.proved();
 expect(()=>f.owner.retainClientCommandFact(a.root,a.facts[0]!)).toThrow('codec_fact_binding_mismatch');
 expect(f.owner.diagnostics(a.scope).children).toBe(0);
});

it('CWA35: seal mismatch retains its verification charge and refuses child movement',()=>{
 const parent=initialProof('initial-only'),f=fixture('client-seal',{parentRead:parent.evidence}),a=f.proved();
 expect(parent.initial.p.planDigest).not.toBe(f.p.planDigest);const spent=f.owner.diagnostics(a.scope).spent.work;
 expect(()=>f.owner.verifyClientSeal(a.root,parent.evidence)).toThrow('codec_fact_binding_mismatch');
 expect(f.owner.diagnostics(a.scope).spent.work).toBe(spent+8192);expect(f.owner.diagnostics(a.scope).children).toBe(0);
 expect(()=>f.owner.retainClientCommandFact(a.root,a.facts[0]!)).toThrow();
 expect(()=>f.owner.verifyClientSeal(a.root,parent.evidence)).toThrow();
});
it('CWA36: another read evidence is refused even when both initial plan digests match',()=>{
 const first=initialProof(),other=initialProof(),f=fixture('client-seal',{parentRead:first.evidence}),a=f.proved();
 expect(first.initial.p.planDigest).toBe(other.initial.p.planDigest);
 expect(()=>f.owner.verifyClientSeal(a.root,other.evidence)).toThrow('codec_fact_binding_mismatch');
 expect(()=>f.owner.retainClientCommandFact(a.root,a.facts[0]!)).toThrow();expect(f.owner.diagnostics(a.scope).children).toBe(0);
});
it('CWA37: serialized or forged initial evidence cannot bind a seal or certify equality',()=>{
 const parent=initialProof(),f=fixture('client-seal');
 expect(()=>f.owner.openScope(f.identity(),budget,{...parent.evidence})).toThrow('codec_fact_binding_mismatch');
 const g=fixture('client-seal',{parentRead:parent.evidence}),a=g.proved();
 expect(()=>g.owner.verifyClientSeal(a.root,{...parent.evidence})).toThrow('codec_fact_binding_mismatch');
 expect(()=>g.owner.retainClientCommandFact(a.root,a.facts[0]!)).toThrow();
});
it('CWA38: only a completely checked initial root can issue initial evidence',()=>{
 const f=fixture('client-initial'),a=f.compiled();expect(()=>f.owner.registerInitialPlan(a.root)).toThrow('codec_fact_binding_mismatch');
 const g=fixture('provider'),b=g.proved();expect(()=>g.owner.registerInitialPlan(b.root)).toThrow('codec_fact_binding_mismatch');
 const h=fixture('client-initial'),c=h.proved(),e=h.owner.registerInitialPlan(c.root);expect(e.kind).toBe('cwc-initial-plan-evidence');
 expect(()=>h.owner.registerInitialPlan(c.root)).toThrow('codec_fact_binding_mismatch');expect(()=>fixture('client-seal',{parentRead:e}).scope()).toThrow('codec_fact_binding_mismatch');
});
it('CWA39: closing or revoking the initial parent invalidates a retained seal child',()=>{
 for(const cancel of ['close','revoke','expire'] as const){const f=approvedSeal(),a=f.a,child=f.owner.retainClientCommandFact(a.root,a.facts[0]!);f.owner.disposeCodecRoot(a.root);
 if(cancel==='close')f.parent.initial.owner.closeScope(f.parent.a.scope);else if(cancel==='revoke')f.parent.initial.revoke();else f.parent.initial.setNow(4500);
 expect(()=>f.owner.readClientCommandFact(a.scope,child,0)).toThrow();expect(f.owner.diagnostics(a.scope).children).toBe(0);}
});
it('CWA40: seal binding preserves parent context, clock and deadline and allows only one seal scope',()=>{
 const parent=initialProof(),f=fixture('client-seal');
 for(const patch of [{clockDomain:'another-clock'},{originalDeadline:4499}])expect(()=>f.owner.openScope({...f.identity(),...patch},budget,parent.evidence)).toThrow('codec_fact_binding_mismatch');
 const g=fixture('client-seal',{parentRead:parent.evidence});g.scope();const h=fixture('client-seal',{parentRead:parent.evidence});expect(()=>h.scope()).toThrow('codec_fact_binding_mismatch');
 const next=initialProof(),outer=fixture('client-seal',{parentRead:next.evidence}),inner=fixture('client-seal',{parentRead:next.evidence});next.initial.hook(()=>{next.initial.hook(()=>{});expect(()=>inner.scope()).toThrow('codec_fact_binding_mismatch');});expect(()=>outer.scope()).not.toThrow();expect(inner.owner.metrics.roots).toBe(0);
});
it('CWA41: swallowed same-scope reentry still poisons root issuance and preserves reservation',()=>{
 const f=fixture(),scope=f.scope();f.hook(()=>{f.hook(()=>{});expect(()=>f.owner.openCodecRoot(scope,f.p.core)).toThrow('codec_fact_binding_mismatch');});
 expect(()=>f.owner.openCodecRoot(scope,f.p.core)).toThrow('codec_fact_binding_mismatch');
 const d=f.owner.diagnostics(scope);expect(d.open).toBe(false);expect(d.reserved).toEqual(budget);expect(d.spent.work).toBe(0);expect(f.owner.metrics.roots).toBe(0);
});
