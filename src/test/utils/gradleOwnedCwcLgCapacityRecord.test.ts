import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {validateCapacityEvidence,validateCapacityLifetimeLocations} from '../fixtures/gradleOwnedCwcLgCapacityValidation.mjs';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {CAPACITY_LIFETIMES} from '../fixtures/gradleOwnedCwcLgCapacity.mjs';
import {ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
const r=JSON.parse(readFileSync(process.env.CWC_LG_CAPACITY_RECORD_PATH??'docs/validation/gradle-cwc-lg-capacity-2026-11-12.json','utf8'));
const bytes=readFileSync(r.baseline.path),baseline=JSON.parse(bytes.toString()),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
// Audit deficits may be negative; this does not relax the nonnegative runtime OwnedManifest schema.
const auditHash=(v:unknown)=>sha(JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value));
const validate=(e:any)=>validateCapacityEvidence(e,baseline);
it('LMR01: binds current audit sources, source anchors, baseline and the new design section',()=>{
 expect(r.schema).toBe('cwc-lg.capacity-validation.v1');expect(sha(bytes)).toBe(r.baseline.sha256);expect(baseline.evidenceDigest).toBe(r.baseline.evidenceDigest);
 for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 expect(sha(designSection(readFileSync(r.document,'utf8'),r.heading))).toBe(r.sectionDigest);expect(r.testsPassed).toBe(12);expect(r.recordTestsPassed).toBe(10);
 expect(auditHash(r.evidence)).toBe(r.evidenceDigest);expect(validate(r.evidence)).toEqual(r.summary);
 const sources=Object.fromEntries(CAPACITY_LIFETIMES.map(x=>[x.source,readFileSync(x.source,'utf8')]));expect(()=>validateCapacityLifetimeLocations(r.lifetimeLocations,sources)).not.toThrow();
});
it('LMR02: rejects lost or reordered positions even when every case and total count are preserved',()=>{
 const e=structuredClone(r.evidence);[e.rows[0],e.rows[1]]=[e.rows[1],e.rows[0]];expect(()=>validate(e)).toThrow('identity');
 const d=structuredClone(r.evidence);d.rows[1]=structuredClone(d.rows[0]);expect(()=>validate(d)).toThrow('identity');
 const m=structuredClone(r.evidence);m.rows.pop();expect(()=>validate(m)).toThrow('matrix');
});
it('LMR03: rejects coordinated context narrowing and updated digest at the schema upper boundary',()=>{
 for(const mode of ['full-input','owned-input']){const e=structuredClone(r.evidence),p=e.rows.find((p:any)=>p.mode===mode&&p.boundary==='schema-upper');p.context.snapshot.byteLength=1;p.context.binding.selected.snapshot.byteLength=1;p.contextDigest=hash(p.context);expect(()=>validate(e)).toThrow('context');}
});
it('LMR04: rejects moving cost between regions with unchanged total peak',()=>{
 const e=structuredClone(r.evidence);for(const actor of ['client','provider']){e.rows[0].audit[actor].regions.codec--;e.rows[0].audit[actor].regions.commands++;}
 expect(()=>validate(e)).toThrow('audit');
});
it('LMR05: rejects using a second frame credit or omitting old snapshot bytes',()=>{
 for(const fault of ['credit','snapshot']){const e=structuredClone(r.evidence),p=e.rows[0];if(fault==='credit'){p.audit.provider.sharedFrameCredit*=2;p.audit.provider.combinedPeak-=32768;}else p.audit.provider.regions.sourceCopies=0;expect(()=>validate(e)).toThrow('audit');}
});
it('LMR06: rejects reduced work, initialization, wire and attempts in synthetic reservation records',()=>{
 for(const key of ['work','initialization','wire','attempts']){const e=structuredClone(r.evidence),p=e.rows.find((p:any)=>p.recipe==='window-3-with-4096-metadata');p.trial.final[key]=0;for(const a of p.trial.attempts){a.beforeRelease[key]=0;a.afterRelease[key]=0;}expect(()=>validate(e)).toThrow('trial');}
});
it('LMR07: rejects rounding the 53-byte excess away or inventing a completed second attempt',()=>{
 const e=structuredClone(r.evidence),p=e.rows.find((p:any)=>p.role==='authority-broker'&&p.boundary==='schema-upper'&&p.recipe==='window-4-with-2048-metadata');
 p.audit.withinLimit=true;p.audit.combinedPeak=1048576;expect(()=>validate(e)).toThrow('audit');
 const d=structuredClone(r.evidence),q=d.rows.find((p:any)=>p.role==='authority-broker'&&p.boundary==='schema-upper'&&p.recipe==='window-4-with-2048-metadata');q.trial.attempts.push({...q.trial.attempts[0],index:1,error:null});expect(()=>validate(d)).toThrow('trial');
});
it('LMR08: rejects promoting a conditional fit to an established three-slot bound or LG-0 adoption',()=>{
 for(const field of ['activeWindowBoundEstablished','lg0ExitEstablished','nextStageAdmitted','productionAdopted']){const e=structuredClone(r.evidence);e.scope[field]=true;expect(()=>validate(e)).toThrow('scope');}
 expect(r.summary.actualConsumerIntegrated).toBe(false);expect(r.summary.threeSlotBoundEstablished).toBe(false);expect(r.summary.lg0ExitEstablished).toBe(false);
});
it('LMR09: rejects source line movement with rewritten metadata and the same source hash',()=>{
 const locations=structuredClone(r.lifetimeLocations);locations[0].line++;const sources=Object.fromEntries(CAPACITY_LIFETIMES.map(x=>[x.source,readFileSync(x.source,'utf8')]));
 expect(()=>validateCapacityLifetimeLocations(locations,sources)).toThrow('lifetime_location');
 const e=structuredClone(r.evidence);e.lifetimes.find((x:any)=>x.id==='transient-fact-command').candidate='new-saving';expect(()=>validate(e)).toThrow('scope');
});
it('LMR10: preserves all twenty future consumer conditions as unexecuted and refuses malformed cost values',()=>{
 expect(r.regressionConditions.map((x:any)=>x.id)).toEqual(Array.from({length:20},(_,i)=>'CLM'+String(i+1).padStart(2,'0')));
 expect(r.regressionConditions.every((x:any)=>x.status==='planned'&&!x.executed)).toBe(true);
 for(const n of [NaN,Infinity,-1]){const e=structuredClone(r.evidence);e.rows[0].audit.combinedPeak=n;expect(()=>validate(e)).toThrow('audit');}
});
