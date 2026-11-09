import {writeFileSync} from 'node:fs';
import {runCwcBMatrix} from '../fixtures/gradleOwnedCwcBExperiment.js';
import {it,expect,vi} from 'vitest';
import {ClosedCwcBCodec,assertCwcBBytes,cwcBase64Length,type CwcBDomain} from '../fixtures/gradleOwnedCwcB.js';
import {cwcBOracle} from '../fixtures/gradleOwnedCwcBOracle.js';
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import {cprBCase} from '../fixtures/gradleOwnedCprB.js';
import {CWC_DOMAINS} from '../fixtures/gradleOwnedCwcA.js';
import {command,makeCommand,wireIntent,CPR_SPEC_DIGEST} from '../fixtures/gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {decodeCurrent,need} from '../../utils/gradleOwnedCurrentSchema.js';
import * as wire from '../fixtures/gradleOwnedCprAWire.js';
const budget={bytes:1048576,fragments:4096,work:67108864};
function fixture(options:Parameters<typeof cprFixture>[0]={},limits=budget){const f=cprFixture(options),p=f.plan();let now=0,allowed=true,hook=()=>{};const codec=new ClosedCwcBCodec({context:f.ctx,budget:limits,now:()=>now,deadline:4500,gate:()=>{need(allowed,'permission_denied');hook();}});
 function parts(q:typeof p.commands[number]){return q.payload.ranges.map(r=>{const src=Buffer.from(r.kind==='commit'?f.source.commits[r.index]!:f.source.payloads[r.index]!,'base64');return Buffer.from(src.subarray(r.offset,r.offset+r.length));});}
 return {f,p,codec,parts,setNow:(n:number)=>now=n,revoke:()=>allowed=false,hook:(h:()=>void)=>hook=h};}
function compareAll(f:ReturnType<typeof fixture>,signed=false){let comparisons=0,verifications=0;for(const q of f.p.commands){const receipt=f.codec.planProof(q),proof=f.codec.inspectProof(receipt,q),oracle=cwcBOracle(f.f.ctx,q,f.parts(q),signed?f.f.keys:undefined);
 expect({request:proof.request,reply:proof.reply,frames:proof.frames,total:proof.total}).toEqual(wire.exact(f.f.ctx,q));
 for(const v of oracle.vectors){assertCwcBBytes(f.codec.encode(v.domain as CwcBDomain,v.input,q),v.bytes);comparisons++;}
 const {requestDigest,...intent}=q;assertCwcBBytes(f.codec.encode('command.full',q),Buffer.from(canonical(q)));assertCwcBBytes(f.codec.encode('wireIntent.preimage',{domain:'cpr.wire-intent.v3',command:intent}),Buffer.from(canonical({domain:'cpr.wire-intent.v3',command:intent})));comparisons+=2;verifications+=oracle.signatureVerifications;
 expect(proof.request).toBe(oracle.request.length);expect(proof.reply).toBe(oracle.reply.length);expect(proof.frames).toEqual(oracle.auth.map(b=>b.length));}
 return {comparisons,verifications};}
it('CWB01: compiles only the fourteen closed canonical domains within logical workspace caps',()=>{
 const f=fixture(),d=f.codec.diagnostics;expect(d.domains).toBe(CWC_DOMAINS.length);expect(d.domains).toBe(14);expect(d.fixedBytes).toBeLessThanOrEqual(81920);expect(d.fragments).toBeLessThanOrEqual(4096);expect(d.logicalWorkspaceReserved).toBe(393216);
});
it('CWB02: all commands match the independent codec including unsigned preimages and signed envelopes',()=>{
 const f=fixture(),r=compareAll(f);expect(r.comparisons).toBe(14*f.p.commands.length);expect(r.verifications).toBe(0);
});
it('CWB03: real Ed25519 owner and auth signatures match without a second signature in composition',()=>{
 const f=fixture(),r=compareAll(f,true);expect(r.verifications).toBe(6*f.p.commands.length);expect(r.comparisons).toBe(14*f.p.commands.length);
});
it('CWB04: broker origin and maximum ASCII identifiers match the independent codec',()=>{
 for(const role of ['reader','authority-broker'] as const){const f=fixture({role,largeIds:true});expect(compareAll(f,true).comparisons).toBe(f.p.commands.length*14);}
});
it('CWB05: four workload shapes preserve every command bound and exact wire/work estimate',()=>{
 for(const sizes of [[600,800,900,1100,1300],[600,2048,2048,2048,2048],[18000,4096,4096,4096,4096],[600,9000,9000,9000,9000]]){const f=fixture({sizes}),before=canonical(f.p);for(const [i,q]of f.p.commands.entries()){const proof=f.codec.inspectProof(f.codec.planProof(q),q),b=f.p.bounds[i]!;expect(proof.request).toBeLessThanOrEqual(b.request);expect(proof.reply).toBeLessThanOrEqual(b.reply);expect(proof.frames.every((n,i)=>n<=b.frames[i]!)).toBe(true);expect(proof.request+q.payload.ranges.length).toBe(wire.exact(f.f.ctx,q).request+q.payload.ranges.length);}expect(canonical(f.p)).toBe(before);expect(compareAll(f).comparisons).toBe(f.p.commands.length*14);}
});
it('CWB06: planning proof makes no calls to reference owner/auth/result materialization',()=>{
 const f=fixture(),spies=[vi.spyOn(wire,'owner'),vi.spyOn(wire,'frames'),vi.spyOn(wire,'exact'),vi.spyOn(wire,'result')];try{for(const q of f.p.commands)f.codec.planProof(q);for(const spy of spies)expect(spy).not.toHaveBeenCalled();expect(f.codec.diagnostics).toMatchObject({planningOwnerWireBuffers:0,planningAuthWireBuffers:0,planningPartBytesAllocated:0,planningPartHashes:0,encodes:0,proofs:f.p.commands.length});}finally{spies.forEach(s=>s.mockRestore());}
});
it('CWB07: insertion order is normalized for nested input keys and noncanonical generated bytes are rejected',()=>{
 const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!;function reverse(v:any):any{return Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reverse(x)])):v;}
 const a=f.codec.encode(v.domain as CwcBDomain,reverse(v.input),q);assertCwcBBytes(a,v.bytes);expect(()=>assertCwcBBytes(Buffer.from(JSON.stringify(reverse(v.input))),v.bytes)).toThrow('codec_layout_mismatch');
});
it('CWB08: same-length changed bytes and decoded-only equality cannot pass the oracle',()=>{
 const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!,b=Buffer.from(v.bytes);b[0]=91;expect(b.length).toBe(v.bytes.length);expect(()=>assertCwcBBytes(b,v.bytes)).toThrow('codec_layout_mismatch');expect(()=>assertCwcBBytes(Buffer.from(v.bytes.toString().replace('{','{ ')),v.bytes)).toThrow();
});
it('CWB09: request/reply, command/intent and auth unsigned/signed domains cannot be exchanged',()=>{
 for(const [from,to]of [['owner.request.signed','owner.reply.signed'],['auth.channel.request.signed','auth.channel.reply.signed'],['auth.challenge.reply.unsigned','auth.challenge.reply.signed'],['owner.request.unsigned','owner.request.signed']] as const){const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors.find(v=>v.domain===from)!;expect(()=>f.codec.encode(to,v.input,q)).toThrow();}
});
it('CWB10: unknown family, fields and missing required fields fail closed',()=>{
 for(const change of [(e:any)=>e.extra=1,(e:any)=>delete e.body,(e:any)=>e.schema='v2']){const f=fixture(),q=f.p.commands[0]!,e=structuredClone(cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!.input);change(e);expect(()=>f.codec.encode('owner.request.signed',e,q)).toThrow();}const f=fixture();expect(()=>f.codec.encode('owner.request.v2' as any,{})).toThrow('codec_profile_unsupported');
});
it('CWB11: getters, toJSON, custom prototypes and cycles are refused without evaluating suppliers',()=>{
 let evaluations=0;for(const change of [(e:any)=>Object.defineProperty(e,'x',{enumerable:true,get(){evaluations++;return 1;}}),(e:any)=>e.toJSON=()=>{evaluations++;return e;},(e:any)=>Object.setPrototypeOf(e,{x:1}),(e:any)=>Object.setPrototypeOf(e,Array.prototype),(e:any)=>e.cycle=e]){const f=fixture(),q=f.p.commands[0]!,e=structuredClone(cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!.input);change(e);expect(()=>f.codec.encode('owner.request.signed',e,q)).toThrow();}expect(evaluations).toBe(0);
});
it('CWB12: quote, slash, Unicode and surrogate identifiers are unsupported rather than reencoded',()=>{
 for(const seed of ['a"b','a\\b','日本語','\ud800','x'.repeat(129)]){const f=fixture(),q=structuredClone(f.p.commands[0]!);q.payload.plan.seed=seed;expect(()=>{q.requestDigest=wireIntent(q);f.codec.planProof(q);}).toThrow();}
});
it('CWB13: base64 width formula covers zero and all modulo-three and maximum boundaries',()=>{
 for(const n of [0,1,2,3,4,4095,4096])expect(cwcBase64Length(n)).toBe(Buffer.alloc(n).toString('base64').length);for(const n of [-1,-0,0.5,4097,NaN])expect(()=>cwcBase64Length(n)).toThrow();
});
it('CWB14: actual part bytes match at every modulo-three and maximum valid size',()=>{
 for(const n of [1,2,3,4,4095,4096]){const f=fixture({sizes:[n,1,1,1,1]}),q=f.p.commands[0]!,r=compareAll(f,true);expect(r.comparisons).toBe(f.p.commands.length*14);expect(q.payload.ranges[0]!.length).toBe(n);}
});
it('CWB15: noncanonical signature padding and base64 tail bits are rejected',()=>{
 for(const signature of ['A'.repeat(87)+'=', 'A'.repeat(85)+'B==','A'.repeat(86)+'=','*'.repeat(86)+'==']){const f=fixture(),q=f.p.commands[0]!,e:any=structuredClone(cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!.input);e.signature=signature;expect(()=>f.codec.encode('owner.request.signed',e,q)).toThrow();}
});
it('CWB16: auth sequence and TTL digit widths match at all allowed boundaries',()=>{
 for(const sequence of [1,9,10,99,100,512])for(const ttlMs of [1,9,10,99,100,999,1000,4500]){const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors.find(v=>v.domain==='auth.channel.request.unsigned')!,e:any=structuredClone(v.input);e.body.sequence=sequence;e.body.ttlMs=ttlMs;assertCwcBBytes(f.codec.encode(v.domain as CwcBDomain,e),Buffer.from(canonical(e)));}
});
it('CWB17: out-of-range sequence, TTL, unsafe integers and negative zero cannot obtain a proof',()=>{
 for(const [key,value]of [['sequence',0],['sequence',513],['ttlMs',0],['ttlMs',4501],['sequence',-0],['sequence',1.5],['sequence',Number.MAX_SAFE_INTEGER+1]] as const){const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors.find(v=>v.domain==='auth.channel.request.signed')!,e:any=structuredClone(v.input);e.body[key]=value;expect(()=>f.codec.encode(v.domain as CwcBDomain,e)).toThrow();}
});
it('CWB18: nineteen command ordinals and count widths retain the unchanged conservative plan bound',()=>{
 const f=fixture(),c=f.f.ctx,ranges=f.p.commands[0]!.payload.ranges;for(const ordinal of [0,8,9,10,18]){const q=makeCommand(c,'seed','transfer',ordinal,19,hash('plan'),ranges),proof=f.codec.inspectProof(f.codec.planProof(q),q);expect({request:proof.request,reply:proof.reply,frames:proof.frames,total:proof.total}).toEqual(wire.exact(c,q));}
});
it('CWB19: invalid wireIntent, operation, range order and inventory cannot hide behind a structural proof',()=>{
 for(const change of [(q:any)=>q.payload.ranges.extra=1,(q:any)=>q.requestDigest=hash('wrong'),(q:any)=>{q.operationId=hash('wrong');q.requestDigest=wireIntent(q);},(q:any)=>{q.payload.ranges[0].ordinal=1;q.requestDigest=wireIntent(q);},(q:any)=>{q.payload.plan.inventoryDigest=hash('wrong');q.requestDigest=wireIntent(q);}]){const f=fixture(),q=structuredClone(f.p.commands[0]!);change(q);expect(()=>f.codec.planProof(q)).toThrow();}
});
it('CWB20: full context identity and key binding rejects same-length substitutions',()=>{
 for(const change of [(e:any)=>e.keyId='another-key',(e:any)=>e.identity.boot=hash('newboot'),(e:any)=>e.identity.credentialId='other-id']){const f=fixture(),q=f.p.commands[0]!,e:any=structuredClone(cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!.input);change(e);expect(()=>f.codec.encode('owner.request.signed',e,q)).toThrow();}
});
it('CWB21: signed result content changes cannot be passed as an unchecked length receipt',()=>{
 const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors.find(v=>v.domain==='owner.reply.signed')!,e:any=structuredClone(v.input);e.body.parts[0].bytes='AAAA';expect(()=>f.codec.encode('owner.reply.signed',e,q)).toThrow();
});
it('CWB22: proof identity and private context are not transferable to another codec root or command',()=>{
 const f=fixture(),g=fixture(),q=f.p.commands[0]!,p=f.codec.planProof(q);expect(()=>g.codec.inspectProof(p,q)).toThrow('codec_fact_binding_mismatch');const h=fixture();expect(()=>h.codec.inspectProof({kind:'cwc-b-length-proof'},q)).toThrow();const j=fixture(),r=j.codec.planProof(q);expect(()=>j.codec.inspectProof(r,j.p.commands[1]!)).toThrow();
});
it('CWB23: input and returned Buffer mutations cannot change future bytes or proof widths',()=>{
 const f=fixture(),q=structuredClone(f.p.commands[0]!),v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors[0]!,expected=Buffer.from(v.bytes),out=f.codec.encode('owner.request.signed',v.input,q);out.fill(0);(v.input as any).body.command.payload.plan.seed='changed';const again=cwcBOracle(f.f.ctx,f.p.commands[0]!,f.parts(f.p.commands[0]!)).vectors[0]!;assertCwcBBytes(f.codec.encode('owner.request.signed',again.input,f.p.commands[0]),expected);
});
it('CWB24: owner close, cancellation and original deadline invalidate receipts without extending time',()=>{
 for(const stop of ['close','cancel','deadline'] as const){const f=fixture(),q=f.p.commands[0]!,p=f.codec.planProof(q);if(stop==='close')f.codec.close();else if(stop==='cancel')f.revoke();else f.setNow(4500);expect(()=>f.codec.inspectProof(p,q)).toThrow();expect(f.codec.diagnostics.closed).toBe(true);}
});
it('CWB25: insufficient workspace, fragments and compile work refuse before context getters',()=>{
 for(const limits of [{...budget,bytes:393215},{...budget,fragments:4095},{...budget,work:131071}]){let reads=0;const c=Object.defineProperty({},'peer',{get(){reads++;return {};}});expect(()=>new ClosedCwcBCodec({context:c as any,budget:limits,gate:()=>{},now:()=>0,deadline:4500})).toThrow('codec_budget_exceeded');expect(reads).toBe(0);}
});
it('CWB26: failed semantic checks keep work consumed and prevent repeated proof execution',()=>{
 const f=fixture(),q=structuredClone(f.p.commands[0]!);q.requestDigest=hash('bad');const before=f.codec.diagnostics.workSpent;expect(()=>f.codec.planProof(q)).toThrow();expect(f.codec.diagnostics.workSpent).toBe(before+65536);expect(()=>f.codec.planProof(f.p.commands[0]!)).toThrow('owner_closed');
});
it('CWB27: insufficient proof budget prevents command evaluation and preserves earlier work',()=>{
 const f=fixture({}, {...budget,work:131072+65535});let reads=0;const q=Object.defineProperty({},'payload',{get(){reads++;return {};}});expect(()=>f.codec.planProof(q)).toThrow('codec_budget_exceeded');expect(reads).toBe(0);expect(f.codec.diagnostics.workSpent).toBe(131072);
});
it('CWB28: post-encode expiry and swallowed reentry cannot return a successful buffer',()=>{
 const f=fixture(),q=f.p.commands[0]!;let calls=0;f.hook(()=>{if(++calls===2)f.setNow(4500);});expect(()=>f.codec.encode('command.full',q)).toThrow('request_expired');const g=fixture();g.hook(()=>{g.hook(()=>{});expect(()=>g.codec.planProof(g.p.commands[0])).toThrow('codec_fact_binding_mismatch');});expect(()=>g.codec.planProof(g.p.commands[0])).toThrow();
});
it('CWB29: actual session owner/auth bytes match without changing runtime frames or dispatch counts',async()=>{
 const sessions:any[]=[];for(const role of ['reader','authority-broker'] as const){const baseline=cprBCase('B-independent',{role}),observed=cprBCase('B-independent',{role});const ctx=observed.ctx,codec=new ClosedCwcBCodec({context:ctx,budget,gate:()=>{},now:()=>0,deadline:4500});let comparisons=0,auth=0,owners=0;const expected=new Map<string,any>(),original=observed.server.receive.bind(observed.server);
 const spy=vi.spyOn(observed.server,'receive').mockImplementation(async(channel,packet)=>{const response=await original(channel,packet);for(const p of [packet,response]){const originalWire=Buffer.from(p.wire),originalInner=p.inner&&Buffer.from(p.inner);const e:any=decodeCurrent(p.wire);if(e.body.api!=='aux.ReadSourceRanges')continue;
  if(packet.inner){const request:any=decodeCurrent(packet.inner);expected.set(request.body.command.requestDigest,request.body.command);}
  const name=`auth.${e.body.kind}.${e.direction}` as const,pre={domain:e.schema,direction:e.direction,keyId:e.keyId,body:e.body};assertCwcBBytes(codec.encode(`${name}.signed` as CwcBDomain,e),p.wire);assertCwcBBytes(codec.encode(`${name}.unsigned` as CwcBDomain,pre),Buffer.from(canonical(pre)));comparisons+=2;auth++;
  if(p.inner){const o:any=decodeCurrent(p.inner,8192),q=o.direction==='request'?o.body.command:expected.get(o.body.requestDigest),{signature,...unsigned}=o;need(q,'binding_mismatch');assertCwcBBytes(codec.encode(`owner.${o.direction}.signed` as CwcBDomain,o,q),p.inner);assertCwcBBytes(codec.encode(`owner.${o.direction}.unsigned` as CwcBDomain,unsigned,q),Buffer.from(canonical(unsigned)));comparisons+=2;owners++;}expect(p.wire.equals(originalWire)).toBe(true);if(p.inner)expect(p.inner.equals(originalInner!)).toBe(true);
 }return response;});
 try{const a=await baseline.transfer(),b=await observed.transfer();expect(b.outputDigest).toBe(a.outputDigest);expect(b.planDigest).toBe(a.planDigest);expect(b.requests).toBe(a.requests);expect(b.wireBytes).toBe(a.wireBytes);expect(b.clientPlans).toBe(a.clientPlans);expect(b.providerPlans).toBe(a.providerPlans);expect(observed.provider.metrics.loads).toBe(baseline.provider.metrics.loads);expect(observed.provider.metrics.validatedBytes).toBe(baseline.provider.metrics.validatedBytes);const {sessionId:aSession,...aClient}=baseline.client.diagnostics,{sessionId:bSession,...bClient}=observed.client.diagnostics;expect(bSession).not.toBe(aSession);expect(bClient).toEqual(aClient);expect(observed.server.diagnostics).toEqual(baseline.server.diagnostics);expect(auth).toBe(4*b.requests);expect(owners).toBe(2*b.requests);expect(comparisons).toBe(12*b.requests);sessions.push({role,requests:b.requests,authFrames:auth,ownerEnvelopes:owners,comparisons,wireBytes:b.wireBytes,clientPlans:b.clientPlans,providerPlans:b.providerPlans,outputDigest:b.outputDigest,planDigest:b.planDigest,baselineWireBytes:a.wireBytes,sourceLoads:observed.provider.metrics.loads,baselineSourceLoads:baseline.provider.metrics.loads,validatedBytes:observed.provider.metrics.validatedBytes,baselineValidatedBytes:baseline.provider.metrics.validatedBytes,randomSessionIdsDiffer:bSession!==aSession,semanticOutputsMatched:b.outputDigest===a.outputDigest&&b.planDigest===a.planDigest,wireUnchanged:true,sessionAdapterChanged:false});}finally{spy.mockRestore();baseline.close();observed.close();codec.close();}
 }
 if(process.env.CWC_B_SESSION_EVIDENCE_PATH)writeFileSync(process.env.CWC_B_SESSION_EVIDENCE_PATH,JSON.stringify(sessions));
});
it('CWB30: a length proof never claims content, signing, approval or production adoption',()=>{
 const f=fixture(),q=f.p.commands[0]!,p=f.codec.inspectProof(f.codec.planProof(q),q);expect(p).toMatchObject({proofKind:'closed-tree-length-only',contentProven:false,authorityGranted:false,compositionOracleRequired:true});expect(Object.getOwnPropertyNames(ClosedCwcBCodec.prototype)).not.toContain('sign');expect(Object.getOwnPropertyNames(ClosedCwcBCodec.prototype)).not.toContain('promote');expect(command(q).payload.plan.specDigest).toBe(CPR_SPEC_DIGEST);
});

it('CWB31: recorded matrix counts are derived from every executed command and domain',()=>{
 const samples=runCwcBMatrix();expect(samples).toHaveLength(16);expect(new Set(samples.map(s=>[s.workload,s.role,s.largeIds].join(':'))).size).toBe(16);
 for(const s of samples){expect(s.comparisons).toBe(14*s.commands);expect(s.signatureVerifications).toBe(6*s.commands);expect(s.diagnostics.planningOwnerWireBuffers).toBe(0);expect(s.diagnostics.planningAuthWireBuffers).toBe(0);expect(s.semanticPlanUnchanged).toBe(true);}
 if(process.env.CWC_B_EVIDENCE_PATH)writeFileSync(process.env.CWC_B_EVIDENCE_PATH,JSON.stringify(samples));
});
it('CWB32: an oracle mismatch closes the diagnostic family and invalidates earlier receipts',()=>{
 const f=fixture(),q=f.p.commands[0]!,proof=f.codec.planProof(q),wrong=Buffer.from(canonical(q));wrong[0]=91;
 expect(()=>f.codec.compareOracle('command.full',q,wrong)).toThrow('codec_layout_mismatch');expect(f.codec.diagnostics.closed).toBe(true);expect(()=>f.codec.inspectProof(proof,q)).toThrow('owner_closed');
});

it('CWB33: epoch and generation decimal widths match through the largest safe integer',()=>{
 const f=cprFixture(),ranges=f.plan().commands[0]!.payload.ranges;
 for(const n of [1,9,10,99,100,9999,10000,Number.MAX_SAFE_INTEGER]){const c=structuredClone(f.ctx);c.peer.keyEpoch=n;c.provider.keyEpoch=n;c.lineage.generation=n;c.binding.generation=n;
 const codec=new ClosedCwcBCodec({context:c,budget,gate:()=>{},now:()=>0,deadline:4500}),q=makeCommand(c,'seed','transfer',0,1,hash('numeric-boundary'),ranges),p=codec.inspectProof(codec.planProof(q),q);
 expect({request:p.request,reply:p.reply,frames:p.frames,total:p.total}).toEqual(wire.exact(c,q));codec.close();}
});
it('CWB34: hash width, alphabet and unsupported auth kinds cannot use an existing layout',()=>{
 for(const value of ['a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'g'.repeat(64)]){const f=fixture(),q=f.p.commands[0]!,v=cwcBOracle(f.f.ctx,q,f.parts(q)).vectors.find(v=>v.domain==='auth.channel.request.signed')!,e:any=structuredClone(v.input);e.body.clientNonce=value;expect(()=>f.codec.encode(v.domain as CwcBDomain,e)).toThrow();}
 const f=fixture();expect(()=>f.codec.encode('auth.client-hello.request.signed' as any,{})).toThrow('codec_profile_unsupported');
});

it('CWB35: length-only proof does not bypass full receiver checks for rehashed content or missing parts',async()=>{
 for(const mutation of ['rehashed-content','missing-part'] as const){const f=cprBCase('B-independent',{mutateResult:(body:any)=>{if(body.schema!=='osv-mcp.cgp.range-result.v3')return;if(mutation==='missing-part')body.parts.pop();else{const p=body.parts[0],b=Buffer.from(p.bytes,'base64');b[0]=b[0]!^1;p.bytes=b.toString('base64');p.sha256=sha(b);}}});
 try{await expect(f.transfer()).rejects.toThrow();}finally{f.close();}}
});
