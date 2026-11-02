/** Opt-in baseline only. No optimized implementation or elapsed-time pass threshold. */
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
const enabled=process.env.OSV_MCP_OWNED_STORE_BENCH==='1';
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
it.skipIf(!enabled)('records reproducible owned-store baseline costs without changing verification',async()=>{
 const started=new Date().toISOString(),rows:unknown[]=[],repeat=5;
 const sourceHashes:Record<string,string>={};
 async function fingerprint(file:string):Promise<void>{
  const relative=path.relative(process.cwd(),path.resolve(file));expect(relative.startsWith('..')).toBe(false);if(sourceHashes[relative])return;
  const bytes=await readFile(relative);sourceHashes[relative]=ownedSha256(bytes);
  if(relative.endsWith('.ts'))for(const match of bytes.toString().matchAll(/from\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g))await fingerprint(path.resolve(path.dirname(relative),match[1]!.replace(/\.js$/,'.ts')));
 }
 await fingerprint('src/test/benchmarks/gradleOwnedStore.test.ts');await fingerprint('package-lock.json');
 const scenarios=[
  {name:'fixed-1MiB-h4',bytes:1024**2,history:4},
  {name:'fixed-1MiB-h8',bytes:1024**2,history:8},
  {name:'fixed-8MiB-h8',bytes:8*1024**2,history:8},
  {name:'fixed-1MiB-h32',bytes:1024**2,history:32},
  {name:'fixed-8MiB-h32',bytes:8*1024**2,history:32},
  {name:'fixed-8MiB-h64',bytes:8*1024**2,history:64},
  {name:'fixed-32MiB-h8',bytes:32*1024**2,history:8},
  {name:'churn-1MiB-h8',bytes:1024**2,history:8,churn:true},
  {name:'churn-8MiB-h8',bytes:8*1024**2,history:8,churn:true},
  {name:'memory-anchor-8MiB-h32',bytes:8*1024**2,history:32,memoryCheckpoint:true},
 ];
 for(const scenario of scenarios){
  const seed=memoryContext(scenario.name,undefined,scenario.memoryCheckpoint);if(seed.cp instanceof FileJournalCheckpoint)await seed.cp.initialize();
  const journal=await AuthorityJournal.create(seed.config);
  for(let i=0;i<scenario.history;i++)await journal.commit({operationId:'op-'+i,requestDigest:ownedSha256('request-'+i),records:records(payload(scenario.bytes,scenario.churn?i:0),i)});
  const snapshot={store:seed.store.files,anchor:seed.anchor.files},expected=payload(scenario.bytes,scenario.churn?scenario.history-1:0);
  for(const operation of ['object-cold-open','warm-lookup','warm-readLatest','commit-one'] as const){
   const timings:number[]=[],rssDeltas:number[]=[],heapDeltas:number[]=[];let observed:Metrics|undefined;
   for(let iteration=-1;iteration<repeat;iteration++){
    const c=memoryContext(scenario.name,snapshot,scenario.memoryCheckpoint);
    if(c.cp instanceof MemoryCheckpoint)c.cp.value={...journal.head};
    let current:AuthorityJournal|undefined;if(operation!=='object-cold-open')current=await AuthorityJournal.open(c.config);
    reset(c);const before=process.memoryUsage(),start=performance.now();
    const result=operation==='object-cold-open'?await AuthorityJournal.open(c.config):operation==='warm-lookup'?await current!.lookupOperation('op-'+(scenario.history-1)):operation==='warm-readLatest'?await current!.readLatest():await current!.commit({operationId:'next',requestDigest:ownedSha256('next'),records:records(payload(scenario.bytes,scenario.churn?scenario.history:0),scenario.history)});
    const ms=performance.now()-start,after=process.memoryUsage(),measurement=counters(c);
    if(operation==='object-cold-open')expect((result as AuthorityJournal).head.revision).toBe(scenario.history);
    else if(operation==='warm-readLatest')expect((result as JournalRecord[]).find(r=>r.role==='metadata-snapshot')!.bytes.equals(expected)).toBe(true);
    else expect(result).toMatchObject({revision:scenario.history+(operation==='commit-one'?1:0),backendEligible:false});
    if(iteration>=0){timings.push(ms);rssDeltas.push(after.rss-before.rss);heapDeltas.push(after.heapUsed-before.heapUsed);if(observed)expect(measurement).toEqual(observed);else observed=measurement;}
   }
   rows.push({layer:'journal',storage:scenario.memoryCheckpoint?'memory-checkpoint':'file-checkpoint-protocol-on-memory',scenario,operation,elapsedMs:stats(timings),rssDeltaBytes:stats(rssDeltas),heapUsedDeltaBytes:stats(heapDeltas),boundaryCounters:observed,storedBytes:[...seed.store.files.values()].reduce((n,b)=>n+b.length,0),checkpointBytes:[...seed.anchor.files.values()].reduce((n,b)=>n+b.length,0),historicalRecordBytesPerFullVerification:[...seed.store.files].filter(([n])=>n.startsWith('commit-')).reduce((n,[,b])=>n+JSON.parse(b.toString()).body.records.reduce((sum:number,r:{size:number})=>sum+r.size,0),0)});
  }
  console.log('baseline complete '+scenario.name);
 }
 // Actual fsync is measured separately; files are warm after authenticated seed preparation.
 for(const bytes of [1024**2,8*1024**2]){
  const name='native-'+bytes,seed=memoryContext(name);await (seed.cp as FileJournalCheckpoint).initialize();const prepared=await AuthorityJournal.create(seed.config);
  for(let i=0;i<8;i++)await prepared.commit({operationId:'op-'+i,requestDigest:ownedSha256('request-'+i),records:records(payload(bytes,0),i)});
  for(const operation of ['object-cold-open','warm-lookup','commit-one'] as const){
   const times:number[]=[];let measured:Metrics|undefined;
   for(let iteration=-1;iteration<repeat;iteration++){
    const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'owned-store-bench-')));let store:RootedJournalIO|undefined,anchor:RootedJournalIO|undefined;
    try{
     await mkdir(path.join(base,'anchor'),{mode:0o700});await mkdir(path.join(base,'store'),{mode:0o700});
     anchor=await RootedJournalIO.open({root:path.join(base,'anchor'),exclusive:true});store=await RootedJournalIO.open({root:path.join(base,'store'),exclusive:true});
     for(const [name,b]of seed.store.files)await store.put(name,b);for(const [name,b]of seed.anchor.files)await anchor.put(name,b);
     const names=new Set(seed.store.files.keys()),cpNames=new Set(seed.anchor.files.keys()),io=new MeteredIO(store,n=>names.has(n)),cpIO=new MeteredIO(anchor,n=>cpNames.has(n)),id=identity(name),raw=new FileJournalCheckpoint({identity:id,keyId:checkpointKeyId,key:checkpointKey,io:cpIO}),cpCalls={read:0,advance:0};
     const checkpoint:JournalCheckpoint={read:async()=>{cpCalls.read++;return raw.read();},advance:async(a,b)=>{cpCalls.advance++;await raw.advance(a,b);}};
     const config={...id,key,io,checkpoint},c={...seed,io,cpIO,cpCalls,config};let j:AuthorityJournal|undefined;if(operation!=='object-cold-open')j=await AuthorityJournal.open(config);
     reset(c,[store,anchor]);const start=performance.now();const result=operation==='object-cold-open'?await AuthorityJournal.open(config):operation==='warm-lookup'?await j!.lookupOperation('op-7'):await j!.commit({operationId:'next',requestDigest:ownedSha256('next'),records:records(payload(bytes,0),8)});const ms=performance.now()-start,metric=counters(c,[store,anchor]);
     expect(operation==='object-cold-open'?(result as AuthorityJournal).head.revision:(result as {revision:number}).revision).toBe(operation==='commit-one'?9:8);
     if(iteration>=0){times.push(ms);if(measured)expect(metric).toEqual(measured);else measured=metric;}
    }finally{store?.close();anchor?.close();await rm(base,{recursive:true,force:true});}
   }
   rows.push({layer:'journal',storage:'native-rooted-files',scenario:{bytes,history:8},operation,elapsedMs:stats(times),boundaryCounters:measured});
  }
  console.log('baseline complete native-'+bytes);
 }
 async function kernel(scopes:number,large:boolean){
  const name='kernel-'+scopes+'-'+large,c=memoryContext(name);await (c.cp as FileJournalCheckpoint).initialize();const journal=await AuthorityJournal.create(c.config),f=ownedPolicyFixture();
  const model=new OwnedAuthorityContract({authorityId:'caller',journal,now:()=>0,policy:{settings:parseOwnedSettings('owned-bta-offered-inputs-v1',f.claim.profileDigest),registry:createOwnedRegistry(f.raw)}}),caller=model.principal('caller'),reader=model.principal('reader');let seq=0;
  const command=(input:any)=>({schema:'osv-mcp.gradle-owned-authority-operation-v1',schemaVersion:1,operationId:'op-'+(++seq),...input});
  const requested=Array.from({length:scopes},(_,i)=>({project:'main::',context:'runtime',invocation:'invocation-'+i}));
  const b=await model.dispatchDurable(caller,command({operation:'begin',expectedRevision:0,consumerId:'consumer',scanRunId:'scan',projectRootId:'root',settingsDigest:ownedSha256('settings'),scopeRequestsDigest:ownedDigest(requested)}));
  const core:any=graphFixture();if(large)core.inputs.files=Array.from({length:300},(_,i)=>({path:'f'+i+'/'+ 'x'.repeat(4000),sha256:ownedSha256('input')}));
  const bytes=Buffer.from(canonicalOwnedJson(core,16*1024**2));let ref:any;
  for(let ordinal=0;ordinal<Math.ceil(bytes.length/1024**2);ordinal++){const part=bytes.subarray(ordinal*1024**2,(ordinal+1)*1024**2);ref=(await model.dispatchDurable(caller,command({operation:'put-metadata-chunk',sessionId:b.sessionId,uploadId:b.coreUploadId,purpose:'core',expectedRevision:ordinal,totalBytes:bytes.length,totalSha256:ownedSha256(bytes),ordinal,chunkSha256:ownedSha256(part),base64:part.toString('base64')}))).ref;}
  const bound=await model.dispatchDurable(caller,command({operation:'bind-core',sessionId:b.sessionId,expectedRevision:1,coreMetadataRef:ref,coreGraphDigest:ownedSha256(bytes),rootRegistryDigest:ownedSha256('pin'),scopes:requested.map(s=>({...s,taskId:'task',actionId:'action',brokerInstanceId:'broker',plannedCaptures:1,...f.claim}))}));
  const active=await model.dispatchDurable(caller,command({operation:'activate',sessionId:b.sessionId,expectedRevision:bound.revision,expectedCurrentRevision:0}));
  return {...c,model,caller,reader,command,active,requested,coreBytes:bytes.length};
 }
 for(const scenario of [{scopes:1,large:false},{scopes:1,large:true},{scopes:16,large:true},{scopes:64,large:true}]){
  for(const operation of ['warm-lookup','register-one'] as const){
   const times:number[]=[];let observed:Metrics|undefined,coreBytes=0;
   for(let iteration=-1;iteration<repeat;iteration++){
    const c=await kernel(scenario.scopes,scenario.large);coreBytes=c.coreBytes;reset(c);const request=c.command(operation==='warm-lookup'?{operation:'lookup',sessionId:c.active.sessionId,scope:c.requested[0],expectedRevision:0}:{operation:'register-scope',sessionId:c.active.sessionId,scope:c.requested[0],expectedRevision:0});
    const start=performance.now(),result=await c.model.dispatchDurable(operation==='warm-lookup'?c.reader:c.caller,request),ms=performance.now()-start,metric=counters(c);
    expect(result).toMatchObject(operation==='warm-lookup'?{contractStatus:'receipt-missing',backendEligible:false}:{lifecycle:'registered',backendEligible:false});
    if(iteration>=0){times.push(ms);if(observed)expect(metric).toEqual(observed);else observed=metric;}
   }
   rows.push({layer:'A1-A2-kernel',storage:'file-checkpoint-protocol-on-memory',scenario:{...scenario,coreBytes},operation,elapsedMs:stats(times),boundaryCounters:observed});
  }
  console.log('baseline complete kernel-'+scenario.scopes+'-'+scenario.large);
 }
 for(const [file,hash]of Object.entries(sourceHashes))expect(ownedSha256(await readFile(file))).toBe(hash);
 const report={schema:'osv-mcp.owned-store-baseline-v1',startedUTC:started,finishedUTC:new Date().toISOString(),node:process.version,platform:process.platform,architecture:process.arch,cpu:os.cpus()[0]?.model,sourceHashes,repetitions:repeat,warmups:1,baselineOnly:true,optimizedImplementation:false,semantics:{cold:'new journal instance; storage and OS caches not cold',memoryCheckpoint:'no disk durability or fsync',fileProtocolOnMemory:'authentication and checkpoint resync protocol with in-memory bytes; no native fsync',native:'exclusive RootedJournalIO roots; fsync counters from native adapter',counters:'JournalIO boundary calls/returned bytes; nested native IO inside put excluded from boundary counts',memory:'before/after deltas, not peak memory; GC is uncontrolled',kernelClock:'fixed at zero to exclude lifecycle/deadline effects',timing:'only named operation; setup/clone/validation excluded; commit includes input payload/record construction',notMeasured:['optimized speedup','full 256 MiB store','disk-cold startup','power loss','GC compaction','Gradle or BTA execution','OSV network','production adoption']},rows};
 const output=process.env.OSV_MCP_OWNED_STORE_BENCH_OUTPUT;if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({baselineRows:rows.length,output:output??null}));
},240_000);
