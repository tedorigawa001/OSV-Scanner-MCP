/** Test-only same-UID anchor port. Disk persistence is NOT independent rollback protection. */
import {sign,type KeyObject} from 'node:crypto';
import {OwnedJournalDisk,type OwnedJournalDiskOptions} from '../../utils/gradleOwnedStoreDisk.js';
import {canonicalOwnedJson as canonical,parseOwnedJson} from '../../utils/gradleOwnedJson.js';
import {pb1ProposalSchema,pb1StreamSchema,pb1Genesis,pb1Same,PB1_LIMITS,type PB1AnchorPort,type PB1AnchorPin,type PB1Proposal} from '../../utils/gradleOwnedP1Contract.js';
export class PB1DiskAnchorFixture implements PB1AnchorPort {
 readonly #disk:OwnedJournalDisk;readonly #key:KeyObject;readonly pin:PB1AnchorPin;
 casCalls=0;queryCalls=0;headCalls=0;fault?:()=>void|Promise<void>;
 private constructor(disk:OwnedJournalDisk,key:KeyObject,pin:PB1AnchorPin){this.#disk=disk;this.#key=key;this.pin=pin;}
 static async open(o:OwnedJournalDiskOptions,key:KeyObject,pin:PB1AnchorPin){return new PB1DiskAnchorFixture(await OwnedJournalDisk.open(o),key,pin);}
 signed(value:unknown){const body={schema:'cwc.e2-p0.pb1-anchor-signed.v1',anchorId:this.pin.anchorId,keyId:this.pin.keyId,value};return canonical({...body,signature:sign(null,Buffer.from(canonical(body)),this.#key).toString('base64')},PB1_LIMITS.anchorWire);}
 async #entries(){await this.#disk.assertNoPendingTail();return (await this.#disk.journal.readHistory()).map(r=>pb1ProposalSchema.parse(parseOwnedJson(r.records.find(x=>x.role==='operation-result')!.bytes.toString())));}
 async head(streamWire:string,challenge:string){this.headCalls++;const stream=pb1StreamSchema.parse(parseOwnedJson(streamWire)),all=await this.#entries();if(all.some(p=>!pb1Same(p.stream,stream)))throw Error('anchor_stream');return this.signed({kind:'head',stream,challenge,head:all.at(-1)?.head??pb1Genesis(stream)});}
 async query(streamWire:string,transactionKey:string,challenge:string){this.queryCalls++;const stream=pb1StreamSchema.parse(parseOwnedJson(streamWire)),p=(await this.#entries()).find(p=>p.transactionKey===transactionKey&&pb1Same(p.stream,stream));return this.signed({kind:'origin',stream,challenge,transactionKey,receiptWire:p?this.signed({kind:'receipt',proposal:p}):null});}
 async compareAndSwap(proposalWire:string){
  this.casCalls++;const p=pb1ProposalSchema.parse(parseOwnedJson(proposalWire)),all=await this.#entries(),prior=all.find(e=>e.transactionKey===p.transactionKey);
  if(prior){if(!pb1Same(prior,p))throw Error('anchor_conflict');return this.signed({kind:'receipt',proposal:prior});}
  if(all.some(e=>!pb1Same(e.stream,p.stream))||!pb1Same(p.previousHead,all.at(-1)?.head??pb1Genesis(p.stream))||p.head.revision!==p.previousHead.revision+1)throw Error('anchor_cas');
  const roles=['session-manifest','session-index','event-ledger','operation-result'] as const;
  await this.#disk.journal.commit({operationId:p.transactionKey,requestDigest:p.intentDigest,records:roles.map((role,i)=>({role,id:String(i),bytes:Buffer.from(canonical(i===3?p:{profile:p.profileDigest,stage:p.transactionKey}))}))});
  await this.fault?.();return this.signed({kind:'receipt',proposal:p});
 }
 async entries():Promise<PB1Proposal[]>{return this.#entries();}
 close(){this.#disk.close();}
}
