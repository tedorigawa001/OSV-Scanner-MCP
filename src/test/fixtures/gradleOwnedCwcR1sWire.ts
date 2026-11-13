/** Fixed summary codec. No hash/canonical/stringification, callback, or authority decision. */
import {types} from 'node:util';
const proxy=types.isProxy,proto=Object.getPrototypeOf,desc=Object.getOwnPropertyDescriptor,keys=Reflect.ownKeys,create=Object.create,freeze=Object.freeze,apply=Reflect.apply,ownPrototype=Object.prototype;
const NativeError=Error,isSafe=Number.isSafeInteger,is=Object.is,floor=Math.floor,char=String.prototype.charCodeAt;
const typedPrototype=proto(Uint8Array.prototype),lengthGetter=desc(typedPrototype,'byteLength')!.get!,bufferGetter=desc(typedPrototype,'buffer')!.get!,arrayBufferLength=desc(ArrayBuffer.prototype,'byteLength')!.get!;
export const SUMMARY_FIELDS=freeze(['readSeq','attempt','generation','reason','captured','proved','work','initialization','wire','attempts','heldBytes','pending','borrow','zeroedBytes','exportOrdinal'] as const);
type Counter=typeof SUMMARY_FIELDS[number];
export type SummaryRecord=Readonly<Record<Counter,number>&{sourceDigest:string;profileDigest:string;layoutDigest:string}>;
const digests=freeze(['sourceDigest','profileDigest','layoutDigest'] as const);
function need(v:unknown,r:string):asserts v{if(!v)throw NativeError('r1s_wire_'+r);}
const integer=(n:unknown):n is number=>typeof n==='number'&&isSafe(n)&&n>=0&&!is(n,-0);
function nibble(s:string,i:number){const n=apply(char,s,[i]) as number;return n>=48&&n<=57?n-48:n>=97&&n<=102?n-87:-1;}
function record(input:SummaryRecord){
 need(input&&typeof input==='object'&&!proxy(input)&&proto(input)===ownPrototype,'record');const names=keys(input);need(names.length===18,'keys');
 const out=create(null) as Record<string,number|string>;for(let i=0;i<18;i++){const name=i<15?SUMMARY_FIELDS[i]!:digests[i-15]!,d=desc(input,name);need(d&&'value'in d&&d.enumerable,'accessor');out[name]=d.value;}
 for(let i=0;i<15;i++)need(integer(out[SUMMARY_FIELDS[i]!]),'counter');
 const r=out as unknown as SummaryRecord;need(r.readSeq>0&&r.generation>0&&(r.attempt===1||r.attempt===2)&&r.exportOrdinal===r.attempt&&r.attempts>=r.attempt&&r.attempts<=2&&r.reason<=3&&r.proved<=r.captured,'semantics');
 for(let i=0;i<3;i++){const s=out[digests[i]!];need(typeof s==='string'&&s.length===64,'digest');for(let j=0;j<64;j++)need(nibble(s,j)>=0,'digest');}return out as unknown as SummaryRecord;
}
function span(b:Uint8Array,offset:number){
 need(b&&typeof b==='object'&&!proxy(b)&&proto(b)===Uint8Array.prototype&&integer(offset),'buffer');
 const n=apply(lengthGetter,b,[]) as number;need(integer(n)&&offset<=n-256,'length');const backing=apply(bufferGetter,b,[]);try{apply(arrayBufferLength,backing,[]);}catch{throw NativeError('r1s_wire_shared_buffer');}
}
function u64(b:Uint8Array,at:number){let n=0;for(let i=0;i<8;i++){n=n*256+b[at+i]!;need(integer(n),'counter');}return n;}
export function writeSummaryAt(b:Uint8Array,offset:number,input:SummaryRecord){
 span(b,offset);const r=record(input);for(let i=0;i<256;i++)b[offset+i]=0;b[offset]=82;b[offset+1]=49;b[offset+2]=72;b[offset+3]=83;b[offset+5]=1;
 for(let i=0;i<15;i++){let n=r[SUMMARY_FIELDS[i]!]!;for(let j=7;j>=0;j--){b[offset+8+i*8+j]=n%256;n=floor(n/256);}}
 for(let i=0;i<3;i++){const s=r[digests[i]!]!;for(let j=0;j<32;j++)b[offset+128+i*32+j]=nibble(s,2*j)*16+nibble(s,2*j+1);}
}
/** Validates every byte against a separately retained, owned producer receipt; never returns a decoded graph. */
export function checkSummaryAt(b:Uint8Array,offset:number,input:SummaryRecord){
 span(b,offset);const r=record(input);need(b[offset]===82&&b[offset+1]===49&&b[offset+2]===72&&b[offset+3]===83&&b[offset+4]===0&&b[offset+5]===1&&b[offset+6]===0&&b[offset+7]===0,'header');
 for(let i=0;i<15;i++)need(u64(b,offset+8+i*8)===r[SUMMARY_FIELDS[i]!],'binding');
 for(let i=0;i<3;i++){const s=r[digests[i]!]!;for(let j=0;j<32;j++)need(b[offset+128+i*32+j]===nibble(s,2*j)*16+nibble(s,2*j+1),'digest');}
 for(let i=224;i<256;i++)need(b[offset+i]===0,'reserved');
}
