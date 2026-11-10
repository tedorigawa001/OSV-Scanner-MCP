/** CLB-3 local real-session experiment. Approval provisioning is outside the call,
 * construction, handshake, capture, reconstruction, audit and cleanup are inside. */
import {cwcLb3Case,type CwcLb3Options} from './gradleOwnedCwcLb3Case.js';
import {lb3pApprovalFixture,requireLb3pApproval,type Lb3pApproval} from './gradleOwnedCwcLb3pApproval.js';
import {installLb3pObserver} from './gradleOwnedCwcLb3pProfile.js';
import {type Lb3Observation} from './gradleOwnedCwcLb3Profile.js';
import {summarizeLb3p} from './gradleOwnedCwcLb3pValidation.mjs';
import {LB3_CONDITIONS,LB3_ARMS,LB3_OBSERVATIONS,LB3_WORKLOADS,summarizeLb3} from './gradleOwnedCwcLb3Validation.mjs';
import {ownedDigest as digest,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,CurrentControlError} from '../../utils/gradleOwnedCurrentSchema.js';
import {decodeCurrent} from '../../utils/gradleOwnedCurrentSchema.js';
import {writeFileSync} from 'node:fs';
import {summarizeLb3pBase} from './gradleOwnedCwcLb3pValidation.mjs';
import {verifiedServiceOutcome} from './gradleOwnedCprBSession.js';
type Arm=typeof LB3_ARMS[number];
type Options={realClock?:boolean;round?:number;workload?:string;role?:'reader'|'authority-broker';sizes?:number[];caseOptions?:Partial<CwcLb3Options>;clock?:()=>number;beforeCleanup?:()=>void};
export async function runLb3pAttempt(arm:Arm,observation:Lb3Observation,approval:Lb3pApproval,options:Options={}){
 need(LB3_ARMS.includes(arm)&&LB3_OBSERVATIONS.includes(observation),'configuration_invalid');
 const start=performance.now(),rawClock=options.clock??(options.realClock?()=>Math.floor(performance.now()):()=>0),clock=()=>{approval.assertCurrent();return rawClock();},startedAt=options.realClock?Math.floor(start):rawClock(),deadline=startedAt+4500;
 const wireTtls:{api:string;kind:string;ttlMs:number}[]= [];let wireFrames:any[]=[];
 let observer:ReturnType<typeof installLb3pObserver>|undefined,f:ReturnType<typeof cwcLb3Case>|undefined,result:any=null,failure:any=null,phase='construction',trace:any=null,profile:any=null;
 const t={start,observerReady:start,constructed:start,transferEnd:start,auditEnd:start,cleanupEnd:start,end:start};let planTiming:any={schema:'cwc-lb3.plan-timing.v1',windows:[],clientPlanMs:0,sealMs:0,providerPlanMs:0};let audit:any={calls:0,held:0,unfinished:0,pending:0,lookup:0,transportBytes:0,wireBytes:0,verified:false,peakBytes:0,callWork:0,callWire:0,providerWork:0,providerWire:0,clientWork:0},contextManifest:string|null=null;
 const remember=(error:unknown)=>{failure??={phase,reason:verifiedServiceOutcome(error)?.reason??(error instanceof CurrentControlError?error.reason:'experiment_error'),message:error instanceof Error?error.message:String(error)};};
 try{
  requireLb3pApproval(approval);if(observation!=='quiet')observer=installLb3pObserver(observation);t.observerReady=performance.now();
  const construct=()=>cwcLb3Case(arm==='scalar'?'S-scoped':'B-independent',{...options.caseOptions,mutatePacket:original=>{const packet=options.caseOptions?.mutatePacket?.(original)??original;const body:any=(decodeCurrent(packet.wire) as any).body;if(['challenge-request','channel'].includes(body.kind))wireTtls.push({api:body.api,kind:body.kind,ttlMs:body.ttlMs});return packet;},approvals:approval.base,bindingMode:arm==='bound-live'?'bound-live':'full-reference',startedAt,clock,observer:observer?.port,role:options.role??'reader',sizes:options.sizes,variant:'combined',referenceOracle:false,planEvents:false,comparisonProfile:true,memory:LB3_CONDITIONS.memory,work:LB3_CONDITIONS.providerWork,wireBudget:LB3_CONDITIONS.wire});
  f=observer?observer.sync('construction',construct):construct();t.constructed=performance.now();contextManifest=f.ctx.manifest;phase='transfer';result=await f.transfer('clb3-common');t.transferEnd=performance.now();phase='audit';
  const reconstructed=f.reconstructed!,expected=[...f.source.commits,...f.source.payloads].map(b=>sha(Buffer.from(b,'base64')));need(digest(reconstructed)===digest(f.source)&&result.outputDigest===digest(expected),'source_integrity');
  audit={...audit,verified:true,expectedDigest:digest(expected)};
 }catch(error){remember(error);}finally{
  if(t.observerReady===start)t.observerReady=performance.now();if(t.constructed===start)t.constructed=performance.now();if(t.transferEnd===start)t.transferEnd=performance.now();
  t.auditEnd=performance.now();phase='cleanup';
  try{options.beforeCleanup?.();f?.close();await f?.link.settle();if(f){planTiming=f.planTiming;wireFrames=structuredClone(f.frames);const calls=f.link.diagnostics,metrics:Record<string,number>={};for(const r of calls)for(const [k,v]of Object.entries(r.control.metrics))metrics[k]=(metrics[k]??0)+(v as number);
   audit={...audit,calls:calls.length,held:calls.reduce((s,r)=>s+r.control.bytesHeld+r.budget.heldBytes,0),pending:calls.filter(r=>r.control.pendingDispatch).length,lookup:calls.filter(r=>r.control.lookupPresent).length,transportBytes:calls.reduce((s,r)=>s+r.ownedTransportBytes,0),unfinished:f.link.unfinished,finalChecks:calls.reduce((s,r)=>s+r.finalChecks,0),...metrics,elidedHashes:calls.reduce((s,r)=>s+r.binding.elidedHashes,0),handshakes:f.frames.filter(r=>r.kind==='client-hello').length,wireBytes:f.frames.reduce((s,r)=>s+r.inner+r.frame,0),loads:f.provider.metrics.loads,peakBytes:Math.max(0,...calls.map(r=>r.budget.peakBytes)),callWork:Math.max(0,...calls.map(r=>r.budget.work+r.budget.initialization)),callWire:Math.max(0,...calls.map(r=>r.budget.wire)),providerWork:Math.max(0,...f.provider.rows.map(r=>r.spent.work)),providerWire:Math.max(0,...f.provider.rows.map(r=>r.spent.wire)),clientWork:f.clientWork};need(audit.held===0&&audit.pending===0&&audit.lookup===0&&audit.transportBytes===0&&audit.unfinished===0,'owner_closed');}
  }catch(error){remember(error);}t.cleanupEnd=performance.now();try{const collected=observer?.finish();trace=collected?.base??null;profile=collected?.cost??null;}catch(error){remember(error);}finally{observer?.close();}t.end=performance.now();
 }
 const overDeadline=(options.realClock?Math.floor(t.end):rawClock())>=deadline;if(overDeadline&&!failure){phase='deadline';remember(new CurrentControlError('request_expired'));}
 const names=['start','observerReady','constructed','transferEnd','auditEnd','cleanupEnd','end'] as const,ds=['observerSetupMs','constructionMs','transferMs','auditMs','cleanupMs','observerFinishMs'];
 return {arm,observation,role:options.role??'reader',workload:options.workload??'small',round:options.round??0,clock:options.realClock?'real':'fixed',conditionsDigest:digest(LB3_CONDITIONS),approvalPin:approval.base.pin,bindingPin:approval.base.bindingPin,codePin:approval.base.codePin,profilingPin:approval.pin,contextManifest,startedAt,deadline,overDeadline,status:failure?'failed':'complete',failure,result,audit,planTiming,cleaned:audit.held===0&&audit.pending===0&&audit.unfinished===0&&audit.lookup===0&&audit.transportBytes===0,timeline:t,totalMs:t.end-t.start,...Object.fromEntries(ds.map((k,i)=>[k,t[names[i+1]!]!-t[names[i]!]!])),trace,profile,wireTtls,wireFrames};
}
export async function runCwcLb3p(rounds=3,workloads=LB3_WORKLOADS,{realClock=false}:{realClock?:boolean}={}){
 need(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=3,'configuration_invalid');const rows:any[]=[],approvals:any[]=[];
 for(const workload of workloads)for(const role of ['reader','authority-broker'] as const)for(let round=-1;round<rounds;round++){
  const approval=lb3pApprovalFixture();approvals.push({workload:workload.id,role,round,record:approval.view.base.record,profilingApproval:approval.view.record});
  // Rotate arm and observation order, while retaining every failed and warm-up trial.
  for(let j=0;j<3;j++)for(let i=0;i<3;i++){const arm=LB3_ARMS[(i+round+1)%3]!,observation=LB3_OBSERVATIONS[(j+round+1)%3]!;
   rows.push(await runLb3pAttempt(arm,observation,approval.view,{realClock,round,workload:workload.id,role,sizes:workload.sizes}));
  }
  if(realClock)console.log('CLB3P group',workload.id,role,round,rows.slice(-9).map(r=>r.arm+'/'+r.observation+':'+r.status+'/'+Math.round(r.totalMs)).join(' '));
 }
 if(process.env.CWC_LB3P_RAW_PATH)writeFileSync(process.env.CWC_LB3P_RAW_PATH,JSON.stringify({rows,approvals,rounds,workloads}));
 return {schema:'cwc-lb3p.measurement.v1',clock:realClock?'real':'fixed',rounds,workloads,approvals,rows,summary:summarizeLb3pBase(rows,rounds,workloads.map(w=>w.id),realClock?'real':'fixed'),profileSummary:summarizeLb3p(rows,rounds,workloads.map(w=>w.id),realClock?'real':'fixed')};
}
