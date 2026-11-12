/** Standalone signed LG source profile; its current cell is owned, not an opaque callback. */
import {z} from 'zod';
import {createPublicKey,verify} from 'node:crypto';
import {posix} from 'node:path';
import {LG0_POLICY,lgOwnedCopy} from './gradleOwnedCwcLg0Contract.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,chash} from '../../utils/gradleOwnedCurrentSchema.js';
const manifestSchema=z.object({schema:z.literal('cwc-lg0.approval.v1'),policyDigest:chash,node:z.string(),sources:z.record(z.string(),chash)}).strict();
const envelopeSchema=z.object({manifest:manifestSchema,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
const registrySchema=z.object({schema:z.literal('cwc-lg0.registry.v1'),manifestDigest:chash,operatorSpki:z.string().max(128)}).strict();
const owners=new WeakSet<object>();
export class Lg0Approval{
 readonly pin:string;#open=true;readonly #listeners=new Set<()=>void>();
 constructor(envelope:unknown,registry:unknown,pin:string,sources:Record<string,Buffer>){
  const e=parsed(envelopeSchema,lgOwnedCopy(envelope,65536)),r=parsed(registrySchema,lgOwnedCopy(registry));
  need(hash(r)===pin&&hash(e.manifest)===r.manifestDigest&&e.manifest.policyDigest===hash(LG0_POLICY)&&e.manifest.node===process.version,'codec_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.operatorSpki,'base64'),format:'der',type:'spki'});
  need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(e.manifest)),key,Buffer.from(e.signature,'base64')),'codec_profile_unsupported');
  const names=Object.keys(e.manifest.sources);need(names.length>0&&names.length<=256&&canonical(names.sort())===canonical(Object.keys(sources).sort()),'codec_profile_unsupported');
  for(const name of ['gradleOwnedCwcLg0.ts','gradleOwnedCwcLg0Contract.ts','gradleOwnedCwcLg0Approval.ts','gradleOwnedCwcLg0Fixture.ts'])need(Object.hasOwn(sources,'src/test/fixtures/'+name),'codec_profile_unsupported');
  let bytes=0;for(const [p,d]of Object.entries(e.manifest.sources)){
   need((p.startsWith('src/')||['package-lock.json','tsconfig.json','vitest.config.ts'].includes(p))&&!p.split('/').includes('..'),'codec_profile_unsupported');
   const source=sources[p];need(Buffer.isBuffer(source)&&(bytes+=source.length)<=8388608&&sha(source)===d,'codec_profile_unsupported');
   for(const m of source.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let target=posix.normalize(posix.join(posix.dirname(p),m[1]!));if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';need(Object.hasOwn(sources,target),'codec_profile_unsupported');}
  }
  this.pin=pin;owners.add(this);Object.freeze(this);
 }
 static require(v:Lg0Approval){need(owners.has(v)&&v.#open,'codec_profile_unsupported');}
 subscribe(fn:()=>void){Lg0Approval.require(this);this.#listeners.add(fn);return ()=>this.#listeners.delete(fn);}
 revoke(){if(!this.#open)return;this.#open=false;for(const fn of [...this.#listeners]){try{fn();}catch{/* Revoke every registered call even if one drain fails. */}}this.#listeners.clear();}
}
Object.freeze(Lg0Approval.prototype);Object.freeze(Lg0Approval);
