/** R0 command path: packed owned cores, fixed sinks, no full command/preimage object.
 * Native hash and descriptor/control-object charge remain R1 proof obligations.
 */
import {read16,write16,read32,write32} from './gradleOwnedCwcR0Memory.js';
import {createHash,type Hash} from 'node:crypto';
import {R0Tokens} from './gradleOwnedCwcR0Tokens.js';
import {R0_CONTEXT} from './gradleOwnedCwcR0Grammar.js';
import {CPR_SPEC_DIGEST} from './gradleOwnedCprASchema.js';
const need=(v:unknown,r='schema')=>{if(!v)throw Error('r0_'+r);};
const copy=Buffer.prototype.copy,fill=Buffer.prototype.fill,subarray=Buffer.prototype.subarray;
const nativeCreateHash=createHash,hashPrototype=Object.getPrototypeOf(nativeCreateHash('sha256')),nativeUpdate=hashPrototype.update,nativeDigest=hashPrototype.digest;
export class R0Sink {
 #target?:Buffer;#offset=0;#limit=0;#count=0;#used=0;#hash?:Hash;#active=false;
 hashes=0;hashBytes=0;chunks=0;viewLive=0;viewPeak=0;targetLive=false;
 constructor(readonly chunk:Buffer,readonly gate:()=>void){need(chunk.length===4096,'chunk');Object.seal(this);}
 begin(target?:Buffer,offset=0,limit=65535){this.gate();need(!this.#active,'sink_reentry');this.#active=true;this.#target=target;this.targetLive=!!target;this.#offset=offset;this.#limit=limit;this.#count=0;this.#used=0;if(!target){this.#hash=nativeCreateHash('sha256');this.hashes++;}}
 byte(b:number){need(this.#active&&this.#count<this.#limit&&b>=0&&b<128,'writer_bound');
  if(this.#target){need(this.#offset+this.#count<this.#target.length,'writer_bound');this.#target[this.#offset+this.#count]=b;}
  else{this.chunk[this.#used++]=b;if(this.#used===4096)this.#flush();}this.#count++;}
 literal(s:string){for(let i=0;i<s.length;i++)this.byte(s.charCodeAt(i));}
 number(n:number){need(Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0));this.literal(String(n));}
 token(p:R0Tokens,t:number){need(t>=0,'missing');for(let i=0;i<p.length(t);i++)this.byte(p.byte(t,i));}
 quoted(b:Buffer,offset:number,length:number){this.byte(34);for(let i=0;i<length;i++){const n=b[offset+i]!;need(n>=32&&n<127&&n!==34&&n!==92);this.byte(n);}this.byte(34);}
 hex(b:Buffer,offset:number){this.byte(34);for(let i=0;i<32;i++){const n=b[offset+i]!;this.byte('0123456789abcdef'.charCodeAt(n>>>4));this.byte('0123456789abcdef'.charCodeAt(n&15));}this.byte(34);}
 #flush(){if(!this.#used)return;let view:Buffer|undefined;this.gate();try{view=Reflect.apply(subarray,this.chunk,[0,this.#used]);this.viewLive=1;this.viewPeak=1;Reflect.apply(nativeUpdate,this.#hash,[view]);this.hashBytes+=this.#used;this.chunks++;}
  finally{view=undefined;this.viewLive=0;this.#used=0;}this.gate();}
 end():number|string{need(this.#active,'sink_state');try{this.gate();if(this.#hash){this.#flush();const digest=Reflect.apply(nativeDigest,this.#hash,['hex']) as string;this.gate();return digest;}return this.#count;}
  finally{this.#target=undefined;this.targetLive=false;this.#hash=undefined;this.#active=false;this.#used=0;}}
 abort(){this.#target=undefined;this.targetLive=false;this.#hash=undefined;this.#active=false;this.#used=0;}
 get active(){return this.#active;}
}
export class R0Core {
 readonly tokens:R0Tokens;readonly rangeBase:number;
 constructor(readonly arena:Buffer,readonly K:number,contextBytes:Buffer,groups:any,seed:string,transfer:string){
  need(Number.isSafeInteger(K)&&K===contextBytes.length&&arena.length>=512+K+4096+76*64,'core_capacity');need(Array.isArray(groups)&&groups.length>=1&&groups.length<=19,'batch_count');
  need(typeof seed==='string'&&typeof transfer==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(seed)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(transfer),'cid');
  arena[0]=groups.length;write16(arena,contextBytes.length,2);arena[4]=seed.length;arena[5]=transfer.length;
  for(let i=0;i<seed.length;i++)arena[8+i]=seed.charCodeAt(i);for(let i=0;i<transfer.length;i++)arena[136+i]=transfer.charCodeAt(i);
  Reflect.apply(copy,contextBytes,[arena,512]);this.tokens=new R0Tokens(arena,256,512+K);this.tokens.parse(arena,contextBytes.length,R0_CONTEXT,512);this.rangeBase=512+K+4096;
  let at=0,total=0,entries=0,commits=0,payloads=0,payloadStarted=false,previous=-1;
  for(let g=0;g<groups.length;g++){const group=groups[g];need(Array.isArray(group)&&group.length>=1&&group.length<=4,'ranges');write16(arena,at,264+g*2);arena[302+g]=group.length;let used=0;
   for(let i=0;i<group.length;i++){
    const r=group[i];need(r&&r.entry&&Object.keys(r).sort().join(',')==='entry,index,kind,length,offset,ordinal'&&Object.keys(r.entry).sort().join(',')==='byteLength,sha256'&&r.ordinal===i&&['commit','payload'].includes(r.kind),'range');
    for(const [v,min,max]of [[r.index,0,8],[r.offset,0,41460],[r.length,1,4096],[r.entry.byteLength,1,41460]])need(Number.isSafeInteger(v)&&v>=min&&v<=max,'range');
    need(typeof r.entry.sha256==='string'&&/^[a-f0-9]{64}$/.test(r.entry.sha256)&&r.offset+r.length<=r.entry.byteLength,'range');
    need(at<76,'ranges');const a=this.rangeBase+at*64;arena[a]=r.kind==='commit'?0:1;arena[a+1]=r.index;arena[a+2]=r.ordinal;
    write32(arena,r.offset,a+4);write32(arena,r.length,a+8);write32(arena,r.entry.byteLength,a+12);
    for(let j=0;j<32;j++)arena[a+16+j]=Number.parseInt(r.entry.sha256.substring(j*2,j*2+2),16);
    if(previous>=0&&arena[previous]===arena[a]&&arena[previous+1]===arena[a+1]){
     need(r.offset===read32(arena,previous+4)+read32(arena,previous+8)&&r.entry.byteLength===read32(arena,previous+12),'coverage');for(let j=0;j<32;j++)need(arena[a+16+j]===arena[previous+16+j],'coverage');
    }else{if(previous>=0)need(read32(arena,previous+4)+read32(arena,previous+8)===read32(arena,previous+12),'coverage');need(r.offset===0,'coverage');
     if(r.kind==='commit'){need(!payloadStarted&&r.index===commits++,'coverage');}else{payloadStarted=true;need(r.index===payloads++,'coverage');}entries++;}
    total+=r.length;used+=r.length;previous=a;at++;
   }need(used<=4096,'range_budget');
  }
  need(previous>=0&&read32(arena,previous+4)+read32(arena,previous+8)===read32(arena,previous+12)&&commits>0&&payloads>=4&&entries<=9&&total<=41460,'coverage');arena[1]=at;Object.freeze(this);
 }
 get n(){return this.arena[0]!;}
 ctx(key:string){return this.tokens.field(0,key);}
 start(ordinal:number){need(ordinal>=0&&ordinal<this.n,'ordinal');return read16(this.arena,264+ordinal*2);}
 size(ordinal:number){this.start(ordinal);return this.arena[302+ordinal]!;}
 range(index:number){need(index>=0&&index<this.arena[1]!,'range');return this.rangeBase+index*64;}
 setDigest(hex:string){need(/^[a-f0-9]{64}$/.test(hex));for(let i=0;i<32;i++)this.arena[322+i]=Number.parseInt(hex.substring(i*2,i*2+2),16);}
 clear(){this.tokens.clear();Reflect.apply(fill,this.arena,[0]);}
}
function range(s:R0Sink,c:R0Core,index:number){const a=c.range(index),b=c.arena;
 s.literal('{"entry":{"byteLength":');s.number(read32(b,a+12));s.literal(',"sha256":');s.hex(b,a+16);s.literal('},"index":');s.number(b[a+1]!);s.literal(',"kind":"');s.literal(b[a]===0?'commit':'payload');
 s.literal('","length":');s.number(read32(b,a+8));s.literal(',"offset":');s.number(read32(b,a+4));s.literal(',"ordinal":');s.number(b[a+2]!);s.byte(125);
}
export function emitCore(s:R0Sink,c:R0Core){
 s.literal('{"binding":');s.token(c.tokens,c.ctx('binding'));s.literal(',"catalog":');s.token(c.tokens,c.ctx('catalog'));s.literal(',"checkpoint":');s.token(c.tokens,c.ctx('checkpoint'));
 s.literal(',"domain":"cpr.plan-core.v3","groups":[');for(let g=0;g<c.n;g++){if(g)s.byte(44);s.byte(91);for(let i=0;i<c.size(g);i++){if(i)s.byte(44);range(s,c,c.start(g)+i);}s.byte(93);}s.literal('],"inventoryDigest":');s.token(c.tokens,c.ctx('inventoryDigest'));
 s.literal(',"lineage":');s.token(c.tokens,c.ctx('lineage'));s.literal(',"metadataDigest":');s.token(c.tokens,c.ctx('metadataDigest'));if(c.ctx('origin')>=0){s.literal(',"origin":');s.token(c.tokens,c.ctx('origin'));}
 s.literal(',"peer":');s.token(c.tokens,c.ctx('peer'));s.literal(',"pin":');s.token(c.tokens,c.ctx('pin'));s.literal(',"provider":');s.token(c.tokens,c.ctx('provider'));s.literal(',"seed":');s.quoted(c.arena,8,c.arena[4]!);
 s.literal(',"snapshot":');s.token(c.tokens,c.ctx('snapshot'));s.literal(',"specDigest":"'+CPR_SPEC_DIGEST+'","transferId":');s.quoted(c.arena,136,c.arena[5]!);s.byte(125);
}
export function emitOperation(s:R0Sink,c:R0Core,ordinal:number,p?:R0Tokens,plan?:number,payload?:number){
 s.literal('{"batchOrdinal":');s.number(ordinal);s.literal(',"domain":"cpr.operation-id.v3","lineage":');s.token(c.tokens,c.ctx('lineage'));s.literal(',"peer":');s.token(c.tokens,c.ctx('peer'));s.literal(',"provider":');s.token(c.tokens,c.ctx('provider'));s.literal(',"seed":');
 if(p)s.token(p,p.field(plan!,'seed'));else s.quoted(c.arena,8,c.arena[4]!);s.literal(',"transferId":');if(p)s.token(p,p.field(payload!,'transferId'));else s.quoted(c.arena,136,c.arena[5]!);s.byte(125);
}
export function emitCommand(s:R0Sink,c:R0Core,ordinal:number,op:string,request?:string){
 s.literal('{"api":"aux.ReadSourceRanges","binding":');s.token(c.tokens,c.ctx('binding'));s.literal(',"lineage":');s.token(c.tokens,c.ctx('lineage'));s.literal(',"operationId":"'+op+'","payload":{"byteBudget":');
 let budget=0;for(let i=0;i<c.size(ordinal);i++)budget+=read32(c.arena,c.range(c.start(ordinal)+i)+8);s.number(budget);
 s.literal(',"checkpoint":');s.token(c.tokens,c.ctx('checkpoint'));if(c.ctx('origin')>=0){s.literal(',"origin":');s.token(c.tokens,c.ctx('origin'));}s.literal(',"pin":');s.token(c.tokens,c.ctx('pin'));
 s.literal(',"plan":{"batchCount":');s.number(c.n);s.literal(',"batchOrdinal":');s.number(ordinal);s.literal(',"inventoryDigest":');s.token(c.tokens,c.ctx('inventoryDigest'));s.literal(',"planDigest":');s.hex(c.arena,322);s.literal(',"seed":');s.quoted(c.arena,8,c.arena[4]!);s.literal(',"specDigest":"'+CPR_SPEC_DIGEST+'"},"ranges":[');
 for(let i=0;i<c.size(ordinal);i++){if(i)s.byte(44);range(s,c,c.start(ordinal)+i);}s.literal('],"snapshot":');s.token(c.tokens,c.ctx('snapshot'));s.literal(',"transferId":');s.quoted(c.arena,136,c.arena[5]!);
 s.literal('},"peer":');s.token(c.tokens,c.ctx('peer'));s.literal(',"purpose":"read"');if(request!==undefined)s.literal(',"requestDigest":"'+request+'"');s.literal(',"schema":"osv-mcp.cgp.source-command.v3"}');
}
export function emitProjection(s:R0Sink,p:R0Tokens){s.literal('{"command":{');let n=0;for(let t=p.child(0);t>=0;t=p.next(t)){
  // The fixed grammar supplies the key tag; no object rest or wrapper is materialized.
  if(t===p.field(0,'requestDigest'))continue;if(n++)s.byte(44);
  // Only the nine fixed top-level fields are reachable here.
  for(const key of ['api','binding','lineage','operationId','payload','peer','purpose','schema'])if(p.field(0,key)===t){s.literal('"'+key+'":');s.token(p,t);break;}
 }s.literal('},"domain":"cpr.wire-intent.v3"}');}
export function checkOwnedCommand(p:R0Tokens,c:R0Core,s:R0Sink){
 const payload=p.field(0,'payload'),plan=p.field(payload,'plan'),ordinal=p.number(p.field(plan,'batchOrdinal')),count=p.number(p.field(plan,'batchCount'));
 need(ordinal<count,'batch_binding');const ranges=p.field(payload,'ranges');let total=0,previous=-1;
 for(let i=0;i<p.children(ranges);i++){const r=p.item(ranges,i),entry=p.field(r,'entry'),offset=p.number(p.field(r,'offset')),length=p.number(p.field(r,'length')),index=p.number(p.field(r,'index'));
  need(p.number(p.field(r,'ordinal'))===i&&offset+length<=p.number(p.field(entry,'byteLength')),'range');total+=length;
  if(previous>=0){const pk=p.textEquals(p.field(previous,'kind'),'commit')?0:1,rk=p.textEquals(p.field(r,'kind'),'commit')?0:1,pi=p.number(p.field(previous,'index'));
   need(rk>pk||rk===pk&&(index>pi||index===pi&&offset>=p.number(p.field(previous,'offset'))+p.number(p.field(previous,'length'))),'range');if(rk===pk&&index===pi)need(p.equal(entry,p,p.field(previous,'entry')),'range');}
  previous=r;
 }
 need(total===p.number(p.field(payload,'byteBudget')),'range_budget');s.begin();emitProjection(s,p);need(p.textEquals(p.field(0,'requestDigest'),s.end() as string),'wire_intent');
 for(const key of ['peer','lineage','binding'])need(p.equal(p.field(0,key),c.tokens,c.ctx(key)),'context_binding');
 for(const key of ['snapshot','checkpoint','pin','origin'])need(p.equal(p.field(payload,key),c.tokens,c.ctx(key)),'context_binding');
 s.begin();emitOperation(s,c,ordinal,p,plan,payload);need(p.textEquals(p.field(0,'operationId'),s.end() as string),'operation');
}
Object.freeze(R0Core.prototype);Object.freeze(R0Core);Object.freeze(R0Sink.prototype);Object.freeze(R0Sink);
