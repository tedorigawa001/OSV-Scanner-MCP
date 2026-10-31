import {afterEach,expect,it,vi} from 'vitest';
import {parsePluginSettings,startupPluginSettings,resetPluginSettingsForTests,pluginApplicationSchema,pluginProfileDigest} from '../../utils/gradlePlugins.js';
afterEach(()=>{vi.unstubAllEnvs();resetPluginSettingsForTests();});
it('does not let an invalid loader allowlist disable independently valid strict trust',()=>{
 const r=parsePluginSettings({OSV_MCP_GRADLE_PLUGIN_TRUST:'local-plugin-build-v1',OSV_MCP_GRADLE_PLUGIN_TOOLCHAIN_PROFILES:'a'.repeat(64),OSV_MCP_GRADLE_PLUGIN_LOADER_PROFILES:'invalid'});
 expect(r.trust).toBe('local-plugin-build-v1');expect(r.toolchains.size).toBe(1);expect(r.loaders.size).toBe(0);expect(r.invalid).toBe(true);
});
it.each(['unknown',' local-plugin-build-v1','local-plugin-build-v1 '])('disables unknown or malformed trust: %s',value=>{
 const r=parsePluginSettings({OSV_MCP_GRADLE_PLUGIN_TRUST:value});expect(r.trust).toBeUndefined();expect(r.invalid).toBe(true);
});
it.each(['A'.repeat(64),'a'.repeat(64)+',','a'.repeat(64)+','+'a'.repeat(64),'https://example.org/profile'])('rejects an invalid profile allowlist: %s',value=>{
 const r=parsePluginSettings({OSV_MCP_GRADLE_PLUGIN_TOOLCHAIN_PROFILES:value});expect(r.toolchains.size).toBe(0);expect(r.invalid).toBe(true);
});
it('captures plugin settings once at startup',()=>{
 vi.stubEnv('OSV_MCP_GRADLE_PLUGIN_TRUST','local-plugin-build-v1');const first=startupPluginSettings();vi.stubEnv('OSV_MCP_GRADLE_PLUGIN_TRUST','local-plugin-loader-attested-v2');expect(startupPluginSettings()).toBe(first);expect(first.trust).toBe('local-plugin-build-v1');
});
it('canonicalizes object keys but keeps profile array order and values significant',()=>{
 expect(pluginProfileDigest({a:1,b:2})).toBe(pluginProfileDigest({b:2,a:1}));expect(pluginProfileDigest([1,2])).not.toBe(pluginProfileDigest([2,1]));
});
it('forbids attested evidence fields on strict policy',()=>{
 const a={id:'a',pluginSpecId:'s',ownerProjectId:'main::',invocationId:'i',producerBuildId:'buildSrc',registrationForm:'binary-instance',registrationUnique:true,beginBeforeApplied:true,ended:true,endOutcome:'complete',observerFired:true,instanceMatches:true,implementationClass:'P',descriptorImplementation:'P',loadObservationPhase:'export-task',builtArtifact:null,expectedRecordIds:[],loadPolicy:'prepared-output-only-v1',directLoadObserved:true,unverifiedTransform:false};
 expect(pluginApplicationSchema.safeParse(a).success).toBe(true);
 for(const extra of [{loaderProfileDigest:'a'.repeat(64)},{runtimeSnapshotRef:null},{runtimeAttestations:{}}])expect(pluginApplicationSchema.safeParse({...a,...extra}).success).toBe(false);
});
