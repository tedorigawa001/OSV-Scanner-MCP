/** Loaded only by the controlled fixture linker. No issuer, writer, factory or raw cell export. */
import {binding,current} from 'hb1:injected-reader';
const portValue=Object.create(null);
for(const key of ['owner','call','root','incarnation','mode','capacity'])Object.defineProperty(portValue,key,{value:binding[key],enumerable:true});
const read=()=>current();Object.setPrototypeOf(read,null);Object.freeze(read);
Object.defineProperty(portValue,'current',{value:read,enumerable:true});
export const port=Object.freeze(portValue);
