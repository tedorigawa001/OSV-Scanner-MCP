// Test-only metadata contract. It never reads project files, executes builds, or approves profiles.
import {createHash} from 'node:crypto';
export const manifestLimits=Object.freeze({maxDepth:32,maxNodes:100000,maxObjectBytes:1048576,maxTotalBytes:8388608,maxObjects:128,maxRefs:4096});
const fail=(reason='schema_invalid')=>{throw Error('owned_manifest_'+reason);};
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function unicode(s){for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=s.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail();}else if(c>=0xdc00&&c<=0xdfff)fail();}return s;}
export function canonicalBytes(value){
 let nodes=0;const visiting=new Set();
 function encode(v,depth){
  if(++nodes>manifestLimits.maxNodes||depth>manifestLimits.maxDepth)fail('budget_exceeded');
  if(v===null||typeof v==='boolean')return String(v);
  if(typeof v==='string')return JSON.stringify(unicode(v));
  if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<0||Object.is(v,-0))fail();return String(v);}
  if(!v||typeof v!=='object'||visiting.has(v))fail();visiting.add(v);let result;
  if(Array.isArray(v)){
   if(Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i)))fail();result='['+v.map(x=>encode(x,depth+1)).join(',')+']';
  }else{
   if(![Object.prototype,null].includes(Object.getPrototypeOf(v))||Reflect.ownKeys(v).some(k=>typeof k!=='string'))fail();
   result='{'+Object.keys(v).sort().map(k=>JSON.stringify(unicode(k))+':'+encode(v[k],depth+1)).join(',')+'}';
  }
  visiting.delete(v);return result;
 }
 const bytes=Buffer.from(encode(value,0),'utf8');if(bytes.length>manifestLimits.maxObjectBytes)fail('budget_exceeded');return bytes;
}
export const objectDigest=value=>sha256(canonicalBytes(value));
export function parseManifestJson(input){
 let text;if(typeof input==='string')text=input;else if(Buffer.isBuffer(input)||input instanceof Uint8Array){try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);}catch{fail();}}else fail();
 if(Buffer.byteLength(text,'utf8')>manifestLimits.maxObjectBytes)fail('budget_exceeded');
 let at=0,nodes=0;const ws=()=>{while(/[ \t\r\n]/.test(text[at]??'x'))at++;};
 function string(){
  const start=at++;while(at<text.length){const c=text[at++];if(c==='"'){try{return unicode(JSON.parse(text.slice(start,at)));}catch{fail();}}if(c==='\\')at++;}
  fail();
 }
 function value(depth){
  ws();if(++nodes>manifestLimits.maxNodes||depth>manifestLimits.maxDepth)fail('budget_exceeded');
  const c=text[at];
  if(c==='"')return string();
  if(c==='{'){
   at++;ws();const result=Object.create(null),seen=new Set();if(text[at]==='}'){at++;return result;}
   while(true){ws();if(text[at]!=='"')fail();const k=string();if(seen.has(k))fail('duplicate_key');seen.add(k);ws();if(text[at++]!==':')fail();result[k]=value(depth+1);ws();const end=text[at++];if(end==='}')return result;if(end!==',')fail();}
  }
  if(c==='['){at++;ws();const result=[];if(text[at]===']'){at++;return result;}while(true){result.push(value(depth+1));ws();const end=text[at++];if(end===']')return result;if(end!==',')fail();}}
  for(const [word,v]of [['null',null],['true',true],['false',false]])if(text.startsWith(word,at)){at+=word.length;return v;}
  const number=text.slice(at).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
  if(number){at+=number[0].length;const n=Number(number[0]);if(!Number.isSafeInteger(n)||n<0||Object.is(n,-0))fail();return n;}
  fail();
 }
 const result=value(0);ws();if(at!==text.length)fail();return result;
}

export const stages=Object.freeze(['prepare','build','runtime-selection','snapshot-generation','offer']);
export const successRefs=Object.freeze(['inputManifestRef','buildReceiptRef','runtimeSelectionRef','generationReceiptRef','offerReceiptRef']);
const roles=['input-manifest','build-receipt','runtime-selection','generation-receipt','offer-receipt'];
const ids=['graphId','exportId','project','context','executionId','invocation','profileId','recipeId'];
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)&&!/^0+$/.test(v);
function shape(v,required,optional=[]){if(!v||Array.isArray(v)||typeof v!=='object'||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))fail();}
function nonempty(v){if(typeof v!=='string'||!v.length)fail();}
function ref(v,role){shape(v,['role','objectDigest','byteLength']);if(!digest(v.objectDigest)||!Number.isSafeInteger(v.byteLength)||v.byteLength<=0||v.byteLength>manifestLimits.maxObjectBytes||v.role!==role)fail();}
function file(v){shape(v,['rootId','path','size','sha256']);nonempty(v.rootId);nonempty(v.path);if(/^[\\/]|^[a-zA-Z]:|[\\\u0000]/.test(v.path)||v.path.split('/').some(x=>x==='..'||x==='.'||!x)||!Number.isSafeInteger(v.size)||v.size<0||!digest(v.sha256))fail();}
const reasons={prepare:{capture:['input_changed','storage_failed','budget_exceeded'],seal:['input_changed','storage_failed','budget_exceeded']},build:{'allocate-output':['output_root_exists','output_root_invalid','storage_failed'],'verify-empty':['output_root_not_empty','output_root_invalid'],compiler:['build_failed'],packaging:['build_failed','inventory_mismatch','storage_failed']},'runtime-selection':{select:['runtime_mismatch','storage_failed']},'snapshot-generation':{generate:['generation_failed','storage_failed']},offer:{binding:['binding_mismatch'],precheck:['input_changed'],call:['call_failed'],postcheck:['input_changed'],capture:['input_changed','storage_failed']}};
export const failureCases=Object.freeze(Object.entries(reasons).flatMap(([stage,phases])=>Object.entries(phases).flatMap(([phase,rs])=>rs.map(reason=>({stage,phase,reason})))));
const unavailableReasons={prepare:['toolchain_unsupported','profile_unapproved','recipe_unsupported'],build:['build_unsupported'],'runtime-selection':['loader_unsupported'],'snapshot-generation':['generator_unsupported'],offer:['consumer_unsupported']};
function state(v){
 if(!v||typeof v!=='object'||Array.isArray(v))fail();
 const n=v.completedThrough==='none'?-1:stages.indexOf(v.completedThrough);if(n< -1||(!stages.includes(v.completedThrough)&&v.completedThrough!=='none'))fail();
 if(!['completed','failed','unavailable'].includes(v.producerState)||!['approved','unavailable'].includes(v.approvalStatus))fail();
 const required=[];if(v.approvalStatus==='approved'){required.push('profileDigest','recipeDigest');if(!digest(v.profileDigest)||!digest(v.recipeDigest))fail();}else if(v.producerState!=='unavailable'||n!==-1||v.blockedStage!=='prepare')fail();
 for(let i=0;i<5;i++)if(i<=n){required.push(successRefs[i]);ref(v[successRefs[i]],roles[i]);}
 if(v.producerState==='completed'){if(n!==4||v.approvalStatus!=='approved')fail();}
 else {if(n===4)fail();if(v.producerState==='failed'){required.push('failureStage','failurePhase','failureReason','failureReceiptRef');if(v.approvalStatus!=='approved'||v.failureStage!==stages[n+1]||!reasons[v.failureStage]?.[v.failurePhase]?.includes(v.failureReason))fail();ref(v.failureReceiptRef,'failure-receipt');}else{required.push('blockedStage','unavailableReason','unavailableEvidenceRef');if(v.blockedStage!==stages[n+1]||!unavailableReasons[v.blockedStage]?.includes(v.unavailableReason))fail();ref(v.unavailableEvidenceRef,'unavailable-evidence');}}
 return {n,required};
}
/** Validate supplied metadata only. expected is independent caller policy, never read from bundle. */
export function verifyManifest(input,expected){
 if(!input.envelope&&!input.bundle)return {status:'unavailable',reason:'owned_offer_envelope_missing',diagnosticEligible:false};
 if(!input.bundle)fail('required_evidence_missing');
 const bundle=parseManifestJson(input.bundle),s=state(bundle);
 shape(bundle,['schema','completenessDomain',...ids,'coreGraphDigest','producerState','completedThrough','approvalStatus','evidenceIndexRef','limitations',...s.required]);
 if(bundle.schema!=='osv-mcp.gradle-owned-manifest-bundle-v1'||bundle.completenessDomain!=='owned-recipe-inputs'||!Array.isArray(bundle.limitations)||bundle.limitations.some(x=>typeof x!=='string'))fail();
 for(const k of ids){nonempty(bundle[k]);if(bundle[k]!==expected[k])fail('binding_mismatch');}
 if(bundle.coreGraphDigest!==expected.coreGraphDigest||!digest(bundle.coreGraphDigest))fail('binding_mismatch');
 const core=parseManifestJson(input.coreGraph);if(!core||typeof core!=='object'||Array.isArray(core))fail();if(Object.hasOwn(core,'ownedOfferBundles')||objectDigest(core)!==bundle.coreGraphDigest)fail('binding_mismatch');
 if(bundle.approvalStatus==='approved')for(const k of ['profileDigest','recipeDigest'])if(bundle[k]!==expected[k])fail('binding_mismatch');
 if(!input.envelope)fail('required_evidence_missing');
 const envelope=parseManifestJson(input.envelope);shape(envelope,['schema',...ids,'producerState','completedThrough','naturalContentBinding']);
 if(envelope.schema!=='osv-mcp.gradle-owned-envelope-static-v1'||envelope.naturalContentBinding!==false)fail();
 for(const k of [...ids,'producerState','completedThrough'])if(envelope[k]!==bundle[k])fail('binding_mismatch');
 shape(input.entry,['bundleDigest','envelopeDigest']);if(input.entry.bundleDigest!==objectDigest(bundle)||input.entry.envelopeDigest!==objectDigest(envelope))fail('content_mismatch');
 if(!Array.isArray(input.objects)||input.objects.length>manifestLimits.maxObjects)fail('budget_exceeded');
 const objects=new Map();let total=0;
 for(const item of input.objects){shape(item,['objectDigest','bytes']);if(!digest(item.objectDigest)||objects.has(item.objectDigest))fail();total+=Buffer.byteLength(item.bytes);if(total>manifestLimits.maxTotalBytes)fail('budget_exceeded');objects.set(item.objectDigest,{value:parseManifestJson(item.bytes),bytes:Buffer.from(item.bytes)});}
 ref(bundle.evidenceIndexRef,'evidence-index');
 const cycleActive=new Set(),cycleDone=new Set();let cycleEdges=0;
 function cycle(d){if(++cycleEdges>manifestLimits.maxRefs)fail('budget_exceeded');if(cycleActive.has(d))fail('cycle');if(cycleDone.has(d))return;const o=objects.get(d)?.value;if(!o)return;cycleActive.add(d);if(Array.isArray(o.refs))for(const r of o.refs){if(r&&typeof r.objectDigest==='string')cycle(r.objectDigest);}cycleActive.delete(d);cycleDone.add(d);}
 cycle(bundle.evidenceIndexRef.objectDigest);
 let edges=0;const active=new Set(),visited=new Set();
 function walk(r){if(++edges>manifestLimits.maxRefs)fail('budget_exceeded');ref(r,r.role);if(active.has(r.objectDigest))fail('cycle');const item=objects.get(r.objectDigest);if(!item)fail('required_evidence_missing');if(!item.value||typeof item.value!=='object'||item.value.role!==r.role)fail();if(item.bytes.length!==r.byteLength)fail('content_mismatch');if(visited.has(r.objectDigest))return;active.add(r.objectDigest);
  const o=item.value;shape(o,['schema','role','binding','refs','files'],['buildInvocationId','stage','phase','reason','completedThrough','envelopeDigest','invocation']);
  const extra=r.role==='evidence-index'?[]:roles.includes(r.role)?(r.role==='offer-receipt'?['envelopeDigest','invocation']:['buildInvocationId']):r.role==='failure-receipt'?['stage','phase','reason','completedThrough','invocation']:['stage','reason','completedThrough','invocation'];shape(o,['schema','role','binding','refs','files',...extra]);
  if(['offer-receipt','failure-receipt','unavailable-evidence'].includes(r.role)&&o.invocation!==expected.invocation)fail('binding_mismatch');
  if(o.schema!=='osv-mcp.gradle-owned-object-static-v1'||!Array.isArray(o.refs)||!Array.isArray(o.files))fail();
  shape(o.binding,ids.filter(x=>x!=='invocation'));for(const k of Object.keys(o.binding))if(o.binding[k]!==expected[k])fail('binding_mismatch');
  o.files.forEach(file);if(o.files.some(x=>!expected.rootIds?.includes(x.rootId)))fail('path_invalid');if(o.files.some(x=>['evidence','receipt','manifest'].includes(x.rootId)))fail();
  if(r.role==='evidence-index'){if(o.files.length||o.refs.some(x=>x.role==='evidence-index'))fail();}
  else if(roles.includes(r.role)){const i=roles.indexOf(r.role);const fields=i===4?['envelopeDigest','invocation']:['buildInvocationId'];if(fields.some(k=>!Object.hasOwn(o,k)))fail();if(i<4&&o.buildInvocationId!==expected.buildInvocationId)fail('binding_mismatch');if(i===4&&o.envelopeDigest!==input.entry.envelopeDigest)fail('binding_mismatch');if(o.refs.length!==(i?1:0)||(i&&objectDigest(o.refs[0])!==objectDigest(bundle[successRefs[i-1]])))fail();if(i===0&&!o.files.length)fail();}
  else if(['failure-receipt','unavailable-evidence'].includes(r.role)){const failed=r.role==='failure-receipt';if(o.stage!==bundle[failed?'failureStage':'blockedStage']||o.reason!==bundle[failed?'failureReason':'unavailableReason']||o.completedThrough!==bundle.completedThrough||(failed?o.phase!==bundle.failurePhase:Object.hasOwn(o,'phase'))||o.refs.length!==s.n+1||o.refs.some((x,i)=>objectDigest(x)!==objectDigest(bundle[successRefs[i]])))fail('claim_mismatch');}
  else fail();
  for(const child of o.refs)walk(child);active.delete(r.objectDigest);visited.add(r.objectDigest);
  if(item.bytes.length!==r.byteLength||!item.bytes.equals(canonicalBytes(o))||sha256(item.bytes)!==r.objectDigest)fail('content_mismatch');
 }
 // Traverse inventory first so cycles cannot hide behind a forged content address.
 walk(bundle.evidenceIndexRef);
 for(const k of [...successRefs.slice(0,s.n+1),...(bundle.producerState==='failed'?['failureReceiptRef']:bundle.producerState==='unavailable'?['unavailableEvidenceRef']:[])]){if(!visited.has(bundle[k].objectDigest))fail('required_evidence_missing');walk(bundle[k]);}
 const index=objects.get(bundle.evidenceIndexRef.objectDigest).value;
 const requiredObjects=[...successRefs.slice(0,s.n+1).map(k=>bundle[k]),...(bundle.producerState==='failed'?[bundle.failureReceiptRef]:bundle.producerState==='unavailable'?[bundle.unavailableEvidenceRef]:[])];
 if(index.refs.length!==requiredObjects.length||index.refs.some(r=>!requiredObjects.some(x=>objectDigest(x)===objectDigest(r))))fail('inventory_mismatch');
 if(new Set(index.refs.map(x=>x.objectDigest)).size!==index.refs.length||index.refs.length!==objects.size-1||visited.size!==objects.size)fail('inventory_mismatch');
 return {status:'structure_verified',producerState:bundle.producerState,completedThrough:bundle.completedThrough,objects:visited.size,diagnosticEligible:false,naturalContentBinding:false};
}
