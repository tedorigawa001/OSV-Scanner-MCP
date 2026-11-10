/** Independent source pin for the conservative CLB-2 one-business-call channel adapter. */
import {generateKeyPairSync,sign,verify,createPublicKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {Lb1Approval,LB1_POLICY} from './gradleOwnedCwcLb1Approval.js';
import {lb0ApprovalFixture} from './gradleOwnedCwcLb0Fixture.js';
import {copyData} from './gradleOwnedCwcLb0Contract.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
import {ownedDigest as hash,ownedSha256 as sha,canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
export const LB2_POLICY=Object.freeze({stage:'CLB-2-real-session',businessCallsPerChannel:1,maximumOperations:64,maximumUnfinished:1,memoryPerActiveCall:1048576,workPerOperation:156978,originalDeadline:4500,transportFinalBeforeReclaim:true,readApisOnly:true,externalStorage:false,performance:false});
const approved=new WeakSet<object>();
export class Lb2Approval{
 readonly base:ReturnType<typeof lb0ApprovalFixture>;readonly connected:Lb1Approval;readonly record:any;readonly #current:()=>string;readonly #pin:string;
 constructor(base:ReturnType<typeof lb0ApprovalFixture>,record:unknown,independentPin:string,sources:Record<string,Buffer>,current:()=>string){
  const r:any=copyData(record);need(r.pin===independentPin&&r.envelope?.manifest?.schema==='cwc-lb2.approval.v1'&&r.envelope.manifest.policyDigest===hash(LB2_POLICY)&&r.envelope.manifest.node===process.version&&hash(r.registry)===r.pin&&hash(r.envelope.manifest)===r.registry.manifestDigest&&hash(r.connected.registry)===r.envelope.manifest.connectedPin,'codec_profile_unsupported');
  const fields=(v:object,keys:string)=>need(Object.keys(v).sort().join(',')===keys,'codec_profile_unsupported');fields(r,'connected,envelope,pin,registry');fields(r.envelope,'manifest,signature');fields(r.envelope.manifest,'connectedPin,node,policyDigest,schema,sources');fields(r.registry,'manifestDigest,operatorSpki,schema');fields(r.connected,'envelope,pin,registry');need(r.registry.schema==='cwc-lb2.registry.v1'&&r.connected.pin===r.envelope.manifest.connectedPin,'codec_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.registry.operatorSpki,'base64'),type:'spki',format:'der'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(r.envelope.manifest)),key,Buffer.from(r.envelope.signature,'base64')),'codec_profile_unsupported');
  need(canonical(r.envelope.manifest.sources)===canonical(r.connected.envelope.manifest.sources)&&canonical(Object.keys(sources).sort())===canonical(Object.keys(r.envelope.manifest.sources).sort()),'codec_profile_unsupported');
  for(const root of ['gradleOwnedCwcLb2Case.ts','gradleOwnedCwcLb2Link.ts','gradleOwnedCwcLb2Approval.ts','gradleOwnedCprBSession.ts'])need(Object.hasOwn(sources,'src/test/fixtures/'+root),'codec_profile_unsupported');
  for(const [p,h]of Object.entries(r.envelope.manifest.sources))need(sha(sources[p]!)===h,'codec_profile_unsupported');
  // Revalidate the actual connected capability against the same independently pinned source set.
  const connected=new Lb1Approval(r.connected.envelope,r.connected.registry,r.envelope.manifest.connectedPin,sources,()=>r.envelope.manifest.connectedPin);
  this.base=base;this.connected=connected;this.record=r;this.#current=current;this.#pin=r.pin;approved.add(this);this.assertCurrent();Object.freeze(this);
 }
 assertCurrent(){need(this.#current()===this.#pin,'codec_profile_unsupported');this.base.view.assertCurrent();this.connected.assertCurrent();}
 static require(value:Lb2Approval){need(approved.has(value),'codec_profile_unsupported');value.assertCurrent();}
}
export function lb2ApprovalFixture(){
 const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcLb2Case.ts','src/test/fixtures/gradleOwnedCwcLb1Fixture.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 function signed(manifest:any,schema:string){const keys=generateKeyPairSync('ed25519'),registry={schema,manifestDigest:hash(manifest),operatorSpki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')};return {envelope:{manifest,signature:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')},registry,pin:hash(registry)};}
 const hashes=Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)])),connected=signed({schema:'cwc-lb1.approval.v1',policyDigest:hash(LB1_POLICY),node:process.version,sources:hashes},'cwc-lb1.registry.v1');
 const r=signed({schema:'cwc-lb2.approval.v1',policyDigest:hash(LB2_POLICY),connectedPin:connected.pin,node:process.version,sources:hashes},'cwc-lb2.registry.v1'),record={...r,connected};let pin=r.pin;
 const view=new Lb2Approval(lb0ApprovalFixture(),record,r.pin,sources,()=>pin);
 return {view,record,revoke(){pin=sha('revoked');}};
}
