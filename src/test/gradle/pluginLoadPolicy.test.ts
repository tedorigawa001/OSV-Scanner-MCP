/** Synthetic policy classification; native observations are tested separately. */
import { expect,it } from "vitest";
import { assessPluginLoad,type LoadApproval } from "../fixtures/gradlePluginLoadPolicy.js";
const tool="a".repeat(64),loader="b".repeat(64);
const common=()=>({applicationId:"app",registrationForm:"binary-instance",toolchainProfileDigest:tool,inputsVerified:true,originsVerified:true,registrationUnique:true,constructedThisInvocation:true,instanceMatches:true,descriptorMatches:true,beginBeforeApplied:true,ended:true,endOutcome:"complete",observerFired:true,comparison:"raw-exact"});
const strict=()=>({...common(),loadPolicy:"prepared-output-only-v1",directLoadObserved:true,unverifiedTransform:false});
const attested=()=>({...common(),loadPolicy:"approved-gradle-loader-v1",loaderProfileDigest:loader,runtimeConfigMatches:true,snapshotVerified:true,runtimeAttested:true});
const policy=():LoadApproval=>({toolchains:new Set([tool]),loaders:new Set([loader]),helper:true,trust:"local-plugin-loader-attested-v2"});
it.each(["local-plugin-build-v1","local-plugin-loader-attested-v2"] as const)("permits valid strict binary evidence with no loader profile (trust=%s)",trust=>{
 const p={...policy(),loaders:new Set<string>(),trust};expect(assessPluginLoad(strict(),p).declarationsComplete).toBe(true);
});
it("requires the extra registration trust for strict precompiled while preserving graph inputs",()=>{
 const e={...strict(),registrationForm:"precompiled-pending"};
 const old=assessPluginLoad(e,{...policy(),trust:"local-plugin-build-v1",loaders:new Set()});expect(old.inputVerified).toBe(true);expect(old.declarationsComplete).toBe(false);
 expect(assessPluginLoad(e,{...policy(),loaders:new Set()}).declarationsComplete).toBe(true);
});
it.each(["disabled","local-plugin-build-v1"] as const)("does not adopt loader-attested evidence under trust=%s",trust=>{
 const r=assessPluginLoad(attested(),{...policy(),trust});expect(r.inputVerified).toBe(true);expect(r.declarationsComplete).toBe(false);
});
it.each(["toolchain","loader","runtime","snapshot","contents","lineage","descriptor","instance"])("rejects missing or inconsistent load evidence: %s",kind=>{
 const e:any=attested(),p=policy();
 if(kind==="toolchain")p.toolchains.clear();if(kind==="loader")p.loaders.clear();if(kind==="runtime")e.runtimeConfigMatches=false;if(kind==="snapshot")e.snapshotVerified=false;if(kind==="contents")e.comparison="unverifiable";if(kind==="lineage")e.constructedThisInvocation=false;if(kind==="descriptor")e.descriptorMatches=false;if(kind==="instance")e.instanceMatches=false;
 expect(assessPluginLoad(e,p).inputVerified).toBe(false);
});
it.each(["late","unclosed","failed","origins","observer","duplicate"])("preserves valid graph inputs but rejects an incomplete registration: %s",kind=>{
 const e:any=attested();if(kind==="duplicate")e.registrationUnique=false;if(kind==="late")e.beginBeforeApplied=false;if(kind==="unclosed")e.ended=false;if(kind==="failed")e.endOutcome="failed";if(kind==="origins")e.originsVerified=false;if(kind==="observer")e.observerFired=false;
 const r=assessPluginLoad(e,policy());expect(r.inputVerified).toBe(true);expect(r.declarationsComplete).toBe(false);
});
it("forbids policy-field mixing and missing/unknown policy instead of falling back",()=>{
 for(const e of [{...strict(),loaderProfileDigest:loader},{...strict(),runtimeSnapshotRef:null},{...attested(),directLoadObserved:true},{...strict(),loadPolicy:"unknown"}])expect(assessPluginLoad(e,policy()).inputVerified).toBe(false);
 const e:any=strict();delete e.loadPolicy;expect(assessPluginLoad(e,policy()).inputVerified).toBe(false);
});
it("does not elevate strict evidence with unverified transforms merely because a loader is approved",()=>{
 expect(assessPluginLoad({...strict(),unverifiedTransform:true},policy()).inputVerified).toBe(false);
});
it("keeps strict independent of a loader rejection in a mixed-policy set",()=>{
 const p={...policy(),loaders:new Set<string>()};expect(assessPluginLoad(strict(),p).declarationsComplete).toBe(true);expect(assessPluginLoad(attested(),p).inputVerified).toBe(false);
});
