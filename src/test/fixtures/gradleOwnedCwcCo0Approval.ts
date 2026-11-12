/** Independent fixture-only source/recipe pin. Cannot approve full work coverage or production use. */
import {z} from 'zod';
import {createPublicKey,verify} from 'node:crypto';
import {posix} from 'node:path';
import {CO0_RECIPE} from './gradleOwnedCwcCo0Contract.js';
import {lgOwnedCopy} from './gradleOwnedCwcLg0Contract.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed,chash} from '../../utils/gradleOwnedCurrentSchema.js';
const manifest=z.object({schema:z.literal('cwc-co0.source.v1'),recipeDigest:chash,node:z.string(),sources:z.record(z.string(),chash)}).strict();
const signed=z.object({manifest,signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/)}).strict();
const registry=z.object({schema:z.literal('cwc-co0.registry.v1'),manifestDigest:chash,operatorSpki:z.string().max(128)}).strict();
const known=new WeakSet<object>();
export class Co0Approval{
 readonly pin:string;#live=true;readonly #listeners=new Set<()=>void>();
 constructor(envelope:unknown,inputRegistry:unknown,pin:string,sources:Record<string,Buffer>){
  const e=parsed(signed,lgOwnedCopy(envelope,65536)),r=parsed(registry,lgOwnedCopy(inputRegistry));
  need(hash(r)===pin&&hash(e.manifest)===r.manifestDigest&&e.manifest.recipeDigest===hash(CO0_RECIPE)&&e.manifest.node===process.version,'co0_profile_unsupported');
  const key=createPublicKey({key:Buffer.from(r.operatorSpki,'base64'),format:'der',type:'spki'});
  need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(e.manifest)),key,Buffer.from(e.signature,'base64')),'co0_profile_unsupported');
  const names=Object.keys(e.manifest.sources);need(names.length>0&&names.length<=256&&canonical(names.sort())===canonical(Object.keys(sources).sort()),'co0_profile_unsupported');
  for(const name of ['gradleOwnedCwcCo0.ts','gradleOwnedCwcCo0Contract.ts','gradleOwnedCwcCo0Approval.ts','gradleOwnedCwcCo0Fixture.ts'])need(Object.hasOwn(sources,'src/test/fixtures/'+name),'co0_profile_unsupported');
  let bytes=0;for(const [p,d]of Object.entries(e.manifest.sources)){
   need((p.startsWith('src/')||['package-lock.json','tsconfig.json','vitest.config.ts'].includes(p))&&!p.split('/').includes('..'),'co0_profile_unsupported');
   const b=sources[p];need(Buffer.isBuffer(b)&&(bytes+=b.length)<=8388608&&sha(b)===d,'co0_profile_unsupported');
   for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let target=posix.normalize(posix.join(posix.dirname(p),m[1]!));if(target.endsWith('.js'))target=target.slice(0,-3)+'.ts';need(Object.hasOwn(sources,target),'co0_profile_unsupported');}
  }
  this.pin=pin;known.add(this);Object.freeze(this);
 }
 static require(a:Co0Approval){need(known.has(a)&&a.#live,'co0_profile_unsupported');}
 subscribe(fn:()=>void){Co0Approval.require(this);this.#listeners.add(fn);return ()=>this.#listeners.delete(fn);}
 revoke(){if(!this.#live)return;this.#live=false;for(const fn of [...this.#listeners])fn();this.#listeners.clear();}
}
Object.freeze(Co0Approval.prototype);Object.freeze(Co0Approval);
