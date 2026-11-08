/** Diagnostic wrapper only; primary transfers never install these spies. */
import {vi} from 'vitest';
import * as schema from '../../utils/gradleOwnedCurrentSchema.js';
import * as json from '../../utils/gradleOwnedJson.js';
import {span} from './gradleOwnedCprBPProfile.js';
export function instrumentPlans(){
 const parse=schema.parsed,digest=json.ownedDigest,hash=json.ownedSha256,canonical=json.canonicalOwnedJson;
 const spies=[
  vi.spyOn(schema,'parsed').mockImplementation((...args)=>span('schema',()=>parse(...args))),
  vi.spyOn(json,'ownedDigest').mockImplementation((...args)=>span('hash.digest',()=>digest(...args))),
  vi.spyOn(json,'ownedSha256').mockImplementation((...args)=>span('hash.bytes',()=>hash(...args))),
  vi.spyOn(json,'canonicalOwnedJson').mockImplementation((...args)=>span('codec.json',()=>canonical(...args))),
 ];
 return ()=>{for(const spy of spies)spy.mockRestore();};
}
