/** Test-only preload. Never imported by the shipped CLI/backend or selected by a submitted packet. */
import fs from 'node:fs/promises';
import {constants,existsSync,appendFileSync,renameSync,copyFileSync,chmodSync,symlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {performance} from 'node:perf_hooks';
const mode=process.env.P0_TEST_FAULT,target=process.env.P0_TEST_TARGET,trace=process.env.P0_TEST_TRACE,marker=process.env.P0_TEST_MARKER;
let notes=0;
const note=(event,extra={})=>{if(trace&&notes++<64)appendFileSync(trace,JSON.stringify({event,...extra})+'\n');};
if(mode?.startsWith('final-')){
 const original=globalThis.AbortController,controllers=[];
 globalThis.AbortController=class extends original{constructor(){super();if(controllers.length>=8)throw Error('fault-controller-budget');controllers.push(this);}};
 let ticks=0;
 Object.defineProperty(performance,'now',{value:()=>{
  if(!marker||!existsSync(marker))return 0;
  ticks++;let now=4999;
  if(ticks>=3){if(mode==='final-expiry')now=5000;else for(const controller of controllers)controller.abort();}
  note('clock',{ticks,now});return now;
 }});
}else if(mode&&target){
 const originalOpen=fs.open;let changed=false;
 const replace=()=>{
  if(changed)return;changed=true;
  if(mode==='before-open-parent-symlink'){const parent=dirname(target);renameSync(parent,parent+'.old');symlinkSync(parent+'.old',parent,'dir');}
  else{renameSync(target,target+'.old');if(mode==='before-open-fifo')execFileSync('/usr/bin/mkfifo',[target],{stdio:'ignore'});else{copyFileSync(target+'.old',target);chmodSync(target,0o600);}}
  note('path-replaced');
 };
 fs.open=async function(path,flags,...rest){
  if(String(path)!==target)return originalOpen.call(this,path,flags,...rest);
  note('target-open',{nonblock:typeof flags==='number'&&Boolean(flags&constants.O_NONBLOCK)});
  if(mode.startsWith('before-open-'))replace();
  const handle=await originalOpen.call(this,path,flags,...rest);
  if(mode==='after-open-file')replace();
  const read=handle.read.bind(handle),close=handle.close.bind(handle);let captured=null;
  handle.read=async function(...args){note('target-read');captured=Buffer.isBuffer(args[0])?args[0]:null;const result=await read(...args);if(mode==='after-read-file')replace();return result;};
  handle.close=async function(){if(captured)note('target-buffer-at-close',{zero:captured.every(b=>b===0)});return close();};
  return handle;
 };
 syncBuiltinESMExports();
}
