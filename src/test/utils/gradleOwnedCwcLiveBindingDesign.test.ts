import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync('docs/validation/gradle-cwc-lb-design-2026-11-09.json','utf8'));
const section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
it('binds the design section and inspected session, scope and provider sources',()=>{
 expect(sha(section)).toBe(r.document.sectionSha256);
 for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
});
it('keeps thirty-six distinct runtime conditions and four stages explicitly unexecuted',()=>{
 expect(r.regressionConditions.map((x:any)=>x.id)).toEqual(Array.from({length:36},(_,i)=>'CLB'+String(i+1).padStart(2,'0')));
 expect(r.stages.map((x:any)=>x.id)).toEqual(['CLB-0','CLB-1','CLB-2','CLB-3']);
 for(const x of [...r.regressionConditions,...r.stages]){expect(x.status).toBe('planned');expect(x.executed).toBe(false);expect(section).toContain('| '+x.id+' | '+x.condition+' |');}
});
it('specifies opaque helper inputs without introducing a general authorization or raw-buffer callback',()=>{
 expect(r.contract.profile).toBe('cwc.session-owned-call-binding.v1');
 expect(r.contract.helperEntries).toEqual(['beginCallBinding','sealCallBinding','checkBoundCallLive','readBoundCommand','releaseCallBinding']);
 for(const name of r.contract.helperEntries)expect(section).toContain('| '+name+' |');
 expect(r.contract.arbitraryBufferCallbackAllowed).toBe(false);expect(r.contract.internalFrameCarriesAuthorization).toBe(false);
 for(const text of ['実参照','1 call＝1 owner','callerが渡す任意callbackへBを渡すAPIを設けない','source読取権限・DispatchPermitを発行しない','frameは経路の正当性だけを示し、認可の成功事実を含まない'])expect(section).toContain(text);
});
it('requires identity ownership, stable capture and session-owned final cleanup',()=>{
 expect(r.contract.identityOwnershipPrerequisite).toBe(true);expect(r.contract.privateWireBeforeFirstVerification).toBe(true);
 expect(r.contract.scopeCloseWipesSessionWire).toBe(false);expect(r.contract.sessionFinalReadBeforeWipe).toBe(true);
 for(const text of ['現行wireもBufferで可変','public readonlyはTypeScript上の制約','SharedArrayBuffer','identity slotの差替えを防ぐ','凍結済みpublic value view','scope.closeだけではBをzeroしない','session自身の最終読取が終わった後','任意の内部コードがBを直接書き換えたことを再hashなしで検出できるとは主張しない'])expect(section).toContain(text);
});
it('preserves per-check live authority, deadlines, ordinary inspect and content validation',()=>{
 expect(r.contract.liveCallChecksPerReplacement).toBe(1);
 for(const key of ['permissionCanonicalEveryCheck','ordinaryInspectRetained','contentChecksRetained'])expect(r.contract[key]).toBe(true);
 expect(r.contract.unobservedPinRestoration).toBe('same-as-cfp10');
 for(const text of ['同じscope内で成功したことを理由に次の検査を省略しない','permission条件やそのlineageのcanonical処理','各gateは実row／親のより短い現在の期限も読む','未知の副作用を自動で「副作用なし」へ変えず','次の検査前に変更と復元が完了し','ready後に失敗したbindingを完全経路で救済するfallback'])expect(section).toContain(text);
});
it('retains existing budgets and counts assembly and cleanup without claiming performance or adoption',()=>{
 expect(r.contract.maximumInnerWireBytes).toBe(8192);expect(r.contract.memoryLimitBytes).toBe(1048576);
 expect(r.contract.modes).toEqual(['full-reference','bound-live']);expect(r.contract.comparisonIncludesAssemblyAndCleanup).toBe(true);
 expect(r.status).toBe('design-only');expect(Object.values(r.scope).every(x=>x===false)).toBe(true);
 for(const text of ['copy／decode前に必要な枠を確保','上限を一律拡大しない','新しいfixture／Endpoint構築前','binding cleanup後までのT_total','事前生成したbindingを最適化armだけへ渡さない','4段階とも未実装'])expect(section).toContain(text);
});
it('requires current purpose to match the issued, bound and expected purpose even if separately permitted',()=>{
 expect(r.purposeBinding).toEqual({conditionId:'CLB15',capturedFrom:'verified-channel-purpose',compare:['currentPurpose','issuedPurpose','binding.purpose','expectedProjection.purpose'],comparison:'exact-equality',permitResultDiscardAllowed:false,alternativeGrantedPurpose:'reject-permission-denied',rebaseAllowed:false,modes:['full-reference','bound-live']});
 const condition=r.regressionConditions.find((x:any)=>x.id==='CLB15');
 for(const text of ['readとpublicationの両purpose','currentPurposeがread→publication','issuedPurpose＝binding＝projection','permission_denied','両mode','purpose復元'])expect(condition.condition).toContain(text);
 for(const text of ['currentPurpose = permitAPI(peer, api)','その返値を捨てず','現行のc.check()はpermitAPIの返値を捨てる','currentPurposeへissuedPurpose／bindingを再基準化せず'])expect(section).toContain(text);
 expect(condition.executed).toBe(false);
});
it('invalidates on timeout independently of dispatch and reclaims bytes only after private readers drain',()=>{
 expect(r.timeoutLifecycle).toEqual({conditionIds:['CLB19','CLB20'],invalidationWaitsForDispatch:false,invalidationOrder:['terminal-and-generation','bindings-and-frames-invalid','lookup-removed','channel-admission-stopped','timeout-response'],privateReadMode:'bounded-synchronous',privateReadsAcrossAwait:false,privateReadsAcrossExternalCallback:false,bufferReferences:'control-and-active-readers-only',reclaimWhen:'terminal-and-privateReaders-zero',byteReservationReleasedOnce:true,lateContinuation:'check-control-generation-before-bytes-or-publication',unfinishedDispatchRetainsCapacity:true,spentBudgetRefund:false});
 const expiry=r.regressionConditions.find((x:any)=>x.id==='CLB19'),cleanup=r.regressionConditions.find((x:any)=>x.id==='CLB20');
 for(const text of ['dispatchを未完了promiseで保留','finallyを待たず','公開lookup除去','後着のresolve／reject','B取得・decode','repeat expire／late finally'])expect(expiry.condition).toContain(text);
 for(const text of ['(a)','(b)','(c)','(d)','privateReaders＝0','dispatch未完了のままBをzero','binding／async closureにBの強参照がない','最後のreaderのfinally','二重zero／解放0','隔離枠'])expect(cleanup.condition).toContain(text);
 for(const text of ['dispatchのfinallyを失効の起点にしない','awaitや外部callbackの前に','await・外部callback・mutableなB参照の外部持出しを禁止','authenticatedCalls.get(call)が存在するとの仮定を置かず','timeoutだけでworking／未完了dispatch枠を再利用可能とせず'])expect(section).toContain(text);
 expect(section).toContain('zeroしただけで参照が残るbytesを回収済みと計上しない');
 expect(expiry.executed).toBe(false);expect(cleanup.executed).toBe(false);
});
