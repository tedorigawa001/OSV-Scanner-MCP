/** LG-0 only: logical arenas and data-only ownership, not a production heap bound. */
import {types} from 'node:util';
import {z} from 'zod';
import {credentialSchema} from './gradleOwnedCprBOwners.js';
import {currentLineageSchema} from '../../utils/gradleOwnedCurrentAuxiliary.js';
import {canonicalOwnedJson as canonical} from '../../utils/gradleOwnedJson.js';
import {need,cn,chash,parsed} from '../../utils/gradleOwnedCurrentSchema.js';

export const LG0_POLICY=lgFreeze({profile:'cwc.owned-live-permission-input.v1',stage:'LG-0-standalone',
 clock:'fixed',inputModes:['full-input','owned-input'],memory:1048576,work:156978,
 sessionBytes:131072,constructorBytes:131072,callBytes:98304,bindingBytes:8192,vfBytes:4096,
 callLayout:{wireAndCopies:57344,vfMetadata:4096,controlMetadata:4096,sharedFrameWorkspace:32768},
 arenaBytes:4096,rowBytes:2048,poolBytes:1024,metadataBytes:1024,initializationWork:4096,
 maxRows:64,rawBytes:32768,maxNodes:2048,maxDepth:12,freezeNodes:256,tupleWrites:256,canonicalCalls:65,fixedOperations:512,maxChecks:4096});
export type Lg0Mode='full-input'|'owned-input';
export const lgViewSchema=z.object({peer:z.boolean(),server:z.boolean(),peerKeyEpoch:cn.positive(),serverKeyEpoch:cn.positive(),
 permissions:credentialSchema.shape.permissions,purpose:z.enum(['read','publication']),
 registryPin:chash,sourcePin:chash,profilePin:chash,callbackPolicy:cn}).strict();
export type Lg0View=z.infer<typeof lgViewSchema>;
export type Lg0Work={nodeVisits:number;freezeNodes:number;tupleWrites:number;canonicalCalls:number;fixedOperations:number};

/** Descriptor reads reject proxies/accessors before any value, iterator, toJSON or structuredClone use. */
export function lgOwnedCopy(input:unknown,maxBytes=57344):unknown{
 let nodes=0,strings=0;const active=new Set<object>();
 function copy(v:unknown,depth:number):any{
  need(++nodes<=2048&&depth<=12,'codec_budget_exceeded');
  if(v===null||typeof v==='boolean')return v;
  if(typeof v==='string'){need((strings+=Buffer.byteLength(v))<=maxBytes,'codec_budget_exceeded');return v;}
  if(typeof v==='number'){need(Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0),'schema_invalid');return v;}
  need(typeof v==='object'&&!types.isProxy(v)&&!active.has(v),'schema_invalid');
  const array=Array.isArray(v);need(Object.getPrototypeOf(v)===(array?Array.prototype:Object.prototype),'schema_invalid');
  active.add(v);const out:any=array?[]:{};
  for(const key of Reflect.ownKeys(v)){
   need(typeof key==='string','schema_invalid');const d=Object.getOwnPropertyDescriptor(v,key)!;need('value'in d,'schema_invalid');
   if(array&&key==='length'){need(d.value<=2048,'codec_budget_exceeded');continue;}
   need(d.enumerable&&(!array||/^(0|[1-9][0-9]*)$/.test(key)),'schema_invalid');
   need((strings+=Buffer.byteLength(key))<=maxBytes,'codec_budget_exceeded');
   Object.defineProperty(out,key,{value:copy(d.value,depth+1),enumerable:true,writable:true,configurable:true});
  }
  if(array)need(out.length===Reflect.getOwnPropertyDescriptor(v,'length')!.value&&Object.keys(out).length===out.length,'schema_invalid');
  active.delete(v);return out;
 }
 const out=copy(input,0);need(Buffer.byteLength(canonical(out,maxBytes))<=maxBytes,'codec_budget_exceeded');return out;
}
export function lgFreeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))lgFreeze(child);Object.freeze(v);}return v;}
export function lgOwnedView(input:unknown):Lg0View{
 const v=parsed(lgViewSchema,lgOwnedCopy(input));need(Buffer.byteLength(canonical(v.permissions,32768))<=32768,'codec_budget_exceeded');return lgFreeze(v);
}
type Tuple=readonly [string,string,string|null,string];
export type Lg0Projection={rows:readonly Tuple[];expectedKey:string;work:Lg0Work;poolBytes:number;temporaryBytes:number};
export function lgNormalize(view:Lg0View,lineage:unknown):Lg0Projection{
 const work:Lg0Work={nodeVisits:8,freezeNodes:0,tupleWrites:0,canonicalCalls:0,fixedOperations:512};
 const pool=new Map<string,string>();let poolBytes=0,temporaryBytes=0;
 function key(v:unknown){work.canonicalCalls++;const k=canonical(parsed(currentLineageSchema,v),4096);temporaryBytes+=Buffer.byteLength(k);
  need(temporaryBytes<=32768,'codec_budget_exceeded');if(!pool.has(k)){poolBytes+=Buffer.byteLength(k);need(poolBytes<=1024,'codec_profile_unsupported');pool.set(k,k);}return pool.get(k)!;}
 const expectedKey=key(lineage),rows:Tuple[]=[];
 for(const p of view.permissions){work.nodeVisits+=11;work.tupleWrites+=4;rows.push(Object.freeze([p.api,p.purpose,p.delegateInstance,key(p.lineage)]));work.freezeNodes++;}
 Object.freeze(rows);work.freezeNodes++;need(rows.length<=64&&work.nodeVisits<=2048&&work.freezeNodes<=256&&work.tupleWrites<=256&&work.canonicalCalls<=65,'codec_budget_exceeded');
 return {rows,expectedKey,work,poolBytes,temporaryBytes};
}
