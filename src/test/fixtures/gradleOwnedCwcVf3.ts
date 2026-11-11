/** VF-3 same-process real monotonic comparison. Provision approvals before T_total. */
import {Vf3SpendWitness} from './gradleOwnedCwcVf3Spend.js';
import {writeFileSync} from 'node:fs';
import {vf3Case,type Vf3Options} from './gradleOwnedCwcVf3Case.js';
import {vf3ApprovalFixture} from './gradleOwnedCwcVf3Approval.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {VfRealtimeClock,readOwnedClock} from './gradleOwnedCwcVf0Authority.js';
import {installVf3Observer,type Vf3Observer,type Vf3Observation} from './gradleOwnedCwcVf3Profile.js';
import {VF3_CONDITIONS,VF3_ARMS,VF3_OBSERVATIONS,VF3_WORKLOADS,summarizeVf3} from './gradleOwnedCwcVf3Validation.mjs';
import {ownedDigest as digest,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {sourceInventory} from '../../utils/gradleOwnedSourceSchema.js';
import {need,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
import {verifiedServiceOutcome} from './gradleOwnedCprBSession.js';
export function vf3Approvals(){const a=vf3ApprovalFixture(),c=cwcCApprovalFixture();return {...a,code:c.view,codeRecord:{envelope:c.envelope,registry:c.registry,pin:c.pin}};}
type Arm=typeof VF3_ARMS[number];
type Options={round?:number;workload?:string;role?:'reader'|'authority-broker';sizes?:number[];caseOptions?:Partial<Vf3Options>;beforeCleanup?:()=>void};
export async function runVf3Attempt(arm:Arm,observation:Vf3Observation,approvals:ReturnType<typeof vf3Approvals>,options:Options={}){
 need(VF3_ARMS.includes(arm)&&VF3_OBSERVATIONS.includes(observation),'configuration_invalid');
 const start=performance.now(),startedAt=Math.floor(start),deadline=startedAt+4500,ownedClock=new VfRealtimeClock();const clock=()=>readOwnedClock(ownedClock);
 let sourceSpend:Vf3SpendWitness|undefined,observer:Vf3Observer|undefined,f:ReturnType<typeof vf3Case>|undefined,result:any=null,failure:any=null,phase='construction',trace:any=null;
 const t={start,observerReady:start,constructed:start,transferEnd:start,auditEnd:start,cleanupEnd:start,end:start};let planTiming:any={windows:[],clientPlanMs:0,sealMs:0,providerPlanMs:0};let calls:any[]=[],frames:any[]=[],providerRows:any[]=[],providerMetrics:any=null,inventory:any=null,metadata:any=null;let audit:any={wireBytes:0,handshakes:0,loads:0,logical:0,reused:0,clientChecks:0,finalChecks:0,calls:0,held:0,unfinished:0,pending:0,lookup:0,transportBytes:0,verified:false,peakBytes:0,callWork:0,callWire:0,providerWork:0,providerWire:0,clientWork:0},contextManifest:string|null=null;
 const remember=(error:unknown)=>{failure??={phase,at:performance.now(),now:clock(),clockEnd:performance.now(),reason:verifiedServiceOutcome(error)?.reason??(error instanceof CurrentControlError?error.reason:'experiment_error'),message:error instanceof Error?error.message:String(error)};};
 try{
  if(observation!=='quiet')observer=installVf3Observer(observation);t.observerReady=performance.now();
  const construct=()=>{sourceSpend=new Vf3SpendWitness();return vf3Case({...options.caseOptions,sourceSpend,approval:approvals.view,codeApproval:approvals.code,verificationMode:arm.endsWith('fact-live')?'fact-live':'full-verify',transferMode:arm.startsWith('scalar')?'S-scoped':'B-independent',ownedClock,originalDeadline:deadline,observer,role:options.role??'reader',sizes:options.sizes,variant:'combined',referenceOracle:false,planEvents:false,comparisonProfile:true,memory:VF3_CONDITIONS.memory,work:VF3_CONDITIONS.providerWork,wireBudget:VF3_CONDITIONS.wire});};
  f=observer?observer.sync('construction',construct):construct();t.constructed=performance.now();contextManifest=f.ctx.manifest;phase='transfer';result=await f.transfer('vf3-common');t.transferEnd=performance.now();phase='audit';
  metadata=f.source.metadata;inventory=sourceInventory(f.source);const reconstructed=f.reconstructed!,expected=[...f.source.commits,...f.source.payloads].map(b=>sha(Buffer.from(b,'base64')));need(digest(reconstructed)===digest(f.source)&&result.outputDigest===digest(expected),'source_integrity');
  audit={...audit,verified:true,expectedDigest:digest(expected)};need(clock()<deadline,'request_expired');
 }catch(error){remember(error);}finally{
  if(t.observerReady===start)t.observerReady=performance.now();if(t.constructed===start)t.constructed=performance.now();if(t.transferEnd===start)t.transferEnd=performance.now();
  t.auditEnd=performance.now();phase='cleanup';
  try{options.beforeCleanup?.();f?.close();await f?.link.settle();const drainUntil=performance.now()+1000;while(f?.link.unfinished&&performance.now()<drainUntil){await new Promise(resolve=>setTimeout(resolve,1));await f.link.settle();}if(f){planTiming=f.planTiming;calls=f.link.diagnostics;frames=structuredClone(f.frames);providerRows=f.provider.rows;providerMetrics={...f.provider.metrics};const metrics:Record<string,number>={};for(const r of calls)for(const [k,v]of Object.entries(r.control.metrics))metrics[k]=(metrics[k]??0)+(v as number);
   audit={...audit,calls:calls.length,held:calls.reduce((s,r)=>s+r.control.bytesHeld+r.budget.heldBytes,0),pending:calls.filter(r=>r.control.pendingDispatch).length,lookup:calls.filter(r=>r.control.lookupPresent).length,transportBytes:calls.reduce((s,r)=>s+r.ownedTransportBytes,0),unfinished:f.link.unfinished,finalChecks:calls.reduce((s,r)=>s+r.finalChecks,0),...metrics,elidedHashes:calls.reduce((s,r)=>s+r.binding.elidedHashes,0),logical:calls.reduce((s,r)=>s+r.control.verification.logical,0),reused:calls.reduce((s,r)=>s+r.control.verification.reused,0),clientChecks:calls.reduce((s,r)=>s+r.clientChecks,0),handshakes:f.frames.filter(r=>r.kind==='client-hello').length,wireBytes:f.frames.reduce((s,r)=>s+r.inner+r.frame,0),loads:f.provider.metrics.loads,peakBytes:Math.max(0,...calls.map(r=>r.budget.peakBytes)),callWork:Math.max(0,...calls.map(r=>r.budget.work+r.budget.initialization)),callWire:Math.max(0,...calls.map(r=>r.budget.wire)),providerWork:Math.max(0,...f.provider.rows.map(r=>r.spent.work)),providerWire:Math.max(0,...f.provider.rows.map(r=>r.spent.wire)),clientWork:f.clientWork};need(audit.held===0&&audit.pending===0&&audit.lookup===0&&audit.transportBytes===0&&audit.unfinished===0,'owner_closed');}
  }catch(error){remember(error);}finally{sourceSpend?.close();}t.cleanupEnd=performance.now();try{trace=observer?.finish()??null;}catch(error){remember(error);}finally{observer?.close();}if(clock()>=deadline&&!failure){phase='deadline';remember(new CurrentControlError('request_expired'));}t.end=performance.now();
 }
 const observedNow=clock(),overDeadline=Math.floor(t.end)>=deadline;if(overDeadline&&!failure)failure={phase:'deadline',at:t.end,now:Math.floor(t.end),clockEnd:t.end,reason:'request_expired',message:'original total deadline reached at cleanup boundary'};
 const names=['start','observerReady','constructed','transferEnd','auditEnd','cleanupEnd','end'] as const,ds=['observerSetupMs','constructionMs','transferMs','auditMs','cleanupMs','observerFinishMs'];
 return {arm,observation,role:options.role??'reader',workload:options.workload??'small',round:options.round??0,clock:'owned-monotonic',conditionsDigest:digest(VF3_CONDITIONS),approvalPin:approvals.view.record.pin,bindingPin:approvals.view.transport.record.pin,codePin:approvals.code.digest,contextManifest,startedAt,deadline,overDeadline,status:failure?'failed':'complete',failure,result,audit,planTiming,cleaned:audit.held===0&&audit.pending===0&&audit.unfinished===0&&audit.lookup===0&&audit.transportBytes===0,timeline:t,totalMs:t.end-t.start,...Object.fromEntries(ds.map((k,i)=>[k,t[names[i+1]!]!-t[names[i]!]!])),trace,calls,frames,providerRows,providerMetrics,inventory,metadata,expiration:{clockDomain:'node-performance-timeOrigin',rounding:'floor',origin:performance.timeOrigin,observedNow,originalDeadline:deadline,lowerBoundMs:deadline-start,reason:failure?.reason??null,phase:failure?.phase??null,injected:!!options.caseOptions||!!options.beforeCleanup}};
}
export async function runCwcVf3(functional:unknown){
 const rows:any[]=[],approvals:any[]=[];
 for(const workload of VF3_WORKLOADS)for(const role of ['reader','authority-broker'] as const)for(let round=-1;round<3;round++){
  const approval=vf3Approvals();approvals.push({workload:workload.id,role,round,record:approval.record,code:approval.codeRecord});
  for(let j=0;j<3;j++)for(let i=0;i<4;i++){
   const arm=VF3_ARMS[(i+round+1)%4]!,observation=VF3_OBSERVATIONS[(j+round+1)%3]!;
   rows.push(await runVf3Attempt(arm,observation,approval,{round,workload:workload.id,role,sizes:workload.sizes}));
   if(process.env.CWC_VF3_RAW_PATH)writeFileSync(process.env.CWC_VF3_RAW_PATH,JSON.stringify({schema:'cwc-vf3.measurement.v2',conditions:VF3_CONDITIONS,rows,approvals,functional}));
  }
  console.log('VF3',workload.id,role,round,rows.slice(-12).map(r=>r.arm+'/'+r.observation+':'+r.status+'/'+Math.round(r.totalMs)).join(' '));
  approval.view.close();approval.code.close();
 }
 const m={schema:'cwc-vf3.measurement.v2',conditions:VF3_CONDITIONS,rows,approvals,functional};return {...m,summary:summarizeVf3(rows)};
}
