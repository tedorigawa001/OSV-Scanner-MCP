import {expect,it,vi} from 'vitest';
import {writeFileSync} from 'node:fs';
import {generateKeyPairSync,sign} from 'node:crypto';
import {signedServiceFrame,serviceTestKeys} from '../fixtures/gradleOwnedServiceContract.js';
import {CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
import {Vf0Approval} from '../fixtures/gradleOwnedCwcVf0Approval.js';
import {Vf0Authority} from '../fixtures/gradleOwnedCwcVf0Authority.js';
import {vf0ApprovalFixture} from '../fixtures/gradleOwnedCwcVf0Fixture.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {VF0_MAP,VF0_POLICY,VF0_LAYOUT} from '../fixtures/gradleOwnedCwcVf0Map.js';
import {ownedSha256 as sha,ownedDigest as hash,canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
import {vf0Fixture} from '../fixtures/gradleOwnedCwcVf0Fixture.js';
import * as protocol from '../fixtures/gradleOwnedCprBProtocol.js';
import * as signer from '../fixtures/gradleOwnedCprBSigner.js';
it('VF001: actual signed validators, mapped live nodes and ready-only elision in both modes',()=>{
 for(const mode of ['full-verify','fact-live'] as const){const f=vf0Fixture({mode}),challenge=vi.spyOn(protocol,'validateChallengeExchange'),channel=vi.spyOn(protocol,'validateChannelFrame'),owner=vi.spyOn(signer,'verifyOwnerValue');
 try{f.capture();f.seal();f.engine.check();const returned=f.engine.command();expect(returned).toEqual(f.command);f.engine.nested();f.engine.closeScope();expect(f.engine.finish().api).toBe(f.command.api);const s=f.engine.stats();expect(s.metrics.full).toBe(mode==='full-verify'?11:4);expect(s.metrics.fact).toBe(mode==='fact-live'?7:0);expect(challenge).toHaveBeenCalledTimes(s.metrics.full+1);expect(channel).toHaveBeenCalledTimes(s.metrics.full);expect(owner).toHaveBeenCalledTimes(s.metrics.full);expect(s.metrics.publications).toBe(1);expect(s.budget.heldBytes).toBe(0);expect(s.metrics.privateReferences).toBe(0);}finally{challenge.mockRestore();channel.mockRestore();owner.mockRestore();f.close();}}
});

const proofs:any[]=[],admissions:any[]=[];
const modes=['full-verify','fact-live'] as const;
function observe(id:string,f:ReturnType<typeof vf0Fixture>,action:()=>void,expected:'complete'|'refused',extra:Record<string,unknown>={}){
 const challenge=vi.spyOn(protocol,'validateChallengeExchange'),channel=vi.spyOn(protocol,'validateChannelFrame'),owner=vi.spyOn(signer,'verifyOwnerValue');let error:string|null=null;
 try{try{action();}catch(e){if(expected==='refused'){if(extra.nonErrorThrow)expect(e,id).toBe(0);else expect(e,id).toBeInstanceOf(CurrentControlError);}error=String(e);}if(expected==='refused')expect(error,id).not.toBeNull();else expect(error,id).toBeNull();
  const beforeClose=f.engine.stats();f.close();const after=f.engine.stats();proofs.push({id,expected,error,beforeClose,after,actual:{challenge:challenge.mock.calls.length,channel:channel.mock.calls.length,owner:owner.mock.calls.length},approval:{envelope:f.approval.envelope,registry:f.approval.registry,pin:f.approval.pin},authority:f.authority.snapshot(),...extra});return {beforeClose,after};
 }finally{challenge.mockRestore();channel.mockRestore();owner.mockRestore();f.close();}
}
it('VF002: twelve role/API/mode examples reconstruct the same verified command and retain finish verification',()=>{
 for(const mode of modes)for(const role of ['reader','authority-broker'] as const)for(const api of ['aux.ReadSourceDescriptor','aux.ReadSealedSource','aux.ReadSourceRanges'] as const){const f=vf0Fixture({mode,role,api}),digests={expectedCommandDigest:hash(f.command),actualCommandDigest:''};const r=observe('normal/'+mode+'/'+role+'/'+api,f,()=>{f.capture();f.seal();f.engine.check();const returned=f.engine.command();expect(returned).toEqual(f.command);digests.actualCommandDigest=hash(returned);f.engine.nested();f.engine.closeScope();expect(f.engine.finish().requestDigest).toBe(f.command.requestDigest);},'complete',{role,api,digests});expect(r.after.metrics.full).toBe(mode==='full-verify'?11:4);expect(r.after.metrics.fact).toBe(mode==='fact-live'?7:0);expect(r.after.metrics.live).toBe(14);expect(r.after.metrics.publications).toBe(1);}
});
it('VF003: unsafe or unsupported profile inputs cannot enable a fixture',()=>{
 for(const mode of modes){const a=vf0ApprovalFixture();a.revoke();const deniedBudget=new Lb0Budget();expect(()=>vf0Fixture({mode,approval:a,budget:deniedBudget})).toThrow('codec_profile_unsupported');admissions.push({id:'approval/'+mode,held:deniedBudget.stats().heldBytes,peak:deniedBudget.stats().peakBytes});
 for(const ownership of ['opaque-callback','shared-alias','remote-unnotified']){const budget=new Lb0Budget();expect(()=>vf0Fixture({mode,ownership,budget})).toThrow('codec_profile_unsupported');admissions.push({id:ownership+'/'+mode,held:budget.stats().heldBytes,peak:budget.stats().peakBytes});}for(const fake of ['authority','clock']){const budget=new Lb0Budget();expect(()=>vf0Fixture({mode,budget,configure:c=>{(c as any)[fake]={};}})).toThrow('codec_profile_unsupported');admissions.push({id:fake+'/'+mode,held:budget.stats().heldBytes,peak:budget.stats().peakBytes});}
 expect(()=>vf0Fixture({mode,gateLimit:4097})).toThrow('codec_profile_unsupported');expect(()=>vf0Fixture({mode,configure:c=>{(c as any).mode='legacy';}})).toThrow('codec_profile_unsupported');}
});
it('VF004: independent source approval refuses signature, source and policy substitution',()=>{
 const a=vf0ApprovalFixture();for(const fault of ['signature','source','policy','pin']){const e=structuredClone(a.envelope),r=structuredClone(a.registry),sources={...a.sources};let pin=a.pin;
 if(fault==='signature')e.signature='A'.repeat(86)+'==';if(fault==='source')sources['src/test/fixtures/gradleOwnedCwcVf0.ts']=Buffer.from('export const forged=true;');if(fault==='policy')(e.manifest as any).policyDigest=sha('other');if(fault==='pin')pin=sha('other');
 expect(()=>new Vf0Approval(e,r,pin,sources,()=>pin)).toThrow('codec_profile_unsupported');}
});
it('VF005: hostile Buffer brands, copy overrides, shared backing, packet getters and proxies are rejected before copies',()=>{
 for(const mode of modes)for(const fault of ['copy','sab','getter','proxy','prototype']){const f=vf0Fixture({mode});if(fault==='copy')(f.packet.inner as any).copy=()=>{};if(fault==='sab')(f.packet as any).inner=Buffer.from(new SharedArrayBuffer(f.packet.inner.length));let getterCalls=0;let packet:any=f.packet;
 if(fault==='getter')Object.defineProperty(packet,'inner',{get(){getterCalls++;return Buffer.from('{}');},enumerable:true});if(fault==='proxy')packet=new Proxy(packet,{});if(fault==='prototype')Object.setPrototypeOf(packet,Object.create(null));
 const r=observe('hostile/'+mode+'/'+fault,f,()=>f.engine.capture(packet),'refused');expect(r.after.metrics.inputCopies).toBe(0);expect(getterCalls).toBe(0);expect(r.after.metrics.publications).toBe(0);}
});
it('VF006: capture owns dedicated bytes and result copies never alias the private request',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});observe('copies/'+mode,f,()=>{f.capture();for(const b of Object.values(f.packet))new Uint8Array(b.buffer).fill(0);f.seal();const q=f.engine.command();q.operationId='changed';expect(f.engine.command()).toEqual(f.command);expect(f.engine.finish().requestDigest).toBe(f.command.requestDigest);},'complete');}
});
it('VF007: invalid initial challenge, channel and owner bodies fail real validation',()=>{
 for(const mode of modes)for(const part of ['request','reply','outer','inner'] as const){const f=vf0Fixture({mode});f.packet[part].fill(0);const r=observe('signature/'+mode+'/'+part,f,()=>f.capture(),'refused');expect(r.after.metrics.boundIssued).toBe(0);expect(r.after.metrics.publications).toBe(0);}
});
it('VF008: unbound facts, fake tokens and different scope, owner, call or association are not capabilities',()=>{
 for(const mode of modes)for(const kind of ['unbound','fake-bound','scope','owner','call','actual-association']){const f=vf0Fixture({mode});const r=observe('binding/'+mode+'/'+kind,f,()=>{f.capture();if(kind==='unbound')f.engine.command();else if(kind==='fake-bound'){f.seal();f.engine.check({kind:'vf0-verification-binding'});}else if(kind==='scope')f.engine.seal({kind:'vf0-scope'});else if(kind==='owner')f.engine.seal(f.engine.scope,{kind:'vf0-owner'});else if(kind==='call')f.engine.seal(f.engine.scope,f.engine.owner,{kind:'vf0-diagnostic-call'});else f.engine.seal(f.engine.scope,f.engine.owner,f.engine.call,'actual-session');},'refused');expect(r.after.metrics.commands).toBe(0);expect(r.after.metrics.publications).toBe(0);}
});
it('VF009: capture and seal claims cannot be repeated or revived',()=>{
 for(const mode of modes)for(const stage of ['capture','seal']){const f=vf0Fixture({mode});const r=observe('repeat/'+mode+'/'+stage,f,()=>{f.capture();if(stage==='capture')f.capture();else{f.seal();f.seal();}},'refused');expect(r.after.claimed).toBe(true);expect(()=>f.capture()).toThrow();}
});
it('VF010: current credentials, purpose, permissions and pins remain live across every ready check',()=>{
 for(const mode of modes)for(const domain of ['peer-credential','server-credential','purpose','permissions','registry-pin','source-pin','profile-pin','callback-policy','key-epoch'] as const){const f=vf0Fixture({mode});const r=observe('authority/'+mode+'/'+domain,f,()=>{f.capture();f.seal();f.authority.change(domain==='peer-credential'||domain==='server-credential'?{domain,value:false}:domain==='purpose'?{domain,value:'publication'}:domain==='permissions'?{domain,value:[]}:domain==='callback-policy'?{domain,value:1}:domain==='key-epoch'?{domain,subject:'server',value:2}:{domain,value:sha('revoked')});f.engine.check();},'refused');expect(r.after.metrics.publications).toBe(0);}
});
it('VF011: final now callback mutation is caught even while the control generation stays unchanged',()=>{
 for(const mode of modes)for(const restore of [false,true]){const f=vf0Fixture({mode});let oldGeneration=0,changedGeneration=0,attempts=0;const r=observe('final-revision/'+mode+'/'+restore,f,()=>{f.capture();f.seal();oldGeneration=f.engine.stats().generation;f.hooks.now=info=>{if(info.phase==='finish'&&info.edge==='operation-post'&&!attempts++){f.authority.change({domain:'peer-credential',value:false});if(restore)f.authority.change({domain:'peer-credential',value:true});changedGeneration=f.engine.stats().generation;}};f.engine.finish();},'refused',{restore});expect(attempts).toBe(1);expect(changedGeneration).toBe(oldGeneration);expect(r.after.metrics.publications).toBe(0);expect(r.after.reason).toBe('permission_denied');}
});
it('VF012: recorded revocation, authority restart and restored source approval cannot revive a binding',()=>{
 for(const mode of modes)for(const fault of ['restore','restart','approval']){const f=vf0Fixture({mode});observe('sticky/'+mode+'/'+fault,f,()=>{f.capture();f.seal();if(fault==='restart')f.authority.restart();else if(fault==='restore'){f.authority.change({domain:'purpose',value:'publication'});f.authority.change({domain:'purpose',value:'read'});}else{f.approval.revoke();try{f.engine.check();}catch{}f.approval.restore();}f.engine.check();},'refused');}
});
it('VF013: swallowed external reentry poisons capture, seal and ready operations in both modes',()=>{
 for(const mode of modes)for(const stage of ['capture','seal','check','copy','finish'])for(const hook of ['current','now','credential-peer','purpose','permissions']){const f=vf0Fixture({mode});let attempts=0;const r=observe('reentry/'+mode+'/'+stage+'/'+hook,f,()=>{if(stage!=='capture')f.capture();if(!['capture','seal'].includes(stage))f.seal();f.hooks[hook]=()=>{if(!attempts++){try{if(stage==='capture')f.capture();else if(stage==='seal')f.seal();else f.engine.check();}catch{}}};if(stage==='capture')f.capture();else if(stage==='seal')f.seal();else if(stage==='check')f.engine.check();else if(stage==='copy')f.engine.command();else f.engine.finish();},'refused');expect(attempts).toBe(1);expect(r.after.metrics.publications).toBe(0);if(stage==='capture'||stage==='seal')expect(r.after.metrics.boundIssued).toBe(0);}
});
it('VF014: scope close during callbacks cannot rescue an outer seal or command publication',()=>{
 for(const mode of modes)for(const stage of ['seal','copy']){const f=vf0Fixture({mode});const r=observe('scope-close/'+mode+'/'+stage,f,()=>{f.capture();if(stage==='copy')f.seal();let once=false;f.hooks.current=()=>{if(!once){once=true;f.engine.closeScope();}};if(stage==='seal')f.seal();else f.engine.command();},'refused');expect(r.after.metrics.commands).toBe(0);if(stage==='seal')expect(r.after.metrics.boundIssued).toBe(0);}
});
it('VF015: nested fixed checks remain fresh, while external frames and replacement attempts are rejected',()=>{
 for(const mode of modes)for(const fault of ['frame','storage','publish']){const f=vf0Fixture({mode});const r=observe('private/'+mode+'/'+fault,f,()=>{f.capture();f.seal();f.engine.nested();if(fault==='frame')f.engine.check(undefined,undefined,{authorized:true});else if(fault==='storage')f.engine.rejectReplacement();else f.engine.rejectUnsafePublish();},'refused');expect(r.after.metrics.publications).toBe(0);}
});
it('VF016: ownership and original deadlines hold at final callbacks, copy and the private final clock',()=>{
 for(const mode of modes)for(const boundary of ['current','now','copy']){const f=vf0Fixture({mode});const r=observe('deadline/'+mode+'/'+boundary,f,()=>{f.capture();f.seal();f.hooks[boundary]=()=>{f.clock.advance(4500);};if(boundary==='copy')f.engine.command();else f.engine.finish();},'refused');expect(r.after.reason).toBe('request_expired');expect(r.after.metrics.publications).toBe(0);}
});
it('VF017: clocks cannot go backward, become nonintegral, or extend a shortened original deadline',()=>{
 for(const mode of modes)for(const kind of ['backward','noninteger','extend','tightened']){const f=vf0Fixture({mode});observe('clock/'+mode+'/'+kind,f,()=>{f.capture();f.seal();if(kind==='noninteger'){f.hooks.now=()=>0.5;f.engine.check();}else if(kind==='extend')f.engine.tighten(4501);else if(kind==='tightened'){f.engine.tighten(10);f.clock.advance(10);f.engine.finish();}else{f.clock.advance(10);f.engine.check();f.hooks.now=()=>9;f.engine.check();}},'refused');}
});
it('VF018: the final clock is private state; replacing public clock methods cannot forge publication time',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});observe('intrinsic/'+mode,f,()=>{f.capture();f.seal();f.hooks.now=info=>{if(info.edge==='operation-post'&&info.phase==='finish'){f.clock.advance(4500);return 0;}};f.engine.finish();},'refused');}
});
it('VF019: no memory or initialization work can be borrowed after capture has started',()=>{
 for(const mode of modes)for(const kind of ['memory','work']){const balance={initialization:0,work:0,wire:0,attempts:0},budget=new Lb0Budget(balance,262144,kind==='work'?5000:156978),f=vf0Fixture({mode,budget});const blocker=kind==='memory'?budget.reserve(24577):undefined;const r=observe('budget/'+mode+'/'+kind,f,()=>f.capture(),'refused');expect(r.after.metrics.inputCopies).toBe(0);expect(r.after.claimed).toBe(true);if(blocker)budget.release(blocker);}
});
it('VF020: logical check limits are identical under full verification and fact reuse',()=>{
 for(const mode of modes){const f=vf0Fixture({mode,gateLimit:4});const r=observe('logical-limit/'+mode,f,()=>{f.capture();f.seal();f.engine.check();f.engine.check();},'refused');expect(r.after.logicalChecks).toBe(5);expect(r.after.metrics.live).toBe(7);}
});
it('VF021: nonnegative balance reductions are refused before private reads',()=>{
 for(const mode of modes){const balance={initialization:0,work:0,wire:0,attempts:0},f=vf0Fixture({mode,budget:new Lb0Budget(balance)});observe('balance/'+mode,f,()=>{f.capture();f.seal();const work=balance.work;balance.work=0;let error:unknown;try{f.engine.check();}catch(e){error=e;}finally{balance.work=work;}expect(error).toBeInstanceOf(CurrentControlError);throw error;},'refused');}
});
it('VF022: timeout removes lookup and reclaims bytes before a pending dispatch drains',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});let pending:ReturnType<typeof f.engine.hold>;const r=observe('pending/'+mode,f,()=>{f.capture();f.seal();pending=f.engine.hold();f.clock.advance(4500);f.engine.expire();const s=f.engine.stats();expect(s.lookup).toBe(false);expect(s.bytes).toBe(0);expect(s.pending).toBe(true);expect(s.budget.occupiedSlots).toBe(1);const before=s.metrics.reads;expect(()=>f.engine.completePending(pending)).toThrow('request_expired');expect(f.engine.stats().metrics.reads).toBe(before);f.engine.drain(pending);f.engine.completePending(pending);},'refused');expect(r.after.pending).toBe(false);expect(r.after.budget.occupiedSlots).toBe(0);expect(r.after.metrics.publications).toBe(0);}
});
it('VF023: invalidation while a private reader is held defers zero until its finally',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});const r=observe('reader/'+mode,f,()=>{f.capture();f.seal();f.engine.faultNextRead();f.engine.finish();},'refused');const held=r.after.events.find(e=>e.name==='reader-still-held'),reclaimed=r.after.events.find(e=>e.name==='bytes-reclaimed');expect(held!.readers).toBe(1);expect(held!.bytes).toBeGreaterThan(0);expect(reclaimed!.readers).toBe(0);expect(reclaimed!.order).toBeGreaterThan(held!.order);expect(r.after.metrics.reclaims).toBe(1);}
});
it('VF024: normal scope release retains storage for a complete final verification',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});observe('scope-final/'+mode,f,()=>{f.capture();f.seal();f.engine.closeScope();const s=f.engine.stats();expect(s.bytes).toBeGreaterThan(0);expect(s.lookup).toBe(true);f.engine.finish();expect(f.engine.stats().metrics.publications).toBe(1);f.engine.expire();f.close();expect(f.engine.stats().metrics.reclaims).toBe(1);},'complete');}
});
it('VF025: the structural layout stays inside the existing budgets and no runtime source is modified',()=>{
 expect(Object.values(VF0_LAYOUT.call).reduce((n,b)=>n+b,0)).toBe(VF0_POLICY.callBytes);expect(Object.values(VF0_LAYOUT.binding).reduce((n,b)=>n+b,0)).toBe(VF0_POLICY.bindingBytes);expect(Object.values(VF0_LAYOUT.session).reduce((n,b)=>n+b,0)).toBe(VF0_POLICY.baseBytes);expect(VF0_MAP.filter(x=>x.replacement==='never').length).toBe(VF0_MAP.length-4);expect(VF0_MAP.filter(x=>x.replacement==='ready-only').length).toBe(4);
});

it('VF027: non-Error throws are terminal and cannot be mistaken for successful callbacks',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});const r=observe('nonerror/'+mode,f,()=>{f.capture();f.seal();f.hooks.now=()=>{throw 0;};f.engine.finish();},'refused',{nonErrorThrow:true});expect(r.after.reason).toBe('experiment_error');expect(r.after.metrics.publications).toBe(0);}
});
it('VF028: registry identities cannot be replaced by caller projections at construction',()=>{
 for(const mode of modes)for(const side of ['peer','server'] as const)for(const field of ['instanceId','boot','keyEpoch'] as const){const budget=new Lb0Budget();expect(()=>vf0Fixture({mode,budget,configure:c=>{(c[side] as any)[field]=field==='keyEpoch'?9:field==='boot'?sha('other'):'other';}})).toThrow('peer_mismatch');expect(budget.stats().heldBytes).toBe(0);}
});
it('VF029: self re-signing a substituted source cannot replace the independently pinned approval',()=>{
 const a=vf0ApprovalFixture(),keys=generateKeyPairSync('ed25519'),sources={...a.sources,'src/test/fixtures/gradleOwnedCwcVf0.ts':Buffer.from('export const forgery=true;')},manifest={...a.envelope.manifest,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))},registry={...a.registry,manifestDigest:hash(manifest),operatorSpki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')},envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')};
 expect(()=>new Vf0Approval(envelope,registry,a.pin,sources,()=>a.pin)).toThrow('codec_profile_unsupported');
});
it('VF030: correctly re-signed mismatching challenge, channel and owner predicates are still rejected',()=>{
 for(const mode of modes){
 for(const field of ['clientNonce','serverNonce','sessionId','transcriptDigest','requestId','originDigest','ttlMs','sequence','api']){const f=vf0Fixture({mode}),body=JSON.parse(f.packet.request.toString()).body;body[field]=field==='ttlMs'?4499:field==='sequence'?9:field==='api'?'aux.ReadSealedSource':sha('other');f.packet.request=signedServiceFrame(body,'request',f.peer.credentialId);observe('challenge-field/'+mode+'/'+field,f,()=>f.capture(),'refused');}
 for(const field of ['innerWireDigest','challenge','sequence','api']){const f=vf0Fixture({mode}),body=JSON.parse(f.packet.outer.toString()).body;body[field]=field==='sequence'?9:field==='api'?'aux.ReadSealedSource':sha('other');f.packet.outer=signedServiceFrame(body,'request',f.peer.credentialId);observe('channel-field/'+mode+'/'+field,f,()=>f.capture(),'refused');}
 for(const field of ['role','instanceId','boot','keyEpoch','keyId','domain','api']){const f=vf0Fixture({mode}),value=JSON.parse(f.packet.inner.toString());if(['role','instanceId','boot','keyEpoch'].includes(field))value.identity[field]=field==='keyEpoch'?9:field==='boot'?sha('other'):field==='role'?'authority-broker':'other';else value[field]=field==='domain'?'control':field==='api'?'aux.ReadSealedSource':'other';delete value.signature;f.packet.inner=Buffer.from(canonical({...value,signature:sign(null,Buffer.from(canonical(value)),serviceTestKeys[f.peer.credentialId]!.privateKey).toString('base64')}));const outer=JSON.parse(f.packet.outer.toString()).body;outer.innerWireDigest=sha(f.packet.inner);f.packet.outer=signedServiceFrame(outer,'request',f.peer.credentialId);observe('owner-field/'+mode+'/'+field,f,()=>f.capture(),'refused');}
 }
});


it('VF031: real pending promises reject late resolve/reject continuations before any bytes read or publication',async()=>{
 for(const mode of modes)for(const outcome of ['resolve','reject']){const f=vf0Fixture({mode}),challenge=vi.spyOn(protocol,'validateChallengeExchange'),channel=vi.spyOn(protocol,'validateChannelFrame'),owner=vi.spyOn(signer,'verifyOwnerValue');let error:string|null=null;
 try{f.capture();f.seal();const token=f.engine.hold();let resolve!:(x:unknown)=>void,reject!:(x:unknown)=>void;const work=new Promise((a,b)=>{resolve=a;reject=b;});const late=outcome==='resolve'?work.then(()=>f.engine.completePending(token)):work.catch(()=>f.engine.completePending(token));f.clock.advance(4500);f.engine.expire();const reads=f.engine.stats().metrics.reads;if(outcome==='resolve')resolve({late:true});else reject(Error('late-work'));try{await late;}catch(e){expect(e).toBeInstanceOf(CurrentControlError);error=String(e);}expect(error).not.toBeNull();expect(f.engine.stats().metrics.reads).toBe(reads);f.engine.drain(token);const beforeClose=f.engine.stats();f.close();proofs.push({id:'async-late/'+mode+'/'+outcome,expected:'refused',error,beforeClose,after:f.engine.stats(),actual:{challenge:challenge.mock.calls.length,channel:channel.mock.calls.length,owner:owner.mock.calls.length},approval:{envelope:f.approval.envelope,registry:f.approval.registry,pin:f.approval.pin},authority:f.authority.snapshot()});
 }finally{challenge.mockRestore();channel.mockRestore();owner.mockRestore();f.close();}}
});

it('VF032: a distinct call keeps its own guard while the first call is inside a callback',()=>{
 for(const mode of modes){const a=vf0Fixture({mode}),b=vf0Fixture({mode});try{a.capture();a.seal();b.capture();b.seal();let entered=false;a.hooks.current=()=>{if(!entered){entered=true;b.engine.check();}};a.engine.check();expect(entered).toBe(true);a.engine.finish();b.engine.finish();expect(a.engine.stats().metrics.publications).toBe(1);expect(b.engine.stats().metrics.publications).toBe(1);}finally{a.close();b.close();}}
});

it('VF033: an expired owned clock cannot be hidden by a stale callback before a private bytes read',()=>{
 for(const mode of modes){const f=vf0Fixture({mode});let reads=0;const r=observe('read-deadline/'+mode,f,()=>{f.capture();f.seal();reads=f.engine.stats().metrics.reads;f.hooks.now=info=>{if(info.phase==='finish'&&info.edge==='inspect-entry'){f.clock.advance(4500);return 0;}};f.engine.finish();},'refused');expect(r.after.metrics.reads).toBe(reads);expect(r.after.reason).toBe('request_expired');expect(r.after.metrics.publications).toBe(0);}
});

it('VF034: finish cannot publish before seal, including after releasing an unbound scope',()=>{
 for(const mode of modes)for(const phase of ['captured','reserved','released']){const f=vf0Fixture({mode});const r=observe('unsealed-finish/'+mode+'/'+phase,f,()=>{if(phase!=='reserved')f.capture();if(phase==='released')f.engine.closeScope();const reads=f.engine.stats().metrics.reads;try{f.engine.finish();}finally{expect(f.engine.stats().metrics.reads).toBe(reads);}},'refused');expect(r.after.metrics.publications).toBe(0);expect(r.after.metrics.boundIssued).toBe(0);expect(r.after.sealed).toBe(false);expect(r.after.reason).toBe('source_binding');}
});
it('VF035: initial authority data is strict while legitimate false credentials remain denied',()=>{
 const changes:[string,(v:any)=>void][]=[
 ['peer-string',v=>v.peer='false'],['server-string',v=>v.server='false'],['missing-peer',v=>delete v.peer],['peer-epoch-string',v=>v.peerKeyEpoch='1'],['server-epoch-zero',v=>v.serverKeyEpoch=0],['registry-pin',v=>v.registryPin='invalid'],['source-pin',v=>v.sourcePin=null],['profile-pin',v=>v.profilePin=true],['permissions-type',v=>v.permissions='allow'],['permissions-extra',v=>v.permissions[0].unexpected=true],['purpose',v=>v.purpose='maintenance'],['callback-policy',v=>v.callbackPolicy='0'],['unknown-field',v=>v.unexpected=true]
 ];
 for(const mode of modes){for(const [id,change]of changes){const budget=new Lb0Budget();expect(()=>vf0Fixture({mode,budget,configure:c=>{const v=c.authority.snapshot().view;change(v);c.authority=new Vf0Authority(v);}}),id).toThrow('schema_invalid');expect(budget.stats().heldBytes).toBe(0);expect(budget.stats().peakBytes).toBe(0);admissions.push({id:'initial-view/'+mode+'/'+id,held:budget.stats().heldBytes,peak:budget.stats().peakBytes});}
 for(const side of ['peer','server']){const f=vf0Fixture({mode,configure:c=>{const v=c.authority.snapshot().view;(v as any)[side]=false;c.authority=new Vf0Authority(v);}});const r=observe('initial-denied/'+mode+'/'+side,f,()=>f.capture(),'refused');expect(r.after.metrics.publications).toBe(0);expect(r.after.reason).toBe('permission_denied');}}
});
it('VF026: evidence contains real-validator counts and scoped fixture outcomes only',()=>{
 expect(proofs.filter(r=>r.id.startsWith('normal/'))).toHaveLength(12);for(const p of proofs){expect(p.after.metrics.publications).toBe(p.expected==='complete'?1:0);if(p.id.startsWith('normal/')){expect(p.actual.challenge).toBe(p.after.metrics.full+1);expect(p.actual.channel).toBe(p.after.metrics.full);expect(p.actual.owner).toBe(p.after.metrics.full);}expect(p.after.metrics.privateReferences).toBe(0);expect(p.after.readers).toBe(0);}
 if(process.env.CWC_VF0_EVIDENCE_PATH)writeFileSync(process.env.CWC_VF0_EVIDENCE_PATH,JSON.stringify({schema:'cwc-vf0.evidence.v1',proofs,admissions,map:VF0_MAP,policy:VF0_POLICY,scope:{standalone:true,fixedClock:true,authorityOwners:1,actualSessionConnected:false,sourceStorageConnected:false,performanceMeasured:false,productionAdopted:false}}));
});
