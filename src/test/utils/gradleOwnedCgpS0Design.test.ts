import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {designSection,s0AnchorCapacity,s0TimeBound} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const recordPath='docs/validation/gradle-c3b-cgp-s0-design-2026-11-05.json',h0='docs/validation/gradle-c3b-cgp-h0-2026-11-05';
const record=json(recordPath),section=designSection(readFileSync(record.document.path,'utf8'),record.document.heading);
describe('CGP-S0 design record',()=>{
 it('matches the section and the H0 record it relies on',()=>{
  expect(sha(section)).toBe(record.document.sectionSha256);
  expect(sha(readFileSync(record.h0Evidence.path))).toBe(record.h0Evidence.sha256);
 });
 it('lists exactly the regression conditions and helpers of the section',()=>{
  const ids=[...section.matchAll(/^\| (SR\d{2}) \|/gm)].map(m=>m[1]);
  expect(ids).toEqual(Array.from({length:ids.length},(_,i)=>'SR'+String(i+1).padStart(2,'0')));
  expect(ids).toEqual(record.regressionConditions);
  expect(section).toContain(`SR01〜${ids.at(-1)}`);
  for(const name of record.helperContracts)expect(section).toContain('`'+name+'(');
 });
 it('stays a design: nothing implemented, measured or opened',()=>{
  expect(record.status).toBe('design-only');
  expect(record.regressionExecution).toEqual({runtimeConditionsExecuted:0,nativeRuns:0,helperImplemented:false,schemasImplemented:false,performanceImprovementEstablished:false,eightReadsEstablished:false});
  expect(record.flags).toEqual({cg0Proceed:false,cg3Proceed:false,backendEligible:false,profileApproved:false,nativeIsolationVerified:false,independentRegistryVerified:false,originalReadsSkipped:0});
 });
 it('recomputes the saved bounds from the H0 data',()=>{
  const raw=json(h0+'.measurements.json'),summary=json(h0+'.json');
  expect(s0TimeBound(raw,summary)).toEqual(record.feasibilityBound.time);
  expect(s0AnchorCapacity(summary)).toEqual(record.feasibilityBound.anchorCapacity);
 },60000);
 it('prints the saved bounds in the section',()=>{
  const n=(v:number)=>v.toLocaleString('en-US');
  for(const s of record.feasibilityBound.time.samples)expect(section).toContain(`| ${s.sample} | ${n(s.firstReadMs)} ms | ${n(s.otherWorkMs)} ms | ${n(s.replayBudgetMs)} ms | ${n(s.growthPerDepthFullMs)}→${n(s.growthPerDepthIdealMs)} ms | ${n(s.lastReadFullMs)}→${n(s.lastReadIdealMs)} ms | ${n(s.lastReplayIdealMs)} ms | ${s.readsWithinDeadlineIdeal} |`);
 });
});
describe('CGP-S0 bound arithmetic',()=>{
 const row=(wallMs:number,costs:Record<string,[number,number]>)=>({outcome:'returned',wallMs,costs:Object.fromEntries(Object.entries(costs).map(([p,[count,exclusiveMs]])=>[p,{count,exclusiveMs}]))});
 const diagnostic=(depth:number,r:any)=>({sample:1,depth,role:'a',observations:[{h0Costs:{rows:[r,{...r,outcome:'threw',wallMs:1e6}]}}]});
 const raw={leaseMs:5000,marginMs:500,samples:[{sample:1,index:1,outcome:'completed',elapsedMs:1000}],diagnostics:[diagnostic(0,row(10,{mac:[1,2],'disk.list':[2,4],'disk.put':[1,1]})),diagnostic(1,row(20,{'json-decode':[1,6],'disk.list':[4,8],'disk.put':[2,2]}))]};
 const summary={projectedGrowth:[{sample:1,fromDepth:0,toDepth:1,comparableCompletedDepths:true,terms:[{role:'a',readCommittedCount:10}]}]};
 it('removes only the reusable work and ignores refused rows',()=>{
  expect(s0TimeBound(raw,summary).samples[0]).toEqual({sample:1,firstReadMs:1000,otherWorkMs:900,replayBudgetMs:3600,growthPerDepthFullMs:100,growthPerDepthIdealMs:40,lastReadFullMs:1700,lastReadIdealMs:1240,lastReplayIdealMs:340,readsWithinDeadlineIdeal:8});
 });
 it('counts a read that ends exactly at the deadline and stops after it',()=>{
  expect(s0TimeBound({...raw,leaseMs:1500,marginMs:500},summary).samples[0].readsWithinDeadlineIdeal).toBe(2);
  expect(s0TimeBound({...raw,leaseMs:1499,marginMs:500},summary).samples[0].readsWithinDeadlineIdeal).toBe(1);
 });
 it('refuses evidence it cannot use',()=>{
  expect(()=>s0TimeBound({...raw,samples:[]},summary)).toThrow('s0_bound_invalid:first_read');
  expect(()=>s0TimeBound({...raw,diagnostics:[]},summary)).toThrow('s0_bound_invalid:rows');
  expect(()=>s0TimeBound(raw,{projectedGrowth:[]})).toThrow('s0_bound_invalid:growth');
  expect(()=>s0AnchorCapacity({projectedGrowth:[]})).toThrow('s0_bound_invalid:anchor');
 });
 it('fits rows by size as well as by count',()=>{
  const growth=(bytes:number)=>({projectedGrowth:[{fromDepth:0,toDepth:1,terms:[{role:'control-anchor',historyRowsBefore:0,historyRowsAfter:2,recordBytesBefore:0,recordBytesAfter:bytes}]}]});
  const cap={buckets:2,rowsPerPage:2,pageBytes:100};
  expect(s0AnchorCapacity(growth(40),cap,3)).toMatchObject({bytesPerRow:20,rowsPerPageAtMeanSize:2,rowsBeforeLastRead:4,bytesBeforeLastRead:80,deepestDepthByBytes:5,deepestDepthByRows:2});
  expect(s0AnchorCapacity(growth(160),cap,3)).toMatchObject({bytesPerRow:80,rowsPerPageAtMeanSize:1,deepestDepthByBytes:1,deepestDepthByRows:1});
 });
 it('ends a section at the next same-level heading only',()=>{
  expect(designSection('x\n### A\ny\n#### b\nz\n### C\nw\n','### A')).toBe('### A\ny\n#### b\nz\n');
  expect(designSection('### A\ny\n','### A')).toBe('### A\ny\n');
  expect(designSection('### A\ny\n\n\n### C\n','### A')).toBe('### A\ny\n');
  expect(designSection('### A\ny\n\n','### A')).toBe('### A\ny\n');
  expect(()=>designSection('y','### A')).toThrow('s0_bound_invalid:section');
 });
});
