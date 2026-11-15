/** Pure PB0 transition fixture. Presence of a ref does not prove it is durably stored. */
import {z} from 'zod';
import {pb0Decode,pb0Need,pb0RefSchema as ref} from './gradleOwnedP0StateContract.js';
const n=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const snapshot=z.object({identity:hash,realmId:id,state:id,revision:n.positive(),authRevision:n,selectionRevision:n,originalDeadline:n,spent:z.object({calls:n,wireBytes:n,work:n}).strict()}).strict();
const maybe=ref.nullable();
const ownerRefs=z.object({registry:maybe,custodian:maybe,controller:maybe}).strict();
const facts=z.object({descriptor:maybe,methodApproval:maybe,environmentApproval:maybe,pin:maybe,reservation:maybe,preflight:maybe,anchor:maybe,adoption:maybe,
 oldEpochInvalidation:maybe,managerFence:maybe,bootApproval:maybe,epochSelection:maybe,rootPin:maybe,journal:maybe,checkpoint:maybe,writerLock:maybe,drain:maybe,debt:maybe,allocator:maybe,quarantine:maybe,responseReady:maybe,escape:maybe,tombstone:maybe,grantRevoke:maybe}).strict();
export const pb0TransitionSchema=z.object({schema:z.literal('cwc.e2-p0.pb0-transition.v1'),machine:z.enum(['job','service','read-stage','origin']),event:z.enum(['advance','grant-revoke','pin-update']),now:n,controlDeadline:n,from:snapshot,to:snapshot,facts,ownerFences:ownerRefs,ownerAdoptions:ownerRefs}).strict();
const graph:Record<string,Record<string,readonly string[]>>={
 job:{registered:['awaiting-approval','revoking'],'awaiting-approval':['metadata-ready','revoking'],'metadata-ready':['preflight-ready','revoking'],'preflight-ready':['revoking'],revoking:['fenced'],fenced:['quarantined','settled'],quarantined:['settled'],settled:[]},
 service:{created:['recovering','blocked'],recovering:['control-ready','blocked'],'control-ready':['operational','blocked'],operational:['draining','blocked'],draining:['closed','blocked'],closed:[],blocked:[]},
 'read-stage':{'intent-reserved':['source-captured','failed-or-unknown'],'source-captured':['response-ready','failed-or-unknown'],'response-ready':['response-may-have-escaped','failed-or-unknown'],'response-may-have-escaped':['historical','failed-or-unknown'],'failed-or-unknown':['historical'],historical:[]},
 origin:{unknown:['absent-tombstoned'],'absent-tombstoned':[]}
};
export function pb0CheckTransition(wire:string){
 const t=pb0Decode(pb0TransitionSchema,wire),a=t.from,b=t.to,f=t.facts;
 pb0Need(a.identity===b.identity&&a.realmId===b.realmId&&b.revision===a.revision+1,'transition-identity-revision');
 pb0Need(b.originalDeadline===a.originalDeadline&&t.now<t.controlDeadline,'transition-original-deadline');
 for(const k of ['calls','wireBytes','work'] as const)pb0Need(b.spent[k]>=a.spent[k],'transition-consumption-reduced');
 pb0Need(b.authRevision>=a.authRevision&&b.selectionRevision>=a.selectionRevision,'transition-revision-rollback');
 const require=(...names:(keyof typeof f)[])=>names.forEach(k=>pb0Need(f[k],'transition-evidence-'+k));
 const all=(v:z.infer<typeof ownerRefs>)=>{pb0Need(Object.values(v).every(Boolean),'transition-all-owners');pb0Need(new Set(Object.values(v).map(r=>r!.id)).size===3,'transition-owner-alias');};
 const live=()=>pb0Need(t.now<a.originalDeadline,'transition-job-expired');
 if(t.event!=='advance'){
  pb0Need(t.machine==='job'&&['metadata-ready','preflight-ready'].includes(a.state)&&a.state===b.state,'transition-event');live();require('anchor','adoption');
  if(t.event==='grant-revoke'){require('grantRevoke');pb0Need(b.authRevision===a.authRevision+1&&b.selectionRevision===a.selectionRevision,'transition-grant-revision');}
  else {require('pin');pb0Need(b.selectionRevision===a.selectionRevision+1&&b.authRevision===a.authRevision,'transition-pin-revision');}
 }else{
  pb0Need(graph[t.machine]?.[a.state]?.includes(b.state),'transition-edge');
  if(t.machine==='job'){
   if(b.state==='awaiting-approval'){live();require('descriptor');}
   if(b.state==='metadata-ready'){live();require('methodApproval','environmentApproval','pin');pb0Need(f.methodApproval!.id!==f.environmentApproval!.id,'transition-approval-alias');}
   if(b.state==='preflight-ready'){live();require('reservation','preflight');}
   if(b.state==='revoking'){require('anchor','adoption');pb0Need(b.authRevision===a.authRevision+1,'transition-revoke-revision');}
   if(b.state==='fenced'){require('anchor','adoption');all(t.ownerFences);}
   if(b.state==='quarantined')require('quarantine','debt');
   if(b.state==='settled'){require('drain','debt','allocator','anchor','adoption');all(t.ownerFences);}
  }
  if(t.machine==='service'){
   if(b.state==='recovering')require('writerLock','rootPin');
   if(b.state==='control-ready')require('journal','checkpoint','anchor','adoption');
   if(b.state==='operational'){require('oldEpochInvalidation','managerFence','bootApproval','epochSelection','rootPin','anchor','adoption');all(t.ownerFences);all(t.ownerAdoptions);}
   if(b.state==='closed')require('drain','debt');
  }
  if(t.machine==='read-stage'){
   if(b.state==='source-captured'){live();require('journal','anchor','adoption');}
   if(b.state==='response-ready'){live();require('responseReady','anchor','adoption');}
   if(b.state==='response-may-have-escaped'){live();require('responseReady','escape','anchor','adoption');pb0Need(f.escape!.id!==f.responseReady!.id,'transition-separate-escape');}
  }
  if(t.machine==='origin')require('tombstone','anchor','adoption');
 }
 return {schema:'cwc.e2-p0.pb0-transition-result.v1' as const,staticTransitionVerified:true as const,jobPermitIssued:false as const,runtimeAdmitted:false as const};
}
