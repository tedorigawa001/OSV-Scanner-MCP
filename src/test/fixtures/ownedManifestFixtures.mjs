import {canonicalBytes,objectDigest,sha256,stages,successRefs,failureCases} from './ownedManifestContract.mjs';
export function manifestFixture(state='completed',through='offer',failure){
 const expected={graphId:'g',exportId:'e',project:':',context:'runtime',executionId:'x',invocation:'i',profileId:'p',recipeId:'r',profileDigest:sha256('profile'),recipeDigest:sha256('recipe'),buildInvocationId:'build-1',rootIds:['source']};
 const coreGraph=canonicalBytes({schema:'independently-validated-core',contexts:['runtime']});expected.coreGraphDigest=sha256(coreGraph);
 const binding=Object.fromEntries(Object.entries(expected).filter(([k])=>['graphId','exportId','project','context','executionId','profileId','recipeId'].includes(k)));
 const envelope={schema:'osv-mcp.gradle-owned-envelope-static-v1',...binding,invocation:expected.invocation,producerState:state,completedThrough:through,naturalContentBinding:false};
 const bundle={schema:'osv-mcp.gradle-owned-manifest-bundle-v1',completenessDomain:'owned-recipe-inputs',...binding,invocation:expected.invocation,coreGraphDigest:expected.coreGraphDigest,producerState:state,completedThrough:through,approvalStatus:'approved',profileDigest:expected.profileDigest,recipeDigest:expected.recipeDigest,limitations:['static metadata only']};
 const objects=[];const add=(role,refs=[],extra={},files=[])=>{const value={schema:'osv-mcp.gradle-owned-object-static-v1',role,binding,refs,files,...extra};const bytes=canonicalBytes(value),objectDigest=sha256(bytes);objects.push({objectDigest,bytes});return {role,objectDigest,byteLength:bytes.length};};
 const n=through==='none'?-1:stages.indexOf(through),roles=['input-manifest','build-receipt','runtime-selection','generation-receipt','offer-receipt'];
 for(let i=0;i<=n;i++)bundle[successRefs[i]]=add(roles[i],i?[bundle[successRefs[i-1]]]:[],i===4?{envelopeDigest:objectDigest(envelope),invocation:expected.invocation}:{buildInvocationId:expected.buildInvocationId},i===0?[{rootId:'source',path:'日本語 空白/%/Main.kt',size:6,sha256:sha256('\ufeffx\r\n')}]:[]);
 if(state==='failed'){const f=failure??failureCases.find(x=>x.stage===stages[n+1]);Object.assign(bundle,{failureStage:f.stage,failurePhase:f.phase,failureReason:f.reason});bundle.failureReceiptRef=add('failure-receipt',successRefs.slice(0,n+1).map(k=>bundle[k]),{invocation:expected.invocation,stage:f.stage,phase:f.phase,reason:f.reason,completedThrough:through});}
 if(state==='unavailable'){Object.assign(bundle,{blockedStage:stages[n+1],unavailableReason:['toolchain_unsupported','build_unsupported','loader_unsupported','generator_unsupported','consumer_unsupported'][n+1]});bundle.unavailableEvidenceRef=add('unavailable-evidence',successRefs.slice(0,n+1).map(k=>bundle[k]),{invocation:expected.invocation,stage:bundle.blockedStage,reason:bundle.unavailableReason,completedThrough:through});}
 bundle.evidenceIndexRef=add('evidence-index',objects.map(x=>{const o=JSON.parse(x.bytes);return {role:o.role,objectDigest:x.objectDigest,byteLength:x.bytes.length};}));
 const transport={coreGraph,bundle:canonicalBytes(bundle),envelope:canonicalBytes(envelope),entry:{bundleDigest:objectDigest(bundle),envelopeDigest:objectDigest(envelope)},objects};
 return {transport,expected,bundle,envelope};
}
export function reseal(f){f.transport.bundle=canonicalBytes(f.bundle);f.transport.envelope=canonicalBytes(f.envelope);f.transport.entry={bundleDigest:objectDigest(f.bundle),envelopeDigest:objectDigest(f.envelope)};return f;}
// Rehash all parents, so negative cases exercise contracts rather than only stale digests.
export function rewriteFixtureObject(f,index,mutate){
 const replacements=new Map();
 f.transport.objects=f.transport.objects.map((item,i)=>{
  const o=JSON.parse(item.bytes);if(i===index)mutate(o);
  o.refs=o.refs.map(r=>replacements.get(r.objectDigest)??r);
  const bytes=canonicalBytes(o),ref={role:o.role,objectDigest:sha256(bytes),byteLength:bytes.length};replacements.set(item.objectDigest,ref);return {objectDigest:ref.objectDigest,bytes};
 });
 for(const [k,v]of Object.entries(f.bundle))if(k.endsWith('Ref')&&v)f.bundle[k]=replacements.get(v.objectDigest)??v;
 return reseal(f);
}
