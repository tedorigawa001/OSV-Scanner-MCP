/** Opt-in interleaved comparison against a compiled, fingerprinted pre-PO2 commit. */
import {it,expect} from 'vitest';
import {readFile,writeFile,mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {performance} from 'node:perf_hooks';
import {AuthorityJournal,MemoryJournalIO,MemoryCheckpoint,journalGenesis,type JournalIO,type JournalRecord,type JournalCheckpoint} from '../fixtures/gradleOwnedAuthorityJournal.js';
import {FileJournalCheckpoint} from '../fixtures/gradleOwnedJournalCheckpoint.js';
import {RootedJournalIO} from '../fixtures/gradleOwnedJournalFs.js';
import {OwnedAuthorityContract} from '../fixtures/gradleOwnedAuthority.js';
import {ownedPolicyFixture} from '../fixtures/gradleOwnedPolicyFixture.js';
import {createOwnedRegistry,parseOwnedSettings} from '../../utils/gradleOwnedPolicy.js';
import {graphFixture} from '../fixtures/gradleGraphFixture.js';
import {ownedSha256,ownedDigest,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {pathToFileURL} from 'node:url';
const beforeRoot=process.env.OSV_MCP_OWNED_PO2_BEFORE_ROOT;
const zero=()=>({listCalls:0,listedEntries:0,readCalls:0,readBytes:0,putCalls:0,putBytes:0,resyncPutCalls:0,assertOpenCalls:0});
class MeteredIO implements JournalIO {
 metrics=zero();readonly written=new Set<string>();
 constructor(readonly base:JournalIO,readonly exists:(name:string)=>boolean){}
 async list(limit:number){this.metrics.listCalls++;const result=await this.base.list(limit);this.metrics.listedEntries+=result.length;return result;}
 async read(name:string,limit:number){this.metrics.readCalls++;const result=await this.base.read(name,limit);this.metrics.readBytes+=result.length;return result;}
 async put(name:string,bytes:Buffer){this.metrics.putCalls++;this.metrics.putBytes+=bytes.length;if(this.exists(name)||this.written.has(name))this.metrics.resyncPutCalls++;await this.base.put(name,bytes);this.written.add(name);}
 assertOpen(){this.metrics.assertOpenCalls++;this.base.assertOpen?.();}
}
const key=Buffer.alloc(32,19),checkpointKey=Buffer.alloc(32,27),checkpointKeyId='benchmark-checkpoint';
const identity=(name:string)=>({authorityId:'caller',storeEpoch:ownedSha256(name),keyId:'benchmark-key'});
function payload(bytes:number,version:number){const out=Buffer.alloc(bytes);for(let i=0;i<Math.ceil(bytes/(1024*1024));i++)out.fill((i+version*37)%251+1,i*1024*1024,Math.min(bytes,(i+1)*1024*1024));return out;}
const records=(bytes:Buffer,version:number):JournalRecord[]=>[
 {id:'manifest',role:'session-manifest',bytes:Buffer.from('{"fixture":true}')},
 {id:'ledger',role:'event-ledger',bytes:Buffer.from(canonicalOwnedJson({version}))},
 {id:'index',role:'session-index',bytes:Buffer.from('{"fixture":true}')},
 {id:'result',role:'operation-result',bytes:Buffer.from(canonicalOwnedJson({version}))},
 {id:'metadata',role:'metadata-snapshot',bytes},
];
function memoryContext(name:string,seed?:{store:Map<string,Buffer>;anchor:Map<string,Buffer>},memoryCheckpoint=false){
 const store=new MemoryJournalIO(),anchor=new MemoryJournalIO();for(const [n,b]of seed?.store??[])store.files.set(n,Buffer.from(b));for(const [n,b]of seed?.anchor??[])anchor.files.set(n,Buffer.from(b));
 const io=new MeteredIO(store,n=>store.files.has(n)),cpIO=new MeteredIO(anchor,n=>anchor.files.has(n)),id=identity(name);
 const cp=memoryCheckpoint?new MemoryCheckpoint(journalGenesis(id)):new FileJournalCheckpoint({identity:id,keyId:checkpointKeyId,key:checkpointKey,io:cpIO});
 const cpCalls={read:0,advance:0};const checkpoint:JournalCheckpoint={read:async()=>{cpCalls.read++;return cp.read();},advance:async(a,b)=>{cpCalls.advance++;await cp.advance(a,b);}};
 return {store,anchor,io,cpIO,cp,cpCalls,config:{...id,key,io,checkpoint},async close(){}};
}
type Metrics={store:ReturnType<typeof zero>;checkpoint:ReturnType<typeof zero>;checkpointCalls:{read:number;advance:number};nativeSync?:{files:number;directories:number}};
function counters(c:ReturnType<typeof memoryContext>,native?:RootedJournalIO[]):Metrics{return {store:{...c.io.metrics},checkpoint:{...c.cpIO.metrics},checkpointCalls:{...c.cpCalls},...(native?{nativeSync:{files:native.reduce((n,io)=>n+io.metrics.filesSynced,0),directories:native.reduce((n,io)=>n+io.metrics.directoriesSynced,0)}}:{})};}
function reset(c:ReturnType<typeof memoryContext>,native?:RootedJournalIO[]){c.io.metrics=zero();c.cpIO.metrics=zero();c.cpCalls.read=0;c.cpCalls.advance=0;if(native)for(const io of native){io.metrics.filesSynced=0;io.metrics.directoriesSynced=0;}}
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values,median:sorted[Math.floor(sorted.length/2)]!,min:sorted[0]!,max:sorted.at(-1)!};};

it.skipIf(!beforeRoot)('compares PO2 dirty snapshots and sealed input reuse against PO1',async()=>{
 const BJ=await import(pathToFileURL(path.join(beforeRoot!,'out/test/fixtures/gradleOwnedAuthorityJournal.js')).href),BK=await import(pathToFileURL(path.join(beforeRoot!,'out/test/fixtures/gradleOwnedAuthority.js')).href);
 const variants=[{name:'before',J:BJ.AuthorityJournal,K:BK.OwnedAuthorityContract},{name:'after',J:AuthorityJournal,K:OwnedAuthorityContract}];
 const reference=JSON.parse(await readFile('docs/benchmarks/gradle-owned-store-po1-2026-11-02.json','utf8')),beforeHashes:Record<string,string>={},afterHashes:Record<string,string>={};
 for(const [file,hash]of Object.entries(reference.afterHashes)){const actual=ownedSha256(await readFile(path.join(beforeRoot!,file)));expect(actual).toBe(hash);beforeHashes[file]=actual;afterHashes[file]=ownedSha256(await readFile(file));}
 const harness='src/test/benchmarks/gradleOwnedStorePo2.test.ts';afterHashes[harness]=ownedSha256(await readFile(harness));
 const rows:any[]=[],startedUTC=new Date().toISOString(),repetitions=5;
 const scenarios=[{scopes:1,large:false,sessions:1},{scopes:1,large:true,sessions:1},{scopes:16,large:true,sessions:1},{scopes:64,large:true,sessions:1},{scopes:4,large:true,sessions:4}];
 async function kernel(v:any,scopes:number,large:boolean,sessions:number,c:any){
  const journal=await v.J.create(c.config),f=ownedPolicyFixture();
  const model=new v.K({authorityId:'caller',journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)}}),caller=model.principal('caller'),reader=model.principal('reader');let seq=0;
  const command=(input:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++seq),...input});
  const requested=Array.from({length:scopes},(_,i)=>({project:'main::',context:'runtime',invocation:'invocation-'+i}));
  let active:any,beginRequest:any;for(let session=0;session<sessions;session++){beginRequest=command({operation:'begin',expectedRevision:0,consumerId:'consumer-'+session,scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(requested)});const begin=await model.dispatchDurable(caller,beginRequest);
  const core:any=graphFixture();if(large)core.inputs.files=Array.from({length:300},(_,i)=>({path:'f'+i+'/'+ 'x'.repeat(4000),sha256:ownedSha256('input')}));const bytes=Buffer.from(canonicalOwnedJson(core,16*1024**2));let ref:any;
  for(let ordinal=0;ordinal<Math.ceil(bytes.length/1024**2);ordinal++){const part=bytes.subarray(ordinal*1024**2,(ordinal+1)*1024**2);ref=(await model.dispatchDurable(caller,command({operation:'put-metadata-chunk',sessionId:begin.sessionId,uploadId:begin.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64')}))).ref;}
  const b=await model.dispatchDurable(caller,command({operation:'bind-core',sessionId:begin.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedSha256(bytes),rootRegistryDigest:ownedSha256('pin'),scopes:requested.map(s=>({...s,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}))}));
  active=await model.dispatchDurable(caller,command({operation:'activate',sessionId:begin.sessionId,expectedRevision:b.revision,expectedCurrentRevision:0}));}return {c,journal,model,caller,reader,command,active,requested,beginRequest};
 }

 async function context(name:string,native:boolean){
  const c=memoryContext(name);if(!native){await (c.cp as FileJournalCheckpoint).initialize();return {...c,native:undefined,close:async()=>{}};}
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'owned-po2-bench-')));let store:RootedJournalIO|undefined,anchor:RootedJournalIO|undefined;
  try{await mkdir(path.join(base,'store'),{mode:0o700});await mkdir(path.join(base,'anchor'),{mode:0o700});store=await RootedJournalIO.open({root:path.join(base,'store'),exclusive:true});anchor=await RootedJournalIO.open({root:path.join(base,'anchor'),exclusive:true});
   const io=new MeteredIO(store,()=>false),cpIO=new MeteredIO(anchor,()=>false),cp=new FileJournalCheckpoint({identity:identity(name),keyId:checkpointKeyId,key:checkpointKey,io:cpIO});await cp.initialize();const cpCalls={read:0,advance:0},checkpoint:JournalCheckpoint={read:async()=>{cpCalls.read++;return cp.read();},advance:async(a,b)=>{cpCalls.advance++;await cp.advance(a,b);}};
   return {...c,io,cpIO,cpCalls,config:{...identity(name),key,io,checkpoint},native:[store,anchor],close:async()=>{store!.close();anchor!.close();await rm(base,{recursive:true,force:true});}};
  }catch(e){store?.close();anchor?.close();await rm(base,{recursive:true,force:true});throw e;}
 }
 const delta=(after:any,before:any)=>after?Object.fromEntries(Object.entries(after).map(([k,n])=>[k,(n as number)-(before?.[k]??0)])):null;
 const normalize=(m:Metrics)=>({...m,store:{...m.store,assertOpenCalls:0},checkpoint:{...m.checkpoint,assertOpenCalls:0}});
 for(const native of [false,true])for(const scenario of native?[scenarios[1]!]:scenarios)for(const operation of ['warm-lookup','register-one','retry-begin']){
  const result:any={};
  for(let iteration=-1;iteration<repetitions;iteration++){
   const samples:any[]=[];
   for(const v of iteration%2===0?[...variants].reverse():variants){
    const c=await context('po2-'+JSON.stringify(scenario),native);
    try{
     const f=await kernel(v,scenario.scopes,scenario.large,scenario.sessions,c),request=operation==='retry-begin'?f.beginRequest:f.command(operation==='warm-lookup'?{operation:'lookup',sessionId:f.active.sessionId,scope:f.requested[0],expectedRevision:0}:{operation:'register-scope',sessionId:f.active.sessionId,scope:f.requested[0],expectedRevision:0});
     const snapshot=f.model.snapshotMetrics,seals=f.journal.sealedRecordMetrics;reset(c,c.native);const t=performance.now(),r=await f.model.dispatchDurable(operation==='warm-lookup'?f.reader:f.caller,request),ms=performance.now()-t,boundaryCounters=counters(c,c.native),snapshotDelta=delta(f.model.snapshotMetrics,snapshot),sealDelta=delta(f.journal.sealedRecordMetrics,seals);
     expect(r).toMatchObject(operation==='warm-lookup'?{contractStatus:'receipt-missing',backendEligible:false}:operation==='register-one'?{lifecycle:'registered',backendEligible:false}:{historical:true,backendEligible:false});
     const outcome={state:r.contractStatus??r.lifecycle,historical:r.historical??false,backendEligible:r.backendEligible};samples.push({boundaryCounters,outcome});
     if(iteration>=0){if(!result[v.name])result[v.name]={times:[],boundaryCounters,snapshotDelta,sealDelta};else {expect(boundaryCounters).toEqual(result[v.name].boundaryCounters);expect(snapshotDelta).toEqual(result[v.name].snapshotDelta);expect(sealDelta).toEqual(result[v.name].sealDelta);}result[v.name].times.push(ms);}
    }finally{await c.close();}
   }
   expect(samples[0].outcome).toEqual(samples[1].outcome);expect(normalize(samples[0].boundaryCounters)).toEqual(normalize(samples[1].boundaryCounters));
  }
  for(const s of Object.values(result) as any[]){s.elapsedMs=stats(s.times);delete s.times;}
  rows.push({scenario,storage:native?'native-rooted-files':'file-checkpoint-protocol-on-memory',operation,...result,speedupBeforeOverAfter:result.before.elapsedMs.median/result.after.elapsedMs.median,equivalent:true,ioAndSyncEquivalent:true});
 }
 for(const [file,hash]of Object.entries(afterHashes))expect(ownedSha256(await readFile(file))).toBe(hash);
 const report={schema:'osv-mcp.owned-store-po2-comparison-v1',beforeCommit:'16bf69f',beforeHashes,afterHashes,startedUTC,finishedUTC:new Date().toISOString(),repetitions,warmups:1,node:process.version,platform:process.platform,architecture:process.arch,cpu:os.cpus()[0]?.model,notes:['interleaved before/after order; fresh independent kernel and storage per sample','setup and post-timing assertions excluded; recovery verification remains timed','opaque random IDs differ; compare public outcome and exact IO sizes','assertOpen count may increase; read/list/put/checkpoint and native fsync must match','before lacks snapshot and seal instrumentation; null means not measured, never zero','same-state byte equivalence is checked by separate full-builder oracle regressions','no process peak RSS measured, no CI wall-clock threshold, no Gradle/BTA/OSV or backend adoption'],rows};
 const output=process.env.OSV_MCP_OWNED_PO2_OUTPUT;if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({rows:rows.length,output}));
},240_000);
