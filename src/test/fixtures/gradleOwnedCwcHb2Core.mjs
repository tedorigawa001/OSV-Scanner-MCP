/** HB-2 candidate artifact. The only export is a sealed reader; no mint, controller, observer or fault program. */
import {port} from 'hb2:reader-port';
const freeze=Object.freeze,create=Object.create,define=Object.defineProperty,setPrototype=Object.setPrototypeOf;
const NativeArray=Array,Bytes=Uint8Array,fill=Uint8Array.prototype.fill,apply=Reflect.apply,NativeError=Error,isSafe=Number.isSafeInteger,is=Object.is,prototype=Object.getPrototypeOf,isFrozen=Object.isFrozen,descriptor=Object.getOwnPropertyDescriptor;
let activeTicket=-1,currentReads=0;
const admission=port.admission;
const need=(v,r)=>{if(!v){if(activeTicket<0)admission.refuse('hb2_binding');admission.error(activeTicket);throw NativeError('hb2_'+r);}};
const integer=n=>typeof n==='number'&&isSafe(n)&&n>=0&&!is(n,-0);
function fixed(n,fn){const a=new NativeArray(n);for(let i=0;i<n;i++)define(a,i,{value:fn(i),writable:true,enumerable:true,configurable:true});return a;}
function opaque(){return freeze(create(null));}
const rows=fixed(port.capacity,()=>undefined);
let sequence=0,busy=false,active,held=0,allocated=0,zeroed=0,reclaims=0,publications=0,reentries=0;
const numericFields=freeze(['now','revision','pin','approvalRevision','memory','work']),booleanFields=freeze(['revoked','approved']);
function current(){currentReads++;const v=port.current();need(v&&prototype(v)===null&&isFrozen(v),'current');
 for(let i=0;i<numericFields.length;i++){const d=descriptor(v,numericFields[i]);need(d&&'value'in d&&integer(d.value),'current');}
 for(let i=0;i<booleanFields.length;i++){const d=descriptor(v,booleanFields[i]);need(d&&'value'in d&&typeof d.value==='boolean','current');}
 need(v.purpose==='read'||v.purpose==='other','current');return v;
}
function permitted(v){need(!v.revoked&&v.purpose==='read'&&v.approved&&v.memory>0&&v.work>0,'authority');}
function fatal(r,reason){r.authority=undefined;if(r.state!=='retiring'){r.state='retiring';r.reason=reason;for(let i=0;i<2;i++){const b=r.bodies[i];if(!b)continue;b.first=false;b.seal=false;b.closed=true;}}}
function guard(){if(busy){if(active)fatal(active,'reentry');reentries++;admission.refuse('hb2_reentry');}}
function find(h,completion){if(!h||typeof h!=='object')admission.refuse('hb2_binding');for(let i=0;i<rows.length;i++){const r=rows[i];if(r&&(completion?r.owner:r.authority)===h)return r;}admission.refuse('hb2_binding');}
function live(r){need(r.state==='active',r.reason??'closed');const v=current();
 if(v.now<r.last||v.now>=r.deadline){fatal(r,v.now<r.last?'clock':'expired');need(false,r.reason);}r.last=v.now;
 if(v.revoked||v.purpose!=='read'||!v.approved||v.memory===0||v.work===0){fatal(r,'authority');need(false,'authority');}
 if(v.pin!==r.pin||v.revision!==r.revision||v.approvalRevision!==r.approvalRevision){fatal(r,'revision');need(false,'revision');}
 if(port.mode==='full-input'){r.fullChecks++;need(isFrozen(r.binding)&&r.binding.owner===r.owner&&r.binding.scope===r.scope&&r.binding.root===port.root&&r.binding.call===port.call&&r.binding.generation===r.sequence&&r.binding.portOwner===port.owner&&r.binding.actor===r.actor,'full_binding');}
 else{r.ownedChecks++;need(r.ownedView===r.binding&&r.binding.portOwner===port.owner&&r.binding.call===port.call,'owned_binding');}
}
function body(r,w){const b=r.bodies[r.attempt-1];need(b&&b.issued&&!b.closed&&(w===b.handles[3]&&b.first||w===b.handles[4]&&b.seal),'window');return b;}
function release(r){need(r.ready&&r.frames===0,'drain');for(let i=0;i<2;i++){const b=r.bodies[i];need(!b.buffer&&!b.borrow&&!b.transport,'drain');for(let j=0;j<48;j++)need(b.refs[j]===null,'drain');}for(let i=0;i<rows.length;i++)if(rows[i]===r)rows[i]=undefined;admission.release(r.ticket);held-=2;reclaims++;}
function begin(actor='provider'){guard();if(actor!=='provider'&&actor!=='client')admission.refuse('hb2_actor');let index=-1;for(let i=0;i<rows.length;i++)if(rows[i]===undefined){index=i;break;}if(index<0)admission.refuse('hb2_registry_full');
 const ticket=admission.begin();busy=true;activeTicket=ticket;let r;
 try{r={ticket,owner:undefined,authority:undefined,scope:undefined,sequence:++sequence,actor,state:'building',reason:null,attempt:0,frames:1,ready:false,last:0,deadline:0,revision:0,pin:0,approvalRevision:0,binding:undefined,ownedView:undefined,bodies:fixed(2,()=>undefined),publications:0,fullChecks:0,ownedChecks:0};rows[index]=r;active=r;held+=2;
 const v=current();permitted(v);need(integer(v.now+4500),'deadline');
  for(let i=0;i<2;i++){const buffer=new Bytes(3072);admission.payload(ticket,3072);allocated+=3072;apply(fill,buffer,[i+1]);r.bodies[i]={handles:freeze(fixed(8,opaque)),refs:fixed(48,()=>null),buffer,issued:false,first:false,seal:false,closed:false,zeroed:false,borrowIssued:false,transportIssued:false,firstPublished:false,sealPublished:false,borrow:undefined,transport:undefined};}
  const owner=r.bodies[0].handles[0],scope=opaque();const binding=freeze({owner,scope,root:port.root,call:port.call,generation:r.sequence,portOwner:port.owner,actor});
  r.owner=owner;r.authority=owner;r.scope=scope;r.binding=binding;r.ownedView=binding;r.state='active';r.last=v.now;r.deadline=v.now+4500;r.revision=v.revision;r.pin=v.pin;r.approvalRevision=v.approvalRevision;
  for(let i=0;i<2;i++){const b=r.bodies[i];b.refs[0]=reader;b.refs[1]=owner;b.refs[2]=scope;b.refs[3]=port;b.refs[6]=port;b.refs[11]=r;b.refs[14]=b.handles[3];b.refs[15]=actor==='client'?b.handles[4]:null;b.refs[38]=b.buffer;b.refs[39]=rows;b.refs[45]=b.handles[0];b.refs[46]=b.handles[5];b.refs[47]=b.handles[7];}return owner;
 }catch(e){if(r){r.authority=undefined;r.state='retiring';r.reason='initialization';}admission.quarantine(ticket);throw e;}
 finally{if(r)r.frames--;active=undefined;busy=false;admission.finish(ticket);activeTicket=-1;}
}
function run(op,h,arg){guard();const completion=op==='endBorrow'||op==='endTransport'||op==='closeRead'||op==='cancel'||op==='reclaim';const r=find(h,completion);try{admission.enter(r.ticket,completion);}catch(e){fatal(r,completion?'cleanup_budget':'entry_budget');throw e;}busy=true;active=r;activeTicket=r.ticket;r.frames++;
 try{if(!completion)live(r);
  if(op==='openAttempt'){need(r.attempt<2&&(r.attempt===0||r.bodies[r.attempt-1].closed),'attempt');const b=r.bodies[r.attempt++];b.issued=true;b.first=true;b.seal=r.actor==='client';return b.handles[0];}
  if(op==='window'){need(arg==='first'||arg==='seal','window');const b=r.bodies[r.attempt-1];need(b?.issued&&!b.closed&&(arg==='first'?b.first:b.seal),'window');return b.handles[arg==='first'?3:4];}
  if(op==='beginBorrow'){const b=body(r,arg);need(!b.borrowIssued&&b.buffer,'borrow');b.borrowIssued=true;b.borrow=b.buffer;return b.handles[5];}
  if(op==='beginTransport'){const b=body(r,arg);let pending=0;for(let i=0;i<2;i++)if(r.bodies[i].transport)pending++;need(!b.transportIssued&&b.buffer&&pending===0,'transport');b.transportIssued=true;b.transport=b.buffer;return b.handles[6];}
  if(op==='endBorrow'||op==='endTransport'){const at=op==='endBorrow'?5:6,key=op==='endBorrow'?'borrow':'transport';let b;for(let i=0;i<2;i++)if(r.bodies[i].handles[at]===arg)b=r.bodies[i];need(b?.[key],key);b[key]=undefined;return;}
  if(op==='publish'){const b=body(r,arg);need(arg===b.handles[3]?!b.firstPublished:!b.sealPublished,'published');
   /* HB2_PUBLICATION_FENCE */
   live(r);if(arg===b.handles[3])b.firstPublished=true;else b.sealPublished=true;r.publications++;publications++;return;
  }
  if(op==='closeWindow'){const b=body(r,arg);if(arg===b.handles[3])b.first=false;else b.seal=false;b.closed=!b.first&&!b.seal;return;}
  if(op==='closeRead'){if(r.state==='active'){r.authority=undefined;r.state='closing';for(let i=0;i<2;i++){const b=r.bodies[i];if(!b)continue;b.first=false;b.seal=false;b.closed=true;}}return;}
  if(op==='cancel'){fatal(r,'cancelled');return;}
  if(op==='reclaim'){need(r.state!=='active'&&r.frames===1,'early_reclaim');for(let i=0;i<2;i++)need(!r.bodies[i].borrow&&!r.bodies[i].transport,'early_reclaim');
   for(let i=0;i<2;i++){const b=r.bodies[i];need(b.buffer,'buffer');if(!b.zeroed)apply(fill,b.buffer,[0]);for(let j=0;j<3072;j++)need(b.buffer[j]===0,'zero');if(!b.zeroed)zeroed+=3072;b.zeroed=true;
    /* HB2_CLEANUP_FENCE */
   }
   for(let i=0;i<2;i++){const b=r.bodies[i];for(let j=0;j<48;j++)b.refs[j]=null;b.buffer=undefined;}r.ready=true;return;
  }
  need(false,'operation');
 }catch(e){if(!completion)fatal(r,'operation');throw e;}
 finally{r.frames--;active=undefined;busy=false;admission.finish(r.ticket);activeTicket=-1;if(r.ready&&r.frames===0)release(r);}
}
const api=create(null);
function operation(name,fn){setPrototype(fn,null);freeze(fn);define(api,name,{value:fn,enumerable:true});}
operation('beginRead',actor=>begin(actor));
operation('openAttempt',h=>run('openAttempt',h));operation('window',(h,w)=>run('window',h,w));
operation('beginBorrow',(h,w)=>run('beginBorrow',h,w));operation('endBorrow',(h,w)=>run('endBorrow',h,w));
operation('beginTransport',(h,w)=>run('beginTransport',h,w));operation('endTransport',(h,w)=>run('endTransport',h,w));
operation('publish',(h,w)=>run('publish',h,w));operation('closeWindow',(h,w)=>run('closeWindow',h,w));
operation('closeRead',h=>run('closeRead',h));operation('cancel',h=>run('cancel',h));operation('reclaim',h=>run('reclaim',h));
export const reader=freeze(api);
