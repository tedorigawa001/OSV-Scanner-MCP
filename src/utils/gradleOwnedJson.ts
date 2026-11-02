import {createHash} from 'node:crypto';
import {visit} from 'jsonc-parser';

export const OWNED_LIMITS=Object.freeze({metadataBytes:64*1024*1024,objectBytes:8*1024*1024,objects:1024,refs:16384,depth:32,nodes:1_000_000});
export class OwnedManifestError extends Error {
 constructor(reason:string){super('owned_manifest_'+reason);}
}
export function ownedFail(reason='schema_invalid'):never {throw new OwnedManifestError(reason);}
export const ownedSha256=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
function string(value:string):void {
 for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const low=value.charCodeAt(++i);if(!(low>=0xdc00&&low<=0xdfff))ownedFail();}else if(c>=0xdc00&&c<=0xdfff)ownedFail();}
}
function key(value:string):void {if(!/^[\x20-\x7e]+$/.test(value))ownedFail();}
export function canonicalOwnedJson(value:unknown,maxBytes:number=OWNED_LIMITS.objectBytes):string {
 let nodes=0;const active=new Set<object>();
 function encode(v:unknown,depth:number):string {
  if(++nodes>OWNED_LIMITS.nodes||depth>OWNED_LIMITS.depth)ownedFail('budget_exceeded');
  if(v===null||typeof v==='boolean')return String(v);
  if(typeof v==='number'){if(!Number.isSafeInteger(v)||v<0||Object.is(v,-0))ownedFail();return String(v);}
  if(typeof v==='string'){string(v);return JSON.stringify(v);}
  if(typeof v!=='object'||active.has(v))ownedFail();if(depth>=OWNED_LIMITS.depth)ownedFail('budget_exceeded');active.add(v);
  let out:string;
  if(Array.isArray(v)){if(Object.keys(v).some((k,i)=>k!==String(i))||Object.keys(v).length!==v.length)ownedFail();out='['+v.map(x=>encode(x,depth+1)).join(',')+']';}
  else {if(![Object.prototype,null].includes(Object.getPrototypeOf(v)))ownedFail();out='{'+Object.keys(v).sort().map(k=>{key(k);return JSON.stringify(k)+':'+encode((v as Record<string,unknown>)[k],depth+1);}).join(',')+'}';}
  active.delete(v);return out;
 }
 const out=encode(value,0);if(Buffer.byteLength(out)>maxBytes)ownedFail('budget_exceeded');return out;
}
export const ownedDigest=(value:unknown,maxBytes?:number)=>ownedSha256(canonicalOwnedJson(value,maxBytes));
export function parseOwnedJson(text:string,maxBytes:number=OWNED_LIMITS.objectBytes,sharedBudget?:{nodes:number}):unknown {
 if(Buffer.byteLength(text)>maxBytes)ownedFail('budget_exceeded');
 let nodes=0;const stack:(Set<string>|null)[]=[];
 const node=()=>{if(++nodes>OWNED_LIMITS.nodes||(sharedBudget&&--sharedBudget.nodes<0))ownedFail('budget_exceeded');};
 const enter=(object:boolean)=>{if(stack.length>=OWNED_LIMITS.depth)ownedFail('budget_exceeded');node();stack.push(object?new Set():null);};
 visit(text,{onObjectBegin:()=>enter(true),onArrayBegin:()=>enter(false),onObjectEnd:()=>{stack.pop();},onArrayEnd:()=>{stack.pop();},onObjectProperty:k=>{key(k);if(stack.at(-1)?.has(k))ownedFail();stack.at(-1)?.add(k);},onLiteralValue:()=>{node();},onError:()=>ownedFail()}, {disallowComments:true,allowTrailingComma:false});
 let value:unknown;try{value=JSON.parse(text);}catch{ownedFail();}canonicalOwnedJson(value,maxBytes);return value;
}
