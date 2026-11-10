import {createHash,createPublicKey,verify} from 'node:crypto';
import {LB3_CONDITIONS,LB3_ARMS,LB3_WORKLOADS,LB3_OBSERVATIONS,validateLb3Row} from './gradleOwnedCwcLb3Validation.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=v=>createHash('sha256').update(canonical(v)).digest('hex'),same=(a,b)=>canonical(a)===canonical(b),need=(v,r)=>{if(!v)throw Error('lb3p_'+r);},finite=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0,near=(a,b)=>Math.abs(a-b)<=1e-6;
export const LB3P_GROUPS=['actual-call','wire-verification','live-gate','planner','codec','canonical-hash','copy','source','transport','construction'];
export const LB3P_POLICY={schema:'cwc-lb3p.policy.v1',baseConditions:LB3_CONDITIONS,groups:LB3P_GROUPS,additionalClockGate:true,observer:'call-through-export-prototype',stackLimit:128,contextLimit:1024,optimization:false,productionAdopted:false};
export function profileGroup(name){
 if(name==='construction')return 'construction';if(name==='session.inspectAuthenticatedCall')return 'actual-call';if(name.startsWith('protocol.')||name.startsWith('signer.'))return 'wire-verification';
 if(name==='json.structuredClone')return 'copy';if(name.startsWith('json.'))return 'canonical-hash';if(name.startsWith('plan.'))return 'planner';
 if(name.startsWith('codec')||name.startsWith('fact.')||name.startsWith('root.'))return 'codec';
 if(name.startsWith('binding.')||name.startsWith('grant.')||name.startsWith('ledger.')||name.startsWith('registry.')||name==='scope.gate'||['endpoint.gate','endpoint.now','endpoint.permitAPI'].includes(name))return 'live-gate';
 if(['scope.load','scope.pre','scope.parts','scope.scalarPart'].includes(name))return 'source';if(name.startsWith('control.')||name.startsWith('link.')||name==='endpoint.openPeer')return 'transport';throw Error('lb3p_unknown_operation');
}
const mandatory=['construction','session.inspectAuthenticatedCall','protocol.validateChallengeExchange','protocol.validateChannelFrame','protocol.validateSessionTranscript','signer.verifyOwnerValue','binding.providerGate','binding.scopeGate','scope.gate','registry.assertCurrent','endpoint.gate','endpoint.now','endpoint.permitAPI','json.canonicalOwnedJson','json.ownedDigest','json.ownedSha256','json.structuredClone'];
export function costBreakdown(p){const groups=Object.fromEntries(LB3P_GROUPS.map(k=>[k,0])),canonicalByOwner={};for(const [name,b]of Object.entries(p.operations))groups[profileGroup(name)]+=b.exclusiveMs;for(const c of Object.values(p.contexts))if(profileGroup(c.operation)==='canonical-hash')canonicalByOwner[c.owner]=(canonicalByOwner[c.owner]??0)+c.exclusiveMs;return {groups,canonicalByOwner,otherMs:p.otherMs};}
export function validateLb3pCost(row,sources){
 validateLb3Row(row);wireShape(row);const p=row.profile;
 if(row.observation==='quiet'){need(p===null,'quiet');wireShape(row);return;}need(p?.schema==='cwc-lb3p.cost.v1'&&p.mode===row.observation,'cost_schema');
 need(p.start===row.trace.start&&p.end===row.trace.end&&p.wallMs===row.trace.wallMs&&finite(p.wallMs)&&near(p.wallMs,p.end-p.start),'cost_window');need(same(p.sources,sources),'method_sources');
 need(p.entries&&p.operations&&same(Object.keys(p.entries).sort(),Object.keys(p.operations).sort())&&Object.keys(p.operations).length<=128,'operation_closure');let exclusive=0;const sums={};
 const validNames=new Set([...Object.keys(sources).filter(k=>k!=='plan'),'construction','plan.client-initial','plan.client-seal','plan.provider']);
 for(const [name,b]of Object.entries(p.operations)){need(validNames.has(name)&&Number.isSafeInteger(b.calls)&&b.calls>0&&p.entries[name]===b.calls,'operation_calls');profileGroup(name);need(['inclusiveMs','exclusiveMs','childMs'].every(k=>finite(b[k]))&&near(b.inclusiveMs,b.exclusiveMs+b.childMs),'operation_partition');if(p.mode==='counts')need(b.inclusiveMs===0&&b.exclusiveMs===0&&b.childMs===0,'count_clock');exclusive+=b.exclusiveMs;sums[name]={calls:0,inclusiveMs:0,exclusiveMs:0,childMs:0};
  if(['construction','json.ownedSha256'].includes(name)||name.startsWith('plan.'))need(b.inclusiveMs<=p.wallMs+1e-6,'nonreentrant_cost');if(name==='json.ownedSha256')need(b.childMs===0,'sha_leaf');
 }
 need(finite(p.otherMs)&&near(p.otherMs+exclusive,p.wallMs),'cost_partition');need(p.contexts&&p.contextEntries&&same(Object.keys(p.contexts).sort(),Object.keys(p.contextEntries).sort())&&Object.keys(p.contexts).length<=1024,'context_capacity');
 for(const [key,c]of Object.entries(p.contexts)){need(c&&key===[c.actor,c.owner,c.operation].join('|')&&['outside','client-initial','client-seal','provider'].includes(c.actor)&&['outside',...LB3P_GROUPS].includes(c.owner)&&sums[c.operation],'context_identity');need(Number.isSafeInteger(c.calls)&&c.calls>0&&p.contextEntries[key]===c.calls&&['inclusiveMs','exclusiveMs','childMs'].every(k=>finite(c[k]))&&near(c.inclusiveMs,c.exclusiveMs+c.childMs),'context_cost');for(const k of ['calls','inclusiveMs','exclusiveMs','childMs'])sums[c.operation][k]+=c[k];}
 for(const [name,s]of Object.entries(sums))for(const k of ['calls','inclusiveMs','exclusiveMs','childMs'])need(near(s[k],p.operations[name][k]),'context_closure');
 for(const [name,b]of Object.entries(row.trace.buckets))need(same(b,{calls:p.operations[name]?.calls,inclusiveMs:p.operations[name]?.inclusiveMs,exclusiveMs:p.operations[name]?.exclusiveMs})&&row.trace.entries[name]===p.entries[name],'base_projection');
 need(same(p.handshakes,row.trace.handshakes),'handshake_projection');
 for(const actor of ['client-initial','client-seal','provider']){const w=row.planTiming.windows.filter(w=>w.actor===actor),count=p.entries['plan.'+actor]??0,done=w.filter(w=>w.complete).length,ms=w.reduce((n,w)=>n+w.end-w.start,0);need(count>=done&&count<=w.length,'plan_witness');const root=p.operations['plan.'+actor]?.inclusiveMs??0,attributed=Object.values(p.contexts).filter(c=>c.actor===actor).reduce((n,c)=>n+c.exclusiveMs,0);need(root<=ms+1e-6,'plan_cost');need(near(attributed,root),'actor_cost_closure');need(attributed<=ms+1e-6,'plan_cost');if(actor!=='provider')need(count===w.length,'client_plan_witness');}
 if(row.audit.calls){need((p.entries['protocol.validateChallengeExchange']??0)>=row.audit.challengeChecks&&(p.entries['protocol.validateChannelFrame']??0)>=row.audit.channelChecks&&(p.entries['signer.verifyOwnerValue']??0)>=row.audit.ownerChecks,'verification_witness');}
 // Closed, approved successful transfer: link inspections plus one per call equal binding full checks.
 if(row.status==='complete'){need(mandatory.every(k=>p.entries[k]>0),'required_operations');need(p.entries['session.inspectAuthenticatedCall']+row.audit.calls===row.audit.fullChecks,'actual_call_witness');if(row.arm!=='scalar')for(const k of ['codecB.planProof','codecB.inspectProof','grant.gate','ledger.check'])need(p.entries[k]>0,'codec_witness');}
 const d=costBreakdown(p);need(near(Object.values(d.groups).reduce((a,b)=>a+b,0)+d.otherMs,p.wallMs),'group_partition');return d;
}
export function summarizeLb3p(rows,rounds,workloads,clock){const base=summarizeLb3pBase(rows,rounds,workloads,clock);const median=a=>{const x=[...a].sort((a,b)=>a-b);return x.length?x.length%2?x[(x.length-1)/2]:(x[x.length/2-1]+x[x.length/2])/2:null;};
 const costs=[];for(const workload of workloads)for(const role of ['reader','authority-broker'])for(const arm of LB3_ARMS){const timed=rows.filter(r=>r.workload===workload&&r.role===role&&r.arm===arm&&r.round>=0&&r.observation==='timed'),ds=timed.map(r=>costBreakdown(r.profile));costs.push({workload,role,arm,complete:timed.filter(r=>r.status==='complete').length,attempted:timed.length,exclusiveMedians:Object.fromEntries(LB3P_GROUPS.map(k=>[k,median(ds.map(d=>d.groups[k]))])),canonicalByOwner:Object.fromEntries(['outside',...LB3P_GROUPS].map(k=>[k,median(ds.map(d=>d.canonicalByOwner[k]??0))])),deadlineCensored:timed.some(r=>r.status==='failed')});}
 return {comparison:base,costs,optimizationImplemented:false,productionAdopted:false,interpretation:'diagnostic-only; censored costs are observed work before refusal, not complete-transfer or recoverable cost'};
}
export function validateLb3pMeasurement(m,sources,methods){
 need(m?.schema==='cwc-lb3p.measurement.v1','measurement');validateLb3pBaseMeasurement({...m,schema:'cwc-lb3.measurement.v2'},sources);
 for(const row of m.rows)validateLb3pCost(row,methods);need(same(m.profileSummary,summarizeLb3p(m.rows,m.rounds,m.workloads.map(w=>w.id),m.clock)),'profile_summary');
 for(const a of m.approvals){const p=a.profilingApproval,manifest=p?.envelope?.manifest;need(p&&manifest?.schema==='cwc-lb3p.approval.v1'&&hash(p.registry)===p.pin&&hash(manifest)===p.registry.manifestDigest&&manifest.policyDigest===hash(LB3P_POLICY)&&manifest.basePin===a.record.comparison.pin,'profile_approval');const key=createPublicKey({key:Buffer.from(p.registry.operatorSpki,'base64'),type:'spki',format:'der'});need(verify(null,Buffer.from(canonical(manifest)),key,Buffer.from(p.envelope.signature,'base64')),'profile_signature');for(const [path,h]of Object.entries(manifest.sources))need(sources[path]===h,'profile_source');for(const name of ['gradleOwnedCwcLb3p.ts','gradleOwnedCwcLb3pProfile.ts','gradleOwnedCwcLb3pApproval.ts','gradleOwnedCwcLb3pValidation.mjs'])need(manifest.sources['src/test/fixtures/'+name],'profile_root');need(m.rows.filter(r=>r.workload===a.workload&&r.role===a.role&&r.round===a.round).every(r=>r.profilingPin===p.pin),'profile_pin');}
 return m.profileSummary;
}

// Actual packet costs stay in every raw row and are always checked against budgets.
// Only cross-mode equality accounts for canonical decimal TTL width variation.
export function wireShape(row){
 const ts=row.wireTtls,fs=row.wireFrames;need(Array.isArray(ts)&&Array.isArray(fs),'wire_evidence');
 for(const t of ts)need(['challenge-request','channel'].includes(t.kind)&&Number.isSafeInteger(t.ttlMs)&&t.ttlMs>0&&t.ttlMs<=4500,'wire_ttl');
 const frameTotal=fs.reduce((n,f)=>{need(Number.isSafeInteger(f.frame)&&f.frame>0&&f.frame<=16384&&Number.isSafeInteger(f.inner)&&f.inner>=0&&f.inner<=8192,'wire_frame');return n+f.frame+f.inner;},0);need(frameTotal===row.audit.wireBytes&&frameTotal<=LB3_CONDITIONS.wire,'wire_actual_cost');
 if(row.status!=='complete')return null;need(ts.length===2*row.audit.calls&&fs.length===8*row.audit.calls,'wire_closure');
 const kinds=['client-hello','server-hello','client-proof','ready','challenge-request','challenge','channel','channel'],shape=[];let total=0,callWire=0;
 for(let i=0;i<row.audit.calls;i++){const a=ts[2*i],b=ts[2*i+1];need(a.kind==='challenge-request'&&b.kind==='channel'&&a.api===b.api&&a.ttlMs===b.ttlMs,'wire_ttl_pair');const padding=4-String(a.ttlMs).length;
  for(let j=0;j<8;j++){const f=fs[8*i+j];need(f.kind===kinds[j]&&f.direction===(j%2===0?'request':'reply')&&Number.isSafeInteger(f.frame)&&f.frame>0&&f.frame<=16384&&Number.isSafeInteger(f.inner)&&f.inner>=0&&f.inner<=8192,'wire_frame');total+=f.frame+f.inner;shape.push({kind:f.kind,direction:f.direction,api:f.api,inner:f.inner,frame:f.frame+(j>=4?padding:0)});if(j===6)callWire=Math.max(callWire,f.frame+f.inner);}
 }
 need(total===row.audit.wireBytes&&total===row.result.wireBytes&&callWire===row.audit.callWire,'wire_actual_cost');return shape;
}
const auditInvariant=a=>Object.fromEntries(Object.entries(a).filter(([k])=>!['wireBytes','callWire'].includes(k)));
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2:null;};
export function summarizeLb3pBase(rows,rounds,workloads,clock){
 need(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=3&&['real','fixed'].includes(clock),'matrix');need(rows.length===workloads.length*2*(rounds+1)*9,'matrix_size');const seen=new Set(),groups=new Map();
 for(const r of rows){validateLb3Row(r);need(r.conditionsDigest===hash(LB3_CONDITIONS)&&workloads.includes(r.workload)&&r.clock===clock&&r.round<rounds,'matrix_row');const key=[r.workload,r.role,r.round,r.observation,r.arm].join('/');need(!seen.has(key),'matrix_duplicate');seen.add(key);const g=[r.workload,r.role,r.round].join('/'),a=groups.get(g)??[];a.push(r);groups.set(g,a);}
 for(const group of groups.values()){
  need(group.length===9,'group_size');for(const key of ['approvalPin','bindingPin','codePin','conditionsDigest','contextManifest']){const values=group.map(r=>r[key]).filter(x=>x!==null);need(new Set(values).size===1||(key==='contextManifest'&&values.length===0&&group.every(r=>r.failure?.phase==='construction')),'common_'+key);}
  for(const observation of LB3_OBSERVATIONS){const pair=group.filter(r=>r.observation===observation&&r.arm!=='scalar');if(pair.every(r=>r.status==='complete')){need(same(wireShape(pair[0]),wireShape(pair[1])),'paired_wire_shape');for(const k of ['outputDigest','inputDigest','inventoryDigest','planDigest','requests','clientPlans','providerPlans'])need(same(pair[0].result[k],pair[1].result[k]),'paired_'+k);for(const k of ['fullChecks','channelChecks','ownerChecks','liveChecks','purposeChecks','credentialChecks','publications'])need(pair[0].audit[k]===pair[1].audit[k],'paired_'+k);}}
  const complete=group.filter(r=>r.status==='complete');if(complete.length)for(const k of ['outputDigest','inputDigest','inventoryDigest'])need(new Set(complete.map(r=>r.result[k])).size===1,'common_'+k);
  for(const arm of LB3_ARMS){const pair=group.filter(r=>r.arm===arm&&r.observation!=='quiet');if(pair.every(r=>r.status==='complete')){need(same(pair[0].trace.entries,pair[1].trace.entries),'observer_count_parity');need(same(pair[0].profile.entries,pair[1].profile.entries)&&same(pair[0].profile.contextEntries,pair[1].profile.contextEntries),'profile_count_parity');need(same(auditInvariant(pair[0].audit),auditInvariant(pair[1].audit))&&same(wireShape(pair[0]),wireShape(pair[1])),'observer_audit_parity');}}
 }
 const summary=[];for(const workload of workloads)for(const role of ['reader','authority-broker']){
  const measured=rows.filter(r=>r.workload===workload&&r.role===role&&r.round>=0),arms=Object.fromEntries(LB3_ARMS.map(arm=>{const rs=measured.filter(r=>r.arm===arm),quiet=rs.filter(r=>r.observation==='quiet'),complete=quiet.filter(r=>r.status==='complete');return [arm,{completed:rs.filter(r=>r.status==='complete').length,attempted:rs.length,completionRate:rs.filter(r=>r.status==='complete').length/rs.length,quietMedianMs:median(complete.map(r=>r.totalMs)),quietAttemptMedianMs:median(quiet.map(r=>r.totalMs)),failures:rs.filter(r=>r.status==='failed').map(r=>({observation:r.observation,round:r.round,reason:r.failure.reason,overDeadline:r.overDeadline})),observationDeltaMs:Object.fromEntries([['counts','quiet'],['timed','counts'],['timed','quiet']].map(([a,b])=>[a+'-'+b,median(Array.from({length:rounds},(_,i)=>rs.find(r=>r.round===i&&r.observation===a).totalMs-rs.find(r=>r.round===i&&r.observation===b).totalMs))]))}];}));
  const wins=Array.from({length:rounds},(_,round)=>{const q=measured.filter(r=>r.round===round&&r.observation==='quiet'),bound=q.find(r=>r.arm==='bound-live');return q.every(r=>r.status==='complete')&&q.filter(r=>r.arm!=='bound-live').every(r=>bound.totalMs<r.totalMs);}).filter(Boolean).length;
  const candidate=clock==='real'&&rounds===3&&measured.every(r=>r.status==='complete')&&wins===rounds&&['scalar','full-reference'].every(a=>arms['bound-live'].quietMedianMs<=arms[a].quietMedianMs*(1-LB3_CONDITIONS.minimumImprovementPercent/100));summary.push({workload,role,arms,pairedQuietWins:wins,decision:candidate?'candidate-only':'defer',productionAdopted:false});
 }
 return {conditions:LB3_CONDITIONS,attempted:rows.filter(r=>r.round>=0).length,completed:rows.filter(r=>r.round>=0&&r.status==='complete').length,summary,decision:summary.every(r=>r.decision==='candidate-only')?'candidate-only':'defer',productionAdopted:false};
}
export function validateLb3pBaseMeasurement(m,sources){
 need(m?.schema==='cwc-lb3.measurement.v2'&&m.clock==='real'&&m.rounds===3&&same(m.workloads,LB3_WORKLOADS),'measurement_scope');
 const summary=summarizeLb3pBase(m.rows,m.rounds,m.workloads.map(w=>w.id),m.clock);need(same(m.summary,summary),'summary');need(m.approvals.length===24,'approval_closure');const seen=new Set();
 for(const a of m.approvals){const group=[a.workload,a.role,a.round].join('/');need(!seen.has(group),'approval_duplicate');seen.add(group);const rs=m.rows.filter(r=>[r.workload,r.role,r.round].join('/')===group);need(rs.length===9,'approval_group');
  for(const part of [a.record.comparison,a.record.binding,a.record.binding.connected,a.record.code]){
   const manifest=part.envelope.manifest,registry=part.registry;need(hash(registry)===part.pin&&(registry.manifestDigest??registry.approvedManifest)===hash(manifest),'approval_digest');
   const key=createPublicKey({key:Buffer.from(registry.operatorSpki,'base64'),type:'spki',format:'der'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(manifest)),key,Buffer.from(part.envelope.signature,'base64')),'approval_signature');
   const closure=manifest.sources??manifest.sourceClosure;need(closure&&Object.keys(closure).length>20,'approval_sources');for(const [p,h]of Object.entries(closure))need(sources[p]===h,'approval_source_'+p);
   for(const [p]of Object.entries(closure)){if(!p.startsWith('src/'))continue;need(Object.hasOwn(sources,p),'approval_source_missing');}
  }
  const comparison=a.record.comparison,binding=a.record.binding,code=a.record.code,manifest=comparison.envelope.manifest;
  need(manifest.schema==='cwc-lb3.approval.v1'&&manifest.conditionsDigest===hash(LB3_CONDITIONS)&&manifest.bindingPin===binding.pin&&manifest.codePin===code.pin&&binding.envelope.manifest.connectedPin===binding.connected.pin,'approval_binding');
  for(const root of ['gradleOwnedCwcLb3.ts','gradleOwnedCwcLb3Case.ts','gradleOwnedCwcLb3Profile.ts','gradleOwnedCwcLb3Approval.ts','gradleOwnedCwcLb3Validation.mjs','gradleOwnedCwcLb2Link.ts','gradleOwnedCwcLb1Fixture.ts','gradleOwnedCprBSession.ts'])need(Object.hasOwn(manifest.sources,'src/test/fixtures/'+root),'approval_roots');
  need(rs.every(r=>r.approvalPin===comparison.pin&&r.bindingPin===binding.pin&&r.codePin===code.pin),'approval_row');
 }
 return summary;
}
