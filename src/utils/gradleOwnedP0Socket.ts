/** One bounded length-prefixed request/reply per Unix socket; no executable or artifact transfer. */
import {createConnection} from 'node:net';
import {lstat,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
export const P0_FRAME_MAX=1048576;
export function p0Frame(bytes:Buffer){if(bytes.length>P0_FRAME_MAX)throw Error('backend-frame-budget');const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return Buffer.concat([header,bytes]);}
/** Incremental collector never accumulates a second frame or allocates an unchecked advertised length. */
export class P0FrameReader{
 #header=Buffer.alloc(4);#headerUsed=0;#body:Buffer|null=null;#used=0;
 push(chunk:Buffer){
  if(this.#headerUsed<4){const n=Math.min(4-this.#headerUsed,chunk.length);chunk.copy(this.#header,this.#headerUsed,0,n);this.#headerUsed+=n;chunk=chunk.subarray(n);
   if(this.#headerUsed===4){const size=this.#header.readUInt32BE();if(size===0||size>P0_FRAME_MAX)throw Error('backend-frame-budget');this.#body=Buffer.alloc(size);}}
  if(chunk.length){if(!this.#body||chunk.length>this.#body.length-this.#used)throw Error('backend-extra-frame');chunk.copy(this.#body,this.#used);this.#used+=chunk.length;}
 }
 finish(){if(!this.#body||this.#used!==this.#body.length)throw Error('backend-truncated-frame');return this.#body;}
}
export async function p0UnixExchange(socketPath:string,request:Buffer,timeoutMs:number,signal:AbortSignal):Promise<Buffer>{
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>5000)throw Error('backend-timeout');
 if(signal.aborted)throw Error('backend-closed');
 const a=await lstat(socketPath);if(!a.isSocket()||a.isSymbolicLink()||await realpath(socketPath)!==resolve(socketPath))throw Error('backend-socket-invalid');
 if(signal.aborted)throw Error('backend-closed');
 return new Promise((accept,reject)=>{
  const reader=new P0FrameReader(),socket=createConnection({path:socketPath});let done=false;
  const end=(error?:unknown,value?:Buffer)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',aborted);socket.destroy();error?reject(error):accept(value!);};
  const aborted=()=>end(Error('backend-closed'));
  const timer=setTimeout(()=>end(Error('backend-timeout')),timeoutMs);signal.addEventListener('abort',aborted,{once:true});
  socket.on('error',end);socket.on('connect',()=>{if(signal.aborted)return aborted();socket.write(p0Frame(request));socket.end();});
  socket.on('data',chunk=>{try{if(!Buffer.isBuffer(chunk))throw Error('backend-frame-invalid');reader.push(chunk);}catch(e){end(e);}});
  socket.on('end',()=>{try{end(undefined,reader.finish());}catch(e){end(e);}});
  socket.on('close',()=>{if(!done)end(Error('backend-closed'));});
 });
}
