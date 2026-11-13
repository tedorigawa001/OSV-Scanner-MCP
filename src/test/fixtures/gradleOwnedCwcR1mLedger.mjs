/** R1-M source/region inventory. No allocation certificate, runtime admission, work conversion or reservation change. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {co0Canonical as canonical} from './gradleOwnedCwcCo0Validation.mjs';
const need=(v,r)=>{if(!v)throw Error('r1m_'+r);};
const sha=b=>createHash('sha256').update(b).digest('hex');
function data(root){let nodes=0;const seen=new Set();function visit(v,depth){
 need(++nodes<=131072&&depth<=64,'data_budget');if(v===null||typeof v==='string'||typeof v==='boolean')return;if(typeof v==='number'){need(Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0),'data_number');return;}
 need(v&&typeof v==='object'&&!types.isProxy(v)&&!seen.has(v),'data_type');const array=Array.isArray(v);need(Object.getPrototypeOf(v)===(array?Array.prototype:Object.prototype),'data_type');seen.add(v);
 const names=Reflect.ownKeys(v);if(array){const length=Object.getOwnPropertyDescriptor(v,'length').value;need(names.length===length+1,'data_array');}
 for(const k of names){need(typeof k==='string','data_key');const d=Object.getOwnPropertyDescriptor(v,k);need(d&&'value'in d,'data_accessor');if(array&&k==='length')continue;need(d.enumerable&&(!array||/^(0|[1-9][0-9]*)$/.test(k)),'data_key');visit(d.value,depth+1);}seen.delete(v);
 }visit(root,0);}
const equal=(a,b)=>{data(a);data(b);need(canonical(a)===canonical(b),'binding');};
const int=n=>Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0);
function sum(a){need(a.every(int),'quantity');const n=a.reduce((x,y)=>x+y,0);need(int(n),'overflow');return n;}
const root='src/test/fixtures/',json='src/utils/gradleOwnedJson.ts';
const file=n=>root+'gradleOwnedCwc'+n+'.ts';
// Explicit manual source catalogue. Whole files and all occurrences are pinned; this is not an AST allocation census.
const sites=[
 ['r0-input',file('R0'),'constructor(o:'],['r0-bootstrap',file('R0'),'const c=context(lgOwnedCopy'],
 ['r0-context',file('R0'),'ctx=Reflect.apply(from,Buffer,[canonical(c)])'],['r0-cores',file('R0'),'const builder=new R0Core('],
 ['r0-family',file('R0'),'slab:this.#alloc(19*this.#width)'],['r0-windows',file('R0'),'this.#slots=[this.#alloc(8192)'],
 ['r0-chunk',file('R0'),'this.#chunk=this.#alloc(4096)'],['r0-metadata',file('R0'),'this.#metadata=this.#alloc(3072)'],
 ['r0-control',file('R0'),'#reservation?:'],['r0-trace',file('R0'),'#event(kind:string'],
 ['r0-stats',file('R0'),'stats(){return'],['r0-export',file('R0'),'diagnosticRows(h:Handle)'],
 ['r0-final',file('R0'),'this.#finalRows=this.#children.map'],['r0-clean',file('R0'),'#cleanup(){'],
 ['r0-core-alias',file('R0Engine'),'readonly tokens:R0Tokens'],['r0-core-table',file('R0Engine'),'this.tokens=new R0Tokens(arena'],
 ['r0-token-source',file('R0Tokens'),'#source?:Buffer'],['r0-token-bind',file('R0Tokens'),'this.#source=source'],
 ['r0-token-clear',file('R0Tokens'),'clear(){'],['r0-parser',file('R0Tokens'),'#value(spec:R0Spec'],
 ['r0-span',file('R0Tokens'),'return {start,length};'],['r0-grammar',file('R0Grammar'),'const keys=new Set<string>()'],
 ['r0-sink',file('R0Engine'),'export class R0Sink'],['r0-native-load',file('R0Engine'),"hashPrototype=Object.getPrototypeOf(nativeCreateHash('sha256'))"],
 ['memory-native-load',file('R0Memory'),"hashPrototype=Object.getPrototypeOf(nativeCreateHash('sha256'))"],
 ['r0-view',file('R0Engine'),'view=Reflect.apply(subarray,this.chunk'],['r0-number',file('R0Engine'),'this.literal(String(n));'],
 ['r0-encoder',file('R0Engine'),'export function emitCommand'],['r0-native-end',file('R0Engine'),'#hash=undefined'],
 ['diagnostic-hash',file('R0Memory'),'export function r0DiagnosticSha'],
 ['canonical',json,'export function canonicalOwnedJson'],['canonical-late-bound',json,'const out=encode(value,0);'],
 ['generic-hash',json,'export const ownedSha256='],['copy-helper',file('Lg0Contract'),'export function lgOwnedCopy'],
 ['r1o-producer',file('R1o'),'#produce(c:Call)'],['r1o-context',file('R1o'),'cb=this.#buffer(c,canonical(ctx),8192)'],
 ['r1o-core',file('R1o'),'pb=this.#buffer(c,canonical(core),65536)'],['r1o-buffer',file('R1o'),'#buffer(c:Call'],
 ['r1o-validate',file('R1o'),'#validate(c:Call'],['r1o-fields',file('R1o'),'type Call={'],
 ['r1o-registry',file('R1o'),'readonly #calls=new Map'],['r1o-handles',file('R1o'),'const handles=Array.from({length:8}'],
 ['r1o-shell',file('R1o'),'c[role]={claim:'],['r1o-borrow',file('R1o'),'c.borrow={handle:'],
 ['r1o-stop',file('R1o'),'c.pin=s.store'],['r1o-exclusive',file('R1o'),'c.exclusive=store'],
 ['r1o-stamp',file('R1o'),'c.stamp={store,revision:'],['r1o-bind',file('R1o'),'d.store=store;c.source!.store=undefined'],
 ['r1o-pending',file('R1o'),'#observeRejectedPromise'],['r1o-settle',file('R1o'),'const settled=()=>'],
 ['r1o-trace',file('R1o'),'#event(c:Call'],['r1o-stats',file('R1o'),'stats(h:R1oHandle)'],
 ['r1o-clean',file('R1o'),'#drain(c:Call)'],['r1o-failure',file('R1o'),'#fail(c:Call'],
 ['r1o-budget',file('R1oBudget'),'const prototype=Lb0Budget.prototype'],['r1o-budget-issue',file('R1oBudget'),'export function createR1oBudget'],
 ['r1o-reserve',file('R1oBudget'),'export function reserveR1oBudget'],['lb-tickets',file('Lb0Contract'),'readonly #tickets=new WeakMap'],
 ['lb-release',file('Lb0Contract'),'release(t:MemoryTicket'],['r0-harness',file('R0Fixture'),'export function r0Fixture'],
 ['r1o-harness',file('R1oFixture'),'export function r1oMatrix'],['r1o-review',file('R1oFixture'),'export async function r1oReviewMatrix'],
 ['integration',file('LgCapacity').replace(/\.ts$/,'.mjs'),'const regions={codec:393216'],
 ['schema',root+'gradleOwnedCprASchema.ts','export const cprContext='],['context-clone',file('LgCapacity').replace(/\.ts$/,'.mjs'),'structuredClone(validateLg0Context'],
 ['connected-initial',file('Vf3Case'),'const p=pack(clientContext'],['connected-commands',file('CPlanner'),'const commands=groups.map'],
 ['connected-provider',file('CProvider'),'same(p.commands[q.payload.plan.batchOrdinal],q)'],
 ['connected-fact-bytes',file('A'),'bytes=ownBytes(canonical(q,8192))'],['connected-fact-release',file('A'),'if(this.#connected)f.q=undefined'],
 ['connected-core',file('A'),'r.core=validatePlanCore(copy(input))'],['connected-dispose',file('A'),'#dispose(r:Root,all:boolean)'],
 ['connected-context',file('C'),'this.#context=context(structuredClone(options.context))'],['connected-context-export',file('C'),'get context(){return structuredClone(this.#context)'],
 ['connected-snapshot',file('C'),'snapshots.set(h,{scope:this,bundle'],['connected-memory',file('C'),'contexts=3*contextBytes'],
 ['r1o-hook-field',file('R1o'),'readonly #hook:'],['r1o-hook-store',file('R1o'),'this.#hook=o.hook??'],
 ['r1o-hook-invoke',file('R1o'),'const result:unknown=this.#hook('],
];
export const R1M_SCOPE=Object.freeze({inventoryOnly:true,manualSourceCatalogue:true,astAllocationCensus:false,sourceClosurePinned:true,
 finiteObservationsOnly:true,backingViewBytesSeparated:true,hookCapturesInventoried:true,hookCaptureUpperProved:false,hookReleaseProved:false,allAllocationSitesProved:false,wholeVmReferenceUpperBound:false,
 bridgeChargeApproved:false,codecOverlayApproved:false,nativeBackendApproved:false,actualParentLedgerVector:false,costCoverageApproved:false,
 r1mRuntimeExit:false,r1Exit:false,r2Exit:false,productionAdopted:false,performanceMeasured:false});
const rows=[];
function row(id,region,profile,owner,sourceSites,holders,lifetime,quantity,kind='js-uncovered'){
 rows.push({id,region,profile,owner,sourceSites,holders,lifetime:{acquire:lifetime[0],lastUse:lifetime[1],clear:lifetime[2],retainedUntil:lifetime[3],wallTimeUpperMs:null},
 quantity,kind,representationUpperBytes:null,physicalHeapUpperBytes:null,approvedChargeRef:null,actualParentBinding:false});
}
row('M01','R01','R0','caller / R0 harness',['r0-input','r0-harness'],['o.context','o.groups','fixture.context/groups/core/commands'],['before constructor','oracle and caller last use','not owned by R0 cleanup','caller release and unproved GC'],{rule:'unknown',reason:'caller graph retained outside owner'});
row('M02','R01','R1O','closed producer frame',['r1o-producer','context-clone'],['f.ctx/entries/source','ctx','groups','core','range closure'],['producer entry','producer return','frame return only; no JS deallocation witness','unproved GC'],{rule:'unknown',reason:'full source fixture, structuredClone, planner and temporary graphs'});
row('M03','R02','R0','bootstrap / copy / schema frames',['r0-bootstrap','copy-helper','canonical'],['c','groups','bounds','canonical(c)','copy.active/out'],['constructor after diagnostic reservation','constructor return or exception escape','ctx bytes zero; cloned graphs not explicitly freed','frame return and unproved GC; caller exceptions may escape'],{rule:'unknown',reason:'131072 reservation is not a graph bound'});
row('M04','R02','R1O','exclusive validation frame',['r1o-validate','schema','canonical'],['cs','ps','parse(cs/ps)','ctx','p','entries','canonical(a/b)'],['after borrow drain and exclusive lease','validation return or throw','frame return only','unproved GC / caller retained error'],{rule:'unknown',reason:'schema clones plus parsed graphs, strings and comparison results coexist'});
row('M05','R03','R0','bootstrap context view',['r0-context','r0-cores','r0-clean'],['ctx','buffers registry','constructor frame'],['Buffer.from canonical context','core constructor completion','fill(ctx,0), buffers.splice; failed constructor uses cleanup','view reference ends; pooled backing release not proved'],{rule:'K',reason:'view length only; Buffer.from can pool'},'pooled-view');
row('M06','R03','R1O','context store / custody owner',['r1o-context','r1o-buffer','r1o-bind','r1o-clean'],['store.context','c.buffers[0]'],['producer Buffer.alloc','destination or fatal drain','actual fill then holder removal','after borrow / pending callbacks / frames drain'],{rule:'r1o-context',maximum:8192},'dedicated-view');
row('M07','R04','R0','per-actor builder and expected',['r0-cores','r0-core-alias','r0-clean'],['children[i].builder/expected.arena','buffers registry'],['construct 2F arenas','all n rows and family comparison','core.clear then registered buffer zero','all frames return; physical allocator release not proved'],{rule:'2F*C',reservedCoreFloor:'provider=3, client=4; actual arenas=2F'},'dedicated-view');
row('M08','R04','R1O','canonical core store / custody owner',['r1o-core','r1o-buffer','r1o-clean'],['store.core','c.buffers[1]'],['producer Buffer.alloc','destination or fatal drain','actual fill then holder removal','after borrow / pending callbacks / frames drain'],{rule:'r1o-core',maximum:65536,packedR0Core:false},'dedicated-view');
row('M09','R04','R0','core/token wrappers',['r0-core-table','r0-token-source','r0-token-bind','r0-token-clear'],['R0Core.arena','R0Core.tokens.table','tokens.#source=arena'],['core constructor','last token lookup','tokens.clear removes #source; readonly table/arena retained by wrapper','owner removes children/parser after managed drain'],{rule:'alias',backing:'M07',occupied:'512+K+256*16+76*64=9472+K',note:'embedded context and table are not additional K/4096 backing'},'alias');
row('M10','R05','R0','per-actor candidate family',['r0-family','r0-clean'],['children[i].slab','buffers registry'],['reserve 19F rows','family/transport candidate lifetime','terminal fill','all owner frames return'],{rule:'19F*W',actualProcessing:'F*n, n=2/19 in current corpus; never refund unused rows'},'dedicated-view');
row('M11','R06','R0','exclusive command windows',['r0-windows','r0-token-bind','r0-clean'],['slots[0/1/2]','parser.table=S2','parser.#source=S0/S1/slab'],['window construction','normalize / expected / compare frame return','release(slot) then terminal zero','S2 cannot be reused while a token borrow remains'],{rule:'constant',bytes:24576,slots:3},'dedicated-view');
row('M12','R07','R0','hash chunk',['r0-chunk','r0-sink','r0-clean'],['chunk','sink.chunk','buffers registry'],['construction','last hash or abort','terminal fill','native synchronous borrower ends; backend release still unproved'],{rule:'constant',bytes:4096},'dedicated-view');
row('M13','R07','R0','hash update view wrapper',['r0-view','r0-native-end'],['local view','native update argument'],['flush','nativeUpdate return','view=undefined; viewLive=0','wrapper and native release not implied by counters'],{rule:'alias',backing:'M12',viewMaximum:4096},'alias');
row('M14','R08','R0','binary metadata',['r0-metadata','r0-clean'],['metadata','buffers registry'],['construction','last row / lease bookkeeping','terminal fill and field clear','owner managed drain'],{rule:'constant',bytes:3072},'dedicated-view');
row('M15','R09','R0','owner/children/control objects',['r0-control','r0-cores','r0-clean'],['children','handles','encoded','slotLive','sink/parser wrappers','managed stack'],['constructor / per actor','owner terminal processing','children/slots/handles/parser/sink cleared, other scalar fields retained','owner unreachable and unproved GC'],{rule:'unknown',handleCount:8,childCount:'F<=2',reason:'all headers, containers and closures need charge'});
row('M16','R09','R1O','runtime / call registry / scope shells',['r1o-registry','r1o-fields','r1o-shell','r1o-clean'],['runtime.#calls','Map key handle[0]','Call','source/destination shells','#active / local c'],['createCall and registration','late lookup/stats after drain','only store holders cleared; #calls entries and shells are NOT deleted','runtime/caller becomes unreachable; no close-time byte upper bound'],{rule:'unknown',callsMaximum:8,shellsPerCall:2,reason:'bounded row count is not a JS byte charge'});
row('M17','R09','R1O','call handle registry',['r1o-handles','r1o-shell','r1o-fields'],['handles[0..7]','Map key','claim/window fields','borrow.handle','stamp.certificate'],['createCall','late lookup after drain','handles array is NOT cleared at call drain','runtime/caller unreachable; external copies may remain'],{rule:'unknown',handlesPerCall:8,handlesPerRuntime:64,coreAlias:'existing window; additional handle=0',reason:'object / array / reference charge unproved'});
row('M18','R09','R1O','borrow / lifetime pin / handoff lease',['r1o-borrow','r1o-stop','r1o-exclusive','r1o-stamp','r1o-bind','r1o-clean'],['borrow.store/context/core','Store wrapper','source/destination.store','pin','exclusive','stamp.store','local store'],['borrow or handoff','last borrower / exclusive validation / destination drain','borrow refs removed, source holder moved, pin/exclusive/stamp cleared','same backing retained until all uses finish'],{rule:'alias',backing:['M06','M08'],directBorrowBufferFields:2,note:'not the total reference count'},'alias');
row('M19','R09','R1O','rejected ordinary Promise observer',['r1o-pending','r1o-settle','r1o-clean'],['pending Promise reactions','settled closure -> c and this','Promise returned by captured then'],['callback return','settled callback and late control use','pendingCallbacks--, then managed buffer drain','settlement may never occur; Promise allocator/closure GC unproved'],{rule:'unknown',pendingPerCall:1,reason:'4500 deadline does not force Promise completion or deallocation'});
row('M20','R09','shared','budget / module registry',['r1o-budget','r1o-budget-issue','lb-tickets','lb-release'],['owners WeakSet','descriptor snapshot','Lb0Budget.balance/last','tickets WeakMap','memory ticket and row'],['module / owner / reserve','last caller / ticket access','release changes remaining; it does NOT delete the WeakMap row','weak entries and JS containers depend on unproved GC'],{rule:'unknown',reason:'memory ticket release is not owner/container deallocation'});
row('M21','R10','shared','grammar / key / schema module owner',['r0-grammar','schema'],['R0_CONTEXT','R0_COMMAND','R0_KEYS','module keys Set','module seen Set','Zod schema graph'],['module load before call gate','all calls','no unload API','module lifetime; all resident descriptors need separate charge'],{rule:'unknown',reason:'reachable descriptor counts do not bound headers or schemas'});
row('M22','R10','R0','parser recursive frame / spans',['r0-parser','r0-span','r0-token-source'],['#value spec/parent/tag locals','add closure','key/s span objects','helper stack'],['parse entry','recursive frame return','finally frames-- / clear source','JS stack/frame/span allocation charge unproved'],{rule:'unknown',depthGuard:32,recursionFramesIncludingRoot:33,tokenRecords:512,reason:'frame count is not a byte upper bound'});
row('M23','R11','R0','stream projection / encoder frame',['r0-number','r0-encoder','r0-sink'],['String(n)','literal concatenations','op/request digest strings','field loop locals'],['emit/hash entry','last consumer / frame return','no explicit JS string release','unproved JS allocation and GC'],{rule:'unknown',integerDigits:16,digestHexCharacters:64,reason:'no full command object does not mean zero scratch'});
row('M24','R11','shared','generic canonical / copy frames',['canonical','canonical-late-bound','copy-helper','context-clone'],['active Set','sorted keys','map/join arrays','encoded fragments/output','copy out / schema clones'],['copy/canonical/structuredClone entry','return or error','active.delete only; maxBytes checked after encode','frame return and unproved GC'],{rule:'unknown',nodesGuard:1000000,depthGuard:32,reason:'output-byte limit is not a pre-allocation workspace bound'});
row('M25','R12','module','R0Engine module loader',['r0-native-load'],['temporary native Hash','hashPrototype / update / digest captures'],['import evaluation before call','prototype capture / later native uses','temporary JS reference drops; no native free witness','backend allocation/deallocation upper unknown'],{rule:'unknown',reason:'native allocation occurs before per-call gate'},'native-uncovered');
row('M26','R12','module','R0Memory module loader',['memory-native-load'],['temporary native Hash','captured hashPrototype/update/digest'],['import evaluation before call','prototype capture / later diagnostic hashes','no native free witness','backend allocation/deallocation upper unknown'],{rule:'unknown',reason:'importing only r0DiagnosticSha still evaluates initializer'},'native-uncovered');
row('M27','R12','R0','native sink backend',['r0-sink','r0-view','r0-native-end'],['sink.#hash','OpenSSL state/allocator/stack'],['begin without target','digest/abort / native borrower end','#hash=undefined is not synchronous native deallocation','GC/allocator release unproved'],{rule:'unknown',reason:'4096 chunk and viewLive=0 do not bound native state'},'native-uncovered');
row('M28','R12','shared','diagnostic native hash backend',['diagnostic-hash','r1o-validate','r1o-clean','r0-final'],['local h','native update/final inputs and state'],['inspect / producer pins / validation / cleanup','digest return','no native release receipt','deallocation, allocation/stack/work maxima unknown'],{rule:'unknown',digestHexCharacters:64,reason:'digest success is not a backend certificate'},'native-uncovered');
row('M29','R12','shared','generic hash / module spec digest',['generic-hash','schema','canonical'],['createHash update/digest temporaries','canonical string','module CPR_SPEC_DIGEST'],['module digest or ownedDigest call','digest consumer return','no allocator release witness','module plus per-call native/JS lifetime unknown'],{rule:'unknown',reason:'generic hash is a second native path, not only captured R0Sink'},'native-uncovered');
row('M30','R13','integration','original call / codec / A-B / source owners',['integration','connected-initial','connected-commands','connected-provider','connected-fact-bytes','connected-fact-release','connected-core','connected-dispose','connected-context','connected-context-export','connected-snapshot','connected-memory'],['p.commands / sealed.commands','r.core','facts.q / bytes / child handles','ReadScope.#context / context getter clones','snapshots -> scope / bundle / entries / data / inventory','codec / original source wire copies / session / call / binding / LG'],['original constructor/plan/root/fact/source owners acquire','independent initial/seal, proof, transport final/outcome/use/ACK and drains','connected proof clears f.q; dispose conditionally zeroes fact bytes and clears r.core; source/scope retain original release boundaries','R1-O is not connected; full concurrent integration evidence pending'],{rule:'unknown',codecBudget:393216,sharedFrameCredit:32768,reason:'historical baseline/credit cannot be deducted twice; source anchors are not integration execution'},'baseline-obligation');
row('M31','R13','R1O','diagnostic reservation owner',['r1o-reserve','r1o-clean','lb-release'],['actual Lb0 ticket','c.ticket'],['before producer','destination / borrower / Promise drain','captured release; initialization/work retained','ticket row and budget object charge remain unproved'],{rule:'reservation',bytes:196608,initialization:4096,work:4096,note:'not backing bytes or a whole-parent cost proof'},'reservation');
row('M32','R14','R0','trace owner',['r0-trace','r0-stats','r0-clean'],['#trace event objects / array'],['construction event','late stats after cleanup','trace is NOT cleared by cleanup','owner/caller unreachable'],{rule:'unknown',eventsMaximum:16384,reason:'bounded event count is not a memory charge'});
row('M33','R14','R1O','call trace / retained digests',['r1o-trace','r1o-fields','r1o-stats','r1o-clean'],['c.traces','sourcePin/corePin/entriesPin','boundContextDigest/boundCoreDigest'],['creation / producer pins','late stats after call drain','trace/digests are NOT cleared or removed from #calls','runtime/caller unreachable'],{rule:'unknown',eventsPerCallMaximum:4096,callsMaximum:8,digestCharacters:64,reason:'buffer drain does not clear control/diagnostic state'});
row('M34','R14','shared','stats caller',['r0-stats','r1o-stats'],['returned trace.map objects','children/finalRows copies','budget/stats object'],['each stats call','caller last use','no caller retention/export quota','caller release and unproved GC'],{rule:'unknown',reason:'unbounded repeated exports even if one trace is bounded'});
row('M35','R14','R0','diagnostic rows caller',['r0-export','r0-harness'],['returned Buffer.alloc(n) per command','caller digests/oracle commands'],['each diagnosticRows call','caller last use','owner cleanup does not zero these copies','caller retention has no aggregate call quota'],{rule:'unknown',perExportViewBound:'n*W per actor',reason:'dedicated exports coexist with slab and may accumulate'});
row('M36','R14','R0','terminal diagnostic frame / retained row digests',['r0-final','r0-clean','diagnostic-hash'],['temporary out Buffer','finalRows string arrays','captured families still resident'],['cleanup before buffer zero','sha(out) / future stats','out fill in finally; #finalRows retained','out wrapper/native GC unproved; digest arrays retained with owner'],{rule:'unknown',temporaryViewMaximum:'W',retainedDigestCountMaximum:38,reason:'one out overlaps full family/core/window state'});
row('M37','R14','harness','oracle / replay / JSON persistence owner',['r0-harness','r1o-harness','r1o-review'],['contexts/cores/commands','before/published/drained stats','review waiting/closed/after/late','JSON record and output bytes'],['harness and baseline file load','verification/report last use','outside admitted path; not subtracted from same-process heap','analysis process/caller lifecycle'],{rule:'unknown',reason:'source audit and persisted byte count are not a heap peak'});
row('M38','R15','shared','exception caller / failure frames',['r0-clean','r1o-failure','r1o-clean'],['thrown error / caller retained message graph','active invocation / finally locals'],['failure / callback throw','cleanup frame return and caller last use','no message getter/coercion; foreign graph not owned','unbounded caller exception retention / unproved GC'],{rule:'unknown',reason:'fixed failure reason does not bound the external thrown graph'});
row('M39','R15','R1O','fatal / pending drain coordinator',['r1o-stop','r1o-pending','r1o-settle','r1o-clean'],['borrow/pin/store already in M18','pending settlement closure','ticket already in M31'],['stop/fatal','all borrowers, frames and ordinary Promises end','zero buffers / remove holders / release once','no finite time bound if borrower or Promise never finishes'],{rule:'alias',backing:['M06','M08'],deadlineIsReleaseBound:false},'alias');
row('M40','R15','R0','terminal frame coordinator',['r0-clean','r0-native-end','r0-token-clear'],['managed stack','sink target/hash','parser source','core/table aliases'],['fatal / close','frame return, native borrower end, zero verification','clear parser/cores, zero buffers, remove owner fields','native/container deallocation still unproved'],{rule:'alias',backing:['M07','M10','M11','M12','M14']},'alias');
row('M41','R11','candidate','codec overlay proposal',['r0-parser','canonical','r0-sink','integration'],['descriptor/cursor candidate','hash/stack candidate','existing codec resident/compile/proof'],['load and each codec phase','all concurrent users and borrowed views end','must prove exclusivity before reuse','candidate only, no admitted overlay implementation'],{rule:'candidate',bytes:16384,parts:[8192,8192],reason:'reservation allowance is not actual workspace proof'},'candidate');
row('M42','R09','candidate','bridge representation proposal',['r1o-fields','r1o-handles','r0-control'],['48 reference roles','8 existing handles','all containers/classes/closures'],['all module/call/scope/frame construction','last holder including terminal paths','requires actual layout and independent charge certificate','candidate only; R1-O eight handles do not prove 48-ref fit'],{rule:'candidate',bytes:1024,referenceSlots:48,handleSlots:8,reason:'48*8+8*32+384 arithmetic only'},'candidate');
row('M43','R10','shared','dependency-closure / runtime owner',['schema','canonical','copy-helper','context-clone'],['Zod/JSON/structuredClone internals','Node/V8 allocator and library residency'],['dependency load / helper entry','runtime use and backend release','not exhaustively instrumented by this source catalogue','uncovered transitive heap, allocator and helper stack'],{rule:'unknown',reason:'manual site coverage is not complete allocation coverage'});
row('M44','R09','R1O','runtime / caller callback owner',['r1o-hook-field','r1o-hook-store','r1o-hook-invoke','r1o-clean'],['runtime.#hook','constructor o.hook / default closure','hook.[[Environment]] -> captured graph'],['runtime constructor before createCall','last hook invocation across all calls / external hook use','call drain does NOT clear #hook; no runtime hook-clear API','runtime and all external hook holders unreachable; unproved GC'],{rule:'unknown',hookPerRuntime:1,callDrainClearsHook:false,capturedGraphRow:'M45',reason:'runtime lifetime is longer than one callback stack or call drain'});
row('M45','R01','R1O','caller graph retained by runtime hook',['r1o-hook-store','r1o-hook-invoke','r1o-clean'],['hook.[[Environment]] -> context / core / arbitrary caller graph / Buffer','external callback/capture aliases'],['hook creation / external capture; retained at runtime constructor','last callback or external capture use','call buffer zero / ticket release does NOT release captured graph','runtime and all external hook/capture holders unreachable; unproved GC'],{rule:'unknown',retainedBy:'M44',mayAliasRows:['M01','M02','M30','M37'],aggregateUpperBytes:null,reason:'raw graph registration refusal and eight-call limit do not bound closure captures'},'external-capture');
export function r1mSourceInventory(){const cache=new Map();return sites.map(([id,path,anchor])=>{
 if(!cache.has(path))cache.set(path,readFileSync(path));const bytes=cache.get(path),text=bytes.toString(),occurrences=[];let at=-1;
 while((at=text.indexOf(anchor,at+1))>=0)occurrences.push({offset:at,line:text.slice(0,at).split('\n').length,fragmentDigest:sha(text.slice(at,at+anchor.length))});
 need(occurrences.length>0,'source_anchor_'+id);return {id,path,anchor,sourceDigest:sha(bytes),occurrences};
});}
export function r1mBuildLedger(){
 const sourceInventory=r1mSourceInventory(),ids=new Set(sourceInventory.map(s=>s.id));for(const r of rows)need(r.sourceSites.length&&r.sourceSites.every(s=>ids.has(s)),'source_binding');
 const output={schema:'cwc-r1m.ledger.v1',status:'inventory-only',scope:R1M_SCOPE,regions:Array.from({length:15},(_,i)=>'R'+String(i+1).padStart(2,'0')),sourceInventory,rows};
 return JSON.parse(JSON.stringify(output));
}
export function validateR1mLedger(input){equal(input,r1mBuildLedger());return {regions:15,rows:rows.length,sourceSites:sites.length,representationUpperBytes:null,r1mRuntimeExit:false,productionAdopted:false};}
/** Source-derived buffer-view arithmetic only. No pooled backing, JS/native or concurrent integration upper. */
export function r1mR0Bytes(input){
 data(input);equal(Object.keys(input).sort(),['C','F','K','W','n']);const {F,K,C,W,n}=input,occupied=sum([9472,K]);
 need([F,K,C,W,n].every(int)&&[1,2].includes(F)&&n>=1&&n<=19&&W>0&&W<=8192&&K>0&&C>=occupied,'dimensions');
 const cores=sum(Array(2*F).fill(C)),families=sum(Array(19*F).fill(W)),windows=24576,chunk=4096,metadata=3072;
 return {cores,families,windows,chunk,metadata,dedicatedRegisteredViewBytes:sum([cores,families,windows,chunk,metadata]),bootstrapViewBytes:K,
 reservedRows:19*F,processedRows:n*F,actualCoreArenas:2*F,requiredCoreFloor:F===1?3:4,packedOccupiedBytes:occupied,
 bootstrapPooledBackingUpperBytes:null,representationUpperBytes:null,physicalHeapUpperBytes:null,runtimeAdmitted:false};
}
/** Inclusive intervals only. Exact amounts require equal endpoints; an upper bound contributes nothing to a lower. */
export function r1mConditionalBound(profile,base,additional){
 data(base);data(additional);need(['R0-provider','R0-client','R1O-call','integration'].includes(profile),'profile_quantity');
 const bound=x=>{need(x&&Object.getPrototypeOf(x)===Object.prototype,'bound_schema');equal(Object.keys(x).sort(),['lowerBytes','upperBytes']);
  need(int(x.lowerBytes)&&(x.upperBytes===null||int(x.upperBytes)&&x.upperBytes>=x.lowerBytes),'bound_quantity');return {lowerBytes:x.lowerBytes,upperBytes:x.upperBytes};};
 const b=bound(base);need(additional&&Object.getPrototypeOf(additional)===Object.prototype,'schema');const names=['bootstrap','bridge','canonical','native','diagnostics','dependencies'].sort();equal(Object.keys(additional).sort(),names);
 const a=Object.fromEntries(names.map(k=>[k,bound(additional[k])])),all=[['base',b],...Object.entries(a)],unknown=all.filter(([,v])=>v.upperBytes===null).map(([k])=>k).sort();
 const lower=sum(all.map(([,v])=>v.lowerBytes)),upper=unknown.length?null:sum(all.map(([,v])=>v.upperBytes));
 return {schema:'cwc-r1m.conditional-bound.v2',profile,base:b,additional:a,limit:1048576,lowerBound:lower,upperBound:upper,unknown,
  status:lower>1048576?'rejected-known-lower-bound':upper===null?'unsupported-uncovered':upper>1048576?'conditional-upper-bound-exceeds-limit':'conditional-arithmetic-only',
  arithmeticFits:lower>1048576?false:upper===null?null:upper<=1048576,runtimeAdmitted:false,actualParentLedgerVector:false};
}
export function r1mArithmeticExamples(){
 const names=['bootstrap','bridge','canonical','native','diagnostics','dependencies'],bounds=(lowerBytes,upperBytes=lowerBytes)=>({lowerBytes,upperBytes}),u=()=>Object.fromEntries(names.map(k=>[k,bounds(0,null)])),z=()=>Object.fromEntries(names.map(k=>[k,bounds(0)]));
 const viewUpper=sum(['M06','M08'].map(id=>rows.find(r=>r.id===id).quantity.maximum));
 return {baseGuard:{basis:'dedicated-view source guard upper only; not a lower or a whole-heap bound',sourceSites:['r1o-context','r1o-core'],bounds:bounds(0,viewUpper)},
  unknown:r1mConditionalBound('R1O-call',bounds(0,viewUpper),u()),conditional:r1mConditionalBound('integration',bounds(1048576),z()),
  upperOnly:r1mConditionalBound('integration',bounds(1048576),{...u(),native:bounds(0,1)}),
  upperExceeds:r1mConditionalBound('integration',bounds(1048576),{...z(),native:bounds(0,1)}),
  overflow:r1mConditionalBound('integration',bounds(1048576),{...u(),native:bounds(1)})};
}
export function validateR1mArithmetic(input){equal(input,r1mArithmeticExamples());return {examples:5,upperOnlyKnownLowerIncrease:0,runtimeAdmitted:false};}
export function verifyR1mSourceInventory(input){equal(input,r1mSourceInventory());}
export function validateR1mObservation(o){
 data(o);const keys=(x,expected)=>equal(Object.keys(x).sort(),expected.split(' ').sort());
 keys(o,'schema r0 r1o pending hookRetention grammar bufferProbe scope');need(o.schema==='cwc-r1m.observation.v1'&&o.r0.length===24&&o.r1o.length===36&&o.pending.length===12&&o.hookRetention.length===3,'observation_matrix');
 const old0=JSON.parse(readFileSync('docs/validation/gradle-cwc-r0-2026-11-12.json')).evidence.rows;
 const old1=JSON.parse(readFileSync('docs/validation/gradle-cwc-r1o-2026-11-13.json'));
 for(const [i,r]of o.r0.entries()){
  const b=old0[i],s=b.before,z=b.after,formula=r1mR0Bytes({F:b.kind==='client'?2:1,K:s.contextWidth,C:s.coreWidth,W:s.width,n:b.n});
  equal(r,{role:b.role,boundary:b.boundary,workload:b.workload,kind:b.kind,n:b.n,formula,registeredBuffers:s.liveBuffers,zeroedDedicatedViewBytes:z.clearedBytes,
   zeroVerified:z.zeroVerified,managedBuffersAfterDrain:z.liveBuffers,logicalHeldBytes:s.budget.heldBytes,traceRowsBeforeDrain:s.trace.length,traceRowsAfterDrain:z.trace.length,
   retainedFinalDigestCount:z.finalRows.reduce((n,rs)=>n+rs.length,0),physicalHeapUpperBytes:null});
  need(formula.dedicatedRegisteredViewBytes===z.clearedBytes&&s.liveBuffers===5+3*(b.kind==='client'?2:1)&&z.liveBuffers===0&&r.traceRowsAfterDrain>0,'r0_bytes');
 }
 for(const [i,r]of o.r1o.entries()){
  const b=old1.evidence.successes[i],p=b.published,z=b.drained;
  keys(r,'role boundary workload actor contextViewBytes coreViewBytes contextDigest coreDigest splitEvidence allocatedViewBytes zeroedViewBytes actualBufferAllocations sameStore sameMemoryLease directBorrowBufferFields borrowUsesPinnedStore sourceHolderRemoved managedBuffersAfterDrain heldAfterDrain traceRowsAfterDrain handlesReportedAfterDrain boundDigestsRetained runtimeRegistryDeletionProved physicalHeapUpperBytes');
  need(int(r.contextViewBytes)&&r.contextViewBytes>0&&r.contextViewBytes<=8192&&int(r.coreViewBytes)&&r.coreViewBytes>0&&r.coreViewBytes<=65536&&sum([r.contextViewBytes,r.coreViewBytes])===p.allocatedBytes,'r1o_split');
  equal(r,{role:b.role,boundary:b.boundary,workload:b.workload,actor:b.actor,contextViewBytes:r.contextViewBytes,coreViewBytes:r.coreViewBytes,
   contextDigest:b.before.context,coreDigest:b.before.core,splitEvidence:'independent recipe/digests plus actual aggregate buffer counters',allocatedViewBytes:p.allocatedBytes,
   zeroedViewBytes:z.zeroedBytes,actualBufferAllocations:p.bufferAllocations,sameStore:p.sameStore,sameMemoryLease:p.sameLease,directBorrowBufferFields:b.waiting.borrowReferences,
   borrowUsesPinnedStore:b.waiting.borrowUsesPinnedStore,sourceHolderRemoved:p.sourceRemoved,managedBuffersAfterDrain:z.privateBuffers,heldAfterDrain:z.budget.heldBytes,
   traceRowsAfterDrain:z.trace.length,handlesReportedAfterDrain:z.handleCapacity,boundDigestsRetained:z.contextDigest!==null&&z.coreDigest!==null,
   runtimeRegistryDeletionProved:false,physicalHeapUpperBytes:null});
 }
 equal(o.pending,old1.review.asyncCallbacks.map(r=>({actor:r.actor,site:r.site,outcome:r.outcome,pending:r.waiting.pendingCallbacks,pendingBuffers:r.waiting.privateBuffers,
  pendingMemoryBytes:r.waiting.budget.heldBytes,pendingZeroBytes:r.waiting.zeroedBytes,closePendingMemoryBytes:r.closed.budget.heldBytes,afterPending:r.after.pendingCallbacks,
  afterBuffers:r.after.privateBuffers,afterMemoryBytes:r.after.budget.heldBytes,afterZeroBytes:r.after.zeroedBytes,initialization:r.after.budget.initialization,work:r.after.budget.work,
  publications:r.after.publications,forcedReleaseTimeUpperMs:null})));
 for(const [i,r]of o.hookRetention.entries()){
  keys(r,'actor firstDrain secondDrain firstCalls totalCalls callsAfterFirstDrain firstObservation secondObservation distinctCalls capturePath captureReleasedAtCallDrain captureUpperBytes physicalHeapUpperBytes scope');
  const actor=['provider','client-initial','client-seal'][i],sample=old1.evidence.successes.find(x=>x.role==='reader'&&x.boundary==='normal'&&x.workload==='small'&&x.actor===actor),zeroed=sample.drained.zeroedBytes;
  const drain={privateBuffers:0,heldBytes:0,zeroedBytes:zeroed,publications:1,released:true},observation={observedViewBytes:2097152,byte:7,contextMarker:'captured-context',coreMarker:'captured-core'};
  equal(r,{actor,firstDrain:drain,secondDrain:drain,firstCalls:5,totalCalls:10,callsAfterFirstDrain:5,firstObservation:observation,secondObservation:observation,distinctCalls:true,
   capturePath:'runtime.#hook -> [[Environment]] -> captured.context/core/payload',captureReleasedAtCallDrain:false,captureUpperBytes:null,physicalHeapUpperBytes:null,
   scope:{reachabilityWitness:true,rawGraphExported:false,gcMeasured:false,captureLayoutApproved:false,runtimeAdmitted:false}});
 }
 keys(o.grammar,'reachableDescriptors fieldTuples keyNames representationUpperBytes');for(const k of ['reachableDescriptors','fieldTuples','keyNames'])need(int(o.grammar[k])&&o.grammar[k]>0,'grammar_count');need(o.grammar.representationUpperBytes===null,'grammar_charge');
 keys(o.bufferProbe,'viewBytes pooledBackingBytes poolSize dedicatedViewBytes dedicatedBackingBytes allocatorExtentUpperProved probeOnly');
 need(o.bufferProbe.viewBytes===1&&o.bufferProbe.pooledBackingBytes>=1&&int(o.bufferProbe.pooledBackingBytes)&&int(o.bufferProbe.poolSize)&&o.bufferProbe.dedicatedViewBytes===1&&o.bufferProbe.dedicatedBackingBytes===1&&o.bufferProbe.allocatorExtentUpperProved===false&&o.bufferProbe.probeOnly===true,'buffer_probe');
 equal(o.scope,{finiteOnly:true,sameProcess:true,fixedClock:true,heapMeasured:false,nativeDeallocationObserved:false,fullReferenceGraphObserved:false,workUnitsProved:false,actualSession:false,productionAdopted:false});
 return {r0Rows:o.r0.length,r1oRows:o.r1o.length,pendingRows:o.pending.length,hookRetentionRows:o.hookRetention.length,wholeMemoryUpperBytes:null,nativeBackendApproved:false,r1mRuntimeExit:false,productionAdopted:false};
}
export function compareR1mObservation(saved,fresh){validateR1mObservation(saved);validateR1mObservation(fresh);equal(saved,fresh);}
