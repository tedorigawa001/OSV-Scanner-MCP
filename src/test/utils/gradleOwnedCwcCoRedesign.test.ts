/** Design consistency only; none of CCR01-48 is executed by these checks. */
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {CO_RED_DESIGN,coRedesignCapacity,coRedesignWork,coRedesignBatch} from '../fixtures/gradleOwnedCwcCoRedesign.mjs';
import {cprFixture} from '../fixtures/gradleOwnedCprAFixture.js';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync(process.env.CWC_CO_REDESIGN_RECORD_PATH??'docs/validation/gradle-cwc-co-redesign-2026-11-12.json','utf8'));
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);
const condition=(id:string)=>r.conditions.find((x:any)=>x.id===id).condition;
it('CRD01: binds the new design and unchanged baseline records/sources',()=>{
 expect(sha(section)).toBe(r.document.sha256);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 for(const b of r.baselines)expect(sha(readFileSync(b.path))).toBe(b.sha256);expect(r.contract).toEqual(CO_RED_DESIGN);
});
it('CRD02: keeps forty-eight runtime conditions and three stages unexecuted',()=>{
 expect(r.conditions.map((c:any)=>c.id)).toEqual(Array.from({length:48},(_,i)=>'CCR'+String(i+1).padStart(2,'0')));
 expect(r.stages.map((s:any)=>s.id)).toEqual(['CCO-R0','CCO-R1','CCO-R2']);
 for(const x of [...r.conditions,...r.stages]){expect(x.status).toBe('planned');expect(x.executed).toBe(false);expect(section).toContain('| '+x.id+' | '+x.condition+' |');}
 expect(r.status).toBe('design-only');expect(r.designChecksPassed).toBe(14);expect(r.runtimeRegressionsExecuted).toBe(false);
});
it('CRD03: includes all reference/handle/container charges in the 4096-byte candidate',()=>{
 const {metadata:m,bridge:b}=r.contract;expect(m.header+m.rows+m.bridge+m.leases+m.alignment).toBe(4096);
 expect(m.binaryArenaBytes).toBe(3072);expect(m.binaryArenaBytes+m.bridge).toBe(4096);expect(m.binaryArenaBytes).toBe(m.header+m.rows+m.leases+m.alignment);
 expect(b.referenceSlots*b.referenceCharge+b.handles*b.handleCharge+b.containerCharge).toBe(1024);
 expect(b.referenceSlots).toBe(48);expect(b.handles).toBe(8);expect(b.physicalHeapBound).toBe(false);expect(b.chargeCertificateRequired).toBe(true);
 for(const t of ['旧16参照target','同じobjectへの複数の保持field','global WeakMap','labelだけ'])expect(section).toContain(t);
});
it('CRD04: counts the token index as a full slot and separately reserves stream/overlay bytes',()=>{
 const w=r.contract.window;expect(w.tokenRecords*w.tokenRecordBytes).toBe(w.bytesPerSlot);expect(w.slots*w.bytesPerSlot).toBe(24576);
 expect(w.externalChunkBytes).toBe(4096);expect(w.codecOverlayBytes).toBe(16384);expect(w.codecBytes).toBe(393216);
 for(const h of r.contract.helpers)expect(section).toContain('| '+h+' |');
 for(const t of ['S2も全command','requestDigestだけを除いた','actual row／S0／そのdigest','完全schema・意味検査','semanticEquivalence'])expect(section).toContain(t);
 expect(r.contract.forbidden).toContain('shallow-preimage-object');expect(r.contract.forbidden).toContain('recursive-canonical-map-join');
});
it('CRD05: independently reproduces all six conditional 4-core memory rows and table values',()=>{
 const peaks=[[936235,989070],[1017925,1035431],[1018690,1035856],[945175,994050],[1037230,1046156],[1037995,1046581]];
 expect(r.memoryRows).toHaveLength(6);
 for(const [i,row]of r.memoryRows.entries()){
  const x=coRedesignCapacity(row.context,row.role);expect(x).toEqual(row.calculation);expect([x.client,x.provider]).toEqual(peaks[i]);
  expect(x.clientCores).toBe(4);expect(x.providerCores).toBe(3);expect(x.arithmeticFits).toBe(true);expect(x.runtimeAdmitted).toBe(false);expect(x.ownershipAndOverlayProved).toBe(false);
  expect(section).toContain('| '+row.role+'／'+row.boundary+' | '+x.client+' | '+x.provider+' | '+x.clientSlack+' | '+x.providerSlack+' |');
 }
});
it('CRD06: retaining one caller core rejects the broker maximum rather than hiding it in the old floor',()=>{
 const row=r.memoryRows.at(-1),x=coRedesignCapacity(row.context,row.role,{callerClientCores:1});
 expect(x.client).toBe(1057397);expect(x.clientSlack).toBe(-8821);expect(x.clientCores).toBe(5);expect(x.arithmeticFits).toBe(false);
 expect(condition('CCR32')).toContain('1057397 B');expect(condition('CCR05')).toContain('追加計上');
});
it('CRD07: restored trace/extra workspace cannot be credited to existing regions',()=>{
 const row=r.memoryRows.at(-1),x=coRedesignCapacity(row.context,row.role,{bridgeOverTarget:262144});
 expect(x.metadataTargetMet).toBe(false);expect(x.arithmeticFits).toBe(false);
 const y=coRedesignCapacity(row.context,row.role,{otherUncoveredBytes:1996});expect(y.providerSlack).toBe(-1);expect(y.arithmeticFits).toBe(false);
 expect(condition('CCR23')).toContain('二重控除');expect(condition('CCR29')).toContain('allocation');
});
it('CRD08: makes codec overlap, representation and core transfer proof mandatory',()=>{
 expect(r.contract.approvalRequired).toHaveLength(11);for(const name of ['coreOwnership','residencyDAG','bridgeCharge','scratchOverlap','costCoverage','semanticEquivalence','ownerLedgerBinding'])expect(r.contract.approvalRequired).toContain(name);
 for(const t of ['resident＋compile scratch＋proof scratch＋overlay','同時borrow','追加bytesを外側','representationCharge','heap／RSS'])expect(section).toContain(t);
});
it('CRD09: limits equal two-attempt additions to the historical remainder without granting coverage',()=>{
 const x=coRedesignWork({work:151554,initialization:0,extraWork:5424,extraInitialization:0});expect(x.total).toBe(156978);expect(x.maximumEqualPerAttempt).toBe(2712);expect(x.arithmeticFits).toBe(true);
 expect(x.unitAndOwnerMappingProved).toBe(false);expect(x.runtimeAdmitted).toBe(false);
 expect(coRedesignWork({work:151554,initialization:0,extraWork:5425,extraInitialization:0}).arithmeticFits).toBe(false);
 expect(coRedesignWork({work:151554,initialization:0,extraWork:5424,extraInitialization:1}).arithmeticFits).toBe(false);
 expect(condition('CCR38')).toContain('新sourceの成立証拠');
});
it('CRD10: keeps original work namespaces and disallows unapproved CPU quantity conversion',()=>{
 const w=r.contract.work;expect(w.unit).toBe('cpr.request-bytes-ranges-probes.v1');expect(w.planTicket).toBe(156978);expect(w.callLimit).toBe(156978);expect(w.providerLimit).toBe(1048576);
 expect(w.globalWorkLimit).toBe(67108864);expect(w.globalWireLimit).toBe(67108864);expect(w.logicalChecks).toBe(4096);expect(w.primitiveQuantityConversionAllowed).toBe(false);
 for(const t of ['(a)','(b)','(c)','元と同じ単位','別owner／namespace','cost-model-unsupported','zero・例外／drain','最初の対象copy／decode・fresh IOより前'])expect(section).toContain(t);
});
it('CRD11: preserves complete validation, live checks, independent plans and terminal lifecycle',()=>{
 for(const t of ['最後のcallback後の同期fence','元site／順序／回数','両credential','全bytes','別root・別計画','outcome／use／ACK','K/D','normal scope終了','fatal','drain'])expect(section).toContain(t);
 for(const id of ['CCR19','CCR20','CCR40','CCR41','CCR42','CCR43','CCR44','CCR45','CCR46'])expect(condition(id).length).toBeGreaterThan(25);
 expect(r.contract.scope.designOnly).toBe(true);for(const [k,v]of Object.entries(r.contract.scope))if(k!=='designOnly')expect(v,k).toBe(false);
});
it('CRD12: rejects invalid arithmetic and never interprets an illustrative fit as adoption',()=>{
 const row=r.memoryRows[0];for(const n of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER])expect(()=>coRedesignCapacity(row.context,row.role,{callerClientCores:n})).toThrow();
 for(const n of [-1,NaN,Infinity,1.5])expect(()=>coRedesignWork({work:n,initialization:0,extraWork:0,extraInitialization:0})).toThrow();
 expect(()=>coRedesignWork({work:Number.MAX_SAFE_INTEGER,initialization:1,extraWork:0,extraInitialization:0})).toThrow();
 expect(condition('CCR48')).toContain('昇格しない');expect(section).toContain('3 slot案を棄却する条件');
});
it('CRD13: CoreHandle aliases existing actor windows without adding a ninth handle or reference slot',()=>{
 const a=CO_RED_DESIGN.coreHandle;
 expect(a.aliasOf).toBe('window-handle');expect(a.runtimeIdentity).toBe('same-object');
 expect(a.additionalHandles).toBe(0);expect(a.additionalReferenceSlots).toBe(0);
 expect(a.binding).toEqual({provider:{window:14,builderCore:27,expectedCore:28},'client-initial':{window:14,builderCore:27,expectedCore:28},'client-seal':{window:15,builderCore:29,expectedCore:30}});
 expect(a.separateGeneration).toBe(false);expect(a.lookupLifetime).toBe('same-window-registry-entry');
 expect(48*8+8*32+384).toBe(1024);expect(3072+48*8+9*32+384).toBe(4128);
 for(const t of ['同一の実object','追加handle・追加reference slotは0','同じregistry entry','CoreHandle用の別generation','別wrapper／clone'])expect(section).toContain(t);
 for(const id of ['CCR26','CCR27'])expect(condition(id)).toContain('CoreHandle');
});
it('CRD14: reserves nineteen rows while completing exactly the validated n, including a real two-batch legacy plan',()=>{
 expect(CO_RED_DESIGN.batch.reservedRows).toBe(19);expect(CO_RED_DESIGN.batch.actualCount).toBe('validated-core.groups.length=command.batchCount');
 const width=r.memoryRows[0].calculation.widths.commandBytes;
 const rows=(n:number)=>Array.from({length:n},(_,i)=>i);
 for(const [index,n] of [1,2,19].entries()){
  const x=coRedesignBatch({batchCount:n,coreGroups:n,width,capturedOrdinals:rows(n),provedOrdinals:rows(n)});
  expect(x.reservedRows).toBe(19);expect(x.reservedFamilyBytes).toBe(19*width);expect(x.processedRows).toBe(n);expect(x.unusedRows).toBe(19-n);expect(x.runtimeAdmitted).toBe(false);
  expect(r.batchExamples[index]).toEqual(x);
 }
 for(const n of [0,20,NaN,1.5])expect(()=>coRedesignBatch({batchCount:n,coreGroups:n,width,capturedOrdinals:[],provedOrdinals:[]})).toThrow();
 const valid={batchCount:2,coreGroups:2,width,capturedOrdinals:[0,1],provedOrdinals:[0,1]};
 for(const bad of [{coreGroups:3},{capturedOrdinals:[0]},{capturedOrdinals:[0,0]},{capturedOrdinals:[1,0]},{capturedOrdinals:[0,1,2]},{capturedOrdinals:Array(2)},{provedOrdinals:[0]},{provedOrdinals:[0,0]},{provedOrdinals:[0,2]},{provedOrdinals:Array(2)},{commandBatchCounts:[2,3]}])expect(()=>coRedesignBatch({...valid,...bad})).toThrow();
 const f=cprFixture({sizes:[1,1,1,1,1]}),p=f.plan(),actualWidth=coRedesignCapacity(f.ctx,'reader').widths.commandBytes;
 const oracle={sizes:[1,1,1,1,1],entries:f.entries.length,sourceBytes:f.entries.reduce((n,e)=>n+e.byteLength,0),commands:p.commands.length,
  batchCount:p.commands[0]!.payload.plan.batchCount,coreGroups:p.core.groups.length,width:actualWidth,reservedRows:19,reservedFamilyBytes:19*actualWidth};
 expect(oracle.commands).toBe(2);expect(oracle.batchCount).toBe(2);expect(oracle.coreGroups).toBe(2);expect(oracle.entries).toBe(5);expect(oracle.sourceBytes).toBe(5);
 expect(r.legacyPlannerOracle).toEqual(oracle);expect(r.legacyPlannerOracleExecuted).toBe(true);
 expect(oracle.width).toBe(width);expect(p.commands.every((q,i)=>q.payload.plan.batchOrdinal===i&&q.payload.plan.batchCount===2)).toBe(true);
 for(const id of ['CCR08','CCR20'])expect(condition(id)).toContain('n=batchCount');
 for(const t of ['予約容量19×W','未使用row','減額・返還しない','n_initialとn_seal'])expect(section).toContain(t);
 if(process.env.CWC_CO_REDESIGN_BATCH_PATH)writeFileSync(process.env.CWC_CO_REDESIGN_BATCH_PATH,JSON.stringify(oracle));
});
