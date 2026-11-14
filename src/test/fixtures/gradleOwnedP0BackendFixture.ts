/** Same-process synthetic service owners. Their signatures do not prove separate UID or real quotas. */
import {generateKeyPairSync,sign,type KeyObject} from 'node:crypto';
import {canonicalOwnedJson as canonical,ownedDigest as digest} from '../../utils/gradleOwnedJson.js';
import {P0MetadataServer,connectP0Backend,type P0BackendAPI,type P0BackendOptions,type P0BackendConfig} from '../../utils/gradleOwnedP0Backend.js';
import {p0Fixture} from './gradleOwnedP0Fixture.js';
export function p0BackendFixture(){
 const f=p0Fixture(),names=['client','registry','custodian','controller'] as const;
 const keys=Object.fromEntries(names.map(n=>[n,generateKeyPairSync('ed25519')])) as Record<typeof names[number],{publicKey:KeyObject;privateKey:KeyObject}>;
 const pub=(n:typeof names[number])=>keys[n].publicKey.export({format:'der',type:'spki'}).toString('base64');
 const ownerIndices={client:0,registry:6,custodian:1,controller:4} as const;
 for(const n of names)f.trust.roles[ownerIndices[n]]!.spki=pub(n);
 const peer=(n:'registry'|'custodian'|'controller')=>({principal:f.trust.roles[ownerIndices[n]]!.principal,keyId:f.trust.roles[ownerIndices[n]]!.keyId,spki:pub(n),boot:digest('boot-'+n),socket:'/tmp/p0-'+n+'.sock'});
 const config:P0BackendConfig={schema:'cwc.e2-p0.backend-config.v1',scope:'metadata-only',client:{principal:f.trust.roles[0]!.principal,keyId:f.trust.roles[0]!.keyId,spki:pub('client')},peers:{registry:peer('registry'),custodian:peer('custodian'),controller:peer('controller')}};
 const resignPreflight=()=>{f.preflight.signature=sign(null,Buffer.from(canonical(f.preflight.payload)),keys.controller.privateKey).toString('base64');};resignPreflight();
 const calls:P0BackendAPI[]=[];const requests:Buffer[]=[];let unavailable:P0BackendAPI|null=null;
 let onLookup:((api:P0BackendAPI)=>void)|null=null;
 const lookup=async(api:P0BackendAPI)=>{
  calls.push(api);onLookup?.(api);if(api===unavailable)return {status:'unavailable' as const,reason:'evidence-unavailable' as const};
  const value=api==='ReadPins'?f.trust:api==='ReadAcquisition'?{lock:f.lock,method:f.packet.method,environment:f.packet.environment}:api==='ReadLive'?f.live:{preflight:f.preflight};
  return {status:'available' as const,wire:JSON.stringify(value)};
 };
 const servers={registry:new P0MetadataServer(config,'registry',keys.registry.privateKey,lookup),custodian:new P0MetadataServer(config,'custodian',keys.custodian.privateKey,lookup),controller:new P0MetadataServer(config,'controller',keys.controller.privateKey,lookup)};
 const exchange:NonNullable<P0BackendOptions['exchange']>=async(path,wire)=>{requests.push(Buffer.from(wire));const role=(['registry','custodian','controller'] as const).find(r=>config.peers[r].socket===path);if(!role)throw Error('unknown-fixture-endpoint');return servers[role].respond(wire);};
 return {f,keys,config,servers,calls,requests,exchange,resignPreflight,jobDigest:digest(f.trust.job),
  setUnavailable:(api:P0BackendAPI)=>{unavailable=api;},onLookup:(fn:(api:P0BackendAPI)=>void)=>{onLookup=fn;},
  connect:(options:P0BackendOptions={})=>connectP0Backend(JSON.stringify(config),keys.client.privateKey,{exchange,...options})};
}
