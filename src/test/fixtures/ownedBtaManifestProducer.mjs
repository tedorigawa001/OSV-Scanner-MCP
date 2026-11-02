// Test-only owned javac -> JAR -> BTA connection. All inputs are concrete before the child starts.
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {canonicalBytes,objectDigest,sha256} from './ownedManifestContract.mjs';
import {createJar,inspectJar} from './ownedJavacContract.mjs';
import {bridgeSources,runtimeRefusals} from './ownedBtaManifestExpected.mjs';
import {runtimeVector,btaFail,makeBridgeBundle} from './ownedBtaManifestContract.mjs';
import {ownerJdkProfile} from './gradleSnapshotOwnerExpected.mjs';
import {btaDriverProfiles} from './gradleBtaDriverRuntime.mjs';
const [project,jdk,cache,version,executionId]=process.argv.slice(2);
if(!executionId||!btaDriverProfiles[version])throw Error('missing-native-environment');
const root=fs.realpathSync(project),repo=fileURLToPath(new URL('../../../',import.meta.url)),environment={LANG:'C',LC_ALL:'C',TZ:'UTC'};
const executorProcess={environment:Object.fromEntries(Object.entries(process.env).filter(([k])=>k==='TZ')),otherVariables:Object.keys(process.env).filter(k=>k!=='TZ').sort(),execArgv:process.execArgv};
if(objectDigest(executorProcess)!==objectDigest({environment:{TZ:'UTC'},otherVariables:process.platform==='darwin'?['__CF_USER_TEXT_ENCODING']:[],execArgv:[]}))btaFail('executor-environment');
function guard(p){if(!p.startsWith(root+path.sep)&&p!==root)btaFail('path_invalid');let at=root;for(const part of path.relative(root,p).split(path.sep).filter(Boolean)){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())btaFail('path_invalid');}}
function read(p){guard(p);const before=fs.lstatSync(p);if(!before.isFile()||before.size>128*1024**2)btaFail('budget');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(stat.ino!==before.ino||stat.dev!==before.dev)btaFail('changed');const bytes=Buffer.alloc(before.size+1);let n=0,k;while(n<bytes.length&&(k=fs.readSync(fd,bytes,n,bytes.length-n,null)))n+=k;const after=fs.lstatSync(p);if(n!==before.size||stat.ino!==after.ino||stat.dev!==after.dev||before.mtimeMs!==after.mtimeMs)btaFail('changed');return bytes.subarray(0,n);}finally{fs.closeSync(fd);}}
function file(p){const bytes=read(p);return {path:path.relative(root,p).split(path.sep).join('/'),size:bytes.length,sha256:sha256(bytes)};}
function create(p,b){guard(path.dirname(p));fs.writeFileSync(p,b,{flag:'wx'});}
// Run-local entity tokens; device/inode/birth time are compared natively but never published, hashed or not.
const tokens=new Map();
function token(p){const s=fs.lstatSync(p,{bigint:true}),k=s.dev+':'+s.ino+':'+s.birthtimeNs;if(!tokens.has(k))tokens.set(k,'entity-'+(tokens.size+1));return tokens.get(k);}
const sourceHashes=Object.fromEntries(bridgeSources.map(p=>[p,sha256(fs.readFileSync(path.join(repo,p)))]));
const nodeRuntime={sha256:sha256(fs.readFileSync(process.execPath)),version:process.version,platform:process.platform,arch:process.arch};
for(const bin of ['java','javac'])if(sha256(fs.readFileSync(path.join(jdk,'bin',bin)))!==ownerJdkProfile[bin].sha256)btaFail('jdk');
fs.mkdirSync(path.join(root,'runtime'));fs.mkdirSync(path.join(root,'evidence'));fs.mkdirSync(path.join(root,'empty-sourcepath'));
const runtime=runtimeVector(version).map((v,i)=>{const profile=btaDriverProfiles[version].runtime.find(x=>x.coordinate===v.coordinate),origin=fs.realpathSync(path.join(cache,profile.relativePath));if(sha256(fs.readFileSync(origin))!==v.sha256)btaFail('runtime-profile');fs.copyFileSync(origin,path.join(root,v.path));return {...v,size:fs.statSync(path.join(root,v.path)).size};});
create(path.join(root,'runtime.tsv'),runtime.map(f=>[f.occurrence,f.coordinate,f.path,f.sha256,f.size].join('\t')).join('\n')+'\n');
const source=path.join(root,'OwnedBtaManifestDriver.java'),sourceBytes=fs.readFileSync(path.join(repo,bridgeSources[0]));create(source,sourceBytes);
const input={schema:'owned-bta-javac-input-v1',buildInvocationId:executionId+':driver',runtime,source:{path:'OwnedBtaManifestDriver.java',size:sourceBytes.length,sha256:sha256(sourceBytes),bytes:sourceBytes.toString('base64')},java:ownerJdkProfile.java.sha256,javac:ownerJdkProfile.javac.sha256,environment,executorHashes:sourceHashes};
const inputDigest=objectDigest(input);create(path.join(root,'evidence/input.json'),canonicalBytes(input));
function verifyInputs(){if(sha256(read(source))!==input.source.sha256||runtime.some(f=>file(path.join(root,f.path)).sha256!==f.sha256))btaFail('input_stale');return objectDigest({...input,source:{...input.source,bytes:read(source).toString('base64')}});}
const out=path.join(root,'output');if(fs.existsSync(out))btaFail('old_output');fs.mkdirSync(out);const outputToken=token(out),start={createdNew:true,token:outputToken,checks:[]};
for(const point of ['created','precompiler']){const dir=fs.opendirSync(out);try{if(dir.readSync())btaFail('output_not_empty');}finally{dir.closeSync();}if(token(out)!==outputToken)btaFail('output_replaced');start.checks.push({point,empty:true,token:outputToken});}
verifyInputs();
const display=args=>args.map(s=>s.split(root).join('$ROOT').split(jdk).join('$JDK'));
const run=(bin,args)=>{const r=spawnSync(path.join(jdk,'bin',bin),args,{cwd:root,env:environment,encoding:'utf8',timeout:240000,maxBuffer:4*1024**2});if(r.error||r.signal||r.status===null)throw Error('native child '+(r.error?.message??r.signal));if(r.status!==0)throw Error(r.stderr+'\n'+r.stdout);return {exitCode:r.status,stdout:display([r.stdout])[0],stderr:display([r.stderr])[0],args:display(args),executableSha256:ownerJdkProfile[bin].sha256};};
const cp=runtime.map(x=>path.join(root,x.path)).join(path.delimiter),args=['-encoding','UTF-8','--release','21','-proc:none','-implicit:none','-g:none','-classpath',cp,'-sourcepath',path.join(root,'empty-sourcepath'),'-d',out,source];
const compiler=run('javac',args),postInputDigest=verifyInputs();if(postInputDigest!==inputDigest||token(out)!==outputToken)btaFail('build_changed');
const names=fs.readdirSync(out).sort();if(names.length>64||names.some(n=>!n.endsWith('.class')))btaFail('output_inventory');
const output={schema:'owned-bta-output-v1',buildInvocationId:input.buildInvocationId,token:outputToken,files:names.map(name=>{const bytes=read(path.join(out,name));return {path:name,size:bytes.length,sha256:sha256(bytes),bytes:bytes.toString('base64')};})},outputDigest=objectDigest(output);
const entries=[{path:'META-INF/MANIFEST.MF',bytes:Buffer.from('Manifest-Version: 1.0\r\n\r\n')},...output.files.map(f=>({path:f.path,bytes:Buffer.from(f.bytes,'base64')}))],jarBytes=createJar(entries);inspectJar(jarBytes);create(path.join(root,'driver.jar'),jarBytes);
const jar={size:jarBytes.length,sha256:sha256(jarBytes),bytes:jarBytes.toString('base64')},receipt={schema:'owned-bta-driver-build-v1',buildInvocationId:input.buildInvocationId,inputManifestRef:inputDigest,outputSetRef:outputDigest,artifactDigest:jar.sha256},receiptDigest=objectDigest(receipt);
create(path.join(root,'evidence/build.json'),canonicalBytes(receipt));
function runtimeGate(candidate){if(objectDigest(candidate.map(({size,...f})=>f))!==objectDigest(runtimeVector(version)))return 'runtime_binding_mismatch';if(file(path.join(root,'driver.jar')).sha256!==jar.sha256)return 'driver_stale';if(candidate.some(f=>file(path.join(root,f.path)).sha256!==f.sha256))return 'runtime_stale';return null;}
const refusals=[];
for(const id of Object.keys(runtimeRefusals)){let candidate=runtime.map(x=>({...x})),target;
 if(id==='runtime-order')[candidate[0],candidate[1]]=[candidate[1],candidate[0]];
 if(id==='runtime-duplicate-dropped')candidate.pop();
 if(id==='runtime-modified')target=path.join(root,runtime[0].path);
 if(id==='driver-modified')target=path.join(root,'driver.jar');
 let baseline;if(target){baseline=read(target);const b=Buffer.from(baseline);b[0]^=1;fs.writeFileSync(target,b);}
 const reason=runtimeGate(candidate);if(reason===null)throw Error('fault passed launch gate');
 refusals.push({id,candidate,reason,childCalls:0,actualDriverDigest:file(path.join(root,'driver.jar')).sha256,actualRuntime:runtime.map(f=>file(path.join(root,f.path)))});
 if(target)fs.writeFileSync(target,baseline);
}
if(runtimeGate(runtime)!==null)btaFail('runtime_gate');
const beforeDigest=file(path.join(root,'driver.jar')).sha256;
const launch=run('java',['-Xmx768m','-cp',[path.join(root,'driver.jar'),cp].join(path.delimiter),'OwnedBtaManifestDriver',root,executionId,receiptDigest,btaDriverProfiles[version].kotlinVersion]);
launch.beforeDigest=beforeDigest;launch.afterDigest=file(path.join(root,'driver.jar')).sha256;launch.classpath=['driver.jar',...runtime.map(f=>f.path)];
if(launch.afterDigest!==beforeDigest||verifyInputs()!==inputDigest)btaFail('after_launch_stale');
const native=JSON.parse(read(path.join(root,'bta-native.json')));
const readerChecks=native.offers.map(o=>{const last=o.capture??o.postflight??o.preflight;return {id:o.id,snapshots:last.snapshots.map(f=>file(path.join(root,f.path))),saved:last.saved.map(f=>file(path.join(root,f.path))),source:file(path.join(root,o.identity.source.path)),refusalLibrary:o.refusalLibraryEvidence?file(path.join(root,o.refusalLibraryEvidence.path)):null};});
for(const [p,h]of Object.entries(sourceHashes))if(sha256(fs.readFileSync(path.join(repo,p)))!==h)btaFail('executor_changed');
const generationReader=native.generations.map(g=>({source:file(path.join(root,g.source.path)),library:file(path.join(root,g.library.path)),outputs:g.libraryOutputs.map(f=>file(path.join(root,f.path))),snapshots:g.snapshots.map(f=>file(path.join(root,f.path)))}));
const report={schema:'owned-bta-bridge-v2',executionId,sourceHashes,nodeRuntime,executorProcess,build:{input,inputDigest,start,compiler,postInputDigest,output,outputDigest,jar,receipt,receiptDigest,launch},runtimeRefusals:refusals,native,readerChecks,generationReader};
report.manifestBundle=makeBridgeBundle(report);
create(path.join(root,'bridge-report.json'),JSON.stringify(report,null,2)+'\n');
