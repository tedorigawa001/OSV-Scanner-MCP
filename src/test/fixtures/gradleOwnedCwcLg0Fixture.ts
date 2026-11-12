/** Diagnostic operator assembly, signed source closure and real shared Lb0Budget only. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Lg0Session,type Lg0Options} from './gradleOwnedCwcLg0.js';
import {Lg0Approval} from './gradleOwnedCwcLg0Approval.js';
import {LG0_POLICY} from './gradleOwnedCwcLg0Contract.js';
import {LG0_MAXIMUM_IDS,LG0_MAXIMUM_EPOCHS} from './gradleOwnedCwcLg0Context.mjs';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Clock} from './gradleOwnedCwcVf0Authority.js';
import {lb0Fixture} from './gradleOwnedCwcLb0Fixture.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';

let saved:ReturnType<typeof approvalInputs>|undefined;
function approvalInputs(){
 const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;
  for(const m of b.toString().matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcLg0Fixture.ts','src/test/utils/gradleOwnedCwcLg0.test.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const key=generateKeyPairSync('ed25519'),manifest={schema:'cwc-lg0.approval.v1',policyDigest:hash(LG0_POLICY),node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))};
 const registry={schema:'cwc-lg0.registry.v1',manifestDigest:hash(manifest),operatorSpki:key.publicKey.export({type:'spki',format:'der'}).toString('base64')};
 const envelope={manifest,signature:sign(null,Buffer.from(canonical(manifest)),key.privateKey).toString('base64')};return {sources,manifest,registry,envelope,pin:hash(registry)};
}
export function lg0ApprovalFixture(){saved??=approvalInputs();const a=saved;return {...a,approval:new Lg0Approval(a.envelope,a.registry,a.pin,a.sources)};}
/** All cid fields and unbounded epochs reach their schema maximum, retaining cross-field equality. */
export function lg0MaximumInput(o:Lg0Options){
 const ids=new Set(LG0_MAXIMUM_IDS),epochs=new Set(LG0_MAXIMUM_EPOCHS);
 function change(v:any){for(const [k,x]of Object.entries(v)){if(ids.has(k)&&typeof x==='string')v[k]=('max-'+x).padEnd(128,'x').slice(0,128);else if(epochs.has(k)&&typeof x==='number')v[k]=Number.MAX_SAFE_INTEGER;else if(x&&typeof x==='object')change(x);}}
 change(o.context);change(o.view);
}
export function lg0Fixture(options:{mode?:Lg0Options['mode'];role?:'reader'|'authority-broker';budget?:Lb0Budget;register?:boolean;
 configure?:(options:Lg0Options)=>void}={}){
 const a=lg0ApprovalFixture(),base=lb0Fixture({role:options.role,api:'aux.ReadSourceRanges'});
 const ctx=structuredClone(base.context),permissions=structuredClone(base.permissions);base.close();
 const clock=new Vf0Clock(),budget=options.budget??new Lb0Budget();
 const hooks:Record<string,((c:any)=>void)|undefined>={};
 const input:Lg0Options={mode:options.mode??'owned-input',context:ctx,
  view:{peer:true,server:true,peerKeyEpoch:ctx.peer.keyEpoch,serverKeyEpoch:ctx.provider.keyEpoch,permissions,purpose:'read',registryPin:ctx.registryDigest,sourcePin:a.pin,profilePin:a.pin,callbackPolicy:0},
  budget,clock,approval:a.approval,register:options.register,hook:(site,call)=>hooks[site]?.(call)};
 options.configure?.(input);const session=new Lg0Session(input);
 return {session,authority:session.authority,approval:a,budget,clock,hooks,input,permissions,context:ctx,
  open:()=>session.open(),close:()=>session.close(),ready(){const call=session.open(),handle=call.capture();call.seal(handle,call.scope);return {call,handle};}};
}
