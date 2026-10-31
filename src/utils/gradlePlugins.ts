import {sanitizeExternalText} from "./externalText.js";
/** Convention-plugin provenance. Static import never loads classes or follows runtime URLs. */
import { z } from "zod";
import { createHash } from "node:crypto";
import { parseGradleJson } from "./gradleJson.js";
import { captureLoadTree, readProofFile, verifyDirectorySnapshot, treeDigest, loadBudget, type TreeEntry, type LoadBudget } from "./gradlePluginSnapshots.js";
import { compareJars, jarContents } from "./gradlePluginJar.js";
const id=z.string().min(1).max(1024),hash=z.string().regex(/^[a-f0-9]{64}$/);
const rel=z.string().min(1).max(4096).refine(s=>!/[\\:\x00-\x1f\x7f]/.test(s)&&s.split("/").every(p=>p&&p!=="."&&p!==".."));
const invocation=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest=(b:Buffer|string)=>createHash("sha256").update(b).digest("hex");
const json=(value:unknown)=>JSON.stringify(value).replace(/[\u0080-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
function canonical(value:unknown):string {
 if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
 if(value!==null&&typeof value==="object")return "{"+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>json(k)+":"+canonical(v)).join(",")+"}";
 return json(value);
}
export const pluginProfileDigest=(value:unknown)=>digest(canonical(value));
const producer=z.object({kind:z.enum(["build-src","included-build"]),rootDirectory:rel,projectPath:id}).strict();
const specFields={id,producer,pluginIds:z.array(id).min(1).max(1),implementationClass:id,
 registrationForm:z.enum(["binary-instance","precompiled-pending"]),
 sourcePaths:z.array(rel).min(1).max(10000),inputPaths:z.array(rel).min(1).max(10000),
 outputRoots:z.array(z.object({kind:z.enum(["jar","directory"]),path:rel,role:z.enum(["classes","resources","plugin-artifact"])}).strict()).min(1).max(32),
 sourceMappings:z.array(z.object({id,sourcePath:rel,implementationClass:id}).strict()).min(1).max(10000),
 toolchainProfileDigest:hash,
 assertions:z.object({buildInputs:z.literal("all-plugin-build-inputs-listed"),additions:z.literal("all-contributing-plugin-additions-use-helper"),mapping:z.literal("source-artifact-mapping-reviewed"),mutation:z.literal("immutable-during-export")}).strict()};
export const pluginSpecSchema=z.discriminatedUnion("loadPolicy",[
 z.object({...specFields,loadPolicy:z.literal("prepared-output-only-v1")}).strict(),
 z.object({...specFields,loadPolicy:z.literal("approved-gradle-loader-v1"),loaderProfileDigest:hash}).strict()
]);
export type PluginSpec=z.infer<typeof pluginSpecSchema>;
const file=z.object({kind:z.literal("jar"),path:rel,size:z.number().int().min(0).max(4*1024**2),sha256:hash}).strict();
const dir=z.object({kind:z.literal("directory"),path:rel,treeDigest:hash}).strict();
const artifact=z.discriminatedUnion("kind",[file,dir]);
const directoryRef=z.object({kind:z.literal("directory"),snapshotVersion:z.literal(1),invocationId:invocation,capturePhase:z.literal("export-task"),treeDigest:hash,manifestPath:rel}).strict();
const jarRef=z.object({kind:z.literal("jar"),snapshotVersion:z.literal(1),invocationId:invocation,capturePhase:z.literal("export-task"),size:z.number().int().min(0).max(4*1024**2),sha256:hash,snapshotPath:rel}).strict();
const appFields={id,pluginSpecId:id,ownerProjectId:id,invocationId:invocation,producerBuildId:id,
 registrationForm:z.enum(["binary-instance","precompiled-pending"]),registrationUnique:z.boolean(),beginBeforeApplied:z.boolean(),ended:z.boolean(),endOutcome:z.enum(["complete","failed"]),observerFired:z.boolean(),instanceMatches:z.boolean(),implementationClass:id,descriptorImplementation:id.nullable(),
 loadObservationPhase:z.literal("export-task"),builtArtifact:artifact.nullable(),expectedRecordIds:z.array(id).max(100000)};
export const pluginApplicationSchema=z.discriminatedUnion("loadPolicy",[
 z.object({...appFields,loadPolicy:z.literal("prepared-output-only-v1"),directLoadObserved:z.boolean(),unverifiedTransform:z.boolean()}).strict(),
 z.object({...appFields,loadPolicy:z.literal("approved-gradle-loader-v1"),loaderProfileDigest:hash,originRelation:z.enum(["same-path-origin","distinct-path-origin"]).nullable(),runtimeSnapshotRef:z.discriminatedUnion("kind",[jarRef,directoryRef]).nullable(),runtimeAttestations:z.object({approvedRuntimeOnly:z.literal(true),noUnregisteredAgentsOrLoaders:z.literal(true),artifactsImmutableThroughLoad:z.literal(true)}).strict()}).strict()
]).superRefine((a,ctx)=>{
 if(a.loadPolicy==='approved-gradle-loader-v1' && ((a.runtimeSnapshotRef?.kind==='directory') !== (a.originRelation!==null)))ctx.addIssue({code:'custom',message:'directory origin relation must match the snapshot kind'});
});
export type PluginApplication=z.infer<typeof pluginApplicationSchema>;
export const pluginOrigin=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("script")}).strict(),
 z.object({kind:z.literal("plugin"),applicationId:id,sourceMappingId:id}).strict()
]);
const toolchainEntry=z.object({id,role:z.enum(["gradle-distribution","gradle-api-generated","compiler","standard-library","jdk-runtime"]),size:z.number().int().min(0).max(512*1024**2),sha256:hash}).strict();
const toolchain=z.object({schemaVersion:z.literal(1),gradleVersion:id,distributionSha256:hash,jdkIdentity:id,compilerIdentity:id,generatedApiMethod:id,entries:z.array(toolchainEntry).max(2000)}).strict();
const agent=z.object({kind:z.enum(["javaagent","agentlib","agentpath"]),entryId:id,sha256:hash}).strict();
const loader=z.object({schemaVersion:z.literal(1),toolchainProfileDigest:hash,gradleVersion:id,jdkIdentity:id,loaderPolicy:z.literal("gradle-managed-only"),transformPolicy:z.literal("operator-attested-pipeline"),agents:z.array(agent).max(2000),exportSettings:z.object({configurationCache:z.literal(false),parallel:z.literal(false)}).strict(),attestations:z.object({approvedRuntimeOnly:z.literal(true),noUnregisteredAgentsOrLoaders:z.literal(true),artifactsImmutableThroughLoad:z.literal(true)}).strict()}).strict();
const classpath=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("toolchain"),entryId:id,size:z.number().int().min(0),sha256:hash}).strict(),
 z.object({kind:z.literal("plugin-input"),artifact}).strict()
]);
export const pluginEvidenceSchema=z.object({invocationId:invocation,
 toolchainProfiles:z.array(toolchain).max(32),loaderProfiles:z.array(loader).max(32),
 toolchainReceipts:z.array(z.object({profileDigest:hash,beforeVerified:z.boolean(),afterVerified:z.boolean(),runtimeIdentityVerified:z.boolean(),bytesRead:z.number().int().min(0).max(2*1024**3),maxBuffer:z.number().int().positive().max(1024**2)}).strict()).max(32),
 runtime:z.object({gradleVersion:id,jdkIdentity:id,agents:z.array(agent).max(2000),configurationCache:z.literal(false),parallel:z.literal(false)}).strict(),
 builds:z.array(z.object({id,producer,invocationId:invocation,inputs:z.array(z.object({path:rel,sha256:hash}).strict()).max(10000),
 receipts:z.array(z.object({id,task:id,type:z.enum(["compile","package"]),executed:z.boolean(),didWork:z.boolean(),skipped:z.boolean(),failure:z.boolean(),classpath:z.array(classpath).max(10000),outputs:z.array(artifact).max(10000)}).strict()).max(2000)}).strict()).max(100)
}).strict();
export type PluginEvidence=z.infer<typeof pluginEvidenceSchema>;
export type PluginTrust="local-plugin-build-v1"|"local-plugin-loader-attested-v2"|undefined;
export interface PluginSettings {trust:PluginTrust;invalid:boolean;toolchains:Set<string>;loaders:Set<string>}
export function parsePluginSettings(env:NodeJS.ProcessEnv):PluginSettings {
 const t=env.OSV_MCP_GRADLE_PLUGIN_TRUST;
 const trustInvalid=!!t&&!['local-plugin-build-v1','local-plugin-loader-attested-v2'].includes(t);let invalid=trustInvalid;
 const profiles=(name:string)=>{const raw=env[name];if(!raw)return new Set<string>();const entries=raw.split(',');if(entries.length>32||entries.some(x=>!hash.safeParse(x).success)||new Set(entries).size!==entries.length){invalid=true;return new Set<string>();}return new Set(entries);};
 const toolchains=profiles('OSV_MCP_GRADLE_PLUGIN_TOOLCHAIN_PROFILES'),loaders=profiles('OSV_MCP_GRADLE_PLUGIN_LOADER_PROFILES');
 return {trust:trustInvalid?undefined:(t||undefined) as PluginTrust,invalid,toolchains,loaders};
}
let startup:PluginSettings|undefined;
export const startupPluginSettings=()=>startup??=parsePluginSettings(process.env);
export function resetPluginSettingsForTests(){startup=undefined;}
export type PluginStatus="accepted"|"disabled"|"disabled_for_required_policy"|"invalid"|"unverifiable"|"missing_assertion";
export interface PluginAnalysis {inputVerified:boolean;declarationsComplete:boolean;status:PluginStatus;assurance:string|null;limitations:string[];reasons:string[];sources:Map<string,string>;applications:{id:string;load_policy:string;input_status:string;trust_status:PluginStatus;source_artifact_status:string;transform_status:string;comparison:string}[]}
export const pluginLimitations=['plugin_build_inputs_author_attested','plugin_source_mapping_author_attested','plugin_toolchain_profile_author_attested','plugin_compiler_and_loader_trusted','plugin_input_transient_changes_not_detectable','plugin_classpath_transient_changes_not_detectable'];
/** One instance per scan. All contexts share artifact bytes/work budgets and immutable read results. */
export class GradlePluginReader {

 private artifacts=new Map<string,Promise<Buffer|TreeEntry[]>>();
 private descriptors=new WeakMap<Buffer,Map<string,Buffer>>();
 private jarComparisons=new Map<string,ReturnType<typeof compareJars>>();
 private verifiedBuilds=new WeakMap<object,Set<string>>();
 private snapshots=new Map<string,Promise<string>>();
 private reads=new Map<string,Promise<Buffer>>();
 private work=2000000;
 constructor(private settings:PluginSettings=startupPluginSettings(),private budget:LoadBudget=loadBudget()){}
 private tick(){if(--this.work<0)throw new Error('plugin_work_budget');}
 private read(root:string,p:string){const key=root+'\0'+p;let value=this.reads.get(key);if(!value){value=readProofFile(root,p,this.budget);this.reads.set(key,value);}return value;}
 private async artifact(root:string,a:z.infer<typeof artifact>){
  this.tick();const key=root+'\0'+JSON.stringify(a);let cached=this.artifacts.get(key);
  if(!cached){cached=(async()=>{if(a.kind==='jar'){const b=await this.read(root,a.path);if(b.length!==a.size||digest(b)!==a.sha256)throw new Error('plugin_artifact_stale');const descriptors=new Map<string,Buffer>();jarContents(b,this.budget,(name,bytes)=>{if(name.startsWith('META-INF/gradle-plugins/'))descriptors.set(name,Buffer.from(bytes));});this.descriptors.set(b,descriptors);return b;}const entries=await captureLoadTree(root,a.path,this.budget);if(treeDigest(entries)!==a.treeDigest)throw new Error('plugin_artifact_stale');return entries;})();this.artifacts.set(key,cached);}
  return cached;
 }
 async analyze(root:string,e:PluginEvidence,specs:PluginSpec[],scopePluginIds:string[],apps:PluginApplication[],records:{id:string;source:{kind:string;path:string;sha256:string}|null;origin?:z.infer<typeof pluginOrigin>;catalogUses:unknown[]}[],projectId:string,helper:boolean):Promise<PluginAnalysis>{
  const result:PluginAnalysis={inputVerified:true,declarationsComplete:false,status:'missing_assertion',assurance:null,limitations:[...pluginLimitations],reasons:[],sources:new Map(),applications:[]};
  try {
   const unique=<T>(xs:T[],key:(x:T)=>string)=>{this.tick();const keys=xs.map(x=>{this.tick();return key(x);});if(new Set(keys).size!==keys.length)throw new Error('plugin_duplicate_identity');};
   unique(specs,s=>s.id);unique(apps,a=>a.id);unique(e.builds,b=>b.id);unique(e.toolchainProfiles,pluginProfileDigest);unique(e.loaderProfiles,pluginProfileDigest);unique(e.toolchainReceipts,r=>r.profileDigest);
   const required=new Set(scopePluginIds);if(required.size!==scopePluginIds.length)throw new Error('plugin_scope_invalid');
   const declared=new Map(specs.map(s=>[s.id,s]));if(scopePluginIds.some(id=>!declared.has(id)))throw new Error('plugin_scope_invalid');
   if([...required].some(id=>!apps.some(a=>a.pluginSpecId===id)))throw new Error('plugin_load_evidence_missing');
   const seen=new Map<string,string[]>();
   const attestations=apps.some(a=>a.loadPolicy==='approved-gradle-loader-v1');
   if(attestations)result.limitations.push('plugin_runtime_transform_author_attested','plugin_loaded_bytes_not_independently_observed');
   if(apps.some(a=>a.registrationForm==='precompiled-pending'))result.limitations.push('precompiled_registration_origin_author_attested');
   if(apps.some(a=>a.loadPolicy==='approved-gradle-loader-v1'&&a.runtimeSnapshotRef?.kind==='directory'))result.limitations.push('plugin_directory_snapshot_post_build');
   if(apps.some(a=>a.loadPolicy==='approved-gradle-loader-v1'&&a.originRelation==='same-path-origin'))result.limitations.push('plugin_directory_origin_same_path_not_compared');
   for(const a of apps){
    this.tick();const s=declared.get(a.pluginSpecId);if(!s||!required.has(s.id)||a.ownerProjectId!==projectId||a.invocationId!==e.invocationId||a.loadPolicy!==s.loadPolicy||a.registrationForm!==s.registrationForm||a.implementationClass!==s.implementationClass)throw new Error('plugin_application_mismatch');
    const profile=e.toolchainProfiles.find(p=>pluginProfileDigest(p)===s.toolchainProfileDigest),receipt=e.toolchainReceipts.find(r=>r.profileDigest===s.toolchainProfileDigest);
    if(!profile||!receipt?.runtimeIdentityVerified||!['jdk/java','jdk/modules','jdk/release'].every(id=>profile.entries.some(e=>e.id===id&&e.role==='jdk-runtime'))||!this.settings.toolchains.has(s.toolchainProfileDigest)||!receipt?.beforeVerified||!receipt.afterVerified||profile.gradleVersion!==e.runtime.gradleVersion||profile.jdkIdentity!==e.runtime.jdkIdentity||Buffer.byteLength(JSON.stringify(profile))>1024**2)throw new Error('plugin_toolchain_unverifiable');
    unique(profile.entries,x=>x.id);if(receipt.bytesRead<2*profile.entries.reduce((n,x)=>n+x.size,0))throw new Error('plugin_toolchain_receipt_incomplete');
    const build=e.builds.find(b=>b.id===a.producerBuildId);if(!build||build.invocationId!==e.invocationId||JSON.stringify(build.producer)!==JSON.stringify(s.producer))throw new Error('plugin_build_identity_mismatch');
    unique(build.inputs,x=>x.path);unique(build.receipts,x=>x.id);
    const siblingSpecs=specs.filter(x=>JSON.stringify(x.producer)===JSON.stringify(s.producer)),inputPaths=[...new Set(siblingSpecs.flatMap(x=>x.inputPaths))],outputRoots=siblingSpecs.flatMap(x=>x.outputRoots);
    if(build.inputs.length!==inputPaths.length||inputPaths.some(p=>!build.inputs.some(i=>i.path===p)))throw new Error('plugin_input_inventory_incomplete');
    const buildKey=root+'\0'+s.toolchainProfileDigest;
    const verified=this.verifiedBuilds.get(build)??new Set<string>();
    if(!verified.has(buildKey)){
    for(const i of build.inputs){this.tick();if(digest(await this.read(root,i.path))!==i.sha256)throw new Error('plugin_inputs_stale');}
    let compiled=false;
    for(const r of build.receipts){this.tick();if(!r.executed||!r.didWork||r.skipped||r.failure)throw new Error('plugin_build_receipt_incomplete');if(r.type==='compile'){compiled=true;if(!r.classpath.length)throw new Error('plugin_classpath_incomplete');}
     for(const cp of r.classpath){this.tick();if(cp.kind==='toolchain'){const entry=profile.entries.find(i=>i.id===cp.entryId);if(!entry||entry.size!==cp.size||entry.sha256!==cp.sha256)throw new Error('plugin_classpath_unverifiable');}else {if(!inputPaths.includes(cp.artifact.path)&&!outputRoots.some(o=>o.kind===cp.artifact.kind&&o.path===cp.artifact.path))throw new Error('plugin_classpath_inventory_incomplete');await this.artifact(root,cp.artifact);}}
     for(const output of r.outputs){this.tick();if(!outputRoots.some(o=>o.kind===output.kind&&o.path===output.path))throw new Error('plugin_output_inventory_incomplete');await this.artifact(root,output);}
    }
    if(!compiled)throw new Error('plugin_build_lineage_incomplete');
     verified.add(buildKey);this.verifiedBuilds.set(build,verified);
    }
    if(!a.builtArtifact||!s.outputRoots.some(o=>o.role==='plugin-artifact'&&o.kind===a.builtArtifact!.kind&&o.path===a.builtArtifact!.path)||!build.receipts.some(r=>r.type==='package'&&r.outputs.some(o=>JSON.stringify(o)===JSON.stringify(a.builtArtifact))))throw new Error('plugin_build_lineage_incomplete');
    const built=await this.artifact(root,a.builtArtifact);
    const descriptor='META-INF/gradle-plugins/'+s.pluginIds[0]+'.properties';let descriptorBytes:Buffer;
    if(Buffer.isBuffer(built)){
     const content=this.descriptors.get(built)?.get(descriptor);
     if(!content)throw new Error('plugin_descriptor_missing');descriptorBytes=content;
    }else descriptorBytes=await this.read(root,a.builtArtifact.path+'/'+descriptor);
    const lines=descriptorBytes.toString('utf8').split(/\r?\n/).filter(x=>x.startsWith('implementation-class='));
    if(lines.length!==1||lines[0]!==`implementation-class=${s.implementationClass}`)throw new Error('plugin_descriptor_mismatch');
    if(!a.instanceMatches||a.descriptorImplementation!==s.implementationClass)throw new Error('plugin_instance_unverifiable');
    let comparison='direct-origin';
    if(a.loadPolicy==='prepared-output-only-v1'){if(!a.directLoadObserved||a.unverifiedTransform)throw new Error('plugin_direct_load_unverifiable');}
    else {
     if(s.loadPolicy!=='approved-gradle-loader-v1'||a.loaderProfileDigest!==s.loaderProfileDigest||!this.settings.loaders.has(a.loaderProfileDigest))throw new Error('plugin_loader_not_approved');
     const loader=e.loaderProfiles.find(l=>pluginProfileDigest(l)===a.loaderProfileDigest);
     if(!loader||Buffer.byteLength(JSON.stringify(loader))>1024**2||loader.toolchainProfileDigest!==s.toolchainProfileDigest||loader.gradleVersion!==e.runtime.gradleVersion||loader.jdkIdentity!==e.runtime.jdkIdentity||canonical(loader.agents)!==canonical(e.runtime.agents))throw new Error('plugin_runtime_mismatch');
     unique(loader.agents,x=>x.kind+':'+x.entryId);if(loader.agents.some(a=>!profile.entries.some(e=>e.id===a.entryId&&e.sha256===a.sha256)))throw new Error('plugin_agent_profile_mismatch');
     if(!a.runtimeSnapshotRef||a.runtimeSnapshotRef.invocationId!==e.invocationId||a.runtimeSnapshotRef.kind!==a.builtArtifact.kind)throw new Error('plugin_snapshot_missing');
     const ref=a.runtimeSnapshotRef;
     if(ref.kind==='jar'){if(ref.snapshotPath!==`.osv-mcp/plugin-runtime/${e.invocationId}/jars/${ref.sha256}.jar`)throw new Error('plugin_snapshot_path');const runtime=await this.read(root,ref.snapshotPath);if(runtime.length!==ref.size||digest(runtime)!==ref.sha256||!Buffer.isBuffer(built))throw new Error('plugin_snapshot_mismatch');const key=root+'\0'+digest(built)+'\0'+ref.sha256;let match=this.jarComparisons.get(key);if(match===undefined){match=compareJars(built,runtime,this.budget);this.jarComparisons.set(key,match);}if(match==='unverifiable')throw new Error('plugin_snapshot_mismatch');comparison=match;}
     else {const key=root+'\0'+JSON.stringify(ref);let snapshot=this.snapshots.get(key);if(!snapshot){snapshot=verifyDirectorySnapshot(root,ref,this.budget).then(m=>m.treeDigest);this.snapshots.set(key,snapshot);}if(Buffer.isBuffer(built)||await snapshot!==treeDigest(built))throw new Error('plugin_snapshot_mismatch');comparison=a.originRelation==='same-path-origin'?'same-path-origin':'directory-content-exact';}
    }
    const ids=seen.get(s.id)??[];ids.push(a.id);seen.set(s.id,ids);
    let status:PluginStatus=!helper||!this.settings.trust?'disabled':(a.loadPolicy==='approved-gradle-loader-v1'||a.registrationForm==='precompiled-pending')&&this.settings.trust!=='local-plugin-loader-attested-v2'?'disabled_for_required_policy':'accepted';
    if(status==='accepted'&&(!a.registrationUnique||!a.beginBeforeApplied||!a.ended||a.endOutcome!=='complete'||!a.observerFired))status='missing_assertion';
    result.applications.push({id:sanitizeExternalText(a.id),comparison,load_policy:a.loadPolicy,input_status:'verified',trust_status:status,source_artifact_status:a.loadPolicy==='approved-gradle-loader-v1'?'build-lineage-and-runtime-attested':'prepared-output-observed',transform_status:a.loadPolicy==='approved-gradle-loader-v1'?'trusted-runtime-not-independently-observed':'prepared-output-observed'});
   }
   if([...required].some(id=>!seen.has(id)))result.reasons.push('plugin_application_missing');
   if([...seen.values()].some(xs=>xs.length!==1))result.reasons.push('plugin_duplicate_registration');
   const recordIds=new Set<string>(),byApp=new Map<string,string[]>();
   for(const r of records){this.tick();if(recordIds.has(r.id))throw new Error('plugin_record_id_duplicate');recordIds.add(r.id);if(r.origin?.kind==='script'){if(r.source?.kind==='convention-plugin'||specs.some(s=>s.sourcePaths.includes(r.source?.path??'')))throw new Error('plugin_source_disguised_as_script');continue;}
    if(r.origin?.kind!=='plugin')throw new Error('plugin_origin_missing');
    const a=apps.find(a=>a.id===(r.origin as {applicationId:string}).applicationId),s=a&&declared.get(a.pluginSpecId),m=s?.sourceMappings.find(m=>m.id===(r.origin as {sourceMappingId:string}).sourceMappingId);
    if(!a||!m||m.implementationClass!==a.implementationClass||r.source?.kind!=='convention-plugin'||r.source.path!==m.sourcePath||digest(await this.read(root,m.sourcePath))!==r.source.sha256||r.catalogUses.length)throw new Error('plugin_source_mapping_invalid');
    const ids=byApp.get(a.id)??[];ids.push(r.id);byApp.set(a.id,ids);result.sources.set(r.id,m.sourcePath);
   }
   for(const a of apps){this.tick();if(new Set(a.expectedRecordIds).size!==a.expectedRecordIds.length||canonical([...a.expectedRecordIds].sort())!==canonical((byApp.get(a.id)??[]).sort()))result.reasons.push('plugin_record_coverage_incomplete');}
   const statuses=result.applications.map(a=>a.trust_status);
   result.status=!helper||!this.settings.trust?'disabled':statuses.includes('disabled_for_required_policy')?'disabled_for_required_policy':result.reasons.length||statuses.includes('missing_assertion')?'missing_assertion':'accepted';
   result.declarationsComplete=result.status==='accepted';result.assurance=result.declarationsComplete?(attestations?'author-attested-loader-and-structurally-checked':'prepared-output-observed'):null;
   if(!result.declarationsComplete)result.reasons.push('plugin_declarations_incomplete');
  }catch(error){
   const reason=error instanceof Error&&/^plugin_/.test(error.message)?error.message:'plugin_evidence_unverifiable';
   const declarationOnly=['plugin_origin_missing','plugin_source_disguised_as_script','plugin_source_mapping_invalid','plugin_record_id_duplicate'].includes(reason);
   result.inputVerified=declarationOnly;result.declarationsComplete=false;result.assurance=null;result.status=declarationOnly?'invalid':'unverifiable';result.sources.clear();result.reasons.push(reason);
  }
  return result;
 }
}
