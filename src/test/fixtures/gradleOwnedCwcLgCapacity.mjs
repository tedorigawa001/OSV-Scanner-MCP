/** Capacity audit only. No reservation reduction in LG-0 or the connected CWC pipeline. */
import {validateLg0Context,LG0_MAXIMUM_IDS,LG0_MAXIMUM_EPOCHS} from './gradleOwnedCwcLg0Context.mjs';
import {lg0MemoryBound} from './gradleOwnedCwcLg0Validation.mjs';
export const CAPACITY_BOUNDARIES=Object.freeze(['normal','registered-maximum','schema-upper']);
export const CAPACITY_RECIPES=Object.freeze(['baseline','window-3-with-4096-metadata','window-4-with-2048-metadata']);
export const CAPACITY_SCOPE=Object.freeze({auditOnly:true,syntheticReservations:true,originalLimitsPreserved:true,
 actualCwcConsumerIntegrated:false,activeWindowBoundEstablished:false,lg0ExitEstablished:false,nextStageAdmitted:false,productionAdopted:false,performanceMeasured:false});
const need=(ok,r)=>{if(!ok)throw Error('lg_capacity_'+r);};
const sum=v=>Object.values(v).reduce((a,b)=>a+b,0);
export function capacityContext(input,role,boundary){
 need(CAPACITY_BOUNDARIES.includes(boundary),'boundary');const c=structuredClone(validateLg0Context(input,role));
 if(boundary!=='normal'){
  const ids=new Set(LG0_MAXIMUM_IDS),epochs=new Set(LG0_MAXIMUM_EPOCHS);
  function maximum(v){for(const [k,x]of Object.entries(v)){
   if(ids.has(k))v[k]=('max-'+x).padEnd(128,'x').slice(0,128);
   else if(epochs.has(k))v[k]=Number.MAX_SAFE_INTEGER;
   else if(boundary==='schema-upper'&&k==='byteLength')v[k]=65536;
   else if(boundary==='schema-upper'&&k==='revision')v[k]=256;
   else if(x&&typeof x==='object')maximum(x);
  }}maximum(c);
 }
 return validateLg0Context(c,role,boundary!=='normal');
}
function accounting(c,role,recipe){
 need(CAPACITY_RECIPES.includes(recipe),'recipe');const checked=validateLg0Context(c,role),widths=lg0MemoryBound(checked);
 // The old formula includes three full private contexts; derive its byte count independently.
 const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 const contextBytes=Buffer.byteLength(canonical(checked));
 const baseline=recipe==='baseline',slots=baseline?0:recipe==='window-3-with-4096-metadata'?3:4,metadata=baseline?0:slots===3?4096:2048;
 const actor=(provider)=>{
  const oldCopies=provider?38:57,retained=baseline?oldCopies:provider?19:38;
  const regions={codec:393216,planCores:3*widths.coreBytes,commands:retained*widths.commandBytes,
   contexts:3*contextBytes,frames:32768,records:16384,sourceWire:provider?65536:0,
   sourceCopies:provider?2*41460:0,sourceMetadata:provider?4096:0,rootAndFactMetadata:8192,
   commandWindow:slots*8192,windowMetadata:metadata};
  const scopeBytes=sum(regions),parent={session:131072,call:98304,binding:8192,lg:4096};
  // Same proven frame sharing as CLB-1; no other old region is treated as free.
  const combinedPeak=scopeBytes+sum(parent)-32768;
  const withoutActive=combinedPeak-regions.commandWindow;
  return {regions,scopeBytes,parent,sharedFrameCredit:32768,combinedPeak,withinLimit:combinedPeak<=1048576,
   oldCommandCopies:oldCopies,retainedCommandCopies:retained,activeSlots:slots,maximumSlotsAtThisMetadata:Math.floor((1048576-withoutActive)/8192)};
 };
 const client=actor(false),provider=actor(true),worstActor=provider.combinedPeak>=client.combinedPeak?'provider':'client';
 return {recipe,role,widths,contextBytes,client,provider,worstActor,combinedPeak:Math.max(client.combinedPeak,provider.combinedPeak),
  withinLimit:client.withinLimit&&provider.withinLimit,memoryLimit:1048576,scope:CAPACITY_SCOPE};
}
export function capacityBreakdown(c,role){return accounting(c,role,'baseline');}
export function capacityCandidate(c,role,recipe){need(recipe!=='baseline','candidate');return accounting(c,role,recipe);}
export function capacityRow(c,role,recipe){return accounting(c,role,recipe);}

/** Source locations are bound by the record checker; these are planned ownership changes. */
export const CAPACITY_LIFETIMES=Object.freeze([
 {id:'client-initial-commands',source:'src/test/fixtures/gradleOwnedCwcVf3Case.ts',anchor:'const p=pack(clientContext',retainedUntil:'same(p.commands,sealed.commands)',releaseBefore:'none-in-current-source',candidate:'private-canonical-initial-family-through-independent-seal'},
 {id:'client-seal-commands',source:'src/test/fixtures/gradleOwnedCwcCPlanner.ts',anchor:'const commands=groups.map',retainedUntil:'return {core,planDigest:digest,commands',releaseBefore:'none-in-current-source',candidate:'stream-one-command-and-retain-seal-facts-not-second-object-family'},
 {id:'provider-commands',source:'src/test/fixtures/gradleOwnedCwcCProvider.ts',anchor:'same(p.commands[q.payload.plan.batchOrdinal],q)',retainedUntil:'plan comparison',releaseBefore:'none-in-current-source',candidate:'stream-all-nineteen-and-compare-selected-ordinal-without-full-array'},
 {id:'fact-canonical-bytes',source:'src/test/fixtures/gradleOwnedCwcA.ts',anchor:'bytes=ownBytes(canonical(q,8192))',retainedUntil:'root disposal or client child release',releaseBefore:'forbidden-before-proof-and-initial-seal-and-child-use',candidate:'preserve-private-independent-fact-families'},
 {id:'transient-fact-command',source:'src/test/fixtures/gradleOwnedCwcA.ts',anchor:'if(this.#connected)f.q=undefined',retainedUntil:'length proof complete',releaseBefore:'already-released-in-current-source',candidate:'do-not-count-this-existing-release-as-new-saving'},
 {id:'three-private-contexts',source:'src/test/fixtures/gradleOwnedCwcC.ts',anchor:'contexts=3*contextBytes',retainedUntil:'owner/codec/scope closure',releaseBefore:'no-immutable-sharing-proof',candidate:'retain-all-three-in-this-audit'},
 {id:'private-plan-cores',source:'src/test/fixtures/gradleOwnedCwcA.ts',anchor:'r.core=validatePlanCore(copy(input))',retainedUntil:'root disposal and independent plan comparison',releaseBefore:'no-cross-owner-plan-sharing',candidate:'retain-all-three-in-this-audit'},
 {id:'snapshot-and-call',source:'src/test/fixtures/gradleOwnedCwcC.ts',anchor:'snapshots.set(h,{scope:this,bundle',retainedUntil:'existing pre/post/final/drain boundaries',releaseBefore:'forbidden-for-command-memory-savings',candidate:'preserve-source-and-call-and-lg-reservations'}
].map(x=>Object.freeze(x)));
