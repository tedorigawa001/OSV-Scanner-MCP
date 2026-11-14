/** Diagnostic child only. Never runs in the MCP or grants a charge/release permit. */
import * as v8 from 'node:v8';
import {Session} from 'node:inspector/promises';
import {openSync,readSync,closeSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {release} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHb2Fixture} from '../src/test/fixtures/gradleOwnedCwcHb2Bootstrap.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function imageDigest(){const fd=openSync(process.execPath,'r'),buf=Buffer.alloc(65536),hash=createHash('sha256');try{for(let n;(n=readSync(fd,buf,0,buf.length,null))>0;)hash.update(buf.subarray(0,n));return hash.digest('hex');}finally{closeSync(fd);}}
const id=process.argv[2],flags=['--experimental-vm-modules','--max-old-space-size=128'];
if(!['full-input','owned-input','snapshot','inspector','tools'].includes(id)||JSON.stringify(process.execArgv)!==JSON.stringify(flags)||process.env.NODE_OPTIONS||process.env.NODE_PATH)throw Error('ed1_invocation');
const runtime={node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,osRelease:release(),linkedVersions:{...process.versions},nodeBinaryDigest:imageDigest(),flags:process.execArgv,nodeOptions:'',nodePath:''};
const start=performance.now();
const apis=Object.fromEntries(['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics','getCppHeapStatistics','getHeapSnapshot','queryObjects'].map(k=>[k,typeof v8[k]]));
const memory=()=>({memory:process.memoryUsage(),heap:v8.getHeapStatistics(),code:v8.getHeapCodeStatistics(),spaces:v8.getHeapSpaceStatistics(),cpp:v8.getCppHeapStatistics('brief')});
let data;
if(id==='full-input'||id==='owned-input'){
 const samples=[],take=phase=>{const t=performance.now(),value=memory();samples.push({phase,value,elapsedMs:performance.now()-t});};
 take('before-bootstrap');const f=await createHb2Fixture(id,1,'candidate'),r=f.reader;take('after-bootstrap');
 const h=r.beginRead('client');r.openAttempt(h);const w=r.window(h,'first'),borrow=r.beginBorrow(h,w),transport=r.beginTransport(h,w),retained=[h,w];r.publish(h,w);r.closeWindow(h,w);const seal=r.window(h,'seal');r.publish(h,seal);r.closeWindow(h,seal);take('held');
 r.closeRead(h);let early=false;try{r.reclaim(h);}catch{early=true;}r.endBorrow(h,borrow);r.endTransport(h,transport);r.reclaim(h);take('drained');let late=false;try{r.publish(retained[0],retained[1]);}catch{late=true;}
 data={samples,witness:f.witness,earlyRejected:early,lateRejected:late,callerStillHolds:retained[0]===h&&retained[1]===w&&typeof h==='object'&&typeof w==='object',ledger:f.ledger(),candidateInstrumented:false};
}else if(id==='snapshot'){
 const f=await createHb2Fixture('owned-input',1,'candidate'),h=f.reader.beginRead();f.reader.openAttempt(h);const w=f.reader.window(h,'first');
 class Ed1Marker{constructor(){this.buffer=new Uint8Array(8192);this.alias=this.buffer;}}
 const marker=new Ed1Marker(),held=[marker];const queryCount=v8.queryObjects(Ed1Marker,{format:'count'});
 const t=performance.now(),stream=v8.getHeapSnapshot(),hash=createHash('sha256'),chunks=[];let bytes=0;
 for await(const chunk of stream){bytes+=chunk.length;if(bytes>33554432){stream.destroy();throw Error('ed1_snapshot_stream_cap');}hash.update(chunk);chunks.push(chunk);}
 const snapshot=JSON.parse(Buffer.concat(chunks).toString()),meta=snapshot.snapshot.meta,nf=meta.node_fields,ef=meta.edge_fields,n=snapshot.nodes,e=snapshot.edges;
 for(const k of ['type','name','self_size','edge_count'])if(!nf.includes(k))throw Error('ed1_snapshot_schema');
 if(n.length%nf.length||e.length%ef.length)throw Error('ed1_snapshot_shape');
 const kinds=meta.node_types[nf.indexOf('type')],counts={};let selfBytes=0,markers=0,edgeSum=0;
 for(let i=0;i<n.length;i+=nf.length){const kind=kinds[n[i+nf.indexOf('type')]];counts[kind]=(counts[kind]??0)+1;selfBytes+=n[i+nf.indexOf('self_size')];edgeSum+=n[i+nf.indexOf('edge_count')];if(kind==='object'&&snapshot.strings[n[i+nf.indexOf('name')]]==='Ed1Marker')markers++;}
 data={witness:f.witness,queryCount,markerCount:markers,aliasSame:held[0].buffer===held[0].alias,heldWindow:w!==undefined&&h!==undefined,bytes,sha256:hash.digest('hex'),nodeFields:nf,edgeFields:ef,nodeCount:n.length/nf.length,edgeCount:e.length/ef.length,edgeSum,selfBytes,counts,elapsedMs:performance.now()-t,rawRetained:false,completeNativeHeap:false,releaseReceipt:false};
}else if(id==='inspector'){
 const session=new Session();session.connect();const methods=[];const post=async(method,params={})=>{const t=performance.now(),r=await session.post(method,params);methods.push({method,elapsedMs:performance.now()-t});return r;};
 try{await post('HeapProfiler.enable');await post('HeapProfiler.startSampling',{samplingInterval:1024});const keep=Array.from({length:256},(_,i)=>({index:i,payload:new Uint8Array(128)}));const {profile}=await post('HeapProfiler.stopSampling');let nodes=0,selfSize=0;const visit=n=>{nodes++;selfSize+=n.selfSize;for(const c of n.children)visit(c);};visit(profile.head);data={methods,samplingInterval:1024,nodes,selfSize,samples:profile.samples.length,kept:keep.length,completeAllocationTrace:false,originalWorkMapping:false};}finally{session.disconnect();}
}else{
 const names=['ps','vmmap','footprint','heap','leaks','prlimit','systemd-run','docker'];const tools=[];
 for(const name of names){const found=spawnSync('/usr/bin/which',[name],{encoding:'utf8',timeout:2000,maxBuffer:8192}),path=found.status===0?found.stdout.trim():null;if(found.error||![0,1].includes(found.status))throw Error('ed1_tool_discovery');
  const args=name==='ps'?['-o','rss=,vsz=','-p',String(process.pid)]:name==='vmmap'?['-summary',String(process.pid)]:name==='footprint'?['-p',String(process.pid)]:null;
  let execution=null;if(path&&args){const t=performance.now(),r=spawnSync(path,args,{encoding:'utf8',timeout:5000,maxBuffer:65536});const out=r.stdout??'',err=r.stderr??'';execution={status:r.status,signal:r.signal,errorCode:r.error?.code??null,stdoutBytes:Buffer.byteLength(out),stderrBytes:Buffer.byteLength(err),stdoutDigest:sha(out),stderrDigest:sha(err),preview:(out||err).replaceAll(String(process.pid),'<diagnostic-pid>').replace(/\/(?:Users|home|private|var\/folders)\/\S*/g,'<local-path>').replace(/\[\d+\]/g,'[<pid>]').slice(0,1000),elapsedMs:performance.now()-t};}
  tools.push({name,path,discoveryStatus:found.status,execution,notRunReason:execution?null:path?'outside-bounded-local-probe-scope':'not-on-PATH'});
 }
 data={tools,cgroupMemoryMaxPresent:existsSync('/sys/fs/cgroup/memory.max'),gcExposed:typeof globalThis.gc==='function',externalProviderSearched:'no-external-proof-bundle-supplied',certifiedProviderFound:false};
}
console.log(JSON.stringify({schema:'cwc.hb2.ed1.probe.v1',id,runtime,apis,data,totalMs:performance.now()-start,diagnosticOnly:true}));
