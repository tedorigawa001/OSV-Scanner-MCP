import {it,expect} from 'vitest';
import {writeFile,readFile} from 'node:fs/promises';import os from 'node:os';
import {h0ProcessFixture} from '../fixtures/gradleOwnedH0Process.js';
import {cgpReader,cgpNow,cgpCallSummary} from '../fixtures/gradleOwnedCgpRead.js';
import {cgpReadFailure,cgpKeepEvidenceOnFailure} from '../fixtures/gradleOwnedCgpOutcome.js';
import {currentAuthoritySource} from '../fixtures/gradleOwnedCurrentBridgeFixture.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createGradleBudget} from '../../utils/gradleGraph.js';
import {h0Sources,analyzeH0} from '../fixtures/gradleOwnedH0Report.mjs';
it.skipIf(process.env.OSV_H0_NATIVE!=='1')('decomposes fresh read costs at fixed history depths without extending read deadlines',async()=>{
 const output=process.env.OSV_H0_OUTPUT;let executionSources:any;const samples:any[]=[],diagnostics:any[]=[],compilations:any[]=[],count=Number(process.env.OSV_H0_RUNS??3);expect(Number.isSafeInteger(count)&&count>=1&&count<=3).toBe(true);
 await cgpKeepEvidenceOnFailure(output,()=>({executionSources,samples,diagnostics,compilations}),async progress=>{
 executionSources=await h0Sources();
 for(let sample=1;sample<=count;sample++){progress.stage='bootstrap';progress.sample=sample;const data=await currentAuthoritySource(undefined,()=>Math.floor(cgpNow())),policy=ownedPolicyFixture(),f=await h0ProcessFixture(data.input,{operationBinding:data.request.operationBinding,profileDigest:data.request.profileDigest,policyRegistry:policy.raw});let reader:ReturnType<typeof cgpReader>|undefined;
 try{const executed=[...f.owners].map(([role,o])=>({role,pid:o.hello.pid,boot:o.hello.boot,sha256:o.hello.instrumentedJsonSha256}));expect(executed.every(e=>e.sha256===f.instrumentation.afterSha256)).toBe(true);compilations.push({sample,...f.instrumentation,executed});const b=await f.call('control.BeginEnrollment',{approvedBase:data.input.approvedBaseDigest}),fence=b.result.provision,candidate=await f.call('aux.PrepareCandidate',{mode:'genesis',fence,input:f.publish()}),prepared=await f.prepare(candidate.result.snapshot,fence);await f.call('control.ActivateEnrollment',{provision:fence,checkpoint:prepared.checkpoint});reader=cgpReader(f,data);
 const diagnose=async(depth:number)=>{for(const [role,o]of f.owners){const result=await o.rpc('h0-diagnostic');diagnostics.push({sample,depth,role,pid:o.hello.pid,boot:o.hello.boot,...result});}};
 await diagnose(0);
 for(let index=1;index<=3;index++){progress.stage='read';progress.index=index;for(const o of f.owners.values())await o.rpc('cgp-reset');const offset=f.profiles.length,eventOffset=reader.events.length,publishedBefore=reader.bridge.diagnostics.publishedResults,loadAverageBefore=os.loadavg(),start=cgpNow();let outcome='completed',reason:string|null=null;
 try{const doc=await reader.bridge.readDocument('graph',createGradleBudget(),data.policy);expect(doc.owned?.executionWitness).toBe('verified');}catch(e){reason=String(e);outcome=cgpReadFailure(reason);}
 const elapsedMs=cgpNow()-start,publishedThisRead=reader.bridge.diagnostics.publishedResults-publishedBefore;if(outcome!=='completed')reader.bridge.close();const drain=cgpNow();for(;;){const m=await Promise.all([...f.owners.values()].map(o=>o.rpc('metrics')));if(m.every(v=>(v.inFlight??0)===0))break;expect(cgpNow()-drain).toBeLessThan(10000);await new Promise(r=>setTimeout(r,10));}
 const owners=await Promise.all([...f.owners.values()].map(o=>o.rpc('cgp-metrics'))),rawSpans=f.profiles.slice(offset).filter(p=>!['metrics','cgp-metrics'].includes(p.action)),readerEvents=reader.events.slice(eventOffset),ownerProcesses=[...f.owners].map(([role,o])=>({role,pid:o.hello.pid,boot:o.hello.boot}));
 samples.push({sample,index,outcome,reason,elapsedMs,drainMs:cgpNow()-drain,publishedThisRead,ownerProcesses,owners,rawSpans,readerEvents,calls:cgpCallSummary(rawSpans,readerEvents),loadAverageBefore,entrySizes:[...data.input.commits,...data.input.payloads].map(b=>b.length),entryLayout:[...data.input.commits.map((b,index)=>({kind:'commit',index,byteLength:b.length})),...data.input.payloads.map((b,index)=>({kind:'payload',index,byteLength:b.length}))],leaseMs:5000,marginMs:500});
 console.log('H0_READ',JSON.stringify({sample,index,outcome,elapsedMs}));expect(publishedThisRead).toBe(outcome==='completed'?1:0);if(outcome==='completed')expect(elapsedMs).toBeLessThan(5000);
 progress.stage='depth-diagnostic';await diagnose(index);if(outcome!=='completed')break;
 }
 }finally{reader?.bridge.close();await f.cleanup();}}
 const raw={schema:'cgp.h0.measurements.v1',executionSources,host:{platform:process.platform,arch:process.arch,node:process.version,cpus:os.cpus().length,loadAverage:os.loadavg()},samples,diagnostics,compilations,leaseMs:5000,marginMs:500,backendEligible:false,profileApproved:false,nativeIsolationVerified:false,independentRegistryVerified:false,originalReadsSkipped:0};expect(await h0Sources()).toEqual(executionSources);analyzeH0(raw);if(output)await writeFile(output,JSON.stringify(raw,null,2)+'\n');progress.completeReportWritten=true;
 });
},600000);
