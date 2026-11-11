/** VF-2 operator approval: cooperative, fixed-clock real-session adapter only. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,createPublicKey,sign,verify} from 'node:crypto';
import {lb2ApprovalFixture,type Lb2Approval} from './gradleOwnedCwcLb2Approval.js';
import {Vf1Approval} from './gradleOwnedCwcVf1Approval.js';
import {VF1_POLICY} from './gradleOwnedCwcVf1Contract.js';
import {copyData,freezeData} from './gradleOwnedCwcLb0Contract.js';
import {ownedDigest as hash,ownedSha256 as sha,canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export const VF2_POLICY=Object.freeze({profile:'cwc.session-private-verification-facts.transport.v1',stage:'VF-2-real-session',variant:'combined',referenceOracle:false,transferModes:['S-scoped','B-independent'],fixedClock:true,authorityOwners:1,businessCallsPerChannel:1,modes:['full-verify','fact-live'],memory:1048576,work:156978,originalDeadline:4500,logicalGateLimit:4096,externalStorage:false,nativeIsolation:false,performanceComparison:false,productionAdopted:false});
const branded=new WeakSet<object>();
export class Vf2Approval{
 readonly transport:Lb2Approval;readonly vf1:Vf1Approval;readonly vf1Pin:string;readonly record:any;#open=true;
 constructor(transport:Lb2Approval,record:unknown,pin:string,sources:Record<string,Buffer>){
  const r:any=copyData(record,131072),m=r.envelope?.manifest;
  const fields=(v:object,keys:string)=>need(Object.keys(v).sort().join(',')===keys,'codec_profile_unsupported');
  fields(r,'envelope,pin,registry,transport,vf1');fields(m,'node,policyDigest,schema,sources,transportPin,vf1Pin');fields(r.envelope,'manifest,signature');fields(r.registry,'manifestDigest,operatorSpki,schema');fields(r.vf1,'envelope,pin,registry');
  need(r.pin===pin&&hash(r.registry)===pin&&r.registry.schema==='cwc-vf2.registry.v1'&&m?.schema==='cwc-vf2.approval.v1'&&m.node===process.version&&m.policyDigest===hash(VF2_POLICY)&&hash(m)===r.registry.manifestDigest&&m.transportPin===transport.record.pin&&r.transport.pin===m.transportPin&&canonical(r.transport)===canonical(transport.record)&&m.vf1Pin===r.vf1.pin&&hash(r.vf1.registry)===r.vf1.pin,'codec_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.registry.operatorSpki,'base64'),type:'spki',format:'der'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(m)),key,Buffer.from(r.envelope.signature,'base64')),'codec_profile_unsupported');
  need(canonical(Object.keys(sources).sort())===canonical(Object.keys(m.sources).sort())&&canonical(m.sources)===canonical(r.vf1.envelope.manifest.sources),'codec_profile_unsupported');
  for(const name of ['gradleOwnedCwcVf2Case.ts','gradleOwnedCwcVf2Link.ts','gradleOwnedCwcVf2Approval.ts','gradleOwnedCprBSession.ts'])need(Object.hasOwn(m.sources,'src/test/fixtures/'+name),'codec_profile_unsupported');
  this.vf1=new Vf1Approval(r.vf1.envelope,r.vf1.registry,r.vf1.pin,sources);this.vf1Pin=r.vf1.pin;this.transport=transport;this.record=freezeData(r);branded.add(this);this.assertCurrent();Object.freeze(this);
 }
 assertCurrent(){need(this.#open,'codec_profile_unsupported');this.transport.assertCurrent();this.vf1.assertCurrent();}
 close(){this.#open=false;this.vf1.close();}
 static require(value:Vf2Approval){need(branded.has(value),'codec_profile_unsupported');value.assertCurrent();}
}
export function vf2ApprovalFixture(){
 const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let target=resolve(dirname(p),m[1]!);if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';bind(relative(process.cwd(),target));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcVf2Case.ts','src/test/utils/gradleOwnedCwcVf2.test.ts','src/test/fixtures/gradleOwnedCwcVf1Fixture.ts','src/test/utils/gradleOwnedCwcVf1.test.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const signed=(manifest:any,schema:string)=>{const k=generateKeyPairSync('ed25519'),registry={schema,manifestDigest:hash(manifest),operatorSpki:k.publicKey.export({type:'spki',format:'der'}).toString('base64')};return {envelope:{manifest,signature:sign(null,Buffer.from(canonical(manifest)),k.privateKey).toString('base64')},registry,pin:hash(registry)};};
 const hashes=Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)])),transport=lb2ApprovalFixture().view,vf1=signed({schema:'cwc-vf1.approval.v1',policyDigest:hash(VF1_POLICY),node:process.version,sources:hashes},'cwc-vf1.registry.v1'),record={...signed({schema:'cwc-vf2.approval.v1',policyDigest:hash(VF2_POLICY),node:process.version,sources:hashes,transportPin:transport.record.pin,vf1Pin:vf1.pin},'cwc-vf2.registry.v1'),vf1,transport:transport.record};
 const view=new Vf2Approval(transport,record,record.pin,sources);return {view,record,sources,pin:record.pin,revoke(){view.close();}};
}
