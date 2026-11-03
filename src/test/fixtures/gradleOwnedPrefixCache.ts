/** Q3 diagnostic byte cache. Memory-owned source, full MAC/history replay on every use.
 * No native reads, suffix-only authentication, authority restoration or production adoption. */
import {canonicalOwnedJson,ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
import {replayV2,type V2ReplayInput} from './gradleOwnedJournalV2.js';
type Handle=Readonly<{kind:'q3-diagnostic-handle'}>;
type Snapshot={input:V2ReplayInput;identity:string;inventory:Map<string,Buffer>;bytes:number};
type Candidate={snapshot:Snapshot;epoch:number;hit:boolean;uncachedInputBytes:number;referenceInputBytes:number;result:ReturnType<typeof replayV2>};
const LIMIT=64*1024*1024;
function need(ok:unknown,reason:string):asserts ok{if(!ok)throw new Error('prefix_cache_'+reason);}
function copy(input:V2ReplayInput):V2ReplayInput{
 need(Buffer.isBuffer(input.key)&&input.key.length===32,'configuration');
 need(Array.isArray(input.commits)&&input.commits.length<=256&&Array.isArray(input.payloads)&&input.payloads.length<=8192,'budget');
 let total=0;for(const b of [...input.commits,...input.payloads]){need(Buffer.isBuffer(b),'bytes');total+=b.length;need(total<=LIMIT,'budget');}
 return {...JSON.parse(canonicalOwnedJson({binding:input.binding,baseRef:input.baseRef,keyId:input.keyId,approvedBaseDigest:input.approvedBaseDigest,checkpoint:input.checkpoint,auditAuthoritySnapshot:input.auditAuthoritySnapshot??false})),key:Buffer.from(input.key),commits:input.commits.map(b=>Buffer.from(b)),payloads:input.payloads.map(b=>Buffer.from(b))};
}
function inventory(input:V2ReplayInput){const map=new Map<string,Buffer>();input.commits.forEach((b,i)=>map.set('commit:'+i,b));for(const b of input.payloads){const name='blob:'+ownedSha256(b);need(!map.has(name),'duplicate_payload');map.set(name,b);}return map;}
const handle=():Handle=>Object.freeze({kind:'q3-diagnostic-handle'});
export class DiagnosticPrefixCache{
 #snapshots=new WeakMap<Handle,Snapshot>();#candidates=new WeakMap<Handle,Candidate>();#cache:Snapshot[]=[];#epoch=1;#closed=false;#blocked=false;#checkpoint='ready';
 #sourceBytes=0;#sourceCount=0;#hits=0;#misses=0;#completed=0;#evictions=0;#pending=0;#pendingBytes=0;
 readonly #limit:number;
 constructor(limit=LIMIT){need(Number.isSafeInteger(limit)&&limit>=0&&limit<=LIMIT,'configuration');this.#limit=limit;}
 #gate(){need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');need(this.#checkpoint==='ready','checkpoint_'+this.#checkpoint);}
 seal(supplied:V2ReplayInput):Handle{
  this.#gate();const input=copy(supplied);replayV2(input);const files=inventory(input),bytes=[...files.values()].reduce((n,b)=>n+b.length,0);
  need(this.#sourceCount<8&&this.#sourceBytes+bytes<=LIMIT,'source_budget');
  const h=handle(),identity=ownedDigest({binding:input.binding,baseRef:input.baseRef,keyId:input.keyId,keyDigest:ownedSha256(input.key),base:input.approvedBaseDigest,audit:input.auditAuthoritySnapshot??false});
  this.#snapshots.set(h,{input,identity,inventory:files,bytes});this.#sourceBytes+=bytes;this.#sourceCount++;return h;
 }
 verify(h:Handle):Handle{
  this.#gate();const snapshot=this.#snapshots.get(h);need(snapshot,'handle');need(this.#pending<16&&this.#pendingBytes+snapshot.bytes<=LIMIT,'pending_budget');
  // These exact immutable source maps are private to this diagnostic owner. Wire digests
  // or external providers cannot establish this property or construct cache entries.
  const prefix=[...this.#cache].filter(p=>p.identity===snapshot.identity).sort((a,b)=>b.input.commits.length-a.input.commits.length)[0];
  if(prefix){
   try{need(prefix.input.commits.length<=snapshot.input.commits.length,'rollback');for(const [name,b]of prefix.inventory)need(snapshot.inventory.get(name)?.equals(b),'prefix_changed');}
   catch(error){this.#blocked=true;this.invalidate();throw error;}
  }
  let read=0;const take=(name:string,b:Buffer)=>{const old=prefix?.inventory.get(name);if(old)return Buffer.from(old);read+=b.length;return Buffer.from(b);};
  const input={...snapshot.input,commits:snapshot.input.commits.map((b,i)=>take('commit:'+i,b)),payloads:snapshot.input.payloads.map(b=>take('blob:'+ownedSha256(b),b))};
  const result=replayV2(input),reference=replayV2(copy(snapshot.input));
  const summary=(r:typeof result)=>({...r,records:r.records.map(row=>({key:row.key,bytes:row.bytes.toString('base64')}))});
  need(canonicalOwnedJson(summary(result))===canonicalOwnedJson(summary(reference)),'reference_mismatch');
  const candidate=handle();this.#candidates.set(candidate,{snapshot,epoch:this.#epoch,hit:!!prefix,uncachedInputBytes:read,referenceInputBytes:snapshot.bytes,result});this.#pending++;this.#pendingBytes+=snapshot.bytes;return candidate;
 }
 complete(h:Handle){
  this.#gate();const c=this.#candidates.get(h);need(c&&c.epoch===this.#epoch,'candidate');
  // A successful publication changes the cache view. Concurrent candidates must
  // verify again; an older completion cannot replace a newer committed proof.
  this.#epoch++;this.#candidates=new WeakMap();this.#pending=0;this.#pendingBytes=0;
  if(c.snapshot.bytes<=this.#limit){this.#cache=this.#cache.filter(p=>p!==c.snapshot);while(this.#cache.reduce((n,p)=>n+p.bytes,0)+c.snapshot.bytes>this.#limit){this.#cache.shift();this.#evictions++;}this.#cache.push(c.snapshot);}
  this.#completed++;if(c.hit)this.#hits++;else this.#misses++;
  return Object.freeze({hit:c.hit,equivalent:true,revision:c.result.revision,stateRoot:c.result.stateRoot,commitDigest:c.result.commitDigest,retainedPayloads:[...c.result.retainedPayloads],uncachedInputBytes:c.uncachedInputBytes,referenceInputBytes:c.referenceInputBytes,
   fullHistoryAuthenticated:true,checkpointSynchronizationObserved:false,nativeReadReductionObserved:false,backendEligible:false,originalReadsSkipped:0});
 }
 evict(){this.#cache=[];this.#epoch++;this.#candidates=new WeakMap();this.#pending=0;this.#pendingBytes=0;}
 invalidate(){this.evict();}
 checkpoint(state:'ready'|'unavailable'|'sync-incomplete'|'rollback'|'tail-unknown'){this.#checkpoint=state;if(state!=='ready')this.invalidate();}
 close(){this.invalidate();this.#closed=true;}
 get metrics(){return Object.freeze({cacheBytes:this.#cache.reduce((n,p)=>n+p.bytes,0),cacheEntries:this.#cache.length,sourceBytes:this.#sourceBytes,hits:this.#hits,misses:this.#misses,completed:this.#completed,evictions:this.#evictions,originalReadsSkipped:0,backendEligible:false});}
}
