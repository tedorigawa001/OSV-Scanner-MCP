/** Sealed current-reader and decreasing-only admission capabilities. Neither raw cell is exported. */
import {binding,current,admission} from 'hb2:injected-reader';
const out=Object.create(null);
for(const key of ['owner','call','root','incarnation','mode','capacity'])Object.defineProperty(out,key,{value:binding[key],enumerable:true});
const read=()=>current();Object.setPrototypeOf(read,null);Object.freeze(read);
Object.defineProperty(out,'current',{value:read,enumerable:true});Object.defineProperty(out,'admission',{value:admission,enumerable:true});
export const port=Object.freeze(out);
