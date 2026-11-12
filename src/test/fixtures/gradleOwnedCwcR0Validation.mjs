/** Independent quantity/lifecycle rules plus mandatory exact fresh replay. No adoption verdict. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {co0Canonical as canonical} from './gradleOwnedCwcCo0Validation.mjs';
const need=(v,r)=>{if(!v)throw Error('r0_record_'+r);},same=(a,b)=>canonical(a)===canonical(b),integer=n=>Number.isSafeInteger(n)&&n>=0;
const scope={standalone:true,fixedClock:true,ownedPackedCores:true,boundedCommandParser:true,streamingProjection:true,originalOracleInHarness:true,
 bootstrapGenericContextValidation:true,nativeHash:true,managedFrameTrace:true,wholeVmReferenceUpperBound:false,metadataChargeProved:false,coreRepresentationChargeProved:false,
 nativeHashUpperBoundProved:false,completeWorkCoverage:false,codecOverlayCoexistence:false,actualAB:false,actualReadScope:false,actualSession:false,lgModesConnected:false,co0Exit:false,productionAdopted:false};
export const R0_INVENTORY=Object.freeze({
 ownership:'source-holder-and-managed-frame; not a VM heap/reference upper bound',
 ownerPersistent:['clock','budget','hook','constructor ticket','window reservation','children[]','8 opaque handles[]','metadata','chunk','S0/S1/S2[]','buffer registry[]','parser','sink','slot flags[]','frame stack[]','trace[]','encoded lengths[][]','final diagnostic digests[][]','native metrics'],
 coreAliases:['child.builder -> core.arena + core.tokens.table/source (same arena)','child.expected -> distinct core.arena + core.tokens.table/source (same arena)','buffer registry -> every arena/slab/metadata/chunk/slot','CoreHandle === window; no new handle or core selector'],
 commandBorrows:['capture: builder + slab; then S2 table/source=slab','normalize: slab + S0 + S2 table/source=S0; clear S2 before expected','expected: independent core + S0 + S1; S2 table/source=S1 for complete check','compare: S0 + S1 + retained slab, no live S2 index','hash: chunk subarray + native hash until synchronous update returns','parser: bounded recursive frames, token/key descriptors and small key span/add closure'],
 bootstrapBorrows:['caller input/config and data-only context/groups copy until constructor returns','legacy context validation/canonical and width recipe outside command path','separate builder/expected cores built from copied input; no fresh planner independence claim'],
 afterClose:['zero and verify all registered buffers, clear parser/core token source, abort sink','remove children/handles/slot/buffer/parser/sink/chunk/metadata lookups','readonly clock/budget/hook/tickets, empty control arrays, numeric trace and diagnostic digests can remain on closed owner'],
 unproved:['full JS bridge/control/descriptor/closure/exception charge','native hash state/stack/allocation/free timing','bootstrap object/encoding allocation upper bound','codec overlay coexistence','complete work model and real parent/child ledger coexistence','observer trace and exported oracle copies outside the representation proof'],
});
const auditSites=[
 ['src/test/fixtures/gradleOwnedCwcR0.ts','this.#buffers.push(b);','all owned buffer registrations'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts','return h;','CoreHandle same window object'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts','19*F*this.#width','maximum family prepayment'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts','c.captured<c.n','actual n capture'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts','c.processed<c.n','actual n processing'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts',"need(!this.#slotLive[2],'index_borrow_live')",'borrow fence before expected'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts',"this.#stack.pop()===id",'managed frame finally'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts',"need(this.#stack.length===0,'frame_live')",'no slot reclaim within frame'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts','this.#parser?.clear();','remove parser source before reclaim'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts',"need(b[i]===0,'zero_failed')",'verify actual buffer zeroization'],
 ['src/test/fixtures/gradleOwnedCwcR0Engine.ts','view=undefined;this.viewLive=0','native chunk view borrow finally'],
 ['src/test/fixtures/gradleOwnedCwcR0Engine.ts','this.#target=undefined;this.targetLive=false;this.#hash=undefined;','stream sink finally/abort'],
 ['src/test/fixtures/gradleOwnedCwcR0Engine.ts',"if(t===p.field(0,'requestDigest'))continue",'fixed projection exclusion'],
 ['src/test/fixtures/gradleOwnedCwcR0Tokens.ts','finally{this.#frames--;}','recursive parser frame finally'],
 ['src/test/fixtures/gradleOwnedCwcR0Tokens.ts','this.#source=undefined;','clear source borrow'],
 ['src/test/fixtures/gradleOwnedCwcR0Grammar.ts','freeze(R0_CONTEXT);freeze(R0_COMMAND);','closed compiled grammar'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts',"this.#fail('operation_failed')",'invalidate before exception diagnostics'],
 ['src/test/fixtures/gradleOwnedCwcR0.ts',"Object.getOwnPropertyDescriptor(error,'message')",'data-only exception reason, no getter or coercion'],
 ['src/test/fixtures/gradleOwnedCwcR0Tokens.ts',"need(this.#frames===0,'borrow_live');this.clear();",'clear prior binding before input preflight'],
];
export function r0SourceAudit(){return {inventory:R0_INVENTORY,sites:auditSites.map(([path,anchor,role])=>{const b=readFileSync(path),s=b.toString(),at=s.indexOf(anchor);need(at>=0,'audit_anchor');return {path,role,anchor,line:s.slice(0,at).split('\n').length,sha256:createHash('sha256').update(b).digest('hex')};})};}
function trace(r){const s=r.before,stack=[],slots=new Set(),counts=new Map();let peak=0,lastFrame=0;
 for(const [i,e]of s.trace.entries()){
  need(same(Object.keys(e).sort(),['seq','kind','actor','ordinal','frame','depth','slot','active'].sort())&&e.seq===i&&[e.seq,e.ordinal,e.frame,e.depth,e.active].every(integer),'event_identity');
  const phase=e.kind.startsWith('enter:')?e.kind.slice(6):e.kind.startsWith('exit:')?e.kind.slice(5):null;
  if(e.kind.startsWith('enter:')){need(e.frame===++lastFrame&&e.depth===stack.length+1,'frame_entry');stack.push([e.frame,phase]);const k=[e.actor,e.ordinal,phase].join(':');counts.set(k,(counts.get(k)??0)+1);}
  else if(e.kind.startsWith('exit:')){need(stack.length&&same(stack.at(-1),[e.frame,phase])&&e.depth===stack.length,'frame_exit');stack.pop();}
  else {need(e.depth===0&&e.frame===0&&stack.length===0,'outside_frame');
   if(e.kind==='lease'){need([0,1,2].includes(e.slot)&&!slots.has(e.slot),'slot_lease');slots.add(e.slot);}
   if(e.kind==='release'){need(slots.has(e.slot),'slot_release');slots.delete(e.slot);}
  }need(e.active===slots.size&&e.active<=3,'active_slots');peak=Math.max(peak,slots.size);
 }
 const F=r.kind==='provider'?1:2;
 need(stack.length===0&&slots.size===0&&peak===3&&lastFrame===F*(2+6*r.n)+(F===2?1:0),'frame_balance');
 const expected=new Map();for(let a=0;a<F;a++){for(const phase of ['core-builder','core-expected'])expected.set([a,0,phase].join(':'),1);
  for(let n=0;n<r.n;n++)for(const phase of ['capture','capture-check','normalize','expected','expected-check','compare'])expected.set([a,n,phase].join(':'),1);
 }if(F===2)expected.set([1,r.n-1,'family-compare'].join(':'),1);
 need(same([...counts].sort(),[...expected].sort()),'frame_recipe');
 for(let a=0;a<F;a++)for(const kind of ['captured','compared'])need(same(s.trace.filter(e=>e.kind===kind&&e.actor===a).map(e=>e.ordinal),Array.from({length:r.n},(_,i)=>i)),'ordinal_recipe');
 need(same(r.after.trace.slice(0,s.trace.length),s.trace)&&same(r.after.trace.slice(s.trace.length).map(e=>e.kind),['failed','drained']),'close_trace');
}
export function validateR0Evidence(e){need(e?.schema==='cwc-r0.evidence.v1'&&e.rows.length===24,'matrix');let at=0,commands=0,highTokens=0;
 for(const role of ['reader','authority-broker'])for(const boundary of ['normal','registered-maximum','schema-upper'])for(const workload of ['small','stress'])for(const kind of ['provider','client']){
  const r=e.rows[at++],s=r.before,z=r.after,F=kind==='provider'?1:2,n=workload==='small'?2:19;
  need(r.role===role&&r.boundary===boundary&&r.workload===workload&&r.kind===kind&&r.n===n&&r.error===null&&r.alias===true,'case');
  need(same(s.scope,scope)&&same(z.scope,scope)&&s.alive&&!s.released&&s.lookup&&!z.alive&&z.released&&!z.lookup,'scope');
  need(s.handleCapacity===8&&s.coreHandleAllocations===0&&s.framePeak===1&&s.slotPeak===3&&s.slotLive===0&&s.liveFrames===0&&s.nativeViewLive===0&&!s.sinkActive&&s.tokenPeak<=512&&s.tokenPeak>0,'representations');
  need(s.children.length===F&&s.compared===F*n&&s.familiesEqual===(kind==='client'),'complete');
  need(s.children.every((c,i)=>c.actor===(F===1?'provider':i===0?'client-initial':'client-seal')&&c.state==='compared'&&c.n===n&&c.captured===n&&c.processed===n&&c.generation===1&&c.reservedRows===19&&c.reservedBytes===19*s.width),'child');
  const reserved=19*F*s.width+(F===1?3:4)*s.coreWidth+3*s.contextWidth+3*8192+4096+16384+4096;
  need([s.width,s.coreWidth,s.contextWidth].every(integer)&&s.width<=8192&&s.budget.heldBytes===131072+reserved&&s.budget.peakBytes===s.budget.heldBytes&&s.budget.work===4096*F&&s.budget.initialization===4096,'prepayment');
  need(s.budget.heldBytes<=s.budget.memoryLimit&&s.budget.work+s.budget.initialization<=s.budget.workLimit&&s.budget.wire===0&&s.budget.attempts===0,'budget');
  need(s.native.hashes===F*(2+10*n)&&s.native.hashBytes>0&&s.native.chunks>0&&s.native.viewPeak===1&&same(s.native,z.native),'hash_recipe');
  need(s.liveBuffers===5+3*F&&z.liveBuffers===0&&z.clearedBuffers===s.liveBuffers&&z.clearedBytes===3072+4096+3*8192+F*(2*s.coreWidth+19*s.width)&&z.zeroVerified&&z.children.length===0&&z.slotLive===0&&z.liveFrames===0&&!z.sinkActive&&z.nativeViewLive===0,'drain');
  need(z.budget.heldBytes===0&&same({...z.budget,heldBytes:s.budget.heldBytes},s.budget)&&s.publications===0&&z.publications===0&&s.proofs===0&&z.proofs===0,'no_refund_or_adoption');
  need(r.oracle.length===F&&r.oracle.every(d=>d.length===n&&d.every(x=>/^[a-f0-9]{64}$/.test(x)))&&same(z.finalRows,r.oracle),'oracle_rows');
  trace(r);commands+=s.compared;highTokens=Math.max(highTokens,s.tokenPeak);
 }need(commands===378,'commands');return {cases:24,commands,tokenPeak:highTokens,managedSlots:3,coreHandleAllocations:0,reservedRows:19,actualRows:[2,19],storageEqualityOnly:true,co0Exit:false,productionAdopted:false};
}
export function validateR0Differential(e){need(e?.schema==='cwc-r0.differential.v1'&&e.rows.length>4000,'differential_schema');let accepts=0;const ids=new Set();
 for(const r of e.rows){const id=r.role+':'+r.id;need(!ids.has(id),'differential_duplicate');ids.add(id);need(['reader','authority-broker'].includes(r.role)&&typeof r.semantic==='boolean'&&typeof r.legacy==='boolean'&&r.legacy===r.owned&&integer(r.bytes)&&r.bytes>0&&/^[a-f0-9]{64}$/.test(r.sha256)&&r.frames===0&&r.tokensAfter===0,'differential_row');accepts+=r.owned?1:0;}
 for(const role of ['reader','authority-broker'])for(const id of ['valid','valid-semantic','provision-schema','semantic:seed','semantic:ordinal','reverse-wire','whitespace','duplicate-key','escape'])need(ids.has(role+':'+id),'differential_coverage');
 return {cases:e.rows.length,accepts,rejects:e.rows.length-accepts,finiteCorpusOnly:true};
}
export function compareR0Replay(saved,fresh){need(same(saved,fresh),'fresh_replay');}
export function validateR0Review(e){need(e?.schema==='cwc-r0.review-regressions.v1'&&e.rows.length===10,'review_schema');let at=0;
 for(const kind of ['provider','client'])for(const fault of ['message-getter','to-string','to-primitive']){
  const r=e.rows[at++],work=kind==='provider'?4096:8192;
  need(r.type==='owner'&&r.kind===kind&&r.fault===fault&&r.originalRethrown===true&&r.diagnosticCalls===0,'review_exception');
  need(r.alive===false&&r.lookup===false&&r.released===true&&r.zeroVerified===true&&r.sinkActive===false&&r.lateHandleRefused===true&&r.oneRelease===true,'review_owner_cleanup');
  need(['compared','publications','proofs','slots','frames','buffers','nativeViews','heldBytes'].every(k=>r[k]===0)&&r.work===work&&r.prepaidWork===work&&r.initialization===4096&&r.prepaidInitialization===4096,'review_owner_consumption');
 }
 for(const fault of ['oversize','length-overrun','offset','source-type']){
  const r=e.rows[at++];need(r.type==='parser'&&r.fault===fault&&integer(r.prior)&&r.prior>0&&r.prior<=512&&r.previousSourceBound===true&&r.refused===true,'review_parser_setup');
  need(r.tokensAfter===0&&r.sourceBound===false&&r.frames===0&&r.tableZero===true&&r.oldReadable===false&&r.reusable===true,'review_parser_cleanup');
 }return {ownerRefusals:6,parserRefusals:4,foreignDiagnosticsEvaluated:0,oldBindingsRetained:0};
}
