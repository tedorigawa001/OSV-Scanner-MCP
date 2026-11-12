import {readFileSync} from 'node:fs';
import {beforeAll,it,expect} from 'vitest';
import {runWindowMatrix} from '../fixtures/gradleOwnedCwcLgWindow.js';
import {validateWindowEvidence,compareWindowReplay,windowHash,windowSourceLocations} from '../fixtures/gradleOwnedCwcLgWindowValidation.mjs';
const path=process.env.CWC_LG_WINDOW_RECORD_PATH??'docs/validation/gradle-cwc-lg-window-2026-11-12.json';
const record=JSON.parse(readFileSync(path,'utf8')),baseline=JSON.parse(readFileSync('docs/validation/gradle-cwc-lg-capacity-2026-11-12.json','utf8'));
let fresh:ReturnType<typeof runWindowMatrix>;
beforeAll(()=>{fresh=runWindowMatrix();},60000);
const validate=(e:any)=>{validateWindowEvidence(e,baseline);compareWindowReplay(e,fresh);};
const change=(fn:(e:any)=>void)=>{const e=structuredClone(record.evidence);fn(e);const changedDigest=windowHash(e);expect(changedDigest).not.toBe(record.evidenceDigest);expect(()=>validate(e)).toThrow();};
it('LMR21: source-bound evidence is accepted and agrees with a fresh execution',()=>{expect(record.evidenceDigest).toBe(windowHash(record.evidence));validate(record.evidence);});
it('LMR22: duplicate/missing events with count and sequence preserved are refused',()=>{change(e=>{const t=e.rows[1].attempts[0].trace;t[17]={...t[18],seq:17};});});
it('LMR23: early release before expected parse is refused even with all counters retained',()=>{change(e=>{const t=e.rows[1].attempts[0].trace;[t[13],t[14]]=[{...t[14],seq:13},{...t[13],seq:14}];});});
it('LMR24: coordinated command-width and trace reductions fail fresh replay',()=>{
 change(e=>{for(const r of e.rows)for(const a of r.attempts){a.commandWidths=a.commandWidths.map((n:number)=>n-1);for(const event of a.trace)if(event.kind==='allocated')event.bytes--;}});
});
it('LMR25: cooperative work/count reductions and deadline extension are refused',()=>{
 change(e=>{const a=e.rows[0].attempts[1];a.planSpent=156978;a.counts.parses=1;a.grant.steps.encode=0;});
 change(e=>{e.rows[1].attempts[0].grant.originalDeadline=4501;});
});
it('LMR26: reused identities, missing cases and promotion to adoption are refused',()=>{
 change(e=>{e.rows[0].attempts[1].grant.scopeId=e.rows[0].attempts[0].grant.scopeId;});
 change(e=>{e.rows.pop();});change(e=>{e.rows[1].attempts[0].scope.threeSlotBoundEstablished=true;});
});
it('LMR27: source-position movement is detected even after updating line metadata',()=>{
 const sources=Object.fromEntries(record.sourceLocations.map((x:any)=>[x.path,readFileSync(x.path,'utf8')]));
 expect(windowSourceLocations(sources)).toEqual(record.sourceLocations);
 const moved={...sources};moved[record.sourceLocations[0].path]='\n'+moved[record.sourceLocations[0].path];
 const locations=windowSourceLocations(moved);expect(locations).not.toEqual(record.sourceLocations);
 expect(locations[0].sourceSha256).not.toBe(record.sourceLocations[0].sourceSha256);
});
it('LMR28: retained four-reference witness cannot be relabeled as a three-slot proof',()=>{
 change(e=>{const a=e.rows[1].attempts[0];a.peakObserved=3;a.witness.pop();});
 change(e=>{e.rows[0].attempts[0].deniedBeforeParse=false;});
});
it('LMR29: unique grant IDs swapped between attempts are refused after digest renewal',()=>{
 for(const [index,row] of record.evidence.rows.entries()){
  if(row.boundary!=='normal')continue;
  for(const fields of [['scopeId'],['callId'],['scopeId','callId']]){
   const changed=structuredClone(record),[a,b]=changed.evidence.rows[index].attempts;
   for(const field of fields)[a.grant[field],b.grant[field]]=[b.grant[field],a.grant[field]];
   const ids=changed.evidence.rows.flatMap((r:any)=>r.attempts.flatMap((a:any)=>[a.grant.scopeId,a.grant.callId]));
   expect(new Set(ids).size).toBe(ids.length);
   changed.evidenceDigest=windowHash(changed.evidence);expect(changed.evidenceDigest).not.toBe(record.evidenceDigest);
   expect(()=>validateWindowEvidence(changed.evidence,baseline)).toThrow('lg_window_grant_scope_binding');
  }
 }
});
it('LMR30: fresh comparison rejects swapped grant identities on either side before normalization',()=>{
 expect(()=>compareWindowReplay(record.evidence,fresh)).not.toThrow();
 for(const [index,row] of record.evidence.rows.entries()){
  if(row.boundary!=='normal')continue;
  for(const side of ['recorded','replayed']){
   const recorded=structuredClone(record.evidence),replayed=structuredClone(fresh);
   const [a,b]=(side==='recorded'?recorded:replayed).rows[index].attempts;
   for(const field of ['scopeId','callId'])[a.grant[field],b.grant[field]]=[b.grant[field],a.grant[field]];
   expect(()=>compareWindowReplay(recorded,replayed)).toThrow('lg_window_grant_scope_binding');
  }
 }
});
