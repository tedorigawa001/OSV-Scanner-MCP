/** Diagnostic stack attribution only. Original operations and authority gates execute unchanged. */
import {siteKey} from './gradleOwnedCwcSiteValidation.mjs';
import {getCallSites} from 'node:util';
import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import * as json from '../../utils/gradleOwnedJson.js';
import * as schema from './gradleOwnedCprASchema.js';
import * as current from '../../utils/gradleOwnedCurrentSchema.js';
import * as source from '../../utils/gradleOwnedSourceSchema.js';
import {CwcAContract} from './gradleOwnedCwcA.js';
let busy=false;
export function installSiteObserver(){
 if(busy)throw Error('cwc_site_busy');busy=true;let active=false,stack:{child:number}[]=[],sites:Record<string,any>={};const restores:(()=>void)[]=[];
 const compiled=CwcAContract.toString(),body=compiled.slice(compiled.indexOf('#checkOwner() {'),compiled.indexOf('\n\t#gate('));
 if((body.match(/ownedDigest/g)??[]).length!==2||!body.includes('copy(this.#current())')||body.indexOf('(current.context)')<0||body.indexOf('(current.context)')>=body.lastIndexOf('(this.#c)')){busy=false;throw Error('cwc_site_runtime_unsupported');}
 const artifact={ownerAnchor:undefined as undefined|{file:string;fn:string;line:number;column:number},classText:compiled,node:process.version,classSha256:createHash('sha256').update(compiled).digest('hex'),ownerCheckBody:body};
 function observe<T>(operation:string,run:()=>T):T{
  if(!active)return run();const start=performance.now();
  const frames=getCallSites(10,{sourceMap:false}).filter(f=>f.scriptName.includes('/src/')&&!f.scriptName.includes('gradleOwnedCwcSiteProfile.ts')).map(f=>({file:f.scriptName.slice(f.scriptName.indexOf('/src/')+1),fn:f.functionName,line:f.lineNumber,column:f.columnNumber}));
  const caller=frames[0];if(!caller)throw Error('cwc_site_caller_missing');
  const ci=frames.findIndex(f=>f.file.endsWith('/gradleOwnedCwcA.ts')&&f.fn==='CwcAContract');if(ci>=0&&frames.slice(0,ci).some(f=>f.file.endsWith('/gradleOwnedCwcA.ts')&&f.fn==='preflightCodecProfile')){const anchor=frames[ci]!;if(artifact.ownerAnchor&&JSON.stringify(artifact.ownerAnchor)!==JSON.stringify(anchor))throw Error('cwc_site_anchor_changed');artifact.ownerAnchor={...anchor};}
  const key=siteKey(operation,frames);
  if(!sites[key]){if(Object.keys(sites).length>=512)throw Error('cwc_site_capacity');sites[key]={operation,caller,frames,calls:0,inclusiveMs:0,exclusiveMs:0};}
  const frame={child:0};stack.push(frame);try{return run();}finally{const elapsed=performance.now()-start;stack.pop();const b=sites[key];b.calls++;b.inclusiveMs+=elapsed;b.exclusiveMs+=elapsed-frame.child;if(stack.length)stack.at(-1)!.child+=elapsed;}
 }
 function spy(module:any,name:string){const original=module[name],s=vi.spyOn(module,name);s.mockImplementation((...args:any[])=>{try{return observe(name,()=>Reflect.apply(original,module,args));}finally{s.mockClear();}});restores.push(()=>s.mockRestore());}
 try{for(const n of ['canonicalOwnedJson','ownedDigest','ownedSha256'])spy(json,n);for(const n of ['context','command','checkCommand','validatePlanCore'])spy(schema,n);spy(current,'parsed');for(const n of ['sourceInventory','inventoryBytes','canonicalBase64'])spy(source,n);
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'structuredClone')!,original=globalThis.structuredClone;Object.defineProperty(globalThis,'structuredClone',{...descriptor,value:(...args:Parameters<typeof structuredClone>)=>observe('structuredClone',()=>original(...args))});restores.push(()=>Object.defineProperty(globalThis,'structuredClone',descriptor));
 }catch(e){for(const restore of restores.reverse())restore();busy=false;throw e;}
 let closed=false;
 // Per-call observer cost: the same observe() path (getCallSites, siteKey, bookkeeping) around a no-op.
 // Runs outside any measured transfer and writes to a throwaway site table.
 function calibrate(calls:number){if(closed||active)throw Error('cwc_site_closed_or_busy');if(!Number.isSafeInteger(calls)||calls<1||calls>100000)throw Error('cwc_site_calibration');const keep=sites,keepStack=stack;sites={};stack=[];active=true;const start=performance.now();try{for(let i=0;i<calls;i++)observe('calibration',()=>undefined);}finally{active=false;}const wallMs=performance.now()-start;sites=keep;stack=keepStack;return {calls,wallMs,perCallMs:wallMs/calls};}
 return {artifact,calibrate,
  async measure<T>(run:()=>Promise<T>){if(closed||active)throw Error('cwc_site_closed_or_busy');active=true;sites={};stack=[];let result:T|undefined,error:unknown,ok=false;const start=performance.now();try{result=await run();ok=true;}catch(e){error=e;}finally{active=false;}const wallMs=performance.now()-start;return {ok,result,error,trace:{wallMs,otherMs:wallMs-Object.values(sites).reduce((n,b)=>n+b.exclusiveMs,0),sites}};},
  close(){if(active)throw Error('cwc_site_busy');if(closed)return;closed=true;for(const r of restores.reverse())r();busy=false;}
 };
}
