/** Design checks only: R1 runtime regression conditions remain planned. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {R1_DESIGN,R1_REGIONS,R1_ADDITIONS,r1SourceAudit,r1BufferAudit,r1CapacityExample,r1WorkExample} from '../fixtures/gradleOwnedCwcR1Design.mjs';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync(process.env.CWC_R1_DESIGN_RECORD_PATH??'docs/validation/gradle-cwc-r1-design-2026-11-13.json','utf8'));
const sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex'),section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);
const condition=(id:string)=>r.conditions.find((c:any)=>c.id===id).condition;
const zero=()=>Object.fromEntries(R1_ADDITIONS.map(k=>[k,0])),unknown=()=>Object.fromEntries(R1_ADDITIONS.map(k=>[k,null]));
const baseline=JSON.parse(readFileSync('docs/validation/gradle-cwc-r0-2026-11-12.json','utf8'));
it('R1D01: binds the new section, unchanged original source closure and baseline records',()=>{
 expect(sha(section)).toBe(r.document.sha256);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 for(const b of r.baselines)expect(sha(readFileSync(b.path))).toBe(b.sha256);expect(r.contract).toEqual(R1_DESIGN);expect(r.regions).toEqual(R1_REGIONS);
});
it('R1D02: records forty-eight planned runtime conditions and four unimplemented steps',()=>{
 expect(r.conditions.map((c:any)=>c.id)).toEqual(Array.from({length:48},(_,i)=>'R1C'+String(i+1).padStart(2,'0')));expect(r.steps.map((s:any)=>s.id)).toEqual(['R1-O','R1-M','R1-W','R1-G']);
 for(const c of [...r.conditions,...r.steps]){expect(c.executed).toBe(false);expect(c.status).toBe('planned');expect(section).toContain('| '+c.id+' | '+c.condition+' |');}
 expect(r.designChecksPassed).toBe(20);expect(r.runtimeRegressionsExecuted).toBe(false);
});
it('R1D03: limits ownership to private construction/internal move and rejects raw flags/copies',()=>{
 const o=r.contract.ownership;expect(o.modes).toEqual(['construct-private','internal-move']);expect(o.rawGraphTransferSupported).toBe(false);expect(o.callerFlagAccepted).toBe(false);expect(o.copyIsTransfer).toBe(false);
 for(const s of o.phases)expect(section).toContain(s);for(const t of ['WeakRef','全重複領域','lookupを先に失効','sourceの旧権限を復活させない','bytesをsource側zeroで破壊せず'])expect(section).toContain(t);
 for(const h of ['registerOwnedIntake','reserveOwnedVector','constructOwnedState','moveOwnedState','publishOwnedWindow','retireOwnedState'])expect(section).toContain('| '+h+' |');
});
it('R1D04: puts the gate before old constructors and binds one shell to its hydrated scope',()=>{
 expect(condition('R1C09')).toContain('constructor');expect(condition('R1C10')).toContain('hydrate前');
 for(const t of ['既存`CwcCReadScope` constructor','同一scope実体を2段階','constructor前に拒否','hydrate前','新adapterは未実装'])expect(section).toContain(t);
});
it('R1D05: inventories fifteen regions including caller graphs, diagnostics and terminal overlap',()=>{
 expect(r.regions.map((x:any)=>x.id)).toEqual(Array.from({length:15},(_,i)=>'R'+String(i+1).padStart(2,'0')));
 for(const x of r.regions){expect(section).toContain('| '+x.id+' |');expect(x.runtimeChargeComplete).toBe(false);expect(x.owner.length).toBeGreaterThan(0);expect(x.lifetime.length).toBeGreaterThan(0);}
 for(const id of ['R01','R02','R09','R12','R14','R15'])expect(r.regions.find((x:any)=>x.id===id)).toBeDefined();
});
it('R1D06: reproduces actual registered buffer quantities from all twenty-four R0 rows',()=>{
 const rows=r1BufferAudit(baseline.evidence);expect(rows).toEqual(r.bufferAudit);expect(rows).toHaveLength(24);
 rows.forEach((x:any,i:number)=>{const old=baseline.evidence.rows[i],F=x.kind==='client'?2:1;
  expect(x.explicitRegisteredBufferBytes).toBe(3072+4096+24576+F*(2*x.coreBytes+19*x.commandBytes));expect(x.explicitRegisteredBufferBytes).toBe(old.after.clearedBytes);
  expect(x.logicalHeldBytes).toBe(old.before.budget.heldBytes);expect(x.logicalHeldBytes).toBeGreaterThan(x.explicitRegisteredBufferBytes);expect(x.wholeMemoryUpperBound).toBeNull();expect(x.runtimeAdmitted).toBe(false);
 });
});
it('R1D07: separates embedded context/cache occupancy from graph charge and core floors',()=>{
 for(const x of r.bufferAudit){expect(x.packedOccupiedBytes).toBe(512+x.contextBytes+256*16+76*64);expect(x.packedOccupiedBytes).toBeLessThanOrEqual(x.coreBytes);expect(x.requiredCoreFloor).toBe(x.kind==='client'?4:3);expect(x.actualCoreArenas).toBe(x.kind==='client'?4:2);expect(x.actualParentLedgerBinding).toBe(false);}
 expect(condition('R1C12')).toContain('複数holder');expect(condition('R1C15')).toContain('JS core graph');
});
it('R1D08: binds twenty-six source groups and keeps every original-unit mapping unapproved',()=>{
 expect(r.sourceAudit).toEqual(r1SourceAudit());expect(r.sourceAudit).toHaveLength(26);
 for(const x of r.sourceAudit){expect(x.lines.length).toBeGreaterThan(0);expect(x.sourceDigest).toBe(sha(readFileSync(x.path)));expect(x.coverageClass).toBe('uncovered');expect(x.originalUnitMapping).toBeNull();expect(x.approvedDebit).toBeNull();}
 for(const id of ['field-scans','parser-spans','native-state','terminal-digests','terminal-zero'])expect(r.sourceAudit.some((x:any)=>x.id===id)).toBe(true);
});
it('R1D09: preserves the bridge/metadata candidate and all alias/closure obligations',()=>{
 const l=r.contract.layout;expect(l.metadataBinary+l.bridgeCandidate).toBe(4096);expect(l.referenceSlots*8+l.handles*32+384).toBe(l.bridgeCandidate);expect(l.physicalHeapBound).toBe(false);
 for(const t of ['JS object header','全holder','固定table','独立certificate','同じbacking bytesは一度だけ'])expect(section).toContain(t);
 expect(condition('R1C16')).toContain('第9handle');expect(condition('R1C17')).toContain('binary3072');
});
it('R1D10: requires codec residency proof and explicit native backend bounds without fallback',()=>{
 expect(r.contract.layout.codec).toBe(393216);expect(r.contract.layout.overlayCandidate).toBe(16384);expect(r.contract.scope.nativeHashApproved).toBe(false);
 for(const t of ['resident＋compile＋proof','固定arena SHA-256','module初期化','GCで解放されることを前提にしない','現R0のnative backend','無予約fallback'])expect(section).toContain(t);
 for(const t of ['閉包のload前','無条件import','全有効入力の最大証拠にしない'])expect(section).toContain(t);
});
it('R1D11: keeps unknown region upper bounds null and never promotes arithmetic fit to admission',()=>{
 const x=r1CapacityExample(1037995,unknown());expect(x.upperBound).toBeNull();expect(x.lowerBound).toBe(1037995);expect(x.arithmeticFits).toBeNull();expect(x.unknown).toHaveLength(7);expect(x.status).toBe('unsupported-unbounded-regions');
 const y=r1CapacityExample(1037995,zero());expect(y.arithmeticFits).toBe(true);expect(y.status).toBe('conditional-arithmetic-only');expect(y.runtimeAdmitted).toBe(false);
 expect(r.capacityExamples.unknown).toEqual(x);expect(r.capacityExamples.conditional).toEqual(y);
});
it('R1D12: rejects known lower-bound overflow even with other unknowns and does not expand the budget',()=>{
 const c=JSON.parse(readFileSync('docs/validation/gradle-cwc-co-redesign-2026-11-12.json','utf8')).memoryRows.at(-1).calculation;
 const x=r1CapacityExample(c.client,{...zero(),callerCoreBytes:c.widths.coreBytes});expect(x.lowerBound).toBe(1057397);expect(x.arithmeticFits).toBe(false);
 const y=r1CapacityExample(c.provider,{...unknown(),outsideOverlayBytes:1996});expect(y.lowerBound).toBe(1048577);expect(y.upperBound).toBeNull();expect(y.status).toBe('rejected-known-lower-bound');
 expect(r.capacityExamples.retainedCaller).toEqual(x);expect(r.capacityExamples.providerOverflow).toEqual(y);
});
it('R1D13: rejects missing, negative, fractional, nonfinite and overflowing arithmetic',()=>{
 for(const n of [-1,NaN,Infinity,1.5])expect(()=>r1CapacityExample(1,{...zero(),otherBytes:n})).toThrow();expect(()=>r1CapacityExample(1,{})).toThrow();expect(()=>r1CapacityExample(1,{...zero(),callerComplete:0})).toThrow();
 expect(()=>r1CapacityExample(Number.MAX_SAFE_INTEGER,{...zero(),otherBytes:1})).toThrow();
});
it('R1D14: keeps plan, call, provider and global namespaces independent with original limits/units',()=>{
 const w=r.contract.reservation;expect([w.plan,w.call,w.providerWork,w.globalWork,w.globalWire]).toEqual([156978,156978,1048576,67108864,67108864]);expect([w.lbWire,w.lbAttempts,w.logicalChecks]).toEqual([163840,256,4096]);
 const x=r1WorkExample(r.workExampleInput);expect(x).toEqual(r.workExample);expect(x.rows).toHaveLength(4);expect(x.arithmeticFits).toBeNull();expect(x.runtimeAdmitted).toBe(false);for(const row of x.rows){expect(row.actualOwnerBound).toBe(false);expect(row.unitCoverageApproved).toBe(false);}
 for(const row of x.rows.slice(2)){expect(row.additional).toBeNull();expect(row.total).toBeNull();expect(row.arithmeticFits).toBeNull();}
});
it('R1D15: cannot merge duplicate ledger names, invent namespaces, change units or exceed namespace limits',()=>{
 const a=r.workExampleInput[0];for(const bad of [{...a,namespace:'unregistered'},{...a,unit:'cpu-ticks'},{...a,limit:156979},{...a,spent:NaN},{...a,additional:-1},{...a,prepaid:true}])expect(()=>r1WorkExample([bad])).toThrow();expect(()=>r1WorkExample([a,a])).toThrow();
 const over=r1WorkExample([{...a,spent:151554,additional:5425}]);expect(over.arithmeticFits).toBe(false);expect(over.runtimeAdmitted).toBe(false);
 for(const t of ['child利用時に同じ156978を再加算しない','同じ実balance','異なる独立義務','確定済みwork／initialization／wire／attempt'])expect(section).toContain(t);
});
it('R1D16: preserves all-parent preflight, hold/commit failure and retry/deadline/drain rules',()=>{
 const w=r.contract.reservation;expect(w.allParentsBeforeCopyIO).toBe(true);expect(w.callbackDuringCommit).toBe(false);expect(w.commitFailureAdmission).toBe(false);expect(w.partialFailureConsumptionRefund).toBe(false);expect(w.deadlineExtension).toBe(false);
 for(const t of ['collect→preflight→prepare-hold→commit-debit→issue-intake','新しいoperation IDで二重予約しない','未確定holdだけ解放','同じ予約operation・K/D・元期限','独立processを跨ぐ永続transaction'])expect(section).toContain(t);
});
it('R1D17: gates sizing before target input access and preserves full live/content/transport checks',()=>{
 for(const t of ['actualサイズはintake後','独立承認schema最大式','その読取を始めずunsupported','全n件・全bytes','最後のcallback後の同期fence','正常drain','fatal／後着drain'])expect(section).toContain(t);
 expect(r.contract.reservation.permitIsDispatchPermit).toBe(false);for(const id of ['R1C34','R1C35','R1C39','R1C40','R1C41','R1C42'])expect(condition(id).length).toBeGreaterThan(30);
});
it('R1D18: leaves all runtime proofs false and separates static checks from future rejection tests',()=>{
 expect(r.status).toBe('design-only');expect(r.contract.scope.designOnly).toBe(true);for(const [k,v]of Object.entries(r.contract.scope))if(k!=='designOnly')expect(v,k).toBe(false);
 expect(r.runtimeRegressionsExecuted).toBe(false);expect(r.performanceMeasured).toBe(false);expect(section).toContain('呼出し0や実ledger予約を達成した証拠とは数えない');expect(condition('R1C47')).toContain('昇格しない');
});
it('R1D19: stops source use and drains existing borrows before final validation under one exclusive lease',()=>{
 const h=R1_DESIGN.ownership.handoff;expect(h).toBeDefined();
 expect(h.order).toEqual(['pin-and-stop-source','drain-existing-borrows','acquire-exclusive-handoff','final-complete-validation','bind-destination','publish-window']);
 expect(h.sourceStopBeforeFinalValidation).toBe(true);expect(h.lifetimePinBeforeDrain).toBe(true);expect(h.exclusiveThroughBind).toBe(true);expect(h.rawAliasAccepted).toBe(false);
 expect(h.additionalPublicHandles).toBe(0);expect(h.memoryReleaseDuringMove).toBe(false);expect(h.runtimeImplemented).toBe(false);
 const text=section.slice(section.indexOf('移管の確定順序は'));
 let at=-1;for(const step of h.order){const next=text.indexOf(step);expect(next).toBeGreaterThan(at);at=next;}
});
it('R1D20: rejects post-validation writes/zero and caught callback mutation attempts without runtime claims',()=>{
 const h=R1_DESIGN.ownership.handoff;expect(h).toBeDefined();
 expect(h.writesAllowedAfterFinalValidation).toBe(false);expect(h.zeroAllowedBeforeDestinationDrain).toBe(false);expect(h.caughtMutationAttemptIsFatal).toBe(true);expect(h.revisionRestoreAccepted).toBe(false);expect(h.callbackBetweenFinalFenceAndBind).toBe(false);
 for(const t of ['最後の完全検証後からbindまで','捕捉済みcallback','内側で例外を捕捉','更新値を元へ戻しても','移管先の公開・署名・use／ACKは0'])expect(condition('R1C05')+' '+condition('R1C06')).toContain(t);
 expect(r.runtimeRegressionsExecuted).toBe(false);expect(r.contract.scope.runtimeTransferImplemented).toBe(false);
});
