import {it,expect} from 'vitest';
import {writeFileSync} from 'node:fs';
import {windowInput,windowAttempt,runWindowMatrix} from '../fixtures/gradleOwnedCwcLgWindow.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {CPR_PLAN_WORK_BOUND} from '../fixtures/gradleOwnedCprAPlanner.js';
import * as commandSchema from '../fixtures/gradleOwnedCprASchema.js';

it('LMW01: actual A expected construction has four distinct live command objects; three slots deny before parser entry',()=>{
 const f=windowInput('reader','normal');
 const positive=windowAttempt(f,{capacity:8,mode:'owned-input'});
 expect(positive.error).toBeNull();expect(positive.completed).toBe(19);expect(positive.oracleChecks).toBe(19);
 expect(positive.witness).toHaveLength(4);expect(new Set(positive.witness!.map(x=>x.object)).size).toBe(4);
 expect(positive.witness!.map(x=>x.site)).toEqual(['caller-decode','schema-result','expected-build','schema-result']);
 const denied=windowAttempt(f,{capacity:3,mode:'owned-input'});
 expect(denied.completed).toBe(0);expect(denied.deniedAt).toBe('expected');expect(denied.deniedBeforeParse).toBe(true);expect(denied.deniedParseCalls).toBe(0);
 expect(denied.counts).toEqual({parses:2,copies:1,decodes:1,builds:1});
 expect(denied.planSpent).toBe(CPR_PLAN_WORK_BOUND);expect(denied.diagnosticBudget.heldBytes).toBe(0);
});
it('LMW02: both requested LG modes, roles and maximum boundaries preserve 19 commands and fail the three-slot guard',()=>{
 const evidence=runWindowMatrix();
 for(const {capacity,attempts} of evidence.rows){
   for(const a of attempts){expect(a.completed).toBe(capacity===3?0:19);expect(a.scope.lg0ExitEstablished).toBe(false);
    expect(a.groups).toBe(19);expect(a.entries).toBe(9);expect(a.sourceBytes).toBe(41460);expect(a.fourRangeGroups).toBe(1);
    expect(a.diagnosticBudget.heldBytes).toBe(0);expect(a.diagnosticBudget.initialization).toBe(4096);}
   expect(attempts.map(x=>x.planSpent)).toEqual([CPR_PLAN_WORK_BOUND,2*CPR_PLAN_WORK_BOUND]);
   expect(attempts[0]!.scopeId).not.toBe(attempts[1]!.scopeId);
 }
 if(process.env.CWC_LG_WINDOW_EVIDENCE_PATH)writeFileSync(process.env.CWC_LG_WINDOW_EVIDENCE_PATH,JSON.stringify(evidence));
},60000);
it('LMW03: insufficient diagnostic reservation refuses before any consumer allocation',()=>{
 const f=windowInput('reader','normal');expect(()=>windowAttempt(f,{capacity:3,mode:'owned-input',diagnosticBudget:new Lb0Budget(undefined,28671)})).toThrow('codec_budget_exceeded');
});
it('LMW05: the same real parent ledger keeps failed-plan consumption and refuses a third attempt before command copies',()=>{
 const f=windowInput('reader','normal'),balance={work:0};
 for(let i=0;i<2;i++)expect(windowAttempt(f,{capacity:3,mode:'owned-input',balance}).planSpent).toBe((i+1)*CPR_PLAN_WORK_BOUND);
 const third=windowAttempt(f,{capacity:3,mode:'owned-input',balance});expect(third.completed).toBe(0);expect(third.trace).toEqual([]);
 expect(third.planSpent).toBe(2*CPR_PLAN_WORK_BOUND);expect(third.counts).toEqual({parses:0,copies:0,decodes:0,builds:0});
 balance.work=0;const lowered=windowAttempt(f,{capacity:3,mode:'owned-input',balance});expect(lowered.error).not.toBeNull();expect(lowered.trace).toEqual([]);
});
it('LMW06: schema failure and caught reentry restore the exact original observer targets',()=>{
 const f=windowInput('reader','normal'),originals=[globalThis.structuredClone,commandSchema.command,commandSchema.checkCommand,commandSchema.makeCommand,commandSchema.cprCommandSchema.parse];
 for(const fault of ['parse-failure','reentry'] as const){windowAttempt(f,{capacity:8,mode:'full-input',fault});
  [globalThis.structuredClone,commandSchema.command,commandSchema.checkCommand,commandSchema.makeCommand,commandSchema.cprCommandSchema.parse].forEach((fn,i)=>expect(fn).toBe(originals[i]));
  const next=windowAttempt(f,{capacity:8,mode:'full-input'});expect(next.error).toBeNull();expect(next.completed).toBe(19);}
});
it('LMW04: exceptions and caught reentry cannot turn a probe into a completed plan or refund spent work',()=>{
 const f=windowInput('reader','normal');
 for(const mode of ['full-input','owned-input'] as const)for(const fault of ['parse-failure','reentry','deadline','revocation'] as const){
  const a=windowAttempt(f,{capacity:8,mode,fault});expect(a.error).not.toBeNull();expect(a.completed).toBe(0);
  expect(a.planSpent).toBe(CPR_PLAN_WORK_BOUND);expect(a.diagnosticBudget.heldBytes).toBe(0);expect(a.diagnosticBudget.initialization).toBe(4096);
 }
});
