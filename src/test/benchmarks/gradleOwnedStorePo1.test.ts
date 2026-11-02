/** Opt-in interleaved comparison against a compiled, fingerprinted pre-PO1 commit. */
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
const beforeRoot=process.env.OSV_MCP_OWNED_PO1_BEFORE_ROOT;
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

it.skipIf(!beforeRoot)('compares PO1 against the actual pre-change implementation',async()=>{
 const baseline=JSON.parse(await readFile('docs/benchmarks/gradle-owned-store-baseline-2026-11-02.json','utf8'));
 const beforeJournal=await import(pathToFileURL(path.join(beforeRoot!,'out/test/fixtures/gradleOwnedAuthorityJournal.js')).href) as typeof import('../fixtures/gradleOwnedAuthorityJournal.js');
 const beforeKernel=await import(pathToFileURL(path.join(beforeRoot!,'out/test/fixtures/gradleOwnedAuthority.js')).href) as typeof import('../fixtures/gradleOwnedAuthority.js');
 const beforeHashes:Record<string,string>={},afterHashes:Record<string,string>={};
 for(const [file,digest]of Object.entries(baseline.sourceHashes)){const actual=ownedSha256(await readFile(path.join(beforeRoot!,file)));expect(actual).toBe(digest);beforeHashes[file]=actual;afterHashes[file]=ownedSha256(await readFile(file));}
 const harness='src/test/benchmarks/gradleOwnedStorePo1.test.ts';afterHashes[harness]=ownedSha256(await readFile(harness));
 const variants=[{name:'before',J:beforeJournal.AuthorityJournal,K:beforeKernel.OwnedAuthorityContract},{name:'after',J:AuthorityJournal,K:OwnedAuthorityContract}] as const;
 const repeat=5,rows:any[]=[];const started=new Date().toISOString();
 const ioShape=(m:Metrics)=>({...m,store:{...m.store,assertOpenCalls:0},checkpoint:{...m.checkpoint,assertOpenCalls:0}});
 const verify=async(j:AuthorityJournal)=>{if(typeof j.verifyHead==='function')return j.verifyHead();await j.readLatest();return j.head;};
 const sumRecords=(store:MemoryJournalIO)=>[...store.files].filter(([n])=>n.startsWith('commit-')).reduce((n,[,b])=>n+JSON.parse(b.toString()).body.records.reduce((sum:number,r:{size:number})=>sum+r.size,0),0);
 const sumLatest=(store:MemoryJournalIO)=>{const files=[...store.files].filter(([n])=>n.startsWith('commit-')).sort();return JSON.parse(files.at(-1)![1].toString()).body.records.reduce((n:number,r:{size:number})=>n+r.size,0);};
 const scenarios=[
  {name:'fixed-1MiB-h4',bytes:1024**2,history:4},{name:'fixed-1MiB-h8',bytes:1024**2,history:8},
  {name:'fixed-8MiB-h8',bytes:8*1024**2,history:8},{name:'fixed-1MiB-h32',bytes:1024**2,history:32},
  {name:'fixed-8MiB-h32',bytes:8*1024**2,history:32},{name:'fixed-8MiB-h64',bytes:8*1024**2,history:64},
  {name:'fixed-32MiB-h8',bytes:32*1024**2,history:8},{name:'churn-1MiB-h8',bytes:1024**2,history:8,churn:true},
  {name:'churn-8MiB-h8',bytes:8*1024**2,history:8,churn:true},{name:'memory-anchor-8MiB-h32',bytes:8*1024**2,history:32,memoryCheckpoint:true},
 ];
 async function measure(layer:string,storage:string,scenario:any,operation:string,prepare:(v:typeof variants[number])=>Promise<{journal:AuthorityJournal;c:ReturnType<typeof memoryContext>;native?:RootedJournalIO[];run:()=>Promise<any>;check:(r:any)=>unknown;close:()=>Promise<void>;beforeHashBytes:number;beforeReturnedBytes:number}>){
  const result:Record<string,any>={};
  for(let iteration=-1;iteration<repeat;iteration++){
   const order=iteration%2===0?[...variants].reverse():variants;
   const outputs:unknown[]=[],metrics:Metrics[]=[];
   for(const v of order){
    const prepared=await prepare(v);
    try{
     reset(prepared.c,prepared.native);const start=performance.now(),output=await prepared.run(),ms=performance.now()-start,metric=counters(prepared.c,prepared.native),proof=prepared.journal.verificationMetrics;
     outputs.push(prepared.check(output));metrics.push(metric);
     const lastRecovery=v.name==='before'?{recordHashBytes:prepared.beforeHashBytes,returnedRecordBytes:prepared.beforeReturnedBytes,derivedFromReference:true}:proof;
     if(iteration>=0){const old=result[v.name];if(old){expect(metric).toEqual(old.boundaryCounters);old.timings.push(ms);}else result[v.name]={timings:[ms],boundaryCounters:metric,lastRecovery};}
    }finally{await prepared.close();}
   }
   expect(outputs[0]).toEqual(outputs[1]);expect(ioShape(metrics[0]!)).toEqual(ioShape(metrics[1]!));
  }
  for(const value of Object.values(result)){value.elapsedMs=stats(value.timings);delete value.timings;}
  rows.push({layer,storage,scenario,operation,...result,speedupBeforeOverAfter:result.before.elapsedMs.median/result.after.elapsedMs.median,equivalent:true,ioAndSyncEquivalent:true});
 }
 for(const scenario of scenarios){
  const seed=memoryContext(scenario.name,undefined,scenario.memoryCheckpoint);if(seed.cp instanceof FileJournalCheckpoint)await seed.cp.initialize();const seeded=await beforeJournal.AuthorityJournal.create(seed.config);
  for(let i=0;i<scenario.history;i++)await seeded.commit({operationId:'op-'+i,requestDigest:ownedSha256('request-'+i),records:records(payload(scenario.bytes,scenario.churn?i:0),i)});
  const snapshot={store:seed.store.files,anchor:seed.anchor.files};
  for(const operation of ['object-cold-open','warm-verify-head','warm-lookup','warm-readLatest','commit-one']){
   await measure('journal',scenario.memoryCheckpoint?'memory-checkpoint':'file-checkpoint-protocol-on-memory',scenario,operation,async v=>{
    const c=memoryContext(scenario.name,snapshot,scenario.memoryCheckpoint);if(c.cp instanceof MemoryCheckpoint)c.cp.value={...seeded.head};
    let j=await v.J.open(c.config);
    const run=async()=>operation==='object-cold-open'?(j=await v.J.open(c.config)):operation==='warm-verify-head'?verify(j):operation==='warm-lookup'?j.lookupOperation('op-'+(scenario.history-1)):operation==='warm-readLatest'?j.readLatest():j.commit({operationId:'next',requestDigest:ownedSha256('next'),records:records(payload(scenario.bytes,scenario.churn?scenario.history:0),scenario.history)});
    return {get journal(){return j;},c,run,close:async()=>{},beforeHashBytes:sumRecords(seed.store),beforeReturnedBytes:operation==='warm-verify-head'||operation==='warm-readLatest'?sumLatest(seed.store):0,check:(r:any)=>{
     if(operation==='object-cold-open')return r.head;
     if(operation==='warm-readLatest')return r.map((x:JournalRecord)=>({id:x.id,role:x.role,sha256:ownedSha256(x.bytes),size:x.bytes.length}));
     return r;
    }};
   });
  }
  console.log('PO1 comparison '+scenario.name);
 }
 for(const bytes of [1024**2,8*1024**2]){
  const name='native-'+bytes,seed=memoryContext(name);await (seed.cp as FileJournalCheckpoint).initialize();const seeded=await beforeJournal.AuthorityJournal.create(seed.config);
  for(let i=0;i<8;i++)await seeded.commit({operationId:'op-'+i,requestDigest:ownedSha256('request-'+i),records:records(payload(bytes,0),i)});
  for(const operation of ['object-cold-open','warm-verify-head','warm-lookup','commit-one'])await measure('journal','native-rooted-files',{bytes,history:8},operation,async v=>{
   const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'owned-po1-bench-')));let store:RootedJournalIO|undefined,anchor:RootedJournalIO|undefined;
   try{
    await mkdir(path.join(base,'anchor'),{mode:0o700});await mkdir(path.join(base,'store'),{mode:0o700});anchor=await RootedJournalIO.open({root:path.join(base,'anchor'),exclusive:true});store=await RootedJournalIO.open({root:path.join(base,'store'),exclusive:true});
    for(const [n,b]of seed.store.files)await store.put(n,b);for(const [n,b]of seed.anchor.files)await anchor.put(n,b);
    const io=new MeteredIO(store,n=>seed.store.files.has(n)),cpIO=new MeteredIO(anchor,n=>seed.anchor.files.has(n)),raw=new FileJournalCheckpoint({identity:identity(name),keyId:checkpointKeyId,key:checkpointKey,io:cpIO}),cpCalls={read:0,advance:0};
    const checkpoint:JournalCheckpoint={read:async()=>{cpCalls.read++;return raw.read();},advance:async(a,b)=>{cpCalls.advance++;await raw.advance(a,b);}};
    const config={...identity(name),key,io,checkpoint},c={...seed,io,cpIO,cpCalls,config};let j=await v.J.open(config);
    return {get journal(){return j;},c,native:[store,anchor],run:async()=>operation==='object-cold-open'?(j=await v.J.open(config)):operation==='warm-verify-head'?verify(j):operation==='warm-lookup'?j.lookupOperation('op-7'):j.commit({operationId:'next',requestDigest:ownedSha256('next'),records:records(payload(bytes,0),8)}),beforeHashBytes:sumRecords(seed.store),beforeReturnedBytes:operation==='warm-verify-head'?sumLatest(seed.store):0,check:(r:any)=>operation==='object-cold-open'?r.head:r,close:async()=>{store!.close();anchor!.close();await rm(base,{recursive:true,force:true});}};
   }catch(e){store?.close();anchor?.close();await rm(base,{recursive:true,force:true});throw e;}
  });
 }
 async function kernel(v:typeof variants[number],scopes:number,large:boolean){
  const name='kernel-'+scopes+'-'+large,c=memoryContext(name);await (c.cp as FileJournalCheckpoint).initialize();const journal=await v.J.create(c.config),f=ownedPolicyFixture();
  const model=new v.K({authorityId:'caller',journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)}}),caller=model.principal('caller'),reader=model.principal('reader');let seq=0;
  const command=(input:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++seq),...input});
  const requested=Array.from({length:scopes},(_,i)=>({project:'main::',context:'runtime',invocation:'invocation-'+i}));
  const begin=await model.dispatchDurable(caller,command({operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(requested)}));
  const core:any=graphFixture();if(large)core.inputs.files=Array.from({length:300},(_,i)=>({path:'f'+i+'/'+ 'x'.repeat(4000),sha256:ownedSha256('input')}));const bytes=Buffer.from(canonicalOwnedJson(core,16*1024**2));let ref:any;
  for(let ordinal=0;ordinal<Math.ceil(bytes.length/1024**2);ordinal++){const part=bytes.subarray(ordinal*1024**2,(ordinal+1)*1024**2);ref=(await model.dispatchDurable(caller,command({operation:'put-metadata-chunk',sessionId:begin.sessionId,uploadId:begin.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64')}))).ref;}
  const b=await model.dispatchDurable(caller,command({operation:'bind-core',sessionId:begin.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedSha256(bytes),rootRegistryDigest:ownedSha256('pin'),scopes:requested.map(s=>({...s,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}))}));
  const active=await model.dispatchDurable(caller,command({operation:'activate',sessionId:begin.sessionId,expectedRevision:b.revision,expectedCurrentRevision:0}));return {c,journal,model,caller,reader,command,active,requested};
 }
 for(const scenario of [{scopes:1,large:false},{scopes:1,large:true},{scopes:16,large:true},{scopes:64,large:true}])for(const operation of ['warm-lookup','register-one'])await measure('A1-A2-kernel','file-checkpoint-protocol-on-memory',scenario,operation,async v=>{
  const f=await kernel(v,scenario.scopes,scenario.large),beforeHashBytes=sumRecords(f.c.store),beforeReturnedBytes=operation==='warm-lookup'?sumLatest(f.c.store):0;
  const request=f.command(operation==='warm-lookup'?{operation:'lookup',sessionId:f.active.sessionId,scope:f.requested[0],expectedRevision:0}:{operation:'register-scope',sessionId:f.active.sessionId,scope:f.requested[0],expectedRevision:0});
  return {journal:f.journal,c:f.c,run:()=>f.model.dispatchDurable(operation==='warm-lookup'?f.reader:f.caller,request),beforeHashBytes,beforeReturnedBytes,close:async()=>{},check:(r:any)=>{
   expect(r).toMatchObject(operation==='warm-lookup'?{contractStatus:'receipt-missing',backendEligible:false}:{lifecycle:'registered',backendEligible:false});
   return {status:r.contractStatus??r.lifecycle,backendEligible:r.backendEligible,ownedFileReads:r.ownedFileReads};
  }};
 });
 for(const [file,digest]of Object.entries(afterHashes))expect(ownedSha256(await readFile(file))).toBe(digest);
 const report={schema:'osv-mcp.owned-store-po1-comparison-v1',startedUTC:started,finishedUTC:new Date().toISOString(),beforeCommit:'7e00ee4',publishedBaselineSha256:ownedSha256(await readFile('docs/benchmarks/gradle-owned-store-baseline-2026-11-02.json')),beforeHashes,afterHashes,node:process.version,platform:process.platform,architecture:process.arch,cpu:os.cpus()[0]?.model,repetitions:repeat,warmups:1,order:'alternates before/after for each repeat',notes:['same providers, input bytes and timing boundaries per row','object-cold means a new journal, not disk-cold data; authenticated setup and validation excluded','head-only baseline uses readLatest then head; candidate uses verifyHead','native boundary counters exclude nested IO; actual fsync counters are separate','kernel fixtures use fresh opaque random IDs; compare public outcomes and IO sizes, not unrelated random heads','lastRecovery metrics cover only the last recovery call, not input hashing or all kernel calls','before recordHashBytes derived from reference source descriptors; candidate counters are instrumented','assertOpen call counts may increase; all read/list/put/checkpoint and native sync counts must match','wall-clock speedup is descriptive with no CI threshold; no OSV/BTA or production backend adoption'],rows};
 const output=process.env.OSV_MCP_OWNED_PO1_OUTPUT;if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({rows:rows.length,output:output??null}));
},240_000);
