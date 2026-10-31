/** Test-only revised plugin load/snapshot proof; never used by the MCP server. */
import { constants } from "node:fs";
import { lstat,open,opendir,realpath,mkdir,mkdtemp,rename,rm,writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseGradleJson } from "../../utils/gradleJson.js";
export const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
export interface LoadBudget {bytes:number;entries:number}
export const loadBudget=():LoadBudget=>({bytes:64*1024**2,entries:10000});
const hash=z.string().regex(/^[a-f0-9]{64}$/);
const invocation=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
function validPath(s:string){return !!s && Buffer.byteLength(s)<=4096 && !/[\\:\x00-\x1f\x7f\uD800-\uDFFF]/u.test(s) && !s.split("/").some(p=>!p||p==="."||p==="..") && s.split("/").length<=64;}
const relative=z.string().refine(validPath);
const fileEntry=z.object({kind:z.literal("file"),path:relative,size:z.number().int().safe().min(0).max(4*1024**2),sha256:hash}).strict();
const entrySchema=z.union([fileEntry,z.object({kind:z.literal("directory"),path:relative}).strict()]);
export type TreeEntry=z.infer<typeof entrySchema>;
const manifestSchema=z.object({snapshotVersion:z.literal(1),kind:z.literal("directory"),digestAlgorithm:z.literal("sha256-tree-v1"),treeDigest:hash,entries:z.array(entrySchema).max(10000)}).strict();
const refSchema=z.object({snapshotVersion:z.literal(1),kind:z.literal("directory"),invocationId:invocation,capturePhase:z.enum(["after-apply","post-compile","post-build"]),treeDigest:hash,manifestPath:relative}).strict();
export type DirectoryRef=z.infer<typeof refSchema>;
const ordered=(entries:TreeEntry[])=>[...entries].sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
export function treeDigest(entries:TreeEntry[]):string{
 const h=createHash("sha256");h.update("OSV-MCP-DIRECTORY-SNAPSHOT-V1\0");
 const n=Buffer.alloc(4);n.writeUInt32BE(entries.length);h.update(n);
 for(const entry of ordered(entries)){
  const name=Buffer.from(entry.path),length=Buffer.alloc(4);length.writeUInt32BE(name.length);
  h.update(Buffer.from([entry.kind==="directory"?0:1]));h.update(length);h.update(name);
  if(entry.kind==="file"){const size=Buffer.alloc(8);size.writeBigUInt64BE(BigInt(entry.size));h.update(size);h.update(Buffer.from(entry.sha256,"hex"));}
 }
 return h.digest("hex");
}
export async function safePath(root:string,relativePath:string,create=false):Promise<string>{
 if(!validPath(relativePath))throw new Error("unsafe_snapshot_path");
 let current=await realpath(root);const parts=relativePath.split("/");
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts[i]!);
  let info;try{info=await lstat(current);}catch(e){if(create&&(e as NodeJS.ErrnoException).code==="ENOENT"){await mkdir(current);info=await lstat(current);}else throw e;}
  if(info.isSymbolicLink() || (i<parts.length-1&&!info.isDirectory()))throw new Error("unsafe_snapshot_path");
 }
 return current;
}
export async function readProofFile(root:string,relativePath:string,budget=loadBudget()):Promise<Buffer>{
 const file=await safePath(root,relativePath),before=await lstat(file);
 if(!before.isFile() || before.size>4*1024**2 || before.size>budget.bytes)throw new Error("snapshot_byte_budget");
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const start=await handle.stat();if(start.ino!==before.ino||start.dev!==before.dev||start.size!==before.size)throw new Error("snapshot_changed");
  const chunks:Buffer[]=[];let count=0;
  while(count<start.size){const buffer=Buffer.alloc(Math.min(65536,start.size-count,budget.bytes));if(!buffer.length)throw new Error("snapshot_byte_budget");const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)throw new Error("snapshot_changed");count+=bytesRead;budget.bytes-=bytesRead;chunks.push(buffer.subarray(0,bytesRead));}
  const end=await handle.stat();if(end.size!==start.size||end.mtimeMs!==start.mtimeMs||end.ctimeMs!==start.ctimeMs)throw new Error("snapshot_changed");return Buffer.concat(chunks);
 }finally{await handle.close();}
}
export async function captureLoadTree(root:string,relativePath:string,budget=loadBudget(),onFile?:(entry:Extract<TreeEntry,{kind:"file"}>,bytes:Buffer)=>Promise<void>):Promise<TreeEntry[]>{
 const base=await safePath(root,relativePath);if(!(await lstat(base)).isDirectory())throw new Error("snapshot_not_directory");
 const entries:TreeEntry[]=[];
 async function walk(directory:string,logical:string,depth:number):Promise<void>{
  if(depth>64)throw new Error("snapshot_depth_budget");
  for await(const item of await opendir(directory)){
   if(--budget.entries<0)throw new Error("snapshot_entry_budget");
   const name=logical?logical+"/"+item.name:item.name;if(!validPath(name))throw new Error("unsafe_snapshot_path");
   const file=path.join(directory,item.name),info=await lstat(file);if(info.isSymbolicLink())throw new Error("unsafe_snapshot_path");
   if(info.isDirectory()){entries.push({kind:"directory",path:name});await walk(file,name,depth+1);}
   else if(info.isFile()){
    const bytes=await readProofFile(root,relativePath+"/"+name,budget),entry={kind:"file" as const,path:name,size:bytes.length,sha256:sha(bytes)};entries.push(entry);if(onFile)await onFile(entry,bytes);
   }else throw new Error("unsafe_snapshot_path");
  }
 }
 await walk(base,"",0);return ordered(entries);
}
function validateManifest(value:unknown){
 const m=manifestSchema.parse(value),seen=new Map<string,TreeEntry>();
 for(const e of m.entries){
  if(seen.has(e.path))throw new Error("duplicate_snapshot_path");
  const parts=e.path.split("/");for(let i=1;i<parts.length;i++)if(seen.get(parts.slice(0,i).join("/"))?.kind!=="directory")throw new Error("snapshot_ancestor_missing");
  seen.set(e.path,e);
 }
 if(JSON.stringify(m.entries.map(e=>e.path))!==JSON.stringify(ordered(m.entries).map(e=>e.path)))throw new Error("snapshot_entry_order");
 if(treeDigest(m.entries)!==m.treeDigest)throw new Error("snapshot_digest_mismatch");return m;
}
export async function verifyDirectorySnapshot(root:string,value:unknown,budget=loadBudget()){
 const ref=refSchema.parse(value),base=`.osv-mcp/plugin-runtime/${ref.invocationId}/directories/${ref.treeDigest}`;
 if(ref.manifestPath!==base+"/manifest.json")throw new Error("snapshot_reference_mismatch");
 const manifest=validateManifest(parseGradleJson(new TextDecoder("utf-8",{fatal:true}).decode(await readProofFile(root,ref.manifestPath,budget)),4*1024**2));
 if(manifest.treeDigest!==ref.treeDigest)throw new Error("snapshot_digest_mismatch");
 const actual=await captureLoadTree(root,base,budget),files=manifest.entries.filter((e):e is Extract<TreeEntry,{kind:"file"}>=>e.kind==="file");
 const unique=new Map<string,number>();for(const e of files){if(unique.has(e.sha256)&&unique.get(e.sha256)!==e.size)throw new Error("snapshot_blob_size");unique.set(e.sha256,e.size);}
 const expected=["blobs/","manifest.json",...[...unique.keys()].map(h=>"blobs/"+h)].sort();
 if(JSON.stringify(actual.map(e=>e.path+(e.kind==="directory"?"/":"")).sort())!==JSON.stringify(expected))throw new Error("snapshot_storage_mismatch");
 for(const [h,size]of unique){const e=actual.find(e=>e.kind==="file"&&e.path==="blobs/"+h) as Extract<TreeEntry,{kind:"file"}>;if(!e||e.size!==size||e.sha256!==h)throw new Error("snapshot_blob_mismatch");}
 return manifest;
}
export async function saveDirectorySnapshot(root:string,source:string,invocationId:string,budget=loadBudget(),phase:"after-apply"|"post-compile"|"post-build"="after-apply",sourceRoot=root):Promise<DirectoryRef>{
 invocation.parse(invocationId);const parent=`.osv-mcp/plugin-runtime/${invocationId}/directories`;
 const base=await safePath(root,parent,true),temp=await mkdtemp(path.join(base,"pending-"));
 await mkdir(path.join(temp,"blobs"));
 try{
  const blobs=new Set<string>();const entries=await captureLoadTree(sourceRoot,source,budget,async(e,bytes)=>{if(!blobs.has(e.sha256)){await writeFile(path.join(temp,"blobs",e.sha256),bytes,{flag:"wx",mode:0o600});blobs.add(e.sha256);}});
  const digest=treeDigest(entries),manifest={snapshotVersion:1,kind:"directory",digestAlgorithm:"sha256-tree-v1",treeDigest:digest,entries};
  validateManifest(manifest);
  const bytes=Buffer.from(JSON.stringify(manifest)+"\n");if(bytes.length>4*1024**2)throw new Error("snapshot_byte_budget");
  await writeFile(path.join(temp,"manifest.json"),bytes,{flag:"wx",mode:0o600});
  if(treeDigest(await captureLoadTree(sourceRoot,source,budget))!==digest)throw new Error("snapshot_source_changed");
  const ref:DirectoryRef={snapshotVersion:1,kind:"directory",invocationId,capturePhase:phase,treeDigest:digest,manifestPath:parent+"/"+digest+"/manifest.json"};
  // Validate the complete staging tree before atomically publishing it.
  const staged=await captureLoadTree(root,path.relative(await realpath(root),temp).split(path.sep).join("/"),budget);
  const expected=["blobs/","manifest.json",...[...blobs].map(h=>"blobs/"+h)].sort();
  if(JSON.stringify(staged.map(e=>e.path+(e.kind==="directory"?"/":"")).sort())!==JSON.stringify(expected))throw new Error("snapshot_storage_mismatch");
  for(const e of staged)if(e.kind==="file"&&e.path.startsWith("blobs/")&&e.sha256!==e.path.slice(6))throw new Error("snapshot_blob_mismatch");
  let exists=false;try{await lstat(path.join(base,digest));exists=true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  if(exists)await verifyDirectorySnapshot(root,ref,budget);else await rename(temp,path.join(base,digest));
  return ref;
 }finally{await rm(temp,{recursive:true,force:true});}
}
/** Compares a directory load origin with the prepared output; an identical path is reported separately, not as a content match. */
export async function compareDirectoryOrigin(root:string,builtPath:string,originRoot:string,originRelative:string,invocationId:string,budget=loadBudget()){
 const built=await safePath(root,builtPath),origin=await safePath(originRoot,originRelative);
 const ref=await saveDirectorySnapshot(root,originRelative,invocationId,budget,"post-build",originRoot),snapshot=await verifyDirectorySnapshot(root,ref,budget);
 if(built===origin)return {comparison:"same-path-origin" as const,ref,snapshot};
 const comparison=treeDigest(await captureLoadTree(root,builtPath,budget))===snapshot.treeDigest?"directory-content-exact" as const:"unverifiable" as const;
 return {comparison,ref,snapshot};
}
