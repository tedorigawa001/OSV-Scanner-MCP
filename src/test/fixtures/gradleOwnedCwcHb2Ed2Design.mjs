/** ED-2 acquisition plan only. No native kernel, proof checker, approval registry, allocator or permit. */
import {HB2E_REGIONS} from './gradleOwnedCwcHb2EvidenceDesign.mjs';
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
export const ED2_PLAN=freeze({
 schema:'cwc.hb2.ed2-acquisition-plan.v1',status:'design-only',baselineCommit:'ec9348a',previousCommit:'53e82db',
 scope:{kernelImplemented:false,modelCheckerExecuted:false,independentProofObtained:false,compiledObjectRefined:false,methodApproved:false,unitMapApproved:false,actualParentReserved:false,lifetimeProved:false,wholeRegionCovered:false,logicalUpper:null,physicalUpper:null,originalWorkUpper:null,credit:0,runtimeAdmitted:false,productionAdopted:false},
 methods:{primary:'bounded-recipe-native-kernel',modelCandidate:'CBMC with complete bounded harness and unwinding assertions',compilerCandidate:'pinned Clang C17 build with object/link closure and translation evidence',engineProof:'no-approved-provider-supplied',capacityDomain:'physical-policy-supplement-only',measurements:'diagnostics-not-worst-case-proof',toolInstallAuthorizedByPlan:false},
 targets:[
 {region:'HB06',part:'payload-addressable-storage',kind:'partial-new-recipe',payloadBuffers:2,payloadBytesEach:3072,payloadBytes:6144,storageUnit:'native-arena-byte.v1',headerAndPadding:'sizeof-and-alignment-require-independent-layout-proof',backingAllocatedBytes:null,wrappers:'not-covered',originalLogicalMapping:false,physicalAllocationMapping:false},
 {region:'HB12',part:'kernel-operation-semantic-steps',kind:'partial-new-recipe',unit:'bounded-kernel-step.v1',definition:'each visited instruction in the pinned verifier GOTO model costs one step, including rejected paths',upper:null,originalWorkMapping:false,cpuTimeMapping:false,totalEntryCoverage:false}
 ],
 regionDisposition:HB2E_REGIONS.map(r=>({id:r.id,status:r.id==='HB06'||r.id==='HB12'?'partial-target-not-covered':'deferred-required-dependency',requiredBundles:[...r.required],wholeRegionCovered:false,upper:null})),
 kernel:{language:'restricted-C17',state:'fresh privately owned fixed-size arena plus fully charged explicit header; exact size pending',input:'bounded integer opcode/index/value; no public raw pointer or arbitrary object',operations:['initialize','write-byte','read-byte-for-test-only','compare-byte','seal','retire','zero-with-debt-retained'],constraints:['CHAR_BIT-8-and-fixed-width-integer-assertions','complete-source-and-include-closure','no-heap-allocation-no-VLA-no-recursion','no-user-callback-no-async-no-IO','no-dynamic-loader-no-unmodelled-external-call','checked-length-index-generation-and-overflow','all-header-padding-error-and-temporary-cost-explicit'],export:'internal-only; no reader controller/raw-storage export',newPublicHandle:false,coreHandleIdentity:'existing-window-alias-required',attempts:2,attemptReuseGivesCredit:false,originalGatesMayBeRemoved:false},
 proof:{
 subject:['recipeSource','sourceIncludes','harnessSource','specification','costModel','verifierImage','verifierOptions','solverImage','allProofObligations','compilerImage','compilerOptions','targetABI','objectCode','linkClosure','runtimeImage','runtimeFlags','loaderWitness','nativeDependencies','allocator','profile','layout','deployment','scopeAndGeneration'],
 modelObligations:['all-input-byte-values-and-invalid-indices','all-reachable-success-and-reject-transitions','full-loop-unwinding-and-unwinding-assertions','overflow-pointer-bounds-and-undefined-behavior','no-assumed-away-callback-or-allocation','all-charged-operation-paths'],
 costModel:{id:'bounded-kernel-step.v1',basis:'pinned frontend GOTO instruction identity and source-location map',weights:'one per visited GOTO program instruction; embedded expression evaluation is a separate required cost obligation',unknownInstruction:'unsupported',expressionCostMapping:null,unmappedExpressionIsFree:false,counterOverflow:'reject',nativeCpuOrStackClaim:false,originalMapping:null},
 buildObligations:['model-to-actual-object-refinement','complete-compiled-and-linked-call-closure','headers-alignment-temporaries-and-code-residency-explicit','no-late-toolchain-or-runtime-substitution'],
 approval:['independent-method-and-subject-approval','independent-writer-key-and-store','verifiable-obligations-not-a-success-flag','current-registry-revision-and-validity','separate-original-unit-map'],
 certificate:'partial-claim bundle; never fills a full region packet or all-parent gate',modelPassIsObjectProof:false,sizeofIsWholeCharge:false,signatureIsSemanticTruth:false,regexNoMallocIsProof:false,
 A:'template-and-method-proof-with-parent-requirements-only',B:'actual-reservation-vector-binds-A-before-allocation',C:'allocator-lifetime-witness-binds-A-and-B-later',proofCreationBootstrapsItsOwnBudget:false
 },
 minimum:{
 phases:[
 {id:'E2-P0',task:'independently provision verifier/compiler/solver, method policy and bounded verification workspace',exit:'missing tool or approval remains unsupported; do not install or assume approval'},
 {id:'E2-P1',task:'implement fixed arena kernel, bounded harness, explicit header/layout and semantic step model',exit:'no native public adapter; enumerate all allocations/temporaries and reject undefined or unbounded constructs'},
 {id:'E2-P2',task:'complete bounded model proofs including rejecting paths and mutation controls',exit:'unknown timeout incomplete unwind unsupported model or surviving mutant rejects candidate'},
 {id:'E2-P3',task:'bind source/model to actual object/link/loader image and verify logical/work mapping separately',exit:'model-only or compiler-only success is not deployable evidence'},
 {id:'E2-P4',task:'compare original oracle and both modes with original live gates, then issue partial acquisition report',exit:'no full HB06/HB12 or HB-2 exit until dependencies and ED-3/4 complete'}
 ],
 boundaryValues:[0,1,3071,3072,3073,6143,6144,6145],modelMaximum:'two 3072-byte spans; complete reachable protocol including both attempts, not a one-byte surrogate',runtimeModes:['full-input','owned-input'],roles:['provider','client'],attempts:2,
 nativeCases:['empty-and-full','max-and-over-index','negative-and-overflow','alias-and-double-count','stale-generation','write-after-seal','early-retire','partial-initialize-failure','zero-failure','retry-keeps-debt','caught-reentry','late-after-close'],
 assertions:['original-byte-content-and-rejection-equivalence','independent-expected-comparison-preserved','every-original-live-site-preserved','private-references-not-escaped','debt-not-refunded','missing-parent-proof-refuses-copy-and-IO'],
 runtimeStatus:'planned',fullConditionsStatus:'planned-not-executed'
 },
 rejection:{
 unsupported:['proof-tool-unavailable','independent-method-unapproved','native-layout-or-runtime-proof-unavailable','original-unit-map-unavailable','uncovered-wrapper-native-caller-or-bootstrap','model-to-object-proof-unavailable','lifetime-or-parent-unavailable'],
 invalid:['subject-or-source-mismatch','schema-or-ref-closure-invalid','proof-counterexample-or-unproved-obligation','partial-or-missing-unwinding','unexpected-allocation-or-import','overflow-or-alias-violation','gate-or-deadline-regression','budget-exceeded'],
 inconclusiveIsSuccess:false,timeoutShrinksMaximum:false,sanitizerPassIsProof:false,observationMaxIsBound:false,partialProofAllowsUse:false,workRefundOnFailure:false,threeSlotExit:false
 },
 budget:{originalMemory:1048576,verificationWork:156978,providerUnit:'cpr.request-bytes-ranges-probes.v1',providerLimit:1048576,globalLimit:67108864,globalUnit:null,extraMemoryAllowed:false,extraWorkAllowed:false,baselineRemoved:false,clientCores:4,windowBodies:2,opaqueIdentities:16,allParentsBound:false,typedIntermediateUnitIsOriginal:false,collectorWorkspaceFree:false,unknownsStayNull:true},
 next:'only E2-P0/P1 feasibility preparation; ED-2 as a whole, ED-3 and ED-4 remain unfulfilled'
});
export const ED2_CONDITIONS=freeze([
 ['E2C01','HB-1→HB-2a→evidence-design→ED-1のsource／baseline hashを独立再計算し、1 byte変更を拒否'],
 ['E2C02','旧未コミット7 pathの現状態とreview commitを照合し、未解決差分を解決済みとしない'],
 ['E2C03','attempt0のwindow／publishは添字参照前に拒否し、負添字getter到達0を両modeで維持'],
 ['E2C04','ED-1 command・summaryの全schema／baseline由来件数・probe／tool閉包をhash更新後も照合し、権限domain差を別domain成功で隠蔽しない'],
 ['E2C05','HB06 payload部分・HB12 kernel部分だけを対象とし、wrapper等と全18領域を被覆済みにしない'],
 ['E2C06','6144 payload・sizeof・alignment観測をoriginal logical／physical upperへ直接変換しない'],
 ['E2C07','kernel header・padding・partial初期化・compiler temporaryの未計上を拒否'],
 ['E2C08','cbmc等の未導入・method未承認・verifier workspace不足は実行前unsupported'],
 ['E2C09','source／include／harness／spec／cost model／tool imageの交換を再署名後も拒否'],
 ['E2C10','実target ABI・compiler options・object／link／loaderの不一致を拒否'],
 ['E2C11','完全loop上限の不足・unwinding assertion欠落・assumeで経路を除外したproofを拒否'],
 ['E2C12','counterexample・solver unknown／timeout／部分出力は成功にせず、最大入力を下げて救済しない'],
 ['E2C13','全input byte値・無効index・整数overflow・pointer／UB義務欠落を拒否'],
 ['E2C14','追加malloc／VLA／recursion／external call・callback／IOの未モデル化を拒否'],
 ['E2C15','bounds guard削除・zero欠落・state／generation検査除去mutantが生存すれば候補を棄却'],
 ['E2C16','C model passだけで実object／native stack／resident上界を成立させない'],
 ['E2C17','独立issuer／method／subject／registryの承認欠落をproducer署名・別UIDだけで補わない'],
 ['E2C18','native-arena-byte／bounded-kernel-stepから元unit／実parentへの未承認mappingを拒否'],
 ['E2C19','成功・拒否・cleanup／retry・guard前後の処理を元workへ完全対応し、EやCPU時間で代替しない'],
 ['E2C20','元1 MiB／work・client4 core・2 body／16 identity・両attemptの重なりを保持'],
 ['E2C21','新CoreHandle追加・scope／actor／generation流用・同一resourceの重複加算を拒否'],
 ['E2C22','source停止・既存borrow終了・完全検証からbindまでの更新／zero／捕捉callbackを拒否'],
 ['E2C23','両mode・両roleで元oracleの内容・独立expected・拒否意味を照合し、live site削減を拒否'],
 ['E2C24','認可・purpose・pin／revision・取消し・元期限・残予算の変更を公開直前まで検出'],
 ['E2C25','seal後write・早期retire・後着・内側捕捉済み再入でも公開0を維持'],
 ['E2C26','partial構築／zero／検証失敗と再試行後もdebt／workを返さない'],
 ['E2C27','zero／ACK／GC／logical closeをallocator release／reuse receiptへ置換しない'],
 ['E2C28','template A→事前予約B→実体witness→後続lifetime Cの順序と循環ref拒否を維持'],
 ['E2C29','proofファイルのparse／hash／signature・loader費用を生成前に予約できなければ拒否'],
 ['E2C30','容量domain・sanitizer・finite native実測をrepresentation／全operation証明へ昇格しない'],
 ['E2C31','部分証明が正規でも全8 bundle／全親／依存領域不足ならcopy／IO許可0'],
 ['E2C32','最大条件・依存領域・ED-3／4未完了でHB-2出口・3 slot・本番採用を成立させない']
].map(([id,condition])=>({id,condition,status:'planned',executed:false})));
