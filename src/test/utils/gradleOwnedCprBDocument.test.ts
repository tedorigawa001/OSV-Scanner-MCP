import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {analyzeCprB} from '../fixtures/gradleOwnedCprBRecord.mjs';
const json=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const summary=json('docs/validation/gradle-c3b-cpr-b-2026-11-08.json'),raw=json(summary.raw.path);
const section=designSection(readFileSync(summary.document.path,'utf8'),summary.document.heading);
type Row={condition:string;scalarMedianMs:number;batchMedianMs:number;planMedianMs:number;headroomMedianMs:number;fasterPairs:number;pairs:number;proceedToCprC:boolean};
const range=(xs:number[])=>Math.min(...xs).toFixed(2)+'〜'+Math.max(...xs).toFixed(2);
function tableRow(workload:string,rows:Row[]){
 const decision=rows.every(r=>r.proceedToCprC)?'限定条件の判定通過':rows.every(r=>!r.proceedToCprC)?'見送り':'条件により異なる';
 return '| '+workload+' | '+[range(rows.map(r=>r.scalarMedianMs)),range(rows.map(r=>r.batchMedianMs)),range(rows.map(r=>r.planMedianMs)),range(rows.map(r=>r.headroomMedianMs)),decision].join(' | ')+' |';
}
describe('CPR-B document claims',()=>{
 const comparison:Row[]=summary.comparison,by=(w:string)=>comparison.filter(r=>r.condition.startsWith(w+'/'));
 it('uses the comparison recomputed from the saved record',()=>{
  expect(analyzeCprB(raw).comparison).toEqual(comparison);
 });
 it('prints each workload row from the summary medians',()=>{
  for(const w of ['default','small','h0Sizes','singleLarge']){expect(by(w)).toHaveLength(4);expect(section).toContain(tableRow(w,by(w)));}
 });
 it('states the slower-pair count of the heavy workloads exactly',()=>{
  const heavy=[...by('h0Sizes'),...by('singleLarge')],pairs=heavy.reduce((n,r)=>n+r.pairs,0),slower=pairs-heavy.reduce((n,r)=>n+r.fasterPairs,0);
  expect([pairs,slower]).toEqual([48,47]);
  expect(section).toContain(pairs+' pair中'+slower+' pairでBが遅く');
  expect(section).not.toMatch(/全48 pairで/);
 });
 it('states that the allowance check is the per-pair total-time comparison',()=>{
  for(const p of raw.pairs){const s=p.arms['S-scoped'].result,b=p.arms['B-independent'].result,plan=b.clientPlanMs+b.sealMs+b.providerPlanMs,headroom=s.wallMs-(b.wallMs-plan);
   expect(plan<=headroom).toBe(b.wallMs<=s.wallMs);}
  expect(section).toContain('「計画合計≦許容額」と「B総時間≦S総時間」は同じ条件');
 });
});
