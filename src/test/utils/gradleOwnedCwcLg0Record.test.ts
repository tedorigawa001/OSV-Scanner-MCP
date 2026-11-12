import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {it,expect} from 'vitest';
import {validateLg0Evidence,lg0MemoryBound,LG0_SCOPE} from '../fixtures/gradleOwnedCwcLg0Validation.mjs';
import {LG0_POLICY} from '../fixtures/gradleOwnedCwcLg0Contract.js';
import {cwcCMemory} from '../fixtures/gradleOwnedCwcC.js';
import {context} from '../fixtures/gradleOwnedCprASchema.js';
import {validateLg0Context} from '../fixtures/gradleOwnedCwcLg0Context.mjs';
import {designSection} from '../fixtures/gradleOwnedCgpS0Bound.mjs';
import {ownedDigest as hash} from '../../utils/gradleOwnedJson.js';
const r=JSON.parse(readFileSync(process.env.CWC_LG0_RECORD_PATH??'docs/validation/gradle-cwc-lg0-2026-11-12.json','utf8'));
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const validate=(e:any)=>validateLg0Evidence(e,r.sourceBindings,LG0_POLICY);
it('LGR01: binds current sources, policy, design section, verified test counts and original design evidence',()=>{
 expect(r.schema).toBe('cwc-lg0.validation.v2');expect(r.policy).toEqual(LG0_POLICY);
 for(const [p,h]of Object.entries(r.sourceBindings))expect(sha(readFileSync(p)),p).toBe(h);
 expect(sha(designSection(readFileSync(r.document,'utf8'),r.heading))).toBe(r.sectionDigest);
 expect(sha(readFileSync(r.designRecord.path))).toBe(r.designRecord.sha256);
 expect(r.testsPassed).toBe(30);expect(r.recordTestsPassed).toBe(14);expect(hash(r.evidence)).toBe(r.evidenceDigest);
 expect(validate(r.evidence)).toEqual(r.summary);
});
it('LGR02: independent layout reproduction agrees with the existing CWC-C recipe',()=>{
 for(const p of [...r.evidence.proofs,...r.evidence.layouts]){expect(validateLg0Context(p.context,p.role)).toEqual(context(p.context));expect(lg0MemoryBound(p.context)).toEqual(cwcCMemory(p.context));}
 expect(r.summary.peakByRole.reader).toBe(1039066);expect(r.summary.peakByRole['authority-broker']).toBe(1047808);
});
it('LGR03: retains all mode/role/case positions and refuses duplicates or missing failure rows',()=>{
 const missing=structuredClone(r.evidence);missing.proofs.pop();expect(()=>validate(missing)).toThrow('matrix');
 const duplicate=structuredClone(r.evidence);duplicate.proofs[1]=structuredClone(duplicate.proofs[0]);expect(()=>validate(duplicate)).toThrow('case_id');
});
it('LGR04: refuses successful publication or outcome/use/ACK on a refused call',()=>{
 for(const key of ['publications','signs','use','ack']){const e=structuredClone(r.evidence),p=e.proofs.find((p:any)=>p.scenario==='normal-then-revoke');for(const k of ['beforeClose','afterClose','afterDrain'])p[k].metrics[key]=1;expect(()=>validate(e)).toThrow('metrics');}
});
it('LGR05: refuses normal-scope release that invalidates the actual call or releases final wire',()=>{
 for(const fault of ['actual','wire','generation']){const e=structuredClone(r.evidence),p=e.proofs[0];
  if(fault==='actual')p.normalRelease.after.actual.open=false;if(fault==='wire')p.normalRelease.after.budget.heldBytes=0;if(fault==='generation')p.normalRelease.after.localGeneration=p.normalRelease.before.localGeneration;
  expect(()=>validate(e)).toThrow('normal_release');}
});
it('LGR06: refuses coordinated check/work/initialization decreases on failed cases',()=>{
 for(const fault of ['logical','initialization','work','wire','attempts']){const e=structuredClone(r.evidence),p=e.proofs.find((p:any)=>p.scenario==='reentry-caught');
  for(const k of ['beforeClose','afterClose','afterDrain']){if(fault==='logical'){p[k].metrics.logical=0;p[k].budget.work--;}else p[k].budget[fault]=0;}
  expect(()=>validate(e)).toThrow();}
});
it('LGR07: refuses early wire reclaim, late successful reads and missing one-time LG release',()=>{
 for(const fault of ['held','late','release']){const e=structuredClone(r.evidence),p=e.proofs.find((p:any)=>p.scenario==='timeout-pending');
  if(fault==='held')p.afterClose.budget.heldBytes=0;if(fault==='late')p.afterDrain.metrics.reads=1;if(fault==='release')for(const k of ['beforeClose','afterClose','afterDrain'])p[k].metrics.lgReleases=0;
  expect(()=>validate(e)).toThrow();}
});
it('LGR08: refuses erased retry spending or a reused successful prior envelope',()=>{
 for(const fault of ['init','prior']){const e=structuredClone(r.evidence),p=e.proofs.find((p:any)=>p.scenario==='retry');
  if(fault==='init')for(const k of ['beforeClose','afterClose','afterDrain'])p[k].budget.initialization=20480;else p.prior=p.beforeClose;
  expect(()=>validate(e)).toThrow();}
});
it('LGR09: refuses memory recipe changes and maximum-context admission claims',()=>{
 const e=structuredClone(r.evidence);e.proofs[0].memory.reserved-=4096;expect(()=>validate(e)).toThrow('memory_recipe');
 const maximum=structuredClone(r.evidence);maximum.layouts[0].status='admitted';expect(()=>validate(maximum)).toThrow('maximum_rejection');
});
it('LGR10: refuses smaller normalizer counters and modified signed source or signature evidence',()=>{
 for(const fault of ['work','signature','source']){const e=structuredClone(r.evidence),p=e.proofs[0];
  if(fault==='work')for(const k of ['beforeClose','afterClose','afterDrain'])p[k].normalizer.work.nodeVisits--;
  if(fault==='signature')p.approval.envelope.signature='A'.repeat(86)+'==';
  if(fault==='source')p.approval.envelope.manifest.sources['src/test/fixtures/gradleOwnedCwcLg0.ts']='f'.repeat(64);
  expect(()=>validate(e)).toThrow();}
});
it('LGR11: refuses extra fields, unknown cases, invalid numbers and wrong role context',()=>{
 for(const fault of ['extra','case','nan','negative','role']){const e=structuredClone(r.evidence),p=e.proofs[0];
  if(fault==='extra')e.valid=true;if(fault==='case')p.scenario='other';if(fault==='nan')p.afterDrain.budget.work=NaN;if(fault==='negative')p.afterDrain.budget.initialization=-1;if(fault==='role')p.context.peer.role='provider';
  expect(()=>validate(e)).toThrow();}
});
it('LGR12: fixture successes cannot promote incomplete maximum layout or later-stage adoption',()=>{
 expect(r.evidence.scope).toEqual(LG0_SCOPE);expect(r.summary.lg0ExitEstablished).toBe(false);expect(r.summary.maximumLayoutAdoptionEstablished).toBe(false);expect(r.summary.productionAdopted).toBe(false);expect(r.summary.nextStageAdmitted).toBe(false);
 for(const field of ['actualSession','actualSourceIO','performanceMeasured','productionAdopted']){const e=structuredClone(r.evidence);e.scope[field]=true;expect(()=>validate(e)).toThrow('scope');}
 const old=structuredClone(r.evidence);old.schema='cwc-lg0.evidence.v1';expect(()=>validate(old)).toThrow('scope');
});
function validateRehashed(evidence:any){
 const candidate={...r,evidence,evidenceDigest:hash(evidence)};
 expect(candidate.evidenceDigest).toBe(hash(candidate.evidence));return validate(candidate.evidence);
}
it('LGR13: rehashed maximum-context schema and role substitutions are refused in both modes',()=>{
 for(const mode of ['full-input','owned-input'])for(const role of ['reader','authority-broker'])for(const fault of ['extra','type','forbidden-role','role-label']){
  const e=structuredClone(r.evidence),layout=e.layouts.find((x:any)=>x.mode===mode&&x.role===role);
  if(fault==='extra')layout.context.extra='unapproved';
  if(fault==='type')layout.context.peer.keyEpoch='not-an-epoch';
  if(fault==='forbidden-role')layout.context.peer.role='provider';
  if(fault==='role-label')for(const x of e.layouts.filter((x:any)=>x.mode===mode))x.role=x.role==='reader'?'authority-broker':'reader';
  expect(()=>validateRehashed(e),`${mode}/${role}/${fault}`).toThrow(fault==='extra'||fault==='type'?'context_schema':'context_role');
 }
});
it('LGR14: rehashed maximum contexts must keep constructor binding semantics and every maximum field',()=>{
 for(const mode of ['full-input','owned-input'])for(const role of ['reader','authority-broker'])for(const fault of ['lineage','selected','provider-boot','catalog','head','short-cid','short-epoch','origin']){
  const e=structuredClone(r.evidence),c=e.layouts.find((x:any)=>x.mode===mode&&x.role===role).context;
  if(fault==='lineage')c.lineage.lineageId='wrong'.padEnd(128,'x');
  if(fault==='selected')c.snapshot.sha256='f'.repeat(64);
  if(fault==='provider-boot')c.provider.boot='f'.repeat(64);
  if(fault==='catalog')c.catalog='f'.repeat(64);
  if(fault==='head')c.binding.selected.head.revision=257;
  if(fault==='short-cid')c.endpointId='short';
  if(fault==='short-epoch')c.peer.keyEpoch=1;
  if(fault==='origin'){if(role==='authority-broker')delete c.origin;else c.origin={...c.peer};}
  const reason=fault==='head'?'context_schema':fault==='origin'?'context_role':fault==='short-cid'||fault==='short-epoch'?'maximum_input':'context_binding';
  expect(()=>validateRehashed(e),`${mode}/${role}/${fault}`).toThrow(reason);
 }
});
