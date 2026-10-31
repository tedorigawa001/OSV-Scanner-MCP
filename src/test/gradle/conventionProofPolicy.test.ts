/** Synthetic policy projections only; native feasibility is tested separately. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assessConventionProof,captureConventionDirectory,proofDigest } from "../fixtures/gradleConventionProof.js";
import { mkdir,mkdtemp,rm,symlink,truncate,unlink,writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function sample(){
 const entry={id:"distribution/gradle-api.jar",size:177*1024**2,sha256:"a".repeat(64)};
 const profile={schemaVersion:1,entries:[entry]};
 const report:any={requiresPlugin:true,pluginSource:"buildSrc/src/main/java/Convention.java",toolchain:{profile,unchanged:true,bytesRead:entry.size*3,maxBuffer:1024**2},inputs:{changed:[]},builds:[{receipts:[{classpath:[{toolchainId:entry.id,size:entry.size,sha256:entry.sha256}],dependencyClasspath:[],outputs:{}}]}],projects:{registered:{sourceArtifactVerified:true,applications:[{id:"a0",source:"buildSrc/src/main/java/Convention.java",expectedRecordIds:["r0"]}],records:[{id:"r0",source:"buildSrc/src/main/java/Convention.java",origin:{kind:"plugin",pluginApplicationId:"a0",sourceMappingId:"buildSrc/src/main/java/Convention.java"}},{id:"r1",source:"build.gradle",origin:{kind:"script"}}]}}};
 const policy={approvedProfiles:new Set([proofDigest(profile)]),pluginTrust:true};
 return {report,policy};
}
describe("Convention proof diagnostic policy (synthetic)",()=>{
 it("projects a complete mixed source list only when every independent gate permits it",()=>{
  const {report,policy}=sample();expect(assessConventionProof(report,policy).declaredIn).toEqual(["build.gradle","buildSrc/src/main/java/Convention.java"]);
  report.projects.registered.sourceArtifactVerified=false;expect(assessConventionProof(report,policy).declaredIn).toEqual([]);
 });
 it("does not return the script subset when plugin trust is disabled",()=>{
  const {report,policy}=sample();policy.pluginTrust=false;expect(assessConventionProof(report,policy).declaredIn).toEqual([]);
 });
 it("permits a proven script-only scope without plugin trust or a fake application",()=>{
  const {report,policy}=sample();report.requiresPlugin=false;report.projects.registered.applications=[];report.projects.registered.records.splice(0,1);policy.pluginTrust=false;
  expect(assessConventionProof(report,policy).declaredIn).toEqual(["build.gradle"]);
 });
 it.each([false,true])("checks stale source inputs regardless of plugin trust (%s)",pluginTrust=>{
  const {report,policy}=sample();policy.pluginTrust=pluginTrust;report.inputs.changed=[report.pluginSource];expect(assessConventionProof(report,policy).inputVerified).toBe(false);
 });
 it.each(["bytes","buffer","size","entries"])("rejects an approved profile exceeding the %s limit",kind=>{
  const {report,policy}=sample();
  if(kind==="bytes")report.toolchain.bytesRead=2*1024**3+1;
  if(kind==="buffer")report.toolchain.maxBuffer=1024**2+1;
  if(kind==="size")report.toolchain.profile.entries[0].size=512*1024**2+1;
  if(kind==="entries")report.toolchain.profile.entries=Array.from({length:2001},(_,i)=>({...report.toolchain.profile.entries[0],id:String(i)}));
  policy.approvedProfiles=new Set([proofDigest(report.toolchain.profile)]);
  expect(assessConventionProof(report,policy).reasons).toContain("toolchain_verification_failed");
 });
 it("does not accept a profile edit against the original operator allowlist",()=>{
  const {report,policy}=sample();report.toolchain.profile.entries[0].sha256="b".repeat(64);expect(assessConventionProof(report,policy).reasons).toContain("toolchain_profile_not_approved");
 });
 it("retains application coverage checks when the source is relabelled as a script",()=>{
  const {report,policy}=sample();report.projects.registered.records[0].origin={kind:"script"};
  expect(assessConventionProof(report,policy).reasons).toEqual(expect.arrayContaining(["invalid_script_origin","plugin_record_coverage_incomplete"]));
 });
 it("rejects a Provider with missing origin even when synchronous origins are valid",()=>{
  const {report,policy}=sample();
  report.projects.registered.providerRecords=[{id:"p0",configuration:"lazy",source:report.pluginSource,origin:{kind:"plugin",pluginApplicationId:"a0",sourceMappingId:report.pluginSource}}];
  report.projects.registered.providerRecords[0].origin=null;
  const result=assessConventionProof(report,policy);
  expect(result.originsVerified).toBe(false);expect(result.reasons).toContain("origin_unverified");
 });
 it("validates both materialized and pending Provider origins without requiring evaluation",()=>{
  const {report,policy}=sample();
  report.projects.registered.providerRecords=[...["lazy","unused"].map((configuration,i)=>({id:`p${i}`,configuration,callbacks:i===0?1:0,source:report.pluginSource,origin:{kind:"plugin",pluginApplicationId:"a0",sourceMappingId:report.pluginSource}}))];
  report.projects.registered.applications[0].expectedRecordIds.push("p0","p1");
  expect(assessConventionProof(report,policy).originsVerified).toBe(true);
 });
 it.each(["script","missing_origin","missing_id","null_app","mapping","removed","reverse","duplicate"])("rejects Provider provenance tampering: %s",mutation=>{
  const {report,policy}=sample(),p=report.projects.registered;
  p.providerRecords=[{id:"p0",source:report.pluginSource,origin:{kind:"plugin",pluginApplicationId:"a0",sourceMappingId:report.pluginSource}}];
  p.applications[0].expectedRecordIds.push("p0");
  expect(assessConventionProof(report,policy).originsVerified).toBe(true);
  if(mutation==="script"){p.providerRecords[0].origin={kind:"script"};p.providerRecords[0].source="build.gradle";}
  if(mutation==="missing_origin")delete p.providerRecords[0].origin;
  if(mutation==="missing_id")delete p.providerRecords[0].id;
  if(mutation==="null_app")p.providerRecords[0].origin.pluginApplicationId=null;
  if(mutation==="mapping")p.providerRecords[0].origin.sourceMappingId=null;
  if(mutation==="removed")p.providerRecords=[];
  if(mutation==="reverse")p.applications[0].expectedRecordIds=["r0"];
  if(mutation==="duplicate")p.providerRecords.push(structuredClone(p.providerRecords[0]));
  for(const pluginTrust of [false,true])expect(assessConventionProof(report,{...policy,pluginTrust}).originsVerified).toBe(false);
 });
 it("rejects extra files in the current classpath directory, not just changed known files",()=>{
  const {report,policy}=sample();
  const expected={"build/classes/Convention.class":"a".repeat(64)};
  report.builds[0].receipts[0].outputs=expected;
  report.builds[0].receipts[0].classpath.push({pluginOutputRoot:"build/classes",pluginOutputs:expected,currentPluginOutputs:{...expected,"build/classes/unrecorded.properties":"b".repeat(64)}});
  const result=assessConventionProof(report,policy);
  expect(result.inputVerified).toBe(false);expect(result.reasons).toContain("plugin_classpath_directory_mismatch");
 });
 it("rejects unclassified independent classpath inputs instead of trusting their labels",()=>{
  const {report,policy}=sample();report.builds[0].receipts[0].classpath.push({toolchainId:"arbitrary-plugin.jar",size:9000000,sha256:"a".repeat(64)});
  const result=assessConventionProof(report,policy);
  expect(result.inputVerified).toBe(false);expect(result.reasons).toContain("toolchain_classpath_unverified");
 });
});

describe("Convention classpath disk snapshot",()=>{
 let root:string;
 beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"osv-convention-directory-"));await mkdir(path.join(root,"build/classes"),{recursive:true});await writeFile(path.join(root,"build/classes/A.class"),"abc");});
 afterEach(async()=>{await rm(root,{recursive:true,force:true});});
 const budget=()=>({bytes:64*1024**2,entries:10000});
 it("verifies an unchanged directory against its independently recorded output set",async()=>{
  const expected=await captureConventionDirectory(root,"build/classes",budget());
  const {report,policy}=sample();report.builds[0].receipts[0].outputs=expected;
  report.builds[0].receipts[0].classpath.push({pluginOutputRoot:"build/classes",pluginOutputs:expected,currentPluginOutputs:await captureConventionDirectory(root,"build/classes",budget())});
  expect(assessConventionProof(report,policy).inputVerified).toBe(true);
 });
 it.each(["added","deleted","changed"])("rejects a directory with a file %s on disk",async mutation=>{
  const expected=await captureConventionDirectory(root,"build/classes",budget());
  if(mutation==="added")await writeFile(path.join(root,"build/classes/unrecorded.properties"),"extra");
  if(mutation==="deleted")await unlink(path.join(root,"build/classes/A.class"));
  if(mutation==="changed")await writeFile(path.join(root,"build/classes/A.class"),"changed");
  const {report,policy}=sample();report.builds[0].receipts[0].outputs=expected;
  report.builds[0].receipts[0].classpath.push({pluginOutputRoot:"build/classes",pluginOutputs:expected,currentPluginOutputs:await captureConventionDirectory(root,"build/classes",budget())});
  expect(assessConventionProof(report,policy).reasons).toContain("plugin_classpath_directory_mismatch");
 });
 it("does not fall back to recorded hashes when a current directory snapshot is missing",async()=>{
  const expected=await captureConventionDirectory(root,"build/classes",budget());
  const {report,policy}=sample();report.builds[0].receipts[0].outputs=expected;
  report.builds[0].receipts[0].classpath.push({pluginOutputRoot:"build/classes",pluginOutputs:expected,pluginDirectoryError:"unsafe_plugin_directory"});
  expect(assessConventionProof(report,policy).inputVerified).toBe(false);
 });
 it("rejects symlinks both within and at the root of a classpath directory",async()=>{
  await symlink(path.join(root,"build/classes"),path.join(root,"alias"));
  await expect(captureConventionDirectory(root,"alias",budget())).rejects.toThrow("unsafe_plugin_directory");
  await symlink(path.join(root,"build/classes/A.class"),path.join(root,"build/classes/link"));
  await expect(captureConventionDirectory(root,"build/classes",budget())).rejects.toThrow("unsafe_plugin_directory");
 });
 it("enforces a shared byte budget before reading a file",async()=>{
  const limit={bytes:2,entries:100};
  await expect(captureConventionDirectory(root,"build/classes",limit)).rejects.toThrow("plugin_directory_byte_budget");
  expect(limit.bytes).toBe(2);
 });
 it("counts directory entries and rejects overlarge files",async()=>{
  await expect(captureConventionDirectory(root,"build/classes",{bytes:1024,entries:0})).rejects.toThrow("plugin_directory_entry_budget");
  await truncate(path.join(root,"build/classes/A.class"),4*1024**2+1);
  await expect(captureConventionDirectory(root,"build/classes",budget())).rejects.toThrow("plugin_directory_byte_budget");
 });
 it("preserves Japanese and space-containing file names",async()=>{
  await mkdir(path.join(root,"build/classes/日本語 space"));
  await writeFile(path.join(root,"build/classes/日本語 space/config.properties"),"data");
  const files=await captureConventionDirectory(root,"build/classes",budget());
  expect(Object.keys(files)).toContain("build/classes/日本語 space/config.properties");
 });
});
