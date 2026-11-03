import {it,expect} from 'vitest';
import {generateKeyPairSync,sign} from 'node:crypto';
import {auxiliaryAPIs,auxiliaryPolicy,auxiliaryIntent,validateAuxiliaryRequest,verifyAuxiliaryRequest,verifyAuxiliaryReply,validateReadBudget,admitReadClosure,readBudgetPhases,type AuxiliaryAPI} from '../../utils/gradleOwnedCurrentAuxiliary.js';
import {currentRoles,CURRENT_LIMITS} from '../../utils/gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256 as h} from '../../utils/gradleOwnedJson.js';
const client=generateKeyPairSync('ed25519'),server=generateKeyPairSync('ed25519');
const ref=(role:string,id=role)=>({role,id,sha256:h(id),byteLength:1});
const head={format:'v2',revision:1,commitDigest:h('commit'),stateRoot:h('state'),baseDigest:h('base')};
const selected={snapshot:ref('snapshot'),checkpoint:ref('checkpoint-prepare'),head};
const binding={authorityId:'a',lineageId:'l',generation:1,storeEpoch:h('epoch'),format:'v2',storeRootId:'store',checkpointRootId:'cp',rootPairId:'pair',storageInstanceId:'storage',providerBoot:h('provider'),namespaceGeneration:1,writerFence:1,registryIncarnation:h('registry'),selectionRevision:1,revocationEpoch:0,checkpointIssuer:'issuer',checkpointKeyEpoch:1,enrollmentDigest:h('enrollment'),schemaDigest:h('schema'),parserDigest:h('parser'),policyDigest:h('policy'),profileDigest:h('profile'),mode:'serving',selected};
const evidence={snapshot:ref('snapshot'),namespace:{namespaceId:h('namespace'),markerDigest:h('marker'),generation:1,fence:1,root:{device:'1',inode:'2'}},inventoryDigest:h('inventory'),head,mode:'selected',pin:ref('read-pin'),selected};
const result={sha256:h('r'),byteLength:1},scope={sessionId:'s',project:'main::',context:'runtime',invocation:'i',consumerId:'reader',scanRunId:'scan',projectRootId:'root',manifestDigest:h('m'),coreGraphDigest:h('c'),operationBinding:h('op')};
function fixture(api:AuxiliaryAPI='ResolveNamespace',mode='selected'){
 const policy=auxiliaryPolicy[api],r:any={schema:'osv-mcp.q2.current-aux.request.v1',api,destination:policy.destination,peer:{credentialId:'client',role:policy.roles[0],instanceId:'client',boot:h('client'),keyEpoch:1},server:{credentialId:'server',role:policy.destination==='registry'?'lineage-registry':policy.destination==='provider'?'provider':'authority-broker',instanceId:'server',boot:h('server'),keyEpoch:1},deploymentDigest:h('deployment'),binding:structuredClone(binding),operationId:'operation',requestId:h('request'),challenge:h('challenge'),sequence:1,payload:{}},e:any=structuredClone(evidence);
 if(mode!=='selected'){
  delete e.pin;delete e.selected;e.mode=mode;e.fence=ref(mode==='candidate-genesis'?'provision':'writer-fence');
  if(mode==='candidate-genesis'){r.binding.mode='provision';r.binding.selected=null;r.binding.selectionRevision=0;}
  else{e.expectedSelection=1;e.previousCheckpoint=ref('checkpoint-prepare');e.namespace.generation=2;}
 }
 const lineage=['authorityId','lineageId','generation','storeEpoch','enrollmentDigest','profileDigest'];
 if(api==='AbandonEnrollment'){r.binding.mode='provision';r.binding.selected=null;r.binding.selectionRevision=0;e.fence=ref('provision');}
 const purpose=api==='AbandonEnrollment'?'enrollment':api==='ReadContext'?'read':api==='PrepareCandidate'?'publication':api==='MirrorSelection'?'maintenance':api==='PrepareAuthorityResult'||api==='RecordUse'?'handoff':mode==='selected'?'read':'checkpoint';
 if(api==='ReadContext')r.payload={purpose:'read',floor:null};
 else if(api==='AbandonEnrollment')r.payload={provision:e.fence,beginOperationId:'begin',beginRequestDigest:h('begin'),registryIncarnation:r.binding.registryIncarnation};
 else if(api==='PrepareCandidate'){r.payload={mode:e.mode,fence:e.fence,input:result,...(e.expectedSelection?{expectedSelection:e.expectedSelection,previousCheckpoint:e.previousCheckpoint}:{})};r.peer.role=mode==='candidate-genesis'?'operator':'writer';}
 else if(api==='ReadSealedSource')r.payload={evidence:e,transferId:'t',entry:{sha256:h('x'),byteLength:1},offset:0,maxBytes:1};
 else if(api==='PrepareAuthorityResult'||api==='RecordUse')r.payload={evidence:e,witness:ref('checkpoint-witness'),scope,useId:'u',result,...(api==='PrepareAuthorityResult'?{input:result}:{delivery:ref('delivery'),receiptDigest:h('receipt'),completeDigest:h('complete')})};
 else r.payload={evidence:e};
 const g:any={peer:r.peer,server:r.server,deploymentDigest:r.deploymentDigest,...Object.fromEntries(['authorityId','lineageId','generation','storeEpoch','enrollmentDigest','profileDigest'].map(k=>[k,r.binding[k]])),api,permission:policy.permission,payloadDigest:ownedDigest(r.payload),purpose,target:api==='ReadContext'?null:api==='PrepareCandidate'||api==='AbandonEnrollment'?e.fence:e.pin??e.fence,snapshot:['ReadContext','PrepareCandidate','AbandonEnrollment'].includes(api)?null:e.snapshot,operationBinding:['PrepareAuthorityResult','RecordUse'].includes(api)?scope.operationBinding:null};
 const full=structuredClone(r.binding);if(api==='ReadContext')r.binding=Object.fromEntries(lineage.map(k=>[k,full[k]]));
 const refresh=()=>{r.requestDigest=auxiliaryIntent(r);g.payloadDigest=ownedDigest(r.payload);};refresh();
 const request=()=>signed(r,'request',client),reply=(value:any)=>signed({schema:'osv-mcp.q2.current-aux.reply.v1',api,destination:r.destination,requestId:r.requestId,challenge:r.challenge,sequence:r.sequence,requestWireDigest:h(request()),requestDigest:r.requestDigest,peer:r.peer,server:r.server,deploymentDigest:r.deploymentDigest,value,backendEligible:false,profileApproved:false,independentRegistryVerified:false,originalReadsSkipped:0},'reply',server);
 return {r,g,e,full,refresh,request,reply,clientPin:{keyId:'client',publicKey:client.publicKey,identity:structuredClone(r.peer),direction:'request' as const},serverPin:{keyId:'server',publicKey:server.publicKey,identity:structuredClone(r.server),direction:'reply' as const}};
}
function signed(body:unknown,direction:'request'|'reply',key=client){const schema='osv-mcp.q2.current-aux.envelope.v1',keyId=direction==='request'?'client':'server';return Buffer.from(canonicalOwnedJson({schema,direction,keyId,body,signature:sign(null,Buffer.from(canonicalOwnedJson({domain:schema,direction,keyId,body})),key.privateKey).toString('base64')}));}
it.each(auxiliaryAPIs)('accepts the statically delegated %s request',api=>{const f=fixture(api,api==='PrepareCandidate'?'candidate-advance':'selected');expect(verifyAuxiliaryRequest(f.request(),f.clientPin,f.g).api).toBe(api);});
it.each(['candidate-genesis','candidate-advance','selected'])('resolves %s with its own evidence instead of circular adoption requirements',mode=>{const f=fixture('ResolveNamespace',mode),r=verifyAuxiliaryRequest(f.request(),f.clientPin,f.g);expect(verifyAuxiliaryReply(f.reply(f.e),f.serverPin,f.request(),r).value).toEqual(f.e);});
it.each(auxiliaryAPIs.flatMap(api=>currentRoles.filter(role=>!auxiliaryPolicy[api].roles.includes(role)).map(role=>({api,role}))))('denies role $role on $api even with consistent signatures',({api,role})=>{const f=fixture(api,api==='PrepareCandidate'?'candidate-advance':'selected');f.r.peer.role=role;f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('permission_denied');});
it.each(['candidate-genesis','candidate-advance'])('rejects %s in normal selected read and mirror APIs',mode=>{for(const api of ['ReadSealedSource','MirrorSelection'] as const){const f=fixture(api,mode);expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('schema_invalid');}});
it('allows genesis staging without a selected proof',()=>{const f=fixture('PrepareCandidate','candidate-genesis');expect(validateAuxiliaryRequest(f.r,f.g).api).toBe('PrepareCandidate');});
it.each(['pin','selected','previousCheckpoint'])('rejects forbidden %s in genesis even after resigning',field=>{const f=fixture('ResolveNamespace','candidate-genesis');f.r.payload.evidence[field]=field==='selected'?selected:ref('read-pin');f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('schema_invalid');});
it.each(['previousCheckpoint','expectedSelection'])('requires advance %s',field=>{const f=fixture('ResolveNamespace','candidate-advance');delete f.r.payload.evidence[field];f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('schema_invalid');});
it.each(['snapshot','head'])('refuses a selected %s exchange with a signed valid body',field=>{const f=fixture();f.r.payload.evidence[field]=field==='head'?{...head,commitDigest:h('other')}:ref('snapshot','other');f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('binding_mismatch');});
it.each(['purpose','permission','target','snapshot','operationBinding','payloadDigest'])('rejects altered handoff delegation %s',field=>{const f=fixture('PrepareAuthorityResult');f.g[field]=field==='target'?ref('read-pin','other'):field==='snapshot'?ref('snapshot','other'):field==='payloadDigest'||field==='operationBinding'?h('other'):'other';expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow();});
it('binds the request intent but permits a fresh transport challenge',()=>{const f=fixture();const digest=f.r.requestDigest;f.r.challenge=h('fresh');f.r.sequence++;f.r.requestId=h('fresh');expect(validateAuxiliaryRequest(f.r,f.g).requestDigest).toBe(digest);f.r.operationId='different';expect(()=>validateAuxiliaryRequest(f.r,f.g)).toThrow('binding_mismatch');});
it.each(['server','client'])('rejects the wrong %s signature key',which=>{const f=fixture(),bad=generateKeyPairSync('ed25519').publicKey;expect(()=>which==='client'?verifyAuxiliaryRequest(f.request(),{...f.clientPin,publicKey:bad},f.g):verifyAuxiliaryReply(f.reply(f.e),{...f.serverPin,publicKey:bad},f.request(),f.r)).toThrow('signature_invalid');});
it.each(['utf8','duplicate','noncanonical','oversize','array'])('rejects %s wire data',kind=>{const f=fixture();const bytes=kind==='utf8'?Buffer.from([0xff]):kind==='duplicate'?Buffer.from('{"x":1,"x":2}'):kind==='noncanonical'?Buffer.from(' '+f.request()):kind==='oversize'?Buffer.alloc(16385):signed([],'request');expect(()=>verifyAuxiliaryRequest(bytes,f.clientPin,f.g)).toThrow();});
it('checks chunk bytes, transfer binding and exact range',()=>{const f=fixture('ReadSealedSource'),value={transferId:'t',entry:f.r.payload.entry,offset:0,totalBytes:1,bytes:Buffer.from('x').toString('base64'),sha256:h('x')};expect(verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),f.r).value).toEqual(value);value.bytes=Buffer.from('y').toString('base64');expect(()=>verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),f.r)).toThrow('binding_mismatch');f.r.payload.offset=1;f.refresh();expect(()=>validateAuxiliaryRequest(f.r,f.g)).toThrow('binding_mismatch');});
it('binds context to an exact Anchor record and revision',()=>{const f=fixture('ReadContext'),value={binding:f.full,controlRevision:1,record:ref('registry-record'),anchorRevision:1,anchorRecord:ref('registry-record')};expect(verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),f.r).value).toEqual(value);value.anchorRevision=0;expect(()=>verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),f.r)).toThrow('binding_mismatch');});
it.each(['useId','result','delivery','completeDigest','receiptDigest'])('rejects signed use receipt %s substitution',field=>{const f=fixture('RecordUse'),v:any={pin:f.e.pin,useId:'u',result,delivery:ref('delivery'),receiptDigest:h('receipt'),completeDigest:h('complete'),savedReceipt:result};expect(verifyAuxiliaryReply(f.reply(v),f.serverPin,f.request(),f.r).value).toEqual(v);v[field]=field==='result'?{...result,sha256:h('other')}:field==='delivery'?ref('delivery','other'):field==='useId'?'other':h('other');expect(()=>verifyAuxiliaryReply(f.reply(v),f.serverPin,f.request(),f.r)).toThrow('binding_mismatch');});
it('rejects a reply for an older challenge or different wire request',()=>{const f=fixture(),bytes=f.reply(f.e);f.r.challenge=h('next');expect(()=>verifyAuxiliaryReply(bytes,f.serverPin,f.request(),f.r)).toThrow('binding_mismatch');});

it.each(['credentialId','instanceId','boot','keyEpoch'])('binds request signing pin to credential %s independently of a matching grant',field=>{
 const f=fixture();f.r.peer[field]=field==='keyEpoch'?2:field==='boot'?h('other'):'other';f.refresh();
 expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('peer_mismatch');
});
it.each(['credentialId','instanceId','boot','keyEpoch'])('binds reply signing pin to server %s independently of a matching request',field=>{
 const f=fixture();f.r.server[field]=field==='keyEpoch'?2:field==='boot'?h('other'):'other';f.refresh();
 expect(()=>verifyAuxiliaryReply(f.reply(f.e),f.serverPin,f.request(),f.r)).toThrow('peer_mismatch');
});

it('binds a permitted request role to its signing credential',()=>{const f=fixture();f.r.peer.role='checkpoint-issuer';f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('peer_mismatch');});
it('binds the server role to the reply signing credential',()=>{const f=fixture();f.r.server.role='authority-broker';f.refresh();expect(()=>verifyAuxiliaryReply(f.reply(f.e),f.serverPin,f.request(),f.r)).toThrow('peer_mismatch');});
it.each(['request','reply'] as const)('requires the independent %s pin direction',direction=>{const f=fixture();expect(()=>direction==='request'?verifyAuxiliaryRequest(f.request(),{...f.clientPin,direction:'reply'},f.g):verifyAuxiliaryReply(f.reply(f.e),{...f.serverPin,direction:'request'},f.request(),f.r)).toThrow('peer_mismatch');});
it.each(['request','reply'] as const)('rejects an old unbound %s pin shape',direction=>{const f=fixture();const pin:any={...(direction==='request'?f.clientPin:f.serverPin)};delete pin.identity;expect(()=>direction==='request'?verifyAuxiliaryRequest(f.request(),pin,f.g):verifyAuxiliaryReply(f.reply(f.e),pin,f.request(),f.r)).toThrow('schema_invalid');});

const observed=(f:ReturnType<typeof fixture>,change:(b:any)=>void,revision=2)=>{const b:any=structuredClone(f.full);change(b);return {binding:b,controlRevision:revision,record:ref('registry-record'),anchorRevision:revision,anchorRecord:ref('registry-record')};};
it('learns an advanced selection, revocation epoch and registry incarnation from a context read',()=>{
 const f=fixture('ReadContext'),r=verifyAuxiliaryRequest(f.request(),f.clientPin,f.g);
 const value=observed(f,b=>{b.selectionRevision=2;b.revocationEpoch=1;b.registryIncarnation=h('restarted');b.providerBoot=h('reboot');b.selected={...b.selected,head:{...head,revision:2,commitDigest:h('next')}};});
 expect(verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),r).value).toEqual(value);
});
it('first context read needs no prior mutable binding',()=>{const f=fixture('ReadContext');expect(Object.keys(f.r.binding).sort()).toEqual(['authorityId','enrollmentDigest','generation','lineageId','profileDigest','storeEpoch']);
 const provision=observed(f,b=>{b.mode='provision';b.selected=null;b.selectionRevision=0;},0);provision.record=null as any;provision.anchorRecord=null as any;
 expect(verifyAuxiliaryReply(f.reply(provision),f.serverPin,f.request(),verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).value).toEqual(provision);
});
it('rejects a full mutable binding in a context read request',()=>{const f=fixture('ReadContext');f.r.binding=f.full;f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('schema_invalid');});
it('rejects a lineage-only binding outside a context read',()=>{const f=fixture();f.r.binding=Object.fromEntries(Object.entries(f.full).filter(([k])=>['authorityId','lineageId','generation','storeEpoch','enrollmentDigest','profileDigest'].includes(k)));f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('schema_invalid');});
it.each(['authorityId','lineageId','generation','storeEpoch','enrollmentDigest','profileDigest'])('rejects a context reply for another lineage %s',key=>{
 const f=fixture('ReadContext'),value=observed(f,b=>{b[key]=key==='generation'?2:key==='authorityId'||key==='lineageId'?'other':h('other');});
 expect(()=>verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),f.r)).toThrow('binding_mismatch');
});
it.each(['controlRevision','selectionRevision','revocationEpoch'])('refuses a context older than the caller floor %s',key=>{
 const f=fixture('ReadContext');f.r.payload.floor={controlRevision:2,selectionRevision:2,revocationEpoch:1};f.refresh();const r=verifyAuxiliaryRequest(f.request(),f.clientPin,f.g);
 const at=observed(f,b=>{b.selectionRevision=2;b.revocationEpoch=1;});expect(verifyAuxiliaryReply(f.reply(at),f.serverPin,f.request(),r).value).toEqual(at);
 const old=key==='controlRevision'?observed(f,b=>{b.selectionRevision=2;b.revocationEpoch=1;},1):observed(f,b=>{b.selectionRevision=key==='selectionRevision'?1:2;b.revocationEpoch=key==='revocationEpoch'?0:1;});
 expect(()=>verifyAuxiliaryReply(f.reply(old),f.serverPin,f.request(),r)).toThrow('binding_mismatch');
});

it('statically delegates AbandonEnrollment for one exact provision and binds the retired reply',()=>{
 const f=fixture('AbandonEnrollment'),r=verifyAuxiliaryRequest(f.request(),f.clientPin,f.g),value={provision:f.e.fence,retiredRecord:ref('registry-record'),controlRevision:2,phase:'uninitialized'};
 expect(verifyAuxiliaryReply(f.reply(value),f.serverPin,f.request(),r).value).toEqual(value);
 expect(()=>verifyAuxiliaryReply(f.reply({...value,provision:ref('provision','other')}),f.serverPin,f.request(),r)).toThrow('binding_mismatch');
 expect(()=>verifyAuxiliaryReply(f.reply({...value,phase:'provisioning'}),f.serverPin,f.request(),r)).toThrow('schema_invalid');
});
it.each(['target','purpose','snapshot','incarnation','serving'])('rejects AbandonEnrollment with altered %s',kind=>{
 const f=fixture('AbandonEnrollment');
 if(kind==='target')f.g.target=ref('provision','other');if(kind==='purpose')f.g.purpose='publication';if(kind==='snapshot')f.g.snapshot=ref('snapshot');
 if(kind==='incarnation'){f.r.payload.registryIncarnation=h('other');f.refresh();}
 if(kind==='serving'){f.r.binding=structuredClone(binding);f.refresh();}
 expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('permission_denied');
});
it('rejects a writer fence or extra field in AbandonEnrollment',()=>{const f=fixture('AbandonEnrollment');f.r.payload.provision=ref('writer-fence');f.refresh();expect(()=>verifyAuxiliaryRequest(f.request(),f.clientPin,f.g)).toThrow('schema_invalid');
 const g=fixture('AbandonEnrollment');g.r.payload.expires=1;g.refresh();expect(()=>verifyAuxiliaryRequest(g.request(),g.clientPin,g.g)).toThrow('schema_invalid');});

const budget=()=>({schema:'osv-mcp.q2.c3a.read-budget.v1',leaseMs:CURRENT_LIMITS.lease,marginMs:1000,closureBytes:8*1024*1024,minTransferBytesPerSecond:16*1024*1024,minVerifyBytesPerSecond:32*1024*1024,
 phases:{context:100,pin:100,checkpoint:200,transfer:1000,verify:500,handoff:400,delivery:300,use:600,ack:300}} as any);
it('accepts a read budget whose phases and margin fit one lease at the declared rates',()=>{const b=validateReadBudget(budget());expect(readBudgetPhases.reduce((n,k)=>n+b.phases[k],0)+b.marginMs).toBeLessThanOrEqual(CURRENT_LIMITS.lease);admitReadClosure(b,b.closureBytes);});
it.each(['sum','margin','transfer-rate','verify-rate','closure-limit','lease','phase-missing'])('rejects a read budget with %s',kind=>{
 const b=budget();if(kind==='sum')b.phases.use+=1101;if(kind==='margin')b.marginMs=499;if(kind==='transfer-rate')b.minTransferBytesPerSecond=8*1024*1024-1;if(kind==='verify-rate')b.minVerifyBytesPerSecond=1024*1024;
 if(kind==='closure-limit')b.closureBytes=CURRENT_LIMITS.closure+1;if(kind==='lease')b.leaseMs=10000;if(kind==='phase-missing')delete b.phases.ack;
 expect(()=>validateReadBudget(b)).toThrow(['closure-limit','lease','phase-missing'].includes(kind)?'schema_invalid':'budget_exceeded');
});
it('refuses an over-budget closure before any pin, never by extending the lease',()=>{const b=validateReadBudget(budget());expect(()=>admitReadClosure(b,b.closureBytes+1)).toThrow('budget_exceeded');expect(()=>admitReadClosure(b,0)).toThrow('budget_exceeded');});
