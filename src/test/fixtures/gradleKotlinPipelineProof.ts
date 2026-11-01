/** Test-only contract specimens. This is neither a v4 parser nor production adoption. */
import path from "node:path";
export const manifestLiteral=Buffer.from("Manifest-Version: 1.0\r\n\r\n","utf8");
export function checkLiteralBinding(e:{recipe:string;stage:string;slot:string;temporaryRoot:string;path:string;publicInputs:string[];input:Buffer;entry:Buffer}):string[]{
 const reasons:string[]=[];
 if(e.recipe!=="gradle-jar-manifest-input-v1"||e.stage!==":jar"||e.slot!=="manifest"||e.path!==e.temporaryRoot+"/MANIFEST.MF"||e.path.split("/").some(p=>p===".."||p===".")||path.isAbsolute(e.path)||e.publicInputs.filter(p=>p===e.path).length!==1) reasons.push("kotlin_package_literal_binding_invalid");
 if(!e.input.equals(manifestLiteral))reasons.push("kotlin_package_literal_file_mismatch");
 if(!e.entry.equals(manifestLiteral))reasons.push("kotlin_package_entry_mismatch");
 return reasons;
}

import { createHash } from "node:crypto";
import { readFile,lstat } from "node:fs/promises";
export interface PipelineContent {size:number;sha256:string;chunks:{size:number;sha256:string}[]}
const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
/** Only persisted content is opened. Original external/cache/temp paths are never followed. */
export async function verifyPipelineContent(root:string,ref:PipelineContent,largeToolchain=false,budget={bytes:256*1024**2,refs:4096}):Promise<void>{
 if(!Number.isSafeInteger(ref.size)||ref.size<0||ref.size>(largeToolchain?64:4)*1024**2||ref.size>budget.bytes||ref.chunks.length>64)throw new Error("kotlin_pipeline_budget_exceeded");
 budget.bytes-=ref.size;
 const d=createHash("sha256");let size=0;
 for(let i=0;i<ref.chunks.length;i++){
  const c=ref.chunks[i]!;
  if(--budget.refs<0)throw new Error("kotlin_pipeline_budget_exceeded");
  if(!/^[a-f0-9]{64}$/.test(c.sha256)||!Number.isSafeInteger(c.size)||c.size<=0||c.size>1024**2||i<ref.chunks.length-1&&c.size!==1024**2)throw new Error("kotlin_pipeline_snapshot_storage_mismatch");
  try{
   const f=path.join(root,".proof/pipeline-blobs",c.sha256),s=await lstat(f);
   if(!s.isFile()||s.isSymbolicLink()||s.size!==c.size)throw new Error();
   const bytes=await readFile(f);
   if(bytes.length!==c.size||sha(bytes)!==c.sha256)throw new Error();
   d.update(bytes);size+=bytes.length;
  }catch{throw new Error("kotlin_pipeline_snapshot_storage_mismatch");}
 }
 if(size!==ref.size||d.digest("hex")!==ref.sha256)throw new Error("kotlin_pipeline_snapshot_storage_mismatch");
}
/** Focused assertion specimen; deliberately not a general manifest schema parser. */
export function mappingDecision(pipelineRaw:string,specRaws:string[],inputsVerified:boolean):{inputStatus:string;declarationsComplete:boolean;reason:string|null}{
 let asserted:boolean[];
 try{asserted=[pipelineRaw,...specRaws].map(raw=>{
  const {assertions:a}=JSON.parse(raw);
  if(!a||typeof a!=="object"||Array.isArray(a)||a.buildInputs!=="all-plugin-build-inputs-listed"||a.mutation!=="immutable-during-export"||Object.keys(a).some(k=>!["buildInputs","mutation","mapping"].includes(k))||a.mapping!==undefined&&!["not-asserted","source-artifact-mapping-reviewed"].includes(a.mapping))throw new Error();
  return a.mapping==="source-artifact-mapping-reviewed";
 });}catch{return {inputStatus:"invalid",declarationsComplete:false,reason:"kotlin_pipeline_schema_invalid"};}
 if(!inputsVerified)return {inputStatus:"invalid",declarationsComplete:false,reason:"kotlin_stage_lineage_mismatch"};
 const complete=asserted.every(Boolean);
 return {inputStatus:"verified",declarationsComplete:complete,reason:complete?null:"kotlin_source_mapping_assertion_missing"};
}
/** Every package file must have one independently observed producer; not just classes. */
export function assessPipelinePackage(report:any,producer:string):{complete:boolean;reasons:string[];inventory:any[]}{
 const tasks=report.builds.find((b:any)=>b.build===producer)?.receipts??[];
 const compile=tasks.find((t:any)=>t.task===":compileKotlin"),jar=tasks.find((t:any)=>t.task===":jar"),resources=tasks.find((t:any)=>t.task===":processResources"),descriptor=tasks.find((t:any)=>t.task===":pluginDescriptors");
 const origins=new Map<string,any[]>(),reasons:string[]=[];
 const add=(name:string,p:string,h:unknown,role:string)=>{origins.set(name,[...(origins.get(name)??[]),{path:p,sha256:h,role}]);};
 for(const [p,h]of Object.entries(compile?.outputs??{}))if(p.startsWith(producer+"/build/classes/kotlin/main/"))add(p.slice((producer+"/build/classes/kotlin/main/").length),p,h,"kotlin-compile");
 const copies=new Map<string,{source:string;sha256:unknown}[]>();
 const expectCopy=(name:string,source:string,h:unknown)=>copies.set(name,[...(copies.get(name)??[]),{source,sha256:h}]);
 const resourcePrefix=producer+"/src/main/resources/",descriptorPrefix=producer+"/build/pluginDescriptors/";
 for(const [p,h]of Object.entries(report.inputs.baseline))if(p.startsWith(resourcePrefix))expectCopy(p.slice(resourcePrefix.length),p,h);
 for(const [p,h]of Object.entries(descriptor?.outputs??{}))if(p.startsWith(descriptorPrefix))expectCopy("META-INF/gradle-plugins/"+p.slice(descriptorPrefix.length),p,h);
 for(const [name,candidates]of copies){
  const output=producer+"/build/resources/main/"+name,owner=candidates[0]!;
  if(candidates.length!==1||resources?.declaredInputs?.[owner.source]!==owner.sha256||!Object.hasOwn(resources?.outputs??{},output))reasons.push("kotlin_package_origin_incomplete");
  else if(resources.outputs[output]!==owner.sha256)reasons.push("kotlin_package_entry_mismatch");
  add(name,output,owner.sha256,"resources-copy");
 }
 for(const p of Object.keys(resources?.outputs??{}))if(p.startsWith(producer+"/build/resources/main/")&&!copies.has(p.slice((producer+"/build/resources/main/").length)))reasons.push("kotlin_package_origin_incomplete");
 const inventory=[];
 if(report.kotlinPackage.entries.filter((e:any)=>e.path==="META-INF/MANIFEST.MF").length!==1)reasons.push("kotlin_package_origin_incomplete");
 for(const e of report.kotlinPackage.entries){
  if(e.path==="META-INF/MANIFEST.MF"){
   if(e.sha256!==sha(manifestLiteral))reasons.push("kotlin_package_entry_mismatch");
   inventory.push({path:e.path,role:"profile-literal",literal:"gradle-default-manifest-v1"});continue;
  }
  const owners=origins.get(e.path)??[];
  if(owners.length!==1)reasons.push("kotlin_package_origin_incomplete");
  else if(owners[0].sha256!==e.sha256||jar?.declaredInputs[owners[0].path]!==e.sha256)reasons.push("kotlin_package_entry_mismatch");
  inventory.push({path:e.path,owners});origins.delete(e.path);
 }
 if(origins.size)reasons.push("kotlin_package_origin_incomplete");
 return {complete:reasons.length===0,reasons:[...new Set(reasons)],inventory};
}
