/** Independent acceptance rules plus exact fresh replay. No successful adoption state exists. */
import {readFileSync} from 'node:fs';
import {co0Canonical as canonical,co0Hash as hash} from './gradleOwnedCwcCo0Validation.mjs';
import {co0bSourceAudit,co0bEligibility} from './gradleOwnedCwcCo0bAudit.mjs';
import {CO0B_WORK_KEYS} from './gradleOwnedCwcCo0bModel.mjs';
const need=(ok,r)=>{if(!ok)throw Error('co0b_record_'+r);},same=(a,b)=>canonical(a)===canonical(b),integer=v=>Number.isSafeInteger(v)&&v>=0;
const keys=(v,list)=>need(v&&same(Object.keys(v).sort(),list.split(' ').sort()),'schema');
export const CO0B_EXPECTED_SCOPE={diagnosticOnly:true,unchangedCo0Source:true,realCprPrimitives:true,fixedClock:true,sameProcess:true,
 observerExtendsSomeLifetimes:true,
 actualAB:false,actualSession:false,lgModesConnected:false,fullHeapUpperBound:false,threeSlotEstablished:false,
 metadataBridgeWithin4096:false,completeWorkCoverage:false,budgetCoexistence:false,co0Exit:false,productionAdopted:false};
function baselineProtocol(r,baseline){
 const row=baseline.evidence.rows.find(b=>b.role===r.role&&b.boundary===r.boundary&&b.kind===r.kind&&b.mode==='full-input');need(row,'baseline_case');
 need(same(r.context,row.context),'baseline_context');const {trace,...stats}=row.afterClose;
 return {...stats,traceLength:trace.length,traceDigest:hash(trace)};
}
function witness(w,expected,labels,bytes){
 keys(w,'phase actor ordinal distinctRoots ids labels canonicalBytes shallowAlias sourceSupportedRoots observerExtendedRaw lifetimePolicy');need(same(w.labels,labels)&&w.distinctRoots===4&&w.shallowAlias===true,'witness');
 need(w.sourceSupportedRoots===(w.phase==='normalize'?4:3)&&w.observerExtendedRaw===(w.phase==='expected')&&w.lifetimePolicy===(w.phase==='normalize'?'source-holder-and-future-use':'conservative-active-frame'),'lifetime_scope');
 need(w.ids.length===4&&w.ids.every(v=>integer(v)&&v>0)&&new Set(w.ids).size===4&&same(w.ids.slice(0,3),expected),'witness_identity');
 need(same(w.canonicalBytes,[bytes,bytes,bytes,bytes-83]),'witness_bytes');
}
function quantities(r){
 const sums=Object.fromEntries(CO0B_WORK_KEYS.map(k=>[k,0]));let hashes=0,canon=0;
 need(Array.isArray(r.primitives)&&r.primitives.length>0,'primitive_rows');
 for(const [i,p]of r.primitives.entries()){
  keys(p,'seq kind phase actor ordinal work outputUnits outputBytes digest scratch hashInputDigest model');
  need(p.seq===i&&['hash','canonical'].includes(p.kind)&&['setup','capture','normalize','expected','compare'].includes(p.phase)&&integer(p.actor)&&integer(p.ordinal),'primitive_identity');
  keys(p.work,CO0B_WORK_KEYS.join(' '));need(Object.values(p.work).every(integer),'primitive_quantity');
  keys(p.model,'work scratch inputBytes preimageDigest outputUnits outputBytes digest');
  need(same(p.work,p.model.work)&&same(p.scratch,p.model.scratch)&&p.outputUnits===p.model.outputUnits&&p.outputBytes===p.model.outputBytes&&p.digest===p.model.digest,'independent_model');
  need(integer(p.outputUnits)&&integer(p.outputBytes)&&integer(p.model.inputBytes)&&/^[a-f0-9]{64}$/.test(p.digest)&&/^[a-f0-9]{64}$/.test(p.model.preimageDigest),'primitive_value');
  if(p.scratch){keys(p.scratch,'parts partUnits joinedUnits logicalUnits');need(Object.values(p.scratch).every(integer)&&p.scratch.logicalUnits===p.scratch.partUnits+p.scratch.joinedUnits,'scratch');}
  if(p.kind==='hash'){hashes++;need(p.work.hashUpdates===1&&p.work.hashInputBytes===p.model.inputBytes&&p.hashInputDigest===p.model.preimageDigest&&p.outputUnits===64,'actual_hash_input');}
  else {canon++;need(p.work.hashUpdates===0&&p.work.hashInputBytes===0&&p.hashInputDigest===null&&p.outputBytes===p.model.inputBytes,'canonical_output');}
  for(const k of CO0B_WORK_KEYS)sums[k]+=p.work[k];
 }
 need(same(r.work,{...sums,canonicalRoots:canon,hashes,directCharReads:2*r.protocol.comparedBytes}),'work_total');
 need(same(r.scratch,r.primitives.filter(p=>p.scratch).map(p=>({seq:p.seq,...p.scratch}))),'scratch_projection');
}
function complete(r,baseline){
 keys(r,'role boundary kind context error compared denied witnesses parses work scratch primitives finalBudget protocol scope');
 const n=r.kind==='provider'?1:2;need(same(r.scope,CO0B_EXPECTED_SCOPE)&&r.error===null&&r.denied===null&&r.compared===19*n,'scope_or_success');
 need(same(r.protocol,baselineProtocol(r,baseline))&&same(r.finalBudget,r.protocol.budget),'protocol_control');
 quantities(r);need(r.parses.length===95*n&&r.witnesses.length===38*n,'parse_witness_counts');
 for(const [i,p]of r.parses.entries()){
  keys(p,'seq phase actor ordinal input output inputBytes outputBytes');need(p.seq===i&&p.input!==p.output&&[p.input,p.output,p.inputBytes,p.outputBytes].every(v=>integer(v)&&v>0),'parse');
 }
 const canonicalChecks=r.role==='reader'?12:14;
 for(let actor=0;actor<n;actor++){
  for(let ordinal=0;ordinal<19;ordinal++){
   const parses=r.parses.filter(p=>p.actor===actor&&p.ordinal===ordinal),byPhase=phase=>parses.filter(p=>p.phase===phase);
   const capture=byPhase('capture'),normalize=byPhase('normalize'),expected=byPhase('expected');
   need(capture.length===2&&normalize.length===2&&expected.length===1&&capture[0].output===capture[1].input&&normalize[0].output===normalize[1].input,'parse_graph');
   const ws=r.witnesses.filter(w=>w.actor===actor&&w.ordinal===ordinal);need(ws.length===2&&ws[0].phase==='normalize'&&ws[1].phase==='expected','witness_phase');
   const bytes=normalize[0].outputBytes;need(parses.every(p=>p.inputBytes===bytes&&p.outputBytes===bytes),'parse_width');
   witness(ws[0],[normalize[0].input,normalize[0].output,normalize[1].output],['decode-input','prepared','check-result','wire-preimage'],bytes);
   witness(ws[1],[normalize[0].output,expected[0].input,expected[0].output],['prepared','raw-expected','parsed-expected','wire-preimage'],bytes);
   for(const [phase,hashes,canon]of [['capture',6,canonicalChecks+1],['normalize',3,canonicalChecks],['expected',4,1],['compare',0,1]]){
    const group=r.primitives.filter(p=>p.actor===actor&&p.ordinal===ordinal&&p.phase===phase);
    need(group.filter(p=>p.kind==='hash').length===hashes&&group.filter(p=>p.kind==='canonical').length===canon,'source_call_recipe');
   }
  }
  need(r.primitives.filter(p=>p.actor===actor&&p.phase==='setup').length===(r.role==='reader'?81:83),'setup_recipe');
 }
 const tail=r.primitives.filter(p=>p.phase==='compare'&&p.ordinal===19);need(tail.length===(n===2?2:0),'family_compare');
 need(r.protocol.traceLength*64>4096,'actual_trace_use');
}
export function validateCo0bEvidence(e){
 keys(e,'schema audit rows');need(e.schema==='cwc-co0b.evidence.v1'&&same(e.audit,co0bSourceAudit()),'source_audit');
 const baseline=JSON.parse(readFileSync('docs/validation/gradle-cwc-co0-2026-11-12.json','utf8'));
 need(baseline.evidenceDigest===hash(baseline.evidence),'baseline_digest');
 need(e.rows.length===12,'matrix');let at=0,commands=0;const cases=[];
 for(const role of ['reader','authority-broker'])for(const boundary of ['normal','registered-maximum','schema-upper'])for(const kind of ['provider','client']){
  const row=e.rows[at++];keys(row,'observed control guards');const r=row.observed;
  need(r.role===role&&r.boundary===boundary&&r.kind===kind,'case');complete(r,baseline);need(same(row.control,r.protocol),'unobserved_control');
  need(row.guards.length===2,'guards');for(const [i,g]of row.guards.entries()){
   keys(g,'guardPhase result');need(g.guardPhase===(i===0?'normalize':'expected'),'guard_phase');const a=g.result;
   keys(a,'role boundary kind context error compared denied witnesses work finalBudget protocol scope primitiveTrace parseTrace scratchTrace');
   need(a.role===role&&a.boundary===boundary&&a.kind===kind&&same(a.context,r.context)&&same(a.scope,CO0B_EXPECTED_SCOPE),'guard_case');
   need(a.error==='co0b_root_limit'&&a.compared===0&&same(a.denied,{phase:g.guardPhase,ordinal:0,beforeHashUpdate:true,allocationAlreadyOccurred:true}),'guard_refusal');
   need(a.protocol.capturedRows===19&&a.protocol.comparedRows===0&&a.protocol.expectedBuilds===i&&a.protocol.proofs===0&&a.protocol.publications===0,'guard_progress');
   need(same(a.finalBudget,r.finalBudget)&&same(a.protocol.budget,a.finalBudget)&&a.protocol.entries===22&&a.protocol.reason==='co0b_root_limit','guard_consumption');
   need(a.parseTrace.length===40+i&&a.witnesses.length===1+i,'guard_counts');
   for(const k of ['primitiveTrace','parseTrace','scratchTrace']){keys(a[k],'length digest');need(integer(a[k].length)&&a[k].length>0&&/^[a-f0-9]{64}$/.test(a[k].digest),'guard_trace');}
   need(a.work.hashUpdates===(i===0?115:120)&&a.work.hashes===a.work.hashUpdates&&a.work.directCharReads===0,'guard_work');
  }
  commands+=r.compared;cases.push({role,boundary,kind,commands:r.compared,schemaParses:r.parses.length,hashUpdates:r.work.hashUpdates,hashInputBytes:r.work.hashInputBytes,
   canonicalRoots:r.work.canonicalRoots,charReads:r.work.charReads,compareCharReads:r.work.directCharReads,maxLogicalJoinUnits:Math.max(...r.scratch.map(s=>s.logicalUnits)),
   normalizeSourceSupportedRoots:4,expectedConservativeRoots:4,expectedSourceSupportedRoots:3,traceUsedBytes:r.protocol.traceLength*64});
 }
 return {cases:12,commandsCompared:commands,controlCases:12,guardRefusals:24,explicitMetadataAndTraceBytes:266240,metadataTarget:4096,
  observedRootLowerBound:4,logicalScratchOnly:true,primitiveQuantitiesOnly:true,casesSummary:cases,decision:co0bEligibility(e.audit)};
}
export function compareCo0bReplay(saved,fresh){need(same(saved,fresh),'fresh_replay');}
