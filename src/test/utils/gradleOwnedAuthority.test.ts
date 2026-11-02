import {it,expect,vi} from 'vitest';
import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
import {ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
function setup(limits?:ConstructorParameters<typeof OwnedAuthorityContract>[0]['limits']){const f=ownedPolicyFixture();let now=0,timeOnRead=0;const model=new OwnedAuthorityContract({authorityId:'caller',policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)},now:()=>{now+=timeOnRead;return now;},limits});return {...f,seq:0,model,caller:model.principal('caller'),reader:model.principal('reader'),advance:(ms:number)=>{now+=ms;},clockStep:(ms:number)=>{timeOnRead=ms;}};}
function call(f:ReturnType<typeof setup>,actor:object,payload:any){return f.model.dispatch(actor,{schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++f.seq),...payload});}
const requests=[{project:'main::',context:'runtime',invocation:'invocation'}];
it('begins a draft with fresh opaque identities and no backend admission',()=>{const f=setup();const r=call(f,f.caller,{operation:'begin',operationId:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(requests)});expect(r).toMatchObject({lifecycle:'draft',revision:1,backendEligible:false});expect(r.nonce).toMatch(/^[a-f0-9]{64}$/);});

import {graphFixture} from '../fixtures/gradleGraphFixture.js';
import {canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
function begin(f:ReturnType<typeof setup>,rs=requests){return call(f,f.caller,{operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(rs)});}
function upload(f:ReturnType<typeof setup>,actor:object,b:any,purpose:'core'|'seal',value:unknown,extra:any={}){
 const text=typeof value==='string'?value:canonicalOwnedJson(value,64*1024*1024),bytes=Buffer.from(text);let r:any;
 for(let ordinal=0;ordinal<Math.ceil(bytes.length/(1024*1024));ordinal++){const part=bytes.subarray(ordinal*1024*1024,(ordinal+1)*1024*1024);r=call(f,actor,{operation:'put-metadata-chunk',sessionId:b.sessionId,uploadId:purpose==='core'?b.coreUploadId:b.uploadId,purpose,expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64'),...extra});}
 return r.ref;
}
function active(f:ReturnType<typeof setup>,rs=requests,core=graphFixture(),plannedCaptures=1){
 const b=begin(f,rs),ref=upload(f,f.caller,b,'core',core);
 const plans=rs.map(r=>({...r,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures,...f.claim}));
 const bound=call(f,f.caller,{operation:'bind-core',sessionId:b.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedDigest(core,16*1024*1024),rootRegistryDigest:ownedSha256('pin'),scopes:plans});
 return {...call(f,f.caller,{operation:'activate',sessionId:b.sessionId,expectedRevision:bound.revision,expectedCurrentRevision:bound.currentRevision}),testCore:core};
}
it('uploads an immutable canonical core and activates only its declared scopes',()=>{const f=setup(),s=active(f);expect(s).toMatchObject({lifecycle:'active',validity:'current',backendEligible:false});expect(s.scopes[0]).toMatchObject({lifecycle:'planned',revision:0});expect(s.coreMetadataRef.purpose).toBe('core');});

import {ownedExecutionCase} from '../fixtures/gradleOwnedExecutionFixture.js';
import {rewriteOwned} from '../fixtures/gradleOwnedFixture.js';
function register(f:ReturnType<typeof setup>,s:any,scope=requests[0]!){
 const r=call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope,expectedRevision:0});
 return {...s,...r,scope,broker:f.model.principal('broker',s.sessionId,scope),observer:f.model.principal('observer',s.sessionId,scope)};
}
function start(f:ReturnType<typeof setup>,r:any){return {...r,...call(f,r.broker,{operation:'append-event',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}})};}
function material(r:any,state='completed',through='offer'){
 const fixture=ownedExecutionCase(state,through),doc=fixture.doc;if(r.testCore)doc.coreGraph=structuredClone(r.testCore);
 doc.graphId=r.graphId;doc.exportId=r.exportId;const coreDigest=ownedDigest(doc.coreGraph,16*1024*1024);
 rewriteOwned(doc,()=>true,v=>{for(const k of ['graphId','exportId','executionId']){if(v.binding)v.binding[k]=r[k];if(k in v)v[k]=r[k];}if(v.binding)v.binding.invocation=r.scope.invocation;if('invocation'in v)v.invocation=r.scope.invocation;if('witnessId'in v)v.witnessId=r.witnessId;if(v.binding)v.binding.coreGraphDigest=coreDigest;if('coreGraphDigest'in v)v.coreGraphDigest=coreDigest;});
 doc.ownedOfferBundles[0].invocation=r.scope.invocation;
 const witness:any=fixture.witness;Object.assign(witness.binding,{authorityId:'caller',sessionId:r.sessionId,nonce:r.nonce,graphId:r.graphId,exportId:r.exportId,executionId:r.executionId,invocation:r.scope.invocation,coreGraphDigest:coreDigest});
 Object.assign(witness,{witnessId:r.witnessId,bundleDigest:doc.ownedOfferBundles[0].bundleRef.objectDigest,envelopeDigest:doc.ownedOfferBundles[0].envelopeRef.objectDigest});
 const {coreGraph:_,...body}=doc;const projection={...body,coreMetadataRef:r.coreMetadataRef};projection.ownedOfferObjects.sort((a:any,b:any)=>a.objectDigest<b.objectDigest?-1:1);
 return {projection,witness,leases:fixture.session.leases,pair:{bundleDigest:witness.bundleDigest,envelopeDigest:witness.envelopeDigest}};
}
function observe(f:ReturnType<typeof setup>,r:any,lookup:any,leases:any[]=[]){return {...r,...call(f,r.observer,{operation:'append-event',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:r.sequence+1,previousDigest:r.ledgerHead,event:{kind:'execution-observation',lookup,leases}})};}
function prepare(f:ReturnType<typeof setup>,r:any){return {...r,...call(f,r.broker,{operation:'seal-scope',phase:'prepare',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead})};}
function seal(f:ReturnType<typeof setup>,r:any,ref?:any,pair?:any){return call(f,r.broker,{operation:'seal-scope',phase:'commit',sessionId:r.sessionId,scope:r.scope,expectedRevision:r.revision,ledgerHead:r.ledgerHead,...(ref?{sealMetadataRef:ref}:{}),...(pair?{pair}:{})});}
function complete(f:ReturnType<typeof setup>,s:any,scope=requests[0]!,change?:(m:ReturnType<typeof material>)=>void){let r=start(f,register(f,s,scope));const m=material(r);if(change)change(m);r=observe(f,r,{status:'verified',witness:m.witness},m.leases);const ref=upload(f,r.broker,r,'seal',m.projection,{scope:r.scope,witnessId:r.witnessId});r=prepare(f,r);return {r,m,ref,result:seal(f,r,ref,m.pair)};}
it('checks a full seal projection and records only a structure-verified terminal',()=>{const f=setup(),s=active(f),done=complete(f,s);expect(done.result).toMatchObject({lifecycle:'terminal',terminal:{outcome:'structure-verified',...done.m.pair},backendEligible:false,diagnosticEligible:false,ownedFileReads:0});expect(f.model.inspect(f.caller,s.sessionId).lifecycle).toBe('committed');expect(call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope:requests[0],expectedRevision:0})).toMatchObject({contractStatus:'structure-verified',readerProjection:{status:'unavailable',reason:'backend-unsupported'}});});
it('keeps B active after A commits and aggregates only after B aborts',()=>{const f=setup(),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs);const done=complete(f,s,rs[0]);const b=start(f,register(f,s,rs[1]));expect(f.model.inspect(f.caller,s.sessionId).lifecycle).toBe('active');call(f,f.caller,{operation:'abort',sessionId:s.sessionId,scope:b.scope,expectedRevision:b.revision,reason:'operator-request'});const snapshot=f.model.inspect(f.caller,s.sessionId);expect(snapshot.lifecycle).toBe('committed');expect(snapshot.scopes[0].terminal).toEqual(done.result.terminal);expect(snapshot.scopes[1].terminal.outcome).toBe('unavailable');});
it('a malformed closure invalidates only its scope',()=>{const f=setup(),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs);const bad=complete(f,s,rs[0],m=>{m.projection.ownedOfferObjects.pop();});expect(bad.result.terminal.outcome).toBe('invalid');expect(f.model.inspect(f.caller,s.sessionId).lifecycle).toBe('active');const good=complete(f,s,rs[1]);expect(good.result.terminal.outcome).toBe('structure-verified');});

it('rejects forged actors without evaluating any input getter',()=>{const f=setup();let reads=0;const command={get operation(){reads++;return 'begin';}};expect(()=>f.model.dispatch({},command)).toThrow('permission_denied');expect(reads).toBe(0);});
it('rejects callbacks, accessors and proxies as data without invoking them',()=>{const f=setup();let calls=0;for(const input of [{get operation(){calls++;return 'begin';}},{operation:()=>{calls++;}},new Proxy({},{ownKeys(){calls++;return [];}})])expect(()=>f.model.dispatch(f.caller,input)).toThrow('schema_invalid');expect(calls).toBe(0);});
it('idempotent begin retry returns the same draft but changed payload is rejected',()=>{const f=setup();const c={operation:'begin',operationId:'same',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(requests)};const a=call(f,f.caller,c),b=call(f,f.caller,c);expect(b).toMatchObject({...a,historical:true});expect(()=>call(f,f.caller,{...c,scanRunId:'other'})).toThrow('replay_conflict');});
it('does not expose mutable internal state or launch capabilities to inspection',()=>{const f=setup(),s=active(f),r=register(f,s);const a=f.model.inspect(f.reader,s.sessionId);expect(JSON.stringify(a)).not.toContain(r.capability);a.scopes[0].lifecycle='terminal';expect(f.model.inspect(f.reader,s.sessionId).scopes[0].lifecycle).toBe('registered');});
it('one scope can succeed while another succeeds, in either order',()=>{for(const reverse of [false,true]){const f=setup(),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs);const order=reverse?[...rs].reverse():rs;for(const scope of order){expect(complete(f,s,scope).result.terminal.outcome).toBe('structure-verified');}const view=f.model.inspect(f.reader,s.sessionId);expect(view.lifecycle).toBe('committed');expect(view.scopes.map((x:any)=>x.terminal.outcome)).toEqual(['structure-verified','structure-verified']);}});
it('a sealing scope does not stop another scope from registering, starting and sealing',()=>{const f=setup(),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs);let a=start(f,register(f,s,rs[0]));const m=material(a);a=observe(f,a,{status:'verified',witness:m.witness},m.leases);const ref=upload(f,a.broker,a,'seal',m.projection,{scope:a.scope,witnessId:a.witnessId});a=prepare(f,a);expect(f.model.inspect(f.reader,s.sessionId).lifecycle).toBe('active');expect(complete(f,s,rs[1]).result.terminal.outcome).toBe('structure-verified');expect(seal(f,a,ref,m.pair).terminal.outcome).toBe('structure-verified');});
it('late events and new seal operations cannot reopen a terminal',()=>{const f=setup(),s=active(f),done=complete(f,s);expect(()=>call(f,done.r.observer,{operation:'append-event',sessionId:s.sessionId,scope:done.r.scope,expectedRevision:done.result.revision,sequence:done.result.sequence+1,previousDigest:done.result.ledgerHead,event:{kind:'execution-observation',lookup:{status:'unavailable',reason:'receipt-missing'},leases:[]}})).toThrow('lifecycle_invalid');expect(()=>seal(f,{...done.r,revision:done.result.revision},done.ref,done.m.pair)).toThrow('lifecycle_invalid');});
it('a caller cannot act on another caller session and a broker cannot use a different scope',()=>{const f=setup(),s=active(f),r=register(f,s);expect(()=>call(f,f.model.principal('caller'),{operation:'register-scope',sessionId:s.sessionId,scope:r.scope,expectedRevision:0})).toThrow('permission_denied');expect(()=>call(f,r.broker,{operation:'seal-scope',phase:'prepare',sessionId:s.sessionId,scope:{...r.scope,invocation:'other'},expectedRevision:1,ledgerHead:r.ledgerHead})).toThrow('permission_denied');});
it('only a broker can start and only an observer can supply observations',()=>{const f=setup(),s=active(f),r=register(f,s);expect(()=>call(f,r.observer,{operation:'append-event',sessionId:s.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}})).toThrow('permission_denied');const b=start(f,r);expect(()=>call(f,b.broker,{operation:'append-event',sessionId:s.sessionId,scope:b.scope,expectedRevision:b.revision,sequence:2,previousDigest:b.ledgerHead,event:{kind:'execution-observation',lookup:{status:'unavailable',reason:'receipt-missing'},leases:[]}})).toThrow('permission_denied');});
for(const mutation of ['sequence','head','revision','capability'])it('rejects altered action-start '+mutation+' atomically',()=>{const f=setup(),s=active(f),r=register(f,s);const before=f.model.inspect(f.reader,s.sessionId);const c:any={operation:'append-event',sessionId:s.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}};if(mutation==='sequence')c.sequence=2;if(mutation==='head')c.previousDigest=ownedSha256('wrong');if(mutation==='revision')c.expectedRevision=0;if(mutation==='capability')c.event.capability='wrong';expect(()=>call(f,r.broker,c)).toThrow();expect(f.model.inspect(f.reader,s.sessionId)).toEqual(before);});
it('consumes the action capability once and permits only identical operation retry',()=>{const f=setup(),s=active(f),r=register(f,s);const c={operation:'append-event',operationId:'start-once',sessionId:s.sessionId,scope:r.scope,expectedRevision:r.revision,sequence:1,previousDigest:r.ledgerHead,event:{kind:'action-start',capability:r.capability}};const a=call(f,r.broker,c),b=call(f,r.broker,c);expect(b).toMatchObject({...a,historical:true});expect(()=>call(f,r.broker,{...c,operationId:'second',expectedRevision:a.revision,sequence:2,previousDigest:a.ledgerHead})).toThrow('capability_invalid');expect(f.model.inspect(f.reader,s.sessionId).eventCount).toBe(1);});
it('a second registration does not mint a new witness or capability',()=>{const f=setup(),s=active(f),r=register(f,s);expect(()=>call(f,f.caller,{operation:'register-scope',sessionId:s.sessionId,scope:r.scope,expectedRevision:r.revision})).toThrow('lifecycle_invalid');});
for(const change of ['missing-carrier','missing-index','dangling-ref','role','length','orphan','noncanonical','different-core','profile-id','wrong-scope','pair'])it('rejects seal fault '+change+' without adopting a backend',()=>{const f=setup(),s=active(f);const done=complete(f,s,requests[0],m=>{
 if(change==='missing-carrier')m.projection.ownedOfferObjects.pop();
 if(change==='missing-index')m.projection.ownedOfferObjects=m.projection.ownedOfferObjects.filter((x:any)=>x.role!=='evidence-index');
 if(change==='dangling-ref')m.projection.ownedOfferBundles[0].bundleRef.objectDigest=ownedSha256('missing');
 if(change==='role'){const carrier=m.projection.ownedOfferObjects[0];carrier.role=carrier.role==='manifest-bundle'?'evidence-index':'manifest-bundle';}
 if(change==='length')m.projection.ownedOfferBundles[0].bundleRef.byteLength++;
 if(change==='orphan')m.projection.ownedOfferObjects.push(m.projection.ownedOfferObjects[0]);
 if(change==='noncanonical')m.projection.ownedOfferObjects[0].bytes+=' ';
 if(change==='different-core')m.projection.coreMetadataRef={...m.projection.coreMetadataRef,rawSha256:ownedSha256('other')};
 if(change==='profile-id'){rewriteOwned(m.projection,()=>true,v=>{if(v.binding)v.binding.profileId='other';if('profileId'in v)v.profileId='other';});m.projection.ownedOfferObjects.sort((a:any,b:any)=>a.objectDigest<b.objectDigest?-1:1);}
 if(change==='wrong-scope')m.projection.ownedOfferBundles[0].invocation='other';
 if(change==='pair')m.pair.bundleDigest=ownedSha256('other');
 });expect(done.result).toMatchObject({terminal:{outcome:'invalid'},backendEligible:false,diagnosticEligible:false,ownedFileReads:0});});
it('does not seal an observed success without the entire metadata snapshot',()=>{const f=setup(),s=active(f);let r=start(f,register(f,s));const m=material(r);r=observe(f,r,{status:'verified',witness:m.witness},m.leases);r=prepare(f,r);expect(seal(f,r).terminal).toMatchObject({outcome:'invalid',reason:'authority_contract_required_metadata_missing'});});
it('an upload and a frozen ref do not accept overwrite or ref substitution',()=>{const f=setup(),s=active(f),r=start(f,register(f,s)),m=material(r);const ref=upload(f,r.broker,r,'seal',m.projection,{scope:r.scope,witnessId:r.witnessId});expect(()=>upload(f,r.broker,r,'seal',m.projection,{scope:r.scope,witnessId:r.witnessId})).toThrow('upload_invalid');const observed=observe(f,r,{status:'verified',witness:m.witness},m.leases),p=prepare(f,observed);expect(seal(f,p,{...ref,byteLength:ref.byteLength+1},m.pair).terminal.outcome).toBe('invalid');});
for(const field of ['ordinal','totalSha256','chunkSha256','base64','totalBytes'])it('rejects invalid chunk '+field+' without reserving memory or advancing revision',()=>{const f=setup(),b=begin(f),bytes=Buffer.from(canonicalOwnedJson(graphFixture()));const c:any={operation:'put-metadata-chunk',sessionId:b.sessionId,uploadId:b.coreUploadId,purpose:'core',expectedRevision:0,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal:0,chunkSha256:ownedSha256(bytes),base64:bytes.toString('base64')};if(field==='ordinal')c.ordinal=1;else if(field==='totalBytes')c.totalBytes++;else if(field==='base64')c.base64='not base64';else c[field]=ownedSha256('wrong');expect(()=>call(f,f.caller,c)).toThrow();expect(f.model.inspect(f.reader,b.sessionId).metadataBytes).toBe(0);});
it('core must be canonical, structurally valid and bound with its exact digest',()=>{const f=setup(),b=begin(f);expect(()=>upload(f,f.caller,b,'core',JSON.stringify(graphFixture()))).toThrow('metadata_invalid');expect(f.model.inspect(f.reader,b.sessionId).metadataBytes).toBe(0);const ref=upload(f,f.caller,b,'core',graphFixture());expect(()=>call(f,f.caller,{operation:'bind-core',sessionId:b.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedSha256('other'),rootRegistryDigest:ownedSha256('root'),scopes:[]})).toThrow();});
it('metadata quotas and unfinished upload counts close the operation',()=>{const f=setup({metadataBytes:1}),b=begin(f);expect(()=>upload(f,f.caller,b,'core',graphFixture())).toThrow('budget_exceeded');const g=setup({pendingUploads:1}),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(g,rs);register(g,s,rs[0]);expect(()=>register(g,s,rs[1])).toThrow('budget_exceeded');});
it('expires a current session without extending it on lookup or retry',()=>{const f=setup({sessionMilliseconds:10}),s=active(f);f.advance(10);expect(f.model.inspect(f.reader,s.sessionId)).toMatchObject({lifecycle:'closed',validity:'expired'});expect(()=>register(f,s)).toThrow('not_current');});
it('rejects monotonic clock rollback',()=>{const f=setup(),b=begin(f);f.advance(5);f.model.inspect(f.reader,b.sessionId);f.advance(-1);expect(()=>f.model.inspect(f.reader,b.sessionId)).toThrow('clock_invalid');});
it('a scope revoke preserves another terminal but a session revoke stops all lookups',()=>{const f=setup(),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs),a=complete(f,s,rs[0]),b=register(f,s,rs[1]);call(f,f.caller,{operation:'revoke',sessionId:s.sessionId,scope:b.scope,expectedRevision:b.revision,reason:'operator-request'});expect(call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope:rs[0],expectedRevision:0}).contractStatus).toBe('structure-verified');const state=f.model.inspect(f.caller,s.sessionId);call(f,f.caller,{operation:'revoke',sessionId:s.sessionId,expectedRevision:state.revision,reason:'operator-request'});expect(call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope:rs[0],expectedRevision:0}).contractStatus).toBe('session-unavailable');expect(f.model.inspect(f.reader,s.sessionId).scopes[0].terminal).toEqual(a.result.terminal);});

it('counts a 13 MiB core only once across six seal projections',()=>{
 const f=setup(),core=graphFixture();const edge=core.contexts[0]!.edges[0]!;core.contexts[0]!.edges=Array.from({length:3300},()=>({...edge,requested:{kind:'module',group:'g',name:'a',selector:'x'.repeat(4096)}}));
 const size=Buffer.byteLength(canonicalOwnedJson(core,16*1024*1024));expect(size).toBeGreaterThan(13*1024*1024);
 const rs=Array.from({length:6},(_,i)=>({...requests[0]!,invocation:'scope-'+i})),s=active(f,rs,core);let projections=0;
 for(const scope of rs){const done=complete(f,s,scope);expect(done.result.terminal.outcome).toBe('structure-verified');projections+=done.ref.byteLength;}
 expect(f.model.inspect(f.reader,s.sessionId).metadataBytes).toBe(size+projections);expect((rs.length+1)*size).toBeGreaterThan(64*1024*1024);
},30000);
it('allows a multi-chunk upload to take more than five seconds overall',()=>{const f=setup(),b=begin(f),core:any=graphFixture();core.inputs.files=Array.from({length:300},(_,i)=>({path:'f'+i+'/'+ 'x'.repeat(4000),sha256:ownedSha256('input')}));const bytes=Buffer.from(canonicalOwnedJson(core,16*1024*1024));expect(bytes.length).toBeGreaterThan(1024*1024);let ref:any;for(let ordinal=0;ordinal<Math.ceil(bytes.length/(1024*1024));ordinal++){if(ordinal)f.advance(6000);const part=bytes.subarray(ordinal*1024*1024,(ordinal+1)*1024*1024);const result=call(f,f.caller,{operation:'put-metadata-chunk',sessionId:b.sessionId,uploadId:b.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64')});ref=result.ref;}expect(ref.byteLength).toBe(bytes.length);});
it('a chunk request exceeding its own deadline rolls back reservations',()=>{const f=setup(),b=begin(f);f.clockStep(3000);expect(()=>upload(f,f.caller,b,'core',graphFixture())).toThrow('deadline_exceeded');f.clockStep(0);expect(f.model.inspect(f.reader,b.sessionId).metadataBytes).toBe(0);});
it('does not return a new capability when the session expires during an operation',()=>{const f=setup(),s=active(f);f.clockStep(200000);expect(()=>register(f,s)).toThrow('expired');f.clockStep(0);expect(f.model.inspect(f.reader,s.sessionId).lifecycle).toBe('closed');});
for(const reason of ['SKIPPED','FROM-CACHE','UP-TO-DATE','NO-SOURCE'])it('seals a genuinely observed '+reason+' without metadata or action launch',()=>{const f=setup(),s=active(f);let r=register(f,s);const m=material(r);r=observe(f,r,{status:'not-executed',binding:m.witness.binding,task:{...m.witness.task,actionCalls:0,didWork:false,skipped:true,noSource:reason==='NO-SOURCE',skipMessage:reason},reason});r=prepare(f,r);expect(seal(f,r)).toMatchObject({terminal:{outcome:'not-executed'},ownedFileReads:0});expect(f.model.inspect(f.reader,s.sessionId).eventCount).toBe(1);});
it('keeps an independently observed Task exception separate from producer failure',()=>{const f=setup(),s=active(f);let r=start(f,register(f,s));const m=material(r);r=observe(f,r,{status:'unavailable',reason:'execution-aborted',binding:m.witness.binding,task:{...m.witness.task,failed:true}});r=prepare(f,r);expect(seal(f,r).terminal.outcome).toBe('execution-aborted');});
it('a new session activates with CAS and supersedes the old one',()=>{const f=setup(),old=active(f),current=active(f);expect(current.currentRevision).toBe(old.currentRevision+1);expect(f.model.inspect(f.reader,old.sessionId).validity).toBe('superseded');expect(()=>register(f,old)).toThrow('not_current');});
it('does not let an identical historical lookup escape a later revoke',()=>{const f=setup(),s=active(f);complete(f,s);const query={operation:'lookup',operationId:'repeat',sessionId:s.sessionId,scope:requests[0],expectedRevision:0};expect(call(f,f.reader,query).contractStatus).toBe('structure-verified');const state=f.model.inspect(f.caller,s.sessionId);call(f,f.caller,{operation:'revoke',sessionId:s.sessionId,expectedRevision:state.revision,reason:'operator-request'});expect(call(f,f.reader,query).contractStatus).toBe('session-unavailable');});

for(const state of ['failed','unavailable'])for(const through of ['none','prepare','build','runtime-selection','snapshot-generation'])it('seals the legal '+state+' prefix '+through+' without requiring unreached stages',()=>{const f=setup(),s=active(f,requests,graphFixture(),0);let r=start(f,register(f,s));const m=material(r,state,through);r=observe(f,r,{status:'verified',witness:m.witness},m.leases);const ref=upload(f,r.broker,r,'seal',m.projection,{scope:r.scope,witnessId:r.witnessId});r=prepare(f,r);expect(seal(f,r,ref,m.pair).terminal.outcome).toBe('structure-verified');});
it('does not accept verified observations with an unexecuted Task',()=>{const f=setup(),s=active(f);const done=complete(f,s,requests[0],m=>{m.witness.task.actionCalls=0;m.witness.task.didWork=false;});expect(done.result.terminal.outcome).toBe('invalid');});
it('closes a formal missing-receipt observation as unavailable, not success',()=>{const f=setup(),s=active(f);let r=start(f,register(f,s));r=observe(f,r,{status:'unavailable',reason:'receipt-missing'});r=prepare(f,r);expect(seal(f,r).terminal.outcome).toBe('unavailable');});
it('refuses activation after a competing session won the same current revision',()=>{const f=setup(),b=begin(f),ref=upload(f,f.caller,b,'core',graphFixture());const plans=requests.map(r=>({...r,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}));const bound=call(f,f.caller,{operation:'bind-core',sessionId:b.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedDigest(graphFixture()),rootRegistryDigest:ownedSha256('pin'),scopes:plans});active(f);expect(()=>call(f,f.caller,{operation:'activate',sessionId:b.sessionId,expectedRevision:bound.revision,expectedCurrentRevision:0})).toThrow('slot_conflict');expect(f.model.inspect(f.reader,b.sessionId).lifecycle).toBe('core-bound');});
it('a duplicate metadata chunk retry does not count its bytes twice',()=>{const f=setup(),b=begin(f),bytes=Buffer.from(canonicalOwnedJson(graphFixture()));const c={operation:'put-metadata-chunk',operationId:'same-chunk',sessionId:b.sessionId,uploadId:b.coreUploadId,purpose:'core',expectedRevision:0,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal:0,chunkSha256:ownedSha256(bytes),base64:bytes.toString('base64')};const a=call(f,f.caller,c),before=f.model.inspect(f.reader,b.sessionId);expect(call(f,f.caller,c)).toMatchObject({...a,historical:true});expect(f.model.inspect(f.reader,b.sessionId)).toEqual(before);});
it('rejects unknown operation fields and unsupported production permit APIs',()=>{const f=setup();expect(()=>call(f,f.caller,{operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(requests),endpoint:'file:///tmp/authority'})).toThrow('schema_invalid');expect(()=>call(f,f.reader,{operation:'grant-read',expectedRevision:0})).toThrow('schema_invalid');});
import {parseGradleExportG0} from '../../utils/gradleOwnedManifest.js';
it('exposes G0-only validation without calling G1 or an authority',()=>{const f=ownedExecutionCase(),parsed=parseGradleExportG0(canonicalOwnedJson(f.doc,64*1024*1024));expect(parsed.owned).toMatchObject({manifestStructure:'verified',executionWitness:'not_checked',diagnosticEligible:false,ownedFileReads:0});expect(parsed.executions[0]).toMatchObject({profileId:'profile',recipeId:'recipe'});expect(parsed.refreshOwnedExecution).toBeUndefined();});

import * as safeRead from '../../utils/safeRead.js';
it('the full logical flow and G0 validation never open an owned file',()=>{const spy=vi.spyOn(safeRead,'readRegularFile');try{const f=setup(),s=active(f);expect(complete(f,s).result.terminal.outcome).toBe('structure-verified');expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}});

it('releases the unfinished upload slot after abort so another scope can register',()=>{
 const f=setup({pendingUploads:1}),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs),a=register(f,s,rs[0]);
 call(f,f.caller,{operation:'abort',sessionId:s.sessionId,scope:a.scope,expectedRevision:a.revision,reason:'operator-request'});
 const b=register(f,s,rs[1]);expect(b.lifecycle).toBe('registered');expect(f.model.inspect(f.reader,s.sessionId).lifecycle).toBe('active');
 expect(()=>upload(f,a.broker,a,'seal',material(a).projection,{scope:a.scope,witnessId:a.witnessId})).toThrow('upload_invalid');
});

for(const during of [false,true])it('returns unavailable '+(during?'when expiry is reached during lookup':'for lookup after the session expired'),()=>{
 const f=setup({sessionMilliseconds:10}),s=active(f);complete(f,s);
 if(during)f.clockStep(4);else f.advance(10);
 const result=call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope:requests[0],expectedRevision:0});
 f.clockStep(0);
 expect(result).toMatchObject({contractStatus:'session-unavailable',readerProjection:{status:'unavailable',reason:'backend-unsupported'},backendEligible:false,diagnosticEligible:false,ownedFileReads:0});
 expect(result).not.toHaveProperty('terminal');expect(f.model.inspect(f.reader,s.sessionId)).toMatchObject({lifecycle:'closed',validity:'expired'});
});

for(const reason of ['SKIPPED','FROM-CACHE','UP-TO-DATE','NO-SOURCE'])it('releases the upload slot after '+reason+' without losing its terminal',()=>{
 const f=setup({pendingUploads:1}),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs);let a=register(f,s,rs[0]);const m=material(a);
 a=observe(f,a,{status:'not-executed',reason,binding:m.witness.binding,task:{...m.witness.task,actionCalls:0,didWork:false,skipped:true,noSource:reason==='NO-SOURCE',skipMessage:reason}});
 a=prepare(f,a);const terminal=seal(f,a).terminal;
 expect(terminal.outcome).toBe('not-executed');expect(register(f,s,rs[1]).lifecycle).toBe('registered');
 expect(call(f,f.reader,{operation:'lookup',sessionId:s.sessionId,scope:a.scope,expectedRevision:0}).terminal).toEqual(terminal);
});
it('closes cancelled partial uploads but retains their reserved byte budget',()=>{
 const f=setup({pendingUploads:1,metadataBytes:2*1024*1024}),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs),a=register(f,s,rs[0]);
 const projection=material(a).projection;projection.ownedOfferObjects[0].bytes+='x'.repeat(1024*1024);const bytes=Buffer.from(canonicalOwnedJson(projection,48*1024*1024)),part=bytes.subarray(0,1024*1024);
 const chunk={operation:'put-metadata-chunk',operationId:'retained-partial',sessionId:s.sessionId,scope:a.scope,witnessId:a.witnessId,uploadId:a.uploadId,purpose:'seal',expectedRevision:0,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal:0,chunkSha256:ownedSha256(part),base64:part.toString('base64')};
 expect(call(f,a.broker,chunk).frozen).toBe(false);const before=f.model.inspect(f.reader,s.sessionId).metadataBytes;
 call(f,f.caller,{operation:'abort',sessionId:s.sessionId,scope:a.scope,expectedRevision:a.revision,reason:'operator-request'});
 expect(f.model.inspect(f.reader,s.sessionId).metadataBytes).toBe(before);expect(before).toBe(s.coreMetadataRef.byteLength+bytes.length);
 const b=register(f,s,rs[1]);const other=material(b).projection;other.ownedOfferObjects[0].bytes+='x'.repeat(1024*1024);
 expect(()=>upload(f,b.broker,b,'seal',other,{scope:b.scope,witnessId:b.witnessId})).toThrow('budget_exceeded');
 // A historical acknowledgement cannot reopen the cancelled upload or free its charge.
 expect(call(f,a.broker,chunk)).toMatchObject({historical:true,frozen:false});
 expect(()=>call(f,a.broker,{...chunk,operationId:'reopen-cancelled'})).toThrow('upload_invalid');
 expect(f.model.inspect(f.reader,s.sessionId).metadataBytes).toBe(before);
});
it('does not exhaust the default 32 pending slots across 33 sequential aborts',()=>{
 const f=setup(),rs=Array.from({length:33},(_,i)=>({...requests[0]!,invocation:'abort-'+i})),s=active(f,rs);
 for(const scope of rs){const r=register(f,s,scope);call(f,f.caller,{operation:'abort',sessionId:s.sessionId,scope,expectedRevision:r.revision,reason:'operator-request'});}
 expect(f.model.inspect(f.reader,s.sessionId)).toMatchObject({lifecycle:'committed',metadataBytes:s.coreMetadataRef.byteLength});
});
for(const outcome of ['execution-aborted','unavailable','invalid'])it('closes the unused upload when seal yields '+outcome,()=>{
 const f=setup({pendingUploads:1}),rs=[requests[0]!,{...requests[0]!,invocation:'second'}],s=active(f,rs);let a=start(f,register(f,s,rs[0]));const m=material(a);
 const lookup=outcome==='execution-aborted'?{status:'unavailable',reason:'execution-aborted',binding:m.witness.binding,task:{...m.witness.task,failed:true}}:outcome==='unavailable'?{status:'unavailable',reason:'receipt-missing'}:{status:'verified',witness:m.witness};
 a=observe(f,a,lookup,m.leases);a=prepare(f,a);expect(seal(f,a).terminal.outcome).toBe(outcome);expect(register(f,s,rs[1]).lifecycle).toBe('registered');
});
it('repeated expired lookups stay unavailable and cannot invalidate another current session',()=>{
 const f=setup({sessionMilliseconds:20}),old=active(f);complete(f,old);f.advance(10);const current=active(f);complete(f,current);f.advance(10);
 const query={operation:'lookup',operationId:'expired-retry',sessionId:old.sessionId,scope:requests[0],expectedRevision:0};
 for(let i=0;i<2;i++)expect(call(f,f.reader,query)).toMatchObject({contractStatus:'session-unavailable',readerProjection:{status:'unavailable',reason:'backend-unsupported'}});
 expect(call(f,f.reader,{...query,sessionId:current.sessionId})).toMatchObject({contractStatus:'structure-verified'});
 expect(f.model.inspect(f.reader,current.sessionId).validity).toBe('current');
});

it('records session abort and revoke as different validity outcomes',()=>{
 for(const [operation,validity] of [['abort','aborted'],['revoke','revoked']] as const){const f=setup(),s=active(f);call(f,f.caller,{operation,sessionId:s.sessionId,expectedRevision:s.revision,reason:'operator-request'});expect(f.model.inspect(f.reader,s.sessionId)).toMatchObject({lifecycle:'closed',validity});}
});
it('keeps an observed Task exception as execution-aborted when the scope is aborted',()=>{
 const f=setup(),s=active(f);let r=start(f,register(f,s));const m=material(r);r=observe(f,r,{status:'unavailable',reason:'execution-aborted',binding:m.witness.binding,task:{...m.witness.task,failed:true}});
 const aborted=call(f,f.caller,{operation:'abort',sessionId:s.sessionId,scope:requests[0],expectedRevision:r.revision,reason:'execution-unavailable'});
 expect(aborted.terminal.outcome).toBe('execution-aborted');
});
it('closes an aborted scope without an observed exception as unavailable',()=>{
 const f=setup(),s=active(f),r=start(f,register(f,s));
 expect(call(f,f.caller,{operation:'abort',sessionId:s.sessionId,scope:requests[0],expectedRevision:r.revision,reason:'operator-request'}).terminal.outcome).toBe('unavailable');
});
