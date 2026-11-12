import {readFileSync} from 'node:fs';
import {beforeAll,it,expect} from 'vitest';
import {runCo0Matrix} from '../fixtures/gradleOwnedCwcCo0Fixture.js';
import {validateCo0Evidence,compareCo0Replay,co0Hash} from '../fixtures/gradleOwnedCwcCo0Validation.mjs';
const path=process.env.CWC_CO0_RECORD_PATH??'docs/validation/gradle-cwc-co0-2026-11-12.json';
const record=JSON.parse(readFileSync(path,'utf8'));let fresh:ReturnType<typeof runCo0Matrix>;
beforeAll(()=>{fresh=runCo0Matrix();},60000);
const check=(e:any)=>{validateCo0Evidence(e);compareCo0Replay(e,fresh);};
const change=(fn:(e:any)=>void)=>{const e=structuredClone(record.evidence);fn(e);expect(co0Hash(e)).not.toBe(record.evidenceDigest);expect(()=>check(e)).toThrow();};
it('COR01: source-bound storage evidence matches independent bytes, trace recipe and a fresh run',()=>{
 expect(co0Hash(record.evidence)).toBe(record.evidenceDigest);check(record.evidence);
});
it('COR02: equal-count duplicated/missing trace entries cannot keep the same receipt',()=>{change(e=>{
 const t=e.rows[0].afterClose.trace;t[17]={...t[18],seq:17};
});});
it('COR03: frame retirement and capture ordinal movement are refused after digest updates',()=>{
 change(e=>{const t=e.rows[0].afterClose.trace;const i=t.findIndex((r:any)=>r.kind==='frame-exit');t[i].extra=4;});
 change(e=>{const t=e.rows[0].afterClose.trace;const rows=t.filter((r:any)=>r.kind==='capture');rows[1].ordinal=rows[0].ordinal;});
});
it('COR04: coordinated counter, work and initialization reductions cannot certify a completed run',()=>{
 change(e=>{for(const k of ['beforeClose','afterClose']){const s=e.rows[0][k];s.budget.work=0;s.managedOperations=0;s.children[0].used=0;}});
 change(e=>{e.rows[0].afterClose.budget.initialization=0;});
});
it('COR05: same-size candidate substitution is caught by independent full-command digests',()=>{
 change(e=>{for(const k of ['beforeClose','afterClose'])e.rows[0][k].familyDigests[0][0]='f'.repeat(64);});
});
it('COR06: a coordinated valid-context and digest replacement still fails fresh execution',()=>{
 change(e=>{for(const row of e.rows)row.context.manifest='f'.repeat(64);});
});
it('COR07: missing cases, actor relabeling and a different maximum-input boundary are refused',()=>{
 change(e=>{e.rows.pop();});change(e=>{e.rows[0].afterClose.children[0].actor='client-seal';});
 change(e=>{e.rows[8].boundary='normal';});
});
it('COR08: managed cells cannot be promoted to real A/B proof, metadata fit or production adoption',()=>{
 for(const field of ['realAandB','normalizerTemporariesBound','metadataBridgeWithin4096','completeWorkCoverage','threeSlotBoundEstablished','lg0ExitEstablished','productionAdopted'])change(e=>{e.rows[0].afterClose.scope[field]=true;});
});
