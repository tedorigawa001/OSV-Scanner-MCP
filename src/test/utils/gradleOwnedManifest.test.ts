import {it,expect} from 'vitest';
import {parseGradleExport} from '../../utils/gradleOwnedManifest.js';
import {graphFixture} from '../fixtures/gradleGraphFixture.js';
it('unwraps a v4 core without allowing malformed owned metadata to erase it',()=>{
 const core=graphFixture();const parsed=parseGradleExport(JSON.stringify({schema:'osv-mcp.gradle-graph',schemaVersion:4,graphId:'g',exportId:'e',coreGraph:core,ownedOfferBundles:'invalid',ownedOfferObjects:[]}));
 expect(parsed.graph).toEqual(core);expect(parsed.owned?.manifestStructure).toBe('invalid');expect(parsed.owned?.diagnosticEligible).toBe(false);
});
import {ownedFixture} from '../fixtures/gradleOwnedFixture.js';
it('validates a complete production metadata DAG without approving diagnostic use',()=>{
 const parsed=parseGradleExport(JSON.stringify(ownedFixture()));expect(parsed.owned).toMatchObject({manifestStructure:'verified',importStatus:'unavailable',diagnosticEligible:false,currentContentMatch:'not_checked',ownedFileReads:0});
});
import {rewriteOwned} from '../fixtures/gradleOwnedFixture.js';
import {ownedStages,successFields,failurePhases,ownedLimitations} from '../../utils/gradleOwnedSchema.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256,parseOwnedJson,OWNED_LIMITS} from '../../utils/gradleOwnedJson.js';
const inspect=(doc:any)=>parseGradleExport(JSON.stringify(doc));
const mutate=(doc:any,select:(v:any)=>boolean,change:(v:any)=>void)=>inspect(rewriteOwned(doc,select,change));
const invalid=(result:ReturnType<typeof inspect>,reason?:string)=>{expect(result.graph.contexts[0]?.id).toBe('runtime');expect(result.owned).toMatchObject({manifestStructure:'invalid',importStatus:'invalid',diagnosticEligible:false,currentContentMatch:'not_checked',ownedFileReads:0});if(reason)expect(result.owned?.reasons).toContain('owned_manifest_'+reason);};
for(const state of ['failed','unavailable'])for(const through of ['none',...ownedStages.slice(0,4)])it(`accepts legal ${state} prefix ${through}`,()=>expect(inspect(ownedFixture(state,through)).owned?.manifestStructure).toBe('verified'));
for(const [stage,ps]of Object.entries(failurePhases))for(const [phase,rs]of Object.entries(ps))for(const reason of rs)it(`validates failed ${stage}/${phase}/${reason}`,()=>{const at=ownedStages.indexOf(stage as any),through=at?ownedStages[at-1]!:'none';expect(inspect(ownedFixture('failed',through,phase,reason)).owned?.manifestStructure).toBe('verified');});
it('accepts only the unresolved-profile unavailable union without resolved digests',()=>{
 const doc=ownedFixture('unavailable','none');const result=mutate(doc,()=>true,v=>{if(v.schema==='osv-mcp.gradle-owned-offer-v2'||v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1'){v.approvalStatus='unavailable';v.unavailableReason='profile_unapproved';delete v.profileDigest;delete v.recipeDigest;}if(v.evidence)for(const e of v.evidence)if(e.kind==='unavailable')e.reason='profile_unapproved';});expect(result.owned?.manifestStructure).toBe('verified');
});
for(const field of successFields)it('requires completed '+field,()=>invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1',v=>delete v[field]),'required_evidence_missing'));
for(const field of ['failureReceiptRef','unavailableEvidenceRef'])it('forbids completed '+field,()=>invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1',v=>v[field]=v.inputManifestRef)));
for(const state of ['failed','unavailable'])for(const through of ['none',...ownedStages.slice(0,4)])it(`forbids unproduced success ${state}/${through}`,()=>invalid(mutate(ownedFixture(state,through),v=>v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1',v=>v.offerReceiptRef=v.evidenceIndexRef)));
for(const field of ['profileDigest','recipeDigest'])it('requires resolved '+field,()=>invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1',v=>delete v[field])));
for(const field of ['coreGraphDigest','graphId','exportId','project','context','executionId','invocation'])it('rejects swapped bundle '+field,()=>invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1',v=>v[field]=field.endsWith('Digest')?ownedSha256('other'):'other'),'claim_mismatch'));
it('binds a self-rehashed context and core digest to the actual core',()=>{
 invalid(mutate(ownedFixture(),()=>true,v=>{if(v.binding)v.binding.coreGraphDigest=ownedSha256('other');if('coreGraphDigest'in v)v.coreGraphDigest=ownedSha256('other');}),'claim_mismatch');
 const d=ownedFixture();d.coreGraph.contexts[0].edges.pop();invalid(inspect(d),'claim_mismatch');
});
it('binds an envelope pair and refuses a synthetic terminal reverse reference',()=>{
 invalid(mutate(ownedFixture(),v=>v.role==='offer-receipt',v=>v.envelopeRef=v.refs[0]));
 invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-offer-v2',v=>v.bundleRef={role:'manifest-bundle',objectDigest:'a'.repeat(64),byteLength:1}));
});
it('requires index closure independently of what the index authorizes',()=>{
 invalid(mutate(ownedFixture(),v=>v.role==='evidence-index',v=>v.refs.pop()),'inventory_mismatch');
 invalid(mutate(ownedFixture(),v=>v.role==='evidence-index',v=>v.refs.push(v.refs[0])),'inventory_mismatch');
 const d=ownedFixture();d.ownedOfferObjects.splice(0,1);invalid(inspect(d),'required_evidence_missing');
});
it('rejects an orphan even when it carries a valid digest',()=>{
 const d=ownedFixture(),v=JSON.parse(d.ownedOfferObjects[0].bytes);v.role='evidence';v.evidence=[{kind:'observation',phase:'precheck',matched:false,files:[]}];const bytes=canonicalOwnedJson(v);d.ownedOfferObjects.push({role:'evidence',objectDigest:ownedSha256(bytes),bytes});invalid(inspect(d),'inventory_mismatch');
});
it('rejects content-addressed cycles before accepting claimed digests',()=>{
 const d=ownedFixture(),v=JSON.parse(d.ownedOfferObjects[0].bytes);v.role='evidence';v.evidence=[];v.refs=[{role:'evidence',objectDigest:'c'.repeat(64),byteLength:1}];for(let i=0;i<5;i++)v.refs[0].byteLength=Buffer.byteLength(canonicalOwnedJson(v));d.ownedOfferObjects.push({role:'evidence',objectDigest:'c'.repeat(64),bytes:canonicalOwnedJson(v)});invalid(inspect(d),'schema_invalid');
});
it('rejects role/length corruption and forged object storage',()=>{
 const a=ownedFixture();a.ownedOfferBundles[0].bundleRef.byteLength++;invalid(inspect(a),'content_mismatch');
 const b=ownedFixture();b.ownedOfferObjects[0].role='build-receipt';invalid(inspect(b),'schema_invalid');
 const c=ownedFixture();c.ownedOfferObjects[0].bytes+=' ';invalid(inspect(c),'content_mismatch');
});
for(const value of [null,'',{role:'input-manifest',objectDigest:'0'.repeat(64),byteLength:1}])it('refuses dummy ref '+JSON.stringify(value),()=>invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-manifest-bundle-v1',v=>v.inputManifestRef=value)));
it('distinguishes empty exports and both-missing pairs from dangling pairs',()=>{
 const d=ownedFixture();d.ownedOfferObjects=[];d.ownedOfferBundles=[];expect(inspect(d).owned?.reasons).toEqual(['owned_manifest_envelope_missing']);
 d.ownedOfferBundles=[{project:'main::',context:'runtime',invocation:'i'}];expect(inspect(d).owned?.manifestStructure).toBe('unavailable');
 d.ownedOfferBundles[0].envelopeRef={role:'offer-envelope',objectDigest:'a'.repeat(64),byteLength:1};invalid(inspect(d),'required_evidence_missing');
});
it('rejects duplicate entries, unknown contexts and unknown object fields',()=>{
 const d=ownedFixture();d.ownedOfferBundles.push(d.ownedOfferBundles[0]);invalid(inspect(d));
 const e=ownedFixture();e.ownedOfferBundles[0].context='unknown';invalid(inspect(e),'claim_mismatch');
 invalid(mutate(ownedFixture(),v=>v.role==='input-manifest',v=>v.unknown=true));
});
it('keeps the core when owned JSON has duplicate keys or excessive depth',()=>{
 const d=ownedFixture();let text=JSON.stringify(d);text=text.replace('"ownedOfferBundles":[','"ownedOfferBundles":[{"project":"x","project":"y"},');invalid(parseGradleExport(text));
 const core=JSON.stringify(d.coreGraph);for(const raw of ['['.repeat(200)+'0'+']'.repeat(200),'[NaN]'])invalid(parseGradleExport(`{"schema":"osv-mcp.gradle-graph","schemaVersion":4,"graphId":"g","exportId":"e","coreGraph":${core},"ownedOfferBundles":${raw},"ownedOfferObjects":[]}`));
});
it('keeps legacy core validation strict including duplicate keys and unknown wrapper fields',()=>{
 const d=ownedFixture();d.coreGraph.contexts[0].edges[0].selectedVariant='unknown';expect(()=>inspect(d)).toThrow();
 const e=ownedFixture();e.unknown=true;expect(()=>inspect(e)).toThrow('invalid_graph_wrapper');
 const f=ownedFixture();const raw=JSON.stringify(f).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1');expect(()=>parseGradleExport(raw)).toThrow('duplicate_json_key');
});
it('accepts escaped wrapper keys and preserves future/legacy version handling',()=>{
 expect(parseGradleExport(JSON.stringify(ownedFixture()).replace('osv-mcp.gradle-graph','osv-mcp.\\u0067radle-graph')).owned?.manifestStructure).toBe('verified');
 expect(parseGradleExport(JSON.stringify(graphFixture())).owned).toBeUndefined();
 const d=ownedFixture();d.schemaVersion=5;expect(()=>inspect(d)).toThrow('unsupported_schema_version');
});
for(const field of ['naturalContentBinding','compilerWorkStatus','consumptionStatus','limitations'])it('forbids evidence upgrades '+field,()=>invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-offer-v2',v=>v[field]=field==='naturalContentBinding'?true:field==='limitations'?[]:'complete')));
it('requires call configuration/parameter, phase ordering and all planned captures',()=>{
 invalid(mutate(ownedFixture(),v=>v.role==='evidence'&&v.evidence.some((r:any)=>r.kind==='process'&&r.operation==='bta-call'),v=>v.evidence[0].parameterId='other'),'claim_mismatch');
 invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-offer-v2',v=>v.phases.splice(0,2)));
 invalid(mutate(ownedFixture(),v=>v.schema==='osv-mcp.gradle-owned-offer-v2',v=>v.plannedCaptures=2),'required_evidence_missing');
});
it('refuses false success after a failure and nonmatching state receipts',()=>{
 invalid(mutate(ownedFixture('failed','prepare'),v=>v.role==='failure-receipt',v=>v.evidence[0].reason='input_changed'),'claim_mismatch');
 invalid(mutate(ownedFixture(),v=>v.role==='input-manifest',v=>v.evidence.push({kind:'failure',stage:'prepare',phase:'seal',reason:'input_changed',notProduced:[]})));
});
it('bounds object count and closes admission without a profile loader or artifact reader',()=>{
 const d=ownedFixture();d.ownedOfferObjects=Array(OWNED_LIMITS.objects+1).fill(d.ownedOfferObjects[0]);invalid(inspect(d),'budget_exceeded');
 const r=inspect(ownedFixture());expect(r.owned?.reasons).toEqual(['owned_manifest_trust_disabled']);expect(r.owned?.ownedFileReads).toBe(0);
});
it('canonical JSON preserves bytes, array order and duplicates; rejects unsafe values',()=>{
 const x={z:['日本語 空白/%','a','a'],a:Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('')+'\u007f\u2028\u2029😀'};
 expect(canonicalOwnedJson(x)).toBe(JSON.stringify({a:x.a,z:x.z}));expect(parseOwnedJson(canonicalOwnedJson(x))).toEqual(x);
 for(const v of ['\ud800','\udc00',-0,-1,1.5,NaN,Infinity,9007199254740992])expect(()=>canonicalOwnedJson(v)).toThrow();
 expect(()=>parseOwnedJson('{"a":1,"\\u0061":2}')).toThrow();expect(()=>parseOwnedJson('{"日本語":1}')).toThrow();
});
import {vectors} from '../manual/gradleOwnedManifestResults.mjs';
import {readFileSync} from 'node:fs';
it('matches the established independent Java/Node canonical byte vectors',()=>{
 const record=JSON.parse(readFileSync('docs/validation/gradle-owned-manifest-contract-2026-11-02.json','utf8'));
 for(const [i,v]of vectors.entries()){const expected=record.canonicalComparison[i].java;if(expected==='REJECT')expect(()=>canonicalOwnedJson(v)).toThrow();else expect(Buffer.from(canonicalOwnedJson(v)).toString('base64')).toBe(expected);}
});
it('requires a causal blocked phase and forbids BTA success before unavailable',()=>{
 invalid(mutate(ownedFixture('unavailable','snapshot-generation'),v=>v.schema==='osv-mcp.gradle-owned-offer-v2',v=>delete v.blockedBeforePhase));
 const d=ownedFixture();invalid(mutate(d,()=>true,v=>{if(v.schema==='osv-mcp.gradle-owned-offer-v2'){v.producerState='unavailable';v.completedThrough='snapshot-generation';v.blockedStage='offer';v.unavailableReason='execution_unsupported';v.blockedBeforePhase='capture';}}));
});
it('preserves repeated snapshot occurrences rather than deduplicating positional bindings',()=>{
 const result=mutate(ownedFixture(),v=>v.role==='evidence',v=>{for(const x of v.evidence){if(x.kind==='inventory'&&x.inputRole==='snapshot-generation')x.files.push({...x.files[0]});if(x.kind==='binding')x.snapshotIds.push(x.snapshotIds[0]);if(x.kind==='observation')x.files.push({...x.files[0]});}});
 expect(result.owned?.manifestStructure).toBe('verified');
});
