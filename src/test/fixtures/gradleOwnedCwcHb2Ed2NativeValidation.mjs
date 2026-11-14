/** Strict diagnostic ED-1 recheck envelope. The baseline argument must already be source/hash verified. */
import {createHash} from 'node:crypto';
import {types,isDeepStrictEqual} from 'node:util';
import {ED1_IDS} from './gradleOwnedCwcHb2Ed1.mjs';
export const ED2_ED1_COMMAND=Object.freeze(['scripts/check-cwc-hb2-ed1.mjs','--check']);
const tools=['ps','vmmap','footprint','heap','leaks','prlimit','systemd-run','docker'];
const need=(v,r)=>{if(!v)throw Error('ed2_fresh_'+r);},sha=s=>createHash('sha256').update(s).digest('hex');
function data(v,depth=0,state={n:0}){need(depth<=24&&++state.n<=50000,'schema');if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'){need(Number.isFinite(v),'schema');return;}need(v&&typeof v==='object'&&!types.isProxy(v),'schema');need(Array.isArray(v)||Object.getPrototypeOf(v)===Object.prototype,'schema');for(const k of Reflect.ownKeys(v)){const d=Object.getOwnPropertyDescriptor(v,k);need(typeof k==='string'&&d&&'value'in d,'schema');if(k!=='length')data(d.value,depth+1,state);}}
const keys=(v,fields)=>v&&typeof v==='object'&&!Array.isArray(v)&&isDeepStrictEqual(Object.keys(v).sort(),[...fields].sort());
/** Derive the COMPLETE stdout schema from the pinned ED-1 baseline, never from the submitted summary. */
export function ed2ExpectedEd1Summary(baseline){
 data(baseline);need(baseline.schema==='cwc.hb2.ed1.record.v1'&&baseline.status==='diagnostic-feasibility-only','baseline');
 need(isDeepStrictEqual(baseline.regions?.map(r=>r.id),Array.from({length:18},(_,i)=>'HB'+String(i+1).padStart(2,'0')))&&isDeepStrictEqual(baseline.cases?.map(c=>c.probe.id),[...ED1_IDS]),'baseline');
 const v=baseline.verification;need(v?.success===true&&v.failed===0&&Number.isSafeInteger(v.passed)&&v.passed>0&&isDeepStrictEqual(v.ids,Array.from({length:v.passed},(_,i)=>'ED1T'+String(i+1).padStart(2,'0'))),'baseline');
 need(baseline.sourceBindings&&Object.getPrototypeOf(baseline.sourceBindings)===Object.prototype&&Object.keys(baseline.sourceBindings).length>0,'baseline');
 const t=baseline.cases.find(c=>c.probe.id==='tools').probe.data.tools;need(isDeepStrictEqual(t.map(x=>x.name),tools),'baseline');
 return {status:baseline.status,regions:baseline.regions.length,sourceBindings:Object.keys(baseline.sourceBindings).length,regressions:v.passed,freshProbes:[...ED1_IDS],independentBounds:0,credit:0,productionAdopted:false,toolResults:t.map(x=>({name:x.name,available:!!x.path,executed:x.execution!==null,success:x.execution?.status===0}))};
}
/** Hashes bind wire bytes only; semantic closure and command are checked separately first. */
export function validateEd2FreshEd1(f,baseline){
 data(f);need(keys(f,['command','exitCode','status','reason','stdoutBytes','stdoutDigest','stderrBytes','stderrDigest','summary','independentlyAttested']),'schema');
 need(isDeepStrictEqual(f.command,[...ED2_ED1_COMMAND]),'command');
 need(f.independentlyAttested===false&&[f.stdoutBytes,f.stderrBytes].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=8388608)&&/^[0-9a-f]{64}$/.test(f.stdoutDigest)&&/^[0-9a-f]{64}$/.test(f.stderrDigest),'schema');
 let raw;
 if(f.status==='same-domain-check-passed'){
  need(f.exitCode===0&&f.reason===null,'status');const expected=ed2ExpectedEd1Summary(baseline);need(isDeepStrictEqual(f.summary,expected),'summary');raw=JSON.stringify(f.summary)+'\n';
 }else{
  need(f.status==='permission-domain-mismatch-refused'&&f.exitCode===1&&f.reason==='ed1_tool_outcome_changed'&&f.summary===null&&f.stderrBytes>0,'status');raw='';
 }
 need(f.stdoutBytes===Buffer.byteLength(raw)&&f.stdoutDigest===sha(raw),'wire');return true;
}
