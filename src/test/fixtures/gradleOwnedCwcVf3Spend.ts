/** Common, call-through numeric witness. It neither reserves work nor decides authorization.
 * Installed inside T_total in all four arms, restored after the actual continuation drains. */
import {CwcCWorkLedger} from './gradleOwnedCwcC.js';
import {CwcLb1Binding} from './gradleOwnedCwcLb0.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
let installed=false;
type Receipt={schema:'cwc-vf3.source-spend.v1';operationKey:string;wireReceived:boolean;planFloor:number|null;finished:boolean};
const branded=new WeakSet<object>();
export class Vf3SpendWitness {
 #active?:Receipt;#closed=false;readonly #restore:()=>void;
 constructor(){
  need(!installed,'operation_busy');installed=true;
  const reserve=Object.getOwnPropertyDescriptor(CwcCWorkLedger.prototype,'reserve')!,accept=Object.getOwnPropertyDescriptor(CwcLb1Binding,'accept')!,self=this;
  Object.defineProperty(CwcLb1Binding,'accept',{...accept,value:function(...args:any[]){const result=Reflect.apply(accept.value,this,args);if(self.#active)self.#active.wireReceived=true;return result;}});
  Object.defineProperty(CwcCWorkLedger.prototype,'reserve',{...reserve,value:function(this:CwcCWorkLedger,...args:Parameters<CwcCWorkLedger['reserve']>){
   if(!self.#active||args[1]!=='provider')return Reflect.apply(reserve.value,this,args);
   const ledger=this,check=Object.getOwnPropertyDescriptor(CwcCWorkLedger.prototype,'check')!;
   // No callback occurs between the balance debit and check(floor). Observe the floor
   // before the original check can reject; a missing returned ticket never refunds it.
   Object.defineProperty(CwcCWorkLedger.prototype,'check',{...check,value:function(this:CwcCWorkLedger,...xs:Parameters<CwcCWorkLedger['check']>){if(this===ledger&&xs[0]!==undefined&&xs[0]>0){need(self.#active&&self.#active.planFloor===null,'source_binding');self.#active.planFloor=xs[0];}return Reflect.apply(check.value,this,xs);}});
   try{return Reflect.apply(reserve.value,this,args);}finally{Object.defineProperty(CwcCWorkLedger.prototype,'check',check);}
  }});
  this.#restore=()=>{Object.defineProperty(CwcCWorkLedger.prototype,'reserve',reserve);Object.defineProperty(CwcLb1Binding,'accept',accept);};branded.add(this);Object.freeze(this);
 }
 static require(value:Vf3SpendWitness){need(branded.has(value)&&!value.#closed,'source_binding');}
 begin(operationKey:string){Vf3SpendWitness.require(this);need(!this.#active&&/^[a-f0-9]{64}$/.test(operationKey),'source_binding');this.#active={schema:'cwc-vf3.source-spend.v1',operationKey,wireReceived:false,planFloor:null,finished:false};}
 finish(){Vf3SpendWitness.require(this);need(this.#active&&!this.#active.finished,'source_binding');this.#active.finished=true;}
 end(operationKey:string){Vf3SpendWitness.require(this);need(this.#active?.operationKey===operationKey,'source_binding');const out={...this.#active};this.#active=undefined;return out;}
 close(){if(this.#closed)return;this.#closed=true;this.#restore();this.#active=undefined;installed=false;}
}
