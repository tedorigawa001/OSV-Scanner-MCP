/** Closed diagnostic owner. No external balance, subclass, virtual operation or parent-ledger claim. */
import {Lb0Budget} from './gradleOwnedCwcLb0Contract.js';
const prototype=Lb0Budget.prototype,descriptors=Object.getOwnPropertyDescriptors(prototype),names=Reflect.ownKeys(descriptors),owners=new WeakSet<Lb0Budget>();
const apply=Reflect.apply,getPrototype=Object.getPrototypeOf,descriptor=Object.getOwnPropertyDescriptor,keys=Reflect.ownKeys;
const check=prototype.check,reserve=prototype.reserve,release=prototype.release,stats=prototype.stats;
function need(v:unknown):asserts v{if(!v)throw Error('r1o_budget_binding');}
function unchanged(){
 need(getPrototype(prototype)===Object.prototype);const current=keys(prototype);need(current.length===names.length);
 for(const name of names){const a=descriptor(prototype,name),b=Reflect.get(descriptors,name);need(a&&'value'in a&&a.value===b.value&&a.writable===b.writable&&a.configurable===b.configurable&&a.enumerable===b.enumerable);}
}
function owner(b:Lb0Budget){need(owners.has(b)&&getPrototype(b)===prototype);}
export function createR1oBudget(memory=1048576,work=156978){unchanged();const b=new Lb0Budget(undefined,memory,work);owners.add(b);return b;}
export function requireR1oBudget(b:Lb0Budget){owner(b);unchanged();apply(check,b,[]);}
export function checkR1oBudget(b:Lb0Budget){requireR1oBudget(b);}
export function reserveR1oBudget(b:Lb0Budget){requireR1oBudget(b);return apply(reserve,b,[196608,4096,4096]) as ReturnType<Lb0Budget['reserve']>;}
// Cleanup and passive diagnostics use captured implementations even after a prototype change has closed the call.
// The factory owns the actual balance, so stats cannot encounter caller-added accessor properties.
export function releaseR1oBudget(b:Lb0Budget,t:ReturnType<Lb0Budget['reserve']>){owner(b);apply(release,b,[t]);}
export function statsR1oBudget(b:Lb0Budget):ReturnType<Lb0Budget['stats']>{owner(b);return apply(stats,b,[]);}
