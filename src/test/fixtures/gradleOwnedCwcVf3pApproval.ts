/** Separate fixture operator pin for the added observer and clock gate; base VF-3 remains unchanged. */
import {readFileSync} from 'node:fs';import {resolve,dirname,relative} from 'node:path';import {generateKeyPairSync,sign} from 'node:crypto';
import {vf3Approvals} from './gradleOwnedCwcVf3.js';import {VF3P_POLICY} from './gradleOwnedCwcVf3pValidation.mjs';
import {freezeData} from './gradleOwnedCwcLb0Contract.js';
import {vf3pObserverSources} from './gradleOwnedCwcVf3pProfile.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';import {need} from '../../utils/gradleOwnedCurrentSchema.js';
const approved=new WeakSet<object>();
export type Vf3pApproval=ReturnType<typeof vf3pApprovalFixture>['view'];
export function requireVf3pApproval(a:Vf3pApproval){need(approved.has(a),'codec_profile_unsupported');a.assertCurrent();a.base.assertCurrent();}
export function vf3pApprovalFixture(){const original=vf3Approvals(),base=original.view,sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}for(const p of ['src/test/fixtures/gradleOwnedCwcVf3p.ts','src/test/utils/gradleOwnedCwcVf3p.test.ts','src/test/utils/gradleOwnedCwcVf3pRecord.test.ts','src/test/utils/gradleOwnedCwcVf3pBenchmark.test.ts'])bind(p);
 const manifest={schema:'cwc-vf3p.approval.v2',policyDigest:hash(VF3P_POLICY),basePin:base.record.pin,methods:vf3pObserverSources(),node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))},keys=generateKeyPairSync('ed25519'),registry={schema:'cwc-vf3p.registry.v1',manifestDigest:hash(manifest),operatorSpki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')},pin=hash(registry),record=freezeData({envelope:{manifest,signature:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')},registry,pin});let open=true,current=pin;
 const view=Object.freeze({base,code:original.code,record,pin,assertCurrent(){try{need(open&&current===pin,'codec_profile_unsupported');base.assertCurrent();original.code.assertCurrent();}catch(e){open=false;throw e;}}});approved.add(view);return {view,codeRecord:original.codeRecord,revoke(){current=sha('revoked');base.close();original.code.close();}};
}
