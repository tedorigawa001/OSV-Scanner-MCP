import {z} from 'zod';
import {ownedFail} from './gradleOwnedJson.js';

export const ownedStages=['prepare','build','runtime-selection','snapshot-generation','offer'] as const;
export const successFields=['inputManifestRef','buildReceiptRef','runtimeSelectionRef','generationReceiptRef','offerReceiptRef'] as const;
export const stageRoles=['input-manifest','build-receipt','runtime-selection','generation-receipt','offer-receipt'] as const;
export const phases=['registration','generation-binding','seal','binding','precheck','call','postcheck','capture'] as const;
export const ownedLimitations=['offered-inputs-only','no-natural-consumption-receipt','no-all-writer-exclusion','no-compiler-internal-supplier-proof','no-transparent-kgp-integration','snapshot-slot-only','no-compiler-work-witness'] as const;
const id=z.string().min(1).max(1024);
const digest=z.string().regex(/^[a-f0-9]{64}$/).refine(v=>!/^0+$/.test(v));
const roles=z.enum([...stageRoles,'failure-receipt','unavailable-evidence','evidence-index','evidence','offer-envelope','manifest-bundle']);
export const ownedRef=z.object({role:roles,objectDigest:digest,byteLength:z.number().int().positive().max(8*1024*1024)}).strict();
export type OwnedRef=z.infer<typeof ownedRef>;
export const binding=z.object({graphId:id,exportId:id,project:id,context:id,executionId:id,invocation:id,profileId:id,recipeId:id,coreGraphDigest:digest}).strict();
export type OwnedBinding=z.infer<typeof binding>;
const stateShape={producerState:z.enum(['completed','failed','unavailable']),completedThrough:z.enum(['none',...ownedStages]),approvalStatus:z.enum(['approved','unavailable']),profileDigest:digest.optional(),recipeDigest:digest.optional(),failureStage:z.enum(ownedStages).optional(),failurePhase:id.optional(),failureReason:id.optional(),blockedStage:z.enum(ownedStages).optional(),unavailableReason:id.optional()};
export const stateSchema=z.object(stateShape).strict();
export type OwnedState=z.infer<typeof stateSchema>;
const limitationList=z.array(z.enum(ownedLimitations)).length(ownedLimitations.length);
const step=z.discriminatedUnion('outcome',[
 z.object({phase:z.enum(phases),outcome:z.literal('begin')}).strict(),
 z.object({phase:z.enum(phases),outcome:z.enum(['success','failure']),evidenceRef:ownedRef}).strict(),
]);
export const envelopeSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-offer-v2'),...binding.shape,...stateShape,witnessId:id,stage:id,slot:z.literal('snapshot'),plannedCaptures:z.number().int().min(0).max(8),naturalContentBinding:z.literal(false),consumptionStatus:z.literal('offered-inputs-only'),compilerWorkStatus:z.literal('unknown'),limitations:limitationList,blockedBeforePhase:z.enum(phases).optional(),phases:z.array(step).max(30)}).strict();
export const bundleSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-manifest-bundle-v1'),completenessDomain:z.literal('owned-recipe-inputs'),...binding.shape,...stateShape,limitations:limitationList,evidenceIndexRef:ownedRef,inputManifestRef:ownedRef.optional(),buildReceiptRef:ownedRef.optional(),runtimeSelectionRef:ownedRef.optional(),generationReceiptRef:ownedRef.optional(),offerReceiptRef:ownedRef.optional(),failureReceiptRef:ownedRef.optional(),unavailableEvidenceRef:ownedRef.optional()}).strict();
export type OwnedBundle=z.infer<typeof bundleSchema>;
export type OwnedEnvelope=z.infer<typeof envelopeSchema>;
const path=z.string().min(1).max(4096).refine(p=>!p.startsWith('/')&&!/[\\:\x00-\x1f\x7f]/.test(p)&&p.split('/').every(x=>x!==''&&x!=='.'&&x!=='..'));
const file=z.object({rootId:id,path,size:z.number().int().nonnegative().max(512*1024*1024),sha256:digest}).strict();
const inputRoles=z.enum(['driver-sources','driver-build-recipe','driver-build-inputs','driver-output-set','execution-environment','runtime-classpath','library-cohort','snapshot-generation','offer-inputs','storage-and-observation']);
const record=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('inventory'),inputRole:inputRoles,files:z.array(file).max(65536),directories:z.array(z.object({rootId:id,path}).strict()).max(65536),complete:z.literal(true)}).strict(),
 z.object({kind:z.literal('process'),operation:z.enum(['javac','jvm-start','snapshot-generator','bta-call']),instanceId:id,result:z.enum(['success','failure','COMPILATION_SUCCESS','COMPILATION_ERROR','COMPILATION_OOM_ERROR','COMPILER_INTERNAL_ERROR','exception']),started:z.literal(true),finished:z.literal(true),configurationId:id.optional(),parameterId:id.optional()}).strict().superRefine((p,ctx)=>{if(p.operation==='bta-call'?!p.configurationId||!p.parameterId:p.configurationId!==undefined||p.parameterId!==undefined)ctx.addIssue({code:'custom',message:'invalid call binding'});}),
 z.object({kind:z.literal('binding'),serviceId:id,projectId:id,configurationId:id,parameterId:id,source:file,arguments:z.array(z.string().max(4096)).max(4096),snapshotIds:z.array(id).min(1).max(16),singleUse:z.literal(true)}).strict(),
 z.object({kind:z.literal('observation'),phase:z.enum(phases),matched:z.boolean(),files:z.array(file).max(65536)}).strict(),
 z.object({kind:z.literal('failure'),stage:z.enum(ownedStages),phase:id,reason:id,notProduced:z.array(id).max(64)}).strict(),
 z.object({kind:z.literal('unavailable'),stage:z.enum(ownedStages),reason:id,notAttemptedRoles:z.array(inputRoles).max(10),phase:z.enum(phases).optional()}).strict(),
]);
export const ownedRecordSchema=record;
export type OwnedRecord=z.infer<typeof record>;
export const objectSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-object-v1'),role:z.enum([...stageRoles,'failure-receipt','unavailable-evidence','evidence-index','evidence']),binding,refs:z.array(ownedRef).max(16384),evidence:z.array(record).max(1024),envelopeRef:ownedRef.optional()}).strict();
export type OwnedObject=z.infer<typeof objectSchema>;
export const entrySchema=z.object({project:id,context:id,invocation:id,bundleRef:ownedRef.optional(),envelopeRef:ownedRef.optional()}).strict();
export const carrierSchema=z.object({role:roles,objectDigest:digest,bytes:z.string().max(8*1024*1024)}).strict();
export const failurePhases:Readonly<Record<string,Readonly<Record<string,readonly string[]>>>>={
 prepare:{capture:['input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation'],seal:['input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation']},
 build:{'allocate-output':['output_root_exists','output_root_invalid','storage_failed'],'verify-empty':['output_root_not_empty','output_root_invalid','budget_exceeded'],compiler:['build_failed','extra_evaluation'],'verify-inputs':['input_changed','output_root_invalid','budget_exceeded'],'collect-output':['inventory_mismatch','output_root_invalid','storage_failed','budget_exceeded'],packaging:['build_failed','inventory_mismatch','storage_failed','budget_exceeded']},
 'runtime-selection':{select:['runtime_binding_mismatch','input_changed','inventory_mismatch','storage_failed','budget_exceeded'],verify:['runtime_binding_mismatch','input_changed','inventory_mismatch','storage_failed','budget_exceeded']},
 'snapshot-generation':{'library-build':['build_failed','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation'],generate:['generation_binding_mismatch','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation'],save:['generation_binding_mismatch','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation'],verify:['generation_binding_mismatch','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation']},
 offer:{registration:['storage_failed','budget_exceeded','extra_evaluation'],'generation-binding':['generation_binding_mismatch','context_binding_mismatch','storage_failed','budget_exceeded'],seal:['snapshot_storage_mismatch','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation'],binding:['configuration_unregistered','configuration_binding_mismatch','parameter_binding_mismatch','context_binding_mismatch','storage_failed','budget_exceeded'],precheck:['configuration_unregistered','configuration_binding_mismatch','parameter_binding_mismatch','context_binding_mismatch','ic_state_mismatch','snapshot_stale','snapshot_storage_mismatch','library_stale','input_changed','inventory_mismatch','budget_exceeded','extra_evaluation'],call:['compile_failed','extra_evaluation'],postcheck:['snapshot_stale','snapshot_storage_mismatch','library_stale','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation'],capture:['snapshot_stale','snapshot_storage_mismatch','library_stale','input_changed','inventory_mismatch','storage_failed','budget_exceeded','extra_evaluation']},
};
const unavailableStages:Readonly<Record<string,readonly string[]>>={prepare:['profile_unapproved','recipe_unsupported','image_unsupported','host_control_unsupported'],build:['build_recipe_unsupported'],'runtime-selection':['loader_unsupported'],'snapshot-generation':['generation_unsupported'],offer:['execution_unsupported']};
export function validateState(s:OwnedState):number {
 const n=s.completedThrough==='none'?-1:ownedStages.indexOf(s.completedThrough);
 const has=(keys:(keyof OwnedState)[])=>keys.some(k=>s[k]!==undefined);
 if(s.approvalStatus==='approved'){if(!s.profileDigest||!s.recipeDigest||s.unavailableReason==='profile_unapproved')ownedFail();}
 else if(s.producerState!=='unavailable'||n!==-1||s.blockedStage!=='prepare'||s.unavailableReason!=='profile_unapproved'||has(['profileDigest','recipeDigest']))ownedFail();
 if(s.producerState==='completed'){if(n!==4||s.approvalStatus!=='approved'||has(['failureStage','failurePhase','failureReason','blockedStage','unavailableReason']))ownedFail();}
 else if(s.producerState==='failed'){
  if(n===4||s.approvalStatus!=='approved'||s.failureStage!==ownedStages[n+1]||!s.failurePhase||!s.failureReason||has(['blockedStage','unavailableReason']))ownedFail();
  if(!Object.hasOwn(failurePhases,s.failureStage!)||!Object.hasOwn(failurePhases[s.failureStage!]!,s.failurePhase!)||!failurePhases[s.failureStage!]![s.failurePhase!]?.includes(s.failureReason!))ownedFail();
 }else if(n===4||s.blockedStage!==ownedStages[n+1]||!s.unavailableReason||has(['failureStage','failurePhase','failureReason'])||!unavailableStages[s.blockedStage!]?.includes(s.unavailableReason))ownedFail();
 return n;
}
