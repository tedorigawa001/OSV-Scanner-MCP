import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {it,expect} from 'vitest';
import {canonicalOwnedJson,ownedDigest} from '../../utils/gradleOwnedJson.js';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8')),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const r=json('docs/validation/gradle-cwc-design-2026-11-09.json'),section=designSection(readFileSync(r.document.path,'utf8'),r.document.heading);
const rows=(prefix:string)=>[...section.matchAll(new RegExp('^\\| ('+prefix+') \\| (.*) \\|$','gm'))].map(m=>({id:m[1],condition:m[2],status:'planned',executed:false}));
it('pins the design, baseline and inspected implementation sources',()=>{
 expect(sha(section)).toBe(r.document.sectionSha256);for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);expect(sha(readFileSync(r.baseline.path))).toBe(r.baseline.sha256);
});
it('keeps all forty conditions and four stages planned rather than executed',()=>{
 expect(r.regressionConditions).toEqual(rows('CWC\\d{2}'));expect(r.regressionConditions.map((x:any)=>x.id)).toEqual(Array.from({length:40},(_,i)=>'CWC'+String(i+1).padStart(2,'0')));expect(r.implementationStages).toEqual(rows('CWC-[A-D]'));expect(r.implementationStages).toHaveLength(4);
});
it('does not upgrade this design into runtime or performance evidence',()=>{
 expect(r.status).toBe('design-only');expect(Object.entries(r.scope).filter(([k])=>!['originalReadsSkipped','readCommittedReduction'].includes(k)).every(([,v])=>v===false)).toBe(true);expect(r.scope.originalReadsSkipped).toBe(0);expect(r.scope.readCommittedReduction).toBe(0);
 const baseline=json(r.baseline.path);expect(r.baseline.proceedToCprC).toBe(baseline.proceedToCprC);expect(r.baseline.productionAdopted).toBe(false);
});
it('separates the call-local encoding facts from actual authorization/session facts',()=>{
 expect(r.sharing.authorityFactsShared).toBe(false);expect(r.sharing.sessionNonceOrSignatureShared).toBe(false);expect(r.sharing.crossProviderCallCache).toBe(false);
 for(const text of ['clientはinitialのfactをsealへ渡さず','providerは各batchでSaved','signing intentを代用しない','slice／subarray／ArrayBuffer','wireIntent／operation／K/Dの検証hashや実wire-binding hashの計算回数を減らさず'])expect(section).toContain(text);
});
it('keeps full byte conformance, common primary gates and nonduplicated costs explicit',()=>{
 expect(r.primary.fullOracleInOptimizedPrimary).toBe(false);expect(r.primary.actualEmitterInitiallyUnchanged).toBe(true);expect(r.primary.existingLimitsUnchanged).toBe(true);expect(r.primary.newCodecSubbudgetApprovalRequired).toBe(true);expect(r.primary.arms).toEqual(['S-cwc','B-cwc-reference','B-cwc-composed']);
 for(const text of ['長さだけ・JSON decode結果だけの一致では不可','memory下位枠・共通preflightはprimary','P≤HはT_composed≤T_scalarと代数的に同じ','対応外側client initial／seal／owner plan時間','外部署名attestationではない'])expect(section).toContain(text);
});

it('separates accepted insertion order changes from rejected generated noncanonical order',()=>{
 const condition=r.regressionConditions.find((x:any)=>x.id==='CWC10').condition;
 expect(condition).toContain('入力キーの挿入順変更は同一canonical bytesとして受理');
 expect(condition).toContain('生成した非canonicalなキー順は独立oracleとの完全bytes照合で拒否');
 const first={schema:'x',body:{z:1,a:2}},reordered={body:{a:2,z:1},schema:'x'};
 expect(canonicalOwnedJson(first)).toBe(canonicalOwnedJson(reordered));
 expect(ownedDigest(first)).toBe(ownedDigest(reordered));
 expect(JSON.stringify(first)).not.toBe(canonicalOwnedJson(first));
});
