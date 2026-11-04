/** C3b-2 single-owner stage persistence. Cooperative local disk, not independent rollback protection. */
import {OwnedJournalDisk,type OwnedJournalDiskOptions} from './gradleOwnedStoreDisk.js';
import {ownerPlanFacts,type OwnerPlan,type OwnedStore} from './gradleOwnedServiceOwners.js';
import {stageCommitSchema,validateStageCommit,deriveStageReceipt,resolveExactStage,stageReceiptRef,type StageReceipt} from './gradleOwnedServiceStages.js';
import {need,decodeCurrent,parsed,CURRENT_LIMITS} from './gradleOwnedCurrentSchema.js';
import {canonicalOwnedJson} from './gradleOwnedJson.js';
const MAX=8*1024*1024,same=(a:unknown,b:unknown)=>canonicalOwnedJson(a,MAX)===canonicalOwnedJson(b,MAX);
export type StageStoreOptions={plan:OwnerPlan;disk:OwnedJournalDiskOptions;preflight:()=>void};
export class StageStore implements OwnedStore {
 readonly #disk:OwnedJournalDisk;readonly #plan:OwnerPlan;readonly #facts:ReturnType<typeof ownerPlanFacts>;
 #closed=false;#blocked=false;#busy=false;
 private constructor(plan:OwnerPlan,disk:OwnedJournalDisk){this.#plan=plan;this.#facts=ownerPlanFacts(plan);this.#disk=disk;}
 static async open(options:StageStoreOptions){
  options.preflight();const c=ownerPlanFacts(options.plan),o=options.disk;
  need(o.authorityId===c.ownerId&&o.storeEpoch===c.storageEpoch&&o.keyId===c.journalKeyId&&o.checkpointKeyId===c.checkpointKeyId,'binding_mismatch');
  need(!o.key.equals(o.checkpointKey),'configuration_invalid');
  const disk=await OwnedJournalDisk.open(o);
  try{options.preflight();const roots=disk.rootIdentities;for(const [i,k]of ['store','checkpoint'].entries()){const r=c.roots[k as 'store'|'checkpoint'];need(String(roots[i]!.device)===r.device&&String(roots[i]!.inode)===r.inode,'binding_mismatch');}
   const store=new StageStore(options.plan,disk);await store.recover();return store;
  }catch(e){disk.close();throw e;}
 }
 get ownerId(){return this.#facts.ownerId;}get storageEpoch(){return this.#facts.storageEpoch;}get roots(){return structuredClone(this.#facts.roots);}get journalKeyId(){return this.#facts.journalKeyId;}get checkpointKeyId(){return this.#facts.checkpointKeyId;}
 assertOpen(){need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');}
 assertIdle(){this.assertOpen();need(!this.#busy,'busy');}
 async #history(resync=false){
  this.assertOpen();if(resync)await this.#disk.revalidate();else await this.#disk.assertNoPendingTail();this.assertOpen();const history=await this.#disk.journal.readHistory();this.assertOpen();
  const ledger:StageReceipt[]=[],images:unknown[]=[],byRef=new Map<string,StageReceipt>(),operations=new Map<string,{api:string;requestDigest:string;stages:Set<string>}>();let head:StageReceipt['appliedHead']|null=null;
  for(const row of history){
   need(row.records.length===4,'integrity_invalid');const get=(role:string)=>{const found=row.records.filter(r=>r.role===role);need(found.length===1,'integrity_invalid');return found[0]!.bytes;};
   const manifest=decodeCurrent(get('session-manifest'),MAX),q=parsed(stageCommitSchema,decodeCurrent(get('event-ledger'),MAX));
   need(same(manifest,{schema:'osv-mcp.q2.c3b.store.v1',ownerId:this.ownerId,storageEpoch:this.storageEpoch,roots:this.roots,journalKeyId:this.journalKeyId,checkpointKeyId:this.checkpointKeyId}),'binding_mismatch');
   const prior=q.previousStageReceipt?byRef.get(canonicalOwnedJson(q.previousStageReceipt))??null:null;
   const record=validateStageCommit(this.#plan,q,head,prior),image=decodeCurrent(get('operation-result'),MAX);
   need(same(image,decodeCurrent(Buffer.from(q.nextImage,'base64'),MAX))&&same(decodeCurrent(get('session-index'),MAX),{transitionKey:q.transitionKey,transitionDigest:q.transitionDigest})&&row.operationId===q.transitionKey&&row.requestDigest===q.transitionDigest,'integrity_invalid');
   // Same checks as resolveExactStage for one new row, kept linear because this replays on every request.
   const operation=operations.get(q.operationKey)??{api:q.api,requestDigest:q.requestDigest,stages:new Set<string>()};need(operation.api===q.api&&operation.requestDigest===q.requestDigest&&!operation.stages.has(q.stageId),'integrity_invalid');operation.stages.add(q.stageId);operations.set(q.operationKey,operation);
   head={revision:row.head.revision,sha256:row.head.headDigest};const receipt=deriveStageReceipt(this.#plan,record,head);ledger.push(receipt);byRef.set(canonicalOwnedJson(stageReceiptRef(receipt)),receipt);images.push(image);
  }
  return {ledger,images,head,image:images.at(-1)??null};
 }
 async #run<T>(work:()=>Promise<T>){this.assertOpen();need(!this.#busy,'busy');this.#busy=true;try{return await work();}catch(e){throw e;}finally{this.#busy=false;}}
 recover(){return this.#run(async()=>{try{return await this.#history(true);}catch(e){this.#blocked=true;throw e;}});}
 readCommitted(ref:unknown){return this.#run(async()=>{try{const h=await this.#history();if(ref===null)return h;const r=h.ledger.find(r=>same(stageReceiptRef(r),ref));need(r,'receipt_invalid');return {receipt:r,image:h.images[h.ledger.indexOf(r)]};}catch(e){if(!(e instanceof Error&&e.message==='current_control_receipt_invalid'))this.#blocked=true;throw e;}});}
 commitStageExact(input:unknown){
  const q=parsed(stageCommitSchema,input);return this.#run(async()=>{
   let h:{ledger:StageReceipt[];images:unknown[];head:StageReceipt['appliedHead']|null;image:unknown}; // assigned only after authenticated replay
   try{h=await this.#history();}catch(e){this.#blocked=true;throw e;}
   const saved=resolveExactStage(this.#plan,q,h.ledger);if(saved.kind==='saved')return saved.receipt;
   need(h.ledger.length<CURRENT_LIMITS.operations,'capacity_exhausted');const previous=q.previousStageReceipt?h.ledger.find(r=>same(stageReceiptRef(r),q.previousStageReceipt)):null;
   const record=validateStageCommit(this.#plan,q,h.head,previous),image=Buffer.from(q.nextImage,'base64');
   // All caller-input refusals above precede writes. Every failure below is fail-stop, including unknown publication.
   try{const result=await this.#disk.journal.commit({operationId:q.transitionKey,requestDigest:q.transitionDigest,expectedHead:this.#disk.journal.head,records:[
    {role:'session-manifest',id:'owner',bytes:Buffer.from(canonicalOwnedJson({schema:'osv-mcp.q2.c3b.store.v1',ownerId:this.ownerId,storageEpoch:this.storageEpoch,roots:this.roots,journalKeyId:this.journalKeyId,checkpointKeyId:this.checkpointKeyId}))},
    {role:'session-index',id:'stage',bytes:Buffer.from(canonicalOwnedJson({transitionKey:q.transitionKey,transitionDigest:q.transitionDigest}))},
    {role:'event-ledger',id:'stage',bytes:Buffer.from(canonicalOwnedJson(q,MAX))},{role:'operation-result',id:'image',bytes:image}]});this.assertOpen();
    const receipt=deriveStageReceipt(this.#plan,record,{revision:result.revision,sha256:result.headDigest}),after=await this.#history();this.assertOpen();need(same(after.ledger.at(-1),receipt),'integrity_invalid');return receipt;
   }catch(e){this.#blocked=true;throw e;}
  });
 }
 close(){need(!this.#busy,'busy');if(!this.#closed){this.#disk.close();this.#closed=true;}}
 get diagnostics(){return {scope:'cooperative-single-owner-disk',blocked:this.#blocked,backendEligible:false,originalReadsSkipped:0};}
}
