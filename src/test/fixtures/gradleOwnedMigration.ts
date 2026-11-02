/** M0/A local migration control contract. Data-only fixture: no registry, IO, migration or GC. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {canonicalOwnedJson,ownedDigest,ownedSha256,parseOwnedJson,OwnedManifestError} from '../../utils/gradleOwnedJson.js';
export const MIGRATION_LIMITS=Object.freeze({recordBytes:1024*1024,closureBytes:64*1024*1024,records:1024,refs:16384,depth:1024,nodes:1000000,entries:8192,pageEntries:64,batchEntries:64});
const id=z.string().min(1).max(1024),hash=z.string().regex(/^[a-f0-9]{64}$/),n=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),pos=n.positive(),head=z.object({revision:n,headDigest:hash}).strict();
const store={generation:pos,storeEpoch:hash,rootPairId:id,storeRootId:id,checkpointRootId:id,keyId:id,checkpointIssuer:id};
export const migrationBindingSchema=z.object({authorityId:id,lineageId:id,migrationId:id,freezeId:id,source:z.object({...store,format:z.enum(['v1','v2']),beforeHead:head}).strict(),target:z.object({...store,format:z.literal('v2')}).strict(),controlRootId:id,policyDigest:hash,profileDigest:hash,clockDomain:id}).strict();
export type MigrationBinding=z.infer<typeof migrationBindingSchema>;
export const migrationRoles=['operator','registry','source-authority','migration-verifier','compactor','coordinator','gc-executor','checkpoint','target-authority','policy','archive','clock'] as const;
type IssuerRole=typeof migrationRoles[number];
const refBase={id,sha256:hash,byteLength:pos.max(MIGRATION_LIMITS.recordBytes)};
const ref=<T extends string>(role:T)=>z.object({...refBase,role:z.literal(role)}).strict();
const namespace=z.object({originEpoch:hash,sessionId:id}).strict();
const reservation=z.object({commits:pos,bytes:pos,entries:pos}).strict();
const window={validFrom:n,validUntil:pos};
const opaqueName=z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(s=>s!=='.'&&s!=='..');
const entry=z.object({rootRole:z.enum(['source-store','source-checkpoint']),name:opaqueName,size:n.max(256*1024*1024),sha256:hash,fileIdentity:z.object({device:z.string().regex(/^[0-9]{1,32}$/),inode:z.string().regex(/^[0-9]{1,32}$/),kind:z.literal('regular'),nlink:z.literal(1)}).strict()}).strict();
const sourceNamespace=namespace.extend({state:z.literal('closed'),bindingDigest:hash,scopeRoot:hash,terminalRoot:hash,reservationRoot:hash,recordRoot:hash,recordCount:n.max(4096)}).strict();
const budgetSchema=z.object({keptSessions:n.max(256),tombstones:n.max(4096),logicalBytes:n.max(64*1024*1024),records:n.max(4096),controlBytes:n.max(64*1024*1024)}).strict();
const unsupportedCarry=z.array(z.object({...refBase,role:id}).strict()).max(1024);
const sync=ref('storage-sync-evidence');
const definitions={
 'source-enrollment':{issuer:'operator',fields:{sourceManifestDigest:hash,sourceCheckpointDigest:hash}},
 'target-provision':{issuer:'operator',fields:{newAndEmpty:z.literal(true),provisionDigest:hash}},
 'start-authorization':{issuer:'operator',fields:{purpose:z.literal('start-only'),sourceEnrollmentRef:ref('source-enrollment'),targetProvisionRef:ref('target-provision'),expectedRevision:n,validFrom:n,validUntil:pos,reservation,invalidatedSessions:z.array(namespace).max(256)}},
 'freeze-requested':{issuer:'registry',fields:{startAuthorizationRef:ref('start-authorization'),previousRevision:n,revision:pos,gate:z.literal('closed')}},
 'source-freeze-result':{issuer:'source-authority',fields:{requestRef:ref('freeze-requested'),maintenance:z.literal('migration-freeze'),validity:z.literal('migration-frozen'),invalidatedSessions:z.array(namespace).max(256),resultDigest:hash}},
 'source-freeze-witness':{issuer:'migration-verifier',fields:{resultRef:ref('source-freeze-result'),head,checkpointDigest:hash,drained:z.literal(true)}},
 'freeze-absent':{issuer:'migration-verifier',fields:{requestRef:ref('freeze-requested'),head,drained:z.literal(true),historyVerified:z.literal(true),absent:z.literal(true)}},
 'inventory-page':{issuer:'migration-verifier',fields:{freezeRef:ref('source-freeze-witness'),ordinal:n.max(127),entries:z.array(entry).min(1).max(64)}},
 'inventory-root':{issuer:'migration-verifier',fields:{freezeRef:ref('source-freeze-witness'),pages:z.array(ref('inventory-page')).min(1).max(128),entryCount:n.max(8192),byteLength:n.max(512*1024*1024),namespaces:z.array(sourceNamespace).max(256),priorTombstones:n.max(4096),carriedControlRefs:unsupportedCarry}},
 'policy-evidence':{issuer:'policy',fields:{inventoryRef:ref('inventory-root'),policyDigest:hash,retentionMode:z.literal('explicit-release')}},
 'hold-evidence':{issuer:'registry',fields:{inventoryRef:ref('inventory-root'),revision:n,held:z.array(namespace).max(256)}},
 'time-evidence':{issuer:'clock',fields:{freezeRef:ref('source-freeze-witness'),clockDomain:id,tick:n}},
 'archive-receipt':{issuer:'archive',fields:{inventoryRef:ref('inventory-root'),archiveId:id,originalClosureDigest:hash,readable:z.literal(true),retained:z.literal(true)}},
 'retirement-intent':{issuer:'coordinator',fields:{inventoryRef:ref('inventory-root'),namespace,sourceBindingDigest:hash,sourceScopeRoot:hash,sourceTerminalRoot:hash,sourceReservationRoot:hash,policyRef:ref('policy-evidence'),holdRef:ref('hold-evidence'),timeRef:ref('time-evidence'),archiveRef:ref('archive-receipt')}},
 'retention-plan':{issuer:'coordinator',fields:{inventoryRef:ref('inventory-root'),keep:z.array(namespace).max(256),retire:z.array(namespace).max(256),intentRefs:z.array(ref('retirement-intent')).max(256),retainedMaterialDigest:hash,transformDigest:hash,budget:budgetSchema,policyRef:ref('policy-evidence'),holdRef:ref('hold-evidence'),timeRef:ref('time-evidence'),archiveRef:ref('archive-receipt'),carriedControlRefs:unsupportedCarry}},
 'release-authorization':{issuer:'operator',fields:{purpose:z.literal('retention-transform'),planRef:ref('retention-plan'),...window}},
 'tombstone-core':{issuer:'compactor',fields:{intentRef:ref('retirement-intent'),planRef:ref('retention-plan'),releaseRef:ref('release-authorization')}},
 'import-map':{issuer:'compactor',fields:{planRef:ref('retention-plan'),mappings:z.array(z.object({namespace,disposition:z.enum(['retained','retired']),sourceRecordRoot:hash,targetRecordRoot:hash,sourceRecordCount:n.max(4096),targetRecordCount:n.max(4096)}).strict()).max(256)}},
 'compacted-base':{issuer:'compactor',fields:{releaseRef:ref('release-authorization'),importMapRef:ref('import-map'),tombstoneCoreRefs:z.array(ref('tombstone-core')).max(4096),retainedNamespaceRoot:hash,tombstoneCoreRoot:hash,retainedMaterialDigest:hash,controlClosureRoot:hash,budget:budgetSchema,carriedControlRefs:unsupportedCarry}},
 'storage-sync-evidence':{issuer:'checkpoint',fields:{rootRole:z.enum(['source','target','control']),roots:z.array(id).min(1).max(2),fileSyncDigest:hash,directorySyncDigest:hash,complete:z.literal(true)}},
 'target-checkpoint':{issuer:'checkpoint',fields:{baseRef:ref('compacted-base'),manifestDigest:hash,head,syncRef:sync}},
 'target-ready':{issuer:'migration-verifier',fields:{baseRef:ref('compacted-base'),planRef:ref('retention-plan'),releaseRef:ref('release-authorization'),checkpointRef:ref('target-checkpoint'),manifestDigest:hash,targetInventoryDigest:hash,closedAuditState:z.literal(true),syncRef:sync}},
 'activation-authorization':{issuer:'operator',fields:{purpose:z.literal('select-target'),readyRef:ref('target-ready'),expectedRevision:n,policyRef:ref('policy-evidence'),holdRef:ref('hold-evidence'),timeRef:ref('time-evidence'),archiveRef:ref('archive-receipt'),...window}},
 'activation-receipt':{issuer:'registry',fields:{authorizationRef:ref('activation-authorization'),previousRevision:n,revision:pos,selected:z.literal('target')}},
 'gc-batch-plan':{issuer:'coordinator',fields:{inventoryRef:ref('inventory-root'),ordinal:n.max(127),entries:z.array(entry).min(1).max(64)}},
 'gc-authorization':{issuer:'operator',fields:{purpose:z.literal('delete-source'),activationRef:ref('activation-receipt'),planRef:ref('retention-plan'),inventoryRef:ref('inventory-root'),holdRef:ref('hold-evidence'),expectedRevision:n,batchRefs:z.array(ref('gc-batch-plan')).min(1).max(128),...window}},
 'gc-barrier':{issuer:'registry',fields:{authorizationRef:ref('gc-authorization'),holdRef:ref('hold-evidence'),previousRevision:n,revision:pos}},
 'gc-batch-prepared':{issuer:'gc-executor',fields:{barrierRef:ref('gc-barrier'),batchIndex:n.max(127),entries:z.array(entry).min(1).max(64),previousDoneRef:ref('gc-batch-done').optional()}},
 'gc-batch-done':{issuer:'gc-executor',fields:{preparedRef:ref('gc-batch-prepared'),deletedEntriesRoot:hash,syncRef:sync}},
 'gc-completion':{issuer:'gc-executor',fields:{barrierRef:ref('gc-barrier'),doneRefs:z.array(ref('gc-batch-done')).min(1).max(128),remainingEntries:z.array(entry).length(0),sourceRootIdentitiesRetained:z.literal(true),archiveRetained:z.literal(true),logicalUnlinkOnly:z.literal(true)}},
 'retire-receipt':{issuer:'migration-verifier',fields:{coreRef:ref('tombstone-core'),baseRef:ref('compacted-base'),activationRef:ref('activation-receipt'),barrierRef:ref('gc-barrier'),completionRef:ref('gc-completion')}},
 'target-finalization':{issuer:'target-authority',fields:{maintenance:z.literal('target-finalization'),baseRef:ref('compacted-base'),completionRef:ref('gc-completion'),retireReceiptRefs:z.array(ref('retire-receipt')).max(4096),newBootId:id,oldActorsRestored:z.literal(false),admission:z.literal('closed')}},
 'target-final-checkpoint':{issuer:'checkpoint',fields:{finalizationRef:ref('target-finalization'),head,syncRef:sync}},
 'completion-receipt':{issuer:'registry',fields:{finalizationRef:ref('target-finalization'),checkpointRef:ref('target-final-checkpoint'),previousRevision:n,revision:pos,selected:z.literal('target'),admission:z.literal('permitted')}},
} satisfies Record<string,{issuer:IssuerRole;fields:z.ZodRawShape}>;
export type MigrationType=keyof typeof definitions;
export type MigrationRef={role:MigrationType;id:string;sha256:string;byteLength:number};
const base={schema:z.literal('osv-mcp.gradle-migration-control-body-v1'),schemaVersion:z.literal(1),id,binding:migrationBindingSchema};
const recordSchemas=new Map<string,z.ZodType<any>>(Object.entries(definitions).map(([recordType,d])=>[recordType,z.object({...base,recordType:z.literal(recordType),...d.fields}).strict()]));
const selectionSchema=z.discriminatedUnion('phase',[
 z.object({phase:z.literal('serving-source'),enrollmentRef:ref('source-enrollment')}).strict(),
 z.object({phase:z.literal('freeze-requested'),requestRef:ref('freeze-requested')}).strict(),
 z.object({phase:z.literal('frozen'),freezeRef:ref('source-freeze-witness'),inventoryRef:ref('inventory-root')}).strict(),
 z.object({phase:z.literal('prepared'),planRef:ref('retention-plan'),releaseRef:ref('release-authorization')}).strict(),
 z.object({phase:z.literal('ready'),readyRef:ref('target-ready')}).strict(),
 z.object({phase:z.literal('selected-target'),activationRef:ref('activation-receipt')}).strict(),
 z.object({phase:z.literal('deleting-source'),barrierRef:ref('gc-barrier'),progress:z.discriminatedUnion('state',[z.object({state:z.literal('none')}).strict(),z.object({state:z.literal('prepared'),preparedRef:ref('gc-batch-prepared')}).strict(),z.object({state:z.literal('done'),doneRef:ref('gc-batch-done')}).strict()])}).strict(),
 z.object({phase:z.literal('gc-complete'),completionRef:ref('gc-completion')}).strict(),
 z.object({phase:z.literal('completed'),completionRef:ref('completion-receipt')}).strict(),
 z.object({phase:z.literal('aborted-before-select'),evidence:z.discriminatedUnion('state',[z.object({state:z.literal('unfrozen'),absenceRef:ref('freeze-absent')}).strict(),z.object({state:z.literal('frozen'),freezeRef:ref('source-freeze-witness')}).strict()])}).strict(),
]);
const envelope=z.object({schema:z.literal('osv-mcp.gradle-migration-control-envelope-v1'),issuerId:id,keyId:id,issuerRole:z.enum(migrationRoles),body:z.unknown(),mac:hash}).strict();
export interface MigrationIssuer{issuerId:string;keyId:string;role:IssuerRole;key:Buffer;authorityId:string;lineageId:string;profileDigest:string}
type RecordBody={id:string;recordType:MigrationType;binding:MigrationBinding;[key:string]:any};
export class MigrationContractError extends Error{constructor(reason:string){super('migration_control_'+reason);}}
function check(ok:unknown,reason:string):asserts ok{if(!ok)throw new MigrationContractError(reason);}
// Comparing a paged aggregate is bounded by closureBytes, not by one record's size.
const same=(a:unknown,b:unknown)=>canonicalOwnedJson(a,MIGRATION_LIMITS.closureBytes)===canonicalOwnedJson(b,MIGRATION_LIMITS.closureBytes);
function parseBody(value:unknown):RecordBody{const type=z.object({recordType:z.string()}).passthrough().parse(value).recordType,schema=recordSchemas.get(type);check(schema,'format_unsupported');return schema.parse(value);}
function decode(bytes:Buffer,budget?:{nodes:number}){check(Buffer.isBuffer(bytes)&&bytes.length<=MIGRATION_LIMITS.recordBytes,'budget_exceeded');const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),raw=envelope.parse(parseOwnedJson(text,MIGRATION_LIMITS.recordBytes,budget));check(canonicalOwnedJson(raw,MIGRATION_LIMITS.recordBytes)===text,'authentication_invalid');return raw;}
export function sealMigrationRecord(input:unknown,issuer:MigrationIssuer):Buffer{const body=parseBody(input);check(issuer.role===definitions[body.recordType].issuer,'issuer_unapproved');check(Buffer.isBuffer(issuer.key)&&issuer.key.length===32,'configuration_invalid');const payload={schema:'osv-mcp.gradle-migration-control-envelope-v1',issuerId:issuer.issuerId,keyId:issuer.keyId,issuerRole:issuer.role,body};return Buffer.from(canonicalOwnedJson({...payload,mac:createHmac('sha256',issuer.key).update(canonicalOwnedJson(payload,MIGRATION_LIMITS.recordBytes)).digest('hex')},MIGRATION_LIMITS.recordBytes));}
/** Author-side bytes ref helper. Computing a ref does not authenticate or approve the object. */
export function migrationRef(bytes:Buffer):MigrationRef{const raw=decode(bytes),body=parseBody(raw.body);return {role:body.recordType,id:body.id,sha256:ownedSha256(bytes),byteLength:bytes.length};}
export function migrationReferences(value:unknown):MigrationRef[]{const out:MigrationRef[]=[];function visit(v:any){if(!v||typeof v!=='object')return;if('role'in v&&'id'in v&&'sha256'in v&&'byteLength'in v){out.push(v);return;}for(const child of Object.values(v))visit(child);}visit(value);return out;}
const name=(r:{role:string;id:string})=>canonicalOwnedJson([r.role,r.id]);
function validateBinding(b:MigrationBinding){const roots=[b.source.storeRootId,b.source.checkpointRootId,b.target.storeRootId,b.target.checkpointRootId,b.controlRootId];check(new Set(roots).size===5&&b.source.rootPairId!==b.target.rootPairId&&b.source.storeEpoch!==b.target.storeEpoch&&b.target.generation===b.source.generation+1&&Number.isSafeInteger(b.source.generation+1),'binding_invalid');}
export function migrationTargetGenesis(binding:MigrationBinding,manifestDigest:string,base:MigrationRef){return ownedDigest({domain:'journal-v2-genesis',authorityId:binding.authorityId,lineageId:binding.lineageId,generation:binding.target.generation,storeEpoch:binding.target.storeEpoch,manifestDigest:hash.parse(manifestDigest),baseDigest:base.sha256});}
export function migrationAncestorDigest(refs:MigrationRef[]){return ownedDigest({domain:'migration-control-ancestors-v1',records:[...refs].sort((a,b)=>name(a)<name(b)?-1:1)});}
export interface MigrationBundleInput{binding:MigrationBinding;issuers:MigrationIssuer[];selection:unknown;objects:Buffer[];limits?:Partial<Record<keyof typeof MIGRATION_LIMITS,number>>}
export function verifyMigrationBundle(input:MigrationBundleInput){try{return verify(input);}catch(e){if(e instanceof MigrationContractError)throw e;throw new MigrationContractError(e instanceof OwnedManifestError&&e.message.includes('budget_exceeded')?'budget_exceeded':'schema_invalid');}}
function verify(input:MigrationBundleInput){
 const binding=migrationBindingSchema.parse(input.binding);validateBinding(binding);const selection=selectionSchema.parse(input.selection),limits:Record<keyof typeof MIGRATION_LIMITS,number>={...MIGRATION_LIMITS};
 for(const [k,v]of Object.entries(input.limits??{})){check(Object.hasOwn(MIGRATION_LIMITS,k)&&Number.isSafeInteger(v)&&v>=0&&v<=MIGRATION_LIMITS[k as keyof typeof MIGRATION_LIMITS],'configuration_invalid');limits[k as keyof typeof MIGRATION_LIMITS]=v;}
 check(Array.isArray(input.objects)&&input.objects.length>0&&input.objects.length<=limits.records,'budget_exceeded');let totalBytes=0;for(const b of input.objects){check(Buffer.isBuffer(b)&&b.length<=limits.recordBytes,'budget_exceeded');totalBytes+=b.length;check(totalBytes<=limits.closureBytes,'budget_exceeded');}
 check(Array.isArray(input.issuers)&&input.issuers.length>0&&input.issuers.length<=32,'issuer_unapproved');const issuers=new Map<string,MigrationIssuer>();for(const i of input.issuers){id.parse(i.issuerId);id.parse(i.keyId);check(!issuers.has(i.keyId)&&Buffer.isBuffer(i.key)&&i.key.length===32&&i.authorityId===binding.authorityId&&i.lineageId===binding.lineageId&&i.profileDigest===binding.profileDigest,'issuer_unapproved');issuers.set(i.keyId,{...i,key:Buffer.from(i.key)});}
 const budget={nodes:limits.nodes},records=new Map<string,{body:RecordBody;ref:MigrationRef;refs:MigrationRef[];bytes:Buffer}>();let edges=0;
 for(const buffer of input.objects){const bytes=Buffer.from(buffer),raw=decode(bytes,budget),issuer=issuers.get(raw.keyId);check(issuer&&raw.issuerId===issuer.issuerId&&raw.issuerRole===issuer.role,'issuer_unapproved');const {mac,...p}=raw;check(timingSafeEqual(createHmac('sha256',issuer.key).update(canonicalOwnedJson(p,limits.recordBytes)).digest(),Buffer.from(mac,'hex')),'authentication_invalid');const body=parseBody(raw.body);check(definitions[body.recordType].issuer===issuer.role,'issuer_unapproved');check(same(body.binding,binding),'binding_mismatch');check(!body.carriedControlRefs?.length&&!(body.recordType==='inventory-root'&&body.priorTombstones>0),'carry_unsupported');const key=name({role:body.recordType,id:body.id});check(!records.has(key),'duplicate_record');const refs=migrationReferences(body);edges+=refs.length;check(edges<=limits.refs,'budget_exceeded');records.set(key,{body,ref:{role:body.recordType,id:body.id,sha256:ownedSha256(bytes),byteLength:bytes.length},refs,bytes});}
 const active=new Set<string>(),reached=new Set<string>(),heights=new Map<string,number>();
 function visit(root:MigrationRef){
  const stack:{key:string;cursor:number;entered:boolean}[]=[{key:name(root),cursor:0,entered:false}];
  while(stack.length){const frame=stack[stack.length-1]!,node=records.get(frame.key);check(node,'reference_missing');
   if(!frame.entered){check(!active.has(frame.key),'cycle_invalid');if(reached.has(frame.key)){stack.pop();continue;}active.add(frame.key);frame.entered=true;}
   if(frame.cursor<node.refs.length){const child=name(node.refs[frame.cursor++]!);check(!active.has(child),'cycle_invalid');if(!reached.has(child))stack.push({key:child,cursor:0,entered:false});}
   else {let height=0;for(const edge of node.refs)height=Math.max(height,1+heights.get(name(edge))!);check(height<=limits.depth,'budget_exceeded');heights.set(frame.key,height);active.delete(frame.key);reached.add(frame.key);stack.pop();}
  }
 }
 const roots=migrationReferences(selection);check(roots.length>0,'reference_missing');for(const r of roots)visit(r);check(reached.size===records.size,'orphan_record');for(const r of [...roots,...[...records.values()].flatMap(n=>n.refs)])check(same(r,records.get(name(r))!.ref),'reference_mismatch');
 const get=(r:MigrationRef)=>records.get(name(r))!.body;
 const nsKey=(v:any)=>canonicalOwnedJson([v.originEpoch,v.sessionId]);
 const inventoryEntries=(r:MigrationRef)=>get(r).pages.flatMap((p:MigrationRef)=>get(p).entries);
 const entryKey=(e:any)=>canonicalOwnedJson([e.rootRole,e.name]);
 const gcRank=(e:any)=>e.rootRole==='source-checkpoint'?2:e.name==='journal.meta'||e.name.startsWith('commit-')?1:0;
 const sortedGc=(entries:any[])=>[...entries].sort((a,b)=>gcRank(a)-gcRank(b)||(entryKey(a)<entryKey(b)?-1:entryKey(a)>entryKey(b)?1:0));

 const ordered=(keys:string[])=>keys.every((k,i)=>i===0||keys[i-1]!<k);
 const refSet=(a:MigrationRef[],b:MigrationRef[])=>new Set(a.map(name)).size===a.length&&same([...a].sort((a,b)=>name(a)<name(b)?-1:1),[...b].sort((a,b)=>name(a)<name(b)?-1:1));
 const inventoryNamespace=(r:MigrationRef)=>get(r).namespaces as any[];
 const matchesInventory=(record:any,inv:MigrationRef)=>check(same(record.inventoryRef,inv),'link_invalid');
 function checkEvidence(plan:RecordBody,auth:RecordBody){
  const policy=get(auth.policyRef),hold=get(auth.holdRef),archive=get(auth.archiveRef),time=get(auth.timeRef),inv=get(plan.inventoryRef);for(const evidence of [policy,hold,archive])matchesInventory(evidence,plan.inventoryRef);
  check(policy.policyDigest===binding.policyDigest&&same(time.freezeRef,inv.freezeRef)&&time.clockDomain===binding.clockDomain,'link_invalid');
  check(hold.revision>=get(plan.holdRef).revision&&!hold.held.some((h:any)=>plan.retire.some((r:any)=>nsKey(h)===nsKey(r))),'hold_invalid');
  check(archive.originalClosureDigest===get(plan.archiveRef).originalClosureDigest,'link_invalid');
 }
 function ancestorRefs(roots:MigrationRef[]){const seen=new Set<string>(),pending=[...roots];while(pending.length){const r=pending.pop()!,key=name(r);if(seen.has(key))continue;seen.add(key);pending.push(...records.get(key)!.refs);}return [...seen].map(k=>records.get(k)!.ref).sort((a,b)=>name(a)<name(b)?-1:1);}
 const preparedKeys=new Set<string>(),doneKeys=new Set<string>();
 for(const node of records.values()){
  const b=node.body;
  if('validFrom'in b)check(b.validFrom<b.validUntil,'window_invalid');
  if(b.recordType==='freeze-requested'){const a=get(b.startAuthorizationRef);check(b.previousRevision===a.expectedRevision&&b.revision===b.previousRevision+1,'revision_invalid');}
  if(b.recordType==='source-freeze-result'){const start=get(get(b.requestRef).startAuthorizationRef);check(same(b.invalidatedSessions,start.invalidatedSessions),'namespace_invalid');}
  if(b.recordType==='source-freeze-witness')check(b.head.revision===binding.source.beforeHead.revision+1&&b.head.headDigest!==binding.source.beforeHead.headDigest,'revision_invalid');
  if(b.recordType==='inventory-page')check(b.entries.length<=limits.pageEntries,'budget_exceeded');
  if(b.recordType==='inventory-root'){
   const pages=b.pages.map((r:MigrationRef)=>get(r)),entries=pages.flatMap((p:any)=>p.entries);check(pages.every((p:any,i:number)=>p.ordinal===i&&same(p.freezeRef,b.freezeRef)),'inventory_invalid');
   check(entries.length<=limits.entries&&entries.length===b.entryCount&&entries.reduce((n:number,e:any)=>n+e.size,0)===b.byteLength&&ordered(entries.map(entryKey)),'inventory_invalid');
   check(ordered(b.namespaces.map(nsKey))&&b.namespaces.every((ns:any)=>ns.originEpoch===binding.source.storeEpoch),'namespace_invalid');
   const invalidated=get(get(b.freezeRef).resultRef).invalidatedSessions;check(invalidated.every((ns:any)=>b.namespaces.some((n:any)=>nsKey(n)===nsKey(ns))),'namespace_invalid');
   for(const rootRole of ['source-store','source-checkpoint'])check(entries.filter((e:any)=>e.rootRole===rootRole).length<=4096&&entries.filter((e:any)=>e.rootRole===rootRole).reduce((n:number,e:any)=>n+e.size,0)<=256*1024*1024,'budget_exceeded');
  }
  if(b.recordType==='policy-evidence')check(b.policyDigest===binding.policyDigest,'policy_invalid');
  if(b.recordType==='time-evidence')check(b.clockDomain===binding.clockDomain,'clock_invalid');
  if(b.recordType==='hold-evidence')check(new Set(b.held.map(nsKey)).size===b.held.length&&b.held.every((ns:any)=>inventoryNamespace(b.inventoryRef).some(s=>nsKey(s)===nsKey(ns))),'hold_invalid');
  if(b.recordType==='retirement-intent'){
   const ns=inventoryNamespace(b.inventoryRef).find(s=>nsKey(s)===nsKey(b.namespace));check(ns&&ns.bindingDigest===b.sourceBindingDigest&&ns.scopeRoot===b.sourceScopeRoot&&ns.terminalRoot===b.sourceTerminalRoot&&ns.reservationRoot===b.sourceReservationRoot,'namespace_invalid');
   for(const r of [b.policyRef,b.holdRef,b.archiveRef])matchesInventory(get(r),b.inventoryRef);check(same(get(b.timeRef).freezeRef,get(b.inventoryRef).freezeRef),'link_invalid');
  }
  if(b.recordType==='retention-plan'){
   const source=inventoryNamespace(b.inventoryRef).map(nsKey),classified=[...b.keep,...b.retire].map(nsKey);check(new Set(classified).size===classified.length&&same([...source].sort(),[...classified].sort())&&ordered(b.keep.map(nsKey))&&ordered(b.retire.map(nsKey)),'namespace_invalid');
   const intents=b.intentRefs.map((r:MigrationRef)=>get(r));check(intents.length===b.retire.length&&new Set(intents.map((i:any)=>nsKey(i.namespace))).size===intents.length&&same(intents.map((i:any)=>nsKey(i.namespace)).sort(),b.retire.map(nsKey).sort()),'namespace_invalid');
   for(const intent of intents){matchesInventory(intent,b.inventoryRef);for(const k of ['policyRef','holdRef','timeRef','archiveRef'])check(same(intent[k],b[k]),'link_invalid');}
   for(const r of [b.policyRef,b.holdRef,b.archiveRef])matchesInventory(get(r),b.inventoryRef);check(same(get(b.timeRef).freezeRef,get(b.inventoryRef).freezeRef),'link_invalid');
   check(!get(b.holdRef).held.some((h:any)=>b.retire.some((r:any)=>nsKey(h)===nsKey(r))),'hold_invalid');
   const count=b.keep.reduce((n:number,k:any)=>n+inventoryNamespace(b.inventoryRef).find(s=>nsKey(s)===nsKey(k))!.recordCount,0)+b.retire.length;
   check(b.budget.keptSessions===b.keep.length&&b.budget.tombstones===b.retire.length&&b.budget.records===count&&b.budget.controlBytes>=totalBytes,'budget_invalid');
  }
  if(b.recordType==='tombstone-core'){const p=get(b.planRef);check(same(get(b.releaseRef).planRef,b.planRef)&&p.intentRefs.some((r:MigrationRef)=>same(r,b.intentRef)),'link_invalid');}
  if(b.recordType==='import-map'){
   const p=get(b.planRef),keys=b.mappings.map((m:any)=>nsKey(m.namespace));check(new Set(keys).size===keys.length&&same([...keys].sort(),[...p.keep,...p.retire].map(nsKey).sort()),'namespace_invalid');
   for(const m of b.mappings){const ns=inventoryNamespace(p.inventoryRef).find(s=>nsKey(s)===nsKey(m.namespace));check(ns&&ns.recordRoot===m.sourceRecordRoot&&ns.recordCount===m.sourceRecordCount,'import_map_invalid');const retained=p.keep.some((n:any)=>nsKey(n)===nsKey(m.namespace));check(m.disposition===(retained?'retained':'retired'),'import_map_invalid');if(retained)check(m.targetRecordRoot===m.sourceRecordRoot&&m.targetRecordCount===m.sourceRecordCount,'import_map_invalid');}
  }
  if(b.recordType==='compacted-base'){
   const release=get(b.releaseRef),p=get(release.planRef),imports=get(b.importMapRef);check(same(imports.planRef,release.planRef)&&same(b.budget,p.budget)&&b.retainedMaterialDigest===p.retainedMaterialDigest,'base_invalid');
   const cores=b.tombstoneCoreRefs.map((r:MigrationRef)=>get(r));check(cores.length===p.retire.length&&new Set(cores.map((c:any)=>name(c.intentRef))).size===cores.length,'retirement_incomplete');
   check(refSet(cores.map((c:any)=>c.intentRef),p.intentRefs)&&cores.every((c:any)=>same(c.planRef,release.planRef)&&same(c.releaseRef,b.releaseRef)),'link_invalid');
   for(const r of b.tombstoneCoreRefs){const core=get(r),m=imports.mappings.find((m:any)=>nsKey(m.namespace)===nsKey(get(core.intentRef).namespace));check(m&&m.targetRecordRoot===r.sha256&&m.targetRecordCount===1,'import_map_invalid');}
   check(b.retainedNamespaceRoot===ownedDigest(p.keep)&&b.tombstoneCoreRoot===ownedDigest(b.tombstoneCoreRefs),'base_invalid');
   const ancestors=ancestorRefs(node.refs);check(b.controlClosureRoot===migrationAncestorDigest(ancestors)&&b.budget.controlBytes>=ancestors.reduce((n,r)=>n+r.byteLength,0)+node.bytes.length,'base_invalid');
  }
  if(b.recordType==='storage-sync-evidence'){const roots=b.rootRole==='source'?[binding.source.storeRootId,binding.source.checkpointRootId]:b.rootRole==='target'?[binding.target.storeRootId,binding.target.checkpointRootId]:[binding.controlRootId];check(same(b.roots,roots),'sync_binding_invalid');}
  if(b.recordType==='target-checkpoint')check(b.head.revision===0&&b.head.headDigest===migrationTargetGenesis(binding,b.manifestDigest,b.baseRef)&&get(b.syncRef).rootRole==='target','genesis_invalid');
  if(b.recordType==='target-ready'){
   const base=get(b.baseRef),cp=get(b.checkpointRef);check(same(base.releaseRef,b.releaseRef)&&same(get(b.releaseRef).planRef,b.planRef)&&same(cp.baseRef,b.baseRef)&&cp.manifestDigest===b.manifestDigest&&same(cp.syncRef,b.syncRef),'ready_invalid');
  }
  if(b.recordType==='activation-authorization'){const ready=get(b.readyRef);checkEvidence(get(ready.planRef),b);}
  if(b.recordType==='activation-receipt'){const a=get(b.authorizationRef);check(b.previousRevision===a.expectedRevision&&b.revision===b.previousRevision+1,'revision_invalid');}
  if(b.recordType==='gc-batch-plan')check(b.entries.length<=limits.batchEntries,'budget_exceeded');
  if(b.recordType==='gc-authorization'){
   const ready=get(get(get(b.activationRef).authorizationRef).readyRef),p=get(b.planRef);check(same(ready.planRef,b.planRef)&&same(p.inventoryRef,b.inventoryRef),'link_invalid');matchesInventory(get(b.holdRef),b.inventoryRef);check(get(b.holdRef).revision>=get(p.holdRef).revision&&!get(b.holdRef).held.some((h:any)=>p.retire.some((r:any)=>nsKey(r)===nsKey(h))),'hold_invalid');
   const batches=b.batchRefs.map((r:MigrationRef)=>get(r));check(batches.every((batch:any,i:number)=>batch.ordinal===i&&same(batch.inventoryRef,b.inventoryRef)),'gc_scope_invalid');const actual=batches.flatMap((batch:any)=>batch.entries),expected=sortedGc(inventoryEntries(b.inventoryRef));check(same(actual,expected),'gc_scope_invalid');
  }
  if(b.recordType==='gc-barrier'){const a=get(b.authorizationRef);check(same(b.holdRef,a.holdRef)&&b.previousRevision===a.expectedRevision&&b.revision===b.previousRevision+1,'revision_invalid');}
  if(b.recordType==='gc-batch-prepared'){
   const batchKey=ownedDigest({barrier:b.barrierRef,index:b.batchIndex});check(!preparedKeys.has(batchKey),'gc_progress_invalid');preparedKeys.add(batchKey);
   check(b.entries.length<=limits.batchEntries,'budget_exceeded');
   const auth=get(get(b.barrierRef).authorizationRef),batch=auth.batchRefs[b.batchIndex]?get(auth.batchRefs[b.batchIndex]):undefined;check(batch&&same(b.entries,batch.entries),'gc_scope_invalid');
   if(b.batchIndex===0)check(!b.previousDoneRef,'gc_progress_invalid');else {check(b.previousDoneRef,'gc_progress_invalid');const old=get(get(b.previousDoneRef).preparedRef);check(old.batchIndex===b.batchIndex-1&&same(old.barrierRef,b.barrierRef),'gc_progress_invalid');}
  }
  if(b.recordType==='gc-batch-done'){const progressKey=name(b.preparedRef);check(!doneKeys.has(progressKey),'gc_progress_invalid');doneKeys.add(progressKey);const prepared=get(b.preparedRef);check(b.deletedEntriesRoot===ownedDigest(prepared.entries)&&get(b.syncRef).rootRole==='source','gc_progress_invalid');}
  if(b.recordType==='gc-completion'){
   const auth=get(get(b.barrierRef).authorizationRef);check(b.doneRefs.length===auth.batchRefs.length,'gc_progress_invalid');for(const [i,r]of b.doneRefs.entries()){const prepared=get(get(r).preparedRef);check(prepared.batchIndex===i&&same(prepared.barrierRef,b.barrierRef)&&(i===0?!prepared.previousDoneRef:same(prepared.previousDoneRef,b.doneRefs[i-1])),'gc_progress_invalid');}
  }
  if(b.recordType==='retire-receipt'){
   const base=get(b.baseRef),barrier=get(b.barrierRef),gc=get(b.completionRef),a=get(barrier.authorizationRef),ready=get(get(get(b.activationRef).authorizationRef).readyRef);
   check(base.tombstoneCoreRefs.some((r:MigrationRef)=>same(r,b.coreRef))&&same(ready.baseRef,b.baseRef)&&same(a.activationRef,b.activationRef)&&same(gc.barrierRef,b.barrierRef),'retirement_incomplete');
  }
  if(b.recordType==='target-finalization'){
   const base=get(b.baseRef),rs=b.retireReceiptRefs.map((r:MigrationRef)=>get(r));check(refSet(rs.map((r:any)=>r.coreRef),base.tombstoneCoreRefs)&&rs.every((r:any)=>same(r.baseRef,b.baseRef)&&same(r.completionRef,b.completionRef)),'retirement_incomplete');
   const ready=get(get(get(get(get(b.completionRef).barrierRef).authorizationRef).activationRef).authorizationRef).readyRef;check(same(get(ready).baseRef,b.baseRef),'link_invalid');
  }
  if(b.recordType==='target-final-checkpoint')check(b.head.revision>0&&get(b.syncRef).rootRole==='target','revision_invalid');
  if(b.recordType==='completion-receipt')check(same(get(b.checkpointRef).finalizationRef,b.finalizationRef)&&b.revision===b.previousRevision+1&&b.previousRevision>=get(get(get(b.finalizationRef).completionRef).barrierRef).revision,'revision_invalid');
 }
 if(selection.phase==='frozen')check(same(get(selection.inventoryRef).freezeRef,selection.freezeRef),'link_invalid');
 if(selection.phase==='prepared')check(same(get(selection.releaseRef).planRef,selection.planRef),'link_invalid');
 if(selection.phase==='deleting-source'&&selection.progress.state!=='none'){const p=selection.progress.state==='prepared'?get(selection.progress.preparedRef):get(get(selection.progress.doneRef).preparedRef);check(same(p.barrierRef,selection.barrierRef),'link_invalid');}
 const sorted=[...records.values()].sort((a,b)=>name(a.ref)<name(b.ref)?-1:1);
 return {scope:'static-local-control-closure' as const,phase:selection.phase,closureVerified:true as const,selectionCurrentVerified:false as const,authorizationCurrentVerified:false as const,backendEligible:false as const,diagnosticEligible:false as const,physicalDeletionAuthorized:false as const,sourceTransformVerified:false as const,targetArtifactsVerified:false as const,storageDurabilityVerified:false as const,closureRoot:ownedDigest({domain:'migration-control-bundle-v1',binding,selection,records:sorted.map(r=>r.ref)}),records:sorted.map(r=>({ref:{...r.ref},body:r.body,bytes:Buffer.from(r.bytes)})),usage:{records:records.size,refs:edges,totalBytes,nodes:limits.nodes-budget.nodes}};
}
