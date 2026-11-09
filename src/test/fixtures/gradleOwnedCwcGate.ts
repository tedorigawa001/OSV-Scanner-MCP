import {cwcCCase} from './gradleOwnedCwcCCase.js';
import {cprBPCase} from './gradleOwnedCprBP.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {CWC_C_WORKLOADS} from './gradleOwnedCwcCExperiment.js';
import {GATE_OPERATIONS,GATE_NON_REENTRANT,installGateObserver,type GateTrace} from './gradleOwnedCwcGateProfile.js';
import {validateTiming} from './gradleOwnedCwcDValidation.mjs';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';

export const GATE_ARMS=['scalar','composed','counts','profiled','bp-bridge'] as const;
export const gateTableRows=(summary:any[])=>summary.map(s=>'| '+[s.workload,s.role,s.times.scalar.medianMs?.toFixed(1)??'failed',s.times.composed.medianMs?.toFixed(1)??'failed',s.times['bp-bridge'].medianMs?.toFixed(1)??'failed',s.bpBridgeGap.medianMs?.toFixed(1)??'failed',s.gateExclusiveMs?.toFixed(1)??'failed',s.operations['session.inspectAuthenticatedCall'].medianCalls??'failed',s.observerOverhead.medianMs?.toFixed(1)??'failed'].join(' | ')+' |');
const finite=(n:number)=>Number.isFinite(n)&&n>=0;
const median=(ns:number[])=>[...ns].sort((a,b)=>a-b)[Math.floor(ns.length/2)]!;
export function validateGateTrace(t:GateTrace,outerMs:number,timed:boolean,requests:number){
 need(t&&t.timed===timed&&finite(t.wallMs)&&finite(t.otherMs)&&t.wallMs<=outerMs,'cwc_gate_trace');
 let total=0;
 for(const [name,b]of Object.entries(t.operations)){
  const leaf=(GATE_NON_REENTRANT as readonly string[]).includes(name);
  need((GATE_OPERATIONS as readonly string[]).includes(name)&&Number.isSafeInteger(b.calls)&&b.calls>0&&finite(b.inclusiveMs)&&finite(b.exclusiveMs)&&b.exclusiveMs<=b.inclusiveMs+1e-6&&b.inclusiveMs<=t.wallMs*(leaf?1:b.calls)+1e-6&&(!leaf||Math.abs(b.inclusiveMs-b.exclusiveMs)<=1e-6),'cwc_gate_operation');
  if(!timed)need(b.inclusiveMs===0&&b.exclusiveMs===0,'cwc_gate_count_only');
  total+=b.exclusiveMs;
 }
 need(Math.abs(total+t.otherMs-t.wallMs)<=1e-6,'cwc_gate_partition');
 for(const n of ['scope.gate','grant.assert','grant.gate','ledger.check','registry.assertCurrent','session.inspectAuthenticatedCall','endpoint.gate','endpoint.now','endpoint.permitAPI','gate.canonicalOwnedJson','gate.ownedSha256','gate.structuredClone'])need((t.operations[n]?.calls??0)>0,'cwc_gate_missing');
 need(t.entryCalls&&typeof t.entryCalls==='object'&&!Array.isArray(t.entryCalls)&&Object.keys(t.entryCalls).length===Object.keys(t.operations).length,'cwc_gate_count_witness');
 for(const [name,n]of Object.entries(t.entryCalls))need(Number.isSafeInteger(n)&&n>0&&t.operations[name]?.calls===n,'cwc_gate_count_witness');
 const count=(name:string)=>t.operations[name]?.calls??0,inspections=count('session.inspectAuthenticatedCall');
 // Source-bound normal matrix: each exported inspection hashes its wire and clones two identities.
 // Each successful RPC also has challenge/channel permission checks plus the lexical final inspection.
 need(Number.isSafeInteger(requests)&&requests>=1&&requests<=19&&count('gate.ownedSha256')===inspections&&count('gate.structuredClone')===2*inspections&&count('endpoint.permitAPI')===inspections+3*(requests+2),'cwc_gate_count_binding');
 const gateExclusiveMs=Object.entries(t.operations).filter(([n])=>!n.startsWith('outside.')).reduce((n,[,b])=>n+b.exclusiveMs,0);
 return {gateExclusiveMs,outsideObservedMs:total-gateExclusiveMs};
}
export function validateGateRows(rows:any[],rounds:number,workloads:string[],clock:'real'|'fixed'){
 need(Number.isInteger(rounds)&&rounds>=1&&rounds<=3,'cwc_gate_rounds');
 const groups=new Map<string,any[]>();
 for(const r of rows){
  need(workloads.includes(r.workload)&&['reader','authority-broker'].includes(r.role)&&Number.isInteger(r.round)&&r.round>=-1&&r.round<rounds&&GATE_ARMS.includes(r.arm)&&r.clock===clock&&finite(r.outerMs)&&finite(r.observerSetupMs)&&['complete','failed'].includes(r.status),'cwc_gate_row');
  need(r.deadlineMs===4500&&(r.arm==='bp-bridge'?r.approvalPin===null&&r.memoryLimit===null:/^[a-f0-9]{64}$/.test(r.approvalPin)&&r.memoryLimit===1048576),'cwc_gate_profile');
  const key=[r.workload,r.role,r.round].join(':'),g=groups.get(key)??[];
  need(!g.some(x=>x.arm===r.arm),'cwc_gate_duplicate');g.push(r);groups.set(key,g);
  if(r.status==='failed'){need(typeof r.error==='string'&&r.error.length>0,'cwc_gate_failure');continue;}
  validateTiming(r);need(/^[a-f0-9]{64}$/.test(r.outputDigest)&&r.loads===r.requests+2&&r.clientWork===(r.arm==='bp-bridge'?null:r.arm==='scalar'?0:313956),'cwc_gate_semantics');
  if(['counts','profiled'].includes(r.arm))validateGateTrace(r.trace,r.outerMs,r.arm==='profiled',r.requests);else need(r.trace===null&&r.observerSetupMs===0,'cwc_gate_trace');
 }
 need(groups.size===workloads.length*2*(rounds+1),'cwc_gate_closure');
 for(const g of groups.values()){
  need(g.length===GATE_ARMS.length&&new Set(g.filter(r=>r.arm!=='bp-bridge').map(r=>r.approvalPin)).size===1,'cwc_gate_closure');
  const good=g.filter(r=>r.status==='complete');need(new Set(good.map(r=>r.outputDigest)).size<=1,'cwc_gate_output');
  const batch=good.filter(r=>r.arm!=='scalar');
  for(const k of ['requests','planDigest','wireBytes','inputDigest','inventoryDigest'])need(new Set(batch.map(r=>r[k])).size<=1,'cwc_gate_semantics');
  const a=g.find(r=>r.arm==='counts'),b=g.find(r=>r.arm==='profiled');
  if(a.status==='complete'&&b.status==='complete'){
   for(const n of GATE_OPERATIONS)need((a.trace.operations[n]?.calls??0)===(b.trace.operations[n]?.calls??0),'cwc_gate_count_parity');
  }
 }
 return workloads.flatMap(workload=>['reader','authority-broker'].map(role=>{
  const rs=rows.filter(r=>r.workload===workload&&r.role===role&&r.round>=0);
  const times=Object.fromEntries(GATE_ARMS.map(arm=>{const a=rs.filter(r=>r.arm===arm);return [arm,{attempts:a.length,completed:a.filter(r=>r.status==='complete').length,medianMs:a.every(r=>r.status==='complete')?median(a.map(r=>r.outerMs)):null}];}));
  const delta=(a:string,b:string)=>{const ns:number[]=[];for(let round=0;round<rounds;round++){const x=rs.find(r=>r.round===round&&r.arm===a),y=rs.find(r=>r.round===round&&r.arm===b);if(x.status==='complete'&&y.status==='complete')ns.push(x.outerMs-y.outerMs);}return {pairs:ns.length,medianMs:ns.length?median(ns):null};};
  const profiled=rs.filter(r=>r.arm==='profiled'&&r.status==='complete');
  return {workload,role,times,countingOverhead:delta('counts','composed'),timingIncrement:delta('profiled','counts'),observerOverhead:delta('profiled','composed'),bpBridgeGap:delta('composed','bp-bridge'),gateExclusiveMs:profiled.length?median(profiled.map(r=>validateGateTrace(r.trace,r.outerMs,true,r.requests).gateExclusiveMs)):null,operations:Object.fromEntries(GATE_OPERATIONS.map(n=>[n,{medianCalls:profiled.length?median(profiled.map(r=>r.trace.operations[n]?.calls??0)):null,medianExclusiveMs:profiled.length?median(profiled.map(r=>r.trace.operations[n]?.exclusiveMs??0)):null}])),decision:'diagnostic-only',productionAdopted:false};
 }));
}
export async function runCwcGate(rounds=3,workloads:readonly typeof CWC_C_WORKLOADS[number][]=CWC_C_WORKLOADS,realClock=false){
 const rows:any[]=[];
 for(const w of workloads)for(const role of ['reader','authority-broker'] as const)for(let round=-1;round<rounds;round++){
  const a=cwcCApprovalFixture();
  for(let i=0;i<GATE_ARMS.length;i++){
   const arm=GATE_ARMS[(i+round+1)%GATE_ARMS.length]!,opts={variant:'combined' as const,role,sizes:[...w.sizes],realClock,planEvents:false};
   const f=arm==='bp-bridge'?cprBPCase('B-independent',opts):cwcCCase(arm==='scalar'?'S-scoped':'B-independent',{...opts,codeApproval:a.view,comparisonProfile:true});
   const setup=performance.now(),o=['counts','profiled'].includes(arm)?installGateObserver(arm==='profiled'):undefined,observerSetupMs=o?performance.now()-setup:0,start=performance.now();let trace:GateTrace|null=null;
   try{
    let result:Awaited<ReturnType<typeof f.transfer>>;
    if(o){const m=await o.measure(()=>f.transfer());trace=m.trace;if(!m.ok)throw m.error;result=m.result!;}else result=await f.transfer();
    const end=performance.now();
    rows.push({workload:w.id,role,round,arm,clock:realClock?'real':'fixed',deadlineMs:4500,memoryLimit:arm==='bp-bridge'?null:1048576,approvalPin:arm==='bp-bridge'?null:a.pin,observerSetupMs,outerMs:end-start,status:'complete',trace,...result,loads:f.provider.metrics.loads,clientWork:'clientWork'in f?f.clientWork:null});
   }catch(error){rows.push({workload:w.id,role,round,arm,clock:realClock?'real':'fixed',deadlineMs:4500,memoryLimit:arm==='bp-bridge'?null:1048576,approvalPin:arm==='bp-bridge'?null:a.pin,observerSetupMs,outerMs:performance.now()-start,status:'failed',trace,error:error instanceof Error?error.message:String(error)});}
   finally{o?.close();f.close();}
  }
 }
 return {schema:'cwc-gate.measurement.v1',clock:realClock?'real':'fixed',rounds,rows,summary:validateGateRows(rows,rounds,workloads.map(w=>w.id),realClock?'real':'fixed')};
}
