/** Independent fixture operator assembly. Never imported by the connected planner/provider or grant. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {CwcCApprovalRegistry,CWC_C_POLICY} from './gradleOwnedCwcC.js';
const operator=generateKeyPairSync('ed25519');
export function cwcCApprovalFixture(){
 const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString('utf8').matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcCCase.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const manifest={schema:'cwc-c.source-approval.v1',policyDigest:hash(CWC_C_POLICY),sourceClosure:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)])),runtime:{node:process.version,vitest:JSON.parse(readFileSync('node_modules/vitest/package.json','utf8')).version}};
 const registry={schema:'cwc-c.approval-registry.v1',approvedManifest:hash(manifest),operatorSpki:operator.publicKey.export({format:'der',type:'spki'}).toString('base64')},pin=hash(registry),envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),operator.privateKey).toString('base64')};
 let current=pin;const view=new CwcCApprovalRegistry(envelope,registry,pin,sources,()=>current);
 return {view,envelope,registry,pin,sources,revoke:()=>current=hash('revoked'),resign:(m:unknown)=>({manifest:m,signature:sign(null,Buffer.from(canonical(m)),operator.privateKey).toString('base64')})};
}
