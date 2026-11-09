/** Independent CWC-B oracle: existing codecs + canonicalOwnedJson, no closed-tree implementation. */
import {createPublicKey,verify,type KeyObject} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {decodeCurrent,need,parsed} from '../../utils/gradleOwnedCurrentSchema.js';
import {authEnvelopeSchema} from './gradleOwnedCgpI2Protocol.js';
import {owner,result,frames,verifyOwner,newStats} from './gradleOwnedCprAWire.js';
import {type CprContext,type CprCommand} from './gradleOwnedCprASchema.js';
export function cwcBOracle(c:CprContext,q:CprCommand,parts:Buffer[],keys?:{request:KeyObject;reply:KeyObject}){
 const stats=newStats();stats.phase='final';
 const request=owner(c,'request',{api:'ReadSourceRanges',command:q},keys?.request,stats),reply=owner(c,'reply',result(c,q,parts),keys?.reply,stats);
 const auth=frames(c,request,reply,keys,stats);
 if(keys){verifyOwner(c,request,'request',createPublicKey(keys.request));verifyOwner(c,reply,'reply',createPublicKey(keys.reply));}
 const vectors:{domain:string;input:unknown;bytes:Buffer;preimage:boolean}[]=[];
 let signatureVerifications=keys?2:0;
 for(const [i,wire]of [request,reply].entries()){const e:any=decodeCurrent(wire,8192),{signature,...unsigned}=e,name=i?'owner.reply':'owner.request';vectors.push({domain:name+'.signed',input:e,bytes:wire,preimage:false},{domain:name+'.unsigned',input:unsigned,bytes:Buffer.from(canonical(unsigned)),preimage:true});}
 for(const [i,wire]of auth.entries()){const e=parsed(authEnvelopeSchema,decodeCurrent(wire)),preimage={domain:e.schema,direction:e.direction,keyId:e.keyId,body:e.body},name='auth.'+e.body.kind+'.'+e.direction;
  if(keys){need(verify(null,Buffer.from(canonical(preimage)),createPublicKey(i%2?keys.reply:keys.request),Buffer.from(e.signature,'base64')),'signature_invalid');signatureVerifications++;}
  vectors.push({domain:name+'.signed',input:e,bytes:wire,preimage:false},{domain:name+'.unsigned',input:preimage,bytes:Buffer.from(canonical(preimage)),preimage:true});
 }
 return {vectors,request,reply,auth,stats,signatureVerifications,partBytes:parts.reduce((n,b)=>n+b.length,0),wireDigest:sha(Buffer.concat([request,reply,...auth]))};
}
