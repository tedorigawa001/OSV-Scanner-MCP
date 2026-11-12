/** Independent replay of the fixed source consumer's observed allocation recipe.
 * No result here can approve a window or establish an allocation upper bound. */
import {createHash} from 'node:crypto';
export const WINDOW_SCOPE_EXPECTED=Object.freeze({actualUnmodifiedABConsumer:true,actualConnectedGrant:true,
 fixedClock:true,sameProcess:true,diagnosticSpies:true,lowerBoundOnly:true,separateDiagnosticBudget:true,lgModeRuntimeConnected:false,
 originalPipelineChanged:false,providerSessionConnected:false,threeSlotBoundEstablished:false,
 metadataLayoutProved:false,extraWorkBoundProved:false,budgetCoexistenceProved:false,lg0ExitEstablished:false,productionAdopted:false});
export const windowCanonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(windowCanonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+windowCanonical(v[k])).join(',')+'}';
export const windowHash=v=>createHash('sha256').update(windowCanonical(v)).digest('hex');
const need=(v,r)=>{if(!v)throw Error('lg_window_'+r);},same=(a,b)=>windowCanonical(a)===windowCanonical(b);
const keys=(v,n)=>need(v&&same(Object.keys(v).sort(),n.split(' ').sort()),'schema');
/** Match CwcConnectedGrant's actual identity derivation before normalizing fresh IDs. */
function assertGrantScopeBinding(a){
 const g=a?.grant;
 need(Number.isSafeInteger(a?.scopeId)&&a.scopeId>0&&g?.actor==='client-initial'&&
  g.scopeId===windowHash({scope:a.scopeId,actor:g.actor})&&g.callId===windowHash({call:a.scopeId,actor:g.actor}),'grant_scope_binding');
}
export const WINDOW_SITES=Object.freeze([
 {id:'encode',path:'src/test/fixtures/gradleOwnedCwcA.ts',anchor:'const q=command(copy(input));checkCommand(this.#c,q);const expected=makeCommand('},
 {id:'fact-release',path:'src/test/fixtures/gradleOwnedCwcA.ts',anchor:'if(this.#connected)f.q=undefined'},
 {id:'copy',path:'src/test/fixtures/gradleOwnedCwcA.ts',anchor:'function copy<T>(value:T):T{plain(value);return structuredClone(value);}'},
 {id:'codec-copy',path:'src/test/fixtures/gradleOwnedCwcB.ts',anchor:'visit(input,0);return structuredClone(input);'},
 {id:'codec-check',path:'src/test/fixtures/gradleOwnedCwcB.ts',anchor:'#checked(input:unknown){const q=command(dataCopy(input));checkCommand(this.#c,q);return q;}'},
 {id:'expected',path:'src/test/fixtures/gradleOwnedCprASchema.ts',anchor:'q.requestDigest=wireIntent(q);return command(q);'},
 {id:'schema',path:'src/utils/gradleOwnedCurrentSchema.ts',anchor:'try{return schema.parse(value);}'},
 {id:'grant-identity',path:'src/test/fixtures/gradleOwnedCwcC.ts',anchor:'scopeId:hash({scope:scope.id,actor}),callId:hash({call:scope.id,actor})'},
]);
export function windowSourceLocations(sources){return WINDOW_SITES.map(s=>{
 const text=sources[s.path];need(typeof text==='string'&&text.split(s.anchor).length===2,'source_anchor');
 return {...s,line:text.slice(0,text.indexOf(s.anchor)).split('\n').length,sourceSha256:createHash('sha256').update(text).digest('hex')};
});}
/** Unlike the observer, this recipe does not call a consumer or trust its counters. */
export function expectedWindowTrace(widths,capacity){
 const out=[],live=new Map();let id=0,object=0,ordinal=0;
 const event=(kind,l,bytes=0)=>out.push({seq:out.length,ordinal,kind,id:l.id,site:l.site,object:l.object,active:live.size,bytes,live:[...live.keys()]});
 const alloc=site=>{const l={id:++id,site,object:null};if(live.size===capacity){event('denied',l);return null;}
  live.set(l.id,l);event('reserve',l);l.object=++object;event('allocated',l,widths[ordinal]);return l;};
 const release=l=>{live.delete(l.id);event('release',l);};
 for(ordinal=0;ordinal<widths.length;ordinal++){
  const caller=alloc('caller-decode'),copy=alloc('data-copy'),q=alloc('schema-result');release(copy);
  release(alloc('schema-result'));const raw=alloc('expected-build'),expected=alloc('schema-result');
  if(!expected){release(raw);release(caller);release(q);break;}
  release(raw);release(expected);
  for(let i=0;i<2;i++){const copy=alloc('data-copy'),parsed=alloc('schema-result');release(copy);release(alloc('schema-result'));release(parsed);}
  release(q);release(caller);
 }
 return out;
}
export function validateWindowEvidence(e,capacityRecord){
 keys(e,'schema rows');need(e.schema==='cwc-lg.window-evidence.v1'&&Array.isArray(e.rows)&&e.rows.length===24,'matrix');
 const identities=new Set(),scopeNumbers=new Set();let index=0;
 for(const role of ['reader','authority-broker'])for(const boundary of ['normal','registered-maximum','schema-upper']){
  let widths;
  for(const mode of ['full-input','owned-input'])for(const capacity of [3,8]){
   const row=e.rows[index++];keys(row,'role boundary mode capacity attempts');need(same({role,boundary,mode,capacity},{role:row.role,boundary:row.boundary,mode:row.mode,capacity:row.capacity}),'identity');
   need(Array.isArray(row.attempts)&&row.attempts.length===2,'attempts');
   const baseline=capacityRecord.evidence.rows.find(r=>r.role===role&&r.boundary===boundary&&r.recipe==='baseline').audit;
   for(const [attempt,a] of row.attempts.entries()){
    keys(a,'mode capacity error completed oracleChecks groups entries sourceBytes fourRangeGroups peakObserved witness deniedAt deniedBeforeParse deniedParseCalls counts planSpent grant diagnosticBudget commandWidths trace scope scopeId');
    need(a.mode===mode&&a.capacity===capacity&&same(a.scope,WINDOW_SCOPE_EXPECTED),'scope');
    need(a.groups===19&&a.entries===9&&a.sourceBytes===41460&&a.fourRangeGroups===1,'workload');
    need(a.completed===(capacity===3?0:19)&&a.oracleChecks===a.completed&&a.error===(capacity===3?'current_control_schema_invalid':null),'outcome');
    need(a.peakObserved===(capacity===3?3:4)&&a.deniedAt===(capacity===3?'expected':null)&&a.deniedBeforeParse===(capacity===3)&&a.deniedParseCalls===0,'denial');
    need(a.planSpent===(attempt+1)*156978,'work');
    need(same(a.counts,capacity===3?{parses:2,copies:1,decodes:1,builds:1}:{parses:133,copies:57,decodes:19,builds:19}),'counts');
    need(Array.isArray(a.commandWidths)&&a.commandWidths.length===(capacity===3?1:19)&&a.commandWidths.every(n=>Number.isSafeInteger(n)&&n>0&&n<=baseline.widths.commandBytes),'widths');
    if(capacity===8){if(widths)need(same(a.commandWidths,widths),'widths');else widths=a.commandWidths;}
    else if(widths)need(a.commandWidths[0]===widths[0],'widths');
    need(same(a.trace,expectedWindowTrace(a.commandWidths,capacity)),'trace');
    need(same(a.witness,capacity===3?null:[{id:1,object:1,site:'caller-decode'},{id:3,object:3,site:'schema-result'},{id:5,object:5,site:'expected-build'},{id:6,object:6,site:'schema-result'}]),'witness');
    need(same(a.diagnosticBudget,{work:0,initialization:4096,wire:0,attempts:0,heldBytes:0,peakBytes:capacity*8192+4096,occupiedSlots:0,memoryLimit:1048576,workLimit:156978}),'diagnostic_budget');
    const g=a.grant;keys(g,'actor scopeId callId originalDeadline prepaidPlanWork workAccounting memory steps complete');
    for(const id of [g.scopeId,g.callId]){need(typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)&&!identities.has(id),'grant_identity');identities.add(id);}
    need(Number.isSafeInteger(a.scopeId)&&a.scopeId>0&&!scopeNumbers.has(a.scopeId),'grant_identity');scopeNumbers.add(a.scopeId);
    assertGrantScopeBinding(a);
    need(g.actor==='client-initial'&&g.originalDeadline===4500&&g.prepaidPlanWork===156978&&g.workAccounting==='cpr.request-bytes-ranges-probes.v1'&&g.complete===(capacity===8),'grant');
    need(same(g.steps,capacity===3?{'codec:compile':1,root:1,compile:1,encode:1}:{'codec:compile':1,root:1,compile:1,encode:19,proof:19,'codec:proof':19,'codec:inspect':19,width:19}),'steps');
    need(same(g.memory,{commandBytes:baseline.widths.commandBytes,coreBytes:baseline.widths.coreBytes,client:baseline.client.scopeBytes,provider:baseline.provider.scopeBytes,reserved:Math.max(baseline.client.scopeBytes,baseline.provider.scopeBytes),fragments:4096,work:156978}),'memory');
   }
  }
 }
 return {rows:24,attempts:48,diagnosticControlsCompleted:24,threeSlotRefusals:24,oracleCommands:456,
  observedDistinctCommandLowerBound:4,threeSlotBoundEstablished:false,metadataLayoutProved:false,extraWorkBoundProved:false,
  budgetCoexistenceProved:false,lg0ExitEstablished:false,nextStageAdmitted:false,productionAdopted:false};
}
/** A fresh execution checks coordinated width/counter/trace changes as well. Normalize
 * private minted values only AFTER checking each argument's own scope/actor binding.
 * Full-record uniqueness remains independently checked above. */
export function compareWindowReplay(recorded,replayed){
 function normalized(e){return {...e,rows:e.rows.map(r=>({...r,attempts:r.attempts.map(a=>{
  assertGrantScopeBinding(a);const {scopeId,callId,...grant}=a.grant;return {...a,scopeId:'fresh-scope',grant};})}))};}
 need(same(normalized(recorded),normalized(replayed)),'fresh_replay');
}
