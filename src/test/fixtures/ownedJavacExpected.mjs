import {sha256,objectDigest} from './ownedManifestContract.mjs';
export const javacRecipe=Object.freeze({id:'owned-javac-closed-v1',release:21,encoding:'UTF-8',processorPolicy:'none',implicitPolicy:'none',classpath:[],modulepath:[],sourcepath:[],generators:[],resources:[],environment:{LANG:'C',LC_ALL:'C',TZ:'UTC'},manifest:'Manifest-Version: 1.0\r\n\r\n',maxEntries:64,maxFileBytes:1048576,maxTotalBytes:4194304});
export const javacRecipeDigest=objectDigest(javacRecipe);
export function driverSource(removed=true,value='one') {return `import java.nio.file.*;\npublic class Driver {\n public static class Inner { static String value(){ return "${value}"; } }\n ${removed?'public static class Removed {}':''}\n public static void main(String[] args) throws Exception {\n  var uri=Paths.get(args[0]).toRealPath().toUri();\n  if(!Driver.class.getProtectionDomain().getCodeSource().getLocation().toURI().equals(uri) || !Inner.class.getProtectionDomain().getCodeSource().getLocation().toURI().equals(uri)) throw new IllegalStateException("origin");\n  System.out.println("owned-driver:"+Inner.value()+":inner");\n }\n}\n`;}
// Explicit, independent expectations. Refusals never derive their expected state from producer metadata.
export const buildCases=Object.freeze({
 'normal-inner':null,'rebuild-no-removed':null,
 'source-after-seal':['prepare','seal','input_changed'],
 'source-added-after-seal':['prepare','seal','input_changed'],
 'source-missing-after-seal':['prepare','seal','input_changed'],
 'source-post-compile':['build','verify-inputs','input_changed'],
 'unregistered-source':['prepare','capture','inventory_mismatch'],
 'processor-enabled':['prepare','policy','recipe_invalid'],
 'implicit-source-enabled':['prepare','policy','recipe_invalid'],
 'unregistered-argfile':['prepare','policy','recipe_invalid'],
 'unregistered-generator':['prepare','policy','recipe_invalid'],
 'existing-empty':['build','allocate-output','output_root_exists'],
 'existing-file':['build','allocate-output','output_root_exists'],
 'existing-symlink':['build','allocate-output','output_root_exists'],
 'ancestor-symlink':['build','allocate-output','output_root_invalid'],
 'input-alias':['build','allocate-output','output_root_invalid'],
 'inject-class':['build','verify-empty','output_root_not_empty'],
 'inject-resource':['build','verify-empty','output_root_not_empty'],
 'inject-hidden':['build','verify-empty','output_root_not_empty'],
 'inject-directory':['build','verify-empty','output_root_not_empty'],
 'inject-symlink':['build','verify-empty','output_root_not_empty'],
 'replace-root':['build','verify-empty','output_root_invalid'],
 'compiler-partial':['build','compiler','build_failed'],
 'retry-partial-root':['build','allocate-output','output_root_exists'],
 'retry-fresh':null,
 'implicit-source-blocked':['build','compiler','build_failed'],
 'extra-output':['build','collect-output','inventory_mismatch'],
 'missing-output':['build','collect-output','inventory_mismatch'],
 'jar-resource':['build','packaging','inventory_mismatch'],
 'jar-missing-manifest':['build','packaging','inventory_mismatch'],
 'jar-duplicate':['build','packaging','inventory_mismatch'],
 'jar-traversal':['build','packaging','path_invalid'],
 'jar-collision':['build','packaging','inventory_mismatch'],
 'jar-budget':['build','packaging','budget_exceeded'],
 'jar-provenance':['build','packaging','inventory_mismatch'],
 'packaging-save-failed':['build','packaging','storage_failed'],
 'artifact-changed':['build','runtime-precheck','input_changed'],
 'index-save-failed':['build','save','storage_failed'],
 'state-save-failed':['build','save','storage_failed']
});
export const javacSources=['src/test/fixtures/ownedJavacExpected.mjs','src/test/fixtures/ownedJavacContract.mjs','src/test/fixtures/ownedJavacProducer.mjs','src/test/fixtures/ownedManifestContract.mjs','src/test/fixtures/gradle-owned-javac.gradle','src/test/fixtures/gradleSnapshotOwnerExpected.mjs'];
export function expectedSources(name){if(name==='compiler-partial')return {'Good.java':'public class Good {}\n','Broken.java':'public class Broken { void x(){ missing(); } }\n'};const sources={'日本語 空白/Driver.java':name==='implicit-source-blocked'?'public class Driver { Hidden x; }\n':driverSource(name!=='rebuild-no-removed',name==='rebuild-no-removed'?'two':'one')};if(!['rebuild-no-removed','implicit-source-blocked'].includes(name))sources['Retired.java']='public class Retired { public static class Nested {} }\n';return sources;}
export function expectedSourceHashes(name){return Object.fromEntries(Object.entries(expectedSources(name)).map(([p,b])=>[p,sha256(b)]));}
