/** Trusted synthetic principals/pins for I0 tests. No signatures or live registry are asserted here. */
import {ownedDigest as h,ownedSha256 as hash,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {makeSourceCommand} from '../../utils/gradleOwnedSourceSchema.js';
import {registryBinding} from './gradleOwnedRegistryFixture.js';
import {I0_GUARD_POLICY,i0MakeBatch,type I0Mode,type I0Manifest} from './gradleOwnedCgpI0Schema.js';
import {CgpI0Authority} from './gradleOwnedCgpI0Authority.js';
export function manifestCase(mode:I0Mode='B*'){
 const manifest:I0Manifest={schema:'cgp.i0.mode-manifest.v1',mode,serviceProfile:hash('P_exp'),producerPolicy:hash('policy'),observerDigest:hash('observer'),guard:structuredClone(I0_GUARD_POLICY),guardDigest:h(I0_GUARD_POLICY),facts:['A*','AB*'].includes(mode),readPlan:{schema:'cgp.i0.read-plan.v4',algorithm:['B*','AB*'].includes(mode)?'ranges-v1':'scalar-control-v1',maxBatches:256,maxDataBytes:196608,maxEntries:256,maxWireBytes:64*1024*1024,maxWorkUnits:64*1024*1024},fixtureApproved:true};
 const pins={manifestDigest:h(manifest),serviceProfile:manifest.serviceProfile,producerPolicy:manifest.producerPolicy,observerDigest:manifest.observerDigest,guardDigest:manifest.guardDigest};return {manifest,pins};
}
export function i0Case(mode:I0Mode='B*',sizes=[600,700,1600,2000,3000]){
 const m=manifestCase(mode),identity=(role:string)=>({credentialId:role+(role==='provider'?'-reply':'-request'),role:role as any,instanceId:role,boot:hash(role),keyEpoch:1}),principals=['reader','authority-broker','checkpoint-issuer','writer','provider'].map(identity),reader=identity('reader'),server=identity('provider');
 const ref=(role:string)=>({role:role as any,id:hash(role),sha256:hash(role),byteLength:64}),snapshot=ref('snapshot'),checkpoint=ref('checkpoint-prepare'),pin=ref('read-pin'),base=registryBinding(),binding={...base,profileDigest:m.manifest.serviceProfile,mode:'serving' as const,selectionRevision:1,namespaceGeneration:1,selected:{snapshot,checkpoint,head:{format:'v2' as const,revision:1,commitDigest:hash('commit'),stateRoot:hash('state'),baseDigest:hash('base')}}},lineage={authorityId:binding.authorityId,lineageId:binding.lineageId,generation:binding.generation,storeEpoch:binding.storeEpoch,enrollmentDigest:binding.enrollmentDigest,profileDigest:binding.profileDigest};
 const metadata={binding:{authorityId:lineage.authorityId,lineageId:lineage.lineageId,generation:1,storeEpoch:lineage.storeEpoch,profileDigest:lineage.profileDigest},baseRef:{role:'compacted-base',id:'base',sha256:hash('base-ref'),byteLength:4},keyId:'source',approvedBaseDigest:hash('base'),checkpoint:{revision:1,commitDigest:hash('commit')}};
 const data=sizes.map((size,i)=>Buffer.alloc(size,65+i)),entries=data.map((b,i)=>({kind:(i===0?'commit':'payload')as 'commit'|'payload',index:i===0?0:i-1,sha256:hash(b),byteLength:b.length})),inventory=Buffer.from(canonicalOwnedJson({schema:'osv-mcp.q2.c3b.source-inventory.v1',metadataDigest:h(metadata),entries})),inventoryPin={schema:'cgp.i0.inventory-pin.v1',snapshot,metadata,ref:{sha256:hash(inventory),byteLength:inventory.length},inventoryDigest:h({domain:'c3b-source-inventory-v1',metadata,entries}),sourceBytes:data.reduce((n,b)=>n+b.length,0),entryCount:entries.length};
 const config={...m,scope:{binding,lineage,pin,reader,server},inventoryPin,principals};
 const authority=new CgpI0Authority(config);
 function open(role='reader',domain='server-clock',deadline=4500,readId='read-1'){return authority.open(identity(role).credentialId,domain,deadline,readId);}
 function command(role='reader',api?:string,payload?:any,operationId='op-1'){
  const peer=identity(role),batch=['B*','AB*'].includes(mode);api??=role==='checkpoint-issuer'?'aux.ResolveNamespace':batch?'aux.ReadSourceRanges':'aux.ReadSealedSource';
  payload??=api==='aux.ResolveNamespace'?{snapshot,target:pin,origin:reader}:api==='aux.ReadSourceDescriptor'?{snapshot,checkpoint,pin}:{snapshot,checkpoint,pin,...(role==='reader'?{}:{origin:reader}),transferId:'transfer',...(api==='aux.ReadSourceRanges'?{planDigest:hash('plan'),ranges:[{ordinal:0,kind:entries[0]!.kind,index:0,offset:0,length:Math.min(16,entries[0]!.byteLength),entry:{sha256:entries[0]!.sha256,byteLength:entries[0]!.byteLength}}],byteBudget:Math.min(16,entries[0]!.byteLength)}:{kind:'commit',index:0,offset:0,maxBytes:Math.min(16,entries[0]!.byteLength)})};
  return api==='aux.ReadSourceRanges'?i0MakeBatch({schema:'osv-mcp.cgp.source-command.v2',api,purpose:'read',operationId,peer,lineage,binding,payload}):makeSourceCommand({api:api as any,operationId,peer,lineage,binding,payload});
 }
 return {config,manifest:m.manifest,pins:m.pins,authority,open,command,reader,server,identity,binding,lineage,snapshot,checkpoint,pin,metadata,entries,data,inventory,inventoryPin};
}
