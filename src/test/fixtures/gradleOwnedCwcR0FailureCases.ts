/** Reproducible review regressions, outside the owned command path and its representation budget. */
import {r0Fixture} from './gradleOwnedCwcR0Fixture.js';
import {R0Tokens} from './gradleOwnedCwcR0Tokens.js';
import {R0_COMMAND} from './gradleOwnedCwcR0Grammar.js';
import {canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
export const R0_EXCEPTION_FAULTS=['message-getter','to-string','to-primitive'] as const;
export const R0_PARSER_FAULTS=['oversize','length-overrun','offset','source-type'] as const;
export function r0ExceptionFailure(kind:'provider'|'client',fault:typeof R0_EXCEPTION_FAULTS[number]){
 let diagnosticCalls=0;const secondary=new Error('diagnostic failure');const thrown:unknown=fault==='message-getter'?Object.defineProperty(new Error('callback failure'),'message',{get(){diagnosticCalls++;throw secondary;}}):fault==='to-string'?{toString(){diagnosticCalls++;throw secondary;}}:{[Symbol.toPrimitive](){diagnosticCalls++;throw secondary;}};
 const f=r0Fixture({kind,hook:site=>{if(site==='compare-after')throw thrown;}}),h=f.owner.open(f.owner.claim(kind==='provider'?'provider':'client-initial'));
 try{for(let i=0;i<f.commands.length;i++)f.owner.capture(h);const prepaid=f.budget.stats();let caught:unknown;
  try{f.owner.process(h);}catch(e){caught=e;}
  const s=f.owner.stats();let lateHandleRefused=false;try{f.owner.coreHandle(h);}catch{lateHandleRefused=true;}
  f.owner.close();const once=f.owner.stats();f.owner.close();const twice=f.owner.stats();
  return {type:'owner',kind,fault,originalRethrown:caught===thrown,diagnosticCalls,alive:s.alive,lookup:s.lookup,released:s.released,compared:s.compared,publications:s.publications,proofs:s.proofs,slots:s.slotLive,frames:s.liveFrames,buffers:s.liveBuffers,nativeViews:s.nativeViewLive,sinkActive:s.sinkActive,zeroVerified:s.zeroVerified,heldBytes:s.budget.heldBytes,work:s.budget.work,initialization:s.budget.initialization,prepaidWork:prepaid.work,prepaidInitialization:prepaid.initialization,lateHandleRefused,oneRelease:once.clearedBytes===twice.clearedBytes&&once.budget.heldBytes===0&&twice.budget.heldBytes===0};
 }finally{f.owner.close();}
}
export function r0ParserFailure(fault:typeof R0_PARSER_FAULTS[number]){
 const f=r0Fixture(),table=Buffer.alloc(8192),p=new R0Tokens(table),source=Buffer.from(canonical(f.commands[0]));
 try{p.parse(source,source.length,R0_COMMAND);const token=p.field(p.field(0,'payload'),'byteBudget'),at=p.start(token),prior=p.count,previousSourceBound=p.sourceBound;
  let refused=false;try{if(fault==='oversize')p.parse(Buffer.alloc(65536),65536,R0_COMMAND);else if(fault==='length-overrun')p.parse(source,source.length+1,R0_COMMAND);else if(fault==='offset')p.parse(source,source.length,R0_COMMAND,-1);else p.parse(null as any,1,R0_COMMAND);}catch{refused=true;}
  source[at]=57;let oldReadable=false;try{p.number(token);oldReadable=true;}catch{}
  const tokensAfter=p.count,sourceBound=p.sourceBound,frames=p.metrics.frames,tableZero=table.every(b=>b===0);
  const fresh=Buffer.from(canonical(f.commands[0]));p.parse(fresh,fresh.length,R0_COMMAND);const reusable=p.sourceBound&&p.number(p.field(p.field(0,'payload'),'byteBudget'))===f.commands[0]!.payload.byteBudget;
  return {type:'parser',fault,prior,previousSourceBound,refused,tokensAfter,sourceBound,frames,tableZero,oldReadable,reusable};
 }finally{p.clear();f.owner.close();}
}
export function r0FailureCases(){return {schema:'cwc-r0.review-regressions.v1',rows:[...(['provider','client'] as const).flatMap(kind=>R0_EXCEPTION_FAULTS.map(fault=>r0ExceptionFailure(kind,fault))),...R0_PARSER_FAULTS.map(r0ParserFailure)]};}
