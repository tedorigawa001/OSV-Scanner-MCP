// Published storage metadata replay. Native filesystem reads are not repeated here.
import {hash} from './gradleBtaDriverProof.mjs';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b),bad=()=>{throw Error('bta_offer_storage_invalid');};
const token=x=>typeof x==='string'&&/^key-[1-9][0-9]*$/.test(x),digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const flat=x=>typeof x==='string'&&x.length>0&&!/[\\/\0:]/.test(x)&&x!=='.'&&x!=='..';
function view(v){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['staging','evidence'].includes(k)))bad();
 for(const root of Object.values(v)){
  if(!Array.isArray(root.ancestors)||!Array.isArray(root.entries)||root.ancestors.length<1||root.ancestors.length>64||root.entries.length>17)bad();
  for(const a of root.ancestors)if(typeof a.path!=='string'||a.path.startsWith('/')||a.path.split('/').some(x=>x==='..')||!['directory','file','symlink','other'].includes(a.kind)||!token(a.key))bad();
  const names=[];for(const e of root.entries){if(!flat(e.name)||!['file','directory','symlink','other'].includes(e.kind)||!token(e.key)||!Number.isSafeInteger(e.size)||e.size<0||('sha256'in e&&!digest(e.sha256)))bad();names.push(e.name);}
  if(!eq(names,[...names].sort())||new Set(names).size!==names.length)bad();
 }
}
const identities=root=>({ancestors:root.ancestors,entries:root.entries.map(f=>({name:f.name,kind:f.kind,key:f.key}))});
export function verifyStorageAudit(r,repeatSeeds){
 if(!Array.isArray(r.storageSeals)||!Array.isArray(r.storageChecks)||!Array.isArray(r.storageWriteProbes)||!Array.isArray(r.storageEntryProbes))throw Error('bta_offer_record_invalid');
 const seals=new Map();
 for(const ledger of r.storageSeals){
  if(seals.has(ledger.invocation)||repeatSeeds[ledger.invocation])bad();seals.set(ledger.invocation,ledger.view);view(ledger.view);
  const e=r.envelopes.find(e=>e.invocation===ledger.invocation),seal=e?.phases.find(x=>x.phase==='seal'&&x.outcome==='success')?.evidence;
  if(!seal||!eq(Object.keys(ledger.view),['staging','evidence']))bad();
  for(const role of ['staging','evidence']){
   const root=ledger.view[role],column=role==='staging'?'path':'baselinePath',base=seal.files[0][column].split('/').slice(0,-1).join('/');
   const chain=[''];let cursor='';for(const component of base.split('/')){cursor=cursor?cursor+'/'+component:component;chain.push(cursor);}
   if(!eq(root.ancestors.map(x=>x.path),chain)||root.ancestors.some(x=>x.kind!=='directory'))bad();
   const expected=seal.files.map(f=>({name:f.id,size:f.size,sha256:f.sha256}));
   if(root.entries.some(x=>x.kind!=='file')||!eq(root.entries.map(x=>({name:x.name,size:x.size,sha256:x.sha256})),expected))bad();
  }
 }
 let refusals=0,calls=0;
 for(const e of r.envelopes){
  const rows=r.storageChecks.filter(x=>x.invocation===e.invocation),owner=repeatSeeds[e.invocation]??e.invocation,base=seals.get(owner);
  if(e.producerState==='unavailable'){if(rows.length)bad();continue;}
  const end=phase=>e.phases.find(x=>x.phase===phase&&x.outcome!=='begin'),hasCall=e.phases.some(x=>x.phase==='call'&&x.outcome==='begin');
  const expected=[];
  if(!repeatSeeds[e.invocation])expected.push(end('seal')?.outcome==='failure'&&e.invocation!=='storage-entry-budget'?'seal:write':'seal:checkpoint');
  if(end('binding')?.outcome==='success'&&(end('precheck')?.outcome==='success'||!['binding_mismatch','ic_state_mismatch'].includes(e.failureReason)&&e.invocation!=='source-changed'))expected.push('precheck:checkpoint');
  if(end('call')?.outcome==='success')expected.push('postcheck:checkpoint');
  if(e.phases.some(x=>x.phase==='capture')){
   expected.push('capture:before');
   const after=e.failurePhase!=='capture'||['capture-after-change','capture-evidence-after','capture-path-after','capture-extra-after'].includes(e.invocation);
   if(after)expected.push('capture:after');
  }
  if(!eq(rows.map(x=>x.phase+':'+x.point),expected))bad();
  if(!base&&end('seal')?.outcome!=='failure')bad();
  for(let i=0;i<rows.length;i++){
   const row=rows[i],limit=e.invocation==='storage-total-budget'?1024:128*1024**2,entryLimit=e.invocation==='storage-entry-budget'?1:16;
   if(row.owner!==owner||row.maxFileBytes!==32*1024**2||row.maxTotalBytes!==limit||row.maxEntries!==entryLimit||!Number.isSafeInteger(row.fileReads)||row.fileReads<0||row.fileReads>4||!Number.isSafeInteger(row.writtenBytes)||row.writtenBytes<0||row.writtenBytes>limit)bad();
   if(!Number.isSafeInteger(row.writeAttempts)||row.writeAttempts<0||row.writeAttempts>4||!Array.isArray(row.enumerations)||row.enumerations.length>4)bad();
   for(const scan of row.enumerations)if(!['staging','evidence'].includes(scan.role)||scan.maxEntries!==row.maxEntries||!Number.isInteger(scan.count)||scan.count<0||scan.count>row.maxEntries+1)bad();
   const atCall=calls+(hasCall&&['postcheck','capture'].includes(row.phase)?1:0);if(row.callsBefore!==atCall||row.callsAfter!==atCall)bad();
   if(row.reason===null){
    if(row.errorKind!==null||row.fileReads!==4||row.observed!==null||!base||row.observedSha256!==hash(JSON.stringify(base))||!eq(row.enumerations.map(x=>[x.role,x.count]),[['staging',2],['evidence',2],['staging',2],['evidence',2]]))bad();
   }else{
    if(i!==rows.length-1||row.phase!==e.failurePhase||row.reason!==e.failureReason||typeof row.errorKind!=='string')bad();refusals++;
    if(row.point==='write'){
     if(row.phase!=='seal'||!['storage_failed','budget_exceeded','path_invalid'].includes(row.reason)||row.enumerations.length!==0)bad();
     if(row.reason==='path_invalid'){
      view(row.observed);if(row.observedSha256!==hash(JSON.stringify(row.observed))||row.writeAttempts!==0||row.writtenBytes!==0||row.fileReads!==0||row.attemptedSize!==0||!Object.values(row.observed).some(root=>root.ancestors.some(x=>x.kind!=='directory')))bad();
     }else if(row.observed!==null||row.observedSha256!==null)bad();
     if(row.reason==='storage_failed'&&(row.errorKind!=='FileAlreadyExistsException'||row.fileReads!==1||row.writtenBytes!==row.attemptedSize))bad();
     if(row.reason==='budget_exceeded'&&row.writtenBytes+2*row.attemptedSize<=row.maxTotalBytes)bad();
    }else{
     view(row.observed);if(row.observedSha256!==hash(JSON.stringify(row.observed)))bad();
     const roots=Object.values(row.observed),entries=roots.flatMap(x=>x.entries);
     if(row.reason!=='stale'&&row.fileReads!==0)bad();
     if(row.reason==='path_invalid'&&!roots.some(x=>x.ancestors.some(a=>a.kind!=='directory')||x.entries.some(f=>f.kind!=='file')))bad();
     if(row.reason==='budget_exceeded'&&!row.enumerations.some(x=>x.count>x.maxEntries)&&!roots.some(x=>x.entries.length>row.maxEntries)&&!entries.some(x=>x.size>row.maxFileBytes)&&entries.reduce((n,f)=>n+f.size,0)<=row.maxTotalBytes)bad();
     if(row.reason==='storage_inventory_mismatch'&&!roots.some(x=>!eq(x.entries.map(f=>f.name),['library.snapshot','stdlib.snapshot'])))bad();
     if(row.reason==='storage_identity_mismatch'&&(!base||!['staging','evidence'].some(role=>row.observed[role]&&!eq(identities(row.observed[role]),identities(base[role])))))bad();
     if(row.reason==='stale'&&(!base||row.fileReads<1||!['staging','evidence'].some(role=>row.observed[role]?.entries.some(f=>f.sha256&&f.sha256!==base[role].entries.find(b=>b.name===f.name)?.sha256))))bad();
    }
   }
  }
  if(hasCall)calls++;
 }
 if(r.storageChecks.some(x=>!r.envelopes.some(e=>e.invocation===x.invocation)))bad();
 const expectedSeals=r.envelopes.filter(e=>e.phases.some(x=>x.phase==='seal'&&x.outcome==='success')&&!repeatSeeds[e.invocation]).map(e=>e.invocation);
 if(!eq([...seals.keys()],expectedSeals))bad();
 const writes=['staging-before-write-symlink','evidence-before-write-symlink','parent-before-write-symlink'];
 if(!eq(r.storageWriteProbes.map(p=>p.invocation),writes))bad();
 for(const probe of r.storageWriteProbes){
  if(probe.writeAttempts!==0||probe.writtenBytes!==0||probe.fileReads!==0||!eq(probe.before,probe.after)||!eq(probe.before,[{path:'sentinel.txt',size:9,sha256:hash('unchanged')}]))bad();
  const rows=r.storageChecks.filter(x=>x.invocation===probe.invocation);if(rows.length!==1||rows[0].point!=='write'||rows[0].reason!=='path_invalid')bad();
 }
 const crowded=['staging-many-entries','evidence-many-entries'];
 if(!eq(r.storageEntryProbes.map(p=>p.invocation),crowded))bad();
 for(const probe of r.storageEntryProbes){
  if(probe.createdEntries!==200||probe.originalEntries!==2)bad();
  const last=r.storageChecks.filter(x=>x.invocation===probe.invocation).at(-1);
  if(last.reason!=='budget_exceeded'||last.fileReads!==0||last.enumerations.at(-1)?.count!==17||last.enumerations.at(-1)?.maxEntries!==16)bad();
 }
 return {storageBoundaryRejections:refusals,prewriteSymlinkRefusals:r.storageWriteProbes.length,boundedEnumerationRefusals:r.storageEntryProbes.length,outsideStorageWrites:0};
}
