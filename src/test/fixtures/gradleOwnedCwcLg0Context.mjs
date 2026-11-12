/** JSON evidence counterpart of CPR context(): no source IO, admission or clock reads. */
import {z} from 'zod';
const cid=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),digest=z.string().regex(/^[a-f0-9]{64}$/),cn=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const roles=['operator','manager','writer','provider','checkpoint-issuer','lineage-registry','control-anchor','authority-broker','reader'];
const identity=z.object({credentialId:cid,role:z.enum(roles),instanceId:cid,boot:digest,keyEpoch:cn.positive()}).strict();
const lineage=z.object({authorityId:cid,lineageId:cid,generation:cn.positive(),storeEpoch:digest,enrollmentDigest:digest,profileDigest:digest}).strict();
const ref=role=>z.object({role:z.literal(role),id:cid,sha256:digest,byteLength:cn.positive().max(65536)}).strict();
const snapshot=ref('snapshot'),checkpoint=ref('checkpoint-prepare');
const head=z.object({format:z.literal('v2'),revision:cn.positive().max(256),commitDigest:digest,stateRoot:digest,baseDigest:digest}).strict();
const binding=z.object({...lineage.shape,format:z.enum(['v1','v2']),storeRootId:cid,checkpointRootId:cid,rootPairId:cid,storageInstanceId:cid,
 providerBoot:digest,namespaceGeneration:cn,writerFence:cn,registryIncarnation:digest,selectionRevision:cn,revocationEpoch:cn,
 checkpointIssuer:cid,checkpointKeyEpoch:cn.positive(),schemaDigest:digest,parserDigest:digest,policyDigest:digest,
 mode:z.literal('serving'),selected:z.object({snapshot,checkpoint,head}).strict()}).strict();
const schema=z.object({catalog:digest,manifest:digest,registryDigest:digest,deploymentDigest:digest,endpointId:cid,requestKeyId:cid,replyKeyId:cid,
 peer:identity,provider:identity,origin:identity.optional(),lineage,binding,snapshot,checkpoint,pin:ref('read-pin'),metadataDigest:digest,inventoryDigest:digest}).strict();
export const LG0_MAXIMUM_IDS=Object.freeze(['authorityId','lineageId','storeRootId','checkpointRootId','rootPairId','storageInstanceId','checkpointIssuer','credentialId','instanceId','id','endpointId','requestKeyId','replyKeyId']);
export const LG0_MAXIMUM_EPOCHS=Object.freeze(['generation','namespaceGeneration','writerFence','selectionRevision','revocationEpoch','checkpointKeyEpoch','keyEpoch','peerKeyEpoch','serverKeyEpoch']);
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const need=(ok,reason)=>{if(!ok)throw Error('lg0_'+reason);};
export function validateLg0Context(input,role,maximum=false){
 const result=schema.safeParse(input);need(result.success,'context_schema');const c=result.data;
 need(['reader','authority-broker'].includes(role)&&c.peer.role===role&&c.provider.role==='provider','context_role');
 need(role==='reader'?c.origin===undefined:c.origin?.role==='reader','context_role');
 need(canonical(c.binding.selected.snapshot)===canonical(c.snapshot)&&canonical(c.binding.selected.checkpoint)===canonical(c.checkpoint),'context_binding');
 need(Object.entries(c.lineage).every(([k,v])=>c.binding[k]===v)&&c.binding.providerBoot===c.provider.boot&&c.catalog===c.lineage.profileDigest,'context_binding');
 if(maximum){
  const ids=new Set(LG0_MAXIMUM_IDS),epochs=new Set(LG0_MAXIMUM_EPOCHS);
  function check(v){for(const [k,x]of Object.entries(v)){if(ids.has(k))need(typeof x==='string'&&x.length===128,'maximum_input');else if(epochs.has(k))need(x===Number.MAX_SAFE_INTEGER,'maximum_input');else if(x&&typeof x==='object')check(x);}}
  check(c);
 }
 return c;
}
