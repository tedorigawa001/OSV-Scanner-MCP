/** Test-only structural checks for public-API observations; not a production reader. */
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export const proofDigest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface ProofPolicy { approvedProfiles: Set<string>; pluginTrust:boolean }
export function assessConventionProof(report:any,policy:ProofPolicy):{inputVerified:boolean;originsVerified:boolean;declaredIn:string[];reasons:string[]} {
 const reasons:string[]=[];
 const t=report.toolchain;
 if(!t || !policy.approvedProfiles.has(proofDigest(t.profile))) reasons.push("toolchain_profile_not_approved");
 if(t && (!t.unchanged || t.bytesRead>2*1024**3 || t.maxBuffer>1024**2 || t.profile.entries.length>2000 ||
   t.profile.entries.some((e:any)=>e.size>512*1024**2))) reasons.push("toolchain_verification_failed");
 const profiles=new Map<string,any>((t?.profile.entries??[]).map((e:any)=>[e.id,e]));
 for(const b of report.builds??[]) for(const c of b.receipts) for(const e of [...c.classpath,...(c.dependencyClasspath??[])]) {
  if(e.pluginOutputRoot && e.pluginOutputs && Object.keys(e.pluginOutputs).length){
   const outputs=Object.assign({},...(report.builds??[]).flatMap((b:any)=>b.receipts).map((c:any)=>c.outputs));
   const expected=Object.keys(e.pluginOutputs).sort();
   const current=e.currentPluginOutputs;
   if(!e.pluginDirectoryError && current && JSON.stringify(expected)===JSON.stringify(Object.keys(current).sort()) &&
      expected.every(p=>p.startsWith(e.pluginOutputRoot+"/") && outputs[p]===e.pluginOutputs[p] && current[p]===e.pluginOutputs[p])) continue;
   reasons.push("plugin_classpath_directory_mismatch");continue;
  }
  const entry=profiles.get(e.toolchainId);
  if(!entry || entry.sha256!==e.sha256 || entry.size!==e.size) reasons.push("toolchain_classpath_unverified");
 }
 if(report.inputs.changed.length) reasons.push("plugin_inputs_stale");
 const inputVerified=!reasons.length;
 const p=report.projects.registered;
 const apps=new Map<string,any>(p.applications.map((a:any)=>[a.id,a]));
 const seen=new Map<string,string[]>();
 const records=[...p.records,...(p.providerRecords??[])];
 const recordIds=new Set<string>();
 if(apps.size!==p.applications.length) reasons.push("plugin_record_coverage_incomplete");
 for(const r of records){
  if(typeof r.id!=="string" || !r.id || recordIds.has(r.id)) reasons.push("invalid_origin_record_id");
  else recordIds.add(r.id);
  const o=r.origin;
  if(o?.kind==="script") {
   if(Object.keys(o).some(k=>k!=="kind") || r.source===report.pluginSource) reasons.push("invalid_script_origin");
  } else if(o?.kind==="plugin") {
   const a=apps.get(o.pluginApplicationId);
   if(!a || !o.sourceMappingId || o.sourceMappingId!==a.source || r.source!==a.source) reasons.push("invalid_plugin_origin");
   else seen.set(a.id,[...(seen.get(a.id)??[]),r.id]);
  } else reasons.push("origin_unverified");
 }
 for(const a of p.applications){
  if(JSON.stringify([...(seen.get(a.id)??[])].sort())!==JSON.stringify([...a.expectedRecordIds].sort())) reasons.push("plugin_record_coverage_incomplete");
 }
 const originsVerified=!reasons.some(r=>r.includes("origin")||r==="plugin_record_coverage_incomplete");
 if(!p.sourceArtifactVerified) reasons.push("plugin_loaded_origin_unverifiable");
 if(report.requiresPlugin!==false && !policy.pluginTrust) reasons.push("plugin_trust_disabled");
 return {inputVerified,originsVerified,declaredIn:reasons.length?[]:[...new Set<string>(records.map((r:any)=>r.source))].sort(),reasons:[...new Set(reasons)]};
}

/** Bounded disk snapshot of a prepared plugin output directory, including its file set. */
export interface ProofDirectoryBudget { bytes:number; entries:number }
export async function captureConventionDirectory(root:string,relative:string,budget:ProofDirectoryBudget):Promise<Record<string,string>> {
 if(!relative || path.isAbsolute(relative) || /[\\:\x00-\x1f\x7f]/.test(relative) || relative.split("/").some(p=>!p||p==="."||p==="..")) throw new Error("unsafe_plugin_directory");
 const canonical=await realpath(root), result:Record<string,string>={};
 let parent=canonical;
 for(const component of relative.split("/")){
  parent=path.join(parent,component);const info=await lstat(parent);
  if(info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe_plugin_directory");
 }
 async function visit(directory:string):Promise<void>{
  const stream=await opendir(directory);
  for await(const entry of stream){
   if(--budget.entries<0)throw new Error("plugin_directory_entry_budget");
   const file=path.join(directory,entry.name), info=await lstat(file);
   if(info.isSymbolicLink())throw new Error("unsafe_plugin_directory");
   if(info.isDirectory()){await visit(file);continue;}
   if(!info.isFile())throw new Error("unsafe_plugin_directory");
   if(info.size>4*1024**2 || info.size>budget.bytes)throw new Error("plugin_directory_byte_budget");
   const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
   try {
    const before=await handle.stat();
    if(before.dev!==info.dev || before.ino!==info.ino || before.size!==info.size)throw new Error("plugin_directory_changed");
    const hash=createHash("sha256"),buffer=Buffer.alloc(64*1024);let total=0;
    while(total<before.size){
     const length=Math.min(buffer.length,before.size-total,budget.bytes);
     if(length<=0)throw new Error("plugin_directory_byte_budget");
     const {bytesRead}=await handle.read(buffer,0,length,null);
     if(!bytesRead)throw new Error("plugin_directory_changed");
     total+=bytesRead;budget.bytes-=bytesRead;hash.update(buffer.subarray(0,bytesRead));
    }
    const after=await handle.stat();
    if(after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs)throw new Error("plugin_directory_changed");
    result[path.relative(canonical,file).split(path.sep).join("/")]=hash.digest("hex");
   } finally {await handle.close();}
  }
 }
 await visit(parent);
 return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
