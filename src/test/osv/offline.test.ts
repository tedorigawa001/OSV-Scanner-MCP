import {it,expect,afterEach,vi} from 'vitest';
import {offlineConfig} from '../../osv/offline.js';
import {prepareOfflineDatabases,captureOfflineDatabases,OFFLINE_LIMITS} from '../../osv/offlineCache.js';
import {mkdtemp,realpath,rm,readFile,writeFile,readdir,chmod,symlink,mkdir} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {fetchOsvRecord,queryOsvPackageVersion} from '../../osv/osvApi.js';
import {buildOsvScanArgs,isRemoteResolutionDisabled,runOsvScan,runOsvSbomScan,runOsvArtifactScan} from '../../osv/runner.js';
import {ensureOsvScannerDownloaded,PINNED_OSV_SCANNER_VERSION} from '../../osv/binaryDownloader.js';
import {resolveOsvScannerBinary} from '../../osv/binaryManager.js';
import {handleSuggestFix} from '../../tools/suggestFix.js';
import {handleExplainVulnerability} from '../../tools/explainVulnerability.js';
vi.mock('node:fs/promises', async original => {
 const actual=await original<typeof import('node:fs/promises')>();
 return {...actual,open:vi.fn(actual.open)};
});
const actualFs=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots:string[]=[];afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();vi.mocked(fs.open).mockImplementation(actualFs.open);for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function root(){const d=await realpath(await mkdtemp(path.join(os.tmpdir(),'offline-tests-')));roots.push(d);return d;}
// Transport fixture, deliberately not a real vulnerability DB; real ZIP parsing is exercised by the native harness.
const zip=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('bounded cache transport fixture')]);
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const fetchZIP=vi.fn(async()=>new Response(zip));
async function cache(){const dir=await root();await prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:fetchZIP as typeof fetch});return dir;}
it('offline settings reject invalid values and cannot enable remote resolution',()=>{
 expect(offlineConfig({},{}).enabled).toBe(false);
 expect(offlineConfig({}, {OSV_MCP_OFFLINE:'1'}).enabled).toBe(true);
 expect(offlineConfig({}, {OSV_MCP_OFFLINE:'1',XDG_CACHE_HOME:path.resolve('test-cache')}).dir).toBe(path.join(path.resolve('test-cache'),'osv-scanner-mcp','offline'));
 expect(()=>offlineConfig({}, {OSV_MCP_OFFLINE:'sometimes'})).toThrow();
 expect(()=>offlineConfig({}, {OSV_MCP_OFFLINE:'1',OSV_MCP_OFFLINE_DB_DIR:'relative'})).toThrow();
});
it.each(['0','false','no',''])('offline=%s remains online by default',value=>expect(offlineConfig({},{OSV_MCP_OFFLINE:value}).enabled).toBe(false));
it.each(['1','true','yes'])('offline=%s overrides an internal false setting',value=>expect(offlineConfig({offline:false},{OSV_MCP_OFFLINE:value}).enabled).toBe(true));
it.each(['0','721','abc','1.5'])('rejects invalid offline max age %s',v=>expect(()=>offlineConfig({},{OSV_MCP_OFFLINE:'1',OSV_MCP_OFFLINE_MAX_AGE_HOURS:v})).toThrow());
it.each(['project','artifact','sbom'] as const)('every %s invocation uses full offline and never enables database download',mode=>{
 const args=buildOsvScanArgs(mode,false,true);expect(args).toContain('--offline');expect(args).toContain('--no-resolve');expect(args).not.toContain('--offline-vulnerabilities');expect(args).not.toContain('--download-offline-databases');expect(isRemoteResolutionDisabled({offline:true,noRemoteResolution:false})).toBe(true);
});
it('publishes immutable DB objects and captures verified private bytes with cleanup',async()=>{
 const dir=await cache(),manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')),object=path.join(dir,'objects',manifest.databases[0].sha256+'.zip');
 expect(await readFile(object)).toEqual(zip);const s=await captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm']);
 expect(s.dir).not.toBe(dir);expect(await readFile(path.join(s.dir,'osv-scalibr/npm/all.zip'))).toEqual(zip);expect(s.metadata.network_requests).toBe(false);
 await writeFile(object,'changed');expect(await readFile(path.join(s.dir,'osv-scalibr/npm/all.zip'))).toEqual(zip);await s.cleanup();await expect(readdir(s.dir)).rejects.toThrow();
});
it.each(['valid','changed tail','shorter','longer','read failure'] as const)(
 'reuses one hash read buffer and checks the private ZIP after copying (%s)',async mode=>{
  const dir=await root(),payload=Buffer.alloc(2*64*1024+17,0x5a);
  zip.copy(payload);payload[payload.length-1]=0x11;
  await prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:async()=>new Response(payload)});
  const buffers=new Set<ArrayBufferLike>(),closed=vi.fn();
  let reads=0,privateZip:string|undefined;
  vi.mocked(fs.open).mockImplementation(async (file,flags,perms)=>{
   if(flags!=='r'||typeof file!=='string'||path.basename(file)!=='all.zip')return actualFs.open(file,flags,perms);
   privateZip=file;
   if(mode==='changed tail'){
    const altered=Buffer.from(payload);altered[altered.length-1]=altered.at(-1)!^0xff;await writeFile(file,altered);
   }else if(mode==='shorter')await writeFile(file,payload.subarray(0,-1));
   else if(mode==='longer')await writeFile(file,Buffer.concat([payload,Buffer.from([0x12])]));
   const handle=await actualFs.open(file,flags,perms),read=handle.read.bind(handle),close=handle.close.bind(handle);
   // Force short reads at arbitrary offsets, including the final partial chunk.
   vi.spyOn(handle,'read').mockImplementation((async (buffer:Buffer,offset:number,length:number,position:null)=>{
    buffers.add(buffer.buffer);
    if(++reads===2&&mode==='read failure')throw Error('controlled read failure');
    return read(buffer,offset,Math.min(length,16381),position);
   }) as fs.FileHandle['read']);
   vi.spyOn(handle,'close').mockImplementation(async()=>{closed();await close();});
   return handle;
  });
  const pending=captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm']);
  if(mode==='valid'){
   const captured=await pending;
   try{expect(await readFile(path.join(captured.dir,'osv-scalibr/npm/all.zip'))).toEqual(payload);}
   finally{await captured.cleanup();}
  }else await expect(pending).rejects.toThrow(mode==='read failure'?'controlled read failure':'database digest mismatch');
  expect(reads).toBeGreaterThan(1);
  expect(buffers.size).toBe(1);
  expect([...buffers][0]?.byteLength).toBe(64*1024);
  expect(closed).toHaveBeenCalledTimes(1);
  expect(privateZip).toBeDefined();
  await expect(readFile(privateZip!)).rejects.toMatchObject({code:'ENOENT'});
 });

it.each([0,1])('checks EOF at the hash size ceiling with %s extra byte',async extra=>{
 const dir=await cache();
 const size=OFFLINE_LIMITS.databaseBytes+extra;
 let remaining=size,lastRead=0,reads=0;
 const closed=vi.fn();
 vi.mocked(fs.open).mockImplementation(async (file,flags,perms)=>{
  const handle=await actualFs.open(file,flags,perms);
  if(flags!=='r'||typeof file!=='string'||path.basename(file)!=='all.zip')return handle;
  const close=handle.close.bind(handle);
  // Simulate a changed destination after the copy without creating a 512 MiB test file.
  vi.spyOn(handle,'read').mockImplementation((async (buffer:Buffer,_offset:number,length:number)=>{
   if(reads++===0)buffer.fill(0);
   lastRead=length;
   const bytesRead=Math.min(length,remaining);
   remaining-=bytesRead;
   return {bytesRead,buffer};
  }) as fs.FileHandle['read']);
  vi.spyOn(handle,'close').mockImplementation(async()=>{closed();await close();});
  return handle;
 });
 await expect(captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm'])).rejects.toThrow(
  extra?'database exceeds the byte limit':'database digest mismatch');
 expect(remaining).toBe(0);
 expect(lastRead).toBe(1);
 expect(reads).toBe(OFFLINE_LIMITS.databaseBytes/(64*1024)+1);
 expect(closed).toHaveBeenCalledTimes(1);
});

it.each(['missing','digest','truncated','expired','future','origin','duplicate','unknown','symlink'])('rejects %s cached evidence',async mode=>{
 const dir=await cache(),file=path.join(dir,'manifest.json'),m=JSON.parse(await readFile(file,'utf8')),d=m.databases[0],obj=path.join(dir,'objects',d.sha256+'.zip');
 if(mode==='missing')await rm(obj);if(mode==='digest')await writeFile(obj,Buffer.alloc(zip.length));if(mode==='truncated')await writeFile(obj,'PK');
 if(mode==='expired')d.downloaded_at=new Date(Date.now()-169*3600000).toISOString();if(mode==='future')d.downloaded_at=new Date(Date.now()+3600000).toISOString();if(mode==='origin')d.url='https://evil.example/all.zip';if(mode==='duplicate')m.databases.push({...d});if(mode==='unknown')m.extra=true;
 if(mode==='symlink'){await rm(obj);await writeFile(path.join(dir,'outside.zip'),zip);await symlink(path.join(dir,'outside.zip'),obj);}
 await writeFile(file,JSON.stringify(m));await expect(captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm'])).rejects.toThrow();
});
it('missing ecosystems never become a successful empty scan',async()=>{const dir=await cache();await expect(captureOfflineDatabases({offline:true,offlineDbDir:dir},['PyPI'])).rejects.toThrow('missing');});
it('failed refresh preserves the previously selected manifest and DB bytes',async()=>{
 const dir=await cache(),old=await readFile(path.join(dir,'manifest.json'));const bad=vi.fn(async()=>new Response('not zip'));
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:bad as typeof fetch})).rejects.toThrow('ZIP');expect(await readFile(path.join(dir,'manifest.json'))).toEqual(old);
 const s=await captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm']);expect(await readFile(path.join(s.dir,'osv-scalibr/npm/all.zip'))).toEqual(zip);await s.cleanup();
});
it.each([206,200])('rejects partial database responses (%s) without replacing the manifest',async status=>{
 const dir=await cache(),before=await readFile(path.join(dir,'manifest.json')),f=vi.fn(async()=>new Response(zip,{status,headers:{'content-range':'bytes 0-31/1000'}}));
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:f as typeof fetch})).rejects.toThrow('complete download');expect(await readFile(path.join(dir,'manifest.json'))).toEqual(before);expect(f.mock.calls).toHaveLength(1);
});
const objectNames=async(dir:string)=>(await readdir(path.join(dir,'objects'))).sort();
const generation=(i:number)=>Buffer.concat([zip,Buffer.from(' generation '+i)]);
it('repeated refreshes keep only the selected and previous DB generations',async()=>{
 const dir=await root();
 for(let i=1;i<=6;i++){
  await prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:(async()=>new Response(generation(i))) as typeof fetch});
  const expected=[generation(i),...(i>1?[generation(i-1)]:[])].map(b=>hash(b)+'.zip').sort();expect(await objectNames(dir)).toEqual(expected);
 }
 const s=await captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm']);expect(await readFile(path.join(s.dir,'osv-scalibr/npm/all.zip'))).toEqual(generation(6));await s.cleanup();
});
it('the next refresh collects objects from a failed partial run and interrupted downloads',async()=>{
 const dir=await cache(),selected=hash(zip)+'.zip',stale=path.join(dir,'objects','.download-'+'a'.repeat(24));await writeFile(stale,'partial');
 let calls=0;const partial=vi.fn(async()=>++calls===1?new Response(generation(1)):new Response('not zip'));
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm','PyPI'],fetchFn:partial as typeof fetch})).rejects.toThrow('ZIP');
 // That run collected the interrupted download at its start, then left an unreferenced npm object; the manifest still selects the original one.
 expect(await objectNames(dir)).toEqual([hash(generation(1))+'.zip',selected].sort());
 await prepareOfflineDatabases({dir,ecosystems:['PyPI'],fetchFn:(async()=>new Response(generation(2))) as typeof fetch});
 expect(await objectNames(dir)).toEqual([selected,hash(generation(2))+'.zip'].sort());
 const s=await captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm','PyPI']);await s.cleanup();
});
it('collection never removes unknown entries; they are still rejected',async()=>{
 const dir=await cache(),note=path.join(dir,'objects','notes.txt');await writeFile(note,'operator file');
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:(async()=>new Response(generation(1))) as typeof fetch})).rejects.toThrow('unexpected cache object');
 expect(await readFile(note,'utf8')).toBe('operator file');expect(await objectNames(dir)).toContain(hash(zip)+'.zip');
});
it('serializes updates and never removes the active updater lock for another caller',async()=>{
 const dir=await root();let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const f=vi.fn(async()=>{entered();await hold;return new Response(zip);}),pending=prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:f as typeof fetch});await ready;
 try{await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:f as typeof fetch})).rejects.toThrow('update is active');expect((await fs.lstat(path.join(dir,'update.lock'))).isDirectory()).toBe(true);expect(f).toHaveBeenCalledOnce();}finally{release();await pending;}
 const s=await captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm']);await s.cleanup();
});
it('does not reclaim a legacy update lock even when its file is empty',async()=>{
 const dir=await cache(),marker=path.join(dir,'update.lock'),before=await readFile(path.join(dir,'manifest.json'));
 const old=await fs.open(marker,'wx',0o600);
 const fetchFn=vi.fn(async()=>new Response(generation(1)));
 try{
  await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn})).rejects.toThrow('legacy or unexpected update.lock');
  expect((await fs.lstat(marker)).ino).toBe((await old.stat()).ino);
  expect(fetchFn).not.toHaveBeenCalled();
  expect(await readFile(path.join(dir,'manifest.json'))).toEqual(before);
 }finally{await old.close();await rm(marker);}
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn})).resolves.toBeDefined();
 expect(fetchFn).toHaveBeenCalledOnce();
});
it('preserves unknown lock directory contents and releases the native lock after rejection',async()=>{
 const dir=await cache(),marker=path.join(dir,'update.lock'),note=path.join(marker,'operator-note');
 await mkdir(marker);await writeFile(note,'keep');
 const fetchFn=vi.fn(async()=>new Response(generation(1)));
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn})).rejects.toThrow('update.lock directory is not empty');
 expect(fetchFn).not.toHaveBeenCalled();expect(await readFile(note,'utf8')).toBe('keep');
 await rm(note);
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn})).resolves.toBeDefined();
 expect(fetchFn).toHaveBeenCalledOnce();
});
it('reports a published manifest separately when its lock marker cannot be removed',async()=>{
 const dir=await cache(),marker=path.join(dir,'update.lock'),note=path.join(marker,'operator-note');
 const intrude=async()=>{await writeFile(note,'keep');return new Response(generation(1));};
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:intrude as typeof fetch})).rejects.toThrow('the new manifest was published, but cleanup failed');
 expect(JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8')).databases[0].sha256).toBe(createHash('sha256').update(generation(1)).digest('hex'));
 expect(await readFile(note,'utf8')).toBe('keep');
 await rm(note);
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:async()=>new Response(generation(2))})).resolves.toBeDefined();
});
it('keeps the reason of a failed update when its lock marker cannot be removed',async()=>{
 const dir=await cache(),marker=path.join(dir,'update.lock'),before=await readFile(path.join(dir,'manifest.json'));
 const intrude=async()=>{await writeFile(path.join(marker,'operator-note'),'keep');return new Response('',{status:503});};
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:intrude as typeof fetch})).rejects.toThrow('HTTP 503');
 expect(await readFile(path.join(dir,'manifest.json'))).toEqual(before);
});
it('completes when the empty lock marker was already removed',async()=>{
 const dir=await cache();
 const remove=async()=>{await fs.rmdir(path.join(dir,'update.lock'));return new Response(generation(1));};
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:remove as typeof fetch})).resolves.toBeDefined();
 await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:async()=>new Response(generation(2))})).resolves.toBeDefined();
});
it('offline blocks preparation and API queries; missing local explanation data never invokes fetch',async()=>{
 vi.stubEnv('OSV_MCP_OFFLINE','1');const f=vi.fn(()=>{throw Error('must not fetch');});
 await expect(prepareOfflineDatabases({dir:await root(),ecosystems:['npm'],fetchFn:f})).rejects.toThrow('Offline mode');
 await expect(fetchOsvRecord('GHSA-35jh-r3h4-6jhm',{fetchFn:f})).rejects.toThrow('Offline mode');await expect(queryOsvPackageVersion('npm','lodash','4.17.21',{fetchFn:f})).rejects.toThrow('Offline mode');
 const result=await handleExplainVulnerability({vulnerability_id:'GHSA-35jh-r3h4-6jhm'},{fetchFn:f,offlineDbDir:path.join(await root(),'missing')});expect(result.isError).toBe(true);expect(result.content[0]!.text).toContain('Offline database cache');expect(f).not.toHaveBeenCalled();
});
it('offline binary resolution never dispatches an automatic download',async()=>{
 const f=vi.fn(async()=>{throw Error('download');});await expect(resolveOsvScannerBinary({PATH:'',OSV_MCP_OFFLINE:'1',XDG_CACHE_HOME:await root()},{downloadFn:f})).rejects.toThrow();expect(f).not.toHaveBeenCalled();
});
it('cache-only binary lookup validates existing bytes and refuses missing or corrupted bytes without fetch',async()=>{
 const cacheDir=await root(),bytes=Buffer.from('test binary'),asset='osv-scanner_darwin_arm64',fetchFn=vi.fn(()=>{throw Error('fetch');}),opts={allowDownload:false,cacheDir,platform:'darwin' as const,arch:'arm64',checksums:{[asset]:hash(bytes)},fetchFn};
 await expect(ensureOsvScannerDownloaded(opts)).rejects.toThrow('Offline mode');const dir=path.join(cacheDir,'v'+PINNED_OSV_SCANNER_VERSION);await mkdir(dir);const binary=path.join(dir,asset);await writeFile(binary,bytes);await chmod(binary,0o755);expect(await ensureOsvScannerDownloaded(opts)).toBe(binary);await writeFile(binary,'changed');await expect(ensureOsvScannerDownloaded(opts)).rejects.toThrow('Offline mode');
 await rm(binary);const external=path.join(cacheDir,'other-binary');await writeFile(external,bytes);await symlink(external,binary);await expect(ensureOsvScannerDownloaded(opts)).rejects.toThrow('Offline mode');expect(fetchFn).not.toHaveBeenCalled();
});
async function fake(dir:string,raw:unknown){await writeFile(path.join(dir,'package-lock.json'),'{"name":"test","lockfileVersion":3,"packages":{}}',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});const bin=path.join(dir,'scanner.cjs');await writeFile(bin,'#!'+process.execPath+'\nconst fs=require("node:fs");fs.writeFileSync('+JSON.stringify(path.join(dir,'args.json'))+',JSON.stringify({args:process.argv.slice(2),cache:process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY}));console.log('+JSON.stringify(JSON.stringify(raw))+');');await chmod(bin,0o755);return bin;}
it.each(['project','artifact','sbom'] as const)('runs %s only after cache verification and cleans up the scanner cache snapshot',async mode=>{
 const dir=await cache();if(mode==='artifact')await prepareOfflineDatabases({dir,ecosystems:['Maven'],fetchFn:fetchZIP as typeof fetch});const binaryPath=await fake(dir,{results:[]}),opts={offline:true,offlineDbDir:dir,binaryPath};
 if(mode==='project'){const report=await runOsvScan([{path:path.join(dir,'package-lock.json'),format:'package-lock.json'}],opts);expect(report.offline_database?.mode).toBe('offline');}
 else if(mode==='artifact')await runOsvArtifactScan([path.join(dir,'x.jar')],opts);else await runOsvSbomScan(path.join(dir,'x.cdx.json'),opts);
 const captured=JSON.parse(await readFile(path.join(dir,'args.json'),'utf8'));expect(captured.args).toContain('--offline');expect(captured.args).toContain('--no-resolve');expect(captured.cache).not.toBe(dir);await expect(readdir(captured.cache)).rejects.toThrow();
});
it('offline Git dependencies are refused before the scanner can silently skip commit matching',async()=>{
 const dir=await cache(),binaryPath=await fake(dir,{results:[]});await writeFile(path.join(dir,'package-lock.json'),'{"resolved":"git+https://github.com/acme/private.git#abcdef"}');
 await expect(runOsvScan([{path:path.join(dir,'package-lock.json'),format:'package-lock.json'}],{offline:true,offlineDbDir:dir,binaryPath})).rejects.toThrow('Git/commit');await expect(readFile(path.join(dir,'args.json'))).rejects.toThrow();
});
it('invalid cache prevents scanner process creation',async()=>{
 const dir=await cache(),binaryPath=await fake(dir,{results:[]});await rm(path.join(dir,'manifest.json'));
 await expect(runOsvScan([{path:path.join(dir,'package-lock.json'),format:'package-lock.json'}],{offline:true,offlineDbDir:dir,binaryPath})).rejects.toThrow('manifest');await expect(readFile(path.join(dir,'args.json'))).rejects.toThrow();
});
it('project scans copy only the required ecosystem, ignoring unrelated expired databases',async()=>{
 const dir=await cache();await prepareOfflineDatabases({dir,ecosystems:['Go'],fetchFn:fetchZIP as typeof fetch});const p=path.join(dir,'manifest.json'),m=JSON.parse(await readFile(p,'utf8'));m.databases.find((d:{ecosystem:string})=>d.ecosystem==='npm').downloaded_at='2020-01-01T00:00:00.000Z';await writeFile(p,JSON.stringify(m));
 await writeFile(path.join(dir,'go.mod'),'module example.com/test\ngo 1.22\n');const binaryPath=await fake(dir,{results:[]}),report=await runOsvScan([{path:path.join(dir,'go.mod'),format:'go.mod'}],{offline:true,offlineDbDir:dir,binaryPath});expect(report.offline_database!.databases.map(d=>d.ecosystem)).toEqual(['Go']);
});
it('online scanner output cannot spoof the internally generated offline metadata',async()=>{
 const dir=await root(),binaryPath=await fake(dir,{results:[],offline_database:{mode:'offline',network_requests:false}}),report=await runOsvScan([{path:path.join(dir,'package-lock.json'),format:'package-lock.json'}],{binaryPath});expect(report.offline_database).toBeUndefined();
});
it('suggest_fix keeps an explicit opt-out for offline candidate rechecks',async()=>{
 const dir=await cache();await writeFile(path.join(dir,'package-lock.json'),JSON.stringify({name:'test',lockfileVersion:3,packages:{'node_modules/lodash':{version:'4.17.20',resolved:'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz'}}}));
 const vuln={id:'GHSA-35jh-r3h4-6jhm',affected:[{package:{ecosystem:'npm',name:'lodash'},ranges:[{type:'SEMVER',events:[{introduced:'0'},{fixed:'4.17.21'}]}]}]};
 const binaryPath=await fake(dir,{results:[{source:{path:path.join(dir,'package-lock.json')},packages:[{package:{name:'lodash',version:'4.17.20',ecosystem:'npm'},groups:[{ids:[vuln.id]}],vulnerabilities:[vuln]}]}]});
 const result=await handleSuggestFix({project_path:dir},{offline:true,offlineDbDir:dir,binaryPath,candidateCheck:'disabled'});expect(result.isError,result.content[0]!.text).not.toBe(true);const value=JSON.parse(result.content[0]!.text);expect(value.offline_database.mode).toBe('offline');expect(value.dependency_resolution.transitive_resolution).toBe('disabled');expect(value.suggestions[0]).toMatchObject({recommended_upgrade:'4.17.21',candidate_check:'disabled'});expect(value.suggestions[0].upgrade_note).toContain('Offline mode');
});
