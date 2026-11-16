import {it,expect,afterEach,vi} from 'vitest';
import {offlineConfig} from '../../osv/offline.js';
import {prepareOfflineDatabases,captureOfflineDatabases} from '../../osv/offlineCache.js';
import {mkdtemp,realpath,rm,readFile,writeFile,readdir,chmod,symlink,mkdir} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {fetchOsvRecord,queryOsvPackageVersion} from '../../osv/osvApi.js';
import {buildOsvScanArgs,isRemoteResolutionDisabled,runOsvScan,runOsvSbomScan,runOsvArtifactScan} from '../../osv/runner.js';
import {ensureOsvScannerDownloaded,PINNED_OSV_SCANNER_VERSION} from '../../osv/binaryDownloader.js';
import {resolveOsvScannerBinary} from '../../osv/binaryManager.js';
import {handleSuggestFix} from '../../tools/suggestFix.js';
import {handleExplainVulnerability} from '../../tools/explainVulnerability.js';
const roots:string[]=[];afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
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
it('serializes updates and never removes the active updater lock for another caller',async()=>{
 const dir=await root();let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);
 const f=vi.fn(async()=>{entered();await hold;return new Response(zip);}),pending=prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:f as typeof fetch});await ready;
 try{await expect(prepareOfflineDatabases({dir,ecosystems:['npm'],fetchFn:f as typeof fetch})).rejects.toThrow('update is active');expect(await readFile(path.join(dir,'update.lock'))).toBeDefined();expect(f).toHaveBeenCalledOnce();}finally{release();await pending;}
 const s=await captureOfflineDatabases({offline:true,offlineDbDir:dir},['npm']);await s.cleanup();
});
it('offline blocks preparation, explanations and package queries before fetch, including explicit fetch injection',async()=>{
 vi.stubEnv('OSV_MCP_OFFLINE','1');const f=vi.fn(()=>{throw Error('must not fetch');});
 await expect(prepareOfflineDatabases({dir:await root(),ecosystems:['npm'],fetchFn:f})).rejects.toThrow('Offline mode');
 await expect(fetchOsvRecord('GHSA-35jh-r3h4-6jhm',{fetchFn:f})).rejects.toThrow('Offline mode');await expect(queryOsvPackageVersion('npm','lodash','4.17.21',{fetchFn:f})).rejects.toThrow('Offline mode');
 const result=await handleExplainVulnerability({vulnerability_id:'GHSA-35jh-r3h4-6jhm'},{fetchFn:f});expect(result.isError).toBe(true);expect(result.content[0]!.text).toContain('Offline mode');expect(f).not.toHaveBeenCalled();
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
it('suggest_fix uses offline findings and explicitly disables candidate rechecks despite injected online options',async()=>{
 const dir=await cache();await writeFile(path.join(dir,'package-lock.json'),JSON.stringify({name:'test',lockfileVersion:3,packages:{'node_modules/lodash':{version:'4.17.20',resolved:'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz'}}}));
 const vuln={id:'GHSA-35jh-r3h4-6jhm',affected:[{package:{ecosystem:'npm',name:'lodash'},ranges:[{type:'SEMVER',events:[{introduced:'0'},{fixed:'4.17.21'}]}]}]};
 const binaryPath=await fake(dir,{results:[{source:{path:path.join(dir,'package-lock.json')},packages:[{package:{name:'lodash',version:'4.17.20',ecosystem:'npm'},groups:[{ids:[vuln.id]}],vulnerabilities:[vuln]}]}]});const f=vi.fn(()=>{throw Error('network');});
 const result=await handleSuggestFix({project_path:dir},{offline:true,offlineDbDir:dir,binaryPath,candidateCheck:{fetchFn:f}});expect(result.isError,result.content[0]!.text).not.toBe(true);const value=JSON.parse(result.content[0]!.text);expect(value.offline_database.mode).toBe('offline');expect(value.dependency_resolution.transitive_resolution).toBe('disabled');expect(value.suggestions[0]).toMatchObject({recommended_upgrade:'4.17.21',candidate_check:'disabled'});expect(value.suggestions[0].upgrade_note).toContain('Offline mode');expect(f).not.toHaveBeenCalled();
});
