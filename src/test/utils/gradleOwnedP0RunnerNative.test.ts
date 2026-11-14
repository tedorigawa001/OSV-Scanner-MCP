/** Native Unix IPC and a separate CLI process; synthetic authorities, same UID, no real tool images. */
import {beforeAll,afterAll,expect,test} from 'vitest';
import {createServer,type Server} from 'node:net';
import {mkdtemp,realpath,rm,writeFile,chmod,symlink,mkdir,readFile,rename} from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {writeFileSync} from 'node:fs';
import {p0BackendFixture} from '../fixtures/gradleOwnedP0BackendFixture.js';
import {connectP0Backend,closeP0Backend} from '../../utils/gradleOwnedP0Backend.js';
import {P0FrameReader,p0Frame,P0_FRAME_MAX} from '../../utils/gradleOwnedP0Socket.js';
import {runP0Preflight} from '../../utils/gradleOwnedP0Runner.js';
const faultPreload=resolve('src/test/fixtures/gradleOwnedP0CliFault.mjs');
let dir:string,cli:string;
beforeAll(async()=>{
 dir=await mkdtemp((await realpath('/tmp'))+'/p0-native-');
 const out=dir+'/build';execFileSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.build.json','--outDir',out],{stdio:'pipe',timeout:120000});
 // An emitted ESM tree outside this package needs its own type marker and dependency resolution.
 await writeFile(out+'/package.json',JSON.stringify({type:'module'}));await symlink(resolve('node_modules'),out+'/node_modules','dir');cli=out+'/cli/e2P0Preflight.js';
},120000);
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});
async function services(mode:'normal'|'oversize'='normal'){
 const f=p0BackendFixture(),servers:Server[]=[];const sockets=new Set<import('node:net').Socket>();
 for(const role of ['registry','custodian','controller'] as const){
  const path=dir+'/'+role+'-'+Math.random().toString(16).slice(2)+'.sock';f.config.peers[role].socket=path;
  const server=createServer({allowHalfOpen:true},socket=>{
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});const reader=new P0FrameReader();
   socket.on('data',chunk=>{try{if(!Buffer.isBuffer(chunk))throw Error();reader.push(chunk);}catch{socket.destroy();}});
   socket.on('end',()=>{void (async()=>{try{
    const request=reader.finish();if(mode==='oversize'){const h=Buffer.alloc(4);h.writeUInt32BE(P0_FRAME_MAX+1);socket.end(h);return;}
    socket.end(p0Frame(await f.servers[role].respond(request)));
   }catch{socket.destroy();}})();});
  });servers.push(server);await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen(path,accept);});
 }
 return {f,close:async()=>{for(const s of sockets)s.destroy();for(const server of servers)await new Promise<void>(r=>server.close(()=>r()));}};
}
async function execute(args:string[],options:{preload?:boolean;env?:Record<string,string>;timeoutMs?:number}={}){
 return new Promise<{status:number|null;stdout:string;stderr:string}>((accept,reject)=>{
  const child=spawn(process.execPath,[...(options.preload?['--import',faultPreload]:[]),cli,...args],{stdio:['ignore','pipe','pipe'],env:{...process.env,...options.env}});let stdout='',stderr='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('native-cli-timeout'));},options.timeoutMs??10000);
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>65536)child.kill('SIGKILL');});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>65536)child.kill('SIGKILL');});
  child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',status=>{clearTimeout(timer);accept({status,stdout,stderr});});
 });
}
async function operatorFiles(f:ReturnType<typeof p0BackendFixture>){
 const prefix=dir+'/operator-'+Math.random().toString(16).slice(2),config=prefix+'.json',key=prefix+'.pem';
 await writeFile(config,JSON.stringify(f.config),{mode:0o600});await writeFile(key,f.keys.client.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
 return {config,key,args:['--config',config,'--key',key,'--job',f.jobDigest]};
}

test('P0N01 native Unix sockets authenticate all three synthetic owners without issuing a permit',async()=>{
 const {f,close}=await services();try{
  const client=connectP0Backend(JSON.stringify(f.config),f.keys.client.privateKey),r=await runP0Preflight(client,f.jobDigest);
  expect(r).toMatchObject({status:'unsupported',calls:5,staticMetadataVerified:true,jobPermitIssued:false});expect(f.calls).toHaveLength(5);
 }finally{await close();}
});

test('P0N02 missing socket is unsupported and does not fetch candidate artifacts',async()=>{
 const f=p0BackendFixture();const r=await runP0Preflight(connectP0Backend(JSON.stringify(f.config),f.keys.client.privateKey),f.jobDigest);
 expect(r.status).toBe('unsupported');expect(r.candidateOperations).toEqual({reads:0,copies:0,execs:0,publications:0});expect(f.calls).toHaveLength(0);
});

test('P0N03 oversized advertised frame is rejected over an actual socket',async()=>{
 const {f,close}=await services('oversize');try{const r=await runP0Preflight(connectP0Backend(JSON.stringify(f.config),f.keys.client.privateKey),f.jobDigest);
  expect(r.status).toBe('unsupported');expect(r.staticMetadataVerified).toBe(false);expect(f.calls).toHaveLength(0);
 }finally{await close();}
});

test('P0N04 CLI without deployed backend reports unsupported with exit 2',async()=>{
 const r=await execute([]);expect(r.status).toBe(2);expect(r.stderr).toBe('');expect(JSON.parse(r.stdout)).toMatchObject({status:'unsupported',calls:0,jobPermitIssued:false});
});

test('P0N05 separate CLI process connects to signed services but remains unsupported without enforcement evidence',async()=>{
 const {f,close}=await services();try{const files=await operatorFiles(f),r=await execute(files.args);
  expect(r.status).toBe(2);expect(r.stderr).toBe('');expect(JSON.parse(r.stdout)).toMatchObject({status:'unsupported',calls:5,staticMetadataVerified:true,jobPermitIssued:false});
  expect(r.stdout).not.toContain('PRIVATE KEY');
 }finally{await close();}
});

test.each(['symlink','permissions'] as const)('P0N06 operator key %s fails before service IO',async kind=>{
 const {f,close}=await services();try{const files=await operatorFiles(f);
  if(kind==='permissions')await chmod(files.key,0o644);else{const link=files.key+'.link';await symlink(files.key,link);files.args[3]=link;}
  const r=await execute(files.args);expect(r.status).toBe(3);expect(JSON.parse(r.stdout)).toMatchObject({status:'invalid',calls:0,jobPermitIssued:false});expect(f.calls).toHaveLength(0);
 }finally{await close();}
});

test('P0N07 injected CLI options are not passed to an executable or shell',async()=>{
 const r=await execute(['--config','/does-not-exist','--key','/does-not-exist','--job','a'.repeat(64),'--exec','touch /tmp/p0-unwanted']);
 expect(r.status).toBe(3);expect(JSON.parse(r.stdout)).toMatchObject({status:'invalid',calls:0,jobPermitIssued:false});
});

test('P0N08 CLI path aliases still execute preflight and return unsupported exit 2',async()=>{
 const alias=cli+'.alias.js';await symlink(cli,alias);
 const r=await new Promise<{status:number|null;stdout:string}>((accept,reject)=>{
  const child=spawn(process.execPath,[alias],{stdio:['ignore','pipe','pipe']});let stdout='';child.stdout.on('data',b=>{stdout+=b;});child.once('error',reject);child.once('close',status=>accept({status,stdout}));
 });expect(r.status).toBe(2);expect(JSON.parse(r.stdout)).toMatchObject({status:'unsupported',jobPermitIssued:false});
});

test.each(['deadline','close'] as const)('P0N09 actual socket final-validation %s cannot mark metadata verified',async fault=>{
 const {f,close}=await services();let reads=0,armed=false,ticks=0,now=0;let client:ReturnType<typeof connectP0Backend>;
 f.onLookup(api=>{if(api==='ReadLive'&&++reads===2)armed=true;});
 try{
  client=connectP0Backend(JSON.stringify(f.config),f.keys.client.privateKey,{now:()=>{
   if(armed&&++ticks>=3){if(fault==='deadline')now=5000;else closeP0Backend(client);}return now;
  }});
  const r=await runP0Preflight(client,f.jobDigest);expect(r).toMatchObject({status:'revoked-or-expired',staticMetadataVerified:false,calls:5,jobPermitIssued:false});
 }finally{await close();}
});

const fileRoles=['config','key'] as const;
test.each(fileRoles.flatMap(role=>(['fifo','directory','socket'] as const).map(kind=>({role,kind}))))('P0N10 CLI $role $kind is refused without waiting for another process',async({role,kind})=>{
 const {f,close}=await services();let extra:Server|undefined;
 try{const files=await operatorFiles(f),target=files[role];await rm(target);
  if(kind==='fifo')execFileSync('/usr/bin/mkfifo',[target]);
  if(kind==='directory')await mkdir(target,{mode:0o700});
  if(kind==='socket'){extra=createServer();await new Promise<void>((accept,reject)=>{extra!.once('error',reject);extra!.listen(target,accept);});}
  const r=await execute(files.args,{timeoutMs:2000});expect(r.status).toBe(3);expect(JSON.parse(r.stdout)).toMatchObject({status:'invalid',calls:0,staticMetadataVerified:false,jobPermitIssued:false});expect(f.calls).toHaveLength(0);
 }finally{if(extra)await new Promise<void>(r=>extra!.close(()=>r()));await close();}
});

const replacementFaults=['before-open-file','after-open-file','before-open-fifo','before-open-parent-symlink','after-read-file'] as const;
test.each(fileRoles.flatMap(role=>replacementFaults.map(fault=>({role,fault}))))('P0N11 CLI $role $fault refuses path substitution before backend IO',async({role,fault})=>{
 const {f,close}=await services();try{
  const files=await operatorFiles(f),parent=dir+'/target-'+Math.random().toString(16).slice(2);await mkdir(parent,{mode:0o700});
  const target=parent+'/input';await rename(files[role],target);files.args[role==='config'?1:3]=target;
  const trace=dir+'/trace-'+Math.random().toString(16).slice(2)+'.jsonl';
  const r=await execute(files.args,{preload:true,timeoutMs:2500,env:{P0_TEST_FAULT:fault,P0_TEST_TARGET:target,P0_TEST_TRACE:trace}});
  expect(r.status).toBe(3);expect(JSON.parse(r.stdout)).toMatchObject({status:'invalid',calls:0,jobPermitIssued:false});expect(f.calls).toHaveLength(0);
  const events=(await readFile(trace,'utf8')).trim().split('\n').map(s=>JSON.parse(s));expect(events.some(e=>e.event==='path-replaced')).toBe(true);
  expect(events.filter(e=>e.event==='target-read')).toHaveLength(fault==='after-read-file'?1:0);
  if(fault==='after-read-file')expect(events.find(e=>e.event==='target-buffer-at-close')?.zero).toBe(role==='key');
 }finally{await close();}
});

test.each(['final-expiry','final-close'] as const)('P0N12 separate CLI process rejects %s during final verification',async mode=>{
 const {f,close}=await services();try{
  const files=await operatorFiles(f),marker=dir+'/clock-'+Math.random().toString(16).slice(2),trace=marker+'.jsonl';let reads=0;
  f.onLookup(api=>{if(api==='ReadLive'&&++reads===2)writeFileSync(marker,'armed');});
  const r=await execute(files.args,{preload:true,env:{P0_TEST_FAULT:mode,P0_TEST_MARKER:marker,P0_TEST_TRACE:trace}});
  expect(r.status).toBe(3);expect(JSON.parse(r.stdout)).toMatchObject({status:'revoked-or-expired',staticMetadataVerified:false,jobPermitIssued:false,calls:5});
  const events=(await readFile(trace,'utf8')).trim().split('\n').map(s=>JSON.parse(s));expect(events.some(e=>e.event==='clock'&&e.ticks>=3)).toBe(true);
 }finally{await close();}
});
