/** Policy projection for independently collected native observations; not production adoption. */
import { z } from "zod";
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const common={applicationId:z.string().min(1),registrationForm:z.enum(["binary-instance","precompiled-pending"]),artifactKind:z.enum(["jar","directory","unavailable"]),toolchainProfileDigest:hash,inputsVerified:z.boolean(),originsVerified:z.boolean(),registrationUnique:z.boolean(),constructedThisInvocation:z.boolean(),instanceMatches:z.boolean(),descriptorMatches:z.boolean(),beginBeforeApplied:z.boolean(),ended:z.boolean(),endOutcome:z.enum(["complete","failed"]),observerFired:z.boolean(),comparison:z.enum(["raw-exact","entry-content-exact","directory-content-exact","same-path-origin","unverifiable"])};
const schema=z.discriminatedUnion("loadPolicy",[
 z.object({...common,loadPolicy:z.literal("prepared-output-only-v1"),directLoadObserved:z.boolean(),unverifiedTransform:z.boolean()}).strict(),
 z.object({...common,loadPolicy:z.literal("approved-gradle-loader-v1"),loaderProfileDigest:hash,runtimeConfigMatches:z.boolean(),snapshotVerified:z.boolean(),runtimeAttested:z.literal(true)}).strict()
]);
// A comparison only counts for the artifact kind it can describe.
const comparisons:Record<"jar"|"directory"|"unavailable",string[]>={jar:["raw-exact","entry-content-exact"],directory:["directory-content-exact","same-path-origin"],unavailable:[]};
export interface LoadApproval {toolchains:Set<string>;loaders:Set<string>;helper:boolean;trust:"disabled"|"local-plugin-build-v1"|"local-plugin-loader-attested-v2"}
export function assessPluginLoad(value:unknown,policy:LoadApproval){
 const parsed=schema.safeParse(value);if(!parsed.success)return {inputVerified:false,declarationsComplete:false,assurance:null,reasons:["invalid_load_evidence"]};
 const e=parsed.data,reasons:string[]=[];
 if(!policy.toolchains.has(e.toolchainProfileDigest)||!e.inputsVerified||!e.constructedThisInvocation||!e.instanceMatches||!e.descriptorMatches||!comparisons[e.artifactKind].includes(e.comparison))reasons.push("plugin_load_inputs_unverifiable");
 if(e.loadPolicy==="prepared-output-only-v1"){
  if(!e.directLoadObserved||e.unverifiedTransform)reasons.push("prepared_output_load_unverifiable");
 }else if(!policy.loaders.has(e.loaderProfileDigest)||!e.runtimeConfigMatches||!e.snapshotVerified)reasons.push("approved_loader_unverifiable");
 const inputVerified=!reasons.length;
 if(!e.registrationUnique||!e.originsVerified||!e.beginBeforeApplied||!e.ended||e.endOutcome!=="complete"||!e.observerFired)reasons.push("plugin_registration_incomplete");
 if(!policy.helper||policy.trust==="disabled")reasons.push("plugin_trust_disabled");
 else if((e.loadPolicy==="approved-gradle-loader-v1"||e.registrationForm==="precompiled-pending")&&policy.trust!=="local-plugin-loader-attested-v2")reasons.push("disabled_for_required_policy");
 const limitations=["plugin_build_inputs_author_attested","plugin_source_mapping_author_attested","plugin_classpath_transient_changes_not_detectable"];
 if(e.loadPolicy==="approved-gradle-loader-v1")limitations.push("plugin_runtime_transform_author_attested","plugin_loaded_bytes_not_independently_observed");
 if(e.registrationForm==="precompiled-pending")limitations.push("precompiled_registration_origin_author_attested");
 if(e.artifactKind==="directory")limitations.push("plugin_directory_snapshot_post_build");
 if(e.comparison==="same-path-origin")limitations.push("plugin_directory_origin_same_path_not_compared");
 return {inputVerified,declarationsComplete:!reasons.length,limitations,sourceArtifactStatus:e.loadPolicy==="approved-gradle-loader-v1"?"build-lineage-and-runtime-attested":"prepared-output-observed",transformStatus:e.loadPolicy==="approved-gradle-loader-v1"?"trusted-runtime-not-independently-observed":"requires-direct-observation",assurance:reasons.length?null:e.loadPolicy==="approved-gradle-loader-v1"?"author-attested-loader-and-structurally-checked":"prepared-output-observed",reasons};
}
