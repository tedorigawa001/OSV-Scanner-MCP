/** Lossless diagnostic-file encoding only. It changes no runtime allocation/charge. */
import {co0Canonical as canonical} from './gradleOwnedCwcCo0Validation.mjs';
export function packCo0b(e){
 const shapes=[],ids=new Map(),shape=v=>{const k=canonical(v);if(!ids.has(k)){ids.set(k,shapes.length);shapes.push(v);}return ids.get(k);};
 const rows=e.rows.map(row=>{const {primitives,...observed}=row.observed;
  const primitiveTuples=primitives.map(p=>[p.seq,p.phase,p.actor,p.ordinal,p.kind,shape({work:p.work,scratch:p.scratch}),
   shape({work:p.model.work,scratch:p.model.scratch,inputBytes:p.model.inputBytes,outputUnits:p.model.outputUnits,outputBytes:p.model.outputBytes}),
   p.outputUnits,p.outputBytes,p.digest,p.hashInputDigest,p.model.preimageDigest,p.model.digest]);
  return {...row,observed:{...observed,primitiveTuples}};
 });
 return {schema:'cwc-co0b.packed.v1',shapes,evidence:{...e,rows}};
}
export function unpackCo0b(packed){
 if(!packed||packed.schema!=='cwc-co0b.packed.v1'||Object.keys(packed).sort().join(',')!=='evidence,schema,shapes'||!Array.isArray(packed.shapes))throw Error('co0b_packed_schema');
 const rows=packed.evidence.rows.map(row=>{const {primitiveTuples,...observed}=row.observed;if(Object.hasOwn(observed,'primitives'))throw Error('co0b_packed_schema');
  const primitives=primitiveTuples.map(t=>{if(!Array.isArray(t)||t.length!==13||![t[5],t[6]].every(i=>Number.isSafeInteger(i)&&i>=0&&i<packed.shapes.length))throw Error('co0b_packed_tuple');
   const a=packed.shapes[t[5]],m=packed.shapes[t[6]];
   if(Object.keys(a).sort().join(',')!=='scratch,work'||Object.keys(m).sort().join(',')!=='inputBytes,outputBytes,outputUnits,scratch,work')throw Error('co0b_packed_shape');
   return {seq:t[0],phase:t[1],actor:t[2],ordinal:t[3],kind:t[4],work:{...a.work},scratch:a.scratch?{...a.scratch}:null,outputUnits:t[7],outputBytes:t[8],digest:t[9],hashInputDigest:t[10],
    model:{...m,work:{...m.work},scratch:m.scratch?{...m.scratch}:null,preimageDigest:t[11],digest:t[12]}};
  });return {...row,observed:{...observed,primitives}};
 });
 const evidence={...packed.evidence,rows};if(canonical(packCo0b(evidence))!==canonical(packed))throw Error('co0b_packed_noncanonical');return evidence;
}
