import {readFileSync} from 'node:fs';import {it,expect} from 'vitest';
const read=(s:string)=>readFileSync('src/test/fixtures/'+s+'.ts','utf8');
for(const suffix of ['Session','Codec','Signer','Protocol','Owners'])it('keeps the '+suffix+' fork limited to v3 and explicit descriptor delegation',()=>{
 let expected=read('gradleOwnedCgpI2'+suffix);
 for(const kind of ['Signer','Codec','Owners','Protocol'])expected=expected.replaceAll('gradleOwnedCgpI2'+kind,'gradleOwnedCprB'+kind);
 if(suffix==='Signer')expected="import {command as cprCommand,cprResultSchema} from './gradleOwnedCprASchema.js';\n"+expected.replace('i0Command(body.command);','cprCommand(body.command);').replace('parsed(i2ReplySchema,body)','parsed(cprResultSchema,body)');
 if(suffix==='Owners')expected=expected.replace("if(['aux.ReadSourceDescriptor','aux.CompleteAuthorityResult'","if(api==='aux.ReadSourceDescriptor')return ['reader','authority-broker'];\n if(['aux.CompleteAuthorityResult'");
 expect(read('gradleOwnedCprB'+suffix)).toBe(expected);
});
