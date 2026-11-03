/** Application-owned semantic client. Transport authentication belongs to the injected endpoint.
 * No principals, default transport, independent-registry admission or read skipping. */
import {randomBytes} from 'node:crypto';
import {canonicalOwnedJson} from './gradleOwnedJson.js';
import {apiPolicy,currentBindingSchema,replySchema,responseValues,payloadSchemas,parsed,need,type CurrentAPI,type CurrentBinding,type CurrentRole} from './gradleOwnedCurrentSchema.js';
export interface OwnedCurrentTransport {
 assertOpen():void;
 context():Promise<unknown>;
 /** Same operationId must preserve the original intent/transport retry binding. */
 call(role:CurrentRole,api:CurrentAPI,payload:unknown,operationId:string):Promise<unknown>;
}
export const currentOperation=()=>randomBytes(32).toString('hex');
export class OwnedCurrentClient {
 readonly #transport:OwnedCurrentTransport;readonly #expected:Readonly<Record<string,string|number>>;
 constructor(transport:OwnedCurrentTransport,expected:Record<string,string|number>){this.#transport=transport;this.#expected=Object.freeze({...expected});need(['authorityId','lineageId','storeEpoch','generation','profileDigest'].every(k=>Object.hasOwn(expected,k)),'configuration_invalid');}
 assertOpen(){this.#transport.assertOpen();}
 async context():Promise<CurrentBinding>{this.assertOpen();const value=parsed(currentBindingSchema,await this.#transport.context());this.assertOpen();for(const [key,v]of Object.entries(this.#expected))need((value as any)[key]===v,'binding_mismatch');return value;}
 async call(role:CurrentRole,api:CurrentAPI,payload:unknown,operationId=currentOperation(),historical=false){
  this.assertOpen();need(apiPolicy[api].roles.includes(role),'permission_denied');const input=parsed(payloadSchemas[api],JSON.parse(canonicalOwnedJson(payload))),reply=parsed(replySchema,await this.#transport.call(role,api,input,operationId));this.assertOpen();
  need(reply.api===api&&reply.destination===apiPolicy[api].destination,'binding_mismatch');const value=parsed(responseValues[api],reply.value);
  need(reply.resolutionMode==='applied'||(['AcquireReadPin','ReserveWriter'].includes(api)&&reply.resolutionMode==='existing-live-confirmed')||(historical&&reply.resolutionMode==='committed-historical'),'historical_only');
  return {...reply,value};
 }
}
