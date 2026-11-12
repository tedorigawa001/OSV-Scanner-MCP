/** Intrinsic call observer for the unchanged canonical/hash implementation.
 * Counts are primitive quantities, not the production work-unit model. String
 * payload units describe logical values, not V8 heap bytes (ropes may share storage).
 */
import {createHash} from 'node:crypto';
import {co0bPrimitiveModel} from './gradleOwnedCwcCo0bModel.mjs';
const names=['keyArrays','keyEntries','mapArrays','mapItems','joins','joinInputUnits','joinOutputUnits','stringifies','stringifyUnits','charReads','hashUpdates','hashInputBytes'] as const;
export const emptyCo0bWork=()=>Object.fromEntries(names.map(k=>[k,0])) as Record<typeof names[number],number>;
type Position={phase:string;actor:number;ordinal:number};
type Scratch={parts:number;partUnits:number;joinedUnits:number;logicalUnits:number};
type PrimitiveRow={seq:number;kind:string;phase:string;actor:number;ordinal:number;work:ReturnType<typeof emptyCo0bWork>;outputUnits:number;outputBytes:number;digest:string;scratch:Scratch|null;hashInputDigest:string|null;model:ReturnType<typeof co0bPrimitiveModel>};
export class Co0bPrimitives {
 readonly rows:PrimitiveRow[]=[];
 readonly #restore:(()=>void)[]=[];#paused=0;#root:typeof this.rows[number]|undefined;
 directCharReads=0;
 constructor(readonly position:()=>Position,enabled=true){
  if(!enabled)return;
  const hook=(target:object,key:string,wrap:(original:any)=>any)=>{const d=Object.getOwnPropertyDescriptor(target,key)!;Object.defineProperty(target,key,{...d,value:wrap(d.value)});this.#restore.push(()=>Object.defineProperty(target,key,d));};
  const self=this,record=(fn:(r:PrimitiveRow)=>void)=>{if(!self.#root||self.#paused)return;self.ignore(()=>fn(self.#root!));};
  hook(Object,'keys',orig=>function(v:object){const out=Reflect.apply(orig,Object,[v]) as string[];record(r=>{r.work.keyArrays++;r.work.keyEntries+=out.length;});return out;});
  hook(Array.prototype,'map',orig=>function(this:any[],...args:any[]){const out=Reflect.apply(orig,this,args);record(r=>{r.work.mapArrays++;r.work.mapItems+=this.length;});return out;});
  hook(Array.prototype,'join',orig=>function(this:any[],...args:any[]){const out=Reflect.apply(orig,this,args) as string;record(r=>{
   let units=0;for(let i=0;i<this.length;i++){if(typeof this[i]!=='string')throw Error('co0b_join_type');units+=this[i].length;}
   r.work.joins++;r.work.joinInputUnits+=units;r.work.joinOutputUnits+=out.length;
   const s={parts:this.length,partUnits:units,joinedUnits:out.length,logicalUnits:units+out.length};if(!r.scratch||s.logicalUnits>r.scratch.logicalUnits)r.scratch=s;
  });return out;});
  hook(JSON,'stringify',orig=>function(...args:any[]){const out=Reflect.apply(orig,JSON,args) as string;record(r=>{r.work.stringifies++;r.work.stringifyUnits+=out.length;});return out;});
  hook(String.prototype,'charCodeAt',orig=>function(this:string,...args:any[]){const out=Reflect.apply(orig,this,args);
   if(self.#root)record(r=>{r.work.charReads++;});else if(!self.#paused&&self.position().phase==='compare')self.directCharReads++;return out;});
  const proto=Object.getPrototypeOf(createHash('sha256'));
  hook(proto,'update',orig=>function(this:unknown,...args:any[]){record(r=>{r.work.hashUpdates++;r.work.hashInputBytes+=typeof args[0]==='string'?Buffer.byteLength(args[0],args[1]):args[0].byteLength;
   if(r.hashInputDigest!==null)throw Error('co0b_hash_multipart');r.hashInputDigest=createHash('sha256').update(args[0],args[1]).digest('hex');});return Reflect.apply(orig,this,args);});
 }
 ignore<T>(fn:()=>T):T{this.#paused++;try{return fn();}finally{this.#paused--;}}
 run<T extends string>(kind:string,input:unknown,fn:()=>T):T{
  if(this.#paused)return fn();if(this.#root)throw Error('co0b_nested_root');if(this.rows.length>=4096)throw Error('co0b_diagnostic_limit');
  const row=this.ignore(()=>({seq:this.rows.length,kind,...this.position(),work:emptyCo0bWork(),outputUnits:0,outputBytes:0,digest:'',scratch:null as Scratch|null,hashInputDigest:null as string|null,model:co0bPrimitiveModel(input,kind)}));this.#root=row;
  try{const value=fn();this.ignore(()=>{row.outputUnits=value.length;row.outputBytes=Buffer.byteLength(value);row.digest=createHash('sha256').update(value).digest('hex');});return value;}
  finally{this.#root=undefined;this.rows.push(row);}
 }
 summary(){return this.ignore(()=>{const work=emptyCo0bWork();let hashes=0,canonicalRoots=0;for(const r of this.rows){for(const k of names)work[k]+=r.work[k];if(r.kind==='hash')hashes++;else canonicalRoots++;}
  return {...work,canonicalRoots,hashes,directCharReads:this.directCharReads};});}
 close(){for(const undo of this.#restore.reverse())undo();this.#restore.length=0;}
}
