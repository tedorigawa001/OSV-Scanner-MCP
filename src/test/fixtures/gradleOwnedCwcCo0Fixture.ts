/** Operator-owned fixed fixture. Never imported by a production scanner/adapter. */
import {readFileSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {Co0Owner,type Co0Fault} from './gradleOwnedCwcCo0.js';
import {Co0Approval} from './gradleOwnedCwcCo0Approval.js';
import {CO0_RECIPE} from './gradleOwnedCwcCo0Contract.js';
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
import {Vf0Clock} from './gradleOwnedCwcVf0Authority.js';
import {cprFixture} from './gradleOwnedCprAFixture.js';
import {planCore} from './gradleOwnedCprAPlanner.js';
import {capacityContext} from './gradleOwnedCwcLgCapacity.mjs';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
let saved:ReturnType<typeof operator>|undefined;
function operator(){const sources:Record<string,Buffer>={};function bind(p:string){if(p in sources)return;const b=readFileSync(p);sources[p]=b;
 for(const m of b.toString().matchAll(/(?:from|import|export)\s*(?:[^'";]*?from\s*)?['"]([^'"]+)['"]/g)){if(!m[1]!.startsWith('.'))continue;let next=resolve(dirname(p),m[1]!);if(next.endsWith('.js'))next=next.slice(0,-3)+'.ts';bind(relative(process.cwd(),next));}}
 for(const p of ['src/test/fixtures/gradleOwnedCwcCo0Fixture.ts','src/test/utils/gradleOwnedCwcCo0.test.ts','package-lock.json','tsconfig.json','vitest.config.ts'])bind(p);
 const key=generateKeyPairSync('ed25519'),manifest={schema:'cwc-co0.source.v1',recipeDigest:hash(CO0_RECIPE),node:process.version,sources:Object.fromEntries(Object.entries(sources).map(([p,b])=>[p,sha(b)]))};
 const registry={schema:'cwc-co0.registry.v1',manifestDigest:hash(manifest),operatorSpki:key.publicKey.export({type:'spki',format:'der'}).toString('base64')};
 return {sources,manifest,registry,pin:hash(registry),envelope:{manifest,signature:sign(null,Buffer.from(canonical(manifest)),key.privateKey).toString('base64')}};
}
export function co0ApprovalFixture(){saved??=operator();const a=saved;return {...a,view:new Co0Approval(a.envelope,a.registry,a.pin,a.sources)};}
export function co0Fixture(o:{kind?:'provider'|'client';role?:'reader'|'authority-broker';boundary?:string;recipe?:unknown;budget?:Lb0Budget;fault?:Co0Fault;hook?:(site:string,owner:Co0Owner)=>void}={}){
 const base=cprFixture({role:o.role,sizes:[1,1,1,1,8288,8288,8288,8288,8304]});
 // No Session/credential registry is connected here. Pin a deterministic synthetic input
 // instead of omitting the real fixture's per-process random registry digest from replay.
 base.ctx.registryDigest=hash({schema:'cwc-co0.synthetic-registry.v1',source:'fixed-command-storage-fixture'});
 const ctx=capacityContext(base.ctx,o.role??'reader',o.boundary??'normal');
 const groups:any[][]=[base.entries.slice(0,4).map((e,i)=>({ordinal:i,kind:e.kind,index:e.index,offset:0,length:e.byteLength,entry:{sha256:e.sha256,byteLength:e.byteLength}}))];
 for(let i=4;i<base.entries.length;i++){const e=base.entries[i]!,parts=i<7?4:3;let offset=0;for(let j=0;j<parts;j++){const length=Math.ceil((e.byteLength-offset)/(parts-j));groups.push([{ordinal:0,kind:e.kind,index:e.index,offset,length,entry:{sha256:e.sha256,byteLength:e.byteLength}}]);offset+=length;}}
 const core=planCore(ctx,'s'.repeat(128),'t'.repeat(128),groups),approval=co0ApprovalFixture(),budget=o.budget??new Lb0Budget(),clock=new Vf0Clock();
 const owner=new Co0Owner({recipe:o.recipe??CO0_RECIPE,approval:approval.view,budget,clock,context:ctx,kind:o.kind??'provider',fault:o.fault,hook:o.hook});
 return {owner,approval,budget,clock,core,context:ctx};
}
export function runCo0Matrix(){const rows=[];
 for(const role of ['reader','authority-broker'] as const)for(const boundary of ['normal','registered-maximum','schema-upper'])for(const mode of ['full-input','owned-input'])for(const kind of ['provider','client'] as const){
  const f=co0Fixture({kind,role,boundary});let error:string|null=null,equality:string|null=null;
  try{const claims=f.owner.claim(),actors=kind==='provider'?['provider'] as const:['client-initial','client-seal'] as const;
   for(const [i,actor]of actors.entries()){const w=f.owner.open(claims[i]!,f.owner.identity(actor),f.core);for(let n=0;n<19;n++)f.owner.capture(w);for(let n=0;n<19;n++)f.owner.process(w);}
   if(kind==='client')equality=f.owner.compareFamilies();
  }catch(e){error=e instanceof Error?e.message:String(e);}
  const {trace,...before}=f.owner.stats(),beforeClose={...before,traceLength:trace.length,traceDigest:hash(trace)};f.owner.close();rows.push({role,boundary,mode,kind,error,equality,context:f.context,beforeClose,afterClose:f.owner.stats()});
 }
 return {schema:'cwc-co0.storage-evidence.v1',rows};
}
