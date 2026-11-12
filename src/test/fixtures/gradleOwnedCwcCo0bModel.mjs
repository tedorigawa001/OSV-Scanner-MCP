/** Independent recursion model for the pinned canonical source and ASCII fixture.
 * Quantities are disjoint counter types, not summed CPU time or production units.
 */
import {createHash} from 'node:crypto';
export const CO0B_WORK_KEYS=['keyArrays','keyEntries','mapArrays','mapItems','joins','joinInputUnits','joinOutputUnits','stringifies','stringifyUnits','charReads','hashUpdates','hashInputBytes'];
export function co0bPrimitiveModel(value,kind){
 const work=Object.fromEntries(CO0B_WORK_KEYS.map(k=>[k,0]));let scratch=null;
 const encode=v=>{
  if(v===null||typeof v==='boolean'||typeof v==='number')return String(v);
  if(typeof v==='string'){work.charReads+=v.length;work.stringifies++;const s=JSON.stringify(v);work.stringifyUnits+=s.length;return s;}
  const array=Array.isArray(v),keys=Object.keys(v);work.keyArrays+=array?2:1;work.keyEntries+=keys.length*(array?2:1);
  const parts=array?v.map(encode):keys.sort().map(k=>{work.stringifies++;const s=JSON.stringify(k);work.stringifyUnits+=s.length;return s+':'+encode(v[k]);});
  work.mapArrays++;work.mapItems+=parts.length;const partUnits=parts.reduce((n,s)=>n+s.length,0),joined=parts.join(',');
  work.joins++;work.joinInputUnits+=partUnits;work.joinOutputUnits+=joined.length;
  const candidate={parts:parts.length,partUnits,joinedUnits:joined.length,logicalUnits:partUnits+joined.length};if(!scratch||candidate.logicalUnits>scratch.logicalUnits)scratch=candidate;
  return (array?'[':'{')+joined+(array?']':'}');
 };
 const text=encode(value),inputBytes=Buffer.byteLength(text),preimageDigest=createHash('sha256').update(text).digest('hex');
 if(kind==='hash'){work.hashUpdates=1;work.hashInputBytes=inputBytes;}
 const out=kind==='hash'?preimageDigest:text;
 return {work,scratch,inputBytes,preimageDigest,outputUnits:out.length,outputBytes:Buffer.byteLength(out),digest:createHash('sha256').update(out).digest('hex')};
}
