import {it,expect} from 'vitest';
import {H0Probe,h0Exclusive} from '../fixtures/gradleOwnedH0Probe.js';
import {instrumentH0Json} from '../fixtures/gradleOwnedH0Instrument.js';
import {analyzeH0,h0Sources} from '../fixtures/gradleOwnedH0Report.mjs';
import {createHash} from 'node:crypto';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
it('partitions nested phase costs without adding inclusive durations twice',async()=>{let t=0;const p=new H0Probe(()=>t);const value={n:1};expect(await p.read(1,'history',async()=>{t=1;await p.phase('journal.readHistory',async()=>{t=2;p.sync('mac',()=>{t=4;});t=6;p.inventory([{records:[{bytes:Buffer.alloc(9)}]}]);p.diskRead(11);});t=10;return value;})).toBe(value);const r=p.snapshot().rows[0]!;expect(r.wallMs).toBe(10);expect(r.costs).toEqual({'mac':{count:1,exclusiveMs:2},'journal.readHistory':{count:1,exclusiveMs:3},'stage-other':{count:1,exclusiveMs:5}});expect([r.historyRows,r.recordBytes,r.ioBytes,r.ioReads]).toEqual([1,9,11,1]);});
it('rejects overlap and parent escape rather than reporting negative exclusive costs',()=>{for(const children of [[{phase:'mac',startMs:1,wallMs:5,children:[]},{phase:'hash',startMs:3,wallMs:1,children:[]}],[{phase:'mac',startMs:9,wallMs:2,children:[]}]] as any[])expect(()=>h0Exclusive({phase:'stage-other',startMs:0,wallMs:10,children})).toThrow();});
it('preserves errors and concurrent read attribution; refuses busy reset and reports overflow',async()=>{let end!:()=>void;const wait=new Promise<void>(r=>end=r),p=new H0Probe(undefined,1),error=Error('original');const a=p.read(1,'history',async()=>{await wait;throw error;});expect(()=>p.reset()).toThrow('busy');expect(await p.read(2,'receipt',async()=>2)).toBe(2);end();await expect(a).rejects.toBe(error);expect(p.snapshot().dropped).toBe(1);expect(p.snapshot().rows[0]!.outcome).toBe('threw');p.reset();expect(p.snapshot().rows).toEqual([]);});
it('patches only exact compiled function anchors, preserving calls and rejecting unknown or double recipes',()=>{const source='export function canonicalOwnedJson(x){return x;}\nexport function parseOwnedJson(x){return x;}';const patched=instrumentH0Json(source);expect(patched).toContain('probe.sync');expect(()=>instrumentH0Json(patched)).toThrow('anchor');expect(()=>instrumentH0Json('export const canonicalOwnedJson=1')).toThrow('anchor');});
const roles=['control-anchor','lineage-registry','provider','checkpoint-issuer','authority-broker'];
function profile(role:string,wall=8,historyRows=1){return {role,boot:role,categories:{'stage.readCommitted':{count:1}},historyReads:{schema:'cgp.history-events.v1',active:0,dropped:0,eventCount:1,reads:[{eventId:1,rpcId:1,api:'api',action:'receive',selector:'history',method:'readCommitted',callsite:'caller',startMs:100,wallMs:10,outcome:'returned'}]},h0Costs:{schema:'cgp.h0.read-costs.v1',active:0,dropped:0,rows:[{eventId:1,selector:'history',startMs:101,wallMs:wall,outcome:'returned',historyRows,recordBytes:100*historyRows,ioBytes:120*historyRows,ioReads:2,costs:{'stage-other':{count:1,exclusiveMs:wall}}}]}};}
function raw(){const ownerProcesses=roles.map((role,i)=>({role,boot:role,pid:i+1})),owners=roles.map(role=>profile(role)),spans=owners.map(o=>({role:o.role,boot:o.boot,rpcId:1,api:'api',action:'receive',startMs:90,wallMs:30,historyEventIds:[1]}));return {schema:'cgp.h0.measurements.v1',leaseMs:5000,marginMs:500,backendEligible:false,profileApproved:false,nativeIsolationVerified:false,independentRegistryVerified:false,originalReadsSkipped:0,executionSources:{files:{},digest:digest('{}')},compilations:[{sample:1,schema:'h0.compiled-json-instrumentation.v1',beforeSha256:'a'.repeat(64),afterSha256:'b'.repeat(64),wrappers:['canonicalOwnedJson','parseOwnedJson'],executed:ownerProcesses.map(o=>({...o,sha256:'b'.repeat(64)}))}],samples:[{sample:1,index:1,outcome:'completed',reason:null,elapsedMs:100,publishedThisRead:1,ownerProcesses,owners,rawSpans:[...spans,...['reader','authority-broker'].map((peer,i)=>({role:'provider',boot:'provider',rpcId:i+2,api:'aux.ReadSealedSource',action:'receive',startMs:200+i*20,wallMs:10,historyEventIds:[],outcome:'returned',sourceRequest:{peer,kind:'commit',index:0,offset:0,maxBytes:1}}))],readerEvents:[],entrySizes:[1],entryLayout:[{kind:'commit',index:0,byteLength:1}],leaseMs:5000,marginMs:500}],diagnostics:[0,1].flatMap(depth=>roles.map((role,i)=>({sample:1,depth,role,boot:role,pid:i+1,observations:[0,1,2].map(()=>profile(role,8,depth+1))})))};}
it('validates fixed-depth evidence and keeps zero benefit and storage diagnosis separate from adoption',()=>{const a=analyzeH0(raw());expect(a.batchCeilings[0].optimisticRemovableSpanMs).toBe(0);expect(a.decision.cg3Proceed).toBe(false);expect(a.diagnostics).toHaveLength(10);});
const row0=(r:any)=>r.samples[0].owners[0].h0Costs.rows[0];
const refuse=(r:any,reason:string,outcome='deadline-refused')=>{Object.assign(r.samples[0],{outcome,reason,publishedThisRead:0});};
// Each change reaches exactly one named check, so a removed check cannot hide behind another refusal.
const mutations:Record<string,(r:any)=>unknown>={
 probe:r=>r.samples[0].owners[0].h0Costs.active=1,
 count:r=>r.samples[0].owners[0].h0Costs.rows.pop(),
 identity:r=>row0(r).eventId=99,
 interval:r=>row0(r).startMs=0,
 io:r=>row0(r).ioBytes=-1,
 inventory:r=>row0(r).historyRows=null,
 costs:r=>row0(r).costs={},
 phase:r=>row0(r).costs.extra={count:1,exclusiveMs:0},
 partition:r=>row0(r).costs.mac={count:1,exclusiveMs:5},
 schema_deadline:r=>r.leaseMs=6000,
 adoption:r=>r.backendEligible=true,
 skip:r=>r.originalReadsSkipped=1,
 sources:r=>r.executionSources.digest='forged',
 samples:r=>r.samples=[],
 boot_sequence:r=>r.samples[0].sample=2,
 diagnostic_boot:r=>r.diagnostics.push({...structuredClone(r.diagnostics[0]),sample:99}),
 compilation_count:r=>r.compilations=[],
 compiled_receipt:r=>r.compilations[0].beforeSha256=r.compilations[0].afterSha256,
 executed_receipt:r=>r.compilations[0].executed[0].sha256='f'.repeat(64),
 read_sequence:r=>r.samples[0].index=2,
 compiled_owner:r=>r.compilations[0].executed[0].pid=999,
 diagnostic_closure:r=>r.diagnostics.pop(),
 sample_deadline:r=>r.samples[0].leaseMs=6000,
 outcome:r=>r.samples[0].outcome='other',
 reason:r=>r.samples[0].reason='unexpected',
 hidden_failure_class:r=>refuse(r,'Error: current_control_request_expired','other-refused'),
 span:r=>r.samples[0].rawSpans.at(-1).wallMs=-1,
 deadline_reason:r=>refuse(r,'Error: bad schema'),
 capacity_reason:r=>refuse(r,'Error: bad schema','capacity-refused'),
 publication:r=>r.samples[0].publishedThisRead=2,
 late_success:r=>r.samples[0].elapsedMs=5001,
 processes:r=>{r.samples[0].ownerProcesses[1].pid=1;r.compilations[0].executed[1].pid=1;for(const d of r.diagnostics)if(d.role===roles[1])d.pid=1;},
 owner:r=>{r.samples[0].owners[0].boot='other';for(const span of r.samples[0].rawSpans)if(span.role===roles[0])span.boot='other';},
 entry_sizes:r=>r.samples[0].entrySizes=[],
 layout:r=>r.samples[0].entryLayout=[],
 data_pass:r=>r.samples[0].rawSpans.at(-1).outcome='threw',
 data_coverage:r=>r.samples[0].rawSpans.at(-1).sourceRequest.index++,
 diagnostic:r=>r.diagnostics[0].observations.pop(),
 diagnostic_owner:r=>r.diagnostics[0].observations[0].role='other',
 diagnostic_row:r=>{const o=r.diagnostics[0].observations[0];o.historyReads.reads[0].outcome='threw';o.h0Costs.rows[0].outcome='threw';},
 fixed_depth:r=>r.diagnostics[0].observations[1].h0Costs.rows[0].recordBytes++,
};
for(const [name,change]of Object.entries(mutations))it('refuses faulty H0 evidence: '+name,()=>{const r=raw();change(r);expect(()=>analyzeH0(r)).toThrow('h0_evidence_'+name);});
it('counts every overlapping diagnostic and reused row as faulty evidence',()=>{for(const change of [(r:any)=>r.diagnostics[1]=r.diagnostics[0],(r:any)=>r.samples[0].owners[0].h0Costs.rows.push(row0(r))]){const r=raw();change(r);expect(()=>analyzeH0(r)).toThrow(/h0_evidence_(diagnostic_closure|count)/);}});
function bootstraps(growth:number[]){const base=raw(),r:any={...base,samples:[],diagnostics:[],compilations:[]};growth.forEach((step,i)=>{const sample=i+1;r.samples.push({...structuredClone(base.samples[0]),sample});r.compilations.push({...structuredClone(base.compilations[0]),sample});for(const d of base.diagnostics)r.diagnostics.push({...structuredClone(d),sample,observations:[0,1,2].map(()=>profile(d.role,d.depth?8+step:8,d.depth+1))});});return r;}
function addRefusedRead(r:any,step:number){r.samples=r.samples.flatMap((s:any)=>[s,{...structuredClone(s),index:2,outcome:'deadline-refused',reason:'Error: current_control_request_expired',publishedThisRead:0}]);for(const sample of new Set<number>(r.samples.map((s:any)=>s.sample)))roles.forEach((role,i)=>r.diagnostics.push({sample,depth:2,role,boot:role,pid:i+1,observations:[0,1,2].map(()=>profile(role,8+step,3))}));return r;}
it('decides the order only when every bootstrap agrees on completed depths',()=>{
 expect(analyzeH0(bootstraps([1,1,1])).decision.next).toBe('storage-replay-page-incremental-feasibility');
 expect(analyzeH0(bootstraps([0,0,0])).decision.next).toBe('I1-only-before-B-native');
 expect(analyzeH0(bootstraps([1,0,1])).decision.next).toBe('inconclusive-remeasure');
});
it('reports a depth after a refused read without letting it decide the order',()=>{
 const a=analyzeH0(addRefusedRead(bootstraps([1,1,1]),0));
 expect(a.projectedGrowth.map((p:any)=>[p.toDepth,p.comparableCompletedDepths])).toEqual([[1,true],[2,false],[1,true],[2,false],[1,true],[2,false]]);
 expect(a.decision.next).toBe('storage-replay-page-incremental-feasibility');
 expect(analyzeH0(addRefusedRead(bootstraps([0,0,0]),1)).decision.next).toBe('I1-only-before-B-native');
});
it('decides on the median so that one slow observation cannot flip the order',()=>{const r=bootstraps([0,0,0]);for(const d of r.diagnostics)if(d.depth===1)d.observations[0]=profile(d.role,9,2);const a=analyzeH0(r);expect(a.projectedGrowth[0].serialReplayWorkGrowthMs).toBeGreaterThan(0);expect(a.projectedGrowth[0].serialReplayWorkGrowthMedianMs).toBe(0);expect(a.decision.next).toBe('I1-only-before-B-native');});
it('stays undecided when a bootstrap has no completed read to compare',()=>{const r=bootstraps([1,1]);refuseWithoutDepth(r);expect(analyzeH0(r).decision.next).toBe('inconclusive-remeasure');});
function refuseWithoutDepth(r:any){Object.assign(r.samples[1],{outcome:'deadline-refused',reason:'Error: current_control_request_expired',publishedThisRead:0});}
it('records the fixtures that the measured child imports by compiled URL',async()=>{const {files}=await h0Sources();for(const file of ['src/test/fixtures/gradleOwnedCgpHistory.ts','src/test/fixtures/gradleOwnedCgpPages.ts','src/test/fixtures/gradleOwnedH0Probe.ts','src/utils/gradleOwnedJson.ts'])expect(files).toHaveProperty([file]);});

it('temporary compiled instrumentation preserves values and original thrown objects',async()=>{const code=instrumentH0Json('export function canonicalOwnedJson(x){if(x instanceof Error)throw x;return x;}\nexport function parseOwnedJson(x){return canonicalOwnedJson(x);}'),module=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')),key=Symbol.for('osv-mcp.h0.probe'),global=globalThis as any,previous=global[key],phases:string[]=[];global[key]={sync:(phase:string,work:()=>unknown)=>{phases.push(phase);return work();}};try{const value={x:1},error=Error('original');expect(module.parseOwnedJson(value)).toBe(value);expect(()=>module.canonicalOwnedJson(error)).toThrow(error);expect(phases).toContain('json-decode');expect(phases).toContain('json-canonical');}finally{if(previous===undefined)delete global[key];else global[key]=previous;}});
