import {readFileSync} from 'node:fs';
import {canonicalBytes,objectDigest,sha256} from './ownedManifestContract.mjs';
import {inspectJar} from './ownedJavacContract.mjs';
import {btaDriverProfiles} from './gradleBtaDriverRuntime.mjs';
import {ownerJdkProfile,ownerTupleArtifacts} from './gradleSnapshotOwnerExpected.mjs';
import {btaManifestCases,runtimeRefusals,bridgeSources,bridgeVerificationSources,consumerBytes,libraryBytes} from './ownedBtaManifestExpected.mjs';
export function btaFail(reason='contract_invalid'){throw Error('owned_bta_'+reason);}
const check=(x,reason)=>{if(!x)btaFail(reason);};
const equal=(a,b,reason)=>check(objectDigest(a)===objectDigest(b),reason);
const exact=(o,required,optional=[])=>check(o&&typeof o==='object'&&!Array.isArray(o)&&required.every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>[...required,...optional].includes(k)),'schema_invalid');
export const bridgeFingerprints=files=>Object.fromEntries(files.map(p=>[p,sha256(readFileSync(p))]));
export function runtimeVector(version){const p=btaDriverProfiles[version];check(p);return [...p.runtime,p.runtime.find(x=>x.coordinate.startsWith('org.jetbrains.kotlin:kotlin-stdlib:'))].map((x,i)=>({occurrence:i,coordinate:x.coordinate,path:'runtime/'+i+'.jar',sha256:x.sha256}));}
export function verifyBtaManifestTuple(t){
 check(t?.report&&t.policy&&['Groovy','Kotlin'].includes(t.dsl)&&btaDriverProfiles[t.gradleVersion]);
 const p=t.policy,r=t.report,b=r.build,n=r.native,profile=btaDriverProfiles[t.gradleVersion];
 exact(r,['schema','executionId','sourceHashes','nodeRuntime','executorProcess','build','runtimeRefusals','native','readerChecks','generationReader','manifestBundle']);
 exact(b.input,['schema','buildInvocationId','runtime','source','java','javac','environment','executorHashes']);
 exact(b.output,['schema','buildInvocationId','token','files']);exact(b.receipt,['schema','buildInvocationId','inputManifestRef','outputSetRef','artifactDigest']);
 exact(n,['schema','executionId','buildReceiptRef','actualCompilerVersion','driverOrigin','apiOrigin','implementationOrigin','runtime','actualClasspath','generations','generationRefs','calls','configurationUses','offers','compilerOrigin','runtimeAfter']);
 check(r.schema==='owned-bta-bridge-v2'&&r.executionId===p.executionId&&t.gradle.executionId===p.executionId&&t.gradle.gradleVersion===t.gradleVersion&&t.gradle.actionEntered===true);
 check(t.gradle.gradleApiSha256===ownerTupleArtifacts[t.gradleVersion].gradle&&p.java===ownerJdkProfile.java.sha256&&p.javac===ownerJdkProfile.javac.sha256);
 equal(t.gradle.taskState,{executed:true,didWork:true,skipped:false,noSource:false,failed:false});equal(r.sourceHashes,p.sourceHashes);equal(r.executorProcess,{environment:{TZ:'UTC'},otherVariables:p.nodeRuntime.platform==='darwin'?['__CF_USER_TEXT_ENCODING']:[],execArgv:[]});equal(r.nodeRuntime,p.nodeRuntime);
 check(b.input&&b.output&&b.receipt&&b.jar&&b.compiler?.exitCode===0&&b.launch?.exitCode===0);
 equal(b.input.runtime.map(({size,...v})=>v),runtimeVector(t.gradleVersion));
 check(b.input.buildInvocationId===p.executionId+':driver'&&b.input.java===p.java&&b.input.javac===p.javac&&b.input.source.path==='OwnedBtaManifestDriver.java'&&b.input.source.sha256===p.sourceHashes['src/test/fixtures/OwnedBtaManifestDriver.java']);
 const sourceBytes=Buffer.from(b.input.source.bytes,'base64');check(sourceBytes.length===b.input.source.size&&sha256(sourceBytes)===b.input.source.sha256);equal(b.input.executorHashes,p.sourceHashes);equal(b.input.environment,{LANG:'C',LC_ALL:'C',TZ:'UTC'});
 check(/^entity-[1-9][0-9]*$/.test(b.start.token),'schema_invalid');
 // The harness offered a NODE_OPTIONS preload; the executor must not have run it.
 const inj=t.injection;check(inj&&inj.nodeOptionsOffered===true&&inj.markerCreated===false&&/^[0-9a-f]{64}$/.test(inj.preloadSha256),'claim_mismatch');
 check(b.start.createdNew===true&&b.start.checks.length===2&&b.start.checks.every(x=>x.empty===true&&x.token===b.start.token)&&b.output.token===b.start.token);
 check(b.inputDigest===objectDigest(b.input)&&b.postInputDigest===b.inputDigest&&b.outputDigest===objectDigest(b.output));
 equal(b.compiler.args,['-encoding','UTF-8','--release','21','-proc:none','-implicit:none','-g:none','-classpath',b.input.runtime.map(x=>'$ROOT/'+x.path).join(':'),'-sourcepath','$ROOT/empty-sourcepath','-d','$ROOT/output','$ROOT/OwnedBtaManifestDriver.java']);check(b.compiler.executableSha256===p.javac);
 check(b.output.files.length>=2&&b.output.files.some(f=>f.path==='OwnedBtaManifestDriver.class')&&b.output.files.some(f=>f.path==='OwnedBtaManifestDriver$Binding.class'));
 for(const f of b.output.files){const bytes=Buffer.from(f.bytes,'base64');check(bytes.length===f.size&&sha256(bytes)===f.sha256);}
 const jar=Buffer.from(b.jar.bytes,'base64');check(jar.length===b.jar.size&&sha256(jar)===b.jar.sha256&&b.launch.beforeDigest===b.jar.sha256&&b.launch.afterDigest===b.jar.sha256);
 equal(inspectJar(jar),[{path:'META-INF/MANIFEST.MF',size:25,sha256:sha256('Manifest-Version: 1.0\r\n\r\n'),bytes:Buffer.from('Manifest-Version: 1.0\r\n\r\n').toString('base64')},...b.output.files]);
 equal(b.receipt,{schema:'owned-bta-driver-build-v1',buildInvocationId:b.input.buildInvocationId,inputManifestRef:b.inputDigest,outputSetRef:b.outputDigest,artifactDigest:b.jar.sha256});check(b.receiptDigest===objectDigest(b.receipt));
 check(n.schema==='owned-bta-native-v1'&&n.executionId===p.executionId&&n.buildReceiptRef===b.receiptDigest&&n.actualCompilerVersion===profile.kotlinVersion&&n.driverOrigin.file.sha256===b.jar.sha256&&n.driverOrigin.file.path==='driver.jar');
 equal(n.runtime,b.input.runtime);equal(n.actualClasspath,['driver.jar',...b.input.runtime.map(x=>x.path)]);equal(b.launch.classpath,n.actualClasspath);check(b.launch.executableSha256===p.java);equal(b.launch.args,['-Xmx768m','-cp',n.actualClasspath.map(x=>'$ROOT/'+x).join(':'),'OwnedBtaManifestDriver','$ROOT',p.executionId,b.receiptDigest,profile.kotlinVersion]);
 for(const [origin,coordinate]of [[n.apiOrigin,'kotlin-build-tools-api'],[n.implementationOrigin,'kotlin-build-tools-impl'],[n.compilerOrigin,'kotlin-compiler-embeddable']])check(origin.file.sha256===profile.runtime.find(x=>x.coordinate.includes(':'+coordinate+':')).sha256,'profile_mismatch');
 equal(n.runtimeAfter,n.runtime.map(({path,size,sha256})=>({path,size,sha256})));
 check(n.generations.length===2&&n.generations[0].generationId==='library-old'&&n.generations[1].generationId==='library-current');
 for(let j=0;j<2;j++){const g=n.generations[j];exact(g,['schema','generationId','source','sourceBytes','libraryOutputs','library','libraryEntries','cohort','cohortDigest','snapshots','buildReceiptRef']);check(Buffer.from(g.sourceBytes,'base64').toString('utf8')===libraryBytes[j]);check(g.buildReceiptRef===b.receiptDigest&&n.generationRefs[j]===objectDigest(g)&&g.cohortDigest===objectDigest(g.cohort)&&g.snapshots.length===3&&g.libraryOutputs.length>0);
  check(sha256(Buffer.from(g.sourceBytes,'base64'))===g.source.sha256&&g.library.sha256===g.cohort[0].sha256&&g.cohort[2].sha256===g.cohort[0].sha256&&g.cohort[1].sha256===profile.runtime.find(x=>x.coordinate.includes(':kotlin-stdlib:')).sha256);
  equal(g.libraryEntries,g.libraryOutputs.map(f=>({path:f.path.slice((g.generationId+'/classes/').length),size:f.size,sha256:f.sha256,outputPath:f.path})));
  equal(r.generationReader[j],{source:g.source,library:g.library,outputs:g.libraryOutputs,snapshots:g.snapshots.map(({path,size,sha256})=>({path,size,sha256}))});
  for(let i=0;i<3;i++){const f=g.snapshots[i];check(f.occurrence===i&&g.cohort[i].occurrence===i&&f.libraryDigest===g.cohort[i].sha256&&f.classCount>0&&f.size>0&&f.format==='BTA-native'&&f.granularity==='CLASS_MEMBER_LEVEL'&&profile.runtime.some(x=>x.sha256===f.generator.file.sha256));}
 }
 check(n.generations[0].library.sha256!==n.generations[1].library.sha256&&n.generations[0].snapshots[0].sha256!==n.generations[1].snapshots[0].sha256);
 equal(n.offers.map(x=>x.id),Object.keys(btaManifestCases));let consumerCalls=0;
 const gen=n.generations[1],refs=gen.snapshots;
 function verifyCheck(c){exact(c,['reason','libraries','snapshots','saved']);check(c&&c.libraries.length===3&&c.snapshots.length===3&&c.saved.length===3);let reason=null;for(let i=0;i<3;i++){if(c.saved[i].sha256!==refs[i].sha256||c.saved[i].size!==refs[i].size)reason='snapshot_storage_mismatch';if(reason===null&&c.snapshots[i].sha256!==refs[i].sha256)reason='snapshot_stale';}for(let i=0;i<3;i++)if(reason===null&&c.libraries[i].sha256!==gen.cohort[i].sha256)reason='library_stale';check(c.reason===reason);return reason;}
 for(const o of n.offers){
  check(o.reason===btaManifestCases[o.id]&&o.producerState===(o.reason?'failed':'completed')&&o.compilerWorkStatus==='unknown'&&o.naturalContentBinding===false&&o.productionAdopted===false);
  exact(o,['id','binding','callsBefore','identity','preflight','icBefore','reason','callsAfter','producerState','executionEvidence','compilerWorkStatus','naturalContentBinding','productionAdopted','outputs','icAfter'],['postflight','capture','callResult','expectedIc','refusalLibraryEvidence']);
  const h=o.binding,a=o.identity;exact(h,['id','context','configurationId','parameterId','source','arguments','generationRef','cohortRef','snapshotPaths']);
  check(a.configurationIdentity===(a.actualConfigurationId===h.configurationId)&&a.parameterIdentity===(a.actualParameterId===h.parameterId));
  check(h.source.sha256===sha256(consumerBytes));
  const out=o.id==='unchanged'?'offer-completed/classes':'offer-'+o.id+'/classes';equal(h.arguments,['-d','$ROOT/'+out,'-classpath',gen.cohort.map(x=>'$ROOT/'+x.path).join(':'),'-no-stdlib','-no-reflect','-module-name','consumer','-jvm-target','17']);
  check(o.callsBefore===2+consumerCalls);check(h.context===o.id&&h.generationRef===n.generationRefs[1]&&h.cohortRef===gen.cohortDigest&&h.snapshotPaths.length===3&&h.source.sha256&&h.configurationId&&h.parameterId);
  let reason=!a.registered?'configuration_unregistered':!a.bindingIdentity||!a.configurationIdentity?'configuration_binding_mismatch':!a.parameterIdentity||objectDigest(a.parameterPaths)!==objectDigest(h.snapshotPaths)?'parameter_binding_mismatch':!a.contextIdentity?'context_binding_mismatch':a.source.sha256!==h.source.sha256?'source_stale':a.generationRef!==h.generationRef?'generation_binding_mismatch':objectDigest(a.cohort)!==objectDigest(gen.cohort.map(x=>x.path))?'cohort_binding_mismatch':null;
  const pre=verifyCheck(o.preflight);if(reason===null)reason=pre;
  const called=reason===null;check(o.callsAfter-o.callsBefore===(called?1:0)&&o.executionEvidence===(called?'bta-call-only':'not-called'));
  const use=n.configurationUses.find(x=>x.context===o.id&&x.configurationId===h.configurationId&&x.parameterId===h.parameterId);check(use);equal(use.paths,h.snapshotPaths);
  if(called){consumerCalls++;check(o.callsAfter===2+consumerCalls);check(o.callResult==='COMPILATION_SUCCESS');reason=verifyCheck(o.postflight);if(reason===null)reason=verifyCheck(o.capture);const call=n.calls.find(c=>c.stage===o.id);check(call&&call.configurationId===h.configurationId&&call.source.sha256===h.source.sha256);equal(call.arguments,h.arguments);if(!o.reason)check(o.outputs.length>0);}
  else check(!Object.hasOwn(o,'callResult')&&!Object.hasOwn(o,'postflight')&&!Object.hasOwn(o,'capture'));
  check(reason===o.reason);
  if(o.id==='unchanged'){equal(o.icBefore,o.expectedIc);check(o.binding.configurationId!==n.offers[0].binding.configurationId&&o.binding.parameterId!==n.offers[0].binding.parameterId);equal(o.binding.arguments,n.offers[0].binding.arguments);equal(o.binding.source,n.offers[0].binding.source);equal(o.binding.snapshotPaths,n.offers[0].binding.snapshotPaths);}
 }
 for(let j=0;j<2;j++){const c=n.calls[j],g=n.generations[j];check(c.stage===g.generationId&&c.source.sha256===g.source.sha256);equal(c.outputs,g.libraryOutputs);}
 check(n.calls.length===2+consumerCalls&&n.calls.every(c=>c.result==='COMPILATION_SUCCESS'));
 equal(r.runtimeRefusals.map(x=>x.id),Object.keys(runtimeRefusals));for(const f of r.runtimeRefusals){check(f.reason===runtimeRefusals[f.id]&&f.childCalls===0);let reason=f.candidate.length!==r.build.input.runtime.length||objectDigest(f.candidate.map(({size,...v})=>v))!==objectDigest(runtimeVector(t.gradleVersion))?'runtime_binding_mismatch':f.actualDriverDigest!==b.jar.sha256?'driver_stale':f.actualRuntime.some((x,i)=>x.sha256!==b.input.runtime[i].sha256)?'runtime_stale':null;check(reason===f.reason);}
 check(r.readerChecks.length===n.offers.length);for(const c of r.readerChecks){const o=n.offers.find(x=>x.id===c.id);check(o);const last=o.capture??o.postflight??o.preflight;equal(c.snapshots,last.snapshots);equal(c.saved,last.saved);equal(c.source,o.identity.source);if(o.id==='library-modified'){equal(c.refusalLibrary,o.refusalLibraryEvidence);check(c.refusalLibrary.sha256===o.preflight.libraries[0].sha256&&c.refusalLibrary.sha256!==gen.cohort[0].sha256);}else check(c.refusalLibrary===null);}
 equal(r.manifestBundle,makeBridgeBundle(r),'manifest_mismatch');
 // Counts come from verified evidence rather than fixed per-tuple constants.
 return {tuples:1,javacInvocations:b.compiler?1:0,javaInvocations:b.launch?1:0,libraryCalls:n.calls.filter(c=>c.stage.startsWith('library-')).length,generatorCalls:n.generations.reduce((k,g)=>k+g.snapshots.length,0),consumerCalls,btaCalls:n.calls.length,offers:n.offers.length,completed:n.offers.filter(x=>!x.reason).length,refused:n.offers.filter(x=>x.reason).length+Object.keys(runtimeRefusals).length,naturalReceipts:0,productionAdopted:0};
}
export function verifyBtaManifestRecord(r,{currentSources=true}={}){check(r?.schema==='owned-bta-manifest-proof-v2'&&r.cases.length===4);equal(r.cases.map(t=>t.gradleVersion+':'+t.dsl),['8.11.1:Groovy','8.11.1:Kotlin','9.2.1:Groovy','9.2.1:Kotlin']);if(currentSources){equal(r.sourceHashes,bridgeFingerprints(bridgeSources));equal(r.verificationHashes,bridgeFingerprints(bridgeVerificationSources));}const scope={};for(const t of r.cases){equal(t.policy.sourceHashes,r.sourceHashes);for(const [k,v]of Object.entries(verifyBtaManifestTuple(t)))scope[k]=(scope[k]??0)+v;}equal(scope,r.scope);return scope;}

/** Content-addressed proof DAG. No object refers to the index, bundle or its own digest. */
export function makeBridgeBundle(r){
 const objects=[];const add=(role,data,refs=[])=>{const value={schema:'owned-bta-proof-object-v1',role,executionId:r.executionId,refs,data},bytes=canonicalBytes(value),ref={role,objectDigest:sha256(bytes),byteLength:bytes.length};objects.push({ref,bytes:bytes.toString('utf8')});return ref;};
 const input=add('input-manifest',r.build.input),output=add('output-set',r.build.output,[input]),build=add('build-receipt',r.build.receipt,[input,output]);
 const runtime=add('runtime-selection',{classpath:r.native.actualClasspath,runtime:r.native.runtime,origins:[r.native.driverOrigin,r.native.apiOrigin,r.native.implementationOrigin,r.native.compilerOrigin]},[build]);
 const generations=r.native.generations.map(g=>add('generation-receipt',g,[runtime]));
 const offers=r.native.offers.map(o=>add(o.producerState==='completed'?'offer-receipt':'failure-receipt',o,[build,runtime,...generations]));
 const index=add('evidence-index',objects.map(x=>x.ref));
 const header={schema:'owned-bta-proof-bundle-v1',executionId:r.executionId,buildReceiptRef:build,runtimeSelectionRef:runtime,generationReceiptRefs:generations,offerReceiptRefs:offers,evidenceIndexRef:index};
 return {header,headerDigest:objectDigest(header),objects};
}
