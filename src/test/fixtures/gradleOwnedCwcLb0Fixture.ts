/** Independent operator and signed-input assembly for CLB-0 tests only. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {CwcLb0Session,type Lb0Environment} from './gradleOwnedCwcLb0.js';
import {LB0_POLICY,Lb0Approval,Lb0Budget,type Lb0Mode} from './gradleOwnedCwcLb0Contract.js';
import {serviceSessionFixture,signedServiceFrame,serviceTestKeys} from './gradleOwnedServiceContract.js';
import {validateSessionTranscript,inspectStaticSession} from './gradleOwnedCprBProtocol.js';
import {i0Case} from './gradleOwnedCgpI0Case.js';
import {context,makeCommand} from './gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';

export function lb0ApprovalFixture(){
 const sources:Record<string,Buffer>={};
 function bind(p:string){if(p in sources)return;const bytes=readFileSync(p);sources[p]=bytes;for(const m of bytes.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcLb0Fixture.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const operator=generateKeyPairSync('ed25519'),manifest={schema:'cwc-lb0.approval.v1',policyDigest:hash(LB0_POLICY),node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))};
 const registry={schema:'cwc-lb0.registry.v1',manifestDigest:hash(manifest),operatorSpki:operator.publicKey.export({format:'der',type:'spki'}).toString('base64')};
 const envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),operator.privateKey).toString('base64')},pin=hash(registry);let current=pin;
 const view=new Lb0Approval(envelope,registry,pin,sources,()=>current);
 return {view,envelope,registry,pin,sources,revoke(){current=sha('revoked');},restore(){current=pin;}};
}
export function lb0Fixture(options:{mode?:Lb0Mode;role?:'reader'|'authority-broker';api?:'aux.ReadSourceDescriptor'|'aux.ReadSealedSource'|'aux.ReadSourceRanges';budget?:Lb0Budget;approval?:ReturnType<typeof lb0ApprovalFixture>}={}){
 const mode=options.mode??'full-reference',role=options.role??'reader',api=options.api??'aux.ReadSourceDescriptor',approval=options.approval??lb0ApprovalFixture(),budget=options.budget??new Lb0Budget();
 const f=serviceSessionFixture(),input=i0Case('S*'),peer=input.identity(role),server=input.server;
 f.registry.profileDigest=input.lineage.profileDigest;f.registry.enrollmentDigest=input.lineage.enrollmentDigest;
 for(const c of f.registry.credentials){for(const p of c.permissions)p.lineage=structuredClone(input.lineage);
  if(c.identity.credentialId===peer.credentialId&&!c.permissions.some((p:any)=>p.api===api&&p.purpose==='read'))c.permissions.push({api,purpose:'read',lineage:structuredClone(input.lineage),delegateInstance:'provider'});
  if(c.identity.credentialId===peer.credentialId)c.permissions.push({api,purpose:'publication',lineage:structuredClone(input.lineage),delegateInstance:'provider'});
 }
 Object.assign(f.base,{clientCredentialId:peer.credentialId,clientBoot:peer.boot,clientKeyEpoch:peer.keyEpoch,...f.pins()});Object.assign(f.session,f.base);for(const body of f.bodies)Object.assign(body,f.base);
 const frames=f.frames(),staticSession=validateSessionTranscript(frames,f.registry,f.pins(),f.base),facts=inspectStaticSession(staticSession);
 const c=context({catalog:input.lineage.profileDigest,manifest:hash(LB0_POLICY),registryDigest:f.pins().registryDigest,deploymentDigest:f.registry.deploymentDigest,endpointId:'provider-endpoint',requestKeyId:peer.credentialId,replyKeyId:server.credentialId,peer,provider:server,...(role==='authority-broker'?{origin:input.reader}:{}),lineage:input.lineage,binding:input.binding,snapshot:input.snapshot,checkpoint:input.checkpoint,pin:input.pin,metadataDigest:hash(input.metadata),inventoryDigest:input.inventoryPin.inventoryDigest});
 const command=api==='aux.ReadSourceRanges'?makeCommand(c,'seed','transfer',0,1,sha('plan'),[{ordinal:0,kind:'commit',index:0,offset:0,length:16,entry:{sha256:input.entries[0]!.sha256,byteLength:input.entries[0]!.byteLength}}]):input.command(role,api);
 const unsigned={schema:'osv-mcp.q2.c3b.owner-envelope.v1',identity:peer,keyId:peer.credentialId,direction:'request',domain:'aux',api,body:{api:api.slice(4),command}};
 const inner=Buffer.from(canonical({...unsigned,signature:sign(null,Buffer.from(canonical(unsigned)),serviceTestKeys[peer.credentialId]!.privateKey).toString('base64')}));
 let time=0,purpose='read',open=true;const revoked=new Set<string>();let permissions=structuredClone(f.registry.credentials.find((x:any)=>x.identity.credentialId===peer.credentialId)!.permissions);
 const hooks:{current?:()=>unknown;now?:()=>void;credential?:(view:Readonly<typeof peer>)=>void;purpose?:()=>void;permissions?:()=>void}={};
 const environment:Lb0Environment={now:()=>{hooks.now?.();return time;},assertOpen:()=>{const value=hooks.current?.();if(value!==undefined)return value as unknown as void;need(open,'owner_closed');},credentialCurrent:view=>{hooks.credential?.(view);return !revoked.has(view.credentialId);},purpose:()=>{hooks.purpose?.();return purpose;},permissions:()=>{hooks.permissions?.();return permissions;}};
 const sessionOptions={approval:approval.view,budget,mode,registry:f.registry,pins:f.pins(),frames,clientCredentialId:peer.credentialId,serverCredentialId:server.credentialId,endpointId:'provider-endpoint',lineage:input.lineage,environment};
 const session=new CwcLb0Session(sessionOptions);
 let counter=0;
 function prepare(){const id=++counter,seq=session.sequence,requestId=sha('request'+id),originDigest=sha(inner),challenge=sha('challenge'+id),ttlMs=4500;
  const common={...f.session,transcriptDigest:facts.transcriptDigest,requestId,api,originDigest,ttlMs};
  const request=signedServiceFrame({...common,kind:'challenge-request',sequence:seq.request},'request',peer.credentialId),reply=signedServiceFrame({...common,kind:'challenge',sequence:seq.reply,challenge},'reply',server.credentialId);
  const pending=session.prepareChallenge(request,reply,{api,requestId,originDigest,ttlMs,deadline:4500,requestSequence:seq.request,replySequence:seq.reply});
  const outer=signedServiceFrame({...f.session,transcriptDigest:facts.transcriptDigest,kind:'channel',sequence:seq.request+1,challenge,api,originDigest,innerWireDigest:sha(inner),ttlMs},'request',peer.credentialId);
  return {pending,packet:{outer,inner:Buffer.from(inner)},request,reply};
 }
 function issue(){const p=prepare();return {...p,call:session.receive(p.pending,p.packet)};}
 function bind(call:ReturnType<typeof session.receive>){const owner=session.owner(),scope=session.scope(owner),begun=session.begin(call,owner),row=session.operationRow(begun.draft,owner),projection={peer,server,api,purpose:'read',actor:'provider'},bound=session.seal(begun.draft,owner,scope,row,projection);return {owner,scope,...begun,row,projection,bound};}
 return {session,sessionOptions,approval,budget,mode,role,api,command,inner,frames,registry:f.registry,peer,server,hooks,environment,prepare,issue,bind,setNow(n:number){time=n;},setPurpose(p:string){purpose=p;},setPermissions(p:typeof permissions){permissions=p;},get permissions(){return permissions;},revoke(id=peer.credentialId){revoked.add(id);},close(){session.close();},stop(){open=false;}};
}
