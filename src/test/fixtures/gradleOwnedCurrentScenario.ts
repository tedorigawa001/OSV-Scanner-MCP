/** Reproducible C0 memory trace. No filesystem or native service is started. */
import {CurrentControl,type CurrentActor} from './gradleOwnedCurrentControl.js';
import {currentRoles,type CurrentRole,type CurrentAPI} from './gradleOwnedCurrentSchema.js';
import {currentSource,extendCurrentSource} from './gradleOwnedCurrentSource.js';
import {ownedSha256,ownedDigest} from '../../utils/gradleOwnedJson.js';
export async function runCurrentScenario(){
 const source=currentSource(),c=new CurrentControl({now:()=>0,readerNow:()=>100000,approvedBase:source.approvedBaseDigest}),a=Object.fromEntries(currentRoles.map(role=>[role,c.actor(role)])) as Record<CurrentRole,CurrentActor>;let sequence=0;
 const call=(role:CurrentRole,api:CurrentAPI,payload:unknown)=>c.call(a[role],api,payload,'trace-'+ ++sequence);
 const snapshot=c.registerSource(a.provider,source),provision=(await call('operator','BeginEnrollment',{approvedBase:source.approvedBaseDigest})).value.provision,previous=c.view().currentRecordRef;
 await call('checkpoint-issuer','ReadForCheckpoint',{fence:provision,snapshot,kind:'commit',index:0,offset:0,maxBytes:16});
 const checkpoint=(await call('provider','PrepareCheckpoint',{mode:'genesis',fence:provision,snapshot})).value.checkpoint;await call('operator','ActivateEnrollment',{provision,checkpoint});
 const current=c.view(),attemptId=ownedDigest({registry:'registry',incarnation:current.incarnation,previous,next:current.currentRecordRef});
 await call('lineage-registry','anchor.read',{});await call('lineage-registry','anchor.cas',{expected:previous,next:current.currentRecordRef,attemptId});await call('lineage-registry','anchor.query-operation',{attemptId});
 const cancelled=(await call('writer','ReserveWriter',{expectedSelection:1})).value.fence;await call('provider','CheckLiveBinding',{target:cancelled,purpose:'checkpoint'});await call('writer','CancelWriter',{fence:cancelled});
 const wire=c.request(a.reader,'AcquireReadPin',{operationBinding:ownedSha256('business')},'lost-response');c.schedule(a.operator,'anchor-after-cas','lose-response');
 try{await c.dispatch(a.reader,wire);throw new Error('loss control did not run');}catch(e){if(!(e instanceof Error&&e.message==='current_control_response_lost'))throw e;}
 const original=Object.values(c.view().pins)[0]!,other=(await call('reader','AcquireReadPin',{operationBinding:ownedSha256('business')})).value.pin,before=c.metrics.anchorCAS;
 const retry=c.retry(a.reader,wire),resolved=c.accept(a.reader,retry,await c.dispatch(a.reader,retry)),additionalCAS=c.metrics.anchorCAS-before;
 await call('reader','ReleaseReadPin',{pin:other});const request=c.inspectRequest(wire);await call('reader','QueryOperation',{originalAPI:'AcquireReadPin',operationId:request.operationId,originalRequestDigest:request.requestDigest});
 const p=resolved.value.pin,witness=(await call('reader','ReadCurrentCheckpoint',{pin:p,checkpoint})).value.witness,gate=c.authorityGate(a['authority-broker'],p,'trace-use',Buffer.from('candidate'));
 await call('authority-broker','PrepareHandoff',{pin:p,witness,...gate,useId:'trace-use'});const decision=c.view().pins[p.id]!.phase;
 const delivery=(await call('authority-broker','DeliverResult',{pin:p,useId:'trace-use'})).value.delivery,delivering=c.view().pins[p.id]!.phase;
 await call('reader','AcknowledgeDelivery',{pin:p,delivery,effect:null});const released=c.view().pins[p.id]!.phase;
 const fence=(await call('writer','ReserveWriter',{expectedSelection:1})).value.fence,next=c.registerSource(a.provider,extendCurrentSource(source)),prepared=(await call('provider','PrepareCheckpoint',{mode:'advance',fence,snapshot:next})).value.checkpoint;
 await call('writer','PublishSelection',{fence,checkpoint:prepared});const barrier=(await call('operator','BeginBarrier',{reason:'restart',participants:c.requiredParticipants()})).value.barrier;
 for(const id of c.view().barrier!.participants)await c.call(a[id as CurrentRole],'ConfirmFenced',{barrier,evidence:c.ownIdleEvidence(a[id as CurrentRole],barrier)},'trace-'+ ++sequence);
 await call('operator','FinishBarrier',{barrier});const frozen=c.view().phase;await call('operator','ResumeServing',{barrier});
 return {schema:'osv-mcp.q2.c0.scenario.v1',scope:'memory-contract-only',lostResponse:{resolutionMode:resolved.resolutionMode,appliedControlRevision:resolved.appliedControlRevision,currentControlRevision:resolved.currentControlRevision,samePin:resolved.value.pin.id===original.ref.id,leaseExtended:resolved.value.expires!==original.expires,additionalCAS},
  handoffPhases:[decision,delivering,released],barrierPhase:frozen,finalPhase:c.view().phase,selectedSourceRevision:c.view().selected!.head.revision,selectionRevision:c.view().selectionRevision,metrics:c.metrics};
}
