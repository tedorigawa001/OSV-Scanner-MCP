import {it,expect} from 'vitest';
import {vf3pApprovals,runVf3pAttempt} from '../fixtures/gradleOwnedCwcVf3p.js';
import {validateVf3pRow} from '../fixtures/gradleOwnedCwcVf3pValidation.mjs';
import {CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
import {i0Case} from '../fixtures/gradleOwnedCgpI0Case.js';
import {vf3pObserverSources} from '../fixtures/gradleOwnedCwcVf3pProfile.js';
import {Vf3Link} from '../fixtures/gradleOwnedCwcVf3Link.js';
const tiny=[32,48,64,80,96],arms=['scalar/full-verify','scalar/fact-live','batch/full-verify','batch/fact-live'] as const;
let pending:Promise<any[]>|undefined;
function samples(){return pending??=(async()=>{const a=vf3pApprovals(),rows=[];for(const arm of arms)for(const observation of ['quiet','counts','timed'] as const)rows.push(await runVf3pAttempt(arm,observation,a,{sizes:tiny}));return rows;})();}
const timed=async()=>structuredClone((await samples()).find(r=>r.arm==='batch/fact-live'&&r.observation==='timed'));
it('VFP01: signed quiet batch keeps full reconstruction, budgets and accepted-part progress',async()=>{
 const r=await runVf3pAttempt('batch/fact-live','quiet',vf3pApprovals(),{sizes:[32,48,64,80,96]});
 validateVf3pRow(r);expect(r.status).toBe('complete');expect(r.progress.reconstructed).toBe(true);expect(r.progress.records).toHaveLength(r.audit.publications);expect(r.profile).toBe(null);
},30000);
it('VFP03: every arm retains the same successful output, live gates, reservations and restored executed methods',async()=>{
 const before=vf3pObserverSources(),rows=await samples();for(const r of rows){validateVf3pRow(r,before);expect(r.status,JSON.stringify(r.failure)).toBe('complete');}
 expect(new Set(rows.map(r=>r.result.outputDigest)).size).toBe(1);expect(vf3pObserverSources()).toEqual(before);
 for(const transfer of ['scalar','batch']){const rs=rows.filter(r=>r.arm.startsWith(transfer));for(const k of ['logical','liveChecks','purposeChecks','credentialChecks','providerWork','clientWork','peakBytes'])expect(new Set(rs.map(r=>r.audit[k])).size,k).toBe(1);}
},120000);
it('VFP04: understated, negative and nonfinite costs fail even without changing the outer total',async()=>{
 for(const value of [-1,NaN,Infinity]){const r=await timed();r.profile.operations['json.ownedSha256'].exclusiveMs=value;expect(()=>validateVf3pRow(r)).toThrow();}
 const r=await timed();r.profile.otherMs=0;expect(()=>validateVf3pRow(r)).toThrow(/partition/);
});
it('VFP05: moving costs between plan actors while preserving operation totals is refused',async()=>{
 const r=await timed(),cs=Object.values<any>(r.profile.contexts),a=cs.find(c=>c.actor==='client-initial'&&c.operation==='json.ownedDigest'),b=cs.find(c=>c.actor==='provider'&&c.operation==='json.ownedDigest'),delta=b.beforeMs/2;
 expect(delta).toBeGreaterThan(0);for(const key of ['exclusiveMs','inclusiveMs','beforeMs','inclusiveBeforeMs']){a[key]+=delta;b[key]-=delta;}
 expect(()=>validateVf3pRow(r)).toThrow('actor_partition');
});
it('VFP06: reducing inspection counts in entries, buckets and contexts still fails the independent actual-call witness',async()=>{
 const r=await timed(),p=r.profile,name='session.inspectAuthenticatedCall',c=Object.values<any>(p.contexts).find(c=>c.operation===name&&c.calls>1)!;c.calls--;p.contextEntries[[c.actor,c.owner,c.operation].join('|')]--;p.entries[name]--;p.operations[name].calls--;
 expect(()=>validateVf3pRow(r)).toThrow('inspection_count');
});
it('VFP07: accepted-part omissions, overlaps and false final reconstruction cannot become successful progress',async()=>{
 for(const change of [(r:any)=>r.progress.records.pop(),(r:any)=>r.progress.records.find((x:any)=>x.parts.length).parts[0].offset++,(r:any)=>r.progress.reconstructed=false]){const r=await timed();change(r);expect(()=>validateVf3pRow(r)).toThrow();}
});
it('VFP08: changed executed method fingerprints and nonreentrant inclusive inflation are refused',async()=>{
 const r=await timed();r.profile.sources['session.inspectAuthenticatedCall']='0'.repeat(64);expect(()=>validateVf3pRow(r,vf3pObserverSources())).toThrow('cost_sources');
 const s=await timed(),b=s.profile.operations['json.ownedSha256'];b.inclusiveMs=s.profile.wallMs+1;b.childMs=b.inclusiveMs-b.exclusiveMs;b.inclusiveBeforeMs=b.inclusiveMs;b.inclusiveAfterMs=0;expect(()=>validateVf3pRow(s)).toThrow('nonreentrant_bound');
});
it('VFP09: source approval revocation refuses before accepted bytes in both verification modes',async()=>{
 for(const mode of ['full-verify','fact-live']){const a=vf3pApprovals(),r=await runVf3pAttempt('batch/'+mode,'counts',a,{sizes:tiny,caseOptions:{hook:at=>{if(at==='load-before')a.revoke();}}});validateVf3pRow(r);expect(r.status).toBe('failed');expect(r.progress.records).toHaveLength(0);expect(r.audit.loads).toBe(0);}
},30000);
for(const mode of ['full-verify','fact-live'])it('VFP10 '+mode+': original deadline keeps partial progress and before/after observation costs separate',async()=>{
 const r=await runVf3pAttempt('batch/'+mode,'timed',vf3pApprovals(),{sizes:tiny,caseOptions:{hook:async at=>{if(at==='plan-before')await new Promise(resolve=>setTimeout(resolve,4510));}}});
 validateVf3pRow(r);expect(r.status).toBe('failed');expect(r.progress.reconstructed).toBe(false);expect(r.profile.wallAfterMs).toBeGreaterThan(0);
 const changed=structuredClone(r);changed.profile.otherBeforeMs=0;expect(()=>validateVf3pRow(changed)).toThrow(/partition/);
 const reduced=structuredClone(r),p=reduced.profile,name='session.inspectAuthenticatedCall',c=Object.values<any>(p.contexts).find(c=>c.operation===name&&c.calls>1)!;
 c.calls--;p.contextEntries[[c.actor,c.owner,c.operation].join('|')]--;p.entries[name]--;p.operations[name].calls--;expect(()=>validateVf3pRow(reduced)).toThrow('inspection_count');
},20000);
it('VFP11: additional source approval cannot silently accept a changed live method before construction',async()=>{
 const a=vf3pApprovals(),d=Object.getOwnPropertyDescriptor(Vf3Link.prototype,'dispatch')!;
 try{Object.defineProperty(Vf3Link.prototype,'dispatch',{...d,value:function(...args:unknown[]){return Reflect.apply(d.value,this,args);}});const r=await runVf3pAttempt('batch/fact-live','quiet',a,{sizes:tiny});validateVf3pRow(r);expect(r.status).toBe('failed');expect(r.audit.calls).toBe(0);}finally{Object.defineProperty(Vf3Link.prototype,'dispatch',d);}
},30000);
for(const mode of ['full-verify','fact-live'])it('VFP12 '+mode+': cancellation at the source boundary keeps accepted progress empty and releases private bytes',async()=>{
 let cancel=()=>{};const r=await runVf3pAttempt('batch/'+mode,'timed',vf3pApprovals(),{sizes:tiny,caseReady:c=>cancel=c.cancel,caseOptions:{hook:phase=>{if(phase==='load-before')cancel();}}});
 validateVf3pRow(r);expect(r.status).toBe('failed');expect(r.progress.records).toHaveLength(0);expect(r.audit.loads).toBe(0);expect(r.audit.held).toBe(0);expect(r.audit.unfinished).toBe(0);
},30000);
for(const mode of ['full-verify','fact-live'])it('VFP13 '+mode+': a correctly signed corrupted part cannot advance accepted source bytes',async()=>{
 const r=await runVf3pAttempt('batch/'+mode,'counts',vf3pApprovals(),{sizes:tiny,role:'authority-broker',caseOptions:{mutateResult:body=>{if(body.parts)body.parts[0].sha256='0'.repeat(64);}}});
 validateVf3pRow(r);expect(r.status).toBe('failed');expect(r.progress.reconstructed).toBe(false);expect(r.progress.records.flatMap((x:any)=>x.parts).filter((p:any)=>p.kind!=='inventory')).toHaveLength(0);
},30000);
it('VFP02: timed batch partitions costs by actor and original deadline without adding inclusive spans',async()=>{
 const r=await runVf3pAttempt('batch/fact-live','timed',vf3pApprovals(),{sizes:[32,48,64,80,96]});
 validateVf3pRow(r);expect(r.status).toBe('complete');const p=r.profile;
 expect(Object.keys(p.operations)).toContain('session.inspectAuthenticatedCall');
 expect(p.wallMs).toBeCloseTo(Object.values<any>(p.operations).reduce((s,b)=>s+b.exclusiveMs,0)+p.otherMs,6);
 expect(p.wallBeforeMs+p.wallAfterMs).toBeCloseTo(p.wallMs,6);expect(p.inspectionWitness.length).toBe(r.audit.calls);
},30000);
for(const mode of ['full-verify','fact-live'] as const)it('VFP14 '+mode+': reconstruction remains true when cleanup reaches the original deadline',async()=>{
 const a=vf3pApprovals(),started=performance.now();
 try{
  const r=await runVf3pAttempt('batch/'+mode,'timed',a,{sizes:tiny,beforeCleanup(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Math.max(0,started+4520-performance.now()));}});
  expect(r.status).toBe('failed');expect(r.failure.reason).toBe('request_expired');expect(r.failure.phase).toBe('deadline');expect(r.audit.verified).toBe(true);expect(r.progress.reconstructed).toBe(true);
  expect(()=>validateVf3pRow(r)).not.toThrow();
  const falseProgress=structuredClone(r);falseProgress.progress.reconstructed=false;expect(()=>validateVf3pRow(falseProgress)).toThrow('progress_reconstruction');
  const missingEvidence=structuredClone(r);missingEvidence.result=null;expect(()=>validateVf3pRow(missingEvidence)).toThrow();
 }finally{a.view.close();a.code.close();}
},20000);
const partials=new Map<string,Promise<any>>();
function partial(mode:'full-verify'|'fact-live'){
 if(!partials.has(mode))partials.set(mode,(async()=>{const a=vf3pApprovals();let plans=0;try{return await runVf3pAttempt('batch/'+mode,'timed',a,{sizes:tiny,caseOptions:{hook:at=>{if(at==='plan-before'&&++plans===2)throw new CurrentControlError('permission_denied');}}});}finally{a.view.close();a.code.close();}})());
 return partials.get(mode)!;
}
for(const mode of ['full-verify','fact-live'] as const){
 it('VFP15 '+mode+': accepted part length cannot shrink while provider and Session evidence stay unchanged',async()=>{
  const r=structuredClone(await partial(mode));validateVf3pRow(r);expect(r.status).toBe('failed');expect(r.progress.reconstructed).toBe(false);
  const last=r.progress.records.flatMap((x:any)=>x.parts).at(-1);expect(last.length).toBeGreaterThan(1);last.length=1;
  expect(()=>validateVf3pRow(r)).toThrow('progress_receipt');
 },30000);
 it('VFP16 '+mode+': an unreceived entry cannot replace an accepted part and become complete',async()=>{
  const r=structuredClone(await partial(mode)),parts=r.progress.records.flatMap((x:any)=>x.parts),seen=new Set(parts.map((p:any)=>p.kind+':'+p.index)),entry=i0Case('B*',tiny).entries.find(e=>!seen.has(e.kind+':'+e.index))!;
  expect(entry).toBeDefined();Object.assign(parts.at(-1),{kind:entry.kind,index:entry.index,offset:0,length:entry.byteLength,entryBytes:entry.byteLength,entrySha256:entry.sha256});
  expect(()=>validateVf3pRow(r)).toThrow('progress_receipt');
 },30000);
 it('VFP17 '+mode+': missing or modified transport-reply evidence cannot validate accepted progress',async()=>{
  for(const change of [(r:any)=>delete r.progress.records.at(-1).verifiedReply,(r:any)=>r.progress.records.at(-1).verifiedReply='e30=',(r:any)=>r.calls.filter((c:any)=>c.control.metrics.publications===1).at(-1).replyDigest='0'.repeat(64)]){
   const r=structuredClone(await partial(mode));change(r);expect(()=>validateVf3pRow(r)).toThrow('progress_receipt');
  }
  const old=structuredClone(await partial(mode));old.progress.schema='cwc-vf3p.progress.v1';expect(()=>validateVf3pRow(old)).toThrow('progress_schema');
 },30000);
}
