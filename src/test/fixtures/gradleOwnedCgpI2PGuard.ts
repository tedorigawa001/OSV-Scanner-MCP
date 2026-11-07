/** I2 planner experiment fork; original I0 behavior remains the baseline. */
import {i0Intent,i0DispatchIntent,type I0Authorized} from './gradleOwnedCgpI2PAuthority.js';
import {i0Manifest,i0Need,i0Same,type I0ManifestHandle} from './gradleOwnedCgpI0Schema.js';
import {canonicalOwnedJson} from '../../utils/gradleOwnedJson.js';
type Options={manifest:I0ManifestHandle;owner:unknown;side:'client'|'server';clockDomain:string;now:()=>number};
type Row={d:string;originalDeadline:number;remaining:number;wireBytes:number;workUnits:number;state:string;attempt:number};
const leases=new WeakMap<object,{guard:I0IntentGuard;key:string;attempt:number;deadline:number;intent:I0Authorized}>();
export class I0IntentGuard {
 readonly #rows=new Map<string,Row>();#last=0;readonly #policy;readonly #options:Options;constructor(options:Options){this.#options={...options,owner:structuredClone(options.owner)};this.#policy=i0Manifest(options.manifest).guard;}
 #now(){const n=this.#options.now();i0Need(Number.isSafeInteger(n)&&n>=this.#last,'clock_invalid');this.#last=n;return n;}
 get diagnostics(){return {entries:this.#rows.size,records:structuredClone([...this.#rows.values()])};}
 begin(intent:I0Authorized,reservation:{deadline:number;requests:number;wireBytes:number;workUnits:number}){
  const f=i0DispatchIntent(intent),n=this.#now();i0Need(f.manifest===this.#options.manifest&&f.clockDomain===this.#options.clockDomain&&i0Same(this.#options.owner,this.#options.side==='server'?f.server:f.peer),'guard_context_invalid');
  i0Need(Object.keys(reservation).sort().join(',')==='deadline,requests,wireBytes,workUnits'&&Object.values(reservation).every(v=>Number.isSafeInteger(v)&&v>0)&&reservation.requests<=2,'reservation_invalid');
  let row=this.#rows.get(f.k);if(row){i0Need(row.d===f.d,'intent_conflict');i0Need(row.state==='complete','operation_busy');}
  else {row={d:f.d,originalDeadline:Math.min(reservation.deadline,f.sessionDeadline,n+4500),remaining:reservation.requests,wireBytes:reservation.wireBytes,workUnits:reservation.workUnits,state:'complete',attempt:0};
   i0Need(n<row.originalDeadline,'deadline_exceeded');i0Need(this.#rows.size<this.#policy.maxSlots,'slot_budget');
   i0Need(Buffer.byteLength(canonicalOwnedJson([...this.#rows.entries(),[f.k,{...row,state:'complete',originalDeadline:Number.MAX_SAFE_INTEGER,attempt:Number.MAX_SAFE_INTEGER,remaining:Number.MAX_SAFE_INTEGER,wireBytes:Number.MAX_SAFE_INTEGER,workUnits:Number.MAX_SAFE_INTEGER}]]))<=this.#policy.maxSerializedBytes,'serialized_budget');this.#rows.set(f.k,row);}
  i0Need(n<Math.min(row.originalDeadline,f.sessionDeadline),'deadline_exceeded');const work=Buffer.byteLength(canonicalOwnedJson(f.command));i0Need(row.remaining>0&&row.wireBytes>=81920&&row.workUnits>=work,'operation_budget');
  row.remaining--;row.wireBytes-=81920;row.workUnits-=work;row.state='pending';row.attempt++;
  const lease=Object.freeze({kind:'cgp-i0-lease'});leases.set(lease,{guard:this,key:f.k,attempt:row.attempt,deadline:Math.min(row.originalDeadline,f.sessionDeadline),intent});return lease;
 }
 #row(lease:object){const l=leases.get(lease);i0Need(l&&l.guard===this,'lease_invalid');const row=this.#rows.get(l.key)!;i0Need(row.attempt===l.attempt,'lease_stale');if(this.#now()>=l.deadline){row.state='retired';throw Error('cgp_i0_deadline_exceeded');}return row;}
 /** Adopting a result needs current authorization; on refusal the attempt stays pending and unknown() can still record it. */
 complete(lease:object){const row=this.#row(lease);i0Intent(leases.get(lease)!.intent);i0Need(row.state==='pending','lease_state');row.state='complete';}
 unknown(lease:object){const row=this.#row(lease);i0Need(row.state==='pending','lease_state');row.state='unknown';}
 ended(lease:object){const row=this.#row(lease);i0Need(row.state==='unknown','lease_state');row.state='complete';}
 retire(lease:object){this.#row(lease).state='retired';}
}
