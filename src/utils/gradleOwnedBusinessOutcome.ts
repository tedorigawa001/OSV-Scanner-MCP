/** Strict signed application outcomes; transport exceptions are never definite refusals. */
import {z} from 'zod';
import {currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {cid,chash} from './gradleOwnedCurrentSchema.js';
import {serviceIdentitySchema} from './gradleOwnedServiceOwners.js';
export const businessOutcomeSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.business-outcome.v1'),api:cid,requestDigest:chash,lineage:currentLineageSchema,peer:serviceIdentitySchema,server:serviceIdentitySchema,outcome:z.enum(['refused','unknown']),reason:cid,effects:z.enum(['none','possible'])}).strict().refine(v=>(v.outcome==='refused')===(v.effects==='none'));
