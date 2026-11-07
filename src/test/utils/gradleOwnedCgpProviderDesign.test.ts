import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {providerFeasibility,feasibilityRow} from '../fixtures/gradleOwnedCgpProviderFeasibility.mjs';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const record=json('docs/validation/gradle-c3b-cgp-provider-plan-design-2026-11-07.json'),section=designSection(readFileSync(record.document.path,'utf8'),record.document.heading);
const rows=(prefix:string)=>[...section.matchAll(new RegExp('^\\| ('+prefix+') \\| (.*) \\|$','gm'))].map(m=>({id:m[1],condition:m[2]}));
describe('CGP provider-plan design record',()=>{
 it('matches the section and the sources it describes',()=>{
  expect(sha(section)).toBe(record.document.sectionSha256);
  for(const [path,digest] of Object.entries(record.sourceBindings))expect(sha(readFileSync(path)),path).toBe(digest);
 });
 it('lists exactly the regression conditions and stages of the section',()=>{
  const cpr=rows('CPR\\d{2}');
  expect(cpr.map(r=>r.id)).toEqual(Array.from({length:48},(_,i)=>'CPR'+String(i+1).padStart(2,'0')));
  expect(record.regressionConditions.map((c:any)=>({id:c.id,condition:c.condition}))).toEqual(cpr);
  expect(record.implementationStages.map((s:any)=>({id:s.id,condition:s.condition}))).toEqual(rows('CPR-[A-D]'));
 });
 it('stays a design: nothing implemented, executed or opened',()=>{
  expect(record.status).toBe('design-only');
  expect(record.regressionConditions.every((c:any)=>c.status==='planned'&&c.executed===false)).toBe(true);
  expect(record.scope).toEqual({runtimeChanged:false,implementationCompleted:false,runtimeTestsExecuted:false,publicApiProven:false,realStorageValidated:false,nativeIsolationVerified:false,productionAdopted:false,eightReadsEstablished:false,originalReadsSkipped:0,readCommittedReduction:0});
  for(const k of ['reviewCorrections','reviewCorrections2'])expect([record[k].runtimeImplemented,record[k].runtimeRegressionConditionsExecuted]).toEqual([false,false]);
 });
 it('recomputes the stop check from the I2P summary and prints it in the section',()=>{
  const f=record.feasibilityEstimate;
  expect(f.status).toBe('stop-check-only');
  expect(sha(readFileSync(f.source.path))).toBe(f.source.sha256);
  const computed=providerFeasibility(json(f.source.path));
  expect(computed).toEqual(f.rows);
  for(const r of computed)expect(section).toContain(feasibilityRow(r));
  expect(computed.filter(r=>r.runToLimitRatio.min>1).map(r=>r.workload)).toEqual(['small','h0Sizes','singleLarge']);
 });
});
