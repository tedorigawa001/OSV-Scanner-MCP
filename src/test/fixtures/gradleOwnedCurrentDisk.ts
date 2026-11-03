/** C1 cooperative POSIX storage owner. Separate roots/keys do NOT prove independent rollback domains. */
import path from 'node:path';
import {verify,type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {OwnedJournalDisk,type OwnedJournalDiskOptions} from './gradleOwnedJournalDisk.js';
import {CurrentControl,type CurrentConfig,type CurrentActor} from './gradleOwnedCurrentControl.js';
import {currentRoles,chash,parsed,need,wireSchema,decodeCurrent,CURRENT_LIMITS,CurrentControlError,type CurrentRole} from './gradleOwnedCurrentSchema.js';
import {durableRegistrySchema,durableIssuerSchema,durableRecordSchema,durableAnchorSchema,type DurableRegistry,type DurableIssuer,type DurableAnchor,type CurrentPersistence} from './gradleOwnedCurrentPersistence.js';
import {canonicalOwnedJson,ownedDigest,ownedSha256} from '../../utils/gradleOwnedJson.js';
const MAX=8*1024*1024,same=(a:unknown,b:unknown)=>canonicalOwnedJson(a,MAX)===canonicalOwnedJson(b,MAX);
const entry=z.object({attempt:chash,expected:durableAnchorSchema,next:durableAnchorSchema}).strict();
const anchorImage=z.object({schema:z.literal('osv-mcp.q2.c1.anchor.v1'),entries:z.array(entry).max(CURRENT_LIMITS.records)}).strict();
type Owner='issuer'|'registry'|'anchor';
export interface CurrentDiskOptions {
 owners:Record<Owner,Omit<OwnedJournalDiskOptions,'mode'>>;
 mode:'create'|'open';serverKeys:Record<CurrentRole,{publicKey:KeyObject;privateKey:KeyObject}>;
 /** Trusted external minimum. A same-host file is diagnostic, not independent rollback protection. */
 anchorFloor:DurableAnchor;
 fault?:(point:'before-anchor-cas'|'after-anchor-cas'|'before-startup-invalidation'|'after-startup-invalidation')=>void|Promise<void>;
}
export class OwnedCurrentDisk implements CurrentPersistence {
 readonly #options:CurrentDiskOptions;readonly #owners:Record<Owner,OwnedJournalDisk>;#queue:Promise<unknown>=Promise.resolve();#blocked=false;#closed=false;#pending=0;#started=false;
 // Caller-input refusals raised before the Anchor image is written leave the owner usable.
 readonly #refusals=new WeakSet<object>();
 #refuse(ok:unknown,reason:string):asserts ok{if(!ok){const error=new CurrentControlError(reason);this.#refusals.add(error);throw error;}}
 private constructor(o:CurrentDiskOptions,owners:Record<Owner,OwnedJournalDisk>){this.#options=o;this.#owners=owners;}
 static async open(input:CurrentDiskOptions){
  parsed(durableAnchorSchema,input.anchorFloor);const all=Object.values(input.owners),roots=all.flatMap(o=>[path.resolve(o.store.root),path.resolve(o.checkpoint.root)]),keys=all.flatMap(o=>[o.key,o.checkpointKey]);
  need(input.mode==='open'||input.mode==='create','configuration_invalid');need(keys.every(k=>Buffer.isBuffer(k)&&k.length===32)&&new Set(keys.map(k=>ownedSha256(k))).size===6,'configuration_invalid');
  for(const [n,a]of roots.entries())for(const b of roots.slice(n+1))need(a!==b&&!a.startsWith(b+path.sep)&&!b.startsWith(a+path.sep),'roots_overlap');
  need(currentRoles.every(role=>input.serverKeys[role]?.privateKey.type==='private'&&input.serverKeys[role]?.publicKey.type==='public')&&new Set(currentRoles.map(role=>ownedSha256(input.serverKeys[role].publicKey.export({type:'spki',format:'der'})))).size===currentRoles.length,'configuration_invalid');
  const o:CurrentDiskOptions={...input,anchorFloor:JSON.parse(canonicalOwnedJson(input.anchorFloor)),serverKeys:Object.fromEntries(currentRoles.map(role=>[role,{...input.serverKeys[role]}])) as CurrentDiskOptions['serverKeys'],owners:Object.fromEntries(Object.entries(input.owners).map(([role,v])=>[role,{...v,key:Buffer.from(v.key),checkpointKey:Buffer.from(v.checkpointKey),store:{...v.store},checkpoint:{...v.checkpoint}}])) as CurrentDiskOptions['owners']};
  const owners={} as Record<Owner,OwnedJournalDisk>;
  try{for(const role of ['anchor','issuer','registry'] as const)owners[role]=await OwnedJournalDisk.open({...o.owners[role],mode:o.mode});const disk=new OwnedCurrentDisk(o,owners);await disk.#run(async()=>{await disk.#load('issuer');await disk.#load('registry');await disk.#anchor();});return disk;}catch(e){for(const d of Object.values(owners).reverse())d.close();throw e;}
 }
 async #run<T>(work:()=>Promise<T>):Promise<T>{
  need(!this.#closed,'owner_closed');this.#pending++;const task=this.#queue.then(async()=>{need(!this.#blocked,'recovery_required');try{return await work();}catch(e){if(!(e instanceof Error&&(e.message==='current_control_control_conflict'||this.#refusals.has(e))))this.#blocked=true;throw e;}});this.#queue=task.catch(()=>{});try{return await task;}finally{this.#pending--;}
 }
 async #load(role:Owner):Promise<unknown|undefined>{
  await this.#owners[role].revalidate();const rows=await this.#owners[role].journal.readLatest();if(rows.length===0)return undefined;
  need(rows.length===4,'integrity_invalid');const get=(r:string)=>{const found=rows.filter(e=>e.role===r);need(found.length===1,'integrity_invalid');return found[0]!.bytes;};
  const body=decodeCurrent(get('operation-result'),MAX);need(same(decodeCurrent(get('session-manifest'),MAX),{schema:'osv-mcp.q2.c1.owner.v1',role}),'integrity_invalid');need(same(decodeCurrent(get('session-index'),MAX),{digest:ownedDigest(body)})&&same(decodeCurrent(get('event-ledger'),MAX),{role,digest:ownedDigest(body)}),'integrity_invalid');return body;
 }
 async #save(role:Owner,image:unknown){
  const bytes=Buffer.from(canonicalOwnedJson(image,MAX)),digest=ownedSha256(bytes),current=await this.#load(role);if(current!==undefined&&same(current,image))return;
  await this.#owners[role].journal.commit({operationId:role+'-'+digest,requestDigest:digest,records:[{role:'session-manifest',id:'root',bytes:Buffer.from(canonicalOwnedJson({schema:'osv-mcp.q2.c1.owner.v1',role}))},{role:'session-index',id:'root',bytes:Buffer.from(canonicalOwnedJson({digest}))},{role:'event-ledger',id:'scope',bytes:Buffer.from(canonicalOwnedJson({role,digest}))},{role:'operation-result',id:'root',bytes}]});
  await this.#owners[role].revalidate();need(same(await this.#load(role),image),'integrity_invalid');
 }
 async #anchor(){
  const raw=await this.#load('anchor'),image=raw===undefined?{schema:'osv-mcp.q2.c1.anchor.v1' as const,entries:[]}:parsed(anchorImage,raw);let current:DurableAnchor={revision:0,record:null};const attempts=new Set<string>();
  for(const e of image.entries){need(!attempts.has(e.attempt)&&same(e.expected,current)&&e.next.revision===current.revision+1,'integrity_invalid');attempts.add(e.attempt);current=e.next;}
  const floor=this.#options.anchorFloor;need(floor.revision===0||image.entries.some(e=>same(e.next,floor)),'rollback_detected');return {image,current};
 }
 readAnchor(){return this.#run(async()=>JSON.parse(canonicalOwnedJson((await this.#anchor()).current)) as DurableAnchor);}
 verify(expected:DurableAnchor){const copy=parsed(durableAnchorSchema,expected);return this.#run(async()=>{need(same((await this.#anchor()).current,copy),'rollback_detected');await this.#load('registry');await this.#load('issuer');});}
 saveIssuer(input:DurableIssuer){const image=parsed(durableIssuerSchema,JSON.parse(canonicalOwnedJson(input,MAX)));return this.#run(()=>this.#save('issuer',image));}
 saveRegistry(input:DurableRegistry){const image=parsed(durableRegistrySchema,JSON.parse(canonicalOwnedJson(input,MAX)));return this.#run(()=>this.#save('registry',image));}
 cas(expected:DurableAnchor,next:DurableAnchor,attemptId:string){
  const previous=parsed(durableAnchorSchema,expected),after=parsed(durableAnchorSchema,next),attempt=parsed(chash,attemptId);
  return this.#run(async()=>{
   const {image,current}=await this.#anchor(),prior=image.entries.find(e=>e.attempt===attempt);if(prior){this.#refuse(same(prior.expected,previous)&&same(prior.next,after),'idempotency_conflict');return;}
   need(same(current,previous),'control_conflict');this.#refuse(after.revision===previous.revision+1&&after.record,'binding_mismatch');const registry=parsed(durableRegistrySchema,await this.#load('registry')),r=registry.records.find(e=>same(e.ref,after.record));this.#refuse(r,'receipt_invalid');
   const raw=Buffer.from(r.raw,'base64');need(raw.length===r.ref.byteLength&&ownedSha256(raw)===r.ref.sha256,'integrity_invalid');const envelope=parsed(wireSchema,decodeCurrent(raw,CURRENT_LIMITS.record)),{signature,...unsigned}=envelope;
   need(envelope.role==='lineage-registry'&&envelope.keyId==='server-lineage-registry'&&envelope.direction==='reply'&&envelope.keyEpoch===1&&verify(null,Buffer.from(canonicalOwnedJson(unsigned,CURRENT_LIMITS.record)),this.#options.serverKeys['lineage-registry'].publicKey,Buffer.from(signature,'base64')),'signature_invalid');
   const body=parsed(durableRecordSchema,envelope.body);need(registry.identityDigest===ownedDigest(body.identity),'integrity_invalid');
   // The stored record is authentic; a mismatch with the caller's revision/previous/attempt claim is the caller's error.
   this.#refuse(body.revision===after.revision&&same(body.previous,previous.record)&&attempt===ownedDigest({registry:'registry',incarnation:body.state.incarnation,previous:body.previous,next:after.record}),'binding_mismatch');
   const issuer=parsed(durableIssuerSchema,await this.#load('issuer'));need(issuer.identityDigest===registry.identityDigest,'binding_mismatch');await this.#options.fault?.('before-anchor-cas');
   await this.#save('anchor',{schema:'osv-mcp.q2.c1.anchor.v1',entries:[...image.entries,{attempt,expected:previous,next:after}]});need(same((await this.#anchor()).current,after),'integrity_invalid');await this.#options.fault?.('after-anchor-cas');
  });
 }
 async start(config:Omit<CurrentConfig,'persistence'|'serverKeys'>){
  need(config.supported!==false,'anchor_unsupported');need(config.approved!==false,'profile_unapproved');need(!this.#started,'owner_already_started');this.#started=true;
  const c=new CurrentControl({...config,persistence:this,serverKeys:this.#options.serverKeys}),actors=Object.fromEntries(currentRoles.map(role=>[role,c.actor(role)])) as Record<CurrentRole,CurrentActor>;
  const saved=await this.#run(async()=>({registry:await this.#load('registry'),issuer:await this.#load('issuer'),anchor:(await this.#anchor()).current}));
  if(saved.registry!==undefined||saved.issuer!==undefined){const i=parsed(durableIssuerSchema,saved.issuer),r=saved.registry??{schema:'osv-mcp.q2.c1.registry.v1',identityDigest:i.identityDigest,records:[],objects:[]};await this.#options.fault?.('before-startup-invalidation');await c.restore(actors.operator,r,i,saved.anchor);await this.#options.fault?.('after-startup-invalidation');}
  else need(saved.anchor.revision===0,'rollback_detected');return {control:c,actors};
 }
 assertOpen(){need(!this.#closed,'owner_closed');need(!this.#blocked,'recovery_required');}
 close(){need(this.#pending===0,'busy');if(!this.#closed){for(const d of Object.values(this.#owners).reverse())d.close();this.#closed=true;}}
 get diagnostics(){return {scope:'cooperative-local-disk',independentRegistryVerified:false,profileApproved:false,backendEligible:false,originalReadsSkipped:0};}
}
