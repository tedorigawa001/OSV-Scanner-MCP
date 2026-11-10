/** CLB-1 opt-in policy. This is an in-process operator approval, never a peer supplied flag. */
import {createPublicKey,verify} from 'node:crypto';
import {posix} from 'node:path';
import {copyData} from './gradleOwnedCwcLb0Contract.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
export const LB1_POLICY=Object.freeze({profile:'cwc.session-owned-call-binding.v1',stage:'CLB-1-connected',memory:1048576,initialization:156978,sessionBytes:131072,constructorBytes:131072,registryBytes:57344,callBytes:98304,bindingBytes:8192,frameWorkspace:32768,fullChannelAndOwnerVerification:true,elision:['owned-inner-comparison-hash','repeated-identity-copy-and-projection']});
const approved=new WeakSet<object>();
export class Lb1Approval{
 readonly #pin:string;readonly #current:()=>string;#open=true;
 constructor(envelope:unknown,registry:unknown,pin:string,sources:Record<string,Buffer>,current:()=>string){
  const e:any=copyData(envelope),r:any=copyData(registry);
  need(Object.keys(e).sort().join(',')==='manifest,signature'&&Object.keys(r).sort().join(',')==='manifestDigest,operatorSpki,schema'&&r.schema==='cwc-lb1.registry.v1'&&hash(r)===pin&&hash(e.manifest)===r.manifestDigest,'codec_profile_unsupported');
  const m=e.manifest;need(Object.keys(m).sort().join(',')==='node,policyDigest,schema,sources'&&m.schema==='cwc-lb1.approval.v1'&&m.node===process.version&&m.policyDigest===hash(LB1_POLICY),'codec_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.operatorSpki,'base64'),format:'der',type:'spki'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(m)),key,Buffer.from(e.signature,'base64')),'codec_profile_unsupported');
  need(Object.keys(m.sources).length<=256&&canonical(Object.keys(m.sources).sort())===canonical(Object.keys(sources).sort()),'codec_profile_unsupported');
  for(const p of ['gradleOwnedCwcLb0.ts','gradleOwnedCwcLb1Approval.ts','gradleOwnedCwcLb1Fixture.ts','gradleOwnedCwcC.ts','gradleOwnedCwcCProvider.ts','gradleOwnedCwcCPlanner.ts','gradleOwnedCwcA.ts'])need(Object.hasOwn(sources,'src/test/fixtures/'+p),'codec_profile_unsupported');
  let total=0;for(const [p,d]of Object.entries(m.sources)){const b=sources[p];need((p.startsWith('src/')||['package-lock.json','tsconfig.json','vitest.config.ts'].includes(p))&&!p.split('/').includes('..')&&Buffer.isBuffer(b)&&(total+=b.length)<=8388608&&sha(b)===d,'codec_profile_unsupported');
   for(const x of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!x[1]!.startsWith('.'))continue;let target=posix.normalize(posix.join(posix.dirname(p),x[1]!));if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';need(Object.hasOwn(sources,target),'codec_profile_unsupported');}
  }
  this.#pin=pin;this.#current=current;approved.add(this);this.assertCurrent();Object.freeze(this);
 }
 assertCurrent(){try{need(this.#open&&this.#current()===this.#pin,'codec_profile_unsupported');}catch(e){this.#open=false;throw e;}}
 static require(value:Lb1Approval){need(approved.has(value),'codec_profile_unsupported');value.assertCurrent();}
}
