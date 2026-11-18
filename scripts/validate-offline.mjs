/** Reproduce real offline scans using an already prepared complete Go database. Never downloads. */
import {mkdtemp,realpath,writeFile,readFile,mkdir,rm,copyFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {connect} from 'node:net';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const values=new Map();for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--cache','--binary','--output','--test-report'].includes(k)||!v||values.has(k))throw Error('Usage: node scripts/validate-offline.mjs --cache /prepared/cache --binary /osv-scanner [--output /record.json] [--test-report /vitest-report.json]');values.set(k,v);}
if(!values.has('--cache')||!values.has('--binary'))throw Error('--cache and --binary are required');
const cache=await realpath(values.get('--cache')),binary=await realpath(values.get('--binary'));
// Require an effective OS network restriction, rather than trusting a CLI label or a fetch mock.
const denied=await new Promise(resolve=>{const s=connect({host:'127.0.0.1',port:9});s.setTimeout(2000);s.once('connect',()=>{s.destroy();resolve('connected');});s.once('timeout',()=>{s.destroy();resolve('timeout');});s.once('error',e=>resolve(e.code));});
if(!['EPERM','EACCES'].includes(denied))throw Error('Network restriction not demonstrated ('+denied+'). Run under an OS network-deny profile');
process.env.OSV_MCP_OFFLINE='1';process.env.OSV_MCP_OFFLINE_DB_DIR=cache;process.env.OSV_SCANNER_PATH=binary;
let fetchCalls=0;globalThis.fetch=async()=>{fetchCalls++;throw Error('Unexpected Node network request');};
const load=async name=>import(pathToFileURL(resolve('dist/tools/'+name+'.js')).href);
const {handleScanProject}=await load('scanProject'),{handleSuggestFix}=await load('suggestFix'),{handleScanSbom}=await load('scanSbom'),{handleExplainVulnerability}=await load('explainVulnerability');
const {prepareOfflineDatabases,captureOfflineDatabases}=await import(pathToFileURL(resolve('dist/osv/offlineCache.js')).href);
const root=await realpath(await mkdtemp(join(tmpdir(),'offline-native-'))),results=[];
const payload=(r,label)=>{const p=JSON.parse(r.content[0].text);if(r.isError)throw Error(label+': '+JSON.stringify(p));return p;};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function image(p){const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');}
try{
 const inputManifest=JSON.parse(await readFile(join(cache,'manifest.json'),'utf8'));
 const go=inputManifest.databases.find(d=>d.ecosystem==='Go');if(!go)throw Error('Prepared Go database required');
 const selected=go.sha256+'.zip',sourceObject=join(cache,'objects',selected);
 if(await image(sourceObject)!==go.sha256)throw Error('Prepared database digest mismatch');
 // Exercise the real collector on a disposable cache. The updater replays the already downloaded
 // official ZIP from disk; it neither downloads a new generation nor changes its acquisition time.
 const workingCache=join(root,'collected-cache'),objects=join(workingCache,'objects');
 await mkdir(objects,{recursive:true,mode:0o700});
 await copyFile(sourceObject,join(objects,selected));
 await writeFile(join(workingCache,'manifest.json'),JSON.stringify({schema:1,databases:[go]}));
 const stale=sha('unreferenced native validation object')+'.zip',partial='.download-'+'a'.repeat(24);
 await writeFile(join(objects,stale),'unreferenced native validation object');
 await writeFile(join(objects,partial),'interrupted download');
 const before=(await readdir(objects)).sort();
 const active=await captureOfflineDatabases({offline:true,offlineDbDir:workingCache},['Go']);
 let replayRequests=0,collectedBeforeReplay=false;
 try{
  process.env.OSV_MCP_OFFLINE='0';
  const refreshed=await prepareOfflineDatabases({dir:workingCache,ecosystems:['Go'],now:Date.parse(go.downloaded_at),fetchFn:async(url)=>{
   replayRequests++;
   const remaining=(await readdir(objects)).sort();
   if(url!==go.url||JSON.stringify(remaining)!==JSON.stringify([selected]))throw Error('Collection did not preserve exactly the selected DB before replay');
   collectedBeforeReplay=true;
   return new Response(Readable.toWeb(createReadStream(sourceObject)),{status:200,headers:{'content-length':String(go.bytes)}});
  }});
  if(JSON.stringify(refreshed)!==JSON.stringify({schema:1,databases:[go]}))throw Error('Replay changed the selected database metadata');
  const after=(await readdir(objects)).sort();
  if(replayRequests!==1||!collectedBeforeReplay||JSON.stringify(after)!==JSON.stringify([selected]))throw Error('Collection control failed');
  if(await image(join(objects,selected))!==go.sha256||await image(join(active.dir,'osv-scalibr/Go/all.zip'))!==go.sha256)throw Error('Collection changed selected or active private DB bytes');
  results.push({case:'object-collection',status:'verified',transport:'local-replay-of-prepared-official-Go-ZIP-no-network',replay_requests:replayRequests,before,after,collected_before_replay:collectedBeforeReplay,selected_sha256:go.sha256,active_private_snapshot_preserved:true});
 }finally{process.env.OSV_MCP_OFFLINE='1';await active.cleanup();}
 process.env.OSV_MCP_OFFLINE_DB_DIR=workingCache;
 await writeFile(join(root,'go.mod'),'module offline.example/verification\n\ngo 1.22\n\nrequire golang.org/x/text v0.3.0\n');
 const scan=payload(await handleScanProject({project_path:root}),'scan_project');
 if(scan.vulnerability_count<1||scan.offline_database?.mode!=='offline'||scan.dependency_resolution.transitive_resolution!=='disabled')throw Error('offline positive scan control failed');
 results.push({tool:'scan_project',vulnerabilities:scan.vulnerability_count,packages:scan.packages.map(p=>({name:p.name,version:p.version,ids:p.vulnerabilities.map(v=>v.id)})),offline_database:scan.offline_database});
 const fix=payload(await handleSuggestFix({project_path:root}),'suggest_fix'),suggestion=fix.suggestions.find(s=>s.package==='golang.org/x/text');
 if(!suggestion?.recommended_upgrade||suggestion.candidate_check!=='disabled'||!suggestion.upgrade_note.includes('Offline mode'))throw Error('offline suggestion control failed');
 if(fix.offline_database?.mode!=='offline')throw Error('suggest_fix missing offline DB metadata');
 results.push({tool:'suggest_fix',recommended:suggestion.recommended_upgrade,candidate_check:suggestion.candidate_check,upgrade_note:suggestion.upgrade_note,verification:suggestion.verification,offline_database:fix.offline_database});
 const sbom=join(root,'input.cdx.json');await writeFile(sbom,JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.5',version:1,components:[{type:'library',name:'golang.org/x/text',version:'0.3.0',purl:'pkg:golang/golang.org/x/text@0.3.0'}]}));
 const bom=payload(await handleScanSbom({sbom_path:sbom}),'scan_sbom');if(bom.identified_vulnerability_count<1||bom.offline_database?.mode!=='offline')throw Error('offline SBOM control failed');results.push({tool:'scan_sbom',vulnerabilities:bom.identified_vulnerability_count,offline_database:bom.offline_database});
 for(const report of [scan,fix,bom]){
  const metadata=report.offline_database;
  if(metadata.network_requests!==false||JSON.stringify(metadata)!==JSON.stringify(scan.offline_database)||JSON.stringify(metadata.databases)!==JSON.stringify([{ecosystem:'Go',downloaded_at:go.downloaded_at,sha256:go.sha256}]))throw Error('Positive tools used different or unexpected DB metadata');
 }
 const explain=await handleExplainVulnerability({vulnerability_id:scan.packages[0].vulnerabilities[0].id});if(!explain.isError||!explain.content[0].text.includes('Offline mode'))throw Error('explanation unexpectedly reached online API');results.push({tool:'explain_vulnerability',status:'offline-unavailable'});
 const negativeTools=[['scan_project',opts=>handleScanProject({project_path:root},opts)],['suggest_fix',opts=>handleSuggestFix({project_path:root},opts)],['scan_sbom',opts=>handleScanSbom({sbom_path:sbom},opts)]];
 const reasons={missing:'manifest missing or unreadable','missing-object':'missing, replaced or truncated',expired:'expired or has a future timestamp',future:'expired or has a future timestamp',truncated:'missing, replaced or truncated',digest:'digest mismatch','invalid-origin':'manifest invalid'};
 for(const kind of ['missing','missing-object','expired','future','truncated','digest','invalid-origin']){
  const dir=join(root,kind);
  if(kind==='missing')await mkdir(dir,{mode:0o700});
  if(kind!=='missing'){
   await mkdir(join(dir,'objects'),{recursive:true,mode:0o700});
   const m={schema:1,databases:[{...go}]},d=m.databases[0];
   if(kind==='expired')d.downloaded_at='2020-01-01T00:00:00.000Z';
   if(kind==='future')d.downloaded_at=new Date(Date.now()+3600000).toISOString();
   if(kind==='invalid-origin')d.url='https://invalid.example/all.zip';
   if(kind==='truncated')await writeFile(join(dir,'objects',selected),'PK');
   if(kind==='digest'){
    const changed=await readFile(sourceObject);changed[changed.length-1]^=1;
    await writeFile(join(dir,'objects',selected),changed);
   }
   await writeFile(join(dir,'manifest.json'),JSON.stringify(m));
  }
  for(const [tool,run] of negativeTools){
   const r=await run({offlineDbDir:dir}),error=JSON.parse(r.content[0].text).error;
   if(!r.isError||error?.kind!=='scan_failed'||!error.message.includes('Offline database cache')||!error.message.includes(reasons[kind]))throw Error('invalid cache accepted or failed for an unrelated reason: '+tool+'/'+kind);
   results.push({tool,case:kind,status:'rejected',error_kind:error.kind,error:error.message});
  }
 }
 if(fetchCalls!==0)throw Error('Node fetch was attempted');
 const files=['src/index.ts','src/cache.ts','src/osv/offline.ts','src/osv/offlineCache.ts','src/osv/runner.ts','src/osv/binaryManager.ts','src/osv/binaryDownloader.ts','src/osv/osvApi.ts','src/osv/candidateCheck.ts','src/osv/scanReport.ts','src/tools/scanProject.ts','src/tools/scanJavaProject.ts','src/tools/scanJavaArtifact.ts','src/tools/scanSbom.ts','src/tools/suggestFix.ts','src/tools/explainVulnerability.ts','src/utils/permissionCheck.ts','src/utils/safeRead.ts','src/test/osv/offline.test.ts','scripts/validate-offline.mjs','package-lock.json'];
 const sources={};for(const p of files)sources[p]=sha(await readFile(p));
 let product_regressions=null;if(values.has('--test-report')){const bytes=await readFile(values.get('--test-report')),report=JSON.parse(bytes),cases=report.testResults.flatMap(t=>t.assertionResults);if(!report.success||report.numFailedTests!==0||cases.filter(t=>t.status==='passed').length!==report.numPassedTests)throw Error('Regression report is not passing');product_regressions={passed:report.numPassedTests,failed:report.numFailedTests,skipped:report.numPendingTests,files:report.testResults.length,report_sha256:sha(bytes),offline_cases:report.testResults.find(t=>t.name.endsWith('offline.test.ts'))?.assertionResults.map(t=>({name:t.fullName,status:t.status}))};}
 const record={schema:1,date:new Date().toISOString(),scope:'complete-Go-database-real-scanner-same-user-network-denied',runtime:{node:process.version,platform:process.platform,arch:process.arch,node_sha256:await image(process.execPath)},scanner:{version:execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),sha256:await image(binary)},database_manifest:inputManifest,network_control:denied,node_fetch_calls:fetchCalls,results,sources,product_regressions};
 if(values.has('--output'))await writeFile(values.get('--output'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({network_control:denied,node_fetch_calls:fetchCalls,results:results.map(r=>({tool:r.tool,case:r.case,status:r.status,vulnerabilities:r.vulnerabilities,recommended:r.recommended}))},null,2));
}finally{await rm(root,{recursive:true,force:true});}
