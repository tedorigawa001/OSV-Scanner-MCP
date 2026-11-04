/** Recovery evidence is a boot-scoped fact; it cannot create a live pin or consumer result. */
import {z} from 'zod';
import {cid,chash,cn,cref} from './gradleOwnedCurrentSchema.js';
import {currentLineageSchema} from './gradleOwnedCurrentAuxiliary.js';
import {serviceIdentitySchema} from './gradleOwnedServiceOwners.js';
import {stageHeadSchema} from './gradleOwnedServiceStages.js';
export const ownerRecoverySchema=z.object({schema:z.literal('osv-mcp.q2.c3b.recovered-owner.v1'),api:z.literal('ReportServiceRecovered'),lineage:currentLineageSchema,subject:serviceIdentitySchema,ownerId:cid,storageEpoch:chash,rootsDigest:chash,recoveryRun:chash,barrier:cref('barrier'),head:stageHeadSchema.nullable(),unresolved:cn.max(64),historyVerified:z.literal(true),scope:z.literal('cooperative-local-only')}).strict();
export const recoveryBundleSchema=z.object({schema:z.literal('osv-mcp.q2.c3b.recovery-bundle.v1'),recoveryRun:chash,barrier:cref('barrier'),proofs:z.array(z.string().max(6000)).length(5)}).strict();
export const resumeWithRecoverySchema=z.object({barrier:cref('barrier'),recoveryRun:chash,evidence:cref('fence-evidence')}).strict();
