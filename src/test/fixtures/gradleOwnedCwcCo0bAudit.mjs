/** Source-supported lower-bound audit. Nothing in this file approves a runtime. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export const co0bSha=bytes=>createHash('sha256').update(bytes).digest('hex');
const root='src/test/fixtures/',json='src/utils/gradleOwnedJson.ts';
export const CO0B_SITES=Object.freeze([
 ['input-holder',root+'gradleOwnedCwcCo0.ts','this.#drop(c.input,c);c.input=undefined','input remains in the child until normalize helper and checkCommand have returned'],
 ['prepared-holder',root+'gradleOwnedCwcCo0.ts','this.#put(q,this.#withScratch(c,()=>command(c.input!.value)))','prepared result is retained in the managed lease during check, then child.q during expected'],
 ['expected-call',root+'gradleOwnedCwcCo0.ts',"this.#expectedBuilds++;const q=",'raw-reservation is a lease flag; it does not replace the internal raw object'],
 ['raw-builder',root+'gradleOwnedCprASchema.ts','const q:any={schema:', 'raw last use is command(q); observer conservatively holds it until makeCommand returns, without proving original GC liveness'],
 ['schema-result',root+'gradleOwnedCprASchema.ts','const q=parsed(cprCommandSchema,input),p=q.payload','schema result is live through wireIntent and the return'],
 ['hash-shallow-copy',root+'gradleOwnedCprASchema.ts','const {requestDigest,...q}=input','rest creates a distinct root which shares nested payload with schema result'],
 ['hash-wrapper',root+'gradleOwnedCprASchema.ts',"hash({domain:'cpr.wire-intent.v3',command:q})",'wrapper and shallow command copy survive while canonical/hash consumes them'],
 ['canonical-active',json,'const active=new Set<object>()','recursive active set and encode frames retain input ancestors'],
 ['canonical-keys',json,'Object.keys(v).sort().map','key array, map result of encoded field strings and join result'],
 ['canonical-array',json,"v.map(x=>encode(x,depth+1)).join(',')",'array map result and join output overlap at join return'],
 ['hash-native',json,"createHash('sha256').update(bytes).digest('hex')",'native crypto allocation/work remains opaque; update bytes are observed'],
 ['owned-copy',root+'gradleOwnedCwcLg0Contract.ts','Object.defineProperty(out,key,{value:copy','recursive descriptor copies, output graph and canonical validation'],
 ['freeze',root+'gradleOwnedCwcLg0Contract.ts','for(const child of Object.values(v))lgFreeze(child)','Object.values arrays and recursive freeze frames are not covered by managed ticks'],
 ['metadata-trace',root+'gradleOwnedCwcCo0.ts','this.#metadata=alloc(4096);this.#trace=alloc(this.#recipe.bridgeBytes)','explicit separate buffers exist from claim until reclaim'],
 ['handle-registries',root+'gradleOwnedCwcCo0.ts','claims=new WeakMap<Handle','weak keys do not bound values while external claim/window handles remain live'],
 ['owner-arrays',root+'gradleOwnedCwcCo0.ts','#cells:Lease[]=[];#retired:Lease[]=[]','child, identity, lease, retired, trace and diagnostic graph are not a fixed 16-ref table'],
 ['private-core-pair',root+'gradleOwnedCwcCo0.ts','c.builderCore=this.#withScratch(c,()=>lgFreeze(validatePlanCore','each child retains separate expected/builder cores and a separate context until reclaim'],
 ['copy-zero',root+'gradleOwnedCwcCo0.ts','Reflect.apply(fill,c.slab,[0])','zero and release work survives failure; it is not refunded'],
 ['byte-compare',root+'gradleOwnedCwcCo0.ts','for(let i=0;i<length;i++)need(text.charCodeAt(i)','two actual character reads per successful compared byte'],
 ['family-compare',root+'gradleOwnedCwcCo0.ts',"need(a!.slab![i*this.#width+j]===b!.slab![i*this.#width+j]",'client seal performs a further byte comparison; not replaced by a digest']
]);
const need=(ok,r)=>{if(!ok)throw Error('co0b_audit_'+r);};
export function co0bSourceAudit(read=p=>readFileSync(p,'utf8')){
 const sites=CO0B_SITES.map(([id,path,anchor,obligation])=>{const source=read(path),at=source.indexOf(anchor);
  need(at>=0&&source.indexOf(anchor,at+1)<0,'anchor_'+id);const before=source.slice(0,at),line=before.split('\n').length,column=at-(source.lastIndexOf('\n',at)+1)+1;
  return {id,path,anchor,obligation,line,column,sourceDigest:co0bSha(source)};});
 const recipe=read(root+'gradleOwnedCwcCo0Contract.ts');need(recipe.includes('metadataBytes:4096')&&recipe.includes('bridgeBytes:262144')&&recipe.includes('referenceTarget:16'),'recipe');
 return {schema:'cwc-co0b.source-audit.v1',sites,
  layout:{metadata:4096,traceCapacity:262144,explicitBuffers:266240,target:4096,referenceTarget:16,referenceTableImplemented:false,
   scratchReservation:65536,scratchAllocationUpperBoundEstablished:false,diagnosticTraceRemovableWithoutProof:false},
  retention:{basis:'source-assignments-before-normal-close',provider:{contexts:2,planCores:2},client:{contexts:3,planCores:4},
   fixtureAlsoRetainsInputContextAndCore:true,totalStrongReferenceUpperBoundEstablished:false},
  work:{model:'primitive-quantities.v1',productionUnitsComparable:false,managedTickModelComplete:false,extraBoundEstablished:false,
   observed:['command-schema-boundaries','canonical-key-map-join-string-work','hash-update-bytes','compare-character-reads'],
   uncovered:['zod-internal-allocations-and-work','native-crypto-scratch-and-work','descriptor-copy-and-freeze-work','all-strong-reference-bridges','buffer-copy-and-zero-work','complete-parent-child-ledger']}};
}
export function co0bEligibility(audit){
 need(audit?.schema==='cwc-co0b.source-audit.v1'&&audit.layout.explicitBuffers===266240&&audit.layout.metadata+audit.layout.traceCapacity===266240&&audit.layout.target===4096,'layout');
 need(audit.work.productionUnitsComparable===false&&audit.work.extraBoundEstablished===false&&audit.layout.referenceTableImplemented===false,'unproved');
 return {eligible:false,reasons:['four-retained-command-roots','metadata-bridge-over-target','scratch-upper-bound-unproved','reference-layout-unproved','complete-work-model-unproved'],
  threeSlotEstablished:false,metadataBridgeWithin4096:false,completeWorkCoverage:false,co0Exit:false,co1Admitted:false,productionAdopted:false};
}
