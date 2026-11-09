import {createHash,createPublicKey,verify} from 'node:crypto';
const need=(v,r)=>{if(!v)throw Error('lb0_record_'+r);};
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const modes=['full-reference','bound-live'],roles=['reader','authority-broker'],apis=['aux.ReadSourceDescriptor','aux.ReadSealedSource','aux.ReadSourceRanges'];
export const LB0_SCOPE={fixtureRuntimeImplemented:true,signedProtocolInputsVerified:true,fullVerificationBothModes:true,hashElisionImplemented:false,cwcPlannerConnected:false,signedSessionRuntimeConnected:false,productionRuntimeChanged:false,sourceStorageConnected:false,nativeIsolationVerified:false,externalApprovalServiceVerified:false,rssVerified:false,performanceMeasured:false,allCLBConditionsVerified:false};
function budget(b){need(b&&['work','initialization','wire','attempts','heldBytes','peakBytes','occupiedSlots','memoryLimit','workLimit'].every(k=>integer(b[k]))&&b.memoryLimit===1048576&&b.workLimit===156978&&b.work+b.initialization<=b.workLimit&&b.heldBytes<=b.peakBytes&&b.peakBytes<=b.memoryLimit&&b.wire<=163840,'budget');}
function state(s,phase='issued'){
 need(s&&modes.includes(s.mode)&&s.phase===phase&&integer(s.generation)&&s.generation>0&&integer(s.readers)&&integer(s.bytesHeld)&&s.deadline===4500&&s.issuedPurpose==='read','state');budget(s.budget);
 const keys=['fullChecks','wireIdentityHashes','challengeChecks','channelChecks','ownerChecks','liveChecks','purposeChecks','credentialChecks','copies','lookups','reclaims','byteReleases','publications','late'];
 need(s.metrics&&Object.keys(s.metrics).length===keys.length&&keys.every(k=>integer(s.metrics[k])),'metrics');
 need(Array.isArray(s.events)&&s.events.length>0&&s.events.length<=64,'event');
 const names=['call-issued','claim','draft','scope-ready','binding-closed','expired-or-refused','completed','lookup-removed','bytes-reclaimed','output','late-resolve','late-reject','dispatch-drained','reader-held','reader-still-held','reader-drained'];
 for(const [i,e]of s.events.entries())need(e.order===i+1&&names.includes(e.name)&&integer(e.readers)&&integer(e.bytes)&&integer(e.generation)&&e.generation>0,'event');
}
function terminal(s){state(s);need(s.state==='closed'&&s.generation===2&&s.lookupPresent===false&&s.readers===0&&s.bytesHeld===0&&s.reclaimed===true&&s.bindingState==='closed'&&s.claimHeld===true&&s.metrics.reclaims===1&&s.metrics.byteReleases===1,'terminal');
 const index=name=>{const indexes=s.events.flatMap((e,i)=>e.name===name?[i]:[]);need(indexes.length===1,'event');return indexes[0];};need(index('lookup-removed')<index('bytes-reclaimed'),'event');return index;
}
function rejectedPending(s,mode){
 state(s,'prepared');need(s.mode===mode&&s.state==='closed'&&s.generation===2&&s.lookupPresent===false&&s.readers===0&&s.bytesHeld===0&&s.reclaimed===true&&s.bindingState==='absent'&&s.claimHeld===false&&!s.pendingDispatch&&s.scratchReleased===true&&s.slotReleased===true,'pre-issuance');
 need(['fullChecks','wireIdentityHashes','channelChecks','ownerChecks','copies','lookups','publications','late'].every(k=>s.metrics[k]===0)&&s.metrics.reclaims===1&&s.metrics.byteReleases===1,'pre-issuance');
 need(canonical(s.events.map(e=>e.name))===canonical(['expired-or-refused','lookup-removed','bytes-reclaimed'])&&s.events.every(e=>e.generation===2&&e.readers===0)&&s.events[2].bytes===0,'pre-issuance');
 need(s.budget.heldBytes===393216&&s.budget.occupiedSlots===0&&s.budget.work===0&&s.budget.wire===0&&s.budget.attempts===1&&s.budget.initialization===12288,'pre-issuance');
}
export function validateLb0Record(r,expectedPolicyDigest,expectedSources){
 need(r&&r.schema==='cwc-lb0.validation.v1'&&r.date==='2026-11-10'&&r.testsPassed===36&&r.recordTestsPassed===9&&canonical(r.scope)===canonical(LB0_SCOPE),'scope');
 const m=r.measurement,a=m?.sourceApproval;need(m?.schema==='cwc-lb0.samples.v1'&&a?.envelope?.manifest?.schema==='cwc-lb0.approval.v1'&&a.envelope.manifest.policyDigest===expectedPolicyDigest,'approval');
 need(digest(a.registry)===a.pin&&digest(a.envelope.manifest)===a.registry.manifestDigest,'approval');
 const key=createPublicKey({key:Buffer.from(a.registry.operatorSpki,'base64'),format:'der',type:'spki'});need(key.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(a.envelope.manifest)),key,Buffer.from(a.envelope.signature,'base64')),'approval');
 for(const root of ['src/test/fixtures/gradleOwnedCwcLb0.ts','src/test/fixtures/gradleOwnedCwcLb0Contract.ts','src/test/fixtures/gradleOwnedCwcLb0Fixture.ts'])need(Object.hasOwn(a.envelope.manifest.sources,root),'sources');
 for(const [p,h]of Object.entries(a.envelope.manifest.sources))need(expectedSources[p]===h,'sources');
 need(canonical(r.sourceBindings)===canonical(expectedSources),'sources');
 need(Array.isArray(m.samples)&&m.samples.length===12,'closure');const seen=new Set();
 for(const s of m.samples){const k=[s.mode,s.role,s.api].join(':');need(modes.includes(s.mode)&&roles.includes(s.role)&&apis.includes(s.api)&&!seen.has(k),'closure');seen.add(k);
  need(s.sourceApprovalPin===a.pin&&/^[a-f0-9]{64}$/.test(s.commandDigest)&&s.commandDigest===s.expectedCommandDigest,'command');
  const before=s.scopeClosed,after=s.completed;state(before);const index=terminal(after);need(before.mode===s.mode&&after.mode===s.mode,'parity');
  need(before.state==='active'&&before.lookupPresent===true&&before.bytesHeld>0&&before.bindingState==='closed'&&before.metrics.publications===0,'before-final');
  need(after.metrics.publications===1&&after.metrics.late===0&&!after.pendingDispatch&&after.scratchReleased&&after.slotReleased,'completion');
  const c=after.metrics;need(c.fullChecks>0&&c.fullChecks===c.wireIdentityHashes&&c.fullChecks===c.channelChecks&&c.challengeChecks===c.fullChecks+1&&c.ownerChecks===c.fullChecks+c.copies&&c.copies===1&&c.liveChecks===c.purposeChecks&&c.credentialChecks===2*c.liveChecks&&c.liveChecks>=c.fullChecks&&c.fullChecks===before.metrics.fullChecks+1,'counts');
  need(index('output')<index('completed')&&index('completed')<index('lookup-removed'),'event');budget(s.budgetAfterClose);need(s.budgetAfterClose.heldBytes===0&&s.budgetAfterClose.occupiedSlots===0,'budget');
  for(const k of ['work','initialization','wire','attempts'])need(s.budgetAfterClose[k]===after.budget[k],'refund');
 }
 for(const role of roles)for(const api of apis){const pair=m.samples.filter(s=>s.role===role&&s.api===api);need(pair.length===2&&pair[0].commandDigest===pair[1].commandDigest&&canonical(pair[0].completed.metrics)===canonical(pair[1].completed.metrics),'parity');}
 need(Array.isArray(m.proofs)&&m.proofs.length===13,'proof-closure');const proofKeys=new Set();
 for(const p of m.proofs){const k=p.id+':'+p.mode;need(!proofKeys.has(k)&&modes.includes(p.mode),'proof-closure');proofKeys.add(k);
  if(p.id==='purpose'){terminal(p.after);need(p.after.metrics.publications===0,'proof');}
  else if(['timeout-resolve','timeout-reject'].includes(p.id)){
   terminal(p.expired);const index=terminal(p.drained);need(p.expired.mode===p.mode&&p.drained.mode===p.mode,'parity');need(p.expired.pendingDispatch&&!p.expired.scratchReleased&&!p.expired.slotReleased&&p.expired.budget.occupiedSlots===1,'quarantine');
   need(!p.drained.pendingDispatch&&p.drained.scratchReleased&&p.drained.slotReleased&&p.drained.budget.occupiedSlots===0&&p.drained.metrics.late===1&&p.drained.metrics.publications===0,'late');
   need(canonical({...p.drained.metrics,late:0})===canonical(p.expired.metrics),'late');
   need(index('bytes-reclaimed')<index(p.id==='timeout-resolve'?'late-resolve':'late-reject')&&index('dispatch-drained')>index('bytes-reclaimed'),'event');
   for(const k of ['work','initialization','wire','attempts'])need(p.expired.budget[k]===p.drained.budget[k],'refund');
  }else if(p.id==='reader-expiry'){
   const index=terminal(p.after),held=p.after.events.find(e=>e.name==='reader-still-held');need(p.mode==='full-reference'&&held?.readers===1&&held.bytes>0&&p.after.metrics.publications===0&&index('reader-still-held')<index('reader-drained')&&index('reader-drained')<index('bytes-reclaimed'),'reader');
  }else if(['buffer-copy','shared-buffer','receive-reentry'].includes(p.id)){
   const expected=p.id==='buffer-copy'?['inner','outer']:p.id==='shared-buffer'?['inner:value','inner:getter','inner:prototype','outer:value','outer:getter','outer:prototype']:['current','now','credential','purpose','permissions'];
   need(Array.isArray(p.cases)&&p.cases.length===expected.length,'review-closure');const cases=new Set();
   for(const c of p.cases){const key=p.id==='shared-buffer'?c.field+':'+c.shape:p.id==='buffer-copy'?c.field:c.hook;need(expected.includes(key)&&!cases.has(key),'review-closure');cases.add(key);rejectedPending(c.after,p.mode);
    if(p.id==='buffer-copy')need(c.callbacks===0&&c.aliases===0,'review-evidence');
    else if(p.id==='shared-buffer')need(c.getters===0,'review-evidence');
    else{need(c.innerReason==='source_binding'&&c.outerReason===c.innerReason&&c.issued===false&&canonical(c.repeated)===canonical(c.after),'review-evidence');budget(c.before);for(const k of ['work','initialization','wire','attempts'])need(c.before[k]===c.after.budget[k],'refund');}
   }
  }else need(false,'proof-closure');
 }
 for(const mode of modes)for(const id of ['purpose','timeout-resolve','timeout-reject','buffer-copy','shared-buffer','receive-reentry'])need(proofKeys.has(id+':'+mode),'proof-closure');need(proofKeys.has('reader-expiry:full-reference'),'proof-closure');
 return {samples:12,proofs:13,fullVerificationBothModes:true,testsPassed:36,recordTestsPassed:9,hashElisionImplemented:false,productionAdopted:false};
}
