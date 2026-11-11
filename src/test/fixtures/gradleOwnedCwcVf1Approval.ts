/** Independent VF-1 source approval. Not a production registry or native attestation. */
import {z} from 'zod';
import {createPublicKey,verify} from 'node:crypto';
import {posix} from 'node:path';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,chash} from '../../utils/gradleOwnedCurrentSchema.js';
import {copyData} from './gradleOwnedCwcLb0Contract.js';
import {VF1_POLICY,VF1_REAL_POLICY} from './gradleOwnedCwcVf1Contract.js';
const approvalSchema=z.object({schema:z.literal('cwc-vf1.approval.v1'),policyDigest:chash,node:z.string(),sources:z.record(z.string(),chash)}).strict();
const envelopeSchema=z.object({manifest:approvalSchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
const registrySchema=z.object({schema:z.literal('cwc-vf1.registry.v1'),manifestDigest:chash,operatorSpki:z.string().max(128)}).strict();
const approvals=new WeakSet<object>();
export class Vf1Approval{
 readonly clockKind:'fixed'|'owned-monotonic';readonly #pin:string;#open=true;
 constructor(envelopeInput:unknown,registryInput:unknown,pin:string,sources:Record<string,Buffer>,clockKind:'fixed'|'owned-monotonic'='fixed'){
  const r=parsed(registrySchema,copyData(registryInput)),e=parsed(envelopeSchema,copyData(envelopeInput));
  need(hash(r)===pin&&hash(e.manifest)===r.manifestDigest&&e.manifest.policyDigest===hash(clockKind==='fixed'?VF1_POLICY:VF1_REAL_POLICY)&&e.manifest.node===process.version,'codec_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.operatorSpki,'base64'),format:'der',type:'spki'});
  need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(e.manifest)),key,Buffer.from(e.signature,'base64')),'codec_profile_unsupported');
  const names=Object.keys(e.manifest.sources);need(names.length>0&&names.length<=256&&canonical(names.sort())===canonical(Object.keys(sources).sort()),'codec_profile_unsupported');
  for(const root of ['src/test/fixtures/gradleOwnedCwcLb0.ts','src/test/fixtures/gradleOwnedCwcCProvider.ts','src/test/fixtures/gradleOwnedCwcC.ts','src/test/fixtures/gradleOwnedCwcVf1Contract.ts','src/test/fixtures/gradleOwnedCwcVf1Fixture.ts','src/test/utils/gradleOwnedCwcVf1.test.ts'])need(Object.hasOwn(sources,root),'codec_profile_unsupported');
  let bytes=0;for(const [p,digest]of Object.entries(e.manifest.sources)){
   need(p.startsWith('src/')||['package-lock.json','tsconfig.json','vitest.config.ts'].includes(p),'codec_profile_unsupported');
   const source=sources[p];need(!p.split('/').includes('..')&&Buffer.isBuffer(source)&&(bytes+=source.length)<=8388608&&sha(source)===digest,'codec_profile_unsupported');
   for(const m of source.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let target=posix.normalize(posix.join(posix.dirname(p),m[1]!));if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';need(Object.hasOwn(sources,target),'codec_profile_unsupported');}
  }
  need(['fixed','owned-monotonic'].includes(clockKind),'codec_profile_unsupported');if(clockKind==='owned-monotonic')for(const root of ['gradleOwnedCwcVf3Case.ts','gradleOwnedCwcVf3Link.ts','gradleOwnedCwcVf3Approval.ts'])need(Object.hasOwn(sources,'src/test/fixtures/'+root),'codec_profile_unsupported');this.clockKind=clockKind;this.#pin=pin;approvals.add(this);this.assertCurrent();Object.freeze(this);
 }
 assertCurrent(){try{need(this.#open,'codec_profile_unsupported');}catch(e){this.#open=false;throw e;}}
 assertPin(pin:string){this.assertCurrent();need(pin===this.#pin,'codec_profile_unsupported');}
 close(){this.#open=false;}
 static require(value:Vf1Approval){need(approvals.has(value),'codec_profile_unsupported');value.assertCurrent();}
}
