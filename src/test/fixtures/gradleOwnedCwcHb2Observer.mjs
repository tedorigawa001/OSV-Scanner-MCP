/** Separate diagnostic transformation. Its generated artifact is NEVER accepted as candidate core. */
const epilogue=`
import {control} from 'hb1:diagnostic-control';
let armed,caught=0,faultFrames=0,faultBodies=0;
function diagnosticPublication(r,w){const fault=armed;if(!fault||fault==='cleanup-after-first')return;armed=undefined;
 if(fault.startsWith('reenter-')){try{if(fault==='reenter-publish')reader.publish(r.owner,w);else if(fault==='reenter-reclaim')reader.reclaim(r.owner);else reader.openAttempt(r.owner);}catch{caught++;}faultFrames=r.frames;faultBodies=2;}
 else if(fault==='cancel-before-publication')fatal(r,'cancelled');
 else if(fault==='expire-before-publication')control.advance(r.deadline-port.current().now);
 else if(fault==='revoke-before-publication')control.revoke();
 else if(fault==='pin-restore-before-publication'){const pin=port.current().pin;control.setPin(pin+1);control.setPin(pin);}
}
function diagnosticCleanup(r,i){if(armed==='cleanup-after-first'&&i===0){armed=undefined;fatal(r,'cleanup');need(false,'cleanup');}}
const faultNames=['reenter-publish','reenter-reclaim','reenter-open','cancel-before-publication','expire-before-publication','revoke-before-publication','pin-restore-before-publication','cleanup-after-first'];
function inspect(h){let r,readRows=0,authorityLookups=0;for(let i=0;i<rows.length;i++){const x=rows[i];if(x){readRows++;if(x.authority)authorityLookups++;if(x.owner===h)r=x;}}
 let borrows=0,pending=0,refs=0,identities=0,binary=0;if(r)for(let i=0;i<2;i++){const b=r.bodies[i];if(!b)continue;if(b.borrow)borrows++;if(b.transport)pending++;refs+=b.refs.length;identities+=b.handles.length;if(b.buffer)binary+=3072;}
 return {mode:port.mode,capacity:port.capacity,readRows,authorityLookups,heldBodySlots:held,allocatedBytes:allocated,zeroedBytes:zeroed,reclaims,publications,reentries,caught,faultFrames,faultBodies,currentReads,
  read:r?{ticket:r.ticket,sequence:r.sequence,actor:r.actor,state:r.state,reason:r.reason,attempt:r.attempt,frames:r.frames,deadline:r.deadline,authority:r.authority!==undefined,binaryBytes:binary,referenceSlots:refs,identities,borrows,pendingTransport:pending,borrowUsesFirstBody:!!r.bodies[0]?.borrow&&r.bodies[0].borrow===r.bodies[0].buffer,distinctBodies:!!r.bodies[0]?.buffer&&r.bodies[0].buffer!==r.bodies[1]?.buffer,fullChecks:r.fullChecks,ownedChecks:r.ownedChecks}:null};
}
export const diagnostic=Object.freeze({arm(f){need(faultNames.includes(f)&&armed===undefined,'fault');armed=f;},inspect});
`;
export function instrumentHb2(source){for(const marker of ['/* HB2_PUBLICATION_FENCE */','/* HB2_CLEANUP_FENCE */'])if(source.split(marker).length!==2)throw Error('hb1_diagnostic_anchor');return source.replace('/* HB2_PUBLICATION_FENCE */','diagnosticPublication(r,arg);').replace('/* HB2_CLEANUP_FENCE */','diagnosticCleanup(r,i);')+epilogue;}
