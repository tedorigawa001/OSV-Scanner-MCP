import {readFileSync} from 'node:fs';import {it,expect} from 'vitest';
const read=(s:string)=>readFileSync('src/test/fixtures/'+s+'.ts','utf8');
for(const suffix of ['Session','Codec','Signer','Protocol','Owners'])it('keeps the '+suffix+' fork limited to v3 and explicit descriptor delegation',()=>{
 let expected=read('gradleOwnedCgpI2'+suffix);
 for(const kind of ['Signer','Codec','Owners','Protocol'])expected=expected.replaceAll('gradleOwnedCgpI2'+kind,'gradleOwnedCprB'+kind);
 if(suffix==='Signer')expected="import {command as cprCommand,cprResultSchema} from './gradleOwnedCprASchema.js';\n"+expected.replace('i0Command(body.command);','cprCommand(body.command);').replace('parsed(i2ReplySchema,body)','parsed(cprResultSchema,body)');
 if(suffix==='Owners')expected=expected.replace("if(['aux.ReadSourceDescriptor','aux.CompleteAuthorityResult'","if(api==='aux.ReadSourceDescriptor')return ['reader','authority-broker'];\n if(['aux.CompleteAuthorityResult'");
 if(suffix==='Session')expected=applyVf2Patch(expected);
 expect(read('gradleOwnedCprB'+suffix)).toBe(expected);
});

// Permit the reviewed, opt-in VF-2 delta explicitly; every other byte remains
// compared to the earlier I2 fork. A broad regex must not hide legacy changes.
function applyVf2Patch(base:string){
 const patch=readFileSync('src/test/fixtures/gradleOwnedCwcVf2Session.patch','utf8'),lines=base.split('\n'),out:string[]=[];let cursor=0;
 const hunks=patch.split(/(?=^@@ )/m).filter(Boolean);expect(hunks.length).toBeGreaterThan(0);
 for(const h of hunks){const [header,...body]=h.trimEnd().split('\n'),m=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header!);expect(m).not.toBeNull();const start=Number(m![1])-1;expect(start).toBeGreaterThanOrEqual(cursor);out.push(...lines.slice(cursor,start));cursor=start;let old=0,added=0;
  for(const line of body){const kind=line[0],text=line.slice(1);expect([' ','-','+']).toContain(kind);if(kind!=='+' ){expect(lines[cursor++]).toBe(text);old++;}if(kind!=='-'){out.push(text);added++;}}
  expect(old).toBe(Number(m![2]??1));expect(added).toBe(Number(m![4]??1));
 }out.push(...lines.slice(cursor));return out.join('\n');
}
