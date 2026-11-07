import {z} from 'zod';import {i0ReplySchema} from './gradleOwnedCgpI0Wire.js';import {currentLineageSchema} from '../../utils/gradleOwnedCurrentAuxiliary.js';
export const i2ReplySchema=i0ReplySchema.extend({schema:z.literal('cgp.i2.range-reply.v1'),lineage:currentLineageSchema,live:z.literal(false)}).strict();
