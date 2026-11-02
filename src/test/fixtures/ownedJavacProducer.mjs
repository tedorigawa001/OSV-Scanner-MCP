// Owned, closed test executor. No Gradle Provider/FileCollection/KGP getter is called here.
import * as fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {canonicalBytes,objectDigest,sha256} from './ownedManifestContract.mjs';
import {buildCases,expectedSources,expectedSourceHashes,javacRecipe,javacRecipeDigest,javacSources,executorEnvironment} from './ownedJavacExpected.mjs';
import {buildFail,createJar,inspectJar,expectedArgs,verifyRequestedRecipe,codeUnitOrder} from './ownedJavacContract.mjs';
import {ownerJdkProfile} from './gradleSnapshotOwnerExpected.mjs';
const [workspace,jdk,executionId]=process.argv.slice(2);
if(!workspace||!jdk||!executionId)throw Error('usage: workspace jdk executionId');
const root=fs.realpathSync(workspace),repo=fileURLToPath(new URL('../../../',import.meta.url));
const tokens=new Map();let tokenSequence=0;
const key=s=>s.dev+':'+s.ino+':'+s.birthtimeNs;
const token=p=>{const k=key(fs.lstatSync(p,{bigint:true}));if(!tokens.has(k))tokens.set(k,'entity-'+(++tokenSequence));return tokens.get(k);};
const relative=p=>path.relative(root,p).split(path.sep).join('/');
function guard(p){const rel=path.relative(root,p);if(rel==='..'||rel.startsWith('../')||path.isAbsolute(rel))buildFail('path_invalid');let at=root;for(const part of rel.split(path.sep).filter(Boolean)){at=path.join(at,part);const s=fs.lstatSync(at);if(s.isSymbolicLink())buildFail('path_invalid');}return p;}
function mkdir(p){guard(path.dirname(p));fs.mkdirSync(p);guard(p);}
function writeNew(p,b){guard(path.dirname(p));const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,b);}finally{fs.closeSync(fd);}}
function read(p){guard(p);const before=fs.lstatSync(p,{bigint:true});if(!before.isFile()||before.size>BigInt(javacRecipe.maxFileBytes))buildFail('budget_exceeded');const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const opened=fs.fstatSync(fd,{bigint:true});if(key(opened)!==key(before))buildFail('input_changed');const b=Buffer.alloc(javacRecipe.maxFileBytes+1);let n=0,k;while(n<b.length&&(k=fs.readSync(fd,b,n,b.length-n,null)))n+=k;if(n>javacRecipe.maxFileBytes)buildFail('budget_exceeded');if(key(fs.fstatSync(fd,{bigint:true}))!==key(before)||key(fs.lstatSync(p,{bigint:true}))!==key(before))buildFail('input_changed');return b.subarray(0,n);}finally{fs.closeSync(fd);}}
function inventory(dir){guard(dir);const directories=[],files=[];let count=0,total=0;function walk(at){const d=fs.opendirSync(at);try{let e;while((e=d.readSync())){if(++count>javacRecipe.maxEntries)buildFail('budget_exceeded');const p=path.join(at,e.name);guard(p);if(e.isDirectory()){directories.push(path.relative(dir,p).split(path.sep).join('/'));walk(p);}else if(e.isFile()){const b=read(p);total+=b.length;if(total>javacRecipe.maxTotalBytes)buildFail('budget_exceeded');files.push({path:path.relative(dir,p).split(path.sep).join('/'),size:b.length,sha256:sha256(b),bytes:b.toString('base64')});}else buildFail('path_invalid');}}finally{d.closeSync();}}walk(dir);directories.sort(codeUnitOrder);files.sort((a,b)=>codeUnitOrder(a.path,b.path));return {directories,files};}
function same(a,b){return objectDigest(a)===objectDigest(b);}
const executableHashes={java:sha256(fs.readFileSync(path.join(jdk,'bin/java'))),javac:sha256(fs.readFileSync(path.join(jdk,'bin/javac')))};
if(executableHashes.java!==ownerJdkProfile.java.sha256||executableHashes.javac!==ownerJdkProfile.javac.sha256)throw Error('unapproved-executables');
const nodeRuntime={sha256:sha256(fs.readFileSync(process.execPath)),version:process.version,platform:process.platform,arch:process.arch};
const executorHashes=Object.fromEntries(javacSources.map(f=>[f,sha256(fs.readFileSync(path.join(repo,f)))]));
const cases=[];let successfulRoot,successfulInventory,partialRoot,partialInventory;
mkdir(path.join(root,'cases'));mkdir(path.join(root,'outputs'));mkdir(path.join(root,'evidence'));
for(const name of Object.keys(buildCases)){
 const base=path.join(root,'cases',name);mkdir(base);const sourceRoot=path.join(base,'src');mkdir(sourceRoot);mkdir(path.join(sourceRoot,'日本語 空白'));mkdir(path.join(base,'empty-classpath'));mkdir(path.join(base,'empty-sourcepath'));
 const sources=expectedSources(name);for(const [p,b]of Object.entries(sources))writeNew(path.join(sourceRoot,p),b);
 const c={schema:'osv-mcp.gradle-owned-javac-case-v1',case:name,executionId,buildInvocationId:executionId+':'+name,recipeDigest:javacRecipeDigest,buildState:'pending',events:[],compilerCalls:0,artifactCalls:0,exported:false,sourceCaptures:0};
 const audit=event=>c.events.push({sequence:c.events.length,event});let phase='policy',stage='prepare';let output=path.join(root,'outputs',name);
 if(name==='rebuild-no-removed'){const p=path.join(sourceRoot,'Retired.java'),b=expectedSources('normal-inner')['Retired.java'];writeNew(p,b);const digest=sha256(read(p));fs.unlinkSync(p);c.sourceRemoval={path:'Retired.java',sha256:digest,removed:!fs.existsSync(p)};}
 const artifact=path.join(base,'driver.jar');
 // Replace the longest paths first so nested roots keep their own tokens.
 const logical=p=>[[artifact,'<artifact>'],[output,'<output>'],[base,'<case>'],[root,'<workspace>'],[jdk,'<jdk>']].sort((a,b)=>b[0].length-a[0].length).reduce((s,[from,to])=>s.split(from).join(to),p);
 function processRun(kind,args){const executable=path.join(jdk,'bin',kind),r=spawnSync(executable,args,{cwd:base,env:{...javacRecipe.environment},encoding:'utf8',maxBuffer:1048576,timeout:30000});if(r.error||r.signal||r.status===null)buildFail('execution_failed');if(sha256(fs.readFileSync(executable))!==executableHashes[kind])buildFail('input_changed');return {exitCode:r.status,stdout:logical(r.stdout),stderr:logical(r.stderr)};}
 function capture(){c.sourceCaptures++;return inventory(sourceRoot);}
 function compareInputs(point){const currentInventory=capture(),candidate={...c.inputManifest,sourceInventory:currentInventory};const matched=same(candidate,c.inputManifest)&&same(inventory(path.join(base,'empty-classpath')),{directories:[],files:[]})&&same(inventory(path.join(base,'empty-sourcepath')),{directories:[],files:[]});c.postInputs={point,matched,digest:objectDigest(candidate),currentInventory};if(!matched)buildFail('input_changed');}
 try{
  audit('policy');
  const requestedRecipe=structuredClone(javacRecipe);
  if(name==='processor-enabled')requestedRecipe.processorPolicy='full';
  if(name==='implicit-source-enabled')requestedRecipe.sourcepath=['src'];
  if(name==='unregistered-argfile')requestedRecipe.argumentFile='unknown.args';
  if(name==='unregistered-generator')requestedRecipe.generators=['unknown-generator'];
  if(!same(requestedRecipe,javacRecipe))c.policyAttempt={kind:name,value:requestedRecipe};
  verifyRequestedRecipe(requestedRecipe);
  phase='capture';audit('capture');if(name==='unregistered-source')writeNew(path.join(sourceRoot,'Extra.java'),'class Extra {}\n');
  const sourceInventory=capture();if(!same(sourceInventory.files.map(f=>[f.path,f.sha256]).sort(),Object.entries(expectedSourceHashes(name)).sort())){c.failureEvidence={sourceInventory};buildFail('inventory_mismatch');}
  c.inputManifest={schema:'osv-mcp.gradle-owned-javac-input-v1',buildInvocationId:c.buildInvocationId,recipeDigest:javacRecipeDigest,sourceInventory,environment:javacRecipe.environment,arguments:expectedArgs(sources),emptyInputs:{classpath:[],sourcepath:[],modulepath:[],processors:[],generators:[],resources:[]},toolchain:{...executableHashes,imageAssurance:'unavailable'},executorHashes,nodeRuntime};c.inputManifestDigest=objectDigest(c.inputManifest);
  const evidence=path.join(root,'evidence',name);mkdir(evidence);writeNew(path.join(evidence,'input.json'),canonicalBytes(c.inputManifest));
  phase='seal';audit('seal');if(name==='source-after-seal')fs.appendFileSync(path.join(sourceRoot,Object.keys(sources)[0]),'// changed after seal\n');if(name==='source-added-after-seal')writeNew(path.join(sourceRoot,'Added.java'),'class Added {}\n');if(name==='source-missing-after-seal')fs.unlinkSync(path.join(sourceRoot,'Retired.java'));compareInputs('precompiler');
  stage='build';phase='allocate-output';audit('allocate-output');
  if(name==='existing-empty')mkdir(output);
  if(name==='existing-file')writeNew(output,'old');
  if(name==='existing-symlink')fs.symlinkSync(sourceRoot,output);
  if(name==='ancestor-symlink'){const parent=path.join(root,'outputs','alias');fs.symlinkSync(base,parent);output=path.join(parent,'out');}
  if(name==='input-alias')output=sourceRoot;
  if(name==='retry-partial-root')output=partialRoot;
  try{guard(path.dirname(output));}catch{c.failureEvidence={symlinkAncestor:true};buildFail('output_root_invalid');}
  if([sourceRoot,path.join(base,'empty-classpath'),path.join(base,'empty-sourcepath')].some(p=>output===p||output.startsWith(p+path.sep)||p.startsWith(output+path.sep))){c.failureEvidence={inputAlias:true};buildFail('output_root_invalid');}
  if(fs.existsSync(output)||(()=>{try{fs.lstatSync(output);return true;}catch(e){if(e.code!=='ENOENT')throw e;return false;}})()){c.failureEvidence={exists:true};buildFail('output_root_exists');}
  mkdir(output);const outputToken=token(output);c.outputStart={path:relative(output),createdNew:true,token:outputToken,checks:[{point:'created',token:outputToken,entries:0}]};
  // Establish empty at creation as well as just before compiler invocation.
  {const d=fs.opendirSync(output);try{if(d.readSync())buildFail('output_root_not_empty');}finally{d.closeSync();}}
  phase='verify-empty';audit('verify-empty');
  if(name==='replace-root'){fs.renameSync(output,output+'-original');mkdir(output);}
  if(name==='inject-class')writeNew(path.join(output,'Old.class'),'old');
  if(name==='inject-resource')writeNew(path.join(output,'resource.txt'),'old');
  if(name==='inject-hidden')writeNew(path.join(output,'.old'),'old');
  if(name==='inject-directory')mkdir(path.join(output,'old'));
  if(name==='inject-symlink')fs.symlinkSync(path.join(sourceRoot,Object.keys(sources)[0]),path.join(output,'link'));
  if(token(output)!==outputToken){c.failureEvidence={createdToken:outputToken,currentToken:token(output)};buildFail('output_root_invalid');}
  {const d=fs.opendirSync(output);try{const e=d.readSync();if(e){c.failureEvidence={observedEntry:e.name,enumerated:1};buildFail('output_root_not_empty');}}finally{d.closeSync();}}
  c.outputStart.checks.push({point:'precompiler',token:token(output),entries:0});
  if(name==='implicit-source-blocked')writeNew(path.join(base,'Hidden.java'),'class Hidden {}\n');
  phase='compiler';audit('compiler');
  const args=c.inputManifest.arguments.map(a=>a.replace('<case>',base).replace('<output>',output));c.compilerCalls++;
  const result=processRun('javac',args);c.compiler={...result,args:c.inputManifest.arguments,environment:javacRecipe.environment,executableSha256:executableHashes.javac,inputDigest:c.inputManifestDigest,outputToken};
  if(result.exitCode!==0){c.partialOutput=inventory(output);if(name==='compiler-partial'){partialRoot=output;partialInventory=c.partialOutput;}buildFail('build_failed');}
  phase='verify-inputs';audit('verify-inputs');if(name==='source-post-compile')fs.appendFileSync(path.join(sourceRoot,Object.keys(sources)[0]),'// changed after compiler\n');compareInputs('postcompiler');
  phase='collect-output';audit('collect-output');
  if(name==='extra-output')writeNew(path.join(output,'Unexpected.class'),Buffer.from('cafebabe','hex'));
  if(name==='missing-output')fs.unlinkSync(path.join(output,'Driver$Inner.class'));
  if(token(output)!==outputToken){c.failureEvidence={createdToken:outputToken,currentToken:token(output)};buildFail('output_root_invalid');}
  const outputInventory=inventory(output),expectedNames=['Driver.class','Driver$Inner.class',...(name==='rebuild-no-removed'?[]:['Driver$Removed.class','Retired.class','Retired$Nested.class'])].sort();
  if(!same(outputInventory.files.map(f=>f.path).sort(),expectedNames)||outputInventory.directories.length){c.failureEvidence={observedInventory:outputInventory};buildFail('inventory_mismatch');}
  c.outputSet={schema:'osv-mcp.gradle-owned-javac-output-v1',buildInvocationId:c.buildInvocationId,token:outputToken,inventory:outputInventory};c.outputSetDigest=objectDigest(c.outputSet);
  phase='packaging';audit('packaging');let entries=[{path:'META-INF/MANIFEST.MF',bytes:Buffer.from(javacRecipe.manifest)},...outputInventory.files.map(f=>({path:f.path,bytes:Buffer.from(f.bytes,'base64')}))];
  if(name==='jar-resource')entries.push({path:'unregistered.txt',bytes:Buffer.from('unknown')});
  if(name==='jar-missing-manifest')entries.shift();
  if(name==='jar-duplicate')entries.push(entries.at(-1));
  if(name==='jar-traversal')entries.push({path:'../escape',bytes:Buffer.from('bad')});
  if(name==='jar-collision')entries.push({path:'META-INF',bytes:Buffer.from('file')});
  if(name==='jar-budget')entries.push({path:'large',bytes:Buffer.alloc(javacRecipe.maxFileBytes+1),compression:'deflate'});
  if(name==='jar-provenance')entries[0]={path:'META-INF/MANIFEST.MF',bytes:Buffer.from('Manifest-Version: 2.0\r\n\r\n')};
  if(name==='packaging-save-failed'){writeNew(artifact,'pre-existing artifact');c.failureEvidence={createNew:true,preservedDigest:sha256(read(artifact))};}
  const jar=createJar(entries);try{writeNew(artifact,jar);}catch{if(c.failureEvidence)c.failureEvidence.afterDigest=sha256(read(artifact));buildFail('storage_failed');}
  c.packaging={outputSetDigest:c.outputSetDigest,jar:{size:jar.length,sha256:sha256(jar),bytes:jar.toString('base64')},entries:[]};
  const actual=inspectJar(jar),allowed=[{path:'META-INF/MANIFEST.MF',size:Buffer.byteLength(javacRecipe.manifest),sha256:sha256(javacRecipe.manifest),bytes:Buffer.from(javacRecipe.manifest).toString('base64')},...outputInventory.files];
  if(!same(actual,allowed))buildFail('inventory_mismatch');
  c.packaging.entries=actual.map(e=>({path:e.path,sha256:e.sha256,origin:e.path==='META-INF/MANIFEST.MF'?{kind:'recipe-literal',digest:javacRecipeDigest}:{kind:'compiler-output',digest:c.outputSetDigest}}));
  phase='runtime-precheck';audit('runtime-precheck');if(name==='artifact-changed')fs.appendFileSync(artifact,'changed');
  const artifactBefore=read(artifact);if(sha256(artifactBefore)!==c.packaging.jar.sha256){c.failureEvidence={artifactBytes:artifactBefore.toString('base64'),sha256:sha256(artifactBefore)};buildFail('input_changed');}
  if(!same(inventory(output),outputInventory))buildFail('input_changed');
  phase='execute';audit('execute');c.artifactCalls++;const run=processRun('java',['-cp',artifact,'Driver',artifact]);
  if(run.exitCode!==0)buildFail('execution_failed');
  phase='runtime-postcheck';audit('runtime-postcheck');const afterDigest=sha256(read(artifact));if(afterDigest!==c.packaging.jar.sha256)buildFail('input_changed');
  c.execution={...run,args:['-cp','<artifact>','Driver','<artifact>'],beforeDigest:sha256(artifactBefore),afterDigest,executableSha256:executableHashes.java};
  phase='save';audit('save');
  if(name==='index-save-failed'||name==='state-save-failed'){
   // CREATE_NEW a metadata file at an already occupied directory: a real native save failure.
   const destination=path.join(evidence,name==='index-save-failed'?'index.json':'state.json');mkdir(destination);c.failureEvidence={saveTarget:name==='index-save-failed'?'index':'state',wasDirectory:fs.lstatSync(destination).isDirectory()};try{writeNew(destination,'{}');}catch{buildFail('storage_failed');}throw Error('expected native write refusal');
  }
  const receipt={schema:'osv-mcp.gradle-owned-javac-receipt-v1',buildInvocationId:c.buildInvocationId,inputManifestRef:c.inputManifestDigest,outputSetRef:c.outputSetDigest,artifactDigest:c.packaging.jar.sha256,compilerExitCode:0,executionScope:'owned-java-main-only',naturalContentBinding:false};
  writeNew(path.join(evidence,'output.json'),canonicalBytes(c.outputSet));writeNew(path.join(evidence,'receipt.json'),canonicalBytes(receipt));
  c.index=[{role:'input-manifest',digest:c.inputManifestDigest},{role:'output-set',digest:c.outputSetDigest},{role:'build-receipt',digest:objectDigest(receipt)}];writeNew(path.join(evidence,'index.json'),canonicalBytes(c.index));
  c.buildReceipt=receipt;c.buildReceiptDigest=objectDigest(receipt);c.buildState='completed';c.exported=true;
  if(name==='normal-inner'){successfulRoot=output;successfulInventory=outputInventory;}
 }catch(e){
  if(!e.message.startsWith('owned_javac_'))throw e;
  c.buildState='failed';c.failureStage=stage;c.failurePhase=phase;c.failureReason=e.message.slice('owned_javac_'.length);c.events.push({sequence:c.events.length,event:'refused',phase,reason:c.failureReason});c.exported=!['index-save-failed','state-save-failed'].includes(name);
  // A partially generated class/JAR is diagnostic only; no receipt or launch authorization is issued.
 }
 if(name==='rebuild-no-removed'){const after=inventory(successfulRoot);c.previousRootUnchanged=same(after,successfulInventory);c.previousRootCheck={fromCase:'normal-inner',before:successfulInventory,after};}
 if(name==='retry-partial-root'||name==='retry-fresh'){const after=inventory(partialRoot);c.previousRootUnchanged=same(after,partialInventory);c.previousRootCheck={fromCase:'compiler-partial',before:partialInventory,after};}
 cases.push(c);
}
if(sha256(fs.readFileSync(process.execPath))!==nodeRuntime.sha256)throw Error('node executable changed during run');
for(const [f,h]of Object.entries(executorHashes))if(sha256(fs.readFileSync(path.join(repo,f)))!==h)throw Error('executor source changed during run');
fs.writeFileSync(path.join(root,'javac-report.json'),JSON.stringify({schema:'osv-mcp.gradle-owned-javac-native-v2',executionId,executorHashes,executableHashes,nodeRuntime,executorProcess:{environment:Object.fromEntries(Object.entries(process.env).filter(([k])=>Object.hasOwn(executorEnvironment,k))),otherVariables:Object.keys(process.env).filter(k=>!Object.hasOwn(executorEnvironment,k)).sort(codeUnitOrder),execArgv:process.execArgv},cases,limitations:['test-only','no-full-jdk-image-approval','no-transformer-or-loader-proof','no-bta-runtime-or-snapshot-manifest','no-kgp-natural-consumption-receipt','no-concurrent-writer-exclusion','no-production-adoption']},null,2)+'\n',{flag:'wx'});
