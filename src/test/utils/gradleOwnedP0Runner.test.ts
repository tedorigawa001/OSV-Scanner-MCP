import {expect,test,vi} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as digest} from '../../utils/gradleOwnedJson.js';
import {readP0Backend,inspectP0Backend,closeP0Backend,connectP0Backend,P0MetadataServer,P0_BACKEND_APIS,type P0BackendAPI} from '../../utils/gradleOwnedP0Backend.js';
import {P0FrameReader,p0Frame,P0_FRAME_MAX} from '../../utils/gradleOwnedP0Socket.js';
import {runP0Preflight} from '../../utils/gradleOwnedP0Runner.js';
import {p0BackendFixture} from '../fixtures/gradleOwnedP0BackendFixture.js';

test('P0B01 absent independent backend stops before metadata or candidate IO',async()=>{
 const r=await runP0Preflight(null,'a'.repeat(64));
 expect(r.status).toBe('unsupported');expect(r.reasons).toContain('independent-backend-unconfigured');
 expect(r.jobPermitIssued).toBe(false);expect(r.calls).toBe(0);
 expect(r.candidateOperations).toEqual({reads:0,copies:0,execs:0,publications:0});
});

test.each(P0_BACKEND_APIS)('P0B03 %s unavailable never enables acquisition or execution',async api=>{
 const f=p0BackendFixture();f.setUnavailable(api);const r=await runP0Preflight(f.connect(),f.jobDigest);
 expect(r).toMatchObject({status:'unsupported',staticMetadataVerified:false,jobPermitIssued:false});expect(r.candidateOperations).toEqual({reads:0,copies:0,execs:0,publications:0});
});

test.each(['method','environment','lock'] as const)('P0B04 missing %s stops before controller lookup',async field=>{
 const f=p0BackendFixture();f.onLookup(api=>{if(api==='ReadAcquisition'){if(field==='lock')Object.assign(f.f,{lock:null});else Object.assign(f.f.packet,{[field]:null});}});
 const r=await runP0Preflight(f.connect(),f.jobDigest);expect(r.status).toBe('unsupported');expect(f.calls).toEqual(['ReadPins','ReadAcquisition']);
});

test('P0B05 altered same-version tool lock is rejected before preflight fetch',async()=>{
 const f=p0BackendFixture();f.f.lock.digests.loaderDigest=digest('substituted');
 const r=await runP0Preflight(f.connect(),f.jobDigest);expect(r.status).toBe('invalid');expect(f.calls).toEqual(['ReadPins','ReadAcquisition']);
});

test('P0B06 incorrect method signature cannot be blessed by the backend signature',async()=>{
 const f=p0BackendFixture();f.f.method.signature='A'.repeat(86)+'==';expect((await runP0Preflight(f.connect(),f.jobDigest)).status).toBe('invalid');expect(f.calls).toHaveLength(2);
});

test('P0B07 registry response for a different job is refused',async()=>{
 const f=p0BackendFixture();expect((await runP0Preflight(f.connect(),digest('different-job'))).reasons).toEqual(['backend-job-mismatch']);expect(f.calls).toEqual(['ReadPins']);
});

test.each(['principal','keyId','spki'] as const)('P0B08 trusted registry data cannot substitute controller %s',async field=>{
 const f=p0BackendFixture();f.f.trust.roles[4]![field]=f.f.trust.roles[2]![field];
 const r=await runP0Preflight(f.connect(),f.jobDigest);expect(r).toMatchObject({status:'invalid',reasons:['backend-owner-pin-mismatch']});expect(f.calls).toEqual(['ReadPins']);
});

test('P0B10 revocation during preflight acquisition is caught by the second authority read',async()=>{
 const f=p0BackendFixture();f.onLookup(api=>{if(api==='ReadPreflight')f.f.live.environmentRevoked=true;});
 const r=await runP0Preflight(f.connect(),f.jobDigest);expect(r.status).toBe('revoked-or-expired');expect(r.staticMetadataVerified).toBe(false);expect(f.calls).toHaveLength(5);
});

test('P0B11 a call that reaches the original client deadline stops later backend reads',async()=>{
 const f=p0BackendFixture();let now=0;f.onLookup(api=>{if(api==='ReadPreflight')now=5000;});const client=f.connect({now:()=>now});
 const r=await runP0Preflight(client,f.jobDigest);expect(r.status).toBe('revoked-or-expired');expect(f.calls).toHaveLength(4);expect(inspectP0Backend(client).closed).toBe(true);
 await expect(readP0Backend(client,'ReadLive',f.jobDigest)).rejects.toThrow('backend-expired-or-closed');expect(f.calls).toHaveLength(4);
});

test.each([600000,600001,605000])('P0B12 original job expiry at %d after metadata acquisition rejects final preflight',async now=>{
 const f=p0BackendFixture();f.onLookup(api=>{if(api==='ReadPreflight')f.f.live.now=now;});const r=await runP0Preflight(f.connect(),f.jobDigest);
 expect(r.status).toBe('revoked-or-expired');expect(r.jobPermitIssued).toBe(false);
});

test('P0B13 an old signed ReadLive reply cannot satisfy a new challenge',async()=>{
 const f=p0BackendFixture();let first:Buffer|null=null;
 const client=f.connect({exchange:async(...args)=>{const request=JSON.parse(args[1].toString());if(request.payload.api==='ReadLive'&&first)return first;
  const r=await f.exchange(...args);if(request.payload.api==='ReadLive')first=r;return r;}});
 const r=await runP0Preflight(client,f.jobDigest);expect(r).toMatchObject({status:'invalid',reasons:['backend-reply-binding']});
});

test.each(['api','server','keyId','serverBoot','jobDigest','requestDigest','nonce','sequence'] as const)('P0B14 re-signed wrong reply %s is rejected',async field=>{
 const f=p0BackendFixture();const client=f.connect({exchange:async(...args)=>{
  const r=JSON.parse((await f.exchange(...args)).toString());const old=r.payload[field];r.payload[field]=typeof old==='number'?old+1:['serverBoot','jobDigest','requestDigest','nonce'].includes(field)?digest('other'):field==='api'?'ReadLive':'other';
  r.signature=sign(null,Buffer.from(canonical(r.payload)),f.keys.registry.privateKey).toString('base64');return Buffer.from(canonical(r));}});
 expect((await runP0Preflight(client,f.jobDigest)).status).toBe('invalid');
});

test('P0B15 invalid backend signature and embedded replacement key are refused',async()=>{
 for(const kind of ['signature','key']){const f=p0BackendFixture(),client=f.connect({exchange:async(...args)=>{
  const r=JSON.parse((await f.exchange(...args)).toString());if(kind==='signature')r.signature='A'.repeat(86)+'==';else r.publicKey=f.config.peers.registry.spki;return Buffer.from(canonical(r));}});
  expect((await runP0Preflight(client,f.jobDigest)).status).toBe('invalid');}
});

test('P0B16 service authenticates the caller and denies cross-role APIs before lookup',async()=>{
 const f=p0BackendFixture(),client=f.connect();await readP0Backend(client,'ReadPins',f.jobDigest);const request=JSON.parse(f.requests[0]!.toString());
 request.payload.api='ReadPreflight';request.payload.nonce=digest('new-nonce');request.signature=sign(null,Buffer.from(canonical(request.payload)),f.keys.client.privateKey).toString('base64');
 await expect(f.servers.registry.respond(Buffer.from(canonical(request)))).rejects.toThrow('backend-api-denied');expect(f.calls).toEqual(['ReadPins']);
 request.signature='A'.repeat(86)+'==';await expect(f.servers.registry.respond(Buffer.from(canonical(request)))).rejects.toThrow('backend-signature-invalid');closeP0Backend(client);
});

test('P0B17 exact authenticated request replay is rejected before source lookup',async()=>{
 const f=p0BackendFixture(),client=f.connect();await readP0Backend(client,'ReadPins',f.jobDigest);
 await expect(f.servers.registry.respond(f.requests[0]!)).rejects.toThrow('backend-replay-or-budget');expect(f.calls).toHaveLength(1);closeP0Backend(client);
});

test('P0B18 mutation of supplied service configuration does not change its copied key/boot/role pins',async()=>{
 const f=p0BackendFixture();f.config.client.principal='changed';f.config.peers.registry.boot=digest('changed');
 const client=f.connect();await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow();expect(f.calls).toHaveLength(0);
});

test('P0B19 replacement or shared client/server key configurations are rejected',()=>{
 const f=p0BackendFixture();expect(()=>connectP0Backend(JSON.stringify(f.config),generateKeyPairSync('ed25519').privateKey)).toThrow('backend-client-key-mismatch');
 f.config.peers.controller.spki=f.config.client.spki;expect(()=>f.connect()).toThrow('backend-owner-separation');
});

test('P0B20 simultaneous use is rejected and the outer call cannot publish a late result',async()=>{
 const f=p0BackendFixture();let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
 const client=f.connect({exchange:async(...args)=>{await held;return f.exchange(...args);}});
 const pending=readP0Backend(client,'ReadPins',f.jobDigest);await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow('backend-reentry');
 release();await expect(pending).rejects.toThrow('backend-expired-or-closed');expect(inspectP0Backend(client).closed).toBe(true);
});

test('P0B21 call slots and transmitted request cost stay consumed on failure',async()=>{
 const f=p0BackendFixture();const client=f.connect({exchange:async()=>{throw Error('lost-response');}});
 await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow('backend-unavailable');const before=inspectP0Backend(client);expect(before.calls).toBe(1);expect(before.wireBytes).toBeGreaterThan(4);
 await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow();expect(inspectP0Backend(client)).toEqual(before);
});

test('P0B22 request count capacity is checked before backend IO',async()=>{
 const f=p0BackendFixture(),client=f.connect();for(let i=0;i<8;i++)await readP0Backend(client,'ReadPins',f.jobDigest);
 await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow('backend-budget-exceeded');expect(f.calls).toHaveLength(8);
});

test('P0B23 clock rollback is rejected and does not refresh the client deadline',async()=>{
 const f=p0BackendFixture();let now=100;const client=f.connect({now:()=>now});await readP0Backend(client,'ReadPins',f.jobDigest);now=99;
 await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow('backend-expired-or-closed');expect(f.calls).toHaveLength(1);
});

test.each(['oversize','zero','truncated','extra'] as const)('P0B24 frame reader refuses %s input',kind=>{
 const r=new P0FrameReader();if(kind==='oversize'){const h=Buffer.alloc(4);h.writeUInt32BE(P0_FRAME_MAX+1);expect(()=>r.push(h)).toThrow('backend-frame-budget');}
 if(kind==='zero')expect(()=>r.push(Buffer.alloc(4))).toThrow('backend-frame-budget');
 if(kind==='truncated'){r.push(p0Frame(Buffer.from('abc')).subarray(0,6));expect(()=>r.finish()).toThrow('backend-truncated-frame');}
 if(kind==='extra')expect(()=>r.push(Buffer.concat([p0Frame(Buffer.from('abc')),Buffer.from('x')]))).toThrow('backend-extra-frame');
});

test('P0B25 split header and payload are reconstructed exactly once',()=>{
 const r=new P0FrameReader(),bytes=p0Frame(Buffer.from('metadata'));for(const byte of bytes)r.push(Buffer.from([byte]));expect(r.finish().toString()).toBe('metadata');
});

test('P0B26 service close during source lookup denies the eventual signed response',async()=>{
 const f=p0BackendFixture();f.onLookup(api=>{if(api==='ReadPins')f.servers.registry.close();});
 expect((await runP0Preflight(f.connect(),f.jobDigest)).status).toBe('revoked-or-expired');expect(f.calls).toHaveLength(1);
});

test.each(['before','after'] as const)('P0B27 a %s authority fence change is refused',async point=>{
 const f=p0BackendFixture();if(point==='before')f.f.live.reservationFence++;
 else f.onLookup(api=>{if(api==='ReadPreflight')f.f.live.registryRevision++;});
 const r=await runP0Preflight(f.connect(),f.jobDigest);expect(r.status).toBe('revoked-or-expired');expect(f.calls).toHaveLength(point==='before'?3:5);
});

test('P0B28 a hanging exchange expires on the original timer and late replies do not restore its state',async()=>{
 vi.useFakeTimers();try{
  const f=p0BackendFixture();let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const client=f.connect({now:()=>0,exchange:async(...args)=>{const response=await f.exchange(...args);await held;return response;}});
  const pending=readP0Backend(client,'ReadPins',f.jobDigest).catch(e=>e);
  await vi.advanceTimersByTimeAsync(5000);expect((await pending).reason).toBe('backend-timeout');const stopped=inspectP0Backend(client);
  release();await Promise.resolve();expect(inspectP0Backend(client)).toEqual(stopped);expect(stopped).toMatchObject({closed:true,calls:1});
 }finally{vi.useRealTimers();}
});

test('P0B29 total wire reservation refuses the next RPC before dispatch even below the call-count cap',async()=>{
 const f=p0BackendFixture(),client=f.connect({exchange:async(...args)=>{
  const r=JSON.parse((await f.exchange(...args)).toString());r.payload.result={status:'available',wire:'x'.repeat(P0_FRAME_MAX-4096)};
  r.signature=sign(null,Buffer.from(canonical(r.payload)),f.keys.registry.privateKey).toString('base64');return Buffer.from(canonical(r));}});
 for(let i=0;i<7;i++)await readP0Backend(client,'ReadPins',f.jobDigest);
 await expect(readP0Backend(client,'ReadPins',f.jobDigest)).rejects.toThrow('backend-budget-exceeded');expect(f.calls).toHaveLength(7);expect(inspectP0Backend(client).wireBytes).toBeLessThanOrEqual(8388608);
});

test('P0B30 approval expiry before the clock origin refuses controller lookup without throwing',async()=>{
 const f=p0BackendFixture();f.f.trust.clock.utcAt=4000000;const r=await runP0Preflight(f.connect(),f.jobDigest);
 expect(r.status).toBe('revoked-or-expired');expect(f.calls).toEqual(['ReadPins','ReadAcquisition','ReadLive']);
});

test('P0B31 correctly signed legacy/extra acquisition body does not bypass strict inner schemas',async()=>{
 const f=p0BackendFixture(),client=f.connect({exchange:async(...args)=>{
  const r=JSON.parse((await f.exchange(...args)).toString());if(r.payload.api==='ReadAcquisition'){
   r.payload.result.wire=JSON.stringify({...JSON.parse(r.payload.result.wire),preflight:f.f.preflight});
   r.signature=sign(null,Buffer.from(canonical(r.payload)),f.keys.custodian.privateKey).toString('base64');}
  return Buffer.from(canonical(r));}});
 expect((await runP0Preflight(client,f.jobDigest)).status).toBe('invalid');expect(f.calls).toHaveLength(2);
});

test.each(['validation-expiry','validation-close','cleanup-expiry','cleanup-close'] as const)('P0B32 final %s refuses metadata verification and preserves charged usage',async fault=>{
 const f=p0BackendFixture();let now=0,liveReads=0,armed=false,ticks=0;
 let client:ReturnType<typeof f.connect>;
 client=f.connect({now:()=>{
  if(armed&&++ticks===3&&fault.startsWith('validation')){if(fault.endsWith('expiry'))now=5000;else closeP0Backend(client);}
  return now;
 },exchange:async(...args)=>{
  const response=await f.exchange(...args);
  if(JSON.parse(args[1].toString()).payload.api==='ReadLive'&&++liveReads===2){armed=true;
   args[3].addEventListener('abort',()=>{if(fault==='cleanup-expiry')now=5000;if(fault==='cleanup-close')closeP0Backend(client);},{once:true});}
  return response;
 }});
 const r=await runP0Preflight(client,f.jobDigest);expect(r).toMatchObject({status:'revoked-or-expired',staticMetadataVerified:false,jobPermitIssued:false,calls:5});
 expect(r.wireBytes).toBeGreaterThan(0);expect(inspectP0Backend(client)).toMatchObject({closed:true,calls:5,wireBytes:r.wireBytes});
 expect(r.candidateOperations).toEqual({reads:0,copies:0,execs:0,publications:0});
});

test('P0B02 pinned signed backends supply metadata while runtime readiness remains unsupported',async()=>{
 const f=p0BackendFixture(),r=await runP0Preflight(f.connect(),f.jobDigest);
 expect(r).toMatchObject({status:'unsupported',staticMetadataVerified:true,jobPermitIssued:false,calls:5});
 expect(f.calls).toEqual(['ReadPins','ReadAcquisition','ReadLive','ReadPreflight','ReadLive']);
});

test('P0B09 authority revocation before controller metadata acquisition prevents that lookup',async()=>{
 const f=p0BackendFixture();f.f.live.methodRevoked=true;
 const r=await runP0Preflight(f.connect(),f.jobDigest);
 expect(r.status).toBe('revoked-or-expired');expect(f.calls).toEqual(['ReadPins','ReadAcquisition','ReadLive']);
});
