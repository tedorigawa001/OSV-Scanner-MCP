/** VF-0 operator assembly. Diagnostic signed inputs and a single owned authority/clock only. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {lb0Fixture} from './gradleOwnedCwcLb0Fixture.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Session,type Vf0Options,type Vf0Hook} from './gradleOwnedCwcVf0.js';
import {Vf0Approval} from './gradleOwnedCwcVf0Approval.js';
import {Vf0Authority,Vf0Clock} from './gradleOwnedCwcVf0Authority.js';
import {VF0_POLICY} from './gradleOwnedCwcVf0Map.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
export function vf0ApprovalFixture(){const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcVf0Fixture.ts','src/test/utils/gradleOwnedCwcVf0.test.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const key=generateKeyPairSync('ed25519'),manifest={schema:'cwc-vf0.approval.v1',policyDigest:hash(VF0_POLICY),node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))},registry={schema:'cwc-vf0.registry.v1',manifestDigest:hash(manifest),operatorSpki:key.publicKey.export({type:'spki',format:'der'}).toString('base64')},pin=hash(registry),envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),key.privateKey).toString('base64')};let current=pin;
 const view=new Vf0Approval(envelope,registry,pin,sources,()=>current);return {view,pin,registry,envelope,sources,revoke(){current=sha('revoked');},restore(){current=pin;}};
}
export function vf0Fixture(options:{mode?:Vf0Options['mode'];role?:'reader'|'authority-broker';api?:'aux.ReadSourceDescriptor'|'aux.ReadSealedSource'|'aux.ReadSourceRanges';approval?:ReturnType<typeof vf0ApprovalFixture>;budget?:Lb0Budget;gateLimit?:number;ownership?:string;configure?:(config:Vf0Options)=>void}={}){
 const approval=options.approval??vf0ApprovalFixture(),base=lb0Fixture({role:options.role,api:options.api}),signed=base.prepare();base.close();
 const hooks:Record<string,Vf0Hook|undefined>={},clock=new Vf0Clock(),authority=new Vf0Authority({peer:true,server:true,peerKeyEpoch:base.peer.keyEpoch,serverKeyEpoch:base.server.keyEpoch,permissions:base.permissions,purpose:'read',registryPin:base.sessionOptions.pins.registryDigest,sourcePin:approval.pin,profilePin:approval.pin,callbackPolicy:0});
 const budget=options.budget??new Lb0Budget(),config:Vf0Options={approval:approval.view,approvalPin:approval.pin,budget,authority,clock,mode:options.mode??'fact-live',ownership:(options.ownership??'owner-notified') as 'owner-notified',gateLimit:options.gateLimit,registry:base.registry,pins:base.sessionOptions.pins,frames:base.frames,peer:base.peer,server:base.server,lineage:base.command.lineage,endpointId:'provider-endpoint',expected:{api:base.api,requestId:sha('request1'),originDigest:sha(base.inner),ttlMs:4500,deadline:4500,requestSequence:1,replySequence:1},foreign:(name,info)=>hooks[name]?.(info)};
 options.configure?.(config);const engine=new Vf0Session(config),packet={request:signed.request,reply:signed.reply,outer:signed.packet.outer,inner:signed.packet.inner};
 return {engine,packet,config,hooks,clock,authority,budget,approval,command:structuredClone(base.command),peer:structuredClone(base.peer),server:structuredClone(base.server),permissions:structuredClone(base.permissions),capture:()=>engine.capture(packet),seal:()=>engine.seal(),close:()=>engine.close()};
}
