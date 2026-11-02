/** G1 consumes operator-owned in-memory metadata only. No path, URL or executable loader. */
import {z} from 'zod';
import {ownedDigest,canonicalOwnedJson,parseOwnedJson,OWNED_LIMITS} from './gradleOwnedJson.js';
import {ownedLimitations} from './gradleOwnedSchema.js';
export const OWNED_TRUST_ENV='OSV_MCP_GRADLE_OWNED_BTA_TRUST';
export const OWNED_PROFILES_ENV='OSV_MCP_GRADLE_OWNED_BTA_PROFILES';
const model='owned-bta-offered-inputs-v1';
const hash=z.string().regex(/^[a-f0-9]{64}$/).refine(s=>s!=='0'.repeat(64));
const id=z.string().min(1).max(1024);
const unique=<T>(xs:T[])=>new Set(xs).size===xs.length;
const ids=z.array(id).max(1024).refine(unique);
const hashes=z.array(hash).max(1024).refine(unique);
const roles=['prepare','javac-build','packaging','runtime-selection','library-build','snapshot-generation','offer','capture'] as const;
export const ownedProfileSchema=z.object({
 schema:z.literal('osv-mcp.gradle-owned-bta-profile-v1'),model:z.literal(model),purpose:z.literal('diagnostic-only'),profileId:id,
 tuple:z.object({os:z.enum(['linux','darwin','win32']),architecture:z.enum(['x64','arm64']),gradle:z.enum(['8.11.1','9.2.1']),jdk:id,node:id,btaApi:id,btaImplementation:id,kotlinCompiler:id}).strict(),
 schemas:z.object({graphWrapper:z.literal(4),coreGraph:z.array(z.union([z.literal(1),z.literal(2),z.literal(3)])).min(1).max(3).refine(unique),envelope:z.literal(2),bundle:z.literal(1),objects:z.tuple([z.literal(1)])}).strict(),
 recipeRegistryId:id,recipes:z.object(Object.fromEntries(roles.map(r=>[r,hash])) as Record<typeof roles[number],typeof hash>).strict(),
 executorProfileDigest:hash,jdkImageProfileDigest:hash,nodeImageProfileDigest:hash,platformProfileDigest:hash,loaderProfileDigest:hash,
 hostControlPolicy:z.literal('data-only-broker-v1'),
 runtimePolicy:z.object({artifacts:z.array(z.object({id,role:z.enum(['api','implementation','compiler','stdlib','generator','dependency']),sha256:hash}).strict()).min(1).max(1024).refine(xs=>unique(xs.map(x=>x.id))),occurrences:z.array(id).min(1).max(4096),serviceProvider:id,generator:z.object({artifactId:id,format:id,granularity:id}).strict()}).strict(),
 executionPolicy:z.object({synchronous:z.literal(true),bta:z.literal('owned-jvm-child-in-process'),fallback:z.literal('error'),parallel:z.literal(false),configurationCache:z.literal(false),driverBuildCache:z.literal(false)}).strict(),
 sourcePolicy:z.object({types:z.array(z.enum(['source','resource','literal'])).min(1).max(3).refine(unique),encoding:z.literal('UTF-8'),arguments:ids.refine(xs=>xs.every(x=>!/^(-javaagent|-agentlib|-agentpath|--patch-module|--upgrade-module-path|--require|--import|--loader|@)/.test(x))),environment:ids.refine(xs=>xs.every(x=>!['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','NODE_OPTIONS','NODE_PATH','CLASSPATH'].includes(x))),properties:ids.refine(xs=>xs.every(x=>!['java.system.class.loader','java.class.path','jdk.module.patch.0'].includes(x))),proc:z.literal('none'),implicit:z.literal('none'),unregisteredArgfiles:z.literal(false),unregisteredGenerators:z.literal(false)}).strict(),
 packagePolicy:z.object({freshOutput:z.literal(true),allEntriesMapped:z.literal(true),entryStages:z.array(z.object({entry:id,stage:z.enum(roles)}).strict()).min(1).max(4096).refine(xs=>unique(xs.map(x=>x.entry)))}).strict(),
 storagePolicy:z.object({rootRoles:ids.refine(xs=>xs.length>0),baseline:z.literal('sealed-bytes'),validateBeforeWrite:z.literal(true),symlinks:z.literal(false)}).strict(),
 budgets:z.object({metadataBytes:z.number().int().positive().max(OWNED_LIMITS.metadataBytes),objectBytes:z.number().int().positive().max(OWNED_LIMITS.objectBytes),objects:z.number().int().positive().max(OWNED_LIMITS.objects),refs:z.number().int().positive().max(OWNED_LIMITS.refs),depth:z.number().int().positive().max(OWNED_LIMITS.depth),nodes:z.number().int().positive().max(OWNED_LIMITS.nodes),fileBytes:z.number().int().positive().max(8*1024*1024),totalFileBytes:z.number().int().positive().max(64*1024*1024),entries:z.number().int().positive().max(10000)}).strict(),
 authorityId:id,observationProfileDigest:hash,
 requiredLimitations:z.array(z.enum([...ownedLimitations,'producer-build-attested','caller-witness-dependent','loader-attested-dependent'])).length(ownedLimitations.length+3).refine(unique),
 reviewAssertions:z.object({inputsClosed:z.literal(true),brokerOwnsConfiguration:z.literal(true),noUnregisteredAgents:z.literal(true),publicObservationReviewed:z.literal(true)}).strict()
}).strict().superRefine((p,ctx)=>{
 const ids=new Set(p.runtimePolicy.artifacts.map(x=>x.id));
 if(p.runtimePolicy.occurrences.some(x=>!ids.has(x))||!ids.has(p.runtimePolicy.generator.artifactId)||[...ids].some(x=>!p.runtimePolicy.occurrences.includes(x)))ctx.addIssue({code:'custom',message:'runtime closure'});
});
export type OwnedProfile=z.infer<typeof ownedProfileSchema>;
export interface OwnedSettings {readonly enabled:boolean;readonly invalid:boolean;readonly profiles:readonly string[]}
export function parseOwnedSettings(trust?:string,profiles?:string):OwnedSettings {
 const values=profiles?profiles.split(','):[];
 const invalid=!!trust&&trust!==model||values.length>32||!unique(values)||values.some(x=>!hash.safeParse(x).success);
 return Object.freeze({enabled:trust===model&&!invalid,invalid,profiles:Object.freeze(invalid?[]:values)});
}
let startup:OwnedSettings|undefined;
export function startupOwnedSettings():OwnedSettings {return startup??=parseOwnedSettings(process.env[OWNED_TRUST_ENV],process.env[OWNED_PROFILES_ENV]);}
export function resetOwnedSettingsForTests():void {startup=undefined;}
// Child specifications are independent reviewed pins, not executable recipes or evidence.
const childSchema=z.object({schema:z.literal('osv-mcp.gradle-owned-profile-pin-v1'),id,kind:z.enum(['executor','jdk-image','node-image','platform','loader','observation','recipe']),specificationDigest:hash,dependencies:hashes,recipeRoles:z.array(z.enum(roles)).min(1).max(8).refine(unique).optional()}).strict().refine(p=>p.kind==='recipe'?!!p.recipeRoles:p.recipeRoles===undefined);
const recordSchema=z.object({digest:hash,body:z.unknown()}).strict();
const registrySchema=z.object({profiles:z.array(recordSchema).max(32),pins:z.array(recordSchema).max(256),recipeRegistries:z.array(z.object({id,recipes:z.array(z.object({id,digest:hash}).strict()).max(256)}).strict()).max(32)}).strict();
export interface OwnedClaim {profileId:string;recipeId:string;profileDigest?:string;recipeDigest?:string}
export type OwnedGateReason='configuration_invalid'|'trust_disabled'|'profile_unapproved'|'recipe_unapproved'|'profile_mismatch'|'witness_unavailable';
export interface OwnedRegistry {readonly invalid:boolean;check(claim:OwnedClaim,settings:OwnedSettings):OwnedGateReason}
export function createOwnedRegistry(input:unknown):OwnedRegistry {
 const profiles=new Map<string,OwnedProfile>(),byId=new Map<string,string>(),pins=new Map<string,z.infer<typeof childSchema>>(),recipes=new Map<string,Map<string,string>>();let invalid=false;
 try {
  // Snapshot trusted startup metadata under the canonical JSON size/node limits.
  const raw=registrySchema.parse(parseOwnedJson(canonicalOwnedJson(input,OWNED_LIMITS.metadataBytes),OWNED_LIMITS.metadataBytes));
  const pinIds=new Set<string>();
  for(const r of raw.pins){const p=childSchema.parse(r.body);if(ownedDigest(p)!==r.digest||pins.has(r.digest)||pinIds.has(p.id))throw Error();pins.set(r.digest,p);pinIds.add(p.id);}
  const active=new Set<string>(),done=new Set<string>();
  function visit(d:string,depth=0):void {if(depth>32||active.has(d)||!pins.has(d))throw Error();if(done.has(d))return;active.add(d);for(const c of pins.get(d)!.dependencies)visit(c,depth+1);active.delete(d);done.add(d);}
  for(const d of pins.keys())visit(d);
  for(const r of raw.recipeRegistries){if(recipes.has(r.id)||!unique(r.recipes.map(x=>x.id)))throw Error();const rs=new Map(r.recipes.map(x=>[x.id,x.digest]));for(const d of rs.values())if(pins.get(d)?.kind!=='recipe')throw Error();recipes.set(r.id,rs);}
  for(const r of raw.profiles){const p=ownedProfileSchema.parse(r.body);if(ownedDigest(p)!==r.digest||profiles.has(r.digest)||byId.has(p.profileId))throw Error();
   for(const [d,k] of [[p.executorProfileDigest,'executor'],[p.jdkImageProfileDigest,'jdk-image'],[p.nodeImageProfileDigest,'node-image'],[p.platformProfileDigest,'platform'],[p.loaderProfileDigest,'loader'],[p.observationProfileDigest,'observation']] as const)if(pins.get(d)?.kind!==k)throw Error();
   const rs=recipes.get(p.recipeRegistryId);if(!rs||Object.entries(p.recipes).some(([role,d])=>![...rs.values()].includes(d)||!pins.get(d)?.recipeRoles?.includes(role as typeof roles[number])))throw Error();
   profiles.set(r.digest,p);byId.set(p.profileId,r.digest);
  }
 }catch{invalid=true;profiles.clear();byId.clear();recipes.clear();}
 return Object.freeze({invalid,check(c:OwnedClaim,s:OwnedSettings):OwnedGateReason {
  if(s.invalid||invalid)return 'configuration_invalid';
  if(!s.enabled)return 'trust_disabled';
  // Unknown or unapproved digests are never promoted by a known ID.
  if(!c.profileDigest||!s.profiles.includes(c.profileDigest)||!profiles.has(c.profileDigest))return 'profile_unapproved';
  const p=profiles.get(c.profileDigest)!;
  if(p.profileId!==c.profileId||byId.get(c.profileId)!==c.profileDigest)return 'profile_mismatch';
  const recipe=recipes.get(p.recipeRegistryId)!.get(c.recipeId);
  if(!recipe||!Object.values(p.recipes).includes(recipe))return 'recipe_unapproved';
  if(recipe!==c.recipeDigest)return 'profile_mismatch';
  return 'witness_unavailable';
 }});
}
export const emptyOwnedRegistry=createOwnedRegistry({profiles:[],pins:[],recipeRegistries:[]});
export interface OwnedPolicy {readonly settings:OwnedSettings;readonly registry:OwnedRegistry}
export function startupOwnedPolicy():OwnedPolicy {return Object.freeze({settings:startupOwnedSettings(),registry:emptyOwnedRegistry});}
