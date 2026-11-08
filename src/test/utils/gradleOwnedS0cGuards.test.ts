import {it,expect,describe} from 'vitest';
import {verifyPublicRegistryRecord} from '../../utils/gradleOwnedAnchorOwner.js';
import {canonicalOwnedJson,ownedSha256 as h} from '../../utils/gradleOwnedJson.js';
import {buildS0c,materializeS0c,expectedS0c,bucketOf,type Bundle} from '../fixtures/gradleOwnedS0c.js';
import {s0cData,s0cStored,s0cSourceOwner} from '../fixtures/gradleOwnedS0cData.js';
import {rewriteS0c,addS0cObject} from '../fixtures/gradleOwnedS0cRewrite.js';
import {serviceTestLineage} from '../fixtures/gradleOwnedServiceContract.js';

const REJECT=(b:Bundle,keys:any,reason:string)=>expect(()=>materializeS0c(b,keys,expectedS0c(b))).toThrow(reason);
const fresh=(mode:'F'|'W'|'P',count=3)=>{const {input,keys}=s0cData(count);return {input,keys,b:buildS0c(input,mode,keys)};};
const values=(b:Bundle)=>b.objects.map(o=>({o,v:JSON.parse(o.bytes.toString())}));
const isRoot=(o:any)=>o.schema==='cgp.s0.owner-root.v1';
const isPage=(o:any)=>o.schema==='cgp.s0.owner-page.v1';
const isDir=(o:any)=>o.schema==='cgp.s0.page-directory.v1';
const isSigned=(o:any)=>o.schema==='cgp.s0.signed-record.v1';
const isLive=(o:any)=>o.schema==='cgp.s0.registry-liveness.v1';
const isAnchor=(o:any)=>o.binding?.owner==='control-anchor';
function replaceFull(b:Bundle,owner:string,revision:number,change:(v:any)=>void){const o=b.objects.find(o=>{const v=JSON.parse(o.bytes.toString());return v.owner===owner&&v.revision===revision;})!,v=JSON.parse(o.bytes.toString()),old=o.ref.sha256;change(v);const bytes=Buffer.from(canonicalOwnedJson(v,8388608)),ref={...o.ref,sha256:h(bytes),byteLength:bytes.length};o.ref=ref;o.bytes=bytes;b.roots=b.roots.map(r=>r.sha256===old?ref:r);b.retained=b.retained.map(r=>r.ref.sha256===old?{...r,ref}:r);}
/** Drops objects no root or retained ref reaches, so a replaced page that no other revision shares is not left as an unrecorded object. */
function pruneUnreachable(b:Bundle){const byHash=new Map(b.objects.map(o=>[o.ref.sha256,o])),seen=new Set<string>(),visit=(v:any):void=>{if(Array.isArray(v)){v.forEach(visit);return;}if(!v||typeof v!=='object')return;if(v.sha256&&v.role&&v.schema&&v.byteLength&&byHash.has(v.sha256)&&!seen.has(v.sha256)){seen.add(v.sha256);visit(JSON.parse(byHash.get(v.sha256)!.bytes.toString()));}for(const x of Object.values(v))visit(x);};b.roots.forEach(visit);b.retained.forEach(r=>visit(r.ref));b.objects=b.objects.filter(o=>seen.has(o.ref.sha256));}
/** Gives only the Anchor directory of `count` rows a private copy of one row. A page shared with older revisions stays intact; whether it is shared depends on the bucket of the newest row, which varies with the generated keys. */
function forkAnchorRow(b:Bundle,keys:any,count:number,ordinal:number,change:(row:any)=>void){const dir=values(b).find(({v})=>isDir(v)&&isAnchor(v)&&v.field==='entries'&&v.count===count)!.v,index=dir.pages.findIndex((p:any)=>{const page=JSON.parse(b.objects.find(o=>o.ref.sha256===p.ref.sha256)!.bytes.toString());return page.data.rows.some((r:any)=>r.ordinal===ordinal);}),page=JSON.parse(b.objects.find(o=>o.ref.sha256===dir.pages[index].ref.sha256)!.bytes.toString());change(page.data.rows.find((r:any)=>r.ordinal===ordinal));page.data.rows.sort((x:any,y:any)=>x.key<y.key?-1:x.key>y.key?1:0);const copy=addS0cObject(b,page,'page');rewriteS0c(b,keys,o=>{if(isDir(o)&&isAnchor(o)&&o.field==='entries'&&o.count===count)o.pages[index].ref=copy;},true);pruneUnreachable(b);}

describe('source records follow the production verifier',()=>{
 const base=()=>{const {input,keys}=s0cData(1);return {keys,body:JSON.parse(Buffer.from(input.records[0]!.wire,'base64').toString()).body};};
 const cases:[string,(e:any)=>void,string][]=[['domain',e=>{e.domain='aux';},'peer_mismatch'],['api',e=>{e.api='control.ReleaseReadPin';},'peer_mismatch'],['instance',e=>{e.identity.instanceId='other';},'peer_mismatch'],['credential',e=>{e.identity.credentialId='other-reply';},'peer_mismatch'],['keyId',e=>{e.keyId='other-reply';},'peer_mismatch'],['keyEpoch',e=>{e.identity.keyEpoch=99;},'peer_mismatch'],['direction',e=>{e.direction='request';},'peer_mismatch'],['role',e=>{e.identity.role='provider';},'peer_mismatch'],['attemptId',e=>{e.body.attemptId=h('forged');},'binding_mismatch'],['ownerId',e=>{e.body.ownerId='other-owner';},'binding_mismatch'],['storageEpoch',e=>{e.body.storageEpoch=h('other');},'binding_mismatch'],['lineage',e=>{e.body.lineage={...e.body.lineage,lineageId:'other'};},'binding_mismatch'],['body api',e=>{e.body.api='ReleaseReadPin';},'peer_mismatch']];
 it.each(cases)('refuses a validly signed record with a forged %s exactly as production does',(_n,forge,reason)=>{const {keys,body}=base(),stored=s0cStored(body,forge),attemptId=JSON.parse(Buffer.from(stored.wire,'base64').toString()).body.attemptId;expect(()=>verifyPublicRegistryRecord(stored as any,keys.source.registry,s0cSourceOwner,serviceTestLineage)).toThrow(reason);expect(()=>buildS0c({records:[stored],entries:[{expected:{revision:0,record:null},next:{revision:1,record:stored.ref},attemptId,record:stored}]} as any,'P',keys)).toThrow(reason);});
 it('accepts what production accepts, including a historical boot',()=>{const {keys,body}=base(),stored=s0cStored(body,e=>{e.identity.boot=h('earlier');});expect(verifyPublicRegistryRecord(stored as any,keys.source.registry,s0cSourceOwner,serviceTestLineage).attemptId).toBe(body.attemptId);expect(()=>buildS0c({records:[stored],entries:[{expected:{revision:0,record:null},next:{revision:1,record:stored.ref},attemptId:body.attemptId,record:stored}]} as any,'P',keys)).not.toThrow();});
 it.each(['F','W'] as const)('re-verifies the source record when materializing %s',mode=>{const {input,keys,b}=fresh(mode,1),other={...keys,source:{...keys.source,owner:{...s0cSourceOwner,storageEpoch:h('other-store')}}};void input;expect(()=>materializeS0c(b,other,expectedS0c(b))).toThrow('binding_mismatch');});
});

describe('builder history',()=>{
 const reject=(change:(input:any)=>void)=>{const {input,keys}=s0cData(2);change(input);expect(()=>buildS0c(input,'P',keys)).toThrow('binding_mismatch');};
 it('binds the last next revision',()=>reject(i=>{i.entries[1].next.revision=9;}));
 it('binds the entry record',()=>reject(i=>{i.entries[1].record=i.records[0];}));
 it('binds the next record',()=>reject(i=>{i.entries[1].next.record=i.records[0].ref;}));
 it('binds the expected head',()=>reject(i=>{i.entries[1].expected={revision:0,record:null};}));
 it('binds the attempt',()=>reject(i=>{i.entries[1].attemptId=h('other');}));
 it('binds the signed previous ref',()=>{const {input,keys}=s0cData(2,0,undefined,(fields,i)=>{if(i===2)fields.previous=null;});expect(()=>buildS0c(input,'P',keys)).toThrow('binding_mismatch');});
 it('binds the record revision to its position',()=>{const {input,keys}=s0cData(2,0,undefined,(fields,i)=>{if(i===2)fields.revision=3;});expect(()=>buildS0c(input,'P',keys)).toThrow('binding_mismatch');});
});

describe('catalog and references',()=>{
 it('rejects a foreign profile digest even for a self-consistent catalog',()=>{const {keys,b}=fresh('W');b.profileDigest=h('other');REJECT(b,keys,'profile_or_catalog_mismatch');});
 it('rejects a declared length that disagrees with correctly hashed bytes',()=>{const {keys,b}=fresh('P');b.objects[0]!.ref={...b.objects[0]!.ref,byteLength:b.objects[0]!.ref.byteLength+1};REJECT(b,keys,'content_changed');});
 it('rejects a ref whose schema disagrees with its role even when object and catalog agree',()=>{const {keys,b}=fresh('F',1),old=b.roots[0]!.sha256,ref={...b.roots[0]!,schema:'cgp.s0.other'};b.objects.find(o=>o.ref.sha256===old)!.ref=ref;b.roots=b.roots.map(r=>r.sha256===old?ref:r);b.retained=b.retained.map(r=>r.ref.sha256===old?{...r,ref}:r);REJECT(b,keys,'ref_type');});
 it('rejects a first-seen ref with a wrong length',()=>{const {keys,b}=fresh('P');b.roots[0]={...b.roots[0]!,byteLength:b.roots[0]!.byteLength+1};REJECT(b,keys,'missing_ref');});
 it('rejects a wrong length on an object already visited',()=>{const {keys,b}=fresh('P'),last=b.retained.at(-1)!;last.ref={...last.ref,byteLength:last.ref.byteLength+1};REJECT(b,keys,'ref_type');});
 it('visits every retained ref',()=>{const {keys,b}=fresh('P');b.retained.push({kind:'hold',id:'extra',ref:{...b.roots[0]!,sha256:h('absent')}});REJECT(b,keys,'missing_ref');});
 it('requires a root at the top of the catalog',()=>{const {keys,b}=fresh('P'),dir=b.objects.find(o=>o.ref.role==='directory')!;b.roots[1]=dir.ref;REJECT(b,keys,'ref_type');});
 it('rejects a full image retained by a paged bundle',()=>{const {input,keys,b}=fresh('W'),full=buildS0c(input,'F',keys).objects[0]!;b.objects.push(full);b.retained.push({kind:'hold',id:'extra',ref:full.ref});REJECT(b,keys,'format_mismatch');});
 it('rejects a signed compact record retained by a whole-wire bundle',()=>{const {input,keys,b}=fresh('W'),signed=buildS0c(input,'P',keys).objects.find(o=>o.ref.role==='signed-record')!;b.objects.push(signed);b.retained.push({kind:'hold',id:'extra',ref:signed.ref});REJECT(b,keys,'signature_invalid');});
 it('rejects a full image whose owner disagrees with its shape',()=>{const {keys,b}=fresh('F',1),v=values(b).find(({v})=>v.owner==='lineage-registry')!.v;v.owner='control-anchor';const ref=addS0cObject(b,v,'full');b.retained.push({kind:'hold',id:'extra',ref});REJECT(b,keys,'binding_mismatch');});
});

describe('F image',()=>{
 it('binds the registry image to the signed wire',()=>{const {keys,b}=fresh('F');replaceFull(b,'lineage-registry',2,v=>{v.image.state.revocationEpoch=77;});REJECT(b,keys,'state_digest');});
 it('rejects a rewritten Anchor prefix',()=>{const {keys,b}=fresh('F');replaceFull(b,'control-anchor',3,v=>{v.image[0].attemptId=h('rewritten');});REJECT(b,keys,'anchor_history');});
 it('rejects swapped owners in a root pair',()=>{const {keys,b}=fresh('F',1);b.roots=[b.roots[1]!,b.roots[0]!];REJECT(b,keys,'binding_mismatch');});
 it('binds the last expected head',()=>{const {keys,b}=fresh('F',2);replaceFull(b,'control-anchor',2,v=>{v.image[1].expected={revision:0,record:null};});REJECT(b,keys,'binding_mismatch');});
 it('binds the registry previous ref',()=>{const {keys,b}=fresh('F',2);replaceFull(b,'lineage-registry',2,v=>{v.image.previous=null;});REJECT(b,keys,'binding_mismatch');});
});

describe.each(['W','P'] as const)('typed roots and pages in %s',mode=>{
 const run=(change:(o:any)=>void,reason:string,count=3)=>{const {keys,b}=fresh(mode,count);rewriteS0c(b,keys,change,true);REJECT(b,keys,reason);};
 it('binds the binding generation to its lineage',()=>run(o=>{if(o.binding)o.binding.generation++;},'format_mismatch'));
 it('rejects a later root revision through its parent',()=>run(o=>{if(isRoot(o)&&o.revision===2)o.revision=3;},'parent_mismatch'));
 it('binds a directory to its root',()=>run(o=>{if(isDir(o)||isPage(o))o.binding.generation++;},'binding_mismatch'));
 it('binds a page to its directory',()=>run(o=>{if(isPage(o))o.binding.generation++;},'binding_mismatch'));
 it('binds liveness to its root',()=>run(o=>{if(isLive(o))o.binding.generation++;},'binding_mismatch'));
 it('binds a directory field to its root slot',()=>run(o=>{if(isDir(o)&&o.count===0)o.field=o.field==='pins'?'handoffs':'pins';},'binding_mismatch'));
 it('binds a root directory count',()=>run(o=>{if(isRoot(o))for(const d of o.directories)if(d.field==='pins')d.count=1;},'binding_mismatch'));
 it('binds the directory slot bucket',()=>run(o=>{if(isDir(o)&&o.pages.length===1)o.pages[0].bucket=(o.pages[0].bucket+1)%16;},'binding_mismatch'));
 it('binds the directory slot count',()=>run(o=>{if(isDir(o))for(const p of o.pages)p.count++;},'binding_mismatch'));
 it('rejects liveness on an Anchor root',()=>{const {keys,b}=fresh(mode),live=values(b).find(({v})=>isLive(v))!.o.ref;rewriteS0c(b,keys,o=>{if(isRoot(o)&&isAnchor(o))o.liveness=live;},true);REJECT(b,keys,'field_coverage');});
 it('binds the pair lineage',()=>run(o=>{if(isAnchor(o))o.binding.lineage.lineageId='other';},'binding_mismatch'));
 it('binds the pair store epoch',()=>run(o=>{if(isAnchor(o))o.binding.storeEpoch=h('other');},'binding_mismatch'));
 it('rejects swapped owners in a root pair',()=>{const {keys,b}=fresh(mode,1);b.roots=[b.roots[1]!,b.roots[0]!];REJECT(b,keys,'binding_mismatch');});
 it('binds a page representation to its format',()=>run(o=>{if(isPage(o)&&o.data.field==='ledger')o.data.representation=mode==='P'?'W':'P';},'count_mismatch'));
 it('keeps keys sorted inside a page',()=>{const inBucket:string[]=[];for(let i=0;inBucket.length<3;i++){const key=h('sorted-'+i);if(bucketOf(key)===0)inBucket.push(key);}const {input,keys}=s0cData(1,0,s=>{const t=s.ledger[0];s.ledger=inBucket.map((key,i)=>({...t,key,operationId:'sorted-'+i}));}),b=buildS0c(input,mode,keys);rewriteS0c(b,keys,o=>{if(isPage(o)&&o.data.field==='ledger')o.data.rows.reverse();},true);REJECT(b,keys,'key_or_bucket');});
 it('binds a row key to its value within the same bucket',()=>{const {input,keys}=s0cData(1),b=buildS0c(input,mode,keys);rewriteS0c(b,keys,o=>{if(isPage(o)&&o.data.field==='ledger'){const row=o.data.rows[0];let i=0,key=h('same-bucket-'+i);while(bucketOf(key)!==o.bucket)key=h('same-bucket-'+(++i));row.key=key;}},true);REJECT(b,keys,'key_or_bucket');});
});

it('W binds the registry pages to the signed wire',()=>{const {keys,b}=fresh('W');rewriteS0c(b,keys,o=>{if(isLive(o)&&o.value.selectionRevision===2)o.value.revocationEpoch=77;},true);REJECT(b,keys,'state_digest');});
it('W rejects a rewritten Anchor prefix in a later revision only',()=>{const {keys,b}=fresh('W');forkAnchorRow(b,keys,3,0,row=>{row.value.next.revision=5;});REJECT(b,keys,'anchor_history');});

describe('compact records',()=>{
 const run=(change:(o:any)=>void,reason:string,count=3)=>{const {keys,b}=fresh('P',count);rewriteS0c(b,keys,change,true);REJECT(b,keys,reason);};
 const at=(o:any,revision:number)=>isSigned(o)&&o.body.header.revision===revision;
 it('requires the pinned key ID',()=>run(o=>{if(isSigned(o))o.keyId='other-key';},'signature_invalid'));
 it('binds the header revision to the state root',()=>run(o=>{if(at(o,2))o.body.header.revision=3;},'binding_mismatch'));
 it('binds the header lineage to the state root',()=>run(o=>{if(at(o,2))o.body.header.lineage={...o.body.header.lineage,lineageId:'other'};},'binding_mismatch'));
 it('binds the header store epoch to the state root',()=>run(o=>{if(at(o,2))o.body.header.storageEpoch=h('other');},'binding_mismatch'));
 it('binds a lineage rewritten across the whole history to the state roots',()=>run(o=>{if(isSigned(o))o.body.header.lineage={...o.body.header.lineage,lineageId:'other'};},'binding_mismatch'));
 it('keeps the owner across the history',()=>run(o=>{if(at(o,2))o.body.header.ownerId='other-owner';},'binding_mismatch'));
 it('binds the compact previous to the preceding revision',()=>{const {keys,b}=fresh('P'),first=values(b).find(({v})=>at(v,1))!;rewriteS0c(b,keys,o=>{if(at(o,3)){o.body.previous=first.o.ref;o.body.header.previous=first.v.body.originalRef;}},true);REJECT(b,keys,'parent_mismatch');});
 it('binds the header previous to the compact previous',()=>run(o=>{if(at(o,2))o.body.header.previous={...o.body.header.previous,id:h('x'),sha256:h('x')};},'parent_mismatch'));
 it('rejects a first record that claims a predecessor',()=>{const {keys,b}=fresh('P'),second=values(b).find(({v})=>at(v,2))!.v;rewriteS0c(b,keys,o=>{if(at(o,1))o.body.header.previous=second.body.originalRef;},true);REJECT(b,keys,'parent_mismatch');});
 it('requires a compact entry to reference a signed record',()=>run(o=>{if(isPage(o)&&o.data.field==='entries')for(const row of o.data.rows)row.value.record={...row.value.record,role:'page'};},'ref_type'));
 it('binds the attempt inside an older row',()=>{const {keys,b}=fresh('P');forkAnchorRow(b,keys,2,0,row=>{let i=0,key=h('same-attempt-bucket-'+i);while(bucketOf(key)!==bucketOf(row.key))key=h('same-attempt-bucket-'+(++i));row.key=key;row.value.attemptId=key;});REJECT(b,keys,'binding_mismatch');});
 it('rejects a handoff directory hidden behind an absent-handoffs flag',()=>{const cref=(role:string)=>({role,id:h(role),sha256:h(role),byteLength:1}),{input,keys}=s0cData(1,0,s=>{const owner=s.ledger[0].owner;s.handoffs=[{pin:cref('read-pin'),reader:owner,broker:owner,useId:'use-1',gate:cref('authority-gate'),witness:cref('checkpoint-witness'),result:cref('candidate-result'),phase:'completing',operationKey:h('handoff'),authorityRevision:1}];}),b=buildS0c(input,'P',keys);rewriteS0c(b,keys,o=>{if(isLive(o))o.handoffsPresent=false;},true);REJECT(b,keys,'field_coverage');});
 it('binds the entry next ref to its record',()=>{const {keys,b}=fresh('P'),first=values(b).find(({v})=>at(v,1))!.o.ref;forkAnchorRow(b,keys,2,1,row=>{row.value.next.record=first;});REJECT(b,keys,'binding_mismatch');});
 it('binds the next revision inside an older row',()=>{const {keys,b}=fresh('P');forkAnchorRow(b,keys,2,0,row=>{row.value.next.revision=9;});REJECT(b,keys,'binding_mismatch');});
 it('binds the expected head inside an older row',()=>{const {keys,b}=fresh('P');forkAnchorRow(b,keys,3,1,row=>{row.value.expected={revision:0,record:null};});REJECT(b,keys,'binding_mismatch');});
});
