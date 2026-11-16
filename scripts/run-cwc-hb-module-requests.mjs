/**
 * Check the HB1/HB2 preflight import checks against the ModuleRequest shape of another runtime.
 * Usage: node --experimental-vm-modules scripts/run-cwc-hb-module-requests.mjs <mode>
 * Modes reshape every request: native (unchanged), node22 (no phase field, as Node 22.20+ reports it),
 * source (phase "source"), attributes (non-empty attributes), no-attributes (attributes field missing).
 * Prints {"hb1":...,"hb2":...} with "accepted" or the thrown code.
 */
import {SourceTextModule} from 'node:vm';
const mode=process.argv[2];
const reshape={
  native:r=>r,
  node22:({phase:_,...r})=>r,
  source:r=>({...r,phase:'source'}),
  attributes:r=>({...r,attributes:{type:'json'}}),
  'no-attributes':({attributes:_,...r})=>r,
}[mode];
if(!reshape||process.argv.length!==3)throw Error('Usage: run-cwc-hb-module-requests.mjs <native|node22|source|attributes|no-attributes>');
const descriptor=Object.getOwnPropertyDescriptor(SourceTextModule.prototype,'moduleRequests');
if(typeof descriptor?.get!=='function')throw Error('moduleRequests getter not found');
Object.defineProperty(SourceTextModule.prototype,'moduleRequests',{...descriptor,get(){return descriptor.get.call(this).map(r=>reshape({...r}));}});
const outcome=f=>{try{f();return 'accepted';}catch(e){return typeof e==='string'?e:String(e?.message??e);}};
const {verifyHb1Candidate}=await import('../src/test/fixtures/gradleOwnedCwcHb1Bootstrap.mjs');
const {verifyHb2Candidate}=await import('../src/test/fixtures/gradleOwnedCwcHb2Bootstrap.mjs');
console.log(JSON.stringify({hb1:outcome(()=>verifyHb1Candidate()),hb2:outcome(()=>verifyHb2Candidate())}));
