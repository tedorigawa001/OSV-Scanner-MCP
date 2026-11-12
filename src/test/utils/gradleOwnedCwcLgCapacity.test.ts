import {afterAll,it,expect} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {capacityBreakdown,capacityContext,capacityCandidate,capacityRow,CAPACITY_BOUNDARIES,CAPACITY_RECIPES,CAPACITY_SCOPE,CAPACITY_LIFETIMES} from '../fixtures/gradleOwnedCwcLgCapacity.mjs';
import {lg0MemoryBound} from '../fixtures/gradleOwnedCwcLg0Validation.mjs';
import {capacityReservationTrial} from '../fixtures/gradleOwnedCwcLgCapacityTrial.js';
import {context} from '../fixtures/gradleOwnedCprASchema.js';
import {cwcCMemory} from '../fixtures/gradleOwnedCwcC.js';
import {Lb0Budget} from '../fixtures/gradleOwnedCwcLb0Contract.js';
import {ownedDigest as hash} from '../../utils/gradleOwnedJson.js';

const baseline=JSON.parse(readFileSync('docs/validation/gradle-cwc-lg0-2026-11-12.json','utf8'));
const inputs=baseline.evidence.proofs.filter((p:any)=>p.mode==='owned-input'&&p.scenario==='normal');
it('LGM01: decomposes the unchanged baseline and preserves the failed maximum-context gate',()=>{
 for(const input of inputs){const c=capacityContext(input.context,input.role,'registered-maximum'),b=capacityBreakdown(c,input.role),old=lg0MemoryBound(c);
  expect(c).toEqual(baseline.evidence.layouts.find((x:any)=>x.mode==='owned-input'&&x.role===input.role).context);
  expect(b.client.scopeBytes).toBe(old.client);expect(b.provider.scopeBytes).toBe(old.provider);
  expect(b.combinedPeak).toBe(input.role==='reader'?1118753:1137629);expect(b.withinLimit).toBe(false);
 }
});
it('LGM02: schema-upper includes bounded reference lengths and head revision without changing role or lineage',()=>{
 for(const p of inputs){const c=capacityContext(p.context,p.role,'schema-upper');expect(context(c)).toEqual(c);
  expect(c.snapshot.byteLength).toBe(65536);expect(c.checkpoint.byteLength).toBe(65536);expect(c.pin.byteLength).toBe(65536);expect(c.binding.selected.head.revision).toBe(256);
  expect(c.binding.selected.snapshot).toEqual(c.snapshot);expect(c.binding.selected.checkpoint).toEqual(c.checkpoint);
  expect(c.peer.credentialId.length).toBe(128);expect(c.lineage.generation).toBe(Number.MAX_SAFE_INTEGER);
  const b=capacityBreakdown(c,p.role);expect(b.widths).toEqual(cwcCMemory(c));expect(b.combinedPeak).toBe(p.role==='reader'?1119501:1138377);
 }
});
it('LGM03: four active command slots plus 2048 metadata bytes fail the full broker bound by 53 bytes',()=>{
 const p=inputs.find((p:any)=>p.role==='authority-broker'),c=capacityContext(p.context,p.role,'schema-upper');
 const r=capacityCandidate(c,p.role,'window-4-with-2048-metadata');expect(r.combinedPeak).toBe(1048629);expect(r.withinLimit).toBe(false);
 const q=capacityCandidate(capacityContext(p.context,p.role,'registered-maximum'),p.role,'window-4-with-2048-metadata');expect(q.combinedPeak).toBe(1048204);expect(q.withinLimit).toBe(true);
});
it('LGM04: three slots and a fresh 4096 metadata reservation fit arithmetically but grant no adoption',()=>{
 for(const p of inputs){const c=capacityContext(p.context,p.role,'schema-upper'),before=capacityBreakdown(c,p.role),after=capacityCandidate(c,p.role,'window-3-with-4096-metadata');
  expect(after.combinedPeak).toBe(p.role==='reader'?1031760:1042485);expect(after.withinLimit).toBe(true);
  for(const actor of ['client','provider']){
   for(const key of ['codec','planCores','contexts','frames','records','sourceWire','sourceCopies','sourceMetadata','rootAndFactMetadata'])expect(after[actor].regions[key],key).toBe(before[actor].regions[key]);
   expect(after[actor].regions.commandWindow).toBe(3*8192);expect(after[actor].regions.windowMetadata).toBe(4096);
  }
  expect(after.scope).toEqual(CAPACITY_SCOPE);expect(after.scope.activeWindowBoundEstablished).toBe(false);expect(after.scope.lg0ExitEstablished).toBe(false);
 }
});
it('LGM05: every region and frame credit balances exactly and context sharing alone is insufficient',()=>{
 for(const p of inputs){const c=capacityContext(p.context,p.role,'schema-upper'),b=capacityBreakdown(c,p.role);
  for(const actor of ['client','provider']){const a=b[actor];expect(Object.values<number>(a.regions).reduce((s,n)=>s+n,0)).toBe(a.scopeBytes);expect(a.combinedPeak).toBe(a.scopeBytes+131072+98304+8192+4096-32768);}
  expect(b.combinedPeak-2*b.contextBytes).toBeGreaterThan(1048576);
  expect(b.combinedPeak-2*b.contextBytes-2*b.widths.coreBytes).toBeGreaterThan(1048576);
 }
});
it('LGM06: actual synthetic tickets keep the old cap and spent balances over two attempts in both modes',()=>{
 for(const p of inputs)for(const mode of ['full-input','owned-input']){const c=capacityContext(p.context,p.role,'schema-upper'),a=capacityCandidate(c,p.role,'window-3-with-4096-metadata'),r=capacityReservationTrial(c,p.role,a.recipe,mode);
  expect(r.attempts).toHaveLength(2);expect(r.attempts.every(x=>x.error===null)).toBe(true);expect(r.final.peakBytes).toBe(a.combinedPeak);
  expect(r.final.heldBytes).toBe(0);expect(r.final.initialization).toBe(36864);expect(r.final.work).toBe(114690);expect(r.final.wire).toBe(114688);expect(r.scope.admitted).toBe(false);
 }
});
it('LGM07: the failing four-slot bound stops at LG reservation and cannot refund already spent work',()=>{
 const p=inputs.find((p:any)=>p.role==='authority-broker'),c=capacityContext(p.context,p.role,'schema-upper');
 for(const mode of ['full-input','owned-input']){const r=capacityReservationTrial(c,p.role,'window-4-with-2048-metadata',mode);expect(r.attempts).toHaveLength(1);expect(r.attempts[0]!.failedRegion).toBe('lg');expect(r.attempts[0]!.error).toBe('codec_budget_exceeded');expect(r.final.initialization).toBe(16384);expect(r.final.work).toBe(57344);expect(r.final.heldBytes).toBe(0);expect(r.final.peakBytes).toBeLessThanOrEqual(1048576);}
});
it('LGM08: a fitting memory hypothesis cannot bypass the old work cap or replace a failed recipe',()=>{
 const p=inputs[0],c=capacityContext(p.context,p.role,'schema-upper'),budget=new Lb0Budget(undefined,1048576,151553);
 const r=capacityReservationTrial(c,p.role,'window-3-with-4096-metadata','owned-input',budget);expect(r.attempts[1]!.failedRegion).toBe('logical-gate');expect(r.final.work+r.final.initialization).toBe(151553);expect(r.final.heldBytes).toBe(0);
 expect(()=>capacityCandidate(c,p.role,'window-zero')).toThrow('recipe');expect(()=>capacityReservationTrial(c,p.role,'baseline','fallback')).toThrow('codec_profile_unsupported');
});
it('LGM09: immutable input order does not change sizing and malformed context or role cannot be costed',()=>{
 const p=inputs[0],c=capacityContext(p.context,p.role,'schema-upper'),reordered=Object.fromEntries(Object.entries(c).reverse());expect(capacityBreakdown(reordered,p.role)).toEqual(capacityBreakdown(c,p.role));
 expect(()=>capacityBreakdown({...c,extra:true},p.role)).toThrow('context_schema');expect(()=>capacityBreakdown(c,'authority-broker')).toThrow('context_role');expect(()=>capacityContext(c,p.role,'shrunken')).toThrow('boundary');
});
it('LGM10: source lifetimes do not turn an existing fact release or unsupported sharing into a new saving',()=>{
 for(const x of CAPACITY_LIFETIMES)expect(readFileSync(x.source,'utf8')).toContain(x.anchor);
 expect(CAPACITY_LIFETIMES.find(x=>x.id==='transient-fact-command')!.candidate).toContain('do-not-count');
 for(const id of ['three-private-contexts','private-plan-cores'])expect(CAPACITY_LIFETIMES.find(x=>x.id===id)!.candidate).toContain('retain-all-three');
});
const rows:any[]=[];
it('LGM11: emits the complete mode/role/boundary/recipe audit without executing any CWC consumer',()=>{
 for(const p of inputs)for(const mode of ['full-input','owned-input'])for(const boundary of CAPACITY_BOUNDARIES)for(const recipe of CAPACITY_RECIPES){
  const c=capacityContext(p.context,p.role,boundary),audit=capacityRow(c,p.role,recipe),trial=capacityReservationTrial(c,p.role,recipe,mode);
  rows.push({id:`${mode}/${p.role}/${boundary}/${recipe}`,mode,role:p.role,boundary,recipe,context:c,contextDigest:hash(c),audit,trial});
 }
 expect(rows).toHaveLength(36);expect(new Set(rows.map(x=>x.id)).size).toBe(36);
});
it('LGM12: constructor scratch reservation failure releases the base ticket without refunding initialization',()=>{
 const p=inputs[0],budget=new Lb0Budget(undefined,131072);
 expect(()=>capacityReservationTrial(p.context,p.role,'baseline','owned-input',budget)).toThrow('codec_budget_exceeded');
 expect(budget.stats().heldBytes).toBe(0);expect(budget.stats().initialization).toBe(4096);
});
afterAll(()=>{if(process.env.CWC_LG_CAPACITY_EVIDENCE_PATH)writeFileSync(process.env.CWC_LG_CAPACITY_EVIDENCE_PATH,JSON.stringify({schema:'cwc-lg.capacity-evidence.v1',rows,lifetimes:CAPACITY_LIFETIMES,scope:CAPACITY_SCOPE}));});
