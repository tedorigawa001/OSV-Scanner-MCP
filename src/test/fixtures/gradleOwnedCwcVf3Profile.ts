/** Optional call-through observer. Async handshake spans are contained observations,
 * never added to the exclusive synchronous partition or subtracted from total time. */
import {vi} from 'vitest';
import * as json from '../../utils/gradleOwnedJson.js';
import * as session from './gradleOwnedCprBSession.js';
import {CwcLb0Session,CwcLb1Binding} from './gradleOwnedCwcLb0.js';
import {Vf3Link} from './gradleOwnedCwcVf3Link.js';
import {CwcAContract} from './gradleOwnedCwcA.js';
import {CwcCReadScope} from './gradleOwnedCwcC.js';
export type Vf3Observation='quiet'|'counts'|'timed';
export const VF3_OPERATIONS=['construction','control.prepareChallenge','control.receive','control.connected','control.dispatchConnected','binding.providerGate','binding.scopeGate','link.request','link.dispatch.entry','link.reply.entry','scope.load','root.open','fact.encode','fact.prove','endpoint.openPeer','endpoint.gate','endpoint.now','endpoint.permitAPI','json.canonicalOwnedJson','json.ownedDigest','json.ownedSha256','json.structuredClone'] as const;
type Bucket={calls:number;inclusiveMs:number;exclusiveMs:number};
export type Vf3Trace={mode:Exclude<Vf3Observation,'quiet'>;start:number;end:number;wallMs:number;otherMs:number;entries:Record<string,number>;buckets:Record<string,Bucket>;handshakes:{id:number;kind:string;start:number;end:number}[]};
export interface Vf3Observer{sync<T>(name:string,run:()=>T):T;around<T>(name:'handshake.open'|'handshake.exchange',run:()=>Promise<T>):Promise<T>;finish():Vf3Trace;close():void}
let installed=false;
export function installVf3Observer(mode:Exclude<Vf3Observation,'quiet'>):Vf3Observer{
 if(installed)throw Error('vf3_observer_busy');installed=true;const restores:(()=>void)[]=[],timed=mode==='timed',entries:Record<string,number>={},buckets:Record<string,Bucket>={},handshakes:Vf3Trace['handshakes']=[];
 let active=true,closed=false;const stack:{child:number}[]=[],start=performance.now();
 function sync<T>(name:string,run:()=>T):T{if(!active)return run();entries[name]=(entries[name]??0)+1;const frame={child:0},at=timed?performance.now():0;stack.push(frame);try{return run();}finally{const elapsed=timed?performance.now()-at:0;stack.pop();const b=buckets[name]??={calls:0,inclusiveMs:0,exclusiveMs:0};b.calls++;b.inclusiveMs+=elapsed;b.exclusiveMs+=elapsed-frame.child;if(stack.length)stack.at(-1)!.child+=elapsed;}}
 function method(target:any,key:string,name:string){const d=Object.getOwnPropertyDescriptor(target,key);if(typeof d?.value!=='function')throw Error('vf3_observer_method');Object.defineProperty(target,key,{...d,value:function(this:unknown,...args:unknown[]){return sync(name,()=>Reflect.apply(d.value,this,args));}});restores.push(()=>Object.defineProperty(target,key,d));}
 try{
  for(const n of ['prepareChallenge','receive','connected','dispatchConnected'])method(CwcLb0Session.prototype,n,'control.'+n);
  for(const n of ['providerGate','scopeGate'])method(CwcLb1Binding.prototype,n,'binding.'+n);
  for(const [n,label]of [['request','link.request'],['dispatch','link.dispatch.entry'],['reply','link.reply.entry']])method(Vf3Link.prototype,n!,label!);
  method(CwcCReadScope.prototype,'load','scope.load');
  for(const [n,label]of [['openCodecRoot','root.open'],['encodeCheckedCommand','fact.encode'],['provePlannedOwnerAndAuth','fact.prove']])method(CwcAContract.prototype,n!,label!);
  method(session.SessionServer.prototype,'openPeer','endpoint.openPeer');const endpoint=Object.getPrototypeOf(session.SessionServer.prototype);for(const n of ['gate','now','permitAPI'])method(endpoint,n,'endpoint.'+n);
  for(const n of ['canonicalOwnedJson','ownedDigest','ownedSha256'] as const){const original=json[n],spy=vi.spyOn(json,n);spy.mockImplementation(((...args:any[])=>{try{return sync('json.'+n,()=>Reflect.apply(original,json,args));}finally{spy.mockClear();}}) as any);restores.push(()=>spy.mockRestore());}
  const d=Object.getOwnPropertyDescriptor(globalThis,'structuredClone')!,clone=globalThis.structuredClone;Object.defineProperty(globalThis,'structuredClone',{...d,value:(...args:Parameters<typeof structuredClone>)=>sync('json.structuredClone',()=>clone(...args))});restores.push(()=>Object.defineProperty(globalThis,'structuredClone',d));
 }catch(error){for(const restore of restores.reverse())restore();installed=false;throw error;}
 return {sync,async around(kind,run){if(!active)return run();if(handshakes.length>=768)throw Error('vf3_handshake_capacity');const row={id:handshakes.length+1,kind,start:timed?performance.now():0,end:0};handshakes.push(row);try{return await run();}finally{row.end=timed?performance.now():0;}},finish(){if(!active||stack.length)throw Error('vf3_observer_state');active=false;const end=performance.now(),wallMs=end-start;return {mode,start,end,wallMs,otherMs:wallMs-Object.values(buckets).reduce((n,b)=>n+b.exclusiveMs,0),entries,buckets,handshakes};},close(){if(closed)return;active=false;closed=true;for(const restore of restores.reverse())restore();installed=false;}};
}
