/** Reproducible ED-1 diagnostics in disposable children; no network, debugger listener or privilege change. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ED1_IDS,ED1_FLAGS,ED1_LIMITS,validateEd1Probes} from '../src/test/fixtures/gradleOwnedCwcHb2Ed1.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateEd1Execution(p,e){
 if(e.exitCode!==0||e.signal!==null||e.error!==null||!Number.isFinite(e.wallMs)||e.wallMs<p.totalMs||e.wallMs>ED1_LIMITS.childMs+2000)throw Error('ed1_execution');
 const raw=JSON.stringify(p)+'\n';if(e.stdoutBytes!==Buffer.byteLength(raw)||e.stdoutDigest!==sha(raw)||!Number.isSafeInteger(e.stderrBytes)||e.stderrBytes<0||e.stderrBytes>ED1_LIMITS.stderrBytes||e.stdoutBytes>ED1_LIMITS.stdoutBytes||!/^[0-9a-f]{64}$/.test(e.stderrDigest))throw Error('ed1_output');
 return true;
}
async function child(id){return await new Promise((resolve,reject)=>{
 const begin=performance.now(),p=spawn(process.execPath,[...ED1_FLAGS,'scripts/probe-cwc-hb2-ed1.mjs',id],{stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}}),out=[],err=[];let ob=0,eb=0,reason=null;
 const stop=r=>{reason??=r;p.kill('SIGKILL');},timer=setTimeout(()=>stop('timeout'),ED1_LIMITS.childMs);
 p.on('error',e=>{reason='spawn:'+e.code;});p.stdout.on('data',b=>{ob+=b.length;if(ob>ED1_LIMITS.stdoutBytes)stop('stdout-cap');else out.push(b);});p.stderr.on('data',b=>{eb+=b.length;if(eb>ED1_LIMITS.stderrBytes)stop('stderr-cap');else err.push(b);});
 p.on('close',(exitCode,signal)=>{clearTimeout(timer);try{if(reason||exitCode!==0||signal)throw Error('ed1_child_'+id+' '+(reason??signal??exitCode)+' '+Buffer.concat(err).toString().slice(0,500));const raw=Buffer.concat(out),probe=JSON.parse(raw),execution={exitCode,signal,error:reason,wallMs:performance.now()-begin,stdoutBytes:ob,stderrBytes:eb,stdoutDigest:sha(raw),stderrDigest:sha(Buffer.concat(err))};validateEd1Execution(probe,execution);resolve({probe,execution});}catch(e){reject(e);}});
 });}
export async function collectEd1(runtime,approval){const cases=[];for(const id of ED1_IDS)cases.push(await child(id));validateEd1Probes(cases.map(x=>x.probe),runtime,approval);return cases;}
