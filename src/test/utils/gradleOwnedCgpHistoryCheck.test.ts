import {spawnSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {it,expect} from 'vitest';
import {validateHistoryReads} from '../fixtures/gradleOwnedCgpHistoryCheck.mjs';
const row=(id:number)=>({rpcId:id,api:'one',action:'receive',eventId:id,method:'readCommitted',selector:'history',callsite:'at caller (gradleOwnedAnchorOwner.js:1:1)',startMs:10*id,wallMs:1,outcome:'returned'});
const span=(id:number)=>({role:'provider',boot:'b',rpcId:id,api:'one',action:'receive',startMs:10*id-1,wallMs:3,historyEventIds:[id]});
const valid=():any=>({owners:[{role:'provider',boot:'b',categories:{'stage.readCommitted':{count:2}},historyReads:{schema:'cgp.history-events.v1',eventCount:2,active:0,dropped:0,reads:[row(1),row(2)]}}],rawSpans:[span(1),span(2)],readerEvents:[]});
const probe=(v:any)=>v.owners[0].historyReads,first=(v:any)=>probe(v).reads[0],firstSpan=(v:any)=>v.rawSpans[0];
// Each change is built so that only the named condition can refuse it.
const conditions:[string,(v:any)=>void][]=[
 ['a missing probe',v=>{delete v.owners[0].historyReads;}],
 ['another schema',v=>{probe(v).schema='other';}],
 ['an unfinished read',v=>{probe(v).active=1;}],
 ['a dropped read',v=>{probe(v).dropped=1;}],
 ['reads that are not a list',v=>{probe(v).reads={length:2};}],
 ['an event count other than the rows',v=>{probe(v).eventCount=3;}],
 ['an owner counter other than the rows',v=>{v.owners[0].categories['stage.readCommitted'].count=3;}],
 ['a renumbered row with a matching manifest',v=>{first(v).eventId=5;firstSpan(v).historyEventIds=[5];}],
 ['a start that is not a number',v=>{first(v).startMs=null;firstSpan(v).startMs=-1;}],
 ['a negative start inside its span',v=>{first(v).startMs=-5;firstSpan(v).startMs=-6;}],
 ['a duration that is not a number',v=>{first(v).wallMs=null;}],
 ['a negative duration',v=>{first(v).wallMs=-1;}],
 ['an unknown outcome',v=>{first(v).outcome='other';}],
 ['an unknown selector',v=>{first(v).selector='other';}],
 ['another method',v=>{first(v).method='other';}],
 ['a callsite that is not text',v=>{first(v).callsite=1;}],
 ['an unattributed callsite',v=>{first(v).callsite='unattributed';}],
 ['a row without its span',v=>{first(v).api='other';}],
 ['a row starting before its span',v=>{first(v).startMs=firstSpan(v).startMs-1;}],
 ['a row ending after its span',v=>{first(v).wallMs=100;}],
 ['a fractional RPC id',v=>{first(v).rpcId=1.5;firstSpan(v).rpcId=1.5;}],
 ['an RPC id outside any call',v=>{first(v).rpcId=0;firstSpan(v).rpcId=0;}],
 ['two spans with one RPC id',v=>{v.rawSpans.push({...span(1),api:'other'});}],
 ['a missing RPC manifest',v=>{delete firstSpan(v).historyEventIds;}],
 ['an empty RPC manifest',v=>{firstSpan(v).historyEventIds=[];}],
];
it('accepts the valid evidence the conditions below start from',()=>{expect(validateHistoryReads(valid()).reduce((n,g)=>n+g.count,0)).toBe(2);});
it.each(conditions)('refuses %s',(_,change)=>{const v=valid();change(v);expect(()=>validateHistoryReads(v)).toThrow('cgp_history_evidence_invalid');});
it('applies the same check in the analysis script',()=>{
 const command=(v:unknown)=>spawnSync(process.execPath,['scripts/analyze-c3b-cgp-history.mjs','--check-history'],{input:JSON.stringify(v),encoding:'utf8'});
 expect(command(valid()).status).toBe(0);
 for(const [,change]of conditions){const v=valid();change(v);const result=command(v);expect(result.status).not.toBe(0);expect(result.stderr).toContain('cgp_history_evidence_invalid');}
});
it('keeps the recorded verification when the summary is regenerated, and requires it when checked',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'cgp-history-summary-')),script=path.resolve('scripts/analyze-c3b-cgp-history.mjs'),base='gradle-c3b-cgp-history-2026-11-05',saved=path.join(root,'docs/validation',base+'.json');
 const run=(...args:string[])=>spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'});
 try{await mkdir(path.dirname(saved),{recursive:true});
  for(const name of ['.json','.before.measurements.json','.after.measurements.json','.pre-review.before.measurements.json','.pre-review.after.measurements.json'])await cp(path.resolve('docs/validation',base+name),path.join(root,'docs/validation',base+name));
  const before=JSON.parse(await readFile(saved,'utf8'));
  expect(run().status).toBe(0);const after=JSON.parse(await readFile(saved,'utf8'));
  for(const key of ['verification','reviewCorrections','documentSha256','regressionSourceSha256'])expect(after[key]).toEqual(before[key]);
  expect(run('--check').status).toBe(0);
  delete after.verification;await writeFile(saved,JSON.stringify(after,null,2)+'\n');
  const result=run('--check');expect(result.status).not.toBe(0);expect(result.stderr).toContain('history_summary_missing:verification');
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
