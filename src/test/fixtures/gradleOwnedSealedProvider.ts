/** Q2/B2 local-disk contract fixture. No IPC, independent registry or adoption. */
import {randomBytes} from 'node:crypto';
import {z} from 'zod';
import {canonicalOwnedJson,ownedDigest,ownedSha256,parseOwnedJson} from '../../utils/gradleOwnedJson.js';
import {OwnedJournalDisk} from './gradleOwnedJournalDisk.js';
import {RootedJournalIO} from './gradleOwnedJournalFs.js';
import {sealJournalValue,openJournalValue,type JournalRecord} from './gradleOwnedAuthorityJournal.js';
import {replayV2,v2BindingSchema,type V2ReplayInput} from './gradleOwnedJournalV2.js';

export const SEALED_LIMITS=Object.freeze({entries:512,fileBytes:8*1024*1024,sourceBytes:64*1024*1024,
 retainedBytes:128*1024*1024,namespaces:32,markerBytes:256*1024,uses:64});
const hash=z.string().regex(/^[a-f0-9]{64}$/),uint=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),pos=uint.positive();
const root=z.object({device:z.string().regex(/^[0-9]+$/),inode:z.string().regex(/^[0-9]+$/)}).strict();
const head=z.object({revision:pos.max(256),commitDigest:hash,stateRoot:hash}).strict();
const entry=z.object({name:z.string().regex(/^(?:commit-[0-9]{8}\.json|blob-[a-f0-9]{64}\.bin)$/),size:uint.max(SEALED_LIMITS.fileBytes),sha256:hash}).strict();
const metadata=z.object({binding:v2BindingSchema,baseRef:z.object({role:z.literal('compacted-base'),id:z.string().min(1).max(1024),sha256:hash,byteLength:uint.max(64*1024*1024)}).strict(),
 keyId:z.string().min(1).max(1024),approvedBaseDigest:hash,checkpoint:z.object({revision:pos.max(256),commitDigest:hash}).strict(),auditAuthoritySnapshot:z.boolean()}).strict();
const marker=z.object({schema:z.literal('osv-mcp.q2b.sealed-namespace.v1'),contextDigest:hash,namespaceId:hash,
 generation:pos,fence:pos,root,expectedSelected:hash.nullable(),source:metadata,head,
 inventory:z.array(entry).min(1).max(SEALED_LIMITS.entries-2),inventoryRoot:hash}).strict();
type Marker=z.infer<typeof marker>;
const reservation=z.object({namespaceId:hash,generation:pos,fence:pos,root,
 phase:z.enum(['sealing','sealed','quarantined','retired']),markerDigest:hash.nullable(),
 reservedBytes:pos.max(SEALED_LIMITS.sourceBytes+SEALED_LIMITS.markerBytes),entries:pos.max(SEALED_LIMITS.entries)}).strict();
const ledger=z.object({schema:z.literal('osv-mcp.q2b.namespace-ledger.v1'),contextDigest:hash,
 controlRoots:z.array(root).length(2),lastGeneration:uint,selected:hash.nullable(),
 uses:z.array(z.object({grantId:hash,useId:hash,receiptDigest:hash,completeDigest:hash,readerDigest:hash,identityDigest:hash}).strict()).max(SEALED_LIMITS.uses),
 namespaces:z.array(reservation).max(SEALED_LIMITS.namespaces)}).strict();
type Ledger=z.infer<typeof ledger>;
export type SealedCandidate=Readonly<{kind:'sealed-namespace-candidate'}>;
export interface SealedStoreOptions {control:OwnedJournalDisk;contextDigest:string;sealKeyId:string;sealKey:Buffer;sourceKey:Buffer;
 limits?:{retainedBytes?:number;namespaces?:number;uses?:number};
 selectedIO?:RootedJournalIO;fault?:(phase:'after-reservation'|'after-inventory'|'after-marker'|'before-select'|'after-selection')=>void|Promise<void>}
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a)===canonicalOwnedJson(b),fresh=()=>randomBytes(32).toString('hex');
export class SealedProviderError extends Error{constructor(reason:string){super('sealed_provider_'+reason);}}
function need(ok:unknown,reason:string):asserts ok{if(!ok)throw new SealedProviderError(reason);}
function records(state:Ledger):JournalRecord[]{return [
 {role:'session-manifest',id:'root',bytes:Buffer.from(canonicalOwnedJson(state))},
 {role:'session-index',id:'root',bytes:Buffer.from(canonicalOwnedJson({selected:state.selected}))},
 {role:'event-ledger',id:'namespaces',bytes:Buffer.from(canonicalOwnedJson({lastGeneration:state.lastGeneration,namespaces:state.namespaces}))},
 {role:'operation-result',id:'root',bytes:Buffer.from(canonicalOwnedJson({stateDigest:ownedDigest(state),backendEligible:false,originalReadsSkipped:0}))},
 ];}
function cloneInput(input:V2ReplayInput):V2ReplayInput{
 // Copy before the first await. Buffer values and caller objects are never retained.
 const meta=metadata.parse({...JSON.parse(canonicalOwnedJson({binding:input.binding,baseRef:input.baseRef,keyId:input.keyId,
  approvedBaseDigest:input.approvedBaseDigest,checkpoint:input.checkpoint})),auditAuthoritySnapshot:input.auditAuthoritySnapshot??false});
 need(Buffer.isBuffer(input.key)&&input.key.length===32&&Array.isArray(input.commits)&&input.commits.length<=256&&Array.isArray(input.payloads)&&input.payloads.length<=SEALED_LIMITS.entries,'budget_exceeded');
 let bytes=0;for(const b of [...input.commits,...input.payloads]){need(Buffer.isBuffer(b)&&b.length<=SEALED_LIMITS.fileBytes,'budget_exceeded');bytes+=b.length;need(bytes<=SEALED_LIMITS.sourceBytes,'budget_exceeded');}
 return {...meta,key:Buffer.from(input.key),commits:input.commits.map(b=>Buffer.from(b)),payloads:input.payloads.map(b=>Buffer.from(b))};
}
export class SealedPrefixStore{
 readonly #config:SealedStoreOptions;readonly #boot=fresh();#state!:Ledger;#blocked=false;#closed=false;#busy=false;
 // A refusal raised before this run wrote anything leaves the owner usable; any later failure is fail-stop.
 #wrote=false;readonly #refusals=new WeakSet<object>();
 readonly #limits:{retainedBytes:number;namespaces:number;uses:number};
 #ios=new Map<string,RootedJournalIO>();#candidates=new WeakMap<SealedCandidate,{id:string;boot:string}>();
 #metrics={fullVerifications:0,contentReadBytes:0,seals:0,selections:0,recoveries:0};
 private constructor(c:SealedStoreOptions){hash.parse(c.contextDigest);need(Buffer.isBuffer(c.sealKey)&&c.sealKey.length===32&&Buffer.isBuffer(c.sourceKey)&&c.sourceKey.length===32,'configuration_invalid');this.#config={...c,sealKey:Buffer.from(c.sealKey),sourceKey:Buffer.from(c.sourceKey)};this.#limits={retainedBytes:SEALED_LIMITS.retainedBytes,namespaces:SEALED_LIMITS.namespaces,uses:SEALED_LIMITS.uses};for(const [key,value]of Object.entries(c.limits??{})){need((key==='retainedBytes'||key==='namespaces'||key==='uses')&&Number.isSafeInteger(value)&&value>0&&value<=this.#limits[key],'configuration_invalid');this.#limits[key]=value;}}
 static async open(config:SealedStoreOptions):Promise<SealedPrefixStore>{
  const p=new SealedPrefixStore(config);await p.#config.control.revalidate();const rows=await p.#config.control.journal.readLatest();
  if(rows.length===0){p.#state={schema:'osv-mcp.q2b.namespace-ledger.v1',contextDigest:p.#config.contextDigest,
   controlRoots:p.#config.control.rootIdentities,lastGeneration:0,selected:null,namespaces:[],uses:[]};await p.#save(p.#state);}
  else p.#state=p.#decodeLedger(rows);
  // Reservation and capacity survive process death. Never re-open an unfinished generation.
  const next=structuredClone(p.#state);let dirty=false;
  for(const ns of next.namespaces)if(ns.phase==='sealing'||ns.phase==='sealed'&&ns.namespaceId!==next.selected){ns.phase='quarantined';dirty=true;}
  if(dirty)await p.#save(next);
  if(p.#state.selected){need(p.#config.selectedIO instanceof RootedJournalIO&&p.#config.selectedIO.ownsWriterLock,'selected_root_missing');p.#ios.set(p.#state.selected,p.#config.selectedIO);await p.#verify(p.#state.selected,true);p.#metrics.recoveries++;}
  return p;
 }
 #decodeLedger(rows:JournalRecord[]):Ledger{
  const body=rows.find(r=>r.role==='session-manifest');need(body,'ledger_invalid');
  const value=ledger.parse(parseOwnedJson(body.bytes.toString('utf8')));
  need(value.contextDigest===this.#config.contextDigest&&same(value.controlRoots,this.#config.control.rootIdentities),'binding_mismatch');
  const expected=records(value);need(rows.length===expected.length&&expected.every(e=>rows.some(r=>r.role===e.role&&r.id===e.id&&r.bytes.equals(e.bytes))),'ledger_invalid');
  const ids=new Set<string>(),roots=new Set<string>(),generations=new Set<number>();
  for(const ns of value.namespaces){need(!ids.has(ns.namespaceId)&&!roots.has(ownedDigest(ns.root))&&!generations.has(ns.generation)&&ns.fence===ns.generation&&ns.generation<=value.lastGeneration,'ledger_invalid');ids.add(ns.namespaceId);roots.add(ownedDigest(ns.root));generations.add(ns.generation);}
  need(value.lastGeneration===value.namespaces.length&&generations.size===value.lastGeneration&&value.namespaces.length<=this.#limits.namespaces&&value.namespaces.reduce((n,s)=>n+s.reservedBytes,0)<=this.#limits.retainedBytes,'ledger_invalid');
  need(value.uses.length<=this.#limits.uses&&new Set(value.uses.map(u=>u.grantId)).size===value.uses.length&&new Set(value.uses.map(u=>u.useId)).size===value.uses.length,'ledger_invalid');
  need(value.selected===null||value.namespaces.some(s=>s.namespaceId===value.selected&&s.phase==='sealed'&&s.markerDigest),'ledger_invalid');return value;
 }
 async #load(){await this.#config.control.revalidate();const state=this.#decodeLedger(await this.#config.control.journal.readLatest());need(same(state,this.#state),'generation_changed');}
 #refuse(ok:unknown,reason:string):asserts ok{if(!ok){const error=new SealedProviderError(reason);if(!this.#wrote)this.#refusals.add(error);throw error;}}
 #put(io:RootedJournalIO,name:string,bytes:Buffer){this.#wrote=true;return io.put(name,bytes);}
 async #save(state:Ledger){
  this.#wrote=true;const parsed=ledger.parse(state),expectedHead=this.#config.control.journal.head;
  await this.#config.control.journal.commit({operationId:'namespace-'+fresh(),requestDigest:ownedDigest(parsed),records:records(parsed),expectedHead});this.#state=parsed;
 }
 async #run<T>(work:()=>Promise<T>):Promise<T>{need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');need(!this.#busy,'busy');this.#busy=true;this.#wrote=false;try{return await work();}catch(e){if(!(e instanceof Object&&this.#refusals.has(e)))this.#blocked=true;throw e;}finally{this.#busy=false;}}
 #sourceContext(input:Pick<V2ReplayInput,'binding'|'approvedBaseDigest'>){need(ownedDigest({binding:input.binding,base:input.approvedBaseDigest})===this.#config.contextDigest,'binding_mismatch');}
 async #inventory(io:RootedJournalIO,entries:Marker['inventory'],withMarker:boolean){
  const files=await io.list(SEALED_LIMITS.entries);need(files.length<=SEALED_LIMITS.entries,'budget_exceeded');
  need(files.length===entries.length+(withMarker?1:0)&&new Set(files.map(f=>f.name)).size===files.length,'inventory_mismatch');
  for(const file of files){if(withMarker&&file.name==='journal.meta')continue;const expected=entries.find(e=>e.name===file.name);need(expected&&expected.size===file.size,'inventory_mismatch');const bytes=await io.read(file.name,SEALED_LIMITS.fileBytes);this.#metrics.contentReadBytes+=bytes.length;need(ownedSha256(bytes)===expected.sha256,'content_mismatch');}
 }
 async prepare(io:RootedJournalIO,supplied:V2ReplayInput):Promise<SealedCandidate>{
  const input=cloneInput(supplied);this.#sourceContext(input);need(input.key.equals(this.#config.sourceKey),'binding_mismatch');
  return this.#run(async()=>{
   await this.#load();this.#refuse(io instanceof RootedJournalIO&&io.ownsWriterLock,'root_invalid');const identity=io.rootIdentity();
   this.#refuse(![...this.#state.controlRoots,...this.#state.namespaces.map(n=>n.root)].some(r=>same(r,identity)),'root_reused');
   this.#refuse((await io.list(SEALED_LIMITS.entries)).length===0,'root_not_empty');const result=replayV2(input);
   const files=new Map<string,Buffer>();input.commits.forEach((b,i)=>files.set('commit-'+String(i+1).padStart(8,'0')+'.json',b));input.payloads.forEach(b=>files.set('blob-'+ownedSha256(b)+'.bin',b));
   const inventory=[...files].map(([name,b])=>({name,size:b.length,sha256:ownedSha256(b)})).sort((a,b)=>a.name<b.name?-1:1);
   this.#refuse(inventory.length+2<=SEALED_LIMITS.entries,'budget_exceeded');const reservedBytes=[...files.values()].reduce((n,b)=>n+b.length,0)+SEALED_LIMITS.markerBytes;
   this.#refuse(this.#state.namespaces.length<this.#limits.namespaces&&this.#state.namespaces.reduce((n,s)=>n+s.reservedBytes,0)+reservedBytes<=this.#limits.retainedBytes,'budget_exceeded');
   const id=fresh(),generation=this.#state.lastGeneration+1,base=this.#state.selected,next=structuredClone(this.#state);
   next.lastGeneration=generation;next.namespaces.push({namespaceId:id,generation,fence:generation,root:identity,phase:'sealing',markerDigest:null,reservedBytes,entries:inventory.length+1});
   await this.#save(next);this.#ios.set(id,io);
   try{
    await this.#config.fault?.('after-reservation');for(const [name,bytes]of files)await this.#put(io,name,bytes);
    await this.#inventory(io,inventory,false);await this.#config.fault?.('after-inventory');await this.#inventory(io,inventory,false);
    const {key:_,commits:__,payloads:___,...source}=input;
    const body=marker.parse({schema:'osv-mcp.q2b.sealed-namespace.v1',contextDigest:this.#config.contextDigest,namespaceId:id,generation,fence:generation,root:identity,expectedSelected:base,source,
     head:{revision:result.revision,commitDigest:result.commitDigest,stateRoot:result.stateRoot},inventory,inventoryRoot:ownedDigest(inventory)});
    const bytes=sealJournalValue(body,this.#config.sealKeyId,this.#config.sealKey);need(bytes.length<=SEALED_LIMITS.markerBytes,'budget_exceeded');
    await this.#put(io,'journal.meta',bytes);await this.#config.fault?.('after-marker');await this.#inventory(io,inventory,true);
    need((await io.read('journal.meta',SEALED_LIMITS.markerBytes)).equals(bytes),'content_mismatch');await this.#put(io,'journal.meta',bytes);
    const sealed=structuredClone(this.#state),ns=sealed.namespaces.find(n=>n.namespaceId===id)!;ns.phase='sealed';ns.markerDigest=ownedSha256(bytes);await this.#save(sealed);
    const handle=Object.freeze({kind:'sealed-namespace-candidate' as const});this.#candidates.set(handle,{id,boot:this.#boot});this.#metrics.seals++;return handle;
   }catch(error){
    const quarantined=structuredClone(this.#state),ns=quarantined.namespaces.find(n=>n.namespaceId===id)!;ns.phase='quarantined';await this.#save(quarantined);throw error;
   }
  });
 }
 async #verify(id:string,sync:boolean){
  const ns=this.#state.namespaces.find(n=>n.namespaceId===id),io=this.#ios.get(id);need(ns&&io&&ns.phase==='sealed'&&ns.markerDigest,'snapshot_unavailable');
  need(same(io.rootIdentity(),ns.root),'root_changed');const bytes=await io.read('journal.meta',SEALED_LIMITS.markerBytes);
  need(ownedSha256(bytes)===ns.markerDigest,'content_mismatch');const body=openJournalValue(bytes,this.#config.sealKeyId,this.#config.sealKey,marker);
  need(body.namespaceId===id&&body.generation===ns.generation&&body.fence===ns.fence&&same(body.root,ns.root)&&body.contextDigest===this.#config.contextDigest&&ownedDigest(body.inventory)===body.inventoryRoot,'binding_mismatch');
  need(new Set(body.inventory.map(e=>e.name)).size===body.inventory.length&&same(body.inventory,[...body.inventory].sort((a,b)=>a.name<b.name?-1:1)),'inventory_mismatch');this.#sourceContext(body.source);
  await this.#inventory(io,body.inventory,true);const commits:Buffer[]=[],payloads:Buffer[]=[];
  for(const item of body.inventory){const data=await io.read(item.name,SEALED_LIMITS.fileBytes);need(ownedSha256(data)===item.sha256&&data.length===item.size,'content_mismatch');if(item.name.startsWith('commit-'))commits.push(data);else payloads.push(data);if(sync)await this.#put(io,item.name,data);}
  const input:V2ReplayInput={...body.source,key:Buffer.from(this.#config.sourceKey),commits,payloads},result=replayV2(input);this.#metrics.fullVerifications++;
  need(same(body.head,{revision:result.revision,commitDigest:result.commitDigest,stateRoot:result.stateRoot}),'content_mismatch');
  if(sync)await this.#put(io,'journal.meta',bytes);await this.#inventory(io,body.inventory,true);need((await io.read('journal.meta',SEALED_LIMITS.markerBytes)).equals(bytes)&&same(io.rootIdentity(),ns.root),'content_mismatch');
  return {input,marker:body,markerDigest:ns.markerDigest,backendEligible:false as const,originalReadsSkipped:0 as const};
 }
 async select(handle:SealedCandidate){
  const candidate=this.#candidates.get(handle);need(candidate?.boot===this.#boot,'fence_invalid');
  return this.#run(async()=>{
   // Caller-level checks use read-only verification so a stale candidate is refused before any write.
   await this.#load();const next=await this.#verify(candidate.id,false);this.#refuse(next.marker.expectedSelected===this.#state.selected,'fence_invalid');
   if(this.#state.selected){const old=await this.#verify(this.#state.selected,false);this.#refuse(next.marker.head.revision>old.marker.head.revision,'head_invalid');for(const e of old.marker.inventory)this.#refuse(next.marker.inventory.some(n=>same(e,n)),'prefix_changed');}
   await this.#config.fault?.('before-select');await this.#verify(candidate.id,true);
   if(this.#state.selected)await this.#verify(this.#state.selected,true);
   const state=structuredClone(this.#state);if(state.selected)state.namespaces.find(n=>n.namespaceId===state.selected)!.phase='retired';state.selected=candidate.id;
   await this.#save(state);await this.#config.fault?.('after-selection');this.#candidates.delete(handle);this.#metrics.selections++;
   return {namespaceId:candidate.id,markerDigest:next.markerDigest,generation:next.marker.generation,fence:next.marker.fence,head:structuredClone(next.marker.head),backendEligible:false as const};
  });
 }
 async readSelected(){return this.#run(async()=>{await this.#load();this.#refuse(this.#state.selected,'snapshot_missing');return this.#verify(this.#state.selected,true);});}
 describeCandidate(handle:SealedCandidate){const data=this.#candidates.get(handle);need(data?.boot===this.#boot,'fence_invalid');const ns=this.#state.namespaces.find(n=>n.namespaceId===data.id);need(ns?.phase==='sealed'&&ns.markerDigest,'snapshot_unavailable');return Object.freeze({markerDigest:ns.markerDigest,generation:ns.generation,fence:ns.fence});}
 async recordUse(value:Ledger['uses'][number]){const use=ledger.shape.uses.element.parse(value);return this.#run(async()=>{await this.#load();const old=this.#state.uses.find(u=>u.grantId===use.grantId||u.useId===use.useId);if(old){this.#refuse(same(old,use),'use_conflict');return;}this.#refuse(this.#state.uses.length<this.#limits.uses,'uses_exhausted');const next=structuredClone(this.#state);next.uses.push(use);await this.#save(next);});}
 /** Whether a Complete for grantId can be recorded: an idempotent retry, or capacity left in the ledger. */
 hasUseCapacity(grantId:unknown){return this.#state.uses.some(u=>u.grantId===grantId)||this.#state.uses.length<this.#limits.uses;}
 historicalUse(grantId:string,useId:string){const use=this.#state.uses.find(u=>u.grantId===grantId&&u.useId===useId);need(use,'use_missing');return {...use,historical:true as const,backendEligible:false as const,originalReadsSkipped:0 as const};}
 view(){return structuredClone({boot:this.#boot,phase:this.#closed?'closed':this.#blocked?'unavailable':'diagnostic-only',selected:this.#state.selected,
  ledger:this.#state,metrics:this.#metrics,backendEligible:false,originalReadsSkipped:0});}
 close(){need(!this.#busy,'busy');this.#closed=true;}
}
