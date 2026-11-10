/** Separate fixture operator pin for the added observer and clock gate; base CLB-3 remains unchanged. */
import {readFileSync} from 'node:fs';import {resolve,dirname,relative} from 'node:path';import {generateKeyPairSync,sign} from 'node:crypto';
import {lb3ApprovalFixture} from './gradleOwnedCwcLb3Approval.js';import {LB3_APPROVAL_ROOTS} from './gradleOwnedCwcLb3Validation.mjs';import {LB3P_POLICY} from './gradleOwnedCwcLb3pValidation.mjs';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';import {need} from '../../utils/gradleOwnedCurrentSchema.js';
const approved=new WeakSet<object>();
export type Lb3pApproval=ReturnType<typeof lb3pApprovalFixture>['view'];
export function requireLb3pApproval(a:Lb3pApproval){need(approved.has(a),'codec_profile_unsupported');a.assertCurrent();a.base.assertCurrent();}
export function lb3pApprovalFixture(){const base=lb3ApprovalFixture().view,sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}for(const p of ['src/test/fixtures/gradleOwnedCwcLb3p.ts',...LB3_APPROVAL_ROOTS])bind(p);
 const manifest={schema:'cwc-lb3p.approval.v1',policyDigest:hash(LB3P_POLICY),basePin:base.pin,node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))},keys=generateKeyPairSync('ed25519'),registry={schema:'cwc-lb3p.registry.v1',manifestDigest:hash(manifest),operatorSpki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')},pin=hash(registry),record={envelope:{manifest,signature:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')},registry,pin};let open=true,current=pin;
 const view=Object.freeze({base,record,pin,assertCurrent(){try{need(open&&current===pin,'codec_profile_unsupported');}catch(e){open=false;throw e;}}});approved.add(view);return {view,revoke(){current=sha('revoked');}};
}
