import { afterEach,beforeEach,expect,it } from "vitest";
import { cp,mkdir,mkdtemp,rm,writeFile,readFile,readdir,unlink,symlink,truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveDirectorySnapshot,verifyDirectorySnapshot,captureLoadTree,treeDigest,loadBudget,compareDirectoryOrigin } from "../../utils/gradlePluginSnapshots.js";
let root:string;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),"osv-plugin-snapshot-"));await mkdir(path.join(root,"producer/日本語 space/empty"),{recursive:true});await writeFile(path.join(root,"producer/日本語 space/A.class"),"abc");});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it("publishes a directory container and independently revalidates its full tree and blobs",async()=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation");
 const verified=await verifyDirectorySnapshot(root,ref);
 expect(verified.entries).toEqual(expect.arrayContaining([{kind:"directory",path:"日本語 space/empty"},{kind:"file",path:"日本語 space/A.class",size:3,sha256:"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]));
 expect(verified.treeDigest).toBe(ref.treeDigest);
});

it("uses the specified binary digest independently of JSON serialization",()=>{
 const entries:any[]=[{kind:"directory",path:"a"},{kind:"file",path:"a/x",size:3,sha256:"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},{kind:"directory",path:"empty"}];
 expect(treeDigest(entries)).toBe("ebad6a05cc055df0c051bd0b7873a14c6f9398146d2396aff7a17c1eecc1f426");
 expect(treeDigest(JSON.parse(JSON.stringify(entries,null,2)))).toBe(treeDigest(entries));
});
it("shares content blobs without dropping duplicate logical files or empty directories",async()=>{
 await writeFile(path.join(root,"producer/copy.class"),"abc");await writeFile(path.join(root,"producer/zero"),"");
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation");const m=await verifyDirectorySnapshot(root,ref);
 expect(m.entries.filter(e=>e.kind==="file")).toHaveLength(3);
 expect(await readdir(path.join(root,path.dirname(ref.manifestPath),"blobs"))).toHaveLength(2);
 const second=await saveDirectorySnapshot(root,"producer","proof-invocation");expect(second).toEqual(ref);
});
it.each([["changed","snapshot_blob_mismatch"],["deleted","snapshot_storage_mismatch"],["extra","snapshot_storage_mismatch"]])("rejects a container with a blob %s",async (mutation,reason)=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation"),base=path.join(root,path.dirname(ref.manifestPath),"blobs"),file=path.join(base,(await readdir(base))[0]!);
 if(mutation==="changed")await writeFile(file,"tampered");
 if(mutation==="deleted")await unlink(file);
 if(mutation==="extra")await writeFile(path.join(base,"0".repeat(64)),"extra");
 await expect(verifyDirectorySnapshot(root,ref)).rejects.toThrow(reason);
});
it.each([["digest","snapshot_digest_mismatch"],["duplicate","duplicate_snapshot_path"],["ancestor","snapshot_ancestor_missing"],["order","snapshot_entry_order"],["unknown","unrecognized_keys"]])("rejects an invalid manifest: %s",async (mutation,reason)=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation"),file=path.join(root,ref.manifestPath),m=JSON.parse(await readFile(file,"utf8"));
 if(mutation==="digest")m.treeDigest="0".repeat(64);
 if(mutation==="duplicate")m.entries.push(m.entries[0]);
 if(mutation==="ancestor")m.entries.shift();
 // Swap siblings so ancestors stay present and only the order check can fail.
 if(mutation==="order"){const i=m.entries.findIndex((e:any)=>e.path==="日本語 space/A.class");[m.entries[i],m.entries[i+1]]=[m.entries[i+1],m.entries[i]];}
 if(mutation==="unknown")m.extra=true;
 await writeFile(file,JSON.stringify(m));await expect(verifyDirectorySnapshot(root,ref)).rejects.toThrow(reason);
});
it("rejects a self-consistent manifest whose declared size disagrees with its blob",async()=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation"),m=JSON.parse(await readFile(path.join(root,ref.manifestPath),"utf8"));
 m.entries.find((e:any)=>e.kind==="file").size++;m.treeDigest=treeDigest(m.entries);
 const parent=path.dirname(path.dirname(ref.manifestPath)),target=path.join(root,parent,m.treeDigest);
 await cp(path.join(root,path.dirname(ref.manifestPath)),target,{recursive:true});await writeFile(path.join(target,"manifest.json"),JSON.stringify(m));
 await expect(verifyDirectorySnapshot(root,{...ref,treeDigest:m.treeDigest,manifestPath:`${parent}/${m.treeDigest}/manifest.json`})).rejects.toThrow("snapshot_blob_mismatch");
});
it("rejects duplicate JSON keys and a forged snapshot reference",async()=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation");
 await expect(verifyDirectorySnapshot(root,{...ref,manifestPath:"producer/manifest.json"})).rejects.toThrow("snapshot_reference_mismatch");
 const file=path.join(root,ref.manifestPath),text=await readFile(file,"utf8");await writeFile(file,text.replace('{','{"kind":"directory",'));
 await expect(verifyDirectorySnapshot(root,ref)).rejects.toThrow();
});
it("does not replace an existing incomplete same-digest container",async()=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation");await unlink(path.join(root,ref.manifestPath));
 await expect(saveDirectorySnapshot(root,"producer","proof-invocation")).rejects.toThrow();
 expect(await readdir(path.join(root,path.dirname(path.dirname(ref.manifestPath))))).toEqual([ref.treeDigest]);
});
it("keeps an existing published container when a new capture exhausts its budget",async()=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation");await writeFile(path.join(root,"producer/new"),"new");
 await expect(saveDirectorySnapshot(root,"producer","proof-invocation",{bytes:0,entries:100})).rejects.toThrow();
 await expect(verifyDirectorySnapshot(root,ref)).resolves.toBeDefined();
 expect((await readdir(path.join(root,path.dirname(path.dirname(ref.manifestPath))))).every(n=>!n.startsWith("pending-"))).toBe(true);
});
it("rejects symlinks, path traversal, excess entries, and overlarge files",async()=>{
 await expect(captureLoadTree(root,"../escape")).rejects.toThrow();
 await expect(captureLoadTree(root,"producer",{bytes:100,entries:0})).rejects.toThrow();
 await symlink(path.join(root,"producer/日本語 space/A.class"),path.join(root,"producer/link"));await expect(captureLoadTree(root,"producer")).rejects.toThrow();await unlink(path.join(root,"producer/link"));
 await truncate(path.join(root,"producer/日本語 space/A.class"),4*1024**2+1);await expect(captureLoadTree(root,"producer")).rejects.toThrow();
});
it("detects a changed prepared directory instead of reopening the runtime source",async()=>{
 const ref=await saveDirectorySnapshot(root,"producer","proof-invocation"),verified=await verifyDirectorySnapshot(root,ref);
 await writeFile(path.join(root,"producer/extra"),"extra");
 expect(treeDigest(await captureLoadTree(root,"producer",loadBudget()))).not.toBe(verified.treeDigest);
});
it("reports a same-path directory origin separately and compares a distinct origin by content",async()=>{
 const same=await compareDirectoryOrigin(root,"producer",root,"producer","proof-invocation");
 expect(same.comparison).toBe("same-path-origin");
 await cp(path.join(root,"producer"),path.join(root,"runtime"),{recursive:true});
 expect((await compareDirectoryOrigin(root,"producer",root,"runtime","proof-invocation")).comparison).toBe("directory-content-exact");
 await writeFile(path.join(root,"runtime/日本語 space/A.class"),"changed");
 expect((await compareDirectoryOrigin(root,"producer",root,"runtime","proof-invocation")).comparison).toBe("unverifiable");
});
