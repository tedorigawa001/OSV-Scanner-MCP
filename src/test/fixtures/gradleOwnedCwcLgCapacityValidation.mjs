import {createHash} from 'node:crypto';
import {capacityContext,capacityRow,CAPACITY_BOUNDARIES,CAPACITY_RECIPES,CAPACITY_SCOPE,CAPACITY_LIFETIMES} from './gradleOwnedCwcLgCapacity.mjs';
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const same=(a,b)=>canonical(a)===canonical(b),hash=v=>createHash('sha256').update(canonical(v)).digest('hex'),need=(ok,r)=>{if(!ok)throw Error('lg_capacity_'+r);};
export function capacityLifetimeLocations(sources){return CAPACITY_LIFETIMES.map(x=>{
 const text=sources[x.source];need(typeof text==='string'&&text.split(x.anchor).length===2,'source_anchor');
 const line=text.slice(0,text.indexOf(x.anchor)).split('\n').length;
 return {...x,line,sourceSha256:createHash('sha256').update(text).digest('hex')};
});}
export function validateCapacityLifetimeLocations(actual,sources){need(same(actual,capacityLifetimeLocations(sources)),'lifetime_location');}
/** Independent integer replay of the synthetic ticket procedure, not a CWC allocation trace. */
function trial(a,mode){
 const b={work:0,initialization:0,wire:0,attempts:0,heldBytes:0,peakBytes:0,occupiedSlots:0,memoryLimit:1048576,workLimit:156978};
 const reserve=(bytes,init=0,work=0,wire=0,slot=false)=>{
  if(b.heldBytes+bytes>1048576||b.work+b.initialization+init+work>156978||b.wire+wire>163840||slot&&(b.occupiedSlots>=4||b.attempts>=256))return false;
  b.heldBytes+=bytes;b.peakBytes=Math.max(b.peakBytes,b.heldBytes);b.initialization+=init;b.work+=work;b.wire+=wire;if(slot){b.occupiedSlots++;b.attempts++;}return true;
 };
 reserve(131072,4096);reserve(131072);b.heldBytes-=131072;const attempts=[];
 for(let index=0;index<2;index++){
  const labels=[],actor=a[a.worstActor];let failedRegion=null,slot=false;
  const steps=Object.entries(actor.regions).filter(([name,bytes])=>name!=='frames'&&bytes>0).map(([name,bytes])=>({label:'scope.'+name,bytes}));
  steps.push({label:'call-and-binding',bytes:106496,init:12288,work:57344,wire:57344,slot:true},{label:'lg',bytes:4096,init:4096},{label:'logical-gate',bytes:0,work:1});
  for(const s of steps){if(!reserve(s.bytes,s.init,s.work,s.wire,s.slot)){failedRegion=s.label;break;}labels.push(s.label);if(s.slot)slot=true;}
  const livePeak=b.heldBytes,beforeRelease={...b};b.heldBytes=131072;if(slot)b.occupiedSlots--;
  attempts.push({index,error:failedRegion?'codec_budget_exceeded':null,failedRegion,labels,livePeak,beforeRelease,afterRelease:{...b}});if(failedRegion)break;
 }
 b.heldBytes=0;
 return {mode,recipe:a.recipe,role:a.role,attempts,final:b,scope:{syntheticReservations:true,actualCwcConsumer:false,sourceReads:0,replyPublications:0,admitted:false}};
}
export function validateCapacityEvidence(e,baseline){
 need(e&&same(Object.keys(e).sort(),['schema','rows','lifetimes','scope'].sort())&&e.schema==='cwc-lg.capacity-evidence.v1','schema');
 need(same(e.scope,CAPACITY_SCOPE)&&same(e.lifetimes,CAPACITY_LIFETIMES),'scope');
 const originals=baseline.evidence.proofs.filter(p=>p.mode==='owned-input'&&p.scenario==='normal');
 need(originals.length===2&&new Set(originals.map(x=>x.role)).size===2&&originals.every(x=>['reader','authority-broker'].includes(x.role)),'baseline');
 need(Array.isArray(e.rows)&&e.rows.length===36,'matrix');let i=0;const seen=new Set();
 for(const original of originals)for(const mode of ['full-input','owned-input'])for(const boundary of CAPACITY_BOUNDARIES)for(const recipe of CAPACITY_RECIPES){
  const row=e.rows[i++],id=`${mode}/${original.role}/${boundary}/${recipe}`;
  need(row&&same(Object.keys(row).sort(),['id','mode','role','boundary','recipe','context','contextDigest','audit','trial'].sort())&&row.id===id&&!seen.has(id),'identity');seen.add(id);
  need(row.mode===mode&&row.role===original.role&&row.boundary===boundary&&row.recipe===recipe,'labels');
  const context=capacityContext(original.context,original.role,boundary);need(same(row.context,context)&&row.contextDigest===hash(context),'context');
  const audit=capacityRow(context,original.role,recipe);need(same(row.audit,audit),'audit');need(same(row.trial,trial(audit,mode)),'trial');
 }
 const rows=e.rows,upper=rows.filter(r=>r.mode==='owned-input'&&r.boundary==='schema-upper');
 return {rows:seen.size,arithmeticFits:rows.filter(r=>r.audit.withinLimit).length,
  syntheticCompleted:rows.filter(r=>r.trial.attempts.length===2&&r.trial.attempts.every(a=>a.error===null)).length,
  syntheticRefused:rows.filter(r=>r.trial.attempts.some(a=>a.error!==null)).length,
  schemaUpper:upper.map(r=>({role:r.role,recipe:r.recipe,peak:r.audit.combinedPeak,slack:1048576-r.audit.combinedPeak})),
  actualConsumerIntegrated:false,threeSlotBoundEstablished:false,lg0ExitEstablished:false,nextStageAdmitted:false,productionAdopted:false};
}
