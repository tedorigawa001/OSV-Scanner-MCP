/** Common diagnostic progress after the original acceptClient promise succeeds.
 * Preserve an independent transport-reply copy for offline part verification.
 * No extra signature verification, decode, hash or source IO runs here. */
import {types} from 'node:util';
import {Vf3Link} from './gradleOwnedCwcVf3Link.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
const byteLength=Buffer.byteLength.bind(Buffer);
const toString=Buffer.prototype.toString;
const own=(v:object,k:string)=>{need(v&&typeof v==='object'&&!types.isProxy(v),'progress_invalid');const d=Object.getOwnPropertyDescriptor(v,k);need(d&&'value'in d,'progress_invalid');return d.value;};
let installed=false;
export class Vf3pProgress {
 readonly #records:any[]=[];readonly #restore:()=>void;#pending=new WeakMap<object,string>();#closed=false;
 constructor(){need(!installed,'operation_busy');installed=true;const self=this,d=Object.getOwnPropertyDescriptor(Vf3Link.prototype,'acceptClient')!,reply=Object.getOwnPropertyDescriptor(Vf3Link.prototype,'reply')!;
  this.#restore=()=>{Object.defineProperty(Vf3Link.prototype,'acceptClient',d);Object.defineProperty(Vf3Link.prototype,'reply',reply);};
  try{
   Object.defineProperty(Vf3Link.prototype,'reply',{...reply,value:async function(this:object,...args:any[]){
    self.#pending.delete(this);const inner=args[1]?.inner;let wire:string|undefined;
    if(inner!==undefined){need(Buffer.isBuffer(inner)&&inner.length>0&&inner.length<=8192,'progress_invalid');wire=Reflect.apply(toString,inner,['base64']);}
    const result=await Reflect.apply(reply.value,this,args);
    if(wire!==undefined){need(!self.#closed,'owner_closed');self.#pending.set(this,wire);}return result;
   }});
   Object.defineProperty(Vf3Link.prototype,'acceptClient',{...d,value:function(this:object,...args:any[]){const result=Reflect.apply(d.value,this,args) as Promise<unknown>;return result.then((value:unknown)=>{self.#accept(this,args[1]);return value;});}});
  }catch(error){this.#restore();installed=false;throw error;}
 }
 #accept(link:object,body:object){need(!this.#closed&&this.#records.length<128,'capacity_exhausted');const verifiedReply=this.#pending.get(link);need(verifiedReply!==undefined,'progress_invalid');this.#pending.delete(link);const api=own(body,'api'),requestDigest=own(body,'requestDigest'),parts:any[]=[];
  const part=(p:object,range:boolean)=>{const entry=own(p,'entry'),bytes=own(p,'bytes');need(typeof bytes==='string','progress_invalid');return {kind:range?own(p,'kind'):own(entry,'kind'),index:range?own(p,'index'):own(entry,'index'),offset:own(p,'offset'),length:byteLength(bytes,'base64'),entryBytes:own(entry,'byteLength'),entrySha256:own(entry,'sha256')};};
  if(api==='ReadSourceRanges'){const values=own(body,'parts');need(Array.isArray(values)&&!types.isProxy(values)&&values.length<=4,'progress_invalid');for(let i=0;i<values.length;i++)parts.push(part(own(values,String(i)),true));}
  else if(api==='ReadSealedSource')parts.push(part(own(body,'result'),false));
  else need(api==='ReadSourceDescriptor','progress_invalid');
  this.#records.push({order:this.#records.length+1,api,requestDigest,parts,verifiedReply});
 }
 snapshot(reconstructed:boolean){return {schema:'cwc-vf3p.progress.v2',point:'after-original-client-accept',records:structuredClone(this.#records),reconstructed};}
 close(){if(this.#closed)return;this.#closed=true;this.#restore();this.#pending=new WeakMap();this.#records.length=0;installed=false;}
}
