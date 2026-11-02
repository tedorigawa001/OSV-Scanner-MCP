import {it,expect} from 'vitest';
import {canonicalBytes,parseManifestJson,objectDigest} from '../fixtures/ownedManifestContract.mjs';
it('BM01 canonicalizes keys without changing string bytes or array occurrences',()=>{
 const a={z:['日本語 空白/%', 'same','same'],a:'\b\f\u0000\u2028\u2029😀'};
 expect(canonicalBytes(a).toString()).toBe(JSON.stringify({a:a.a,z:a.z}));
 expect(objectDigest(a)).toBe(objectDigest({a:a.a,z:a.z}));
});

import {describe} from 'vitest';
import {verifyManifest,stages,successRefs,failureCases,sha256} from '../fixtures/ownedManifestContract.mjs';
import {manifestFixture,reseal} from '../fixtures/ownedManifestFixtures.mjs';
const check=(f:any)=>verifyManifest(f.transport,f.expected);
function reject(f:any,change:(f:any)=>void,reason?:string){change(f);reseal(f);expect(()=>check(f)).toThrow(reason);}
describe('BM01 strict canonical JSON',()=>{
 it.each(['{"a":1,"a":2}','{"a":1,"\\u0061":2}','"\\ud800"','"\\udc00"','-0','1.1','9007199254740992','{"x":1}x'])('rejects %s',s=>expect(()=>parseManifestJson(s)).toThrow());
 it('preserves escaping and distinguishes raw file bytes',()=>{
  const x={a:'\\"\b\f\n\r\t'+Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('')};
  expect(canonicalBytes(parseManifestJson(canonicalBytes(x)))).toEqual(canonicalBytes(x));
  expect(sha256('\ufeffa\r\n')).not.toBe(sha256('a\n'));
  expect(objectDigest(['a','a'])).not.toBe(objectDigest(['a']));
  expect(objectDigest(['a','b'])).not.toBe(objectDigest(['b','a']));
 });
 it.each([NaN,Infinity,-1,-0,1.5,undefined,'\ud800','\udc00'])('rejects invalid value %#',x=>expect(()=>canonicalBytes(x)).toThrow());
});
describe('BM02 state unions and closed inventory',()=>{
 it('accepts complete prefix without authorizing diagnostics',()=>expect(check(manifestFixture())).toMatchObject({status:'structure_verified',objects:6,diagnosticEligible:false,naturalContentBinding:false}));
 for(const state of ['failed','unavailable'])for(const through of ['none',...stages.slice(0,4)])it(`${state} after ${through}`,()=>expect(check(manifestFixture(state,through)).producerState).toBe(state));
 it('accepts unresolved approval with no resolved digests',()=>{const f=manifestFixture('unavailable','none');delete f.bundle.profileDigest;delete f.bundle.recipeDigest;f.bundle.approvalStatus='unavailable';reseal(f);expect(check(f).status).toBe('structure_verified');});
 for(const key of successRefs)it(`requires ${key}`,()=>reject(manifestFixture(),f=>delete f.bundle[key]));
 it.each([null,'',{role:'input-manifest',objectDigest:'0'.repeat(64),byteLength:1}])('rejects dummy ref %#',v=>reject(manifestFixture(),f=>f.bundle.inputManifestRef=v));
 for(const state of ['failed','unavailable'])for(const through of ['none',...stages.slice(0,4)])it(`forbids future ref ${state}/${through}`,()=>reject(manifestFixture(state,through),f=>f.bundle[successRefs[through==='none'?0:stages.indexOf(through)+1]!]=manifestFixture().bundle.offerReceiptRef));
 it('rejects unknown field',()=>reject(manifestFixture(),f=>f.bundle.extra=true));
 it('requires index and state evidence',()=>{for(const state of ['completed','failed','unavailable']){const f=manifestFixture(state,state==='completed'?'offer':'none');f.transport.objects=[];expect(()=>check(f)).toThrow('required_evidence_missing');}});
 it('rejects orphan, role substitution and corrupted storage',()=>{
  const f=manifestFixture();f.transport.objects.push({...f.transport.objects[0],objectDigest:sha256('orphan')});expect(()=>check(f)).toThrow('inventory_mismatch');
  reject(manifestFixture(),f=>f.bundle.inputManifestRef.role='offer-receipt');
  const g=manifestFixture();g.transport.objects[0].bytes=Buffer.from('{}');expect(()=>check(g)).toThrow();
 });
 it('classifies missing envelope and bundle',()=>{expect(verifyManifest({},{})).toMatchObject({reason:'owned_offer_envelope_missing'});expect(()=>verifyManifest({envelope:'{}'},{})).toThrow('required_evidence_missing');});
});
describe('BM03 independent binding',()=>{
 for(const key of ['graphId','exportId','project','context','executionId','invocation','profileId','recipeId','coreGraphDigest','profileDigest','recipeDigest'])it(`rejects self-resealed ${key}`,()=>reject(manifestFixture(),f=>{f.bundle[key]=sha256('changed');if(key in f.envelope)f.envelope[key]=f.bundle[key];},'binding_mismatch'));
 it('rejects core graph mutation and envelope pair replacement',()=>{const f=manifestFixture();f.transport.coreGraph=canonicalBytes({changed:true});expect(()=>check(f)).toThrow('binding_mismatch');const g=manifestFixture();g.transport.entry.envelopeDigest=sha256('other');expect(()=>check(g)).toThrow('content_mismatch');});
});
describe('BM17 legal failures and rejected claims',()=>{
 for(const f of failureCases)it(`${f.stage}/${f.phase}/${f.reason}`,()=>{const n=stages.indexOf(f.stage);expect(check(manifestFixture('failed',n?stages[n-1]:'none',f)).producerState).toBe('failed');});
 it.each(['failureStage','failurePhase','failureReason','completedThrough','producerState'])('rejects forged %s',key=>reject(manifestFixture('failed','prepare'),f=>f.bundle[key]=key==='producerState'?'unavailable':'forged'));
 it('rejects mixed failure/unavailable state and premature approval',()=>{reject(manifestFixture('unavailable','build'),f=>f.bundle.failureReceiptRef=f.bundle.unavailableEvidenceRef);reject(manifestFixture('unavailable','none'),f=>f.bundle.approvalStatus='unavailable');});
});

it('BM02 rejects cyclic and self references before trusting declared hashes',()=>{
 const f=manifestFixture();const index=f.transport.objects.at(-1);const o=JSON.parse(index.bytes);o.refs.push(f.bundle.evidenceIndexRef);index.bytes=canonicalBytes(o);expect(()=>check(f)).toThrow('owned_manifest_cycle');
});
it('BM02 rejects file traversal, absolute paths and evidence inventories',()=>{
 for(const path of ['../x','/tmp/x','C:/x','x\\y','a//b']){const f=manifestFixture();const o=JSON.parse(f.transport.objects[0].bytes);o.files[0].path=path;f.transport.objects[0].bytes=canonicalBytes(o);expect(()=>check(f)).toThrow();}
 const f=manifestFixture();const o=JSON.parse(f.transport.objects[0].bytes);o.files[0].rootId='evidence';f.transport.objects[0].bytes=canonicalBytes(o);expect(()=>check(f)).toThrow();
});

import {readFileSync} from 'node:fs';
import {vectors,fingerprints,staticCases} from '../manual/gradleOwnedManifestResults.mjs';
it('replays saved static results, canonical vectors and source fingerprints',()=>{
 const record=JSON.parse(readFileSync('docs/validation/gradle-owned-manifest-contract-2026-11-02.json','utf8'));
 expect(record.sources).toEqual(fingerprints());expect(record.cases).toEqual(staticCases());
 expect(record.canonicalComparison).toHaveLength(vectors.length);
 for(const [i,v]of vectors.entries()){let node;try{node=canonicalBytes(v).toString('base64');}catch{node='REJECT';}expect(record.canonicalComparison[i]).toEqual({vector:i,node,java:node,matched:true});}
});

import {rewriteFixtureObject} from '../fixtures/ownedManifestFixtures.mjs';
it('BM02 rejects unknown object fields, substituted build, unapproved roots and non-prefix edges after full rehash',()=>{
 for(const mutate of [(o:any)=>o.unknown=true,(o:any)=>o.buildInvocationId='other',(o:any)=>o.files[0].rootId='unapproved',(o:any)=>o.files[0].path='../escape']){
  const f=rewriteFixtureObject(manifestFixture(),0,mutate);expect(()=>check(f)).toThrow();
 }
 const f=rewriteFixtureObject(manifestFixture(),1,o=>o.refs=[]);expect(()=>check(f)).toThrow();
 const g=rewriteFixtureObject(manifestFixture(),5,o=>o.refs.pop());expect(()=>check(g)).toThrow('required_evidence_missing');
});
it('BM17 refuses self-rehashed failure stage, phase, reason and prefix claims',()=>{
 for(const key of ['stage','phase','reason','completedThrough']){const f=rewriteFixtureObject(manifestFixture('failed','prepare'),1,o=>o[key]='forged');expect(()=>check(f)).toThrow('claim_mismatch');}
});
it('BM03 refuses self-rehashed upstream context and mismatched envelope attachment',()=>{
 const f=rewriteFixtureObject(manifestFixture(),0,o=>o.binding.context='other');expect(()=>check(f)).toThrow('binding_mismatch');
 const g=rewriteFixtureObject(manifestFixture(),4,o=>o.envelopeDigest=sha256('other-envelope'));expect(()=>check(g)).toThrow('binding_mismatch');
});
it('BM01 enforces parse budgets, malformed UTF8 and array holes',()=>{
 expect(()=>parseManifestJson(Buffer.from([0xff]))).toThrow();
 expect(()=>parseManifestJson(Buffer.from('\ufeff{}'))).toThrow();
 expect(()=>parseManifestJson('['.repeat(34)+'0'+']'.repeat(34))).toThrow('budget_exceeded');
 expect(()=>canonicalBytes(new Array(1))).toThrow();
});
it('BM02 bounds object inventories and rejects malformed root JSON',()=>{
 const f=manifestFixture();f.transport.objects=Array(129).fill(f.transport.objects[0]);expect(()=>check(f)).toThrow('budget_exceeded');
 for(const value of ['null','[]','1']){const g=manifestFixture();g.transport.bundle=value;expect(()=>check(g)).toThrow('schema_invalid');}
});
it('BM03 binds offer and terminal receipts to their invocation while upstream builds remain shared',()=>{
 for(const [state,through,index]of [['completed','offer',4],['failed','prepare',1],['unavailable','prepare',1]]as const){const f=rewriteFixtureObject(manifestFixture(state,through),index,o=>o.invocation='other-offer');expect(()=>check(f)).toThrow('binding_mismatch');}
});
