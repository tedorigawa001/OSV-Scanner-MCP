/** Operator entry point: metadata preflight only; never installs or executes submitted tools. */
import {open,realpath,lstat} from 'node:fs/promises';
import {constants,type BigIntStats} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPrivateKey} from 'node:crypto';
import {connectP0Backend} from '../utils/gradleOwnedP0Backend.js';
import {runP0Preflight,p0RunnerResultSchema} from '../utils/gradleOwnedP0Runner.js';
async function boundedFile(path:string,max:number,secret=false){
 if(!path.startsWith('/')||await realpath(path)!==resolve(path))throw Error('operator-file-path-invalid');
 const valid=(s:BigIntStats)=>{
  if(!s.isFile()||s.size<=0n||s.size>BigInt(max)||(s.mode&0o022n)!==0n||secret&&((s.mode&0o077n)!==0n||!process.getuid||s.uid!==BigInt(process.getuid())))throw Error('operator-file-permissions-invalid');
 };
 const same=(a:BigIntStats,b:BigIntStats)=>['dev','ino','size','mode','uid','gid','nlink','mtimeNs','ctimeNs'].every(k=>a[k as keyof BigIntStats]===b[k as keyof BigIntStats]);
 const expected=await lstat(path,{bigint:true});valid(expected);
 // NONBLOCK also protects a regular-file -> FIFO race between lstat and open.
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let bytes:Buffer|undefined,returned=false;
 const currentPath=async(s:BigIntStats)=>{
  const named=await lstat(path,{bigint:true});
  if(!same(s,named)||await realpath(path)!==resolve(path))throw Error('operator-file-path-changed');
 };
 try{
  const s=await f.stat({bigint:true});valid(s);if(!same(expected,s))throw Error('operator-file-changed');await currentPath(s);
  const size=Number(s.size);bytes=Buffer.alloc(size+1);const n=await f.read(bytes,0,bytes.length,0);const after=await f.stat({bigint:true});
  if(n.bytesRead!==size||!same(s,after))throw Error('operator-file-changed');await currentPath(after);
  returned=true;return bytes.subarray(0,size);
 }finally{
  if(secret&&!returned)bytes?.fill(0);
  try{await f.close();}catch(e){if(secret)bytes?.fill(0);throw e;}
 }
}
export async function runP0Cli(args:readonly string[]){
 const options=new Map<string,string>();
 try{
  if(args.length===0)return await runP0Preflight(null,'0'.repeat(64));
  if(args.length!==6)throw Error('operator-arguments-invalid');
  for(let i=0;i<args.length;i+=2){const k=args[i]!,v=args[i+1]!;if(!['--config','--key','--job'].includes(k)||options.has(k)||!v)throw Error('operator-arguments-invalid');options.set(k,v);}
  if(!/^[a-f0-9]{64}$/.test(options.get('--job')!))throw Error('operator-job-invalid');
  const config=new TextDecoder('utf-8',{fatal:true}).decode(await boundedFile(options.get('--config')!,65536));
  const keyBytes=await boundedFile(options.get('--key')!,4096,true);
  try{return await runP0Preflight(connectP0Backend(config,createPrivateKey(keyBytes)),options.get('--job')!);}finally{keyBytes.fill(0);}
 }catch{
  return p0RunnerResultSchema.parse({schema:'cwc.e2-p0.runner-result.v1',status:'invalid',reasons:['operator-configuration-invalid'],calls:0,wireBytes:0,
   staticMetadataVerified:false,jobPermitIssued:false,runtimeAdmitted:false,candidateOperations:{reads:0,copies:0,execs:0,publications:0}});
 }
}
const invoked=process.argv[1]?await realpath(resolve(process.argv[1])).catch(()=>null):null;
if(invoked&&import.meta.url===pathToFileURL(invoked).href){
 const result=await runP0Cli(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.status==='unsupported'?2:3;
}
