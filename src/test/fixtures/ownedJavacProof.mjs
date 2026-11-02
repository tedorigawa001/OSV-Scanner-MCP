import {readFileSync} from 'node:fs';
import {sha256,objectDigest} from './ownedManifestContract.mjs';
import {javacSources,buildCases,javacRecipeDigest} from './ownedJavacExpected.mjs';
import {verifyBuildCase,buildFail} from './ownedJavacContract.mjs';
import {ownerJdkProfile,ownerTupleArtifacts} from './gradleSnapshotOwnerExpected.mjs';
export const javacVerificationSources=['src/test/fixtures/ownedJavacProof.mjs','src/test/fixtures/ownedJavacContract.d.mts','src/test/fixtures/ownedJavacExpected.d.mts','src/test/fixtures/ownedJavacProof.d.mts','src/test/gradle/javacBuild.test.ts','src/test/gradle/javacBuild.integration.test.ts','src/test/manual/gradleOwnedJavacResults.mjs'];
export const fileFingerprints=files=>Object.fromEntries(files.map(p=>[p,sha256(readFileSync(p))]));
const equal=(a,b)=>{if(objectDigest(a)!==objectDigest(b))buildFail('claim_mismatch');};
export function verifyJavacTuple(t){
 if(!['8.11.1','9.2.1'].includes(t.gradleVersion)||!['Groovy','Kotlin'].includes(t.dsl))buildFail('profile_mismatch');
 equal(t.policy.executorHashes,t.report.executorHashes);equal(t.policy.nodeRuntime,t.report.nodeRuntime);
 if(t.policy.java!==ownerJdkProfile.java.sha256||t.policy.javac!==ownerJdkProfile.javac.sha256||t.gradle.gradleApiSha256!==ownerTupleArtifacts[t.gradleVersion].gradle)buildFail('profile_mismatch');
 equal(t.report.executableHashes,{java:t.policy.java,javac:t.policy.javac});
 const g=t.gradle;if(g.schema!=='osv-mcp.owned-javac-gradle-v1'||t.report.schema!=='osv-mcp.gradle-owned-javac-native-v1'||g.gradleVersion!==t.gradleVersion||g.executionId!==t.policy.executionId||t.report.executionId!==t.policy.executionId||g.javaSha256!==t.policy.java||g.javacSha256!==t.policy.javac||g.parallel!==false||g.maxWorkers!==1||g.actionEntered!==true)buildFail();
 equal(g.taskState,{executed:true,didWork:true,skipped:false,noSource:false,failed:false});
 equal(t.report.cases.map(c=>c.case),Object.keys(buildCases));
 const ext=t.dsl==='Kotlin'?'.gradle.kts':'.gradle';equal(t.fixtureHashes,{['settings'+ext]:sha256('rootProject.name="owned-javac-proof"\n'),['build'+ext]:sha256(t.dsl==='Kotlin'?'apply(from="recipe.gradle")\n':"apply from: 'recipe.gradle'\n"),'recipe.gradle':t.policy.executorHashes['src/test/fixtures/gradle-owned-javac.gradle']});
 const scope={cases:0,compilerInvocations:0,artifactExecutions:0,completedBuilds:0,refused:0,btaCalls:0,productionAdopted:0,naturalReceipts:0};
 for(const c of t.report.cases){const s=verifyBuildCase(c,t.policy);scope.cases++;scope.compilerInvocations+=s.builds;scope.artifactExecutions+=s.executions;scope.completedBuilds+=s.completed;scope.refused+=s.refused;
  if(c.sourceRemoval){const prior=t.report.cases.find(p=>p.case==='normal-inner').inputManifest.sourceInventory.files.find(f=>f.path===c.sourceRemoval.path);if(!prior||prior.sha256!==c.sourceRemoval.sha256)buildFail('claim_mismatch');}
  if(c.previousRootCheck){const prev=t.report.cases.find(p=>p.case===c.previousRootCheck.fromCase);if(!prev)buildFail();equal(c.previousRootCheck.before,prev.case==='compiler-partial'?prev.partialOutput:prev.outputSet.inventory);if(c.outputStart?.token===prev.outputStart.token)buildFail('claim_mismatch');}
 }
 return scope;
}
export function verifyJavacRecord(r,{currentSources=true}={}){
 if(r.schema!=='osv-mcp.owned-javac-construction-proof-v1'||r.recipeDigest!==javacRecipeDigest||r.cases.length!==4)buildFail();
 equal(r.cases.map(t=>t.gradleVersion+':'+t.dsl),['8.11.1:Groovy','8.11.1:Kotlin','9.2.1:Groovy','9.2.1:Kotlin']);
 if(new Set(r.cases.map(t=>t.policy.executionId)).size!==4)buildFail('binding_mismatch');
 if(currentSources){equal(r.sourcesSha256,fileFingerprints(javacSources));equal(r.verificationSourcesSha256,fileFingerprints(javacVerificationSources));}
 const scope={};for(const t of r.cases){equal(t.policy.executorHashes,r.sourcesSha256);for(const [k,v]of Object.entries(verifyJavacTuple(t)))scope[k]=(scope[k]??0)+v;}
 equal(r.scope,scope);return scope;
}
