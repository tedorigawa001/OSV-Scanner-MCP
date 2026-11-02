import {inspectOwnedExecution,unsupportedOwnedCaller,type OwnedExecutionClaim} from './gradleOwnedExecution.js';
/** G0 metadata inspection and G1 operator approval. No owned file/process/authority loader. */
import {startupOwnedPolicy,type OwnedPolicy,type OwnedClaim} from './gradleOwnedPolicy.js';
import {z} from 'zod';
import {parseGradleGraph, createGradleBudget, type GradleGraph, type GradleBudget} from './gradleGraph.js';
import {exportFields} from './gradleExportJson.js';
import {OWNED_LIMITS, OwnedManifestError, ownedFail, canonicalOwnedJson, parseOwnedJson, ownedDigest, ownedSha256} from './gradleOwnedJson.js';
import {binding, bundleSchema, envelopeSchema, objectSchema, entrySchema, carrierSchema, stageRoles, successFields, phases, stateSchema, ownedStages, ownedLimitations, validateState, type OwnedRef, type OwnedBundle, type OwnedEnvelope, type OwnedObject, type OwnedBinding} from './gradleOwnedSchema.js';
export interface OwnedManifestStatus {
 executionWitness:'not_checked'|'verified'|'unavailable'|'invalid';
 manifestStructure:'verified'|'invalid'|'unavailable'; importStatus:'invalid'|'unavailable'; reasons:string[];
 diagnosticEligible:false; currentContentMatch:'not_checked'; naturalContentBinding:false; compilerWorkStatus:'unknown'; ownedFileReads:0;
}
export interface GradleExport {graph:GradleGraph;owned?:OwnedManifestStatus;refreshOwnedExecution?:()=>OwnedManifestStatus}
/** A schemaVersion 4 document that does not have the wrapper shape. */
export class InvalidGradleWrapper extends Error {constructor(){super('invalid_graph_wrapper');}}
/** Non-wrapper (v1-v3) companions keep their previous 16 MiB limit; only v4 wrappers may use the larger transport. */
export class LegacyGradleMetadataTooLarge extends Error {constructor(){super('metadata_too_large');}}
export const LEGACY_GRAPH_BYTES=16*1024*1024;
function status(manifestStructure:OwnedManifestStatus['manifestStructure'],reason:string):OwnedManifestStatus {
 return {executionWitness:'not_checked',manifestStructure,importStatus:manifestStructure==='invalid'?'invalid':'unavailable',reasons:[reason],diagnosticEligible:false,currentContentMatch:'not_checked',naturalContentBinding:false,compilerWorkStatus:'unknown',ownedFileReads:0};
}
type Node={ref:OwnedRef;bytes:string;value:OwnedBundle|OwnedEnvelope|OwnedObject};
function equal(a:unknown,b:unknown):boolean {return canonicalOwnedJson(a)===canonicalOwnedJson(b);}
function required(ok:unknown,reason='schema_invalid'):asserts ok {if(!ok)ownedFail(reason);}
function refs(value:Node['value']):OwnedRef[] {
 if('completenessDomain' in value)return [value.evidenceIndexRef,...successFields.flatMap(k=>value[k]?[value[k]!]:[]),...(value.failureReceiptRef?[value.failureReceiptRef]:[]),...(value.unavailableEvidenceRef?[value.unavailableEvidenceRef]:[])];
 if('phases' in value)return value.phases.flatMap(p=>'evidenceRef' in p?[p.evidenceRef]:[]);
 return [...value.refs,...(value.envelopeRef?[value.envelopeRef]:[])];
}
function bindOf(v:Node['value']):OwnedBinding {return 'binding' in v?v.binding:binding.parse(Object.fromEntries(Object.keys(binding.shape).map(k=>[k,(v as Record<string,unknown>)[k]])));}
function sameBinding(a:OwnedBinding,b:OwnedBinding):void {for(const key of Object.keys(binding.shape) as (keyof OwnedBinding)[])required(a[key]===b[key],'claim_mismatch');}
function inspectOwned(graph:GradleGraph,graphId:string,exportId:string,entriesText:string,objectsText:string,policy:OwnedPolicy,caller:unknown,refresh:{current?:(()=>OwnedManifestStatus)}):OwnedManifestStatus {
 const claims:OwnedClaim[]=[];
 const executions:OwnedExecutionClaim[]=[];
 const jsonBudget={nodes:OWNED_LIMITS.nodes};
 const rawEntries=parseOwnedJson(entriesText,OWNED_LIMITS.metadataBytes,jsonBudget),rawObjects=parseOwnedJson(objectsText,OWNED_LIMITS.metadataBytes,jsonBudget);
 if((Array.isArray(rawEntries)&&rawEntries.length>2000)||(Array.isArray(rawObjects)&&rawObjects.length>OWNED_LIMITS.objects))ownedFail('budget_exceeded');
 const entries=z.array(entrySchema).parse(rawEntries),carriers=z.array(carrierSchema).parse(rawObjects);
 const nodes=new Map<string,Node>();let total=0;
 for(const c of carriers){
  required(!nodes.has(c.objectDigest));total+=Buffer.byteLength(c.bytes);if(total>OWNED_LIMITS.metadataBytes)ownedFail('budget_exceeded');
  const raw=parseOwnedJson(c.bytes,OWNED_LIMITS.objectBytes,jsonBudget);
  const value=c.role==='manifest-bundle'?bundleSchema.parse(raw):c.role==='offer-envelope'?envelopeSchema.parse(raw):objectSchema.parse(raw);
  if('role' in value)required(value.role===c.role);
  else required((c.role==='manifest-bundle')===('completenessDomain' in value));
  nodes.set(c.objectDigest,{ref:{role:c.role,objectDigest:c.objectDigest,byteLength:Buffer.byteLength(c.bytes)},bytes:c.bytes,value});
 }
 let work=OWNED_LIMITS.refs;
 function resolve(r:OwnedRef):Node {if(--work<0)ownedFail('budget_exceeded');const n=nodes.get(r.objectDigest);required(n,'required_evidence_missing');required(n.ref.role===r.role);required(n.ref.byteLength===r.byteLength,'content_mismatch');return n;}
 function object(r:OwnedRef,role:OwnedRef['role']):OwnedObject {required(r.role===role);const n=resolve(r);required('role' in n.value&&n.value.role===role);return n.value;}
 const cycleActive=new Set<string>(),cycleDone=new Set<string>();
 function walk(r:OwnedRef,depth:number,visited:Set<string>):void {
  if(depth>OWNED_LIMITS.depth)ownedFail('budget_exceeded');const n=resolve(r);if(cycleActive.has(r.objectDigest))ownedFail();
  if(visited.has(r.objectDigest))return;visited.add(r.objectDigest);cycleActive.add(r.objectDigest);
  for(const child of refs(n.value))walk(child,depth+1,visited);
  cycleActive.delete(r.objectDigest);
 }
 // Validate the whole supplied metadata graph, including objects an entry never reaches.
 for(const n of nodes.values())if(!cycleDone.has(n.ref.objectDigest)){const visited=new Set<string>();walk(n.ref,0,visited);for(const d of visited)cycleDone.add(d);}
 for(const n of nodes.values())required(canonicalOwnedJson(n.value)===n.bytes&&ownedSha256(n.bytes)===n.ref.objectDigest,'content_mismatch');
 const reached=new Set<string>(),entryIds=new Set<string>();let missing=false;
 const coreDigest=ownedDigest(graph,OWNED_LIMITS.metadataBytes);
 const hasRecord=(o:OwnedObject,kind:string)=>o.evidence.some(e=>e.kind===kind);
 function checkPhases(e:OwnedEnvelope,b:OwnedBundle):void {
  let position=0,captures=0;const successful=new Map<string,OwnedObject>();
  for(let i=0;i<e.phases.length;i+=2){
   const begin=e.phases[i],end=e.phases[i+1],phase=phases[position];
   required(begin?.outcome==='begin'&&begin.phase===phase&&end&&end.outcome!=='begin'&&end.phase===phase);
   const evidence=object(end.evidenceRef,'evidence');sameBinding(evidence.binding,bindOf(e));
   for(const x of evidence.evidence){if(x.kind==='observation')required(x.phase===phase,'claim_mismatch');if(x.kind==='process'&&x.operation==='bta-call'){required(phase==='call');const bound=successful.get('binding')?.evidence.find(x=>x.kind==='binding');required(bound?.kind==='binding'&&x.configurationId===bound.configurationId&&x.parameterId===bound.parameterId,'claim_mismatch');}}

   if(end.outcome==='failure'){
    required(e.producerState==='failed'&&e.failureStage==='offer'&&e.failurePhase===phase&&i+2===e.phases.length);
    required(evidence.evidence.some(x=>x.kind==='failure'&&x.stage==='offer'&&x.phase===phase&&x.reason===e.failureReason),'claim_mismatch');
    if(phase==='call')required(evidence.evidence.some(x=>x.kind==='process'&&x.operation==='bta-call'&&x.result!=='success'&&x.result!=='COMPILATION_SUCCESS'));
   }else{
    required(!evidence.evidence.some(x=>x.kind==='failure'||x.kind==='unavailable'));
    if(phase==='binding'){required(hasRecord(evidence,'binding'));for(const x of evidence.evidence)if(x.kind==='binding')required(x.projectId===e.project,'claim_mismatch');}
    if(phase==='generation-binding')required(evidence.refs.some(r=>equal(r,b.generationReceiptRef)));
    if(phase==='seal')required(evidence.evidence.some(x=>x.kind==='inventory'&&x.inputRole==='snapshot-generation'&&x.files.length>0));
    if(phase==='call')required(evidence.evidence.some(x=>x.kind==='process'&&x.operation==='bta-call'&&x.result==='COMPILATION_SUCCESS'));
    if(['precheck','postcheck','capture'].includes(phase))required(evidence.evidence.some(x=>x.kind==='observation'&&x.phase===phase&&x.matched));
    successful.set(phase!,evidence);if(phase==='capture')captures++;
   }
   if(phase!=='capture')position++;
  }
  if(e.completedThrough!=='offer'&&e.failureStage!=='offer'&&e.blockedStage!=='offer')required(e.phases.length===0&&e.plannedCaptures===0);
  if(e.producerState==='completed')required(successful.has('postcheck')&&captures===e.plannedCaptures&&e.phases.at(-1)?.outcome==='success','required_evidence_missing');
  if(e.producerState==='failed'&&e.failureStage==='offer')required(e.phases.at(-1)?.outcome==='failure'&&(e.failurePhase==='capture'?captures<e.plannedCaptures:captures===0));
  if(e.producerState==='unavailable')required(e.phases.every(p=>p.outcome!=='failure')&&captures===0&&!successful.has('call'));
  if(e.producerState==='unavailable'&&e.blockedStage==='offer')required(e.blockedBeforePhase===phases[position]&&position<=5);else required(e.blockedBeforePhase===undefined);
  const sealed=successful.get('seal')?.evidence.find(x=>x.kind==='inventory'&&x.inputRole==='snapshot-generation');
  const bound=successful.get('binding')?.evidence.find(x=>x.kind==='binding');
  if(sealed?.kind==='inventory'&&bound?.kind==='binding')required(equal(sealed.files.map(f=>f.path),bound.snapshotIds),'claim_mismatch');
 }
 for(const entry of entries){
  const key=JSON.stringify([entry.project,entry.context,entry.invocation]);required(!entryIds.has(key));entryIds.add(key);
  const context=graph.contexts.find(c=>c.id===entry.context);required(context?.projectId===entry.project,'claim_mismatch');
  if(!entry.bundleRef&&!entry.envelopeRef){missing=true;continue;}
  required(entry.bundleRef&&entry.envelopeRef,'required_evidence_missing');required(entry.bundleRef.role==='manifest-bundle'&&entry.envelopeRef.role==='offer-envelope');
  const bn=resolve(entry.bundleRef),en=resolve(entry.envelopeRef);required('completenessDomain' in bn.value&&'phases' in en.value);
  const b=bn.value,e=en.value,n=validateState(b);validateState(e);
  claims.push({profileId:b.profileId,recipeId:b.recipeId,profileDigest:b.profileDigest,recipeDigest:b.recipeDigest});
  required(new Set(b.limitations).size===ownedLimitations.length&&new Set(e.limitations).size===ownedLimitations.length);
  sameBinding(bindOf(b),bindOf(e));required(b.graphId===graphId&&b.exportId===exportId&&b.project===entry.project&&b.context===entry.context&&b.invocation===entry.invocation&&b.coreGraphDigest===coreDigest,'claim_mismatch');
  for(const field of Object.keys(bundleSchema.shape).filter(k=>Object.hasOwn(envelopeSchema.shape,k)&&!['schema','limitations'].includes(k)))required(equal((b as Record<string,unknown>)[field]??null,(e as Record<string,unknown>)[field]??null),'claim_mismatch');
  for(let i=0;i<successFields.length;i++)required((b[successFields[i]!]!==undefined)===(i<=n),i<=n?'required_evidence_missing':'schema_invalid');
  required((!!b.failureReceiptRef)===(b.producerState==='failed')&&(!!b.unavailableEvidenceRef)===(b.producerState==='unavailable'));
  for(let i=0;i<=n;i++){
   const r=b[successFields[i]!]!,o=object(r,stageRoles[i]!);sameBinding(o.binding,bindOf(b));required(!o.evidence.some(x=>x.kind==='failure'||x.kind==='unavailable'));if(i===4)required(o.evidence.length===0);
   const primary=o.refs.filter(r=>r.role!=='evidence');required(equal(primary,i?[b[successFields[i-1]!]!]:[]));
   if(i<4)required(!o.envelopeRef);else required(o.envelopeRef&&equal(o.envelopeRef,entry.envelopeRef),'claim_mismatch');
   if(i===0)required(o.evidence.some(x=>x.kind==='inventory'&&x.inputRole==='driver-sources'&&x.files.length>0));
   if(i>=1&&i<=3){const operation=['javac','jvm-start','snapshot-generator'][i-1];required(o.evidence.some(x=>x.kind==='process'&&x.operation===operation&&x.result==='success'));}
  }
  const terminal=b.failureReceiptRef??b.unavailableEvidenceRef;
  if(terminal){const o=object(terminal,b.producerState==='failed'?'failure-receipt':'unavailable-evidence');sameBinding(o.binding,bindOf(b));required(o.envelopeRef&&equal(o.envelopeRef,entry.envelopeRef),'claim_mismatch');required(equal(o.refs.filter(r=>r.role!=='evidence'),successFields.slice(0,n+1).map(k=>b[k])));
   if(b.producerState==='failed')required(o.evidence.some(x=>x.kind==='failure'&&x.stage===b.failureStage&&x.phase===b.failurePhase&&x.reason===b.failureReason),'claim_mismatch');
   else required(o.evidence.some(x=>x.kind==='unavailable'&&x.stage===b.blockedStage&&x.reason===b.unavailableReason&&(b.blockedStage==='offer'?x.phase===e.blockedBeforePhase:x.phase===undefined)),'claim_mismatch');
  }
  checkPhases(e,b);
  const index=object(b.evidenceIndexRef,'evidence-index');sameBinding(index.binding,bindOf(b));required(index.evidence.length===0&&!index.envelopeRef);
  const closure=new Set<string>();
  // Derive expected evidence independently of the index, so an index cannot authorize an orphan.
  for(const r of [entry.envelopeRef,...successFields.slice(0,n+1).map(k=>b[k]!),...(terminal?[terminal]:[])])walk(r,0,closure);
  required(!closure.has(b.evidenceIndexRef.objectDigest)&&!closure.has(entry.bundleRef.objectDigest));
  required(index.refs.length===closure.size&&new Set(index.refs.map(r=>r.objectDigest)).size===index.refs.length&&index.refs.every(r=>closure.has(r.objectDigest)),'inventory_mismatch');
  for(const digest of closure){const v=nodes.get(digest)!.value;sameBinding(bindOf(v),bindOf(b));
   if('role' in v&&b.producerState==='completed')required(!v.evidence.some(x=>x.kind==='failure'||x.kind==='unavailable'));
   if('role' in v&&v.role==='evidence'){required(!v.envelopeRef);required(v.refs.every(r=>!['manifest-bundle','offer-envelope','evidence-index','offer-receipt','failure-receipt','unavailable-evidence'].includes(r.role)));}
  }
  reached.add(entry.bundleRef.objectDigest);reached.add(b.evidenceIndexRef.objectDigest);for(const d of closure)reached.add(d);
  const processRecords:OwnedExecutionClaim['processes']=[];
  function collect(r:OwnedRef,stage:typeof ownedStages[number],depth=0):void {
   if(depth>OWNED_LIMITS.depth)ownedFail('budget_exceeded');const o=resolve(r).value;required('role' in o);
   for(const record of o.evidence)if(record.kind==='process')processRecords.push({stage,record});
   for(const ref of o.refs)if(ref.role==='evidence')collect(ref,stage,depth+1);
  }
  for(let i=0;i<=Math.min(n,3);i++)collect(b[successFields[i]!]!,ownedStages[i]!);
  if(terminal)collect(terminal,b.failureStage??b.blockedStage!);
  for(const p of e.phases)if('evidenceRef'in p)collect(p.evidenceRef,'offer');
  const stages:OwnedExecutionClaim['stages']=ownedStages.slice(0,n+1).map(stage=>({stage,outcome:'success'}));
  if(b.producerState==='failed')stages.push({stage:b.failureStage!,outcome:'failed'});
  if(b.producerState==='unavailable'&&e.phases.length)stages.push({stage:b.blockedStage!,outcome:'unavailable'});
  executions.push({...bindOf(b),profileDigest:b.profileDigest!,recipeDigest:b.recipeDigest!,witnessId:e.witnessId,bundleDigest:entry.bundleRef.objectDigest,envelopeDigest:entry.envelopeRef.objectDigest,plannedCaptures:e.plannedCaptures,captures:e.phases.filter(p=>p.phase==='capture'&&p.outcome==='success').length,state:stateSchema.parse(Object.fromEntries(Object.keys(stateSchema.shape).filter(k=>(b as Record<string,unknown>)[k]!==undefined).map(k=>[k,(b as Record<string,unknown>)[k]]))),stages,...(b.producerState==='unavailable'&&!e.phases.length?{optionalBlockedStage:b.blockedStage}:{}),processes:processRecords});

 }
 required(reached.size===nodes.size,'inventory_mismatch');
 if(missing||entries.length===0)return status('unavailable','owned_manifest_envelope_missing');
 const reasons=[...new Set(claims.map(c=>policy.registry.check(c,policy.settings)))];
 if(reasons.includes('profile_mismatch'))return {...status('verified','owned_manifest_profile_mismatch'),importStatus:'invalid'};
 if(reasons.some(r=>r!=='witness_unavailable'))return {...status('verified','owned_manifest_'+reasons[0]),reasons:reasons.map(r=>'owned_manifest_'+r)};
 const evaluate=():OwnedManifestStatus=>{
 const outcomes=[...new Set(executions.map((e,i)=>{const auth=policy.registry.authorization(claims[i]!,policy.settings);return auth?inspectOwnedExecution(e,caller,auth):'execution_invalid';}))];
 const invalid=outcomes.some(r=>r==='execution_invalid'||r==='claim_mismatch');
 return {...status('verified','owned_manifest_'+outcomes[0]),importStatus:invalid?'invalid':'unavailable',executionWitness:invalid?'invalid':outcomes.every(r=>r==='capability_unsupported')?'verified':'unavailable',reasons:outcomes.map(r=>'owned_manifest_'+r)};
 };
 refresh.current=evaluate;return evaluate();
}
function legacy(text:string,budget:GradleBudget):GradleExport {
 if(Buffer.byteLength(text)>LEGACY_GRAPH_BYTES)throw new LegacyGradleMetadataTooLarge();
 return {graph:parseGradleGraph(text,budget)};
}
export function parseGradleExport(text:string,budget:GradleBudget=createGradleBudget(),policy:OwnedPolicy=startupOwnedPolicy(),caller:unknown=unsupportedOwnedCaller):GradleExport {
 // Anything the root slicer cannot read keeps the previous legacy parser behavior and reasons.
 let fields:Map<string,string>;try{fields=exportFields(text);}catch{return legacy(text,budget);}
 if((!fields.has('schema')||JSON.parse(fields.get('schema')!)!=='osv-mcp.gradle-graph')||!fields.has('schemaVersion')||JSON.parse(fields.get('schemaVersion')!)!==4)return legacy(text,budget);
 const allowed=['schema','schemaVersion','graphId','exportId','coreGraph','ownedOfferBundles','ownedOfferObjects'];
 if([...fields.keys()].some(k=>!allowed.includes(k))||allowed.some(k=>!fields.has(k)))throw new InvalidGradleWrapper();
 const parsedHeader=z.object({graphId:z.string().min(1).max(1024),exportId:z.string().min(1).max(1024)}).strict().safeParse({graphId:JSON.parse(fields.get('graphId')!),exportId:JSON.parse(fields.get('exportId')!)});
 if(!parsedHeader.success)throw new InvalidGradleWrapper();const header=parsedHeader.data;
 // Legacy validation and budget are intentionally independent of owned errors.
 const graph=parseGradleGraph(fields.get('coreGraph')!,budget);
 const refresh:{current?:(()=>OwnedManifestStatus)}={};
 try{const owned=inspectOwned(graph,header.graphId,header.exportId,fields.get('ownedOfferBundles')!,fields.get('ownedOfferObjects')!,policy,caller,refresh);return {graph,owned,...(refresh.current?{refreshOwnedExecution:refresh.current}:{})};}
 catch(error){return {graph,owned:status('invalid',error instanceof OwnedManifestError?error.message:'owned_manifest_schema_invalid')};}
}
