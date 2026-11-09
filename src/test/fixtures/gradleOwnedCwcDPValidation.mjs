import {validateTiming} from './gradleOwnedCwcDValidation.mjs';
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
const finite=x=>Number.isFinite(x)&&x>=0;
export const DP_ARMS=['scalar','composed','profiled','diagnostic-quiet','diagnostic-quiet-profiled'];
const operationCategories={};
for(const n of ['openScope','openCodecRoot','compilePlanLayout','encodeCheckedCommand','provePlannedOwnerAndAuth','connectedWidths','connectedSummary','registerInitialPlan','verifyClientSeal','retainClientCommandFact','readClientCommandFact','disposeCodecRoot'])operationCategories['A.'+n]='root-fact';
for(const n of ['assert','assertApproval','gate'])operationCategories['grant.'+n]='gate';
Object.assign(operationCategories,{'scope.gate':'gate','approval.assertCurrent':'gate','B.planProof':'proof','B.inspectProof':'proof','A.metrics':'diagnostics','grant.diagnostics':'diagnostics','B.diagnostics':'diagnostics','structuredClone':'copy','Buffer.alloc':'copy','Buffer.copy':'copy','Buffer.write':'copy'});
for(const n of ['canonicalOwnedJson','ownedDigest','ownedSha256'])operationCategories['json.'+n]='canonical-hash';
// These getters and native Buffer operations cannot nest another invocation of themselves.
// Other operations retain a conservative bound: callbacks may re-enter an observed entry point.
const nonReentrantOperations=new Set(['A.metrics','grant.diagnostics','B.diagnostics','Buffer.alloc','Buffer.copy','Buffer.write']);
const median=a=>{const s=[...a].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
export function validateDpTrace(trace,outerMs,requests,quiet){
 need(trace&&finite(trace.wallMs)&&finite(trace.otherMs)&&trace.wallMs<=outerMs&&trace.operations,'cwc_dp_trace');
 let exclusive=0;
 for(const [name,b]of Object.entries(trace.operations)){need(operationCategories[name]===b.category&&Number.isSafeInteger(b.calls)&&b.calls>0&&finite(b.inclusiveMs)&&finite(b.exclusiveMs)&&b.exclusiveMs<=b.inclusiveMs+1e-6&&b.inclusiveMs<=trace.wallMs*(nonReentrantOperations.has(name)?1:b.calls)+1e-6,'cwc_dp_operation');exclusive+=b.exclusiveMs;}
 need(Math.abs(exclusive+trace.otherMs-trace.wallMs)<=1e-6,'cwc_dp_partition');
 const count=name=>trace.operations[name]?.calls??0,plans=requests+2;
 for(const name of ['A.openScope','A.openCodecRoot','A.compilePlanLayout','A.connectedSummary'])need(count(name)===plans,'cwc_dp_count');
 for(const name of ['A.encodeCheckedCommand','A.provePlannedOwnerAndAuth','A.connectedWidths','B.planProof','B.inspectProof'])need(count(name)===requests*plans,'cwc_dp_count');
 for(const name of ['A.registerInitialPlan','A.verifyClientSeal'])need(count(name)===1,'cwc_dp_count');
 for(const name of ['A.retainClientCommandFact','A.readClientCommandFact'])need(count(name)===requests,'cwc_dp_count');
 need(count('A.disposeCodecRoot')===2,'cwc_dp_count');
 for(const name of ['A.metrics','grant.diagnostics','B.diagnostics'])need(count(name)===(quiet?0:plans),'cwc_dp_count');
 for(const name of ['grant.gate','scope.gate','approval.assertCurrent','structuredClone','Buffer.alloc','Buffer.copy','Buffer.write','json.ownedDigest','json.canonicalOwnedJson','json.ownedSha256'])need(count(name)>0,'cwc_dp_count');
 const categories={};for(const b of Object.values(trace.operations)){const c=categories[b.category]??={calls:0,inclusiveMs:0,exclusiveMs:0};c.calls+=b.calls;c.inclusiveMs+=b.inclusiveMs;c.exclusiveMs+=b.exclusiveMs;}return categories;
}
export function validateCwcDP(rows,rounds,workloads,expectedClock='real'){
 need(Number.isInteger(rounds)&&rounds>=1&&rounds<=3,'cwc_dp_rounds');const groups=new Map();
 for(const r of rows){need(workloads.includes(r.workload)&&['reader','authority-broker'].includes(r.role)&&Number.isInteger(r.round)&&r.round>=-1&&r.round<rounds&&DP_ARMS.includes(r.arm)&&r.clock===expectedClock&&r.deadlineMs===4500&&r.memoryLimit===1048576&&finite(r.outerMs)&&finite(r.observerSetupMs)&&(r.arm.endsWith('profiled')||r.observerSetupMs===0)&&['complete','failed'].includes(r.status),'cwc_dp_row');const k=[r.workload,r.role,r.round].join(':');const g=groups.get(k)??[];need(!g.some(x=>x.arm===r.arm),'cwc_dp_duplicate');g.push(r);groups.set(k,g);
  if(r.status==='failed'){need(typeof r.error==='string'&&r.error.length>0,'cwc_dp_failure');continue;}
  validateTiming(r);need(/^[a-f0-9]{64}$/.test(r.outputDigest),'cwc_dp_output');const scalar=r.arm==='scalar',quiet=r.arm.startsWith('diagnostic-quiet');
  need(Array.isArray(r.providerRows)&&r.providerRows.length===r.requests+2&&r.providerRows.every(row=>row.state==='complete'&&[65537,222515].includes(row.spent.work))&&r.batchRows===r.providerRows.filter(row=>row.spent.work===222515).length&&r.completeRows===r.providerRows.filter(row=>row.state==='complete').length,'cwc_dp_work_evidence');
  need(r.sourceLoads===r.requests+2&&r.codecRecords===(scalar||quiet?0:r.requests+2)&&r.clientWork===(scalar?0:313956)&&r.batchRows===(scalar?0:r.requests)&&r.completeRows===r.requests+2&&r.workValid===true,'cwc_dp_runtime');
  if(r.arm.endsWith('profiled'))validateDpTrace(r.trace,r.outerMs,r.requests,quiet);else need(r.trace===null,'cwc_dp_trace');
 }
 need(groups.size===workloads.length*2*(rounds+1),'cwc_dp_closure');
 for(const g of groups.values()){need(g.length===DP_ARMS.length&&new Set(g.map(r=>r.approvalPin)).size===1&&/^[a-f0-9]{64}$/.test(g[0].approvalPin),'cwc_dp_closure');const success=g.filter(r=>r.status==='complete');need(new Set(success.map(r=>r.outputDigest)).size<=1,'cwc_dp_output');const batch=success.filter(r=>r.arm!=='scalar');for(const k of ['planDigest','wireBytes','requests','clientWork'])need(new Set(batch.map(r=>r[k])).size<=1,'cwc_dp_semantics');
  const a=g.find(r=>r.arm==='profiled'),b=g.find(r=>r.arm==='diagnostic-quiet-profiled');if(a.status==='complete'&&b.status==='complete'){for(const [name,category]of Object.entries(operationCategories))if(['gate','root-fact','proof','canonical-hash'].includes(category))need((a.trace.operations[name]?.calls??0)===(b.trace.operations[name]?.calls??0),'cwc_dp_gate_parity');}
 }
 const summary=[];for(const workload of workloads)for(const role of ['reader','authority-broker']){const rs=rows.filter(r=>r.workload===workload&&r.role===role&&r.round>=0);const times={};for(const arm of DP_ARMS){const ar=rs.filter(r=>r.arm===arm);times[arm]={attempts:ar.length,completed:ar.filter(r=>r.status==='complete').length,medianObserverSetupMs:median(ar.map(r=>r.observerSetupMs)),medianMs:ar.every(r=>r.status==='complete')?median(ar.map(r=>r.outerMs)):null};}
  const paired=(a,b)=>{const ds=[];for(let round=0;round<rounds;round++){const x=rs.find(r=>r.arm===a&&r.round===round),y=rs.find(r=>r.arm===b&&r.round===round);if(x.status==='complete'&&y.status==='complete')ds.push(x.outerMs-y.outerMs);}return {pairs:ds.length,medianMs:ds.length?median(ds):null,wins:ds.filter(x=>x>0).length};};
  const costs={};for(const arm of ['profiled','diagnostic-quiet-profiled']){const ar=rs.filter(r=>r.arm===arm&&r.status==='complete'),cs=ar.map(r=>validateDpTrace(r.trace,r.outerMs,r.requests,arm!=='profiled'));costs[arm]={samples:cs.length,categories:Object.fromEntries(['root-fact','copy','gate','canonical-hash','diagnostics','proof'].map(k=>[k,{medianExclusiveMs:cs.length?median(cs.map(c=>c[k]?.exclusiveMs??0)):null,medianCalls:cs.length?median(cs.map(c=>c[k]?.calls??0)):null}]))};}
  const benefit=paired('composed','diagnostic-quiet'),scalar=paired('scalar','diagnostic-quiet');summary.push({workload,role,times,costs,observerDelta:paired('profiled','composed'),quietObserverDelta:paired('diagnostic-quiet-profiled','diagnostic-quiet'),diagnosticSaving:benefit,scalarAdvantage:scalar,decision:scalar.pairs===rounds&&scalar.wins===rounds?'candidate-only':'defer',productionAdopted:false});
 }return summary;
}
