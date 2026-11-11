/** VF-1 opt-in owner. Fixed clock/single authority; no SessionServer/storage/native admission. */
import {Vf0Authority,Vf0Clock,assertAuthority,stampAuthority,authorityView,authorityReason,sameAuthorityStamp,readOwnedClock,ownedClockKind,type VfAuthorityStamp} from './gradleOwnedCwcVf0Authority.js';
import {copyData,freezeData} from './gradleOwnedCwcLb0Contract.js';
import {need} from '../../utils/gradleOwnedCurrentSchema.js';
import {Vf1Approval} from './gradleOwnedCwcVf1Approval.js';
import type {Lb0Environment} from './gradleOwnedCwcLb0.js';
export const VF1_POLICY=Object.freeze({profile:'cwc.session-private-verification-facts.v1',stage:'VF-1-provider-scope',modes:['full-verify','fact-live'],memory:1048576,work:156978,callBytes:98304,bindingBytes:8192,metadataBytes:4096,maxChecks:4096,authorityOwners:1,fixedClock:true,actualSession:false});
const owners=new WeakSet<object>();
export const VF1_REAL_POLICY=Object.freeze({...VF1_POLICY,profile:'cwc.session-private-verification-facts.monotonic.v1',stage:'VF-3-real-session-comparison',fixedClock:false,actualSession:true});
export class Vf1Owner {
 readonly environment:Lb0Environment;readonly #authority:Vf0Authority;readonly #clock:Vf0Clock;readonly #approval:Vf1Approval;readonly #hook:(site:string)=>void;
 readonly mode:'full-verify'|'fact-live';readonly #registryPin:string;readonly #approvalPin:string;
 #open=true;#counts:Record<string,number>={};
 constructor(o:{mode:'full-verify'|'fact-live';authority:Vf0Authority;clock:Vf0Clock;approval:Vf1Approval;approvalPin:string;registryPin:string;hook?:(site:string)=>void}){
  assertAuthority(o.authority);readOwnedClock(o.clock);Vf1Approval.require(o.approval);o.approval.assertPin(o.approvalPin);need(ownedClockKind(o.clock)===o.approval.clockKind,'codec_profile_unsupported');need(VF1_POLICY.modes.includes(o.mode),'codec_profile_unsupported');
  this.mode=o.mode;this.#authority=o.authority;this.#clock=o.clock;this.#approval=o.approval;this.#approvalPin=o.approvalPin;this.#registryPin=o.registryPin;this.#hook=o.hook??(()=>{});
  this.environment=Object.freeze({now:()=>{this.#foreign('now');return readOwnedClock(this.#clock);},assertOpen:()=>{this.#foreign('open');this.current();},credentialCurrent:(identity)=>{this.#foreign('credential-'+identity.role);const v=authorityView(this.#authority);return identity.role==='provider'?v.server&&v.serverKeyEpoch===identity.keyEpoch:v.peer&&v.peerKeyEpoch===identity.keyEpoch;},purpose:()=>{this.#foreign('purpose');return authorityView(this.#authority).purpose;},permissions:()=>{this.#foreign('permissions');return copyData(authorityView(this.#authority).permissions,32768);}});
  owners.add(this);this.current();Object.freeze(this);
 }
 static requireTransport(value:Vf1Owner,authority:Vf0Authority,clock:Vf0Clock,registryPin:string){need(owners.has(value)&&value.#authority===authority&&value.#clock===clock&&value.#registryPin===registryPin,'codec_profile_unsupported');value.current();}
 static require(value:Vf1Owner,environment:Lb0Environment,registryPin:string){need(owners.has(value)&&value.environment===environment&&value.#registryPin===registryPin,'codec_profile_unsupported');value.current();}
 #foreign(site:string){const before=this.stamp();this.#counts[site]=(this.#counts[site]??0)+1;this.#hook(site);need(sameAuthorityStamp(before,this.stamp()),authorityReason(this.#authority));}
 stamp(){return stampAuthority(this.#authority);}
 current(){need(this.#open,'owner_closed');Vf1Approval.require(this.#approval);const v=authorityView(this.#authority);need(v.registryPin===this.#registryPin&&v.sourcePin===this.#approvalPin&&v.profilePin===this.#approvalPin,'codec_profile_unsupported');need(v.callbackPolicy===0,'policy_changed');}
 assertStamp(before:VfAuthorityStamp){this.current();need(sameAuthorityStamp(before,this.stamp()),authorityReason(this.#authority));}
 check(before:VfAuthorityStamp,deadline:number){this.assertStamp(before);need(readOwnedClock(this.#clock)<deadline,'request_expired');}
 snapshot(){return freezeData(copyData(this.#counts));}
 cancel(){this.#open=false;}
}
