/** Bounded ZIP content comparison for the test-only plugin-load proof. No extraction. */
import { inflateRawSync } from "node:zlib";
import { sha, type LoadBudget,loadBudget } from "./gradlePluginLoadProof.js";
export interface JarEntry {path:string;size:number;sha256:string}
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=(b:Buffer)=>{let crc=0xffffffff;for(const n of b)crc=crcTable[(crc^n)&255]!^(crc>>>8);return(crc^0xffffffff)>>>0;};
export function jarContents(bytes:Buffer,budget:LoadBudget=loadBudget()):JarEntry[]{
 if(bytes.length>4*1024**2||bytes.length>budget.bytes)throw new Error("jar_byte_budget");budget.bytes-=bytes.length;
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
 if(end<0)throw new Error("jar_end_missing");
 const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||count===65535||offset+size!==end)throw new Error("jar_layout");
 const names=new Set<string>(),entries:JarEntry[]=[],ranges:[number,number][]=[];let at=offset;
 const extras=(start:number,length:number)=>{let p=start;while(p<start+length){if(p+4>start+length)throw new Error("jar_extra");const id=bytes.readUInt16LE(p),n=bytes.readUInt16LE(p+2);if(![0x5455,0x000a,0xcafe].includes(id)||p+4+n>start+length)throw new Error("jar_extra");p+=4+n;}};
 for(let i=0;i<count;i++){
  if(--budget.entries<0||at+46>end||bytes.readUInt32LE(at)!==0x02014b50)throw new Error("jar_entry_budget_or_layout");
  const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),length=bytes.readUInt32LE(at+24),nameLength=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
  if(flags&~0x80e || ![0,8].includes(method)||length>4*1024**2||length>budget.bytes||at+46+nameLength+extra+comment>end||local+30>offset)throw new Error("jar_unsupported_or_budget");
  const raw=bytes.subarray(at+46,at+46+nameLength);if(!(flags&0x800)&&raw.some(n=>n>127))throw new Error("jar_encoding");
  const name=new TextDecoder("utf-8",{fatal:true}).decode(raw),directory=name.endsWith("/"),clean=directory?name.slice(0,-1):name;
  if(!clean||Buffer.byteLength(clean)>4096||/[\\:\x00-\x1f\x7f]/.test(clean)||clean.split("/").some(p=>!p||p==="."||p==="..")||names.has(clean))throw new Error("jar_path");names.add(clean);
  const mode=bytes.readUInt32LE(at+38)>>>16,type=mode&0xf000;if(type&&type!==(directory?0x4000:0x8000))throw new Error("jar_special_entry");
  extras(at+46+nameLength,extra);
  if(bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method)throw new Error("jar_local_header");
  const localName=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),data=local+30+localName+localExtra;
  if(data+compressed>offset||!bytes.subarray(local+30,local+30+localName).equals(raw))throw new Error("jar_local_name");extras(local+30+localName,localExtra);
  if(!(flags&8)&&(bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==length))throw new Error("jar_local_sizes");
  let finish=data+compressed;
  if(flags&8){if(finish+12>offset)throw new Error("jar_descriptor");if(bytes.readUInt32LE(finish)===0x08074b50)finish+=4;if(finish+12>offset||bytes.readUInt32LE(finish)!==crc||bytes.readUInt32LE(finish+4)!==compressed||bytes.readUInt32LE(finish+8)!==length)throw new Error("jar_descriptor");finish+=12;}
  ranges.push([local,finish]);
  const content=method===0?bytes.subarray(data,data+compressed):inflateRawSync(bytes.subarray(data,data+compressed),{maxOutputLength:Math.max(1,length)});
  if(content.length!==length||crc32(content)!==crc||(directory&&length))throw new Error("jar_content");budget.bytes-=content.length;
  if(!directory)entries.push({path:name,size:length,sha256:sha(content)});
  at+=46+nameLength+extra+comment;
 }
 if(at!==end)throw new Error("jar_central_size");
 ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i]![0]<ranges[i-1]![1])throw new Error("jar_overlap");
 return entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}
export function compareJars(a:Buffer,b:Buffer,budget=loadBudget()):"raw-exact"|"entry-content-exact"|"unverifiable"{
 const first=jarContents(a,budget),second=jarContents(b,budget);
 return JSON.stringify(first)!==JSON.stringify(second)?"unverifiable":a.equals(b)?"raw-exact":"entry-content-exact";
}
