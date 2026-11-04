/** C3b-5 delivery facts. No receipt or historical ACK is a fresh execution permission. */
import {z} from 'zod';
import {canonicalOwnedJson} from './gradleOwnedJson.js';
import {cid,chash,cn,cref,currentBindingSchema,parsed,need} from './gradleOwnedCurrentSchema.js';
import {currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema} from './gradleOwnedServiceOwners.js';
export const deliveryBindingShape={pin:cref('read-pin'),delivery:cref('delivery'),useId:cid,gate:cref('authority-gate'),result:cref('candidate-result'),reader:serviceIdentitySchema};
export const deliveryStateSchema=z.object({...deliveryBindingShape,binding:currentBindingSchema,broker:serviceIdentitySchema,phase:z.enum(['delivering','released']),decisionRevision:cn.positive(),deliveryRevision:cn.positive(),ackRevision:cn.positive().nullable()}).strict();
export type DeliveryState=z.infer<typeof deliveryStateSchema>;
export const readDeliveryPayload=z.object({pin:cref('read-pin'),delivery:cref('delivery'),useId:cid,reader:serviceIdentitySchema}).strict();
export const recordUsePayload=z.object(deliveryBindingShape).strict();
export const acknowledgePayload=z.object({pin:cref('read-pin'),delivery:cref('delivery'),useId:cid,result:cref('candidate-result'),receipt:cref('semantic-result'),resultDigest:chash,effect:z.null()}).strict();
export const providerUseSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.provider-use.v1'),api:z.literal('RecordUse'),lineage:currentLineageSchema,binding:currentBindingSchema,...deliveryBindingShape,broker:serviceIdentitySchema,provider:serviceIdentitySchema,decisionRevision:cn.positive(),deliveryRevision:cn.positive()}).strict();
export const completeReadPayload=z.object({pin:cref('read-pin'),gate:cref('authority-gate'),result:cref('candidate-result'),witness:cref('checkpoint-witness'),useId:cid}).strict();
export const resultChunkPayload=z.object({pin:cref('read-pin'),delivery:cref('delivery'),useId:cid,result:cref('candidate-result'),receipt:cref('semantic-result'),transferId:cid,offset:cn.max(65536),maxBytes:cn.positive().max(4096)}).strict();
export const resultChunkSchema=resultChunkPayload.omit({maxBytes:true}).extend({totalBytes:cn.positive().max(65536),bytes:z.string().max(5500),sha256:chash}).strict();
export function validateDeliveryMatch(state:DeliveryState,value:z.infer<typeof recordUsePayload>){for(const key of Object.keys(deliveryBindingShape) as (keyof typeof deliveryBindingShape)[])need(canonicalOwnedJson(state[key])===canonicalOwnedJson(value[key]),'binding_mismatch');}
