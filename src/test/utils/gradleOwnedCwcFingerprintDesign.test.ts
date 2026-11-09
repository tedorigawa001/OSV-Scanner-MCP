import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const r=JSON.parse(readFileSync('docs/validation/gradle-cwc-fp-design-2026-11-09.json','utf8')),section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading),sha=(x:string|Buffer)=>createHash('sha256').update(x).digest('hex');
it('binds the fingerprint contract to its section and inspected implementation',()=>{expect(sha(section)).toBe(r.document.sectionSha256);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);});
it('retains twenty-eight distinct planned conditions and four unexecuted stages',()=>{expect(r.regressionConditions.map((x:any)=>x.id)).toEqual(Array.from({length:28},(_,i)=>'CFP'+String(i+1).padStart(2,'0')));expect(r.stages.map((x:any)=>x.id)).toEqual(['CFP-0','CFP-1','CFP-2','CFP-3']);for(const x of [...r.regressionConditions,...r.stages]){expect(x.executed).toBe(false);expect(x.status).toBe('planned');expect(section).toContain('| '+x.id+' | '+x.condition+' |');}});
it('limits substitution to one self hash and preserves fresh input and authority checks',()=>{expect(r.target.replacementSites).toBe(1);for(const k of ['currentInputHashEveryCheck','grantAssertHashPreserved','authorityGatesPreserved'])expect(r.target[k]).toBe(true);for(const t of ['grant.assert(actor, privateContext)','hash(validatedCurrent.context) === F','同じmutable current参照','callbackがその例外を捕捉','同じgrantへの並行・再入constructor','親initial','private node'])expect(section).toContain(t);});
it('does not report planned runtime or performance work as completed',()=>{expect(r.status).toBe('design-only');expect(Object.values(r.scope).every(v=>v===false)).toBe(true);for(const t of ['毎回plain検査','callback・copy／parse／hash後','消費済みwork・attempt・wire枠を巻き戻さない','通常JS書込','旧baselineとの強化差は別bridge'])expect(section).toContain(t);});
it('separates observed or recorded revocation from unobserved pin restoration',()=>{
 expect(r.revocationObservation).toEqual({conditionId:'CFP10',observedMismatch:'reject-terminal-even-after-pin-restoration',recordedRevocation:'reject-even-if-pin-restored-before-next-check',unobservedChangeAndRestoration:'may-continue-if-all-live-checks-pass',baselineAndFixedFingerprintSameContract:true,historyDetectionRequiredWithoutIndependentEvidence:'unsupported',independentRevocationHistoryImplemented:false});
 const cfp10=r.regressionConditions.find((x:any)=>x.id==='CFP10');
 for(const t of ['(a)','(b)','(c)','実gateで観測','失効を記録','次の検査前にpinを復元','不一致の観測も失効記録もない','共通baseline／固定F版の双方で継続可能','検出成功とは記録しない','証拠なしではunsupported'])expect(cfp10.condition).toContain(t);
 for(const t of ['既存の`CwcCApprovalRegistry.assertCurrent()`','未観測の一時変更','全ての権威ある変更を復元前に記録','caller／callbackが巻き戻せず','今回の単一自己hash置換ではその仕組みを追加せず'])expect(section).toContain(t);
 expect(cfp10.executed).toBe(false);
});
