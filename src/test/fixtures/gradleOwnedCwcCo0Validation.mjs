/** Independent storage bytes / managed-protocol replay. Never certifies primitive temporaries or CPU work. */
import {createHash} from 'node:crypto';
import {validateLg0Context} from './gradleOwnedCwcLg0Context.mjs';
import {lg0MemoryBound} from './gradleOwnedCwcLg0Validation.mjs';
export const co0Canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(co0Canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+co0Canonical(v[k])).join(',')+'}';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const co0Hash=v=>sha(co0Canonical(v));
const need=(v,r)=>{if(!v)throw Error('co0_record_'+r);},same=(a,b)=>co0Canonical(a)===co0Canonical(b);
const keys=(v,list)=>need(v&&same(Object.keys(v).sort(),list.split(' ').sort()),'schema');
export const CO0_SCOPE_EXPECTED={standalone:true,fixedClock:true,realCommandSchema:true,privateSlabs:true,managedLeaseProtocol:true,logicalLayoutOnly:true,diagnosticExportsExcluded:true,
 realAandB:false,actualReadScope:false,actualSession:false,sourceIO:false,normalizerTemporariesBound:false,metadataBridgeWithin4096:false,
 completeWorkCoverage:false,threeSlotBoundEstablished:false,budgetCoexistenceProved:false,lgModesConnected:false,kDRetryEstablished:false,lg0ExitEstablished:false,productionAdopted:false};

/** Independent canonical command oracle for the fixed nine-entry 41,460-byte input.
 * It invokes neither the new normalizer nor the original command/expected builder. */
export function co0ExpectedRows(c){
 const sizes=[1,1,1,1,8288,8288,8288,8288,8304],entries=sizes.map((n,i)=>({kind:i===0?'commit':'payload',index:i===0?0:i-1,sha256:sha(Buffer.alloc(n,65+i)),byteLength:n}));
 const range=(e,offset,length,ordinal=0)=>({ordinal,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}});
 const groups=[entries.slice(0,4).map((e,i)=>range(e,0,e.byteLength,i))];
 for(let i=4;i<9;i++){const e=entries[i],count=i<7?4:3;let offset=0;for(let j=0;j<count;j++){const length=Math.ceil((e.byteLength-offset)/(count-j));groups.push([range(e,offset,length)]);offset+=length;}}
 const specDigest=co0Hash({schema:'cpr.semantic-spec.v1',packing:'max-feasible-prefix-v1',layout:'cpr.actual-codec-bound.v1',entries:9,sourceBytes:41460,inventoryBytes:4096,batches:19,ranges:4,dataBytes:4096,innerBytes:8192,frameBytes:16384,wireBytes:67108864,workUnits:67108864});
 const seed='s'.repeat(128),transferId='t'.repeat(128),core={domain:'cpr.plan-core.v3',specDigest,catalog:c.catalog,peer:c.peer,provider:c.provider,...(c.origin?{origin:c.origin}:{}),lineage:c.lineage,binding:c.binding,snapshot:c.snapshot,checkpoint:c.checkpoint,pin:c.pin,metadataDigest:c.metadataDigest,inventoryDigest:c.inventoryDigest,seed,transferId,groups},planDigest=co0Hash(core);
 return groups.map((ranges,batchOrdinal)=>{const command={schema:'osv-mcp.cgp.source-command.v3',api:'aux.ReadSourceRanges',purpose:'read',
  operationId:co0Hash({domain:'cpr.operation-id.v3',peer:c.peer,provider:c.provider,lineage:c.lineage,seed,transferId,batchOrdinal}),peer:c.peer,lineage:c.lineage,binding:c.binding,
  payload:{snapshot:c.snapshot,checkpoint:c.checkpoint,pin:c.pin,...(c.origin?{origin:c.origin}:{}),transferId,plan:{specDigest,seed,batchOrdinal,batchCount:19,planDigest,inventoryDigest:c.inventoryDigest},ranges,byteBudget:ranges.reduce((n,r)=>n+r.length,0)}};
  const text=co0Canonical({...command,requestDigest:co0Hash({domain:'cpr.wire-intent.v3',command})});return {bytes:Buffer.byteLength(text),sha256:sha(text)};
 });
}
/** Source recipe replay, not a second run of the fixture's event writer. */
export function co0ExpectedTrace(families,closed=false){
 const rows=[],live=new Set();let managed=0,id=0,actor=255,ordinal=0;
 const event=(kind,extra=0)=>rows.push({seq:rows.length,kind,actor,ordinal,active:live.size,extra,managed,generation:actor===255?0:1});
 const take=()=>{const x=++id;live.add(x);managed++;event('lease',x);return x;};
 const drop=x=>{need(live.delete(x),'recipe');managed++;event('release',x);};
 const scratch=()=>{event('scratch');event('scratch-end');};
 managed++;event('claim');
 for(actor=0;actor<families;actor++){
  ordinal=0;managed++;scratch();scratch();event('open');
  for(ordinal=0;ordinal<19;ordinal++){
   managed+=2;const q=take();scratch();scratch();const text=take();scratch();event('frame-exit',1);drop(text);drop(q);event('capture');
  }
  for(ordinal=0;ordinal<19;ordinal++){
   managed+=2;const text=take(),input=take();event('frame-exit',2);drop(text);event('decode');
   const q=take();scratch();const check=take();scratch();drop(check);event('frame-exit',3);event('normalize');drop(input);event('input-retired');
   const raw=take(),parsed=take();scratch();drop(raw);const expected=take();scratch();event('frame-exit',4);drop(parsed);event('expected');
   const actual=take();scratch();event('frame-exit',5);drop(actual);event('compare');drop(expected);drop(q);
   ordinal++;event('ordinal-end');ordinal--;
  }
 }
 if(families===2)managed++; // one-shot full family comparison is a separate public entry.
 if(closed){actor=255;ordinal=0;event('fail');event('drain');}
 return {rows,managed};
}
export function validateCo0Evidence(e){
 keys(e,'schema rows');need(e.schema==='cwc-co0.storage-evidence.v1'&&Array.isArray(e.rows)&&e.rows.length===24,'matrix');let index=0,commands=0;
 for(const role of ['reader','authority-broker'])for(const boundary of ['normal','registered-maximum','schema-upper'])for(const mode of ['full-input','owned-input'])for(const kind of ['provider','client']){
  const r=e.rows[index++];keys(r,'role boundary mode kind error equality context beforeClose afterClose');need(r.role===role&&r.boundary===boundary&&r.mode===mode&&r.kind===kind&&r.error===null,'case');
  validateLg0Context(r.context,role,boundary!=='normal');need(r.context.registryDigest===co0Hash({schema:'cwc-co0.synthetic-registry.v1',source:'fixed-command-storage-fixture'}),'synthetic_input_pin');
  const n=kind==='provider'?1:2,width=lg0MemoryBound(r.context).commandBytes,expected=co0ExpectedRows(r.context),digestRows=Array.from({length:n},()=>expected.map(r=>r.sha256));
  need(r.equality===(n===2?'storage-equal':null),'family_equality');const peak=487424+n*19*width;
  for(const [key,closed]of [['beforeClose',false],['afterClose',true]]){
   const a=r[key],names='claimed alive released pending reason width familiesCompared entries capturedRows comparedRows sourceBytes comparedBytes slotPeak activeCells scratchUses expectedBuilds slabAllocations managedOperations children publications proofs lateRejected budget familyDigests scope';
   keys(a,names+(closed?' trace':' traceLength traceDigest'));
   need(same(a.scope,CO0_SCOPE_EXPECTED),'scope');need(a.claimed&&a.alive===!closed&&a.released===closed&&!a.pending&&a.reason===(closed?'owner_closed':null),'lifecycle');
   need(a.width===width&&a.familiesCompared===(n===2)&&a.entries===1+39*n+(n===2?1:0),'entries');
   need(a.capturedRows===19*n&&a.comparedRows===19*n&&a.sourceBytes===41460&&a.comparedBytes===n*expected.reduce((s,r)=>s+r.bytes,0),'content');
   need(a.slotPeak===3&&a.activeCells===0&&a.scratchUses===154*n&&a.expectedBuilds===19*n&&a.slabAllocations===2+n,'counts');
   const replay=co0ExpectedTrace(n,closed);need(a.managedOperations===replay.managed,'managed');
   need(same(a.children,Array.from({length:n},(_,i)=>({actor:n===1?'provider':i===0?'client-initial':'client-seal',state:closed?'failed':'storage-compared',captured:19,compared:19,used:418,generation:closed?2:1}))),'children');
   need(a.publications===0&&a.proofs===0&&a.lateRejected===0&&same(a.familyDigests,digestRows),'proof_or_digest');
   need(same(a.budget,{work:4096*n,initialization:4096,wire:0,attempts:0,heldBytes:closed?0:peak,peakBytes:peak,occupiedSlots:0,memoryLimit:1048576,workLimit:156978}),'budget');
   if(closed)need(same(a.trace,replay.rows),'trace');else need(a.traceLength===replay.rows.length&&a.traceDigest===co0Hash(replay.rows),'trace_prefix');
  }
  commands+=19*n;
 }
 return {rows:24,storageCompleted:24,commandsCompared:commands,legacyFourObjectControlRequired:true,managedSlotLimit:3,
  actualReferenceUpperBoundEstablished:false,metadataWithin4096:false,completeWorkCoverage:false,co0ExitEstablished:false,co1Admitted:false,lg0ExitEstablished:false,productionAdopted:false};
}
export function compareCo0Replay(saved,fresh){need(same(saved,fresh),'fresh_replay');}
