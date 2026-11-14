/** Pure bounded-debit helper artifact. No observer, issuer/reset, clock mutation or raw-cell return. */
const freeze=Object.freeze,create=Object.create,define=Object.defineProperty,setPrototype=Object.setPrototypeOf,isSafe=Number.isSafeInteger;
const integer=n=>typeof n==='number'&&isSafe(n)&&n>=0;
export function makeHb2Admission(cell,owner,ordinal){
 function refuse(reason){if(cell.denials<64){cell.denials++;if(cell.denials===64)cell.stopped=true;}throw reason;}
 function row(ticket){if(!integer(ticket)||ticket>=cell.issued)refuse('hb2_ticket');const r=cell.rows[ticket];if(!r.issued||r.owner!==owner||r.ordinal!==ordinal)refuse('hb2_ticket');return r;}
 function begin(){if(cell.stopped)throw 'hb2_dispatch_stopped';if(cell.active>=4)refuse('hb2_global_capacity');if(cell.issued>=64)refuse('hb2_epoch_budget');const ticket=cell.issued++,r=cell.rows[ticket];r.owner=owner;r.ordinal=ordinal;r.issued=true;r.open=true;r.ordinary=1;cell.active++;cell.ordinary++;return ticket;}
 function enter(ticket,cleanup){const r=row(ticket);if(r.open||r.drained||r.quarantined)refuse('hb2_entry_state');if(cleanup){if(r.cleanup>=16){r.quarantined=true;refuse('hb2_cleanup_budget');}r.cleanup++;cell.cleanup++;}else{if(cell.stopped)throw 'hb2_dispatch_stopped';if(r.ordinary>=240)refuse('hb2_entry_budget');r.ordinary++;cell.ordinary++;}r.open=true;r.errorInEntry=false;}
 function error(ticket){const r=row(ticket);if(!r.open||r.errorInEntry)refuse('hb2_error_state');r.errorInEntry=true;r.errors++;cell.errors++;}
 function payload(ticket,bytes){const r=row(ticket);if(!r.open||bytes!==3072||r.payload>=6144)refuse('hb2_payload_state');r.payload+=bytes;cell.payloadDebt+=bytes;}
 function finish(ticket){const r=row(ticket);if(!r.open)refuse('hb2_entry_state');r.open=false;}
 function quarantine(ticket){const r=row(ticket);r.quarantined=true;}
 function release(ticket){const r=row(ticket);if(r.open||r.drained||r.quarantined)refuse('hb2_release_state');r.drained=true;cell.active--;}
 const port=create(null),names=['refuse','begin','enter','error','payload','finish','quarantine','release'],functions=[reason=>refuse(reason),()=>begin(),(t,c)=>enter(t,c),t=>error(t),(t,n)=>payload(t,n),t=>finish(t),t=>quarantine(t),t=>release(t)];
 for(let i=0;i<8;i++){const fn=functions[i];setPrototype(fn,null);freeze(fn);define(port,names[i],{value:fn,enumerable:true});}return freeze(port);
}
