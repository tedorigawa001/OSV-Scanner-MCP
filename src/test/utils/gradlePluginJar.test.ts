import { expect,it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { compareJars,jarContents } from "../../utils/gradlePluginJar.js";
function crc(bytes:Buffer){let c=0xffffffff;for(const n of bytes){c^=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function zip(entries:[string,string][],stamp=0,method=0,descriptor=false):Buffer{
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const [name,text]of entries){
  const raw=Buffer.from(name),body=Buffer.from(text),data=method===8?deflateRawSync(body):body,check=crc(body),flags=0x800|(descriptor?8:0);
  const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(flags,6);header.writeUInt16LE(method,8);header.writeUInt16LE(stamp,10);header.writeUInt32LE(descriptor?0:check,14);header.writeUInt32LE(descriptor?0:data.length,18);header.writeUInt32LE(descriptor?0:body.length,22);header.writeUInt16LE(raw.length,26);
  const cd=Buffer.alloc(46);cd.writeUInt32LE(0x02014b50);cd.writeUInt16LE(20,4);cd.writeUInt16LE(20,6);cd.writeUInt16LE(flags,8);cd.writeUInt16LE(method,10);cd.writeUInt16LE(stamp,12);cd.writeUInt32LE(check,16);cd.writeUInt32LE(data.length,20);cd.writeUInt32LE(body.length,24);cd.writeUInt16LE(raw.length,28);cd.writeUInt32LE(offset,42);
  const tail=descriptor?Buffer.alloc(16):Buffer.alloc(0);if(descriptor){tail.writeUInt32LE(0x08074b50);tail.writeUInt32LE(check,4);tail.writeUInt32LE(data.length,8);tail.writeUInt32LE(body.length,12);}
  local.push(header,raw,data,tail);central.push(cd,raw);offset+=header.length+raw.length+data.length+tail.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
const contents:[string,string][]=[["META-INF/MANIFEST.MF","Manifest-Version: 1.0\r\n\r\n"],["proof/A.class","class"],["META-INF/gradle-plugins/proof.properties","implementation-class=proof.A"],["META-INF/services/proof.Service","proof.A"],["data.properties","version=1"]];
it("matches raw bytes and parses ordinary public Java ZIP layouts",()=>{const bytes=zip(contents);expect(compareJars(bytes,bytes)).toBe("raw-exact");expect(jarContents(bytes)).toHaveLength(5);});
it("accepts only envelope differences across order, timestamp, compression and descriptors",()=>{expect(compareJars(zip(contents),zip([...contents].reverse(),1,8,true))).toBe("entry-content-exact");});
it.each(contents.map(([name])=>name))("does not accept changed content for %s",name=>{
 const changed=contents.map(([p,v])=>[p,p===name?v+"changed":v] as [string,string]);expect(compareJars(zip(contents),zip(changed))).toBe("unverifiable");
});
it.each(["../escape","/absolute","a\\b","a/../b"])("rejects unsafe entry name %s",name=>{expect(()=>jarContents(zip([[name,"x"]]))).toThrow();});
it("rejects duplicate names, unknown compression and encryption flags",()=>{
 expect(()=>jarContents(zip([["same","1"],["same","2"]]))).toThrow();
 for(const kind of ["method","flags"]){const bytes=zip([["a","abc"]]);const at=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));if(kind==="method")bytes.writeUInt16LE(99,at+10);else bytes.writeUInt16LE(1,at+8);expect(()=>jarContents(bytes)).toThrow();}
});
it("rejects damaged CRC, local/central disagreement, truncation, and declared oversized content",()=>{
 const source=zip([["a","abc"]]);const at=source.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
 for(const kind of ["crc","name","size","truncated"]){const bytes=Buffer.from(source);if(kind==="crc")bytes.writeUInt32LE(0,at+16);if(kind==="name")bytes[30]=98;if(kind==="size")bytes.writeUInt32LE(4*1024**2+1,at+24);expect(()=>jarContents(kind==="truncated"?bytes.subarray(0,-1):bytes)).toThrow();}
});
it("charges entry and decoded-byte budgets before allowing a comparison",()=>{
 const bytes=zip(contents,0,8);expect(()=>jarContents(bytes,{bytes:bytes.length-1,entries:100})).toThrow();expect(()=>jarContents(bytes,{bytes:1024**2,entries:0})).toThrow();
});

it.each(['prefix','gap'])('rejects unapproved bytes outside indexed ZIP records: %s',kind=>{
 const source=zip([['a','abc']]),end=source.length-22,offset=source.readUInt32LE(end+16),extra=Buffer.from('unapproved');
 const bytes=kind==='prefix'?Buffer.concat([extra,source]):Buffer.concat([source.subarray(0,offset),extra,source.subarray(offset)]);
 const newEnd=end+extra.length,newOffset=offset+extra.length;bytes.writeUInt32LE(newOffset,newEnd+16);
 if(kind==='prefix')bytes.writeUInt32LE(extra.length,newOffset+42);
 expect(()=>jarContents(bytes)).toThrow();
});
