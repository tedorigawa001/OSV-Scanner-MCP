import {it,expect,afterEach} from 'vitest';
import {parseOwnedSettings,createOwnedRegistry,emptyOwnedRegistry,ownedProfileSchema,startupOwnedSettings,resetOwnedSettingsForTests,OWNED_TRUST_ENV,OWNED_PROFILES_ENV,type OwnedPolicy} from '../../utils/gradleOwnedPolicy.js';
import {ownedDigest,ownedSha256,OWNED_LIMITS} from '../../utils/gradleOwnedJson.js';
import {ownedLimitations} from '../../utils/gradleOwnedSchema.js';
import {ownedFixture,rewriteOwned} from '../fixtures/gradleOwnedFixture.js';
import {parseGradleExport} from '../../utils/gradleOwnedManifest.js';
import {createGradleBudget} from '../../utils/gradleGraph.js';
const trust='owned-bta-offered-inputs-v1';
import {ownedPolicyFixture as fixture} from '../fixtures/gradleOwnedPolicyFixture.js';

const inspect=(doc:any,policy:OwnedPolicy)=>parseGradleExport(JSON.stringify(doc),createGradleBudget(),policy);
function policyFixture(){const f=fixture();return {...f,policy:{settings:parseOwnedSettings(trust,f.claim.profileDigest),registry:createOwnedRegistry(f.raw)}};}
it('defaults to disabled; only the exact new trust enables it',()=>{
 for(const t of [undefined,''])expect(parseOwnedSettings(t)).toMatchObject({enabled:false,invalid:false,profiles:[]});
 expect(parseOwnedSettings(trust)).toMatchObject({enabled:true,invalid:false});
 for(const t of ['true','local-plugin-loader-attested-v2',' '+trust,trust+' '])expect(parseOwnedSettings(t)).toMatchObject({enabled:false,invalid:true});
});
for(const input of ['a'.repeat(64)+','+'a'.repeat(64),'A'.repeat(64),'0'.repeat(64),' '+ 'a'.repeat(64),'a'.repeat(64)+',',Array.from({length:33},(_,i)=>ownedSha256(String(i))).join(',')])it('rejects invalid approval set '+input.slice(0,8),()=>expect(parseOwnedSettings(trust,input)).toMatchObject({enabled:false,invalid:true,profiles:[]}));
it('accepts 32 distinct digests and makes immutable snapshots',()=>{const values=Array.from({length:32},(_,i)=>ownedSha256(String(i)));const s=parseOwnedSettings(trust,values.join(','));expect(s.invalid).toBe(false);expect(s.profiles).toEqual(values);expect(Object.isFrozen(s.profiles)).toBe(true);});
const oldTrust=process.env[OWNED_TRUST_ENV],oldProfiles=process.env[OWNED_PROFILES_ENV];
afterEach(()=>{if(oldTrust===undefined)delete process.env[OWNED_TRUST_ENV];else process.env[OWNED_TRUST_ENV]=oldTrust;if(oldProfiles===undefined)delete process.env[OWNED_PROFILES_ENV];else process.env[OWNED_PROFILES_ENV]=oldProfiles;resetOwnedSettingsForTests();});
it('captures settings once at startup',()=>{resetOwnedSettingsForTests();delete process.env[OWNED_TRUST_ENV];const first=startupOwnedSettings();process.env[OWNED_TRUST_ENV]=trust;expect(startupOwnedSettings()).toBe(first);expect(first.enabled).toBe(false);});
it('valid independent metadata reaches only the unimplemented witness gate',()=>{const {raw,claim}=fixture();const r=createOwnedRegistry(raw);expect(r.invalid).toBe(false);expect(r.check(claim,parseOwnedSettings(trust,claim.profileDigest))).toBe('witness_unavailable');expect(emptyOwnedRegistry.check(claim,parseOwnedSettings(trust,claim.profileDigest))).toBe('profile_unapproved');});
for(const [label,change] of [
 ['body digest',(f:any)=>f.raw.profiles[0].body.authorityId='other'],
 ['same ID new body',(f:any)=>{const body={...f.profile,authorityId:'other'};f.raw.profiles.push({digest:ownedDigest(body),body});}],
 ['unknown field',(f:any)=>{f.profile.extra=true;f.raw.profiles[0].digest=ownedDigest(f.profile);}],
 ['missing child',(f:any)=>f.raw.pins.pop()],
 ['wrong child kind',(f:any)=>{f.profile.loaderProfileDigest=f.profile.executorProfileDigest;f.raw.profiles[0].digest=ownedDigest(f.profile);}],
 ['unknown schema',(f:any)=>{f.profile.schema='proof-v2';f.raw.profiles[0].digest=ownedDigest(f.profile);}],
 ['unknown recipe registry',(f:any)=>{f.profile.recipeRegistryId='unknown';f.raw.profiles[0].digest=ownedDigest(f.profile);}],
 ['duplicate recipe ID',(f:any)=>f.raw.recipeRegistries[0].recipes.push(f.raw.recipeRegistries[0].recipes[0])],
 ['missing dependency',(f:any)=>{const pin=f.raw.pins[0];pin.body.dependencies=[ownedSha256('missing')];pin.digest=ownedDigest(pin.body);}],
 ['self reference',(f:any)=>{const pin=f.raw.pins[0];pin.body.dependencies=[pin.digest];}],
 ['budget escalation',(f:any)=>{f.profile.budgets.refs++;f.raw.profiles[0].digest=ownedDigest(f.profile);}],
 ['test profile',(f:any)=>{f.profile.purpose='test-only';f.raw.profiles[0].digest=ownedDigest(f.profile);}],
] as const)it('invalidates independently supplied registry: '+label,()=>{const f=fixture();change(f);const r=createOwnedRegistry(f.raw);expect(r.invalid).toBe(true);expect(r.check(f.claim,parseOwnedSettings(trust,f.claim.profileDigest))).toBe('configuration_invalid');});
it('does not retain mutable caller data',()=>{const {raw,claim}=fixture();const r=createOwnedRegistry(raw);raw.profiles[0]!.body.authorityId='changed';raw.pins.length=0;expect(r.check(claim,parseOwnedSettings(trust,claim.profileDigest))).toBe('witness_unavailable');});
it('preserves occurrence order and duplicates in canonical profile digests',()=>{const {profile}=fixture();expect(ownedProfileSchema.parse(profile).runtimePolicy.occurrences).toEqual(['api','api']);const digest=ownedDigest(profile);profile.runtimePolicy.occurrences.pop();expect(ownedDigest(profile)).not.toBe(digest);});
for(const [change,reason] of [
 [(c:any)=>c.profileId='other','profile_mismatch'],
 [(c:any)=>c.recipeDigest=ownedSha256('other'),'profile_mismatch'],
 [(c:any)=>c.recipeId='other','recipe_unapproved'],
 [(c:any)=>c.profileDigest=ownedSha256('other'),'profile_unapproved'],
] as const)it('classifies claim '+reason,()=>{const {raw,claim}=fixture();const settings=parseOwnedSettings(trust,claim.profileDigest);change(claim);expect(createOwnedRegistry(raw).check(claim,settings)).toBe(reason);});
it('a known ID with an unapproved digest stays unapproved',()=>{const {raw,claim}=fixture();expect(createOwnedRegistry(raw).check(claim,parseOwnedSettings(trust))).toBe('profile_unapproved');});
for(const kind of ['disabled','invalid','unapproved','approved'] as const)it('G0 precedes '+kind+' and no owned files are read',()=>{
 const {policy,claim}=policyFixture();if(kind==='disabled')policy.settings=parseOwnedSettings();if(kind==='invalid')policy.settings=parseOwnedSettings('bad');if(kind==='unapproved')policy.settings=parseOwnedSettings(trust);
 const doc=rewriteOwned(ownedFixture(),()=>true,v=>{if(v.profileDigest)v.profileDigest=claim.profileDigest;if(v.recipeDigest)v.recipeDigest=claim.recipeDigest;});
 const good=inspect(doc,policy);expect(good.owned).toMatchObject({manifestStructure:'verified',diagnosticEligible:false,ownedFileReads:0,currentContentMatch:'not_checked'});expect(good.owned?.reasons).toEqual(['owned_manifest_'+({disabled:'trust_disabled',invalid:'configuration_invalid',unapproved:'profile_unapproved',approved:'witness_unavailable'}[kind])]);
 doc.ownedOfferObjects[0].bytes+=' ';const bad=inspect(doc,policy);expect(bad.owned).toMatchObject({manifestStructure:'invalid',importStatus:'invalid',ownedFileReads:0});expect(bad.owned?.reasons).toEqual(['owned_manifest_content_mismatch']);expect(bad.graph).toEqual(good.graph);
});
it('known pinned mismatch invalidates only owned admission after G0',()=>{const {policy,claim}=policyFixture();const doc=rewriteOwned(ownedFixture(),()=>true,v=>{if(v.profileDigest)v.profileDigest=claim.profileDigest;});const result=inspect(doc,policy);expect(result.owned).toMatchObject({manifestStructure:'verified',importStatus:'invalid',reasons:['owned_manifest_profile_mismatch'],ownedFileReads:0});expect(result.graph.contexts[0]?.id).toBe('runtime');});

for(const field of ['tuple','schemas','recipes','executorProfileDigest','jdkImageProfileDigest','nodeImageProfileDigest','platformProfileDigest','loaderProfileDigest','runtimePolicy','executionPolicy','sourcePolicy','packagePolicy','storagePolicy','budgets','authorityId','observationProfileDigest','requiredLimitations','reviewAssertions'])it('requires profile contract field '+field,()=>{const f=fixture();delete f.profile[field];f.raw.profiles[0]!.digest=ownedDigest(f.profile);expect(createOwnedRegistry(f.raw).invalid).toBe(true);});
it('rejects duplicate child IDs even with independently correct hashes',()=>{const f=fixture();const body={...f.raw.pins[0]!.body,specificationDigest:ownedSha256('different')};f.raw.pins.push({digest:ownedDigest(body),body});expect(createOwnedRegistry(f.raw).invalid).toBe(true);});
it('requires the reviewed recipe to support each assigned stage',()=>{const f=fixture();const pin=f.raw.pins.find(x=>x.body.kind==='recipe')!;pin.body.recipeRoles=['prepare'];pin.digest=ownedDigest(pin.body);for(const k of Object.keys(f.profile.recipes))f.profile.recipes[k]=pin.digest;f.raw.recipeRegistries[0]!.recipes[0]!.digest=pin.digest;f.raw.profiles[0]!.digest=ownedDigest(f.profile);expect(createOwnedRegistry(f.raw).invalid).toBe(true);});
it('accepts a closed child DAG and rejects a missing transitive dependency',()=>{const f=fixture(),leaf={schema:'osv-mcp.gradle-owned-profile-pin-v1',id:'leaf',kind:'platform',specificationDigest:ownedSha256('leaf'),dependencies:[]};const ref={digest:ownedDigest(leaf),body:leaf};f.raw.pins.push(ref);const parent=f.raw.pins[0]!;parent.body.dependencies=[ref.digest] as never[];parent.digest=ownedDigest(parent.body);f.profile.executorProfileDigest=parent.digest;f.raw.profiles[0]!.digest=ownedDigest(f.profile);expect(createOwnedRegistry(f.raw).invalid).toBe(false);f.raw.pins.pop();expect(createOwnedRegistry(f.raw).invalid).toBe(true);});

for(const [field,value] of [['environment','JAVA_TOOL_OPTIONS'],['environment','NODE_OPTIONS'],['properties','java.system.class.loader'],['arguments','-javaagent:unregistered.jar']] as const)it('rejects initial-policy injection '+value,()=>{const f=fixture();f.profile.sourcePolicy[field]=[value];f.raw.profiles[0]!.digest=ownedDigest(f.profile);expect(createOwnedRegistry(f.raw).invalid).toBe(true);});
it('checks every invocation and does not let a valid first claim hide a mismatching second claim',()=>{const {policy,claim}=policyFixture();const doc=rewriteOwned(ownedFixture(),()=>true,v=>{if(v.profileDigest)v.profileDigest=claim.profileDigest;if(v.recipeDigest)v.recipeDigest=claim.recipeDigest;});
 const other=rewriteOwned(structuredClone(doc),()=>true,v=>{if(v.binding)v.binding.invocation='second';if('invocation'in v)v.invocation='second';if(v.recipeDigest)v.recipeDigest=ownedSha256('wrong');});
 other.ownedOfferBundles[0].invocation='second';doc.ownedOfferBundles.push(...other.ownedOfferBundles);for(const carrier of other.ownedOfferObjects)if(!doc.ownedOfferObjects.some((x:any)=>x.objectDigest===carrier.objectDigest))doc.ownedOfferObjects.push(carrier);
 expect(inspect(doc,policy).owned).toMatchObject({manifestStructure:'verified',importStatus:'invalid',reasons:['owned_manifest_profile_mismatch'],ownedFileReads:0});
});
