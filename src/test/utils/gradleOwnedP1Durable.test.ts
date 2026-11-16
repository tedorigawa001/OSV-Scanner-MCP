import {it,expect,afterEach,vi} from 'vitest';
import {PB1_COMMAND_SCHEMA,pb1Command,pb1OriginKey} from '../../utils/gradleOwnedP1Contract.js';
import {request,readDraft,controlDraft,H} from '../fixtures/gradleOwnedP0StateFixture.js';
import {journalGenesis,AuthorityJournal} from '../../utils/gradleOwnedStoreJournal.js';
import {RootedJournalIO} from '../../utils/gradleOwnedStoreFs.js';
import {PB1Store,type PB1StoreOptions,type PB1Receipt,type PB1Area} from '../../utils/gradleOwnedP1Store.js';
import {PB1DiskAnchorFixture} from '../fixtures/gradleOwnedP1Fixture.js';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtemp,realpath,mkdir,rm,readdir,readFile,writeFile,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonicalOwnedJson as C,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {PB1_LIMITS,pb1VerifyAnchor,pb1Reserve} from '../../utils/gradleOwnedP1Contract.js';
import {stripTypeScriptTypes} from 'node:module';
import {spawn,execFileSync} from 'node:child_process';
const head=journalGenesis({authorityId:'owner',storeEpoch:H('c'),keyId:'journal'});
it('PBD01 strict stage input preserves the full original intent and excludes D from tombstone identity',()=>{
 const w=pb1Command(JSON.stringify({schema:PB1_COMMAND_SCHEMA,kind:'stage',requestWire:request(),stage:'intent-reserved',expectedHead:head,previousStageRef:null,dataWire:'{}'}));
 expect(w.request.operationKey).toBeDefined();
 expect(pb1OriginKey(w.origin)).toBe(pb1OriginKey({...w.origin,intentDigest:H('2')}));
 expect(()=>pb1Command(JSON.stringify({...w.command,extra:true}))).toThrow();
 const r=readDraft();r.purpose='wrong';expect(()=>request(r)).toThrow();
});

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of cleanups.splice(0).reverse())await f();});
async function setup(){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'e2-pb1-'))),names=['journal','checkpoint','adoption','adoptionCheckpoint','anchor','anchorCheckpoint'];
 for(const n of names)await mkdir(path.join(root,n),{mode:0o700});
 const pair=generateKeyPairSync('ed25519'),spki=pair.publicKey.export({type:'spki',format:'der'}).toString('base64'),pin={anchorId:'anchor',keyId:'anchor-signature',spki,spkiDigest:sha(Buffer.from(spki,'base64'))};
 const anchorOptions={authorityId:'independent-port-fixture',storeEpoch:H('4'),keyId:'anchor-journal',key:Buffer.alloc(32,8),checkpointKeyId:'anchor-checkpoint',checkpointKey:Buffer.alloc(32,9),store:{root:path.join(root,'anchor')},checkpoint:{root:path.join(root,'anchorCheckpoint')},mode:'create' as 'create'|'open'};
 let anchor=await PB1DiskAnchorFixture.open(anchorOptions,pair.privateKey,pin),now=1,revoked=false;
 const roots=Object.fromEntries(names.slice(0,4).map(n=>[n,path.join(root,n)])) as Record<PB1Area,string>;
 const options:PB1StoreOptions={stream:{realmId:'realm',owner:'registry',authorityId:'owner',storeEpoch:H('c'),keyId:'journal'},mode:'create',roots,keys:{journal:Buffer.alloc(32,1),checkpoint:Buffer.alloc(32,2),adoption:Buffer.alloc(32,3),adoptionCheckpoint:Buffer.alloc(32,4)},anchor,anchorPin:pin,now:()=>now,authorize:()=>{if(revoked)throw Error('revoked');}};
 let store=await PB1Store.open(options);const handles=[store];
 cleanups.push(async()=>{for(const s of handles)s.close();anchor.close();await rm(root,{recursive:true,force:true});});
 const open=async(extra:Partial<PB1StoreOptions>={})=>{store.close();store=await PB1Store.open({...options,mode:'open',...extra});handles.push(store);return store;};
 return {root,options,anchorOptions,pair,pin,get store(){return store;},get anchor(){return anchor;},open,setNow:(v:number)=>now=v,revoke:()=>revoked=true,
  restartAnchor:async()=>{anchor.close();anchor=await PB1DiskAnchorFixture.open({...anchorOptions,mode:'open'},pair.privateKey,pin);options.anchor=anchor;return anchor;}};
}
function command(store:PB1Store,stage='intent-reserved',r=request(),previous:PB1Receipt|null=null,data:unknown={}){return C({schema:PB1_COMMAND_SCHEMA,kind:'stage',requestWire:r,stage,expectedHead:store.head,previousStageRef:previous?store.receiptRef(previous):null,dataWire:C(data)});}
function query(origin:ReturnType<typeof pb1Command>['origin'],headDigest:string){const draft=controlDraft('QueryOperation',{origin});draft.expectedOwnerHead=headDigest;draft.operationId='query-'+origin.operationKey.slice(0,16);return request(draft);}
function tombstone(store:PB1Store,origin:ReturnType<typeof pb1Command>['origin']){return C({schema:PB1_COMMAND_SCHEMA,kind:'tombstone',queryWire:query(origin,store.head.headDigest),origin,expectedHead:store.head,previousStageRef:null});}
it('PBD02 ACK follows local checkpoint, external CAS and durable local adoption; escape is a second write',async()=>{
 const f=await setup(),events:string[]=[];await f.open({fault:p=>{events.push(p);}});let previous:PB1Receipt|null=null;
 for(const stage of ['intent-reserved','source-captured','response-ready','response-may-have-escaped']){
  previous=await f.store.commit(command(f.store,stage,request(),previous));
  expect(events.splice(0)).toEqual(['after-local-checkpoint','after-anchor','after-adoption','before-ack']);
  expect(previous.jobPermitIssued).toBe(false);expect(previous.adoptionHead.revision).toBe(previous.appliedHead.revision);
 }
 const rows=await f.anchor.entries();expect(rows).toHaveLength(4);expect(rows[2]!.head).not.toEqual(rows[3]!.head);expect(f.store.head.revision).toBe(4);
});
it('PBD03 exact retry after later transactions and restart returns original receipt without applying old image',async()=>{
 const f=await setup(),a=command(f.store),one=await f.store.commit(a),r=readDraft();r.operationId='read2';await f.store.commit(command(f.store,'intent-reserved',request(r)));
 const two=f.store.head;expect(await f.store.commit(a)).toEqual(one);expect(f.store.head).toEqual(two);expect(f.anchor.casCalls).toBe(2);
 await f.open();expect(await f.store.commit(a)).toEqual(one);expect(f.store.head).toEqual(two);
 expect((await f.store.audit(query(pb1Command(a).origin,two.headDigest))).outcome).toBe('historical');
});
it('PBD04 absent is pending until anchored tombstone adoption; late same K with either D is rejected',async()=>{
 const f=await setup(),a=command(f.store),origin=pb1Command(a).origin,q=query(origin,f.store.head.headDigest);
 expect(await f.store.audit(q)).toMatchObject({outcome:'pending',receipt:null,reapply:false});
 const saved=await f.store.commit(tombstone(f.store,origin));expect(saved.stage).toBe('absent-tombstoned');
 expect(await f.store.audit(q)).toMatchObject({outcome:'absent',receipt:saved});
 for(const changed of [false,true]){await f.open();const d=readDraft();if(changed)d.currentPinRef=H('8');await expect(f.store.commit(command(f.store,'intent-reserved',request(d)))).rejects.toThrow('tombstoned');}
});
it.each(['source-captured','response-ready','response-may-have-escaped'])('PBD05 rejects skipped stage %s without publishing',async stage=>{
 const f=await setup();await expect(f.store.commit(command(f.store,stage))).rejects.toThrow('stage-order');expect(f.anchor.casCalls).toBe(0);expect((await readdir(f.options.roots.journal)).filter(n=>n.startsWith('commit-'))).toHaveLength(0);
});
it('PBD06 rejects changed expected head / data / original request and preserves later data',async()=>{
 const f=await setup(),a=command(f.store),saved=await f.store.commit(a);
 for(const change of ['data','head','request']){
  await f.open();const c=JSON.parse(a);if(change==='data')c.dataWire='{"x":1}';if(change==='head')c.expectedHead=f.store.head;if(change==='request'){const r=readDraft();r.nonce=H('8');c.requestWire=request(r);}
  await expect(f.store.commit(C(c))).rejects.toThrow('operation-conflict');
 }
 await f.open();expect(await f.store.commit(a)).toEqual(saved);
});
it.each(['after-local-checkpoint','after-anchor','after-adoption','before-ack'] as const)('PBD07 interrupted %s withholds ACK and resolves exact origin on reopen',async point=>{
 const f=await setup();await f.open({fault:p=>{if(p===point)throw Error('fault');}});const a=command(f.store);let ack=0;
 await expect(f.store.commit(a).then(()=>ack++)).rejects.toThrow('fault');expect(ack).toBe(0);expect(f.store.diagnostics.blocked).toBe(true);
 await expect(f.store.commit(a)).rejects.toThrow('blocked');await f.open();expect((await f.store.commit(a)).appliedHead.revision).toBe(1);expect((await f.anchor.entries())).toHaveLength(1);
});
it('PBD08 lost anchor CAS response is queried, not re-applied, on reopen',async()=>{
 const f=await setup();f.anchor.fault=()=>{throw Error('reply lost');};const a=command(f.store);await expect(f.store.commit(a)).rejects.toThrow('reply lost');expect(f.anchor.casCalls).toBe(1);
 f.anchor.fault=undefined;await f.open();expect(f.anchor.casCalls).toBe(1);expect((await f.store.commit(a)).appliedHead.revision).toBe(1);expect(f.anchor.queryCalls).toBeGreaterThan(1);
});
it.each(['journal','checkpoint','adoption','adoptionCheckpoint'] as const)('PBD09 %s publication sync failure blocks ACK until successful re-sync',async area=>{
 const f=await setup();let armed=false;
 const fail:PB1StoreOptions['diskFault']=(a,p,n)=>{if(armed&&a===area&&p==='before-directory-sync'&&(n==='commit-00000001.json'||n==='checkpoint-00000001.json'))throw Error('sync failed');};
 await f.open({diskFault:fail});armed=true;const a=command(f.store);await expect(f.store.commit(a)).rejects.toThrow(/sync failed|checkpoint_unavailable/);f.store.close();
 await expect(PB1Store.open({...f.options,mode:'open',diskFault:fail})).rejects.toThrow(/sync failed|checkpoint_unavailable/);
 armed=false;await f.open();expect((await f.store.commit(a)).appliedHead.revision).toBe(1);
});
it.each(['after-publish','after-file-sync'] as const)('PBD10 real disk %s failure never ACKs or silently ignores uncommitted scratch',async phase=>{
 const f=await setup();let armed=false;await f.open({diskFault:(a,p,n)=>{if(armed&&a==='journal'&&p===phase&&n.startsWith('commit-'))throw Error('write failed');}});armed=true;const a=command(f.store);await expect(f.store.commit(a)).rejects.toThrow('write failed');
 if(phase==='after-publish'){await f.open();expect((await f.store.commit(a)).appliedHead.revision).toBe(1);}
 else{await expect(f.open()).rejects.toThrow('tail_unknown');expect((await readdir(f.options.roots.journal)).some(n=>n.startsWith('pending-'))).toBe(true);}
});
it.each(['expiry','revocation'])('PBD11 %s at final gate suppresses ACK but retains durable debt/history',async what=>{
 const f=await setup();await f.open({fault:p=>{if(p==='before-ack'){if(what==='expiry')f.setNow(5000);else f.revoke();}}});const a=command(f.store);
 await expect(f.store.commit(a)).rejects.toThrow();expect((await f.anchor.entries())).toHaveLength(1);expect((await readdir(f.options.roots.adoption)).filter(n=>n.startsWith('commit-'))).toHaveLength(1);
});
it('PBD12 failed live gate before IO performs no stage/anchor writes',async()=>{
 const f=await setup();f.setNow(5000);await expect(f.store.commit(command(f.store))).rejects.toThrow('expired');expect(f.anchor.casCalls).toBe(0);
});
it.each(['journal','checkpoint','adoption','adoptionCheckpoint'] as const)('PBD13 authenticated %s tampering refuses reopen',async area=>{
 const f=await setup();await f.store.commit(command(f.store));f.store.close();const root=f.options.roots[area],name=(await readdir(root)).find(n=>n.startsWith(area.toLowerCase().includes('checkpoint')?'checkpoint-':'commit-'))!;const b=await readFile(path.join(root,name));b[0]=b[0]!^1;await writeFile(path.join(root,name),b);
 await expect(f.open()).rejects.toThrow();
});
it('PBD14 rolling local journal + checkpoint + adoption back cannot roll the external head back',async()=>{
 const f=await setup();f.store.close();const backup=path.join(f.root,'backup');await mkdir(backup,{mode:0o700});for(const a of Object.keys(f.options.roots) as PB1Area[])await cp(f.options.roots[a],path.join(backup,a),{recursive:true});
 await f.open();await f.store.commit(command(f.store));f.store.close();for(const a of Object.keys(f.options.roots) as PB1Area[]){await rm(f.options.roots[a],{recursive:true});await cp(path.join(backup,a),f.options.roots[a],{recursive:true});}
 await expect(f.open()).rejects.toThrow('rollback-or-anchor-conflict');
});
it('PBD15 real anchor disk restart retains CAS and original receipt',async()=>{
 const f=await setup(),a=command(f.store),receipt=await f.store.commit(a);f.store.close();await f.restartAnchor();await f.open();expect(await f.store.commit(a)).toEqual(receipt);expect(f.anchor.casCalls).toBe(0);
});
it.each(['signature','stream','head','origin'])('PBD16 rejects %s anchor forgery/misbinding and publishes no ACK',async field=>{
 const f=await setup(),real=f.anchor;const fake={head:real.head.bind(real),query:real.query.bind(real),compareAndSwap:real.compareAndSwap.bind(real)};
 if(field==='signature'){fake.head=async (w,c)=>{const v=JSON.parse(await real.head(w,c));v.signature='A'.repeat(86)+'==';return C(v);};}
 if(field==='stream')fake.head=async (w,c)=>{const v=pb1VerifyAnchor(await real.head(w,c),f.pin);if(v.kind==='head')v.stream.realmId='other';return real.signed(v);};
 if(field==='head')fake.head=async (w,c)=>{const v=pb1VerifyAnchor(await real.head(w,c),f.pin);if(v.kind==='head')v.head.headDigest=H('8');return real.signed(v);};
 if(field==='origin')fake.query=async (w,_k,c)=>real.signed({kind:'origin',stream:JSON.parse(w),challenge:c,transactionKey:H('8'),receiptWire:null});
 if(field==='origin'){await f.open({anchor:fake});await expect(f.store.commit(command(f.store))).rejects.toThrow('anchor-origin');}
 else await expect(f.open({anchor:fake})).rejects.toThrow();
});
it('PBD17 duplicate writer, overlapping roots and key aliases refuse acquisition',async()=>{
 const f=await setup();await expect(PB1Store.open({...f.options,mode:'open'})).rejects.toThrow('writer_busy');
 await expect(PB1Store.open({...f.options,roots:{...f.options.roots,adoption:f.options.roots.journal}})).rejects.toThrow('roots-overlap');
 await expect(PB1Store.open({...f.options,keys:{...f.options.keys,adoption:f.options.keys.journal}})).rejects.toThrow('key-alias');
});
it('PBD18 caught reentry still poisons the outer ACK; close while busy is refused',async()=>{
 const f=await setup();let target:PB1Store|undefined,a='';await f.open({fault:async p=>{if(p==='before-ack'&&target){const t=target;expect(()=>t.close()).toThrow('busy');await expect(t.commit(a)).rejects.toThrow('reentrant');}}});target=f.store;a=command(f.store);await expect(f.store.commit(a)).rejects.toThrow('reentrant');expect(f.store.diagnostics.blocked).toBe(true);
});
it('PBD19 caps retained payload before writing; invalid/oversize data cannot consume an anchor slot',async()=>{
 const f=await setup();const a=JSON.parse(command(f.store));a.dataWire='"'+'a'.repeat(PB1_LIMITS.data)+'"';await expect(f.store.commit(C(a,PB1_LIMITS.command))).rejects.toThrow();expect(f.anchor.casCalls).toBe(0);
});
it('PBD21 local reservation arithmetic preserves 192 normal / 64 cleanup and rejects payload overflow',()=>{
 const c=pb1Command(C({schema:PB1_COMMAND_SCHEMA,kind:'stage',requestWire:request(),stage:'intent-reserved',expectedHead:head,previousStageRef:null,dataWire:'{}'}));
 const t=pb1Command(C({schema:PB1_COMMAND_SCHEMA,kind:'tombstone',queryWire:query(c.origin,head.headDigest),origin:c.origin,expectedHead:head,previousStageRef:null}));
 expect(pb1Reserve(Array(191).fill(c),c).normal).toBe(192);expect(()=>pb1Reserve(Array(192).fill(c),c)).toThrow('budget-stage');
 expect(pb1Reserve([...Array(192).fill(c),...Array(63).fill(t)],t)).toMatchObject({normal:192,cleanup:64});
 expect(()=>pb1Reserve(Array(64).fill(t),t)).toThrow('budget-stage');
 const big=pb1Command(C({...c.command,dataWire:C('x'.repeat(PB1_LIMITS.data-2))},PB1_LIMITS.command));
 expect(()=>pb1Reserve(Array(32).fill(big),big)).toThrow('budget-bytes');
});
it.each(['head','origin'] as const)('PBD22 rejects a valid old signed %s response under a new challenge',async kind=>{
 const f=await setup(),real=f.anchor,oldChallenge=H('7'),w=C(f.options.stream),a=command(f.store);
 const fake={head:real.head.bind(real),query:real.query.bind(real),compareAndSwap:real.compareAndSwap.bind(real)};
 if(kind==='head'){const old=await real.head(w,oldChallenge);fake.head=async()=>old;await expect(f.open({anchor:fake})).rejects.toThrow('challenge');}
 else{const old=await real.query(w,pb1Command(a).transactionKey,oldChallenge);fake.query=async()=>old;await f.open({anchor:fake});await expect(f.store.commit(a)).rejects.toThrow('anchor-origin');}
});
it('PBD23 loss of only the final local adoption is reconstructed from the exact anchor receipt',async()=>{
 const f=await setup();const a=command(f.store),one=await f.store.commit(a),r=readDraft(),backup=path.join(f.root,'adoption-backup');await mkdir(backup,{mode:0o700});f.store.close();
 for(const area of ['adoption','adoptionCheckpoint'] as const)await cp(f.options.roots[area],path.join(backup,area),{recursive:true});
 await f.open();r.operationId='second';const b=command(f.store,'intent-reserved',request(r)),two=await f.store.commit(b);f.store.close();
 for(const area of ['adoption','adoptionCheckpoint'] as const){await rm(f.options.roots[area],{recursive:true});await cp(path.join(backup,area),f.options.roots[area],{recursive:true});}
 const calls=f.anchor.casCalls;await f.open();expect(await f.store.commit(b)).toEqual(two);expect(await f.store.commit(a)).toEqual(one);expect(f.anchor.casCalls).toBe(calls);
});
it('PBD24 interrupted tombstone cannot publish absent until anchor/adoption recover',async()=>{
 const f=await setup(),origin=pb1Command(command(f.store)).origin;await f.open({fault:p=>{if(p==='after-local-checkpoint')throw Error('lost');}});const t=tombstone(f.store,origin);
 await expect(f.store.commit(t)).rejects.toThrow('lost');await expect(f.store.audit(query(origin,head.headDigest))).rejects.toThrow('blocked');
 await f.open();expect(await f.store.audit(query(origin,head.headDigest))).toMatchObject({outcome:'absent',reapply:false});await expect(f.store.commit(command(f.store))).rejects.toThrow('tombstoned');
});
it('PBD25 control mutation binds its PB0 expected owner head to the local CAS',async()=>{
 const f=await setup(),d=controlDraft();await expect(f.store.commit(command(f.store,'mutation-committed',request(d)))).rejects.toThrow('control-head');expect(f.anchor.casCalls).toBe(0);
 await f.open();d.expectedOwnerHead=f.store.head.headDigest;const c=command(f.store,'mutation-committed',request(d)),saved=await f.store.commit(c);expect(saved.stage).toBe('mutation-committed');expect(await f.store.commit(c)).toEqual(saved);
});
it('PBD26 missing recovery authority refuses before any root is opened',async()=>{
 const f=await setup();let calls=0;await expect(PB1Store.open({...f.options,roots:{...f.options.roots,journal:'/does-not-exist'},authorize:()=>{calls++;throw Error('no recovery grant');}})).rejects.toThrow('no recovery grant');expect(calls).toBe(1);
});
it.each(['journal','checkpoint','adoption','adoptionCheckpoint'] as const)('PBD27 %s symlink/foreign inventory remains unadopted',async area=>{
 const f=await setup();f.store.close();await symlink('/dev/null',path.join(f.options.roots[area],'blob-'+H('7')+'.bin'));await expect(f.open()).rejects.toThrow();
});
it('PBD28 unindexed durable blobs from a failed attempt stay charged and block reopen, not refunded',async()=>{
 const f=await setup();let armed=false;await f.open({journalFault:(a,p)=>{if(armed&&a==='journal'&&p==='before-commit')throw Error('disk-full');}});armed=true;
 await expect(f.store.commit(command(f.store))).rejects.toThrow('disk-full');const before=await readdir(f.options.roots.journal);expect(before.filter(n=>n.startsWith('blob-')).length).toBeGreaterThan(0);expect(f.anchor.casCalls).toBe(0);
 await expect(f.open()).rejects.toThrow('unaccounted-tail');expect(await readdir(f.options.roots.journal)).toEqual(before);
});
it('PBD29 tombstone writes cannot reuse the query control K with a different D/origin',async()=>{
 const f=await setup(),a=pb1Command(command(f.store)).origin,d=readDraft();d.operationId='other-origin';const b=pb1Command(command(f.store,'intent-reserved',request(d))).origin;
 const t=(origin:typeof a)=>{const q=controlDraft('QueryOperation',{origin});q.operationId='same-audit-key';q.expectedOwnerHead=f.store.head.headDigest;return C({schema:PB1_COMMAND_SCHEMA,kind:'tombstone',queryWire:request(q),origin,expectedHead:f.store.head,previousStageRef:null});};
 await f.store.commit(t(a));await expect(f.store.commit(t(b))).rejects.toThrow('query-operation-conflict');expect((await f.anchor.entries())).toHaveLength(1);
});
it.each(['realm','owner'] as const)('PBD30 audit %s mismatch rejects before history/file reads or anchor access',async field=>{
 const f=await setup(),a=command(f.store),saved=await f.store.commit(a),origin=pb1Command(a).origin;
 const foreignOrigin=field==='owner'?{...origin,owner:'custodian'}:origin,q=controlDraft('QueryOperation',{origin:foreignOrigin});
 q.expectedOwnerHead=f.store.head.headDigest;if(field==='realm')q.realmId='other-realm';else q.targetOwner='custodian';
 const foreign=request(q),own=query(origin,f.store.head.headDigest);
 const history=vi.spyOn(AuthorityJournal.prototype,'readHistory'),read=vi.spyOn(RootedJournalIO.prototype,'read'),counts=()=>[f.anchor.headCalls,f.anchor.queryCalls,f.anchor.casCalls],before=counts();
 await expect(f.store.audit(foreign)).rejects.toThrow('pb1-owner');
 expect(history).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(counts()).toEqual(before);
 expect(f.store.diagnostics.blocked).toBe(true);
 // Positive control on the same seeded store proves the observers see the real read path.
 await f.open();history.mockClear();read.mockClear();const heads=f.anchor.headCalls;
 expect(await f.store.audit(own)).toMatchObject({outcome:'historical',receipt:saved});expect(history.mock.calls.length).toBeGreaterThan(0);expect(read.mock.calls.length).toBeGreaterThan(0);expect(f.anchor.headCalls).toBe(heads+1);
});
it.each([
 ['authorize','commit'],['authorize','audit'],['fault','commit'],['fault','audit']
] as const)('PBD31 caught malformed JSON reentry from %s to %s suppresses outer ACK',async (port,method)=>{
 const f=await setup();let target:PB1Store|undefined,caught=0,innerError='';
 const inject=async()=>{if(!target)return;try{await target[method]('{');}catch(e){caught++;innerError=String(e);}};
 await f.open(port==='authorize'?{authorize:async(_wire,p)=>{if(p==='before-ack')await inject();}}:{fault:async p=>{if(p==='before-ack')await inject();}});target=f.store;
 const a=command(f.store);let ack=0;
 await expect(f.store.commit(a).then(r=>{ack++;return r;})).rejects.toThrow('reentrant');
 expect(caught).toBe(1);expect(innerError).toContain('reentrant');expect(ack).toBe(0);expect(f.store.diagnostics.blocked).toBe(true);
 // Already committed effects remain charged; poisoning never rolls the persisted transaction back.
 expect(await f.anchor.entries()).toHaveLength(1);await expect(f.store.commit(a)).rejects.toThrow('blocked');
 await f.open();expect((await f.store.commit(a)).appliedHead.revision).toBe(1);
});
it('PBD32 ordinary malformed JSON refusal does not poison an idle store',async()=>{
 const f=await setup();await expect(f.store.commit('{')).rejects.toThrow();await expect(f.store.audit('{')).rejects.toThrow();expect(f.store.diagnostics.blocked).toBe(false);
 expect((await f.store.commit(command(f.store))).appliedHead.revision).toBe(1);
});

async function nativeModules(root:string){
 // Execute the actual production compiler output. Strip-only execution cannot compile PB0's parameter property.
 execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json','--outDir',root],{stdio:'pipe',timeout:120000});
 const fixture=await readFile('src/test/fixtures/gradleOwnedP1Fixture.ts','utf8');await writeFile(path.join(root,'anchor.mjs'),stripTypeScriptTypes(fixture.replaceAll('../../utils/','./utils/')));
 await writeFile(path.join(root,'package.json'),'{"type":"module"}');await symlink(path.resolve('node_modules'),path.join(root,'node_modules'),'dir');
}
it.each(['after-local-checkpoint','after-anchor','after-adoption','before-ack'] as const)('PBD20 actual SIGKILL at %s recovers authenticated head and exact original receipt',async point=>{
 const f=await setup(),a=command(f.store);f.store.close();f.anchor.close();const childRoot=path.join(f.root,'child');await mkdir(childRoot,{mode:0o700});await nativeModules(childRoot);
 const {stream,roots}=f.options,pk=f.pair.privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
 const source=`const {PB1Store}=await import(new URL('./utils/gradleOwnedP1Store.js',import.meta.url));const {PB1DiskAnchorFixture}=await import(new URL('./anchor.mjs',import.meta.url));import {createPrivateKey} from 'node:crypto';
 const ao=${JSON.stringify({...f.anchorOptions,key:undefined,checkpointKey:undefined,mode:'open'})};ao.key=Buffer.alloc(32,8);ao.checkpointKey=Buffer.alloc(32,9);
 const anchor=await PB1DiskAnchorFixture.open(ao,createPrivateKey({key:Buffer.from(${JSON.stringify(pk)},'base64'),format:'der',type:'pkcs8'}),${JSON.stringify(f.pin)});
 const s=await PB1Store.open({stream:${JSON.stringify(stream)},roots:${JSON.stringify(roots)},keys:{journal:Buffer.alloc(32,1),checkpoint:Buffer.alloc(32,2),adoption:Buffer.alloc(32,3),adoptionCheckpoint:Buffer.alloc(32,4)},mode:'open',anchor,anchorPin:${JSON.stringify(f.pin)},now:()=>1,authorize:()=>{},fault:p=>{if(p===${JSON.stringify(point)})process.kill(process.pid,'SIGKILL');}});
 await s.commit(${JSON.stringify(a)});console.log('UNEXPECTED-ACK');process.exit(2);`;
 await writeFile(path.join(childRoot,'child.mjs'),source);const child=spawn(process.execPath,[path.join(childRoot,'child.mjs')],{cwd:childRoot,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const ended=await new Promise<{code:number|null;signal:string|null}>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('child timeout '+err));},15000);child.once('error',reject);child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
 expect(ended.signal,err).toBe('SIGKILL');expect(out).not.toContain('ACK');await f.restartAnchor();await f.open();const saved=await f.store.commit(a);expect(saved.appliedHead.revision).toBe(1);expect((await f.anchor.entries())).toHaveLength(1);
});
