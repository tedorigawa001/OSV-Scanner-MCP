/** One independently pinned source/policy approval group shared by all comparison arms. */
import {generateKeyPairSync,sign,verify,createPublicKey} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {Lb2Approval,LB2_POLICY} from './gradleOwnedCwcLb2Approval.js';
import {LB1_POLICY} from './gradleOwnedCwcLb1Approval.js';
import {lb0ApprovalFixture} from './gradleOwnedCwcLb0Fixture.js';
import {cwcCApprovalFixture} from './gradleOwnedCwcCApprovalFixture.js';
import {LB3_CONDITIONS,LB3_APPROVAL_ROOTS} from './gradleOwnedCwcLb3Validation.mjs';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
const approved=new WeakSet<object>();
export type Lb3Approvals={binding:Lb2Approval;code:ReturnType<typeof cwcCApprovalFixture>['view'];pin:string;bindingPin:string;codePin:string;record:any;assertCurrent:()=>void};
export function requireLb3Approvals(value:Lb3Approvals){need(approved.has(value),'codec_profile_unsupported');value.assertCurrent();}
export function lb3ApprovalFixture(){
 const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of LB3_APPROVAL_ROOTS)bind(p);
 function signed(manifest:any,schema:string){const keys=generateKeyPairSync('ed25519'),registry={schema,manifestDigest:hash(manifest),operatorSpki:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')};return {envelope:{manifest,signature:sign(null,Buffer.from(canonical(manifest)),keys.privateKey).toString('base64')},registry,pin:hash(registry)};}
 const hashes=Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)])),connected=signed({schema:'cwc-lb1.approval.v1',policyDigest:hash(LB1_POLICY),node:process.version,sources:hashes},'cwc-lb1.registry.v1');
 const bindingSigned=signed({schema:'cwc-lb2.approval.v1',policyDigest:hash(LB2_POLICY),connectedPin:connected.pin,node:process.version,sources:hashes},'cwc-lb2.registry.v1'),bindingRecord={...bindingSigned,connected},binding=new Lb2Approval(lb0ApprovalFixture(),bindingRecord,bindingSigned.pin,sources,()=>bindingSigned.pin),code=cwcCApprovalFixture();
 const comparison=signed({schema:'cwc-lb3.approval.v1',node:process.version,conditionsDigest:hash(LB3_CONDITIONS),bindingPin:bindingSigned.pin,codePin:code.pin,sources:hashes},'cwc-lb3.registry.v1');
 const key=createPublicKey({key:Buffer.from(comparison.registry.operatorSpki,'base64'),type:'spki',format:'der'});need(verify(null,Buffer.from(canonical(comparison.envelope.manifest)),key,Buffer.from(comparison.envelope.signature,'base64')),'codec_profile_unsupported');let pin=comparison.pin,open=true;
 const view:Lb3Approvals=Object.freeze({binding,code:code.view,pin:comparison.pin,bindingPin:bindingSigned.pin,codePin:code.pin,record:{comparison,binding:bindingRecord,code:{envelope:code.envelope,registry:code.registry,pin:code.pin}},assertCurrent(){try{need(open&&pin===comparison.pin,'codec_profile_unsupported');binding.assertCurrent();code.view.assertCurrent();}catch(e){open=false;throw e;}}});approved.add(view);
 return {view,revoke(){pin=sha('revoked');}};
}
