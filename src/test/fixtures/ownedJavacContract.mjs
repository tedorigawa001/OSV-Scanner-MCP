// Test-only construction contract. Does not grant image/loader trust or enable production import.
import {canonicalBytes,objectDigest,sha256} from './ownedManifestContract.mjs';
import {buildCases,expectedSourceHashes,javacRecipe,javacRecipeDigest} from './ownedJavacExpected.mjs';
import {inflateRawSync,deflateRawSync} from 'node:zlib';
export const buildFail=(reason='schema_invalid')=>{throw Error('owned_javac_'+reason);};
const require=(ok,reason='claim_mismatch')=>{if(!ok)buildFail(reason);};
function exact(o,required,optional=[]){require(o&&typeof o==='object'&&!Array.isArray(o)&&required.every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>[...required,...optional].includes(k)),'schema_invalid');}
const same=(a,b)=>objectDigest(a)===objectDigest(b);
export function verifyRequestedRecipe(recipe){try{if(!same(recipe,javacRecipe))buildFail('recipe_invalid');}catch{buildFail('recipe_invalid');}return true;}
export function safeEntry(p){require(typeof p==='string'&&p.length>0&&!/^[\\/]|^[a-zA-Z]:|[\\\u0000]/.test(p)&&!p.split('/').some(x=>!x||x==='.'||x==='..'),'path_invalid');}
export function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
/** Closed ZIP writer: stored files only, no clock-dependent metadata or implicit entries. */
export function createJar(entries){const locals=[],central=[];let offset=0;for(const {path,bytes,compression}of entries){const name=Buffer.from(path),raw=Buffer.from(bytes),method=compression==='deflate'?8:0,body=method===8?deflateRawSync(raw):raw,crc=crc32(raw),l=Buffer.alloc(30),c=Buffer.alloc(46);l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt16LE(0x800,6);l.writeUInt16LE(method,8);l.writeUInt32LE(crc,14);l.writeUInt32LE(body.length,18);l.writeUInt32LE(raw.length,22);l.writeUInt16LE(name.length,26);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(method,10);c.writeUInt32LE(crc,16);c.writeUInt32LE(body.length,20);c.writeUInt32LE(raw.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE(offset,42);locals.push(l,name,body);central.push(c,name);offset+=l.length+name.length+body.length;}const cd=Buffer.concat(central),e=Buffer.alloc(22);e.writeUInt32LE(0x06054b50);e.writeUInt16LE(entries.length,8);e.writeUInt16LE(entries.length,10);e.writeUInt32LE(cd.length,12);e.writeUInt32LE(offset,16);return Buffer.concat([...locals,cd,e]);}
/** Bounded inventory without extraction. Local and central records must agree. ZIP64/comments rejected. */
export function inspectJar(bytes){
 require(Buffer.isBuffer(bytes)&&bytes.length>=22&&bytes.length<=javacRecipe.maxTotalBytes,'budget_exceeded');
 const end=bytes.length-22;require(bytes.readUInt32LE(end)===0x06054b50&&bytes.readUInt16LE(end+20)===0,'inventory_mismatch');
 const n=bytes.readUInt16LE(end+10),start=bytes.readUInt32LE(end+16),size=bytes.readUInt32LE(end+12);require(n<=javacRecipe.maxEntries,'budget_exceeded');
 require(bytes.readUInt16LE(end+4)===0&&bytes.readUInt16LE(end+6)===0&&bytes.readUInt16LE(end+8)===n&&start+size===end,'inventory_mismatch');
 let at=start,localEnd=0,total=0;const result=[],names=new Set();
 for(let i=0;i<n;i++){
  require(at+46<=end&&bytes.readUInt32LE(at)===0x02014b50,'inventory_mismatch');
  const method=bytes.readUInt16LE(at+10),flags=bytes.readUInt16LE(at+8),packed=bytes.readUInt32LE(at+20),length=bytes.readUInt32LE(at+24),nl=bytes.readUInt16LE(at+28),xl=bytes.readUInt16LE(at+30),cl=bytes.readUInt16LE(at+32),offset=bytes.readUInt32LE(at+42);
  require(length<=javacRecipe.maxFileBytes&&(total+=length)<=javacRecipe.maxTotalBytes,'budget_exceeded');
  require(flags===0x800&&[0,8].includes(method)&&at+46+nl+xl+cl<=end&&xl===0&&cl===0&&bytes.readUInt16LE(at+34)===0&&offset===localEnd,'inventory_mismatch');
  const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(at+46,at+46+nl));safeEntry(name);require(!names.has(name)&&![...names].some(p=>p.startsWith(name+'/')||name.startsWith(p+'/')),'inventory_mismatch');names.add(name);
  require(offset+30<=start&&bytes.readUInt32LE(offset)===0x04034b50&&bytes.readUInt16LE(offset+6)===flags&&bytes.readUInt16LE(offset+8)===method&&bytes.readUInt32LE(offset+14)===bytes.readUInt32LE(at+16)&&bytes.readUInt32LE(offset+18)===packed&&bytes.readUInt32LE(offset+22)===length,'inventory_mismatch');
  const ln=bytes.readUInt16LE(offset+26),le=bytes.readUInt16LE(offset+28),bodyAt=offset+30+ln+le;require(ln===nl&&le===0&&bodyAt+packed<=start&&bytes.subarray(offset+30,bodyAt).equals(Buffer.from(name)),'inventory_mismatch');
  const stored=bytes.subarray(bodyAt,bodyAt+packed),body=method===0?stored:inflateRawSync(stored,{maxOutputLength:javacRecipe.maxFileBytes});require(body.length===length&&crc32(body)===bytes.readUInt32LE(at+16),'inventory_mismatch');
  result.push({path:name,size:body.length,sha256:sha256(body),bytes:body.toString('base64')});localEnd=bodyAt+packed;at+=46+nl+xl+cl;
 }
 require(at===end&&localEnd===start,'inventory_mismatch');return result;
}
export function verifyInventory(inv){exact(inv,['directories','files']);require(Array.isArray(inv.directories)&&Array.isArray(inv.files)&&inv.files.length+inv.directories.length<=javacRecipe.maxEntries,'inventory_mismatch');let total=0;const names=new Set();for(const p of inv.directories){safeEntry(p);require(!names.has(p),'inventory_mismatch');names.add(p);}for(const f of inv.files){exact(f,['path','size','sha256','bytes']);safeEntry(f.path);const bytes=Buffer.from(f.bytes,'base64');require(bytes.toString('base64')===f.bytes&&bytes.length===f.size&&sha256(bytes)===f.sha256,'content_mismatch');require(f.size<=javacRecipe.maxFileBytes&&(total+=f.size)<=javacRecipe.maxTotalBytes,'budget_exceeded');require(!names.has(f.path)&&!inv.files.some(x=>x!==f&&x.path===f.path),'inventory_mismatch');names.add(f.path);}return inv;}
export function expectedArgs(sources){return ['-encoding','UTF-8','--release','21','-proc:none','-implicit:none','-g:none','-classpath','<case>/empty-classpath','-sourcepath','<case>/empty-sourcepath','-d','<output>',...Object.keys(sources).map(p=>'<case>/src/'+p)];}
export function verifyBuildCase(c,policy){
 exact(c,['schema','case','executionId','buildInvocationId','recipeDigest','buildState','events','compilerCalls','artifactCalls','exported','sourceCaptures'],['inputManifest','inputManifestDigest','outputStart','compiler','postInputs','outputSet','outputSetDigest','partialOutput','packaging','execution','buildReceipt','buildReceiptDigest','index','failureStage','failurePhase','failureReason','previousRootUnchanged','previousRootCheck','sourceRemoval','policyAttempt','failureEvidence']);
 require(c.schema==='osv-mcp.gradle-owned-javac-case-v1'&&Object.hasOwn(buildCases,c.case)&&c.executionId===policy.executionId&&c.buildInvocationId===policy.executionId+':'+c.case&&c.recipeDigest===javacRecipeDigest);
 require(Array.isArray(c.events)&&c.events.every((x,i)=>x.sequence===i&&typeof x.event==='string'),'schema_invalid');
 for(const e of c.events)exact(e,e.event==='refused'?['sequence','event','phase','reason']:['sequence','event']);
 if(c.outputStart){exact(c.outputStart,['path','createdNew','token','checks']);require(Array.isArray(c.outputStart.checks));for(const x of c.outputStart.checks)exact(x,['point','token','entries']);}
 if(c.compiler)exact(c.compiler,['exitCode','stdout','stderr','args','environment','executableSha256','inputDigest','outputToken']);
 if(c.postInputs)exact(c.postInputs,['point','matched','digest','currentInventory']);
 if(c.outputSet){exact(c.outputSet,['schema','buildInvocationId','token','inventory']);require(c.outputSet.schema==='osv-mcp.gradle-owned-javac-output-v1');}
 if(c.packaging){exact(c.packaging,['outputSetDigest','jar','entries']);exact(c.packaging.jar,['size','sha256','bytes']);require(Array.isArray(c.packaging.entries));for(const e of c.packaging.entries){exact(e,['path','sha256','origin']);exact(e.origin,['kind','digest']);}}
 if(c.execution)exact(c.execution,['exitCode','stdout','stderr','args','beforeDigest','afterDigest','executableSha256']);
 if(c.previousRootCheck)exact(c.previousRootCheck,['fromCase','before','after']);
 if(c.sourceRemoval)exact(c.sourceRemoval,['path','sha256','removed']);
 if(c.policyAttempt)exact(c.policyAttempt,['kind','value']);

 require(c.compilerCalls===(c.compiler?1:0)&&c.artifactCalls===(c.execution?1:0));
 const target=buildCases[c.case];require(c.buildState===(target?'failed':'completed'));
 if(target)require(same([c.failureStage,c.failurePhase,c.failureReason],target));else require(!['failureStage','failurePhase','failureReason','partialOutput'].some(k=>Object.hasOwn(c,k)));
 const order=['policy','capture','seal','allocate-output','verify-empty','compiler','verify-inputs','collect-output','packaging','runtime-precheck','execute','runtime-postcheck','save'];
 const last=target?order.indexOf(c.failurePhase):order.length-1;require(last>=0);
 require(same(c.events.map(e=>e.event),[...order.slice(0,last+1),...(target?['refused']:[])]));
 const compilerReached=last>=order.indexOf('compiler'),executionReached=last>=order.indexOf('execute');
 require(c.compilerCalls===(compilerReached?1:0)&&c.artifactCalls===(executionReached?1:0));
 require(c.sourceCaptures===(last===0?0:last===1?1:last<6?2:3));
 require(Boolean(c.inputManifest)===(last>=2));
 if(last>=2)require(c.postInputs);
 if(c.compiler)require(c.compiler.exitCode===(['compiler-partial','implicit-source-blocked'].includes(c.case)?1:0));
 if(last<7)require(!c.outputSet&&!c.outputSetDigest);if(last<8)require(!c.packaging);
 if(last>=8)require(c.outputSet);
 if(last>=9)require(c.packaging);
 if(['index-save-failed','state-save-failed'].includes(c.case))require(c.execution&&c.exported===false&&c.failureEvidence?.saveTarget===(c.case==='index-save-failed'?'index':'state')&&c.failureEvidence.wasDirectory===true);
 if(last===0){require(c.policyAttempt?.kind===c.case&&c.sourceCaptures===0);let refused=false;try{verifyRequestedRecipe(c.policyAttempt.value);}catch(e){refused=e.message==='owned_javac_recipe_invalid';}require(refused);}
 if(c.case==='unregistered-source'){verifyInventory(c.failureEvidence?.sourceInventory);require(c.failureEvidence.sourceInventory.files.some(f=>f.path==='Extra.java'));}
 if(c.outputStart){require(c.outputStart.createdNew===true&&c.outputStart.path==='outputs/'+c.case&&typeof c.outputStart.token==='string'&&c.outputStart.checks[0]?.token===c.outputStart.token&&c.outputStart.checks[0]?.point==='created'&&c.outputStart.checks[0]?.entries===0);}
 if(c.case.startsWith('inject-')){exact(c.failureEvidence,['observedEntry','enumerated']);}if(c.case.startsWith('inject-'))require(c.failureEvidence?.enumerated===1&&typeof c.failureEvidence.observedEntry==='string'&&c.outputStart?.checks.length===1);
 if(c.case==='replace-root')require(c.failureEvidence?.createdToken===c.outputStart?.token&&c.failureEvidence.currentToken!==c.outputStart?.token);
 if(['existing-empty','existing-file','existing-symlink','retry-partial-root'].includes(c.case))require(c.failureEvidence?.exists===true);
 if(c.case==='ancestor-symlink')require(c.failureEvidence?.symlinkAncestor===true);
 if(['extra-output','missing-output'].includes(c.case)){verifyInventory(c.failureEvidence?.observedInventory);const paths=c.failureEvidence.observedInventory.files.map(f=>f.path);require(c.case==='extra-output'?paths.includes('Unexpected.class'):!paths.includes('Driver$Inner.class'));}
 if(c.case==='artifact-changed'){const e=c.failureEvidence;require(e&&sha256(Buffer.from(e.artifactBytes,'base64'))===e.sha256&&e.sha256!==c.packaging?.jar.sha256);}
 if(c.case==='packaging-save-failed')require(c.failureEvidence?.createNew===true&&c.failureEvidence.preservedDigest===sha256('pre-existing artifact')&&c.failureEvidence.afterDigest===c.failureEvidence.preservedDigest);

 if(c.case==='input-alias')require(c.failureEvidence?.inputAlias===true);

 if(c.inputManifest){const m=c.inputManifest;exact(m,['schema','buildInvocationId','recipeDigest','sourceInventory','environment','arguments','emptyInputs','toolchain','executorHashes','nodeRuntime']);require(m.schema==='osv-mcp.gradle-owned-javac-input-v1'&&m.buildInvocationId===c.buildInvocationId&&m.recipeDigest===javacRecipeDigest&&objectDigest(m)===c.inputManifestDigest);
  verifyInventory(m.sourceInventory);require(same(m.sourceInventory.files.map(f=>[f.path,f.sha256]).sort(),Object.entries(expectedSourceHashes(c.case)).sort()),'source_mismatch');
  require(same(m.sourceInventory.directories,['日本語 空白']),'inventory_mismatch');
  require(same(m.environment,javacRecipe.environment)&&same(m.arguments,expectedArgs(expectedSourceHashes(c.case)))&&same(m.emptyInputs,{classpath:[],sourcepath:[],modulepath:[],processors:[],generators:[],resources:[]}));
  require(same(m.nodeRuntime,policy.nodeRuntime),'profile_mismatch');
  require(same(m.executorHashes,policy.executorHashes)&&same(m.toolchain,{java:policy.java,javac:policy.javac,imageAssurance:'unavailable'}),'profile_mismatch');
 }
 if(c.postInputs){verifyInventory(c.postInputs.currentInventory);const current={...c.inputManifest,sourceInventory:c.postInputs.currentInventory};const actualMatched=same(current,c.inputManifest);require(c.postInputs.point===(['source-after-seal','source-added-after-seal','source-missing-after-seal'].includes(c.case)||last<6?'precompiler':'postcompiler'));require(c.postInputs.digest===objectDigest(current)&&c.postInputs.matched===actualMatched);if(['source-after-seal','source-added-after-seal','source-missing-after-seal','source-post-compile'].includes(c.case))require(actualMatched===false);else require(actualMatched===true);}
 if(c.compiler){require(c.inputManifest&&c.outputStart);require(c.outputStart.createdNew===true&&c.outputStart.checks.length===2&&c.outputStart.checks.every((x,i)=>x.point===['created','precompiler'][i]&&x.token===c.outputStart.token&&x.entries===0));require(c.compiler.inputDigest===c.inputManifestDigest&&c.compiler.outputToken===c.outputStart.token&&same(c.compiler.args,c.inputManifest.arguments)&&same(c.compiler.environment,c.inputManifest.environment)&&c.compiler.executableSha256===policy.javac);}
 if(c.packaging&&c.buildState==='failed'){
  const bytes=Buffer.from(c.packaging.jar.bytes,'base64');require(bytes.length===c.packaging.jar.size&&sha256(bytes)===c.packaging.jar.sha256,'content_mismatch');
  if(c.failurePhase==='packaging'){
   let refusal;try{const entries=inspectJar(bytes),allowed=[{path:'META-INF/MANIFEST.MF',size:Buffer.byteLength(javacRecipe.manifest),sha256:sha256(javacRecipe.manifest),bytes:Buffer.from(javacRecipe.manifest).toString('base64')},...c.outputSet.inventory.files];if(!same(entries,allowed))refusal='inventory_mismatch';}catch(e){refusal=e.message.replace('owned_javac_','');}
   require(refusal===c.failureReason,'claim_mismatch');
  }
 }
 if(c.execution){require(c.execution.exitCode===0&&c.execution.beforeDigest===c.packaging?.jar.sha256&&c.execution.afterDigest===c.packaging.jar.sha256&&c.execution.executableSha256===policy.java&&c.execution.stdout==='owned-driver:'+(c.case==='rebuild-no-removed'?'two':'one')+':inner\n'&&c.execution.stderr===''&&same(c.execution.args,['-cp','<artifact>','Driver','<artifact>']));}
 if(c.partialOutput){verifyInventory(c.partialOutput);require(c.buildState==='failed'&&!c.buildReceipt&&!c.packaging&&!c.execution);}
 if(c.outputSet){verifyInventory(c.outputSet.inventory);require(c.compiler?.exitCode===0&&c.outputSet.token===c.outputStart.token&&c.outputSet.buildInvocationId===c.buildInvocationId&&objectDigest(c.outputSet)===c.outputSetDigest);}
 if(c.buildState==='completed'){
  require(c.inputManifest&&c.compiler?.exitCode===0&&c.postInputs?.matched===true&&c.postInputs.digest===c.inputManifestDigest&&c.outputSet&&c.packaging&&c.execution&&c.buildReceipt&&c.index&&c.exported);
  const names=['Driver$Inner.class','Driver.class',...(c.case!=='rebuild-no-removed'?['Driver$Removed.class','Retired.class','Retired$Nested.class']:[])].sort();require(same(c.outputSet.inventory.files.map(f=>f.path).sort(),names)&&c.outputSet.inventory.directories.length===0,'inventory_mismatch');
  require(c.packaging.outputSetDigest===c.outputSetDigest);const jarBytes=Buffer.from(c.packaging.jar.bytes,'base64');require(sha256(jarBytes)===c.packaging.jar.sha256&&jarBytes.length===c.packaging.jar.size,'content_mismatch');const entries=inspectJar(jarBytes);
  const expectedEntries=[{path:'META-INF/MANIFEST.MF',bytes:Buffer.from(javacRecipe.manifest).toString('base64'),size:Buffer.byteLength(javacRecipe.manifest),sha256:sha256(javacRecipe.manifest)},...c.outputSet.inventory.files];require(same(entries,expectedEntries),'inventory_mismatch');
  require(same(c.packaging.entries,entries.map(e=>({path:e.path,sha256:e.sha256,origin:e.path==='META-INF/MANIFEST.MF'?{kind:'recipe-literal',digest:javacRecipeDigest}:{kind:'compiler-output',digest:c.outputSetDigest}}))),'inventory_mismatch');
  require(c.execution.exitCode===0&&c.execution.stdout==='owned-driver:'+(c.case==='rebuild-no-removed'?'two':'one')+':inner\n'&&c.execution.stderr===''&&c.execution.beforeDigest===c.packaging.jar.sha256&&c.execution.afterDigest===c.packaging.jar.sha256&&c.execution.executableSha256===policy.java&&same(c.execution.args,['-cp','<artifact>','Driver','<artifact>']));
  require(same(c.buildReceipt,{schema:'osv-mcp.gradle-owned-javac-receipt-v1',buildInvocationId:c.buildInvocationId,inputManifestRef:c.inputManifestDigest,outputSetRef:c.outputSetDigest,artifactDigest:c.packaging.jar.sha256,compilerExitCode:0,executionScope:'owned-java-main-only',naturalContentBinding:false})&&objectDigest(c.buildReceipt)===c.buildReceiptDigest);
  require(same(c.index,[{role:'input-manifest',digest:c.inputManifestDigest},{role:'output-set',digest:c.outputSetDigest},{role:'build-receipt',digest:c.buildReceiptDigest}]),'inventory_mismatch');
  require(c.events.map(x=>x.event).join(',')==='policy,capture,seal,allocate-output,verify-empty,compiler,verify-inputs,collect-output,packaging,runtime-precheck,execute,runtime-postcheck,save');
 }else{
  require(!c.buildReceipt&&!c.buildReceiptDigest&&!c.index);if(!['index-save-failed','state-save-failed'].includes(c.case))require(!c.execution);
  require(c.events.at(-1)?.event==='refused'&&c.events.at(-1)?.phase===c.failurePhase);
  require(c.exported===!['index-save-failed','state-save-failed'].includes(c.case));
 }
 if(c.case==='compiler-partial')require(c.compiler?.exitCode!==0&&c.partialOutput.files.some(f=>f.path==='Good.class'));
 if(c.case==='rebuild-no-removed'){require(c.sourceRemoval?.path==='Retired.java'&&c.sourceRemoval.removed===true&&!c.inputManifest.sourceInventory.files.some(f=>f.path==='Retired.java'));}
 if(c.case==='rebuild-no-removed'||c.case==='retry-partial-root'||c.case==='retry-fresh'){require(c.previousRootUnchanged===true&&c.previousRootCheck);verifyInventory(c.previousRootCheck.before);verifyInventory(c.previousRootCheck.after);require(same(c.previousRootCheck.before,c.previousRootCheck.after));}
 return {builds:c.compilerCalls,executions:c.artifactCalls,completed:c.buildState==='completed'?1:0,refused:c.buildState==='failed'?1:0,productionAdopted:0,naturalReceipts:0};
}
