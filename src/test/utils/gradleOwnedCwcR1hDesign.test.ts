/** Design consistency, not RHC runtime execution or admission evidence. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {R1H_DESIGN,R1H_OWNERS,R1H_REF_ROLES,R1H_SOURCE_ACTIONS,R1H_SUMMARY_LAYOUT,r1hCounts,r1hBatchArithmetic,r1hUpperExample} from '../fixtures/gradleOwnedCwcR1hDesign.mjs';
const record=JSON.parse(readFileSync(process.env.CWC_R1H_DESIGN_RECORD_PATH??'docs/validation/gradle-cwc-r1h-design-2026-11-13.json','utf8'));
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
const section=designSection(readFileSync(record.document.path,'utf8'),record.document.heading);
const condition=(id:string)=>record.conditions.find((c:any)=>c.id===id).condition;
const count=(kind='client',actualAttempts=2,exportMode='none',readOwners=4)=>r1hCounts({readOwners,kind,actualAttempts,exportMode});
const unknown=()=>({referenceUpper:null,handleUpper:null,windowContainerUpper:null,retirementContainerUpper:null,summaryWrapperUpper:null,moduleShareUpper:null,frameUpper:null,exportMode:'summary-v1'});
const finite=()=>({...unknown(),referenceUpper:8,handleUpper:32,windowContainerUpper:384,retirementContainerUpper:128,summaryWrapperUpper:128,moduleShareUpper:128,frameUpper:128});
it('R1HD01: binds unchanged baseline, source closure and the new document section',()=>{
 expect(sha(section)).toBe(record.document.sha256);expect(sha(readFileSync(record.baseline.path))).toBe(record.baseline.sha256);
 for(const [p,h]of Object.entries(record.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 expect(record.contract).toEqual(R1H_DESIGN);expect(record.owners).toEqual(R1H_OWNERS);
});
it('R1HD02: distinguishes forty-eight planned runtime conditions from twenty-eight static checks',()=>{
 expect(record.conditions.map((c:any)=>c.id)).toEqual(Array.from({length:48},(_,i)=>'RHC'+String(i+1).padStart(2,'0')));
 for(const c of record.conditions){expect(c.executed).toBe(false);expect(c.status).toBe('planned');expect(section).toContain('| '+c.id+' | '+c.condition+' |');}
 expect(record.designChecksPassed).toBe(28);expect(record.runtimeRegressionsExecuted).toBe(false);
});
it('R1HD03: rejects arbitrary closure admission without claiming environment inspection',()=>{
 expect(R1H_DESIGN.admission.arbitraryHook).toBe(false);expect(R1H_DESIGN.admission.callerClosureProof).toBe(false);
 for(const t of ['hook` fieldはundefined','関数の捕捉環境を証明できない','getter・文字列変換・callback・thenへ触れる前','M45のcaller→closure→graph','既存gate／now callback'])expect(section).toContain(t);
 expect(condition('RHC43')).toContain('hook edge除去');
});
it('R1HD04: keeps every mandatory live and transport obligation',()=>{
 expect(R1H_DESIGN.live).toEqual(['authorization','purpose','pin','cancellation','originalDeadline','remainingBudget','content','independentPlan','transportFinal','outcome/use/ACK']);
 expect(condition('RHC04')).toContain('全live site');expect(condition('RHC26')).toContain('fenceと公開');expect(R1H_DESIGN.diagnostics.betweenFenceAndPublication).toBe(false);
});
it('R1HD05: assigns seven owners with explicit capacity, end and charge obligations',()=>{
 expect(R1H_OWNERS.map(x=>x.id)).toEqual(['G','R','W','T','D','C','F']);for(const x of R1H_OWNERS){expect(x.cap.length).toBeGreaterThan(10);expect(x.end.length).toBeGreaterThan(10);expect(x.charge.length).toBeGreaterThan(10);expect(section).toContain('| '+x.id+' ');}
 expect(section).toContain('activeな権限lookup');expect(section).toContain('cleanup用のretiring容量行');
});
it('R1HD06: fixes deployment capacity without overflow rows or hidden weak histories',()=>{
 for(const R of [1,4])expect(count('client',1,'none',R).readOwners).toBe(R);
 for(const R of [0,5,-1,NaN,1.5])expect(()=>count('client',1,'none',R)).toThrow();
 for(const t of ['Map／WeakMapへの無限履歴追加を禁止','FinalizationRegistry','overflow table'])expect(section).toContain(t);
});
it('R1HD07: separates eight live identities from sixteen per-read lifetime identities',()=>{
 const a=count('client',1),b=count();expect(a.activeOpaquePerAttempt).toBe(8);expect(a.reservedOpaquePerRead).toBe(16);expect(a.issuedOpaque).toBe(8);expect(b.issuedOpaque).toBe(16);expect(a.reservedAttempts).toBe(2);
 expect(section).toContain('24として二重計上せず');expect(R1H_DESIGN.reservation.reuseRetiredIdentity).toBe(false);
});
it('R1HD08: keeps CoreHandle alias and every fixed reference role',()=>{
 expect(R1H_REF_ROLES).toHaveLength(48);expect(new Set(R1H_REF_ROLES).size).toBe(48);expect(record.referenceRoles).toEqual(R1H_REF_ROLES);
 expect(R1H_REF_ROLES.slice(27,31)).toEqual(['first builder core','first A expected core','seal builder core','seal A expected core']);
 expect(condition('RHC10')).toContain('同一実体');expect(section).toContain('table外の全辺');
});
it('R1HD09: reserves original root-fact receipt issuance independently of private handles',()=>{
 const c=count(),p=count('provider');expect([c.reservedFactsPerRead,c.reservedLengthReceiptsPerRead,c.reservedRootsPerRead]).toEqual([76,76,4]);
 expect([p.reservedFactsPerRead,p.reservedLengthReceiptsPerRead,p.reservedRootsPerRead]).toEqual([38,38,2]);expect(count('client',1).reservedFactsPerRead).toBe(76);expect(section).toContain('元8192 B内に収まる証明ではない');
});
it('R1HD10: binds nineteen original inventory rows to explicit future actions',()=>{
 expect(record.sourceActions).toEqual(R1H_SOURCE_ACTIONS);expect(record.originalRows.map((x:any)=>x.id)).toEqual(R1H_SOURCE_ACTIONS.map(x=>x.id));
 const b=JSON.parse(readFileSync(record.baseline.path,'utf8'));for(const x of record.originalRows)expect(x).toEqual(b.ledger.rows.find((r:any)=>r.id===x.id));
 expect(record.originalRows).toHaveLength(19);for(const x of R1H_SOURCE_ACTIONS){expect(x.runtimeImplemented).toBe(false);expect(x.approvedChargeRef).toBeNull();}
});
it('R1HD11: treats the old 1024 bridge as a proposal rather than a representation proof',()=>{
 const l=R1H_DESIGN.layout;expect(l.binary+l.bridgeCandidate).toBe(4096);expect(48*l.referenceCandidate+8*l.handleCandidate+l.containerCandidate).toBe(1024);
 expect(l.retirementIncludedInOldBridge).toBe(false);expect(section).toContain('実pointer幅やV8 objectサイズを表さない');expect(section).toContain('container384');
});
it('R1HD12: leaves unknown upper bounds unknown and never derives a positive known lower',()=>{
 const x=r1hUpperExample(unknown());expect(x.windowMetadataUpper).toBeNull();expect(x.additionalBeyondOldMetadataUpper).toBeNull();expect(x.knownLowerBytes).toBe(0);expect(x.readBudgetFits).toBeNull();
 expect(record.arithmetic.unknown).toEqual(x);expect(section).toContain('upper-only値は既知lowerへ足さない');
});
it('R1HD13: keeps retirement export module and frame costs outside old metadata',()=>{
 const x=r1hUpperExample(finite());expect(x.windowMetadataUpper).toBe(4096);expect(x.windowCandidateFits).toBe(true);expect(x.retirementExtraUpper).toBe(128);expect(x.summaryPayloadUpper).toBe(512);expect(x.additionalBeyondOldMetadataUpper).toBe(5120);expect(x.chargeVerified).toBe(false);expect(x.readBudgetFits).toBeNull();expect(record.arithmetic.hypotheticalFinite).toEqual(x);
});
it('R1HD14: does not credit metadata underspend or an old shared frame twice',()=>{
 const x=r1hUpperExample({...finite(),referenceUpper:0,handleUpper:0,windowContainerUpper:0,exportMode:'none'});expect(x.windowMetadataUpper).toBe(3072);expect(x.reservedWindowsUpper).toBe(6144);expect(x.additionalBeyondOldMetadataUpper).toBe(2432);expect(x.summaryPayloadUpper).toBe(0);expect(R1H_DESIGN.layout.extra32768Credit).toBe(false);
 const y=r1hUpperExample({...unknown(),referenceUpper:8,handleUpper:32,windowContainerUpper:384,exportMode:'none'});expect(y.windowCandidateFits).toBe(true);expect(y.additionalBeyondOldMetadataUpper).toBeNull();
});
it('R1HD15: rejects malformed design quantities, surplus flags and overflowing arithmetic',()=>{
 for(const n of [-1,-0,NaN,Infinity,0.5,'8'])expect(()=>r1hUpperExample({...finite(),handleUpper:n})).toThrow();expect(()=>r1hUpperExample({...finite(),handleUpper:Number.MAX_SAFE_INTEGER})).toThrow();
 expect(()=>r1hUpperExample({...finite(),approved:true})).toThrow();expect(()=>r1hUpperExample({})).toThrow();expect(()=>count('other')).toThrow();expect(()=>count('client',3)).toThrow();expect(()=>count('client',1,'raw')).toThrow();
});
it('R1HD16: rejects accessor, proxy and inherited design inputs without evaluating getters',()=>{
 let reads=0;const v=finite();Object.defineProperty(v,'handleUpper',{get(){reads++;throw Error('getter');},enumerable:true});expect(()=>r1hUpperExample(v)).toThrow();expect(reads).toBe(0);
 expect(()=>r1hUpperExample(new Proxy(finite(),{get(){reads++;throw Error('proxy');}}))).toThrow();expect(reads).toBe(0);expect(()=>r1hUpperExample(Object.create(finite()))).toThrow();
});
it('R1HD17: specifies helper boundaries and retains all-parent prepayment before IO',()=>{
 expect(R1H_DESIGN.helpers).toHaveLength(8);for(const h of R1H_DESIGN.helpers)expect(section).toContain('| '+h+' |');
 expect(R1H_DESIGN.reservation.allParentsBeforeCopyIO).toBe(true);expect(condition('RHC22')).toContain('construction／copy／IOを0');expect(section).toContain('preflight自体の有界bootstrap');
});
it('R1HD18: separates normal local close from fatal read-wide invalidation',()=>{
 for(const t of ['正常scope終了はそのWだけ','fatal・取消し・期限はcall／read全体','失効→実drain→zero／参照除去→一度だけ解放','cleanup失敗はquarantine'])expect(section).toContain(t);
 expect(R1H_DESIGN.reservation.gcIsReleaseWitness).toBe(false);expect(R1H_DESIGN.reservation.ackIsReleaseWitness).toBe(false);
});
it('R1HD19: keeps retry debits and finite occupancy without inventing a drain deadline',()=>{
 const r=R1H_DESIGN.reservation;expect(r.retryKeepsKandD).toBe(true);expect(r.retryKeepsDeadline).toBe(true);for(const k of ['refundSpentWork','refundSpentInitialization','refundSpentWire','refundSpentAttempt'])expect(r[k]).toBe(false);
 for(const t of ['最大1','drainが来なければ有限slotとdebitを保持','容量の有界性と有限時間での回収可能性を区別'])expect(section).toContain(t);
});
it('R1HD20: fixes a contiguous 256-byte terminal summary without making authority evidence',()=>{
 let end=0;for(const f of R1H_SUMMARY_LAYOUT){expect(f.offset).toBe(end);end+=f.bytes;}expect(end).toBe(256);expect(record.summaryLayout).toEqual(R1H_SUMMARY_LAYOUT);
 expect(count('client',1,'summary-v1').summaryPayloadReserve).toBe(512);expect(count().summaryPayloadReserve).toBe(0);expect(R1H_DESIGN.diagnostics.authorityEvidence).toBe(false);expect(section).toContain('全てsafe integer範囲');
});
it('R1HD21: separates core and summary exports and charges recipient copies',()=>{
 const d=R1H_DESIGN.diagnostics;expect(d.coreExports).toBe(false);expect(d.rawObjects).toBe(false);expect(d.extraWrapperChargeRequired).toBe(true);expect(d.ackReleasesConsumerCopy).toBe(false);
 for(const t of ['全export debtがなくなるまでRとGの容量を返さない','senderとreceiver','借用中recordの上書き不可','同じordinal'])expect(section).toContain(t);
});
it('R1HD22: does not let diagnostics create a callback hash or failure authority',()=>{
 const d=R1H_DESIGN.diagnostics;expect(d.newCanonicalOrHash).toBe(false);expect(d.errorStringConversion).toBe(false);expect(d.betweenFenceAndPublication).toBe(false);
 for(const t of ['authoritative readの成功／拒否判定を変えない','限定diagnostic purpose','同じprocessで同居する量'])expect(section).toContain(t);expect(condition('RHC40')).toContain('評価を0');
});
it('R1HD23: requires independent certificates for topology residency and original unit costs',()=>{
 expect(R1H_DESIGN.certificate).toHaveLength(9);for(const t of ['residency DAG','原単位work対応','module初期化前のload gate','codec overlay・native hash','汎用callerが任意に保持する場合はuncovered'])expect(section).toContain(t);
 expect(condition('RHC47')).toContain('条件付き算術fitでも');
});
it('R1HD24: keeps contracts immutable and all runtime exits and performance claims unproved',()=>{
 expect(Object.isFrozen(R1H_DESIGN)).toBe(true);expect(Object.isFrozen(R1H_DESIGN.caps)).toBe(true);expect(record.status).toBe('design-only');
 for(const [k,v]of Object.entries(R1H_DESIGN.scope))expect(v,k).toBe(k==='designOnly');for(const x of Object.values(record.arithmetic) as any[]){expect(x.runtimeAdmitted).toBe(false);expect(x.physicalHeapUpperBytes).toBeNull();}
 expect(section).toContain('実装・physical upper・実親vector・性能・R1-M／R1出口・本番採用は全て未成立');
});
it('R1HD25: reserves both complete window bodies without counting retired handles twice',()=>{
 const x=r1hUpperExample(finite());
 expect(x.reservedWindowBodies).toBe(2);expect(x.reservedWindowsUpper).toBe(8192);
 expect(x.retirementExtraUpper).toBe(128);expect(x.additionalBeyondOldMetadataUpper).toBe(5120);expect(x.retentionEnvelopeUpper).toBe(9216);
 expect(x.retentionEnvelopeUpper).toBe(2*(3072+48*8+8*32+384)+128+512+128+128+128);
 expect(x.retentionEnvelopeUpper).toBeGreaterThan(5376);expect(x.runtimeAdmitted).toBe(false);
 expect(record.review).toEqual({regressions:['R1HD25','R1HD26','R1HD27','R1HD28'],preFixFailuresConfirmed:4,scope:'design-consistency-only',oldHypotheticalEnvelopeUpper:5376,correctedHypotheticalEnvelopeUpper:9216,omittedWindowBodyUpper:3840});
});
it('R1HD26: retains two-window reservation for one attempt and refuses unproved reuse credits',()=>{
 expect(count('client',1).reservedWindowBodies).toBe(2);expect(count('provider',2).reservedWindowBodies).toBe(2);
 const x=r1hUpperExample({...finite(),windowContainerUpper:null});expect(x.reservedWindowsUpper).toBeNull();expect(x.retentionEnvelopeUpper).toBeNull();
 for(const credit of [{oldWindowReleased:true},{reservedWindowBodies:1},{reuseWindowBody:true}])expect(()=>r1hUpperExample({...finite(),...credit})).toThrow();
 expect(condition('RHC27')).toContain('2組');expect(condition('RHC27')).toContain('byte borrower終了だけ');
});
it('R1HD27: limits n=1 to arithmetic and a planned rejection of incomplete inventory',()=>{
 expect(R1H_DESIGN.batchCases).toEqual([
  {n:1,arithmeticCheck:true,runtimeExpectation:'reject-incomplete-inventory',normalRuntime:false,runtimeExecuted:false},
  {n:2,arithmeticCheck:true,runtimeExpectation:'complete-inventory-required',normalRuntime:true,runtimeExecuted:false},
  {n:19,arithmeticCheck:true,runtimeExpectation:'complete-inventory-required',normalRuntime:true,runtimeExecuted:false},
 ]);
 expect(R1H_DESIGN.batchCoverage).toEqual({minimumEntries:5,maximumRangesPerCommand:4,minimumNormalBatches:2});
 expect(Math.ceil(5/4)).toBe(2);expect(record.batchCases).toEqual(R1H_DESIGN.batchCases);
 const rows=['provider','client'].flatMap(kind=>[1,2,19].map(batchCount=>r1hBatchArithmetic({kind,batchCount})));expect(record.batchArithmetic).toEqual(rows);
 for(const row of rows){expect(row.reservedRowsPerRead).toBe(19*row.families*2);expect(row.arithmeticRowsPerAttempt).toBe(row.batchCount*row.families);expect(row.fullCoreValidated).toBe(false);expect(row.runtimeExecuted).toBe(false);expect(row.runtimeAdmitted).toBe(false);}
 expect(rows.filter(x=>x.batchCount===1).map(x=>[x.arithmeticRowsPerAttempt,x.reservedRowsPerRead,x.runtimeExpectation])).toEqual([[1,38,'reject-incomplete-inventory'],[2,76,'reject-incomplete-inventory']]);
 for(const n of [0,20,-1,NaN,1.5])expect(()=>r1hBatchArithmetic({kind:'client',batchCount:n})).toThrow();
});
it('R1HD28: separates valid n=2/19 runtime plans from n=1 arithmetic and rejection conditions',()=>{
 const c=condition('RHC14');for(const s of ['n=1は算術確認','不完全inventoryを拒否','正常runtimeはn=2／19','完全schema／全range被覆','予約を減らさない'])expect(c).toContain(s);
 expect(section).toContain('n=1の算術成功をfull core／inventoryのruntime成功へ昇格しない');
 expect(record.runtimeRegressionsExecuted).toBe(false);expect(record.conditions.find((x:any)=>x.id==='RHC14').executed).toBe(false);
});
