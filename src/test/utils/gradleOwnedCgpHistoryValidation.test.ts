import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateHistoryReads} from '../fixtures/gradleOwnedCgpHistory.js';
import {validateCgpReport} from '../fixtures/gradleOwnedCgpReport.js';
it('binds before/after attribution to measured RPCs, counters, phases and raw bytes',async()=>{
 const summary=JSON.parse(await readFile('docs/validation/gradle-c3b-cgp-history-2026-11-05.json','utf8'));
 expect(summary.changedSources).toEqual(['src/utils/gradleOwnedStageStore.ts']);
 for(const report of summary.reports){const bytes=await readFile(report.path);expect(createHash('sha256').update(bytes).digest('hex')).toBe(report.sha256);const raw=JSON.parse(bytes.toString());expect(validateCgpReport(raw).go).toBe(false);
  expect(raw.executionSources).toEqual(report.executionSources);
  for(const [i,sample]of raw.samples.entries()){const groups=validateHistoryReads(sample);expect(groups).toEqual(report.samples[i].groups);expect(groups.reduce((n,g)=>n+g.count,0)).toBe(report.samples[i].totalReadCommitted);}
 }
 expect(summary.decision.readCommittedSkipped).toBe(0);expect(summary.decision.cg0Proceed).toBe(false);expect(summary.decision.cg3Proceed).toBe(false);
});

it('does not retroactively certify old rows that lack event identities',async()=>{
 const summary=JSON.parse(await readFile('docs/validation/gradle-c3b-cgp-history-2026-11-05.json','utf8'));
 expect(summary.legacyEvidence.length).toBe(2);
 for(const evidence of summary.legacyEvidence){const bytes=await readFile(evidence.path);expect(createHash('sha256').update(bytes).digest('hex')).toBe(evidence.sha256);const raw=JSON.parse(bytes.toString());for(const sample of raw.samples)expect(()=>validateHistoryReads(sample)).toThrow();}
});

it('rejects constant-count duplicate/missing reads in the newly measured native evidence',async()=>{
 const summary=JSON.parse(await readFile('docs/validation/gradle-c3b-cgp-history-2026-11-05.json','utf8'));
 for(const report of summary.reports){const raw=JSON.parse(await readFile(report.path,'utf8')),complete=raw.samples.find((s:any)=>s.outcome==='completed');expect(complete).toBeDefined();
  for(const renumber of [false,true]){const sample=structuredClone(complete),owner=sample.owners.find((o:any)=>o.role==='lineage-registry'),rows=owner.historyReads.reads;const total=rows.length,id=rows[1].eventId;rows[1]=structuredClone(rows[0]);if(renumber)rows[1].eventId=id;expect(rows.length).toBe(total);expect(()=>validateHistoryReads(sample)).toThrow('cgp_history_evidence_invalid');}
 }
});
