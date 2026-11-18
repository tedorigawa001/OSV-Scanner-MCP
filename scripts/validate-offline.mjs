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
import {createRequire} from 'node:module';
import {offlineAliasFixtures,offlineExplanationConflictFixtures} from './offline-alias-fixtures.mjs';
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
const {queryOfflineCandidate}=await import(pathToFileURL(resolve('dist/osv/offlineCandidate.js')).href);
const require=createRequire(import.meta.url);
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
 const fix=payload(await handleSuggestFix({project_path:root},{candidateCheck:{}}),'suggest_fix'),suggestion=fix.suggestions.find(s=>s.package==='golang.org/x/text');
 if(!suggestion?.recommended_upgrade||suggestion.candidate_check!=='clean'||suggestion.candidate_check_source!=='local_database'||!suggestion.upgrade_note.includes('local database snapshot'))throw Error('offline suggestion control failed');
 if(fix.offline_database?.mode!=='offline')throw Error('suggest_fix missing offline DB metadata');
 results.push({tool:'suggest_fix',recommended:suggestion.recommended_upgrade,candidate_check:suggestion.candidate_check,candidate_check_source:suggestion.candidate_check_source,upgrade_note:suggestion.upgrade_note,verification:suggestion.verification,offline_database:fix.offline_database});
 const candidateOptions={offline:true,offlineDbDir:workingCache,binaryPath:binary};
 const affected=await queryOfflineCandidate('Go','golang.org/x/text','0.3.0',candidateOptions,scan.offline_database);
 const fixed=await queryOfflineCandidate('Go','golang.org/x/text',suggestion.recommended_upgrade,candidateOptions,scan.offline_database);
 if(affected.length===0||fixed.length!==0)throw Error('Native affected/clean candidate controls failed');
 results.push({tool:'offline_candidate_query',case:'affected-control',version:'0.3.0',status:'affected',record_ids:affected.map(r=>r.id)});
 results.push({tool:'offline_candidate_query',case:'recommended-control',version:suggestion.recommended_upgrade,status:'clean',record_ids:fixed.map(r=>r.id)});
 const sbom=join(root,'input.cdx.json');await writeFile(sbom,JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.5',version:1,components:[{type:'library',name:'golang.org/x/text',version:'0.3.0',purl:'pkg:golang/golang.org/x/text@0.3.0'}]}));
 const bom=payload(await handleScanSbom({sbom_path:sbom}),'scan_sbom');if(bom.identified_vulnerability_count<1||bom.offline_database?.mode!=='offline')throw Error('offline SBOM control failed');results.push({tool:'scan_sbom',vulnerabilities:bom.identified_vulnerability_count,offline_database:bom.offline_database});
 for(const report of [scan,fix,bom]){
  const metadata=report.offline_database;
  if(metadata.network_requests!==false||JSON.stringify(metadata)!==JSON.stringify(scan.offline_database)||JSON.stringify(metadata.databases)!==JSON.stringify([{ecosystem:'Go',downloaded_at:go.downloaded_at,sha256:go.sha256}]))throw Error('Positive tools used different or unexpected DB metadata');
 }
 for(const requested of ['GO-2020-0015','CVE-2020-14040','GHSA-5rcv-m4m3-hfh7']){
  const explanation=payload(await handleExplainVulnerability({vulnerability_id:requested}),'explain_vulnerability');
  if(explanation.requested_id!==requested||explanation.matched_by!==(requested.startsWith('CVE-')?'alias':'id')||(!requested.startsWith('CVE-')&&explanation.id!==requested)||!explanation.matching_record_ids.includes('GO-2020-0015')||!explanation.details||!explanation.affected.some(p=>p.package==='golang.org/x/text')||JSON.stringify(explanation.offline_database)!==JSON.stringify(scan.offline_database))throw Error('Offline ID/alias explanation control failed: '+requested);
  results.push({tool:'explain_vulnerability',case:'lookup-'+requested,status:'found',id:explanation.id,requested_id:requested,matched_by:explanation.matched_by,matching_record_ids:explanation.matching_record_ids,
   summary:explanation.summary,details_characters:explanation.details.length,details_sha256:sha(explanation.details),affected:explanation.affected,related_record_ids:(explanation.related_records??[]).map(r=>r.id),offline_database:explanation.offline_database});
 }
 const absent=await handleExplainVulnerability({vulnerability_id:'GO-2999-0000'}),absentValue=JSON.parse(absent.content[0].text);
 if(!absent.isError||absentValue.error?.kind!=='vulnerability_not_found'||JSON.stringify(absentValue.offline_database)!==JSON.stringify(scan.offline_database))throw Error('Local miss was not identified as snapshot-scoped absence');
 results.push({tool:'explain_vulnerability',case:'unlisted-id',status:'not-found-in-local-snapshot',error:absentValue.error,offline_database:absentValue.offline_database});
 const limited=await handleExplainVulnerability({vulnerability_id:'GO-2020-0015'},{offlineLookupLimits:{entries:1}}),limitedValue=JSON.parse(limited.content[0].text);
 if(!limited.isError||limitedValue.error?.kind!=='output_too_large')throw Error('Lookup budget exhaustion was published as a result');
 results.push({tool:'explain_vulnerability',case:'entry-budget',status:'rejected',error_kind:limitedValue.error.kind,error:limitedValue.error.message});
 const negativeTools=[['scan_project',opts=>handleScanProject({project_path:root},opts)],['suggest_fix',opts=>handleSuggestFix({project_path:root},opts)],['scan_sbom',opts=>handleScanSbom({sbom_path:sbom},opts)],['explain_vulnerability',opts=>handleExplainVulnerability({vulnerability_id:'GO-2020-0015'},opts)]];
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
  let candidateError;
  try{await queryOfflineCandidate('Go','golang.org/x/text',suggestion.recommended_upgrade,{...candidateOptions,offlineDbDir:dir},scan.offline_database);}catch(error){candidateError=error;}
  if(candidateError?.kind!=='scan_failed'||!candidateError.message.includes('Offline database cache')||!candidateError.message.includes(reasons[kind]))throw Error('Invalid candidate DB accepted or rejected for an unrelated reason: '+kind);
  results.push({tool:'offline_candidate_query',case:kind,status:'rejected',error_kind:candidateError.kind,error:candidateError.message});
 }
 const invalidArchive=join(root,'invalid-archive'),invalidBytes=Buffer.from('PK\x03\x04not a ZIP directory'),invalidDigest=sha(invalidBytes);
 await mkdir(join(invalidArchive,'objects'),{recursive:true,mode:0o700});
 await writeFile(join(invalidArchive,'objects',invalidDigest+'.zip'),invalidBytes);
 await writeFile(join(invalidArchive,'manifest.json'),JSON.stringify({schema:1,databases:[{...go,sha256:invalidDigest,bytes:invalidBytes.length}]}));
 const malformed=await handleExplainVulnerability({vulnerability_id:'GO-2020-0015'},{offlineDbDir:invalidArchive}),malformedValue=JSON.parse(malformed.content[0].text);
 if(!malformed.isError||malformedValue.error?.kind!=='scan_failed'||!malformedValue.error.message.includes('ZIP'))throw Error('Digest-valid malformed ZIP was accepted');
 results.push({tool:'explain_vulnerability',case:'digest-valid-malformed-zip',status:'rejected',error_kind:malformedValue.error.kind,error:malformedValue.error.message});
 // Change only the prepared official ZIP's footer; publish a matching integrity digest for each control.
 // A correct full-count ZIP64 conversion first proves the conversion itself is readable.
 const original=await readFile(sourceObject),end=original.length-22;
 if(original.readUInt32LE(end)!==0x06054b50||original.readUInt16LE(end+20)!==0)throw Error('Official ZIP control expects a classic footer without comment');
 const count=original.readUInt16LE(end+10),directorySize=original.readUInt32LE(end+12),directoryOffset=original.readUInt32LE(end+16);
 if(count<2||directoryOffset+directorySize!==end)throw Error('Official ZIP control has unexpected directory layout');
 let cursor=directoryOffset,lastEntryBytes=0,actualCount=0;
 while(cursor<end){
  if(original.readUInt32LE(cursor)!==0x02014b50)throw Error('Unexpected official central entry');
  lastEntryBytes=46+original.readUInt16LE(cursor+28)+original.readUInt16LE(cursor+30)+original.readUInt16LE(cursor+32);
  cursor+=lastEntryBytes;actualCount++;
 }
 if(cursor!==end||actualCount!==count)throw Error('Official ZIP directory count differs from the control inventory');
 const archiveControl=async(name,bytes,expected,metadata)=>{
  const dir=join(root,'explanation-'+name),digest=sha(bytes);
  await mkdir(join(dir,'objects'),{recursive:true,mode:0o700});
  await writeFile(join(dir,'objects',digest+'.zip'),bytes);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({schema:1,databases:[{...go,sha256:digest,bytes:bytes.length}]}));
  const response=await handleExplainVulnerability({vulnerability_id:'GO-2020-0015'},{offlineDbDir:dir}),value=JSON.parse(response.content[0].text);
  if(expected==='found'){
   if(response.isError||value.id!=='GO-2020-0015'||!value.matching_record_ids.includes('GHSA-5rcv-m4m3-hfh7'))throw Error('Full-count ZIP64 conversion failed');
  }else if(!response.isError||value.error?.kind!=='scan_failed'||!value.error.message.includes('ZIP directory'))throw Error('Underreported ZIP directory was not refused: '+name);
  results.push({tool:'explain_vulnerability',case:name,status:expected,fixture_kind:'modified-prepared-official-Go-ZIP-local-reader',source_zip_sha256:go.sha256,zip_sha256:digest,
   ...metadata,...(value.error?{error_kind:value.error.kind,error:value.error.message}:{id:value.id,matching_record_ids:value.matching_record_ids})});
 };
 for(const zip64 of [false,true])for(const mode of ['valid','count','count-and-size']){
  if(!zip64&&mode==='valid')continue; // The unchanged official ZIP already passed the real ID/alias controls.
  const declaredCount=count-(mode==='valid'?0:1),declaredSize=directorySize-(mode==='count-and-size'?lastEntryBytes:0),footer=Buffer.from(original.subarray(end));
  let bytes;
  if(zip64){
   const extended=Buffer.alloc(56),locator=Buffer.alloc(20);
   extended.writeUInt32LE(0x06064b50);extended.writeBigUInt64LE(44n,4);extended.writeUInt16LE(45,12);extended.writeUInt16LE(45,14);
   extended.writeBigUInt64LE(BigInt(declaredCount),24);extended.writeBigUInt64LE(BigInt(declaredCount),32);
   extended.writeBigUInt64LE(BigInt(declaredSize),40);extended.writeBigUInt64LE(BigInt(directoryOffset),48);
   locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(BigInt(end),8);locator.writeUInt32LE(1,16);
   footer.writeUInt16LE(0xffff,8);footer.writeUInt16LE(0xffff,10);footer.writeUInt32LE(0xffffffff,12);footer.writeUInt32LE(0xffffffff,16);
   bytes=Buffer.concat([original.subarray(0,end),extended,locator,footer]);
  }else{
   footer.writeUInt16LE(declaredCount,8);footer.writeUInt16LE(declaredCount,10);footer.writeUInt32LE(declaredSize,12);
   bytes=Buffer.concat([original.subarray(0,end),footer]);
  }
  await archiveControl((zip64?'zip64':'zip')+'-'+mode,bytes,mode==='valid'?'found':'rejected',{actual_entries:actualCount,declared_entries:declaredCount,actual_directory_bytes:directorySize,declared_directory_bytes:declaredSize});
 }
 for(const fixture of offlineExplanationConflictFixtures()){
  const dir=join(root,'explanation-'+fixture.name),databases=fixture.databases.map(d=>({ecosystem:d.ecosystem,url:`https://osv-vulnerabilities.storage.googleapis.com/${d.ecosystem}/all.zip`,sha256:sha(d.bytes),bytes:d.bytes.length,downloaded_at:go.downloaded_at}));
  await mkdir(join(dir,'objects'),{recursive:true,mode:0o700});
  for(const [i,d] of fixture.databases.entries())await writeFile(join(dir,'objects',databases[i].sha256+'.zip'),d.bytes);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({schema:1,databases}));
  const response=await handleExplainVulnerability({vulnerability_id:fixture.requested_id},{offlineDbDir:dir}),value=JSON.parse(response.content[0].text);
  if(!response.isError||value.error?.kind!=='scan_failed'||!value.error.message.includes('conflicting copies'))throw Error('Nonmatching copy hid an alias conflict: '+fixture.name);
  results.push({tool:'explain_vulnerability',case:fixture.name,status:'rejected',fixture_kind:'synthetic-cross-ecosystem-same-ID-local-reader',requested_id:fixture.requested_id,canonical_id:fixture.canonical_id,databases,error_kind:value.error.kind,error:value.error.message});
 }
 // These small generated databases are synthetic controls, separate from the complete official Go ZIP.
 for(const fixture of offlineAliasFixtures()){
  const parent=join(root,'alias-'+fixture.name),project=join(parent,'project'),dir=join(parent,'cache');
  await mkdir(project,{recursive:true,mode:0o700});
  await writeFile(join(project,'go.mod'),'module review.example/consumer\n\ngo 1.22\n\nrequire example.com/lib v1.0.0\n');
  let requests=0;
  try{
   process.env.OSV_MCP_OFFLINE='0';
   await prepareOfflineDatabases({dir,ecosystems:['Go'],fetchFn:async()=>{requests++;return new Response(fixture.bytes);}});
  }finally{process.env.OSV_MCP_OFFLINE='1';}
  const checked=payload(await handleSuggestFix({project_path:project},{offlineDbDir:dir,binaryPath:binary,candidateCheck:{}}),fixture.name);
  const suggestion=checked.suggestions.find(s=>s.package==='example.com/lib');
  if(requests!==1||!suggestion||suggestion.recommended_upgrade!==fixture.expected.recommended_upgrade||suggestion.candidate_check!==fixture.expected.candidate_check||suggestion.candidate_check_source!=='local_database')throw Error('Alias candidate control failed: '+fixture.name);
  const records=await queryOfflineCandidate('Go','example.com/lib','1.5.0',{offlineDbDir:dir,binaryPath:binary},checked.offline_database);
  const actualIds=records.map(r=>r.id).sort(),expectedIds=fixture.records.slice(1).map(r=>r.id).sort();
  if(JSON.stringify(actualIds)!==JSON.stringify(expectedIds)||checked.offline_database.databases[0].sha256!==sha(fixture.bytes))throw Error('Alias fixture DB/record binding failed: '+fixture.name);
  results.push({tool:'suggest_fix',case:'alias-'+fixture.name,status:'verified',fixture_kind:'synthetic-Go-OSV-database-real-scanner',zip_sha256:sha(fixture.bytes),replay_requests:requests,expected:fixture.expected,
   actual:{recommended_upgrade:suggestion.recommended_upgrade,candidate_check:suggestion.candidate_check,candidate_check_source:suggestion.candidate_check_source,recommended_known_vulnerabilities:suggestion.recommended_known_vulnerabilities},
   first_candidate_record_ids:actualIds,offline_database:checked.offline_database});
 }
 if(fetchCalls!==0)throw Error('Node fetch was attempted');
 const files=['src/index.ts','src/cache.ts','src/osv/offline.ts','src/osv/offlineCache.ts','src/osv/offlineCandidate.ts','src/osv/offlineRecord.ts','src/osv/vulnerabilityExplanation.ts','src/osv/runner.ts','src/osv/binaryManager.ts','src/osv/binaryDownloader.ts','src/osv/osvApi.ts','src/osv/candidateCheck.ts','src/osv/suggestFix.ts','src/osv/versionScheme.ts','src/osv/affectedVersions.ts','src/osv/scanReport.ts','src/tools/scanProject.ts','src/tools/scanJavaProject.ts','src/tools/scanJavaArtifact.ts','src/tools/scanSbom.ts','src/tools/suggestFix.ts','src/tools/explainVulnerability.ts','src/utils/permissionCheck.ts','src/utils/safeRead.ts','src/test/osv/offline.test.ts','src/test/osv/offlineCandidateCheck.test.ts','src/test/osv/offlineExplanation.test.ts','src/test/fixtures/offlineRecords.ts','src/test/osv/candidateCheck.test.ts','scripts/validate-offline.mjs','scripts/offline-alias-fixtures.mjs','package.json','package-lock.json'];
 const sources={};for(const p of files)sources[p]=sha(await readFile(p));
 let product_regressions=null;if(values.has('--test-report')){const bytes=await readFile(values.get('--test-report')),report=JSON.parse(bytes),cases=report.testResults.flatMap(t=>t.assertionResults);if(!report.success||report.numFailedTests!==0||cases.filter(t=>t.status==='passed').length!==report.numPassedTests)throw Error('Regression report is not passing');product_regressions={passed:report.numPassedTests,failed:report.numFailedTests,skipped:report.numPendingTests,files:report.testResults.length,report_sha256:sha(bytes),offline_cases:report.testResults.find(t=>t.name.endsWith('offline.test.ts'))?.assertionResults.map(t=>({name:t.fullName,status:t.status})),offline_candidate_cases:report.testResults.find(t=>t.name.endsWith('offlineCandidateCheck.test.ts'))?.assertionResults.map(t=>({name:t.fullName,status:t.status})),online_candidate_cases:report.testResults.find(t=>t.name.endsWith('/candidateCheck.test.ts'))?.assertionResults.map(t=>({name:t.fullName,status:t.status})),offline_explanation_cases:report.testResults.find(t=>t.name.endsWith('offlineExplanation.test.ts'))?.assertionResults.map(t=>({name:t.fullName,status:t.status}))};}
 const record={schema:1,date:new Date().toISOString(),scope:'complete-Go-database-local-explanations-and-real-scanner-same-user-network-denied',runtime:{node:process.version,platform:process.platform,arch:process.arch,node_sha256:await image(process.execPath),zip_reader:{name:'yauzl',version:require('yauzl/package.json').version,index_sha256:await image(require.resolve('yauzl'))}},scanner:{version:execFileSync(binary,['--version'],{encoding:'utf8'}).trim(),sha256:await image(binary)},database_manifest:inputManifest,network_control:denied,node_fetch_calls:fetchCalls,results,sources,product_regressions};
 if(values.has('--output'))await writeFile(values.get('--output'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({network_control:denied,node_fetch_calls:fetchCalls,results:results.map(r=>({tool:r.tool,case:r.case,status:r.status,vulnerabilities:r.vulnerabilities,recommended:r.recommended}))},null,2));
}finally{await rm(root,{recursive:true,force:true});}
