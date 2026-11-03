import {it,expect} from 'vitest';
import {ownedSha256,ownedDigest,canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
import {sealMigrationRecord,migrationRef,verifyMigrationBundle,migrationReferences,migrationAncestorDigest,type MigrationBinding} from '../fixtures/gradleOwnedMigration.js';
const h=(s:string)=>ownedSha256(s);
const binding:MigrationBinding={authorityId:'authority',lineageId:'lineage',migrationId:'migration',freezeId:'freeze',source:{format:'v1',generation:1,storeEpoch:h('source'),rootPairId:'source-pair',storeRootId:'source-store',checkpointRootId:'source-checkpoint',keyId:'source-key',checkpointIssuer:'source-cp',beforeHead:{revision:5,headDigest:h('before')}},target:{format:'v2',generation:2,storeEpoch:h('target'),rootPairId:'target-pair',storeRootId:'target-store',checkpointRootId:'target-checkpoint',keyId:'target-key',checkpointIssuer:'target-cp'},controlRootId:'control',policyDigest:h('policy'),profileDigest:h('profile'),clockDomain:'authority-clock'};
const roles=['operator','registry','source-authority','migration-verifier','compactor','coordinator','gc-executor','checkpoint','target-authority','policy','archive','clock'] as const;
const issuers=roles.map((role,i)=>({issuerId:role,keyId:role+'-key',role,key:Buffer.alloc(32,i+1),authorityId:binding.authorityId,lineageId:binding.lineageId,profileDigest:binding.profileDigest}));
const signer=(role:typeof roles[number])=>issuers.find(x=>x.role===role)!;
function fixture(change?:(body:any)=>void){
 const objects:Buffer[]=[];const add=(type:string,id:string,fields:any,role:typeof roles[number])=>{const body={schema:'osv-mcp.gradle-migration-control-body-v1',schemaVersion:1,recordType:type,id,binding:JSON.parse(canonicalOwnedJson(binding)),...fields};change?.(body);const bytes=sealMigrationRecord(body,signer(role));objects.push(bytes);return migrationRef(bytes);};
 const enrollment=add('source-enrollment','source',{sourceManifestDigest:h('source-manifest'),sourceCheckpointDigest:h('source-checkpoint')},'operator');
 const provision=add('target-provision','target',{newAndEmpty:true,provisionDigest:h('provision')},'operator');
 const start=add('start-authorization','start',{purpose:'start-only',sourceEnrollmentRef:enrollment,targetProvisionRef:provision,expectedRevision:0,validFrom:0,validUntil:1000,reservation:{commits:1,bytes:1024,entries:8},invalidatedSessions:[]},'operator');
 const requested=add('freeze-requested','requested',{startAuthorizationRef:start,previousRevision:0,revision:1,gate:'closed'},'registry');
 return {objects,add,enrollment,provision,start,requested,selection:{phase:'freeze-requested',requestRef:requested}};
}
it('verifies the exact authenticated closure for a freeze-requested migration without adopting it',()=>{
 const f=fixture(),result=verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects});expect(result).toMatchObject({phase:'freeze-requested',closureVerified:true,selectionCurrentVerified:false,backendEligible:false,physicalDeletionAuthorized:false});expect(result.records).toHaveLength(4);
});

const refKey=(r:any)=>canonicalOwnedJson([r.role,r.id]);
function completeFixture(phase='completed',change?:(body:any)=>void,splitBatches=false,largeInventory=false){
 const f=fixture(change),a=f.add;
 const result=a('source-freeze-result','freeze-result',{requestRef:f.requested,maintenance:'migration-freeze',validity:'migration-frozen',invalidatedSessions:[],resultDigest:h('invalidated')},'source-authority');
 const freeze=a('source-freeze-witness','freeze-witness',{resultRef:result,head:{revision:6,headDigest:h('frozen')},checkpointDigest:h('frozen-cp'),drained:true},'migration-verifier');
 const storeEntry={rootRole:'source-store',name:'journal.meta',size:10,sha256:h('journal'),fileIdentity:{device:'1',inode:'2',kind:'regular',nlink:1}},cpEntry={...storeEntry,rootRole:'source-checkpoint',name:'checkpoint-00000006.json',fileIdentity:{...storeEntry.fileIdentity,inode:'3'}};
 const entries=largeInventory?Array.from({length:8192},(_,i)=>({rootRole:i<4096?'source-checkpoint':'source-store',name:i===4096?'journal.meta':(i<4096?'checkpoint-':'blob-')+String(i).padStart(8,'0')+'x'.repeat(180),size:1,sha256:h('file-'+i),fileIdentity:{device:'1',inode:String(i+10),kind:'regular',nlink:1}})):[cpEntry,storeEntry];
 entries.sort((a,b)=>canonicalOwnedJson([a.rootRole,a.name])<canonicalOwnedJson([b.rootRole,b.name])?-1:1);
 const pages=[];for(let i=0;i<entries.length;i+=64)pages.push(a('inventory-page','page-'+i/64,{freezeRef:freeze,ordinal:i/64,entries:entries.slice(i,i+64)},'migration-verifier'));
 const ns=(sessionId:string)=>({originEpoch:binding.source.storeEpoch,sessionId}),describe=(sessionId:string)=>({...ns(sessionId),state:'closed',bindingDigest:h(sessionId+'binding'),scopeRoot:h(sessionId+'scopes'),terminalRoot:h(sessionId+'terminal'),reservationRoot:h(sessionId+'reservation'),recordRoot:h(sessionId+'records'),recordCount:1});
 const kept=describe('kept'),retired=describe('retired');
 const inventory=a('inventory-root','inventory',{freezeRef:freeze,pages,entryCount:entries.length,byteLength:entries.reduce((n,e)=>n+e.size,0),namespaces:[kept,retired],priorTombstones:0,carriedControlRefs:[]},'migration-verifier');
 if(phase==='frozen')return {...f,selection:{phase,freezeRef:freeze,inventoryRef:inventory}};
 const policy=a('policy-evidence','policy',{inventoryRef:inventory,policyDigest:binding.policyDigest,retentionMode:'explicit-release'},'policy');
 const hold=a('hold-evidence','hold',{inventoryRef:inventory,revision:1,held:[]},'registry');
 const time=a('time-evidence','time',{freezeRef:freeze,clockDomain:binding.clockDomain,tick:100},'clock');
 const archive=a('archive-receipt','archive',{inventoryRef:inventory,archiveId:'archive',originalClosureDigest:h('raw-archive'),readable:true,retained:true},'archive');
 const evidence={policyRef:policy,holdRef:hold,timeRef:time,archiveRef:archive};
 const intent=a('retirement-intent','intent',{inventoryRef:inventory,namespace:ns('retired'),sourceBindingDigest:retired.bindingDigest,sourceScopeRoot:retired.scopeRoot,sourceTerminalRoot:retired.terminalRoot,sourceReservationRoot:retired.reservationRoot,...evidence},'coordinator');
 const budget={keptSessions:1,tombstones:1,logicalBytes:1024,records:2,controlBytes:largeInventory?64*1024*1024:1024*1024};
 const plan=a('retention-plan','plan',{inventoryRef:inventory,keep:[ns('kept')],retire:[ns('retired')],intentRefs:[intent],retainedMaterialDigest:h('retained-material'),transformDigest:h('transform'),budget,...evidence,carriedControlRefs:[]},'coordinator');
 const release=a('release-authorization','release',{purpose:'retention-transform',planRef:plan,validFrom:0,validUntil:1000},'operator');
 if(phase==='prepared')return {...f,selection:{phase,planRef:plan,releaseRef:release}};
 const core=a('tombstone-core','core',{intentRef:intent,planRef:plan,releaseRef:release},'compactor');
 const imports=a('import-map','import-map',{planRef:plan,mappings:[{namespace:ns('kept'),disposition:'retained',sourceRecordRoot:kept.recordRoot,targetRecordRoot:kept.recordRoot,sourceRecordCount:1,targetRecordCount:1},{namespace:ns('retired'),disposition:'retired',sourceRecordRoot:retired.recordRoot,targetRecordRoot:core.sha256,sourceRecordCount:1,targetRecordCount:1}]},'compactor');
 const prior=f.objects.map(migrationRef).sort((a,b)=>refKey(a)<refKey(b)?-1:1);
 const base=a('compacted-base','base',{releaseRef:release,importMapRef:imports,tombstoneCoreRefs:[core],retainedNamespaceRoot:ownedDigest([ns('kept')]),tombstoneCoreRoot:ownedDigest([core]),retainedMaterialDigest:h('retained-material'),controlClosureRoot:migrationAncestorDigest(prior),budget,carriedControlRefs:[]},'compactor');
 const syncTarget=a('storage-sync-evidence','target-sync',{rootRole:'target',roots:[binding.target.storeRootId,binding.target.checkpointRootId],fileSyncDigest:h('files'),directorySyncDigest:h('directories'),complete:true},'checkpoint');
 const manifestDigest=h('target-manifest'),genesis=ownedDigest({domain:'journal-v2-genesis',authorityId:binding.authorityId,lineageId:binding.lineageId,generation:binding.target.generation,storeEpoch:binding.target.storeEpoch,manifestDigest,baseDigest:base.sha256});
 const checkpoint=a('target-checkpoint','target-genesis',{baseRef:base,manifestDigest,head:{revision:0,headDigest:genesis},syncRef:syncTarget},'checkpoint');
 const ready=a('target-ready','ready',{baseRef:base,planRef:plan,releaseRef:release,checkpointRef:checkpoint,manifestDigest,targetInventoryDigest:h('target-inventory'),closedAuditState:true,syncRef:syncTarget},'migration-verifier');
 if(phase==='ready')return {...f,selection:{phase,readyRef:ready}};
 const activationAuthorization=a('activation-authorization','activate',{purpose:'select-target',readyRef:ready,expectedRevision:4,...evidence,validFrom:0,validUntil:1000},'operator');
 const activation=a('activation-receipt','activated',{authorizationRef:activationAuthorization,previousRevision:4,revision:5,selected:'target'},'registry');
 if(phase==='selected-target')return {...f,selection:{phase,activationRef:activation}};
 const rank=(e:any)=>e.rootRole==='source-checkpoint'?2:e.name==='journal.meta'?1:0,ordered=[...entries].sort((a,b)=>rank(a)-rank(b)||(a.name<b.name?-1:1)),groups=largeInventory?Array.from({length:128},(_,i)=>ordered.slice(i*64,(i+1)*64)):splitBatches?[[storeEntry],[cpEntry]]:[[storeEntry,cpEntry]];
 const batchRefs=groups.map((entries,i)=>a('gc-batch-plan','batch-plan-'+i,{inventoryRef:inventory,ordinal:i,entries},'coordinator'));
 const gcAuthorization=a('gc-authorization','delete',{purpose:'delete-source',activationRef:activation,planRef:plan,inventoryRef:inventory,holdRef:hold,expectedRevision:5,batchRefs,validFrom:0,validUntil:1000},'operator');
 const barrier=a('gc-barrier','barrier',{authorizationRef:gcAuthorization,holdRef:hold,previousRevision:5,revision:6},'registry');
 if(phase==='deleting-source')return {...f,selection:{phase,barrierRef:barrier,progress:{state:'none'}}};
 const syncSource=a('storage-sync-evidence','source-sync',{rootRole:'source',roots:[binding.source.storeRootId,binding.source.checkpointRootId],fileSyncDigest:h('source-files'),directorySyncDigest:h('source-directories'),complete:true},'checkpoint');
 const doneRefs:any[]=[];for(const [i,group]of groups.entries()){
  const prepared=a('gc-batch-prepared','batch-'+i,{barrierRef:barrier,batchIndex:i,entries:group,...(i?{previousDoneRef:doneRefs[i-1]}:{})},'gc-executor');
  doneRefs.push(a('gc-batch-done','done-'+i,{preparedRef:prepared,deletedEntriesRoot:ownedDigest(group),syncRef:syncSource},'gc-executor'));
 }
 const completion=a('gc-completion','gc-completed',{barrierRef:barrier,doneRefs,remainingEntries:[],sourceRootIdentitiesRetained:true,archiveRetained:true,logicalUnlinkOnly:true},'gc-executor');
 if(phase==='gc-complete')return {...f,selection:{phase,completionRef:completion}};
 const retiredReceipt=a('retire-receipt','retired',{coreRef:core,baseRef:base,activationRef:activation,barrierRef:barrier,completionRef:completion},'migration-verifier');
 const finalization=a('target-finalization','finalize',{maintenance:'target-finalization',baseRef:base,completionRef:completion,retireReceiptRefs:[retiredReceipt],newBootId:'new-boot',oldActorsRestored:false,admission:'closed'},'target-authority');
 const syncFinal=a('storage-sync-evidence','final-sync',{rootRole:'target',roots:[binding.target.storeRootId,binding.target.checkpointRootId],fileSyncDigest:h('final-files'),directorySyncDigest:h('final-directories'),complete:true},'checkpoint');
 const finalCheckpoint=a('target-final-checkpoint','final-checkpoint',{finalizationRef:finalization,head:{revision:1,headDigest:h('final-head')},syncRef:syncFinal},'checkpoint');
 const completed=a('completion-receipt','completed',{finalizationRef:finalization,checkpointRef:finalCheckpoint,previousRevision:6,revision:7,selected:'target',admission:'permitted'},'registry');
 return {...f,selection:{phase:'completed',completionRef:completed}};
}
for(const phase of ['frozen','prepared','ready','selected-target','deleting-source','gc-complete','completed'])it('closes the typed control graph at phase '+phase,()=>{
 const f=completeFixture(phase),result=verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects});expect(result.phase).toBe(phase);expect(result.records).toHaveLength(f.objects.length);expect(result.physicalDeletionAuthorized).toBe(false);
});

it('rejects signed keep/retire overlap even after every dependent ref is regenerated',()=>{
 const f=completeFixture('completed',b=>{if(b.recordType==='retention-plan')b.keep.push(...b.retire);});expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('namespace_invalid');
});
it('rejects a signed GC entry outside the fixed inventory even with consistent envelope refs',()=>{
 const f=completeFixture('completed',b=>{if(b.recordType==='gc-batch-plan')b.entries[0]={...b.entries[0],name:'outside.bin'};});expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('gc_scope_invalid');
});

const inconsistent:[string,string,(b:any)=>void][]=[
 ['source-freeze-result','invalidated set',b=>b.invalidatedSessions=[{originEpoch:binding.source.storeEpoch,sessionId:'extra'}]],
 ['source-freeze-witness','freeze revision',b=>b.head.revision=5],
 ['inventory-page','page ordinal',b=>b.ordinal=1],
 ['inventory-root','inventory count',b=>b.entryCount++],
 ['inventory-root','inventory bytes',b=>b.byteLength++],
 ['inventory-root','duplicate pages',b=>b.pages.push(b.pages[0])],
 ['inventory-root','duplicate namespace',b=>b.namespaces.push(b.namespaces[0])],
 ['policy-evidence','policy binding',b=>b.policyDigest=h('other')],
 ['time-evidence','clock domain',b=>b.clockDomain='other-clock'],
 ['retirement-intent','source terminal root',b=>b.sourceTerminalRoot=h('other')],
 ['hold-evidence','held retirement',b=>b.held=[{originEpoch:binding.source.storeEpoch,sessionId:'retired'}]],
 ['retention-plan','intent coverage',b=>b.intentRefs=[]],
 ['retention-plan','session budget',b=>b.budget.keptSessions=0],
 ['import-map','source record root',b=>b.mappings[0].sourceRecordRoot=h('other')],
 ['import-map','target record root',b=>b.mappings[0].targetRecordRoot=h('other')],
 ['import-map','duplicate mapping',b=>b.mappings.push(b.mappings[0])],
 ['compacted-base','ancestor closure root',b=>b.controlClosureRoot=h('other')],
 ['compacted-base','namespace root',b=>b.retainedNamespaceRoot=h('other')],
 ['compacted-base','tombstone root',b=>b.tombstoneCoreRoot=h('other')],
 ['compacted-base','retained material',b=>b.retainedMaterialDigest=h('other')],
 ['compacted-base','base budget',b=>b.budget.logicalBytes++],
 ['storage-sync-evidence','sync root identity',b=>{if(b.id==='target-sync')b.roots[0]='other-root';}],
 ['target-checkpoint','genesis',b=>b.head.headDigest=h('other')],
 ['target-ready','manifest',b=>b.manifestDigest=h('other')],
 ['activation-receipt','activation CAS',b=>b.revision++],
 ['gc-barrier','barrier CAS',b=>b.previousRevision++],
 ['gc-batch-prepared','batch ordinal',b=>b.batchIndex=1],
 ['gc-batch-prepared','batch contents',b=>b.entries[0].size++],
 ['gc-batch-done','deleted entry root',b=>b.deletedEntriesRoot=h('other')],
 ['gc-completion','done coverage',b=>b.doneRefs.push(b.doneRefs[0])],
 ['target-final-checkpoint','final revision',b=>b.head.revision=0],
 ['completion-receipt','completion CAS',b=>b.revision=b.previousRevision],
];
for(const [type,label,change]of inconsistent)it('rejects authenticated '+label+' after consistent ref re-signing',()=>{
 const f=completeFixture('completed',b=>{if(b.recordType===type)change(b);});expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow(/migration_control_/);
});
it('does not complete a tombstone from its core alone when the retire receipt is absent',()=>{
 const f=completeFixture('completed',b=>{if(b.recordType==='target-finalization')b.retireReceiptRefs=[];});f.objects.splice(f.objects.findIndex(b=>JSON.parse(b.toString()).body.recordType==='retire-receipt'),1);expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('retirement_incomplete');
});

import {createHmac} from 'node:crypto';
const rawSeal=(body:any,role:typeof roles[number]='operator',extra:any={})=>{const i=signer(role),payload={schema:'osv-mcp.gradle-migration-control-envelope-v1',issuerId:i.issuerId,keyId:i.keyId,issuerRole:role,body,...extra};return Buffer.from(canonicalOwnedJson({...payload,mac:createHmac('sha256',i.key).update(canonicalOwnedJson(payload)).digest('hex')}));};
function subset(f:ReturnType<typeof fixture>|ReturnType<typeof completeFixture>,selection:any){const map=new Map(f.objects.map(bytes=>{const body=JSON.parse(bytes.toString()).body;return [refKey({role:body.recordType,id:body.id}),{bytes,body}] as const;})),seen=new Set<string>(),pending=migrationReferences(selection);while(pending.length){const r=pending.pop()!,key=refKey(r);if(seen.has(key))continue;seen.add(key);pending.push(...migrationReferences(map.get(key)!.body));}return {binding,issuers,selection,objects:[...seen].map(k=>map.get(k)!.bytes)};}
it('handles prepared/done chaining across multiple GC batches without granting deletion',()=>{
 const f=completeFixture('completed',undefined,true),result=verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects});expect(result.physicalDeletionAuthorized).toBe(false);expect(result.records.filter(r=>r.ref.role==='gc-batch-done')).toHaveLength(2);
});
for(const state of ['prepared','done'] as const)it('validates the explicit deleting-source progress '+state,()=>{
 const f=completeFixture(),prepared=f.objects.map(migrationRef).find(r=>r.role==='gc-batch-prepared')!,done=f.objects.map(migrationRef).find(r=>r.role==='gc-batch-done')!,barrier=f.objects.map(migrationRef).find(r=>r.role==='gc-barrier')!;
 const input=subset(f,{phase:'deleting-source',barrierRef:barrier,progress:state==='prepared'?{state,preparedRef:prepared}:{state,doneRef:done}});expect(verifyMigrationBundle(input).phase).toBe('deleting-source');
});
it('verifies both pre-selection abort evidence forms without reviving a source',()=>{
 const f=fixture(),absent=f.add('freeze-absent','absence',{requestRef:f.requested,head:binding.source.beforeHead,drained:true,historyVerified:true,absent:true},'migration-verifier');expect(verifyMigrationBundle({binding,issuers,objects:f.objects,selection:{phase:'aborted-before-select',evidence:{state:'unfrozen',absenceRef:absent}}}).backendEligible).toBe(false);
 const frozen=completeFixture('frozen'),freeze=frozen.objects.map(migrationRef).find(r=>r.role==='source-freeze-witness')!;expect(verifyMigrationBundle(subset(frozen,{phase:'aborted-before-select',evidence:{state:'frozen',freezeRef:freeze}})).physicalDeletionAuthorized).toBe(false);
});
for(const fault of ['missing','orphan','duplicate','ref-digest','ref-size','ref-role','issuer','issuer-role','mac','unknown-field','purpose','noncanonical','duplicate-json','utf8'] as const)it('rejects malformed authenticated closure input '+fault,()=>{
 const f=fixture(),objects=[...f.objects],selection:any=JSON.parse(canonicalOwnedJson(f.selection));
 if(fault==='missing')objects.pop();if(fault==='duplicate')objects.push(objects[0]!);if(fault==='orphan'){const b=JSON.parse(objects[0]!.toString()).body;b.id='orphan';objects.push(rawSeal(b));}
 if(fault==='ref-digest')selection.requestRef.sha256=h('other');if(fault==='ref-size')selection.requestRef.byteLength++;if(fault==='ref-role')selection.requestRef.role='start-authorization';
 if(['issuer','issuer-role','mac','unknown-field','purpose'].includes(fault)){
  const index=fault==='purpose'?2:0,raw=JSON.parse(objects[index]!.toString());if(fault==='issuer')objects[index]=rawSeal(raw.body,'operator',{keyId:'unknown'});if(fault==='issuer-role')objects[index]=rawSeal(raw.body,'operator',{issuerRole:'coordinator'});if(fault==='unknown-field'){raw.body.refs=[];objects[index]=rawSeal(raw.body);}if(fault==='purpose'){raw.body.purpose='delete-source';objects[index]=rawSeal(raw.body);}if(fault==='mac'){raw.mac='1'.repeat(64);objects[index]=Buffer.from(canonicalOwnedJson(raw));}
 }
 if(fault==='noncanonical')objects[0]=Buffer.from(objects[0]!.toString()+'\n');if(fault==='duplicate-json')objects[0]=Buffer.from(objects[0]!.toString().replace('"keyId":','"keyId":"duplicate","keyId":'));if(fault==='utf8')objects[0]=Buffer.from([255]);
 expect(()=>verifyMigrationBundle({binding,issuers,selection,objects})).toThrow(/migration_control_/);
});
for(const field of ['authorityId','lineageId','migrationId','freezeId','policyDigest','profileDigest','clockDomain'] as const)it('rejects a signed record from another '+field,()=>{
 const f=fixture(b=>{if(b.recordType==='source-enrollment')b.binding[field]=field.endsWith('Digest')?h('other'):'other';});expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('binding_mismatch');
});
for(const kind of ['same-root','same-epoch','same-generation','unsafe-generation','source-pair'] as const)it('rejects invalid root/generation binding '+kind,()=>{
 const b=JSON.parse(canonicalOwnedJson(binding));if(kind==='same-root')b.target.storeRootId=b.source.storeRootId;if(kind==='same-epoch')b.target.storeEpoch=b.source.storeEpoch;if(kind==='same-generation')b.target.generation=b.source.generation;if(kind==='unsafe-generation'){b.source.generation=Number.MAX_SAFE_INTEGER;b.target.generation=Number.MAX_SAFE_INTEGER;}if(kind==='source-pair')b.target.rootPairId=b.source.rootPairId;
 const f=fixture();expect(()=>verifyMigrationBundle({binding:b,issuers,selection:f.selection,objects:f.objects})).toThrow('binding_invalid');
});
for(const kind of ['prior-tombstones','carried-records'] as const)it('rejects unsupported prior control evidence explicitly: '+kind,()=>{
 const f=completeFixture('completed',b=>{if(b.recordType==='inventory-root'){if(kind==='prior-tombstones')b.priorTombstones=1;else b.carriedControlRefs=[{role:'retire-receipt',id:'old',sha256:h('old'),byteLength:1}];}});expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('carry_unsupported');
});
it('rejects a structurally cyclic GC progress graph before chasing its invalid byte refs',()=>{
 const f=completeFixture('completed',b=>{if(b.recordType==='gc-batch-prepared')b.previousDoneRef={role:'gc-batch-done',id:'done-0',sha256:h('placeholder'),byteLength:1};});expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('cycle_invalid');
});
it('charges the longest shared reference path rather than only the first DFS visit',()=>{
 const f=completeFixture('frozen');expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects,limits:{depth:4}})).toThrow('budget_exceeded');expect(verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects,limits:{depth:6}}).closureVerified).toBe(true);
});
for(const kind of ['records','closureBytes','recordBytes','refs','nodes','pageEntries','batchEntries','entries'] as const)it('enforces aggregate or local budget '+kind,()=>{
 const f=completeFixture(),limits:any={};limits[kind]=kind==='records'?f.objects.length-1:kind==='closureBytes'?f.objects.reduce((n,b)=>n+b.length,0)-1:kind==='recordBytes'?Math.max(...f.objects.map(b=>b.length))-1:kind==='pageEntries'||kind==='batchEntries'||kind==='entries'?1:0;
 expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects,limits})).toThrow(/budget_exceeded|inventory_invalid/);
});
it('preflights aggregate bytes and object count before parsing invalid envelopes',()=>{
 const f=fixture(),raw=Buffer.alloc(1024*1024,120);expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:Array(65).fill(raw)})).toThrow('budget_exceeded');expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:Array(1025).fill(f.objects[0])})).toThrow('budget_exceeded');expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:[Buffer.alloc(1024*1024+1)]})).toThrow('budget_exceeded');
});
it('does not let returned data or issuer key buffers become mutable proof aliases',()=>{
 const f=fixture(),input={binding,issuers,selection:f.selection,objects:f.objects},result=verifyMigrationBundle(input);result.records[0]!.bytes.fill(0);result.records[0]!.body.binding.freezeId='mutated';expect(verifyMigrationBundle(input).closureRoot).toBe(result.closureRoot);
 const wrong=issuers.map(i=>({...i,key:Buffer.alloc(32,99)}));expect(()=>verifyMigrationBundle({...input,issuers:wrong})).toThrow('authentication_invalid');
});

it('rejects an alternative Done for the same prepared batch inside the selected progress chain',()=>{
 let first:any;const extra:Buffer[]=[];const f=completeFixture('completed',b=>{
  if(b.recordType==='gc-batch-done'&&b.id==='done-0')first=JSON.parse(canonicalOwnedJson(b));
  if(b.recordType==='gc-batch-prepared'&&b.batchIndex===1){const bytes=sealMigrationRecord({...first,id:'alternative-done'},signer('gc-executor'));extra.push(bytes);b.previousDoneRef=migrationRef(bytes);}
 },true);f.objects.push(...extra);expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('gc_progress_invalid');
});

for(const selection of [{phase:'completed'},{phase:'unknown'},{phase:'freeze-requested',requestRef:null},{phase:'aborted-before-select',evidence:{state:'frozen',absenceRef:{}}}])it('rejects missing or forbidden phase evidence '+canonicalOwnedJson(selection),()=>{
 const f=fixture();expect(()=>verifyMigrationBundle({binding,issuers,selection,objects:f.objects})).toThrow('schema_invalid');
});
for(const fault of ['restart-validity','symlink','hardlink','outside-name'] as const)it('rejects signed unsupported freeze or file identity '+fault,()=>{
 const f=completeFixture(),objects=[...f.objects],index=objects.findIndex(b=>JSON.parse(b.toString()).body.recordType===(fault==='restart-validity'?'source-freeze-result':'inventory-page')),body=JSON.parse(objects[index]!.toString()).body;
 if(fault==='restart-validity')body.validity='restarted';if(fault==='symlink')body.entries[0].fileIdentity.kind='symlink';if(fault==='hardlink')body.entries[0].fileIdentity.nlink=2;if(fault==='outside-name')body.entries[0].name='../escape';objects[index]=rawSeal(body,fault==='restart-validity'?'source-authority':'migration-verifier');expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects})).toThrow('schema_invalid');
});

it('represents an 8192-entry synthetic inventory through bounded pages and batch plan refs',()=>{
 const f=completeFixture('completed',undefined,false,true),result=verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects});expect(result.records.filter(r=>r.ref.role==='inventory-page')).toHaveLength(128);expect(result.records.filter(r=>r.ref.role==='gc-batch-plan')).toHaveLength(128);expect(result.records.filter(r=>r.ref.role==='gc-batch-done')).toHaveLength(128);expect(Math.max(...f.objects.map(b=>b.length))).toBeLessThan(1024*1024);expect(result.sourceTransformVerified).toBe(false);expect(result.storageDurabilityVerified).toBe(false);
},90000);

it('binds unfrozen abort evidence to the exact pre-freeze source head',()=>{
 const f=fixture(),absent=f.add('freeze-absent','absence',{requestRef:f.requested,head:{revision:binding.source.beforeHead.revision+1,headDigest:h('advanced')},drained:true,historyVerified:true,absent:true},'migration-verifier');
 expect(()=>verifyMigrationBundle({binding,issuers,objects:f.objects,selection:{phase:'aborted-before-select',evidence:{state:'unfrozen',absenceRef:absent}}})).toThrow('revision_invalid');
});
for(const [label,change]of [
 ['activation before the freeze request',(b:any)=>{if(b.recordType==='activation-authorization')b.expectedRevision=0;if(b.recordType==='activation-receipt'){b.previousRevision=0;b.revision=1;}}],
 ['GC barrier before the activation',(b:any)=>{if(b.recordType==='gc-authorization')b.expectedRevision=0;if(b.recordType==='gc-barrier'){b.previousRevision=0;b.revision=1;}}],
] as const)it('rejects a registry revision ordered '+label,()=>{
 const f=completeFixture('completed',change);expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('revision_invalid');
});
it('rejects two inventory entries claiming one nlink=1 file identity',()=>{
 const f=completeFixture('completed',b=>{if(['inventory-page','gc-batch-plan','gc-batch-prepared'].includes(b.recordType)){const s=b.entries.find((e:any)=>e.rootRole==='source-store'),c=b.entries.find((e:any)=>e.rootRole==='source-checkpoint');if(s&&c)c.fileIdentity={...s.fileIdentity};}});
 expect(()=>verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects})).toThrow('inventory_invalid');
});
it('judges the plan control budget by its ancestors, not by the selected phase',()=>{
 const total=(phase:string)=>completeFixture(phase).objects.reduce((n,b)=>n+b.length,0),mid=Math.floor((total('prepared')+total('completed'))/2);
 for(const phase of ['prepared','completed']){const f=completeFixture(phase,b=>{if(b.budget)b.budget.controlBytes=mid;});expect(verifyMigrationBundle({binding,issuers,selection:f.selection,objects:f.objects}).phase).toBe(phase);}
 const low=completeFixture('prepared',b=>{if(b.budget)b.budget.controlBytes=1;});expect(()=>verifyMigrationBundle({binding,issuers,selection:low.selection,objects:low.objects})).toThrow('budget_invalid');
});
