/** Captured Buffer accessors: later prototype changes cannot receive private arenas. */
const get16=Buffer.prototype.readUInt16LE,set16=Buffer.prototype.writeUInt16LE,get32=Buffer.prototype.readUInt32LE,set32=Buffer.prototype.writeUInt32LE;
export const read16=(b:Buffer,at:number):number=>Reflect.apply(get16,b,[at]);
export const write16=(b:Buffer,value:number,at:number):void=>{Reflect.apply(set16,b,[value,at]);};
export const read32=(b:Buffer,at:number):number=>Reflect.apply(get32,b,[at]);
export const write32=(b:Buffer,value:number,at:number):void=>{Reflect.apply(set32,b,[value,at]);};
import {createHash} from 'node:crypto';
const nativeCreateHash=createHash,hashPrototype=Object.getPrototypeOf(nativeCreateHash('sha256')),nativeUpdate=hashPrototype.update,nativeDigest=hashPrototype.digest;
/** Diagnostic-only digest; even cleanup must not expose a private buffer to a replaced prototype. */
export function r0DiagnosticSha(bytes:Buffer){const h=nativeCreateHash('sha256');Reflect.apply(nativeUpdate,h,[bytes]);return Reflect.apply(nativeDigest,h,['hex']) as string;}
