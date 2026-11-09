/** CWC-B closed-tree codec diagnostic. Not a signer, dispatcher or SessionRuntime adapter.
 * Per-command full semantic checks remain. A length receipt is not content/authentication evidence.
 */
import {CWC_DOMAINS,cwcBudgetSchema,type CwcBudget} from './gradleOwnedCwcA.js';
import {context,command,checkCommand,keys,CPR_SPEC_DIGEST,type CprContext,type CprCommand} from './gradleOwnedCprASchema.js';
import {checkResult} from './gradleOwnedCprAWire.js';
import {canonicalOwnedJson as canonical,ownedDigest as hash,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
import {need,parsed} from '../../utils/gradleOwnedCurrentSchema.js';

type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
type Node={kind:'fixed';value:Json;text:string}|{kind:'cid'|'hash'|'signature'}|{kind:'enum';values:readonly string[]}|{kind:'number';min:number;max:number}|{kind:'base64';min:number;max:number}|{kind:'object';fields:readonly (readonly [string,Node])[]}|{kind:'array';item:Node;min:number;max:number};
export type CwcBDomain=typeof CWC_DOMAINS[number];
export type CwcBFamily='owner.request'|'owner.reply'|'auth.challenge-request.request'|'auth.challenge.reply'|'auth.channel.request'|'auth.channel.reply';
export type CwcBProof=Readonly<{kind:'cwc-b-length-proof'}>;
export const CWC_B_GRAMMAR_VERSION='cwc.closed-ascii-tree.v1';
const zero='0'.repeat(64),dummySignature=Buffer.alloc(64).toString('base64');
const cid:Node={kind:'cid'},hex:Node={kind:'hash'},sig:Node={kind:'signature'};
const num=(min:number,max=Number.MAX_SAFE_INTEGER):Node=>({kind:'number',min,max});
const object=(fields:Record<string,Node>):Node=>({kind:'object',fields:Object.entries(fields).sort(([a],[b])=>a<b?-1:a>b?1:0)});
const array=(item:Node,min:number,max:number):Node=>({kind:'array',item,min,max});
/** No getters/toJSON/prototype conversion is invoked before the bounded copy. */
function dataCopy<T>(input:T):T{
 let nodes=0,bytes=0;const active=new Set<object>();
 function visit(v:unknown,depth:number){need(++nodes<=4096&&depth<=32,'codec_budget_exceeded');if(typeof v==='string'){bytes+=Buffer.byteLength(v);need(bytes<=262144,'codec_budget_exceeded');return;}if(v===null||typeof v==='boolean')return;if(typeof v==='number'){need(Number.isSafeInteger(v)&&v>=0&&!Object.is(v,-0),'schema_invalid');return;}need(v&&typeof v==='object'&&!active.has(v)&&(Array.isArray(v)?Object.getPrototypeOf(v)===Array.prototype:[Object.prototype,null].includes(Object.getPrototypeOf(v))),'schema_invalid');if(Array.isArray(v)){const keys=Object.keys(v);need(keys.length===v.length&&keys.every((k,i)=>k===String(i)),'schema_invalid');}active.add(v);const descriptors=Object.getOwnPropertyDescriptors(v);need(Reflect.ownKeys(v).every(k=>typeof k==='string'),'schema_invalid');for(const [k,d]of Object.entries(descriptors)){if(Array.isArray(v)&&k==='length')continue;need(d.enumerable&&'value'in d&&k!=='toJSON','schema_invalid');visit(d.value,depth+1);}active.delete(v);
 }
 visit(input,0);return structuredClone(input);
}
function equal(a:unknown,b:unknown):boolean{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&equal((a as any)[k],(b as any)[k]));}
export function cwcBase64Length(n:number){need(Number.isSafeInteger(n)&&!Object.is(n,-0)&&n>=0&&n<=4096,'schema_invalid');return 4*Math.ceil(n/3);}
function base64Bytes(s:unknown):number{
 need(typeof s==='string'&&s.length>0&&s.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(s),'schema_invalid');
 const padding=s.endsWith('==')?2:s.endsWith('=')?1:0;
 if(padding===2)need(/[AQgw]==$/.test(s),'schema_invalid');if(padding===1)need(/[AEIMQUYcgkosw048]=$/.test(s),'schema_invalid');
 return s.length/4*3-padding;
}
export function assertCwcBBytes(actual:Buffer,oracle:Buffer){need(Buffer.isBuffer(actual)&&Buffer.isBuffer(oracle)&&actual.equals(oracle),'codec_layout_mismatch');}
export type CwcBOptions={context:CprContext;gate:()=>void;now:()=>number;deadline:number;budget:CwcBudget};
type ProofRow={digest:string;request:number;reply:number;frames:number[];total:number};
export class ClosedCwcBCodec {
 readonly #c:CprContext;readonly #gateCallback:()=>void;readonly #now:()=>number;readonly #deadline:number;readonly #budget:CwcBudget;
 readonly #trees=new Map<CwcBDomain,Node>();readonly #verified=new Set<Node>();readonly #virtual=new WeakMap<object,number>();readonly #proofs=new WeakMap<CwcBProof,ProofRow>();
 #closed=false;#busy=false;#last=0;#work=0;#compileCanonical=0;#fragments=0;#fixedBytes=0;#visits=0;#encodes=0;#proofCount=0;#scratchPeak=0;
 constructor(options:CwcBOptions){
  this.#gateCallback=options.gate;this.#now=options.now;this.#deadline=options.deadline;this.#budget=parsed(cwcBudgetSchema,dataCopy(options.budget));
  // Reserve the entire logical diagnostic workspace before copying context/compiling any tree.
  need(this.#budget.bytes>=393216&&this.#budget.fragments>=4096&&this.#budget.work>=131072,'codec_budget_exceeded');this.#work=131072;
  need(Number.isSafeInteger(this.#deadline)&&this.#deadline>0,'configuration_invalid');this.#busy=true;
  try{this.#gate();need(this.#deadline<=this.#last+4500,'request_expired');this.#c=context(dataCopy(options.context));this.#compile();this.#gate();}catch(e){this.close();throw e;}finally{this.#busy=false;}
 }
 #gate(){need(!this.#closed,'owner_closed');this.#gateCallback();const n=this.#now();need(Number.isSafeInteger(n)&&n>=this.#last,'clock_invalid');this.#last=n;need(!this.#closed,'owner_closed');need(n<this.#deadline,'request_expired');}
 #run<T>(cost:number,fn:()=>T){need(!this.#closed,'owner_closed');if(this.#busy){this.#closed=true;need(false,'codec_fact_binding_mismatch');}this.#busy=true;try{this.#gate();need(this.#work+cost<=this.#budget.work,'codec_budget_exceeded');this.#work+=cost;const out=fn();this.#gate();return out;}catch(e){this.close();throw e;}finally{this.#busy=false;}}
 #fixed(value:Json):Node{const copy=dataCopy(value),text=canonical(copy);this.#compileCanonical++;this.#fixedBytes+=Buffer.byteLength(text);need(this.#fixedBytes<=81920,'codec_budget_exceeded');return {kind:'fixed',value:copy,text};}
 #compile(){
  const c=this.#c,f=(v:unknown)=>this.#fixed(v as Json);
  const entry=object({sha256:hex,byteLength:num(1,41460)}),kind:Node={kind:'enum',values:['commit','payload']};
  const requestRange=object({ordinal:num(0,3),kind,index:num(0,8),offset:num(0,41460),length:num(1,4096),entry});
  const plan=object({specDigest:f(CPR_SPEC_DIGEST),seed:cid,batchOrdinal:num(0,18),batchCount:num(1,19),planDigest:hex,inventoryDigest:f(c.inventoryDigest)});
  const payload=object({snapshot:f(c.snapshot),checkpoint:f(c.checkpoint),pin:f(c.pin),...(c.origin?{origin:f(c.origin)}:{}),transferId:cid,plan,ranges:array(requestRange,1,4),byteBudget:num(1,4096)});
  const commandFields={schema:f('osv-mcp.cgp.source-command.v3'),api:f('aux.ReadSourceRanges'),purpose:f('read'),operationId:hex,peer:f(c.peer),lineage:f(c.lineage),binding:f(c.binding),payload,requestDigest:hex};
  const commandNode=object(commandFields),{requestDigest:_,...intentFields}=commandFields;
  this.#trees.set('command.full',commandNode);this.#trees.set('wireIntent.preimage',object({domain:f('cpr.wire-intent.v3'),command:object(intentFields)}));
  const part=object({ordinal:num(0,3),kind,index:num(0,8),entry,offset:num(0,41460),totalBytes:num(1,41460),bytes:{kind:'base64',min:1,max:4096},sha256:hex});
  const resultNode=object({schema:f('osv-mcp.cgp.range-result.v3'),api:f('ReadSourceRanges'),lineage:f(c.lineage),requestDigest:hex,operationKey:hex,mode:f('observed'),snapshot:f(c.snapshot),inventoryDigest:f(c.inventoryDigest),transferId:cid,specDigest:f(CPR_SPEC_DIGEST),planDigest:hex,batchOrdinal:num(0,18),batchCount:num(1,19),parts:array(part,1,4),live:f(false)});
  for(const direction of ['request','reply'] as const){const fields={schema:f('osv-mcp.q2.c3b.owner-envelope.v1'),identity:f(direction==='request'?c.peer:c.provider),keyId:f(direction==='request'?c.requestKeyId:c.replyKeyId),direction:f(direction),domain:f('aux'),api:f('aux.ReadSourceRanges'),body:direction==='request'?object({api:f('ReadSourceRanges'),command:commandNode}):resultNode};
   this.#trees.set(`owner.${direction}.unsigned`,object(fields));this.#trees.set(`owner.${direction}.signed`,object({...fields,signature:sig}));
  }
  for(const [kind,direction]of [['challenge-request','request'],['challenge','reply'],['channel','request'],['channel','reply']] as const){
   const body=object({clientCredentialId:f(c.peer.credentialId),serverCredentialId:f(c.provider.credentialId),deploymentDigest:f(c.deploymentDigest),enrollmentDigest:f(c.lineage.enrollmentDigest),profileDigest:f(c.lineage.profileDigest),registryDigest:f(c.registryDigest),endpointId:f(c.endpointId),clientBoot:f(c.peer.boot),serverBoot:f(c.provider.boot),clientKeyEpoch:f(c.peer.keyEpoch),serverKeyEpoch:f(c.provider.keyEpoch),clientNonce:hex,serverNonce:hex,sessionId:hex,transcriptDigest:hex,sequence:num(1,512),api:f('aux.ReadSourceRanges'),originDigest:hex,ttlMs:num(1,4500),kind:f(kind),...(kind==='channel'?{innerWireDigest:hex}:{requestId:hex}),...(kind!=='challenge-request'?{challenge:hex}:{})});
   const keyId=f(direction==='request'?c.requestKeyId:c.replyKeyId),name=`auth.${kind}.${direction}` as const;
   this.#trees.set(`${name}.unsigned` as CwcBDomain,object({domain:f('osv-mcp.q2.c3b.auth.v1'),direction:f(direction),keyId,body}));
   this.#trees.set(`${name}.signed` as CwcBDomain,object({schema:f('osv-mcp.q2.c3b.auth.v1'),direction:f(direction),keyId,body,signature:sig}));
  }
  // Each variant uses the same induction rules, fixed fragments and key order. No supplied descriptors.
  for(const tree of this.#trees.values())this.#verifyTree(tree);
  need(this.#trees.size===CWC_DOMAINS.length&&CWC_DOMAINS.every(d=>this.#trees.has(d)),'codec_profile_unsupported');
 }
 #verifyTree(n:Node){if(this.#verified.has(n))return;this.#verified.add(n);need(++this.#fragments<=4096,'codec_budget_exceeded');if(n.kind==='object'){this.#fragments+=1+n.fields.length;need(this.#fragments<=4096,'codec_budget_exceeded');const keys=n.fields.map(([k])=>k);need(keys.every((k,i)=>/^[A-Za-z][A-Za-z0-9]*$/.test(k)&&(i===0||keys[i-1]!<k)),'codec_layout_mismatch');for(const [,child]of n.fields)this.#verifyTree(child);}else if(n.kind==='array'){need(n.min>=0&&n.max<=4&&n.min<=n.max,'codec_layout_mismatch');this.#verifyTree(n.item);}else if(n.kind==='fixed'){const records=(v:Json):number=>v&&typeof v==='object'?1+Object.values(v).reduce<number>((sum,x)=>sum+records(x),0):0;this.#fragments+=records(n.value);need(this.#fragments<=4096,'codec_budget_exceeded');this.#compileCanonical++;need(canonical(n.value)===n.text&&Buffer.byteLength(n.text)===n.text.length,'codec_layout_mismatch');}else if(n.kind==='enum')need(n.values.length===2&&n.values.every(v=>/^[A-Za-z]+$/.test(v)),'codec_layout_mismatch');else if(n.kind==='number')need(Number.isSafeInteger(n.min)&&Number.isSafeInteger(n.max)&&n.min>=0&&n.max>=n.min,'codec_layout_mismatch');else if(n.kind==='base64')need(n.min===1&&n.max===4096,'codec_layout_mismatch');else need(['cid','hash','signature'].includes(n.kind),'codec_profile_unsupported');}
 #walk(n:Node,v:unknown,output?:string[],virtual=false):number{
  this.#visits++;
  const emit=(s:string)=>{output?.push(s);return Buffer.byteLength(s);};
  if(n.kind==='fixed'){need(equal(v,n.value),'codec_fact_binding_mismatch');return emit(n.text);}
  if(n.kind==='object'){need(v&&typeof v==='object'&&!Array.isArray(v),'schema_invalid');const keys=Object.keys(v);need(keys.length===n.fields.length&&n.fields.every(([k])=>Object.hasOwn(v,k)),'schema_invalid');let size=emit('{');for(const [i,[k,child]]of n.fields.entries()){if(i)size+=emit(',');if(output)output.push('"'+k+'":');size+=k.length+3;size+=this.#walk(child,(v as any)[k],output,virtual);}return size+emit('}');}
  if(n.kind==='array'){need(Array.isArray(v)&&v.length>=n.min&&v.length<=n.max&&Object.keys(v).length===v.length,'schema_invalid');let size=emit('[');for(let i=0;i<v.length;i++){if(i)size+=emit(',');size+=this.#walk(n.item,v[i],output,virtual);}return size+emit(']');}
  if(n.kind==='number'){need(typeof v==='number'&&Number.isSafeInteger(v)&&!Object.is(v,-0)&&v>=n.min&&v<=n.max,'schema_invalid');const text=String(v);return output?emit(text):text.length;}
  if(n.kind==='base64'&&virtual&&v&&typeof v==='object'){const bytes=this.#virtual.get(v);need(bytes!==undefined&&bytes>=n.min&&bytes<=n.max&&!output,'codec_fact_binding_mismatch');return cwcBase64Length(bytes)+2;}
  need(typeof v==='string','schema_invalid');
  if(n.kind==='enum')need(n.values.includes(v),'schema_invalid');
  if(n.kind==='cid')need(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),'schema_invalid');
  if(n.kind==='hash')need(/^[a-f0-9]{64}$/.test(v),'schema_invalid');
  if(n.kind==='base64'){const bytes=base64Bytes(v);need(bytes>=n.min&&bytes<=n.max,'schema_invalid');}
  if(n.kind==='signature')need(base64Bytes(v)===64,'schema_invalid');
  // These alphabets contain no JSON escapes or non-ASCII; scalar length == UTF-8 bytes.
  return output?emit('"'+v+'"'):v.length+2;
 }
 #node(domain:unknown){need(typeof domain==='string'&&this.#trees.has(domain as CwcBDomain),'codec_profile_unsupported');return this.#trees.get(domain as CwcBDomain)!;}
 #checked(input:unknown){const q=command(dataCopy(input));checkCommand(this.#c,q);return q;}
 #owner(direction:'request'|'reply',body:unknown){const c=this.#c;return {schema:'osv-mcp.q2.c3b.owner-envelope.v1',identity:direction==='request'?c.peer:c.provider,keyId:direction==='request'?c.requestKeyId:c.replyKeyId,direction,domain:'aux',api:'aux.ReadSourceRanges',body};}
 #validateSemantic(domain:CwcBDomain,value:any,q?:CprCommand){
  if(domain==='command.full'){this.#checked(value);return;}
  if(domain==='wireIntent.preimage'){need(value?.domain==='cpr.wire-intent.v3','codec_fact_binding_mismatch');const full={...value.command,requestDigest:hash(value)};this.#checked(full);return;}
  if(domain.startsWith('owner.')){need(q,'codec_fact_binding_mismatch');const expected=this.#checked(q);if(domain.startsWith('owner.request.'))need(equal(value.body,{api:'ReadSourceRanges',command:expected}),'codec_fact_binding_mismatch');else checkResult(this.#c,expected,value.body);}
 }
 #encode(domain:CwcBDomain,input:unknown,expectedCommand?:CprCommand){const node=this.#node(domain),value=dataCopy(input);this.#validateSemantic(domain,value,expectedCommand);const size=this.#walk(node,value);need(size<=(domain.startsWith('auth.')?16384:8192),'codec_budget_exceeded');const fragments:string[]=[];this.#walk(node,value,fragments);const out=Buffer.from(fragments.join(''));need(out.length===size,'codec_layout_mismatch');this.#scratchPeak=Math.max(this.#scratchPeak,3*size);need(this.#scratchPeak<=65536,'codec_budget_exceeded');this.#encodes++;return out;}
 encode(domain:CwcBDomain,input:unknown,expectedCommand?:CprCommand){return this.#run(65536,()=>this.#encode(domain,input,expectedCommand));}
 compareOracle(domain:CwcBDomain,input:unknown,oracle:Buffer,expectedCommand?:CprCommand){return this.#run(73728,()=>{need(Buffer.isBuffer(oracle)&&oracle.length<=(domain.startsWith('auth.')?16384:8192),'codec_budget_exceeded');const out=this.#encode(domain,input,expectedCommand);assertCwcBBytes(out,oracle);return {domain,bytes:out.length,sha256:sha(out)};});}

 planProof(input:unknown):CwcBProof{return this.#run(65536,()=>{
  const q=this.#checked(input),c=this.#c,claim=q.payload.plan;
  const request=this.#owner('request',{api:'ReadSourceRanges',command:q});
  const reply=this.#owner('reply',{schema:'osv-mcp.cgp.range-result.v3',api:'ReadSourceRanges',lineage:c.lineage,requestDigest:q.requestDigest,operationKey:keys(c,q).k,mode:'observed',snapshot:c.snapshot,inventoryDigest:c.inventoryDigest,transferId:q.payload.transferId,specDigest:claim.specDigest,planDigest:claim.planDigest,batchOrdinal:claim.batchOrdinal,batchCount:claim.batchCount,parts:q.payload.ranges.map(r=>{const virtual=Object.freeze({kind:'private-length'});this.#virtual.set(virtual,r.length);return {ordinal:r.ordinal,kind:r.kind,index:r.index,entry:r.entry,offset:r.offset,totalBytes:r.entry.byteLength,bytes:virtual,sha256:zero};}),live:false});
  const requestBytes=this.#walk(this.#node('owner.request.signed'),{...request,signature:dummySignature});
  const replyBytes=this.#walk(this.#node('owner.reply.signed'),{...reply,signature:dummySignature},undefined,true);
  const frames=[['challenge-request','request'],['challenge','reply'],['channel','request'],['channel','reply']].map(([kind,direction])=>{
   const body={clientCredentialId:c.peer.credentialId,serverCredentialId:c.provider.credentialId,deploymentDigest:c.deploymentDigest,enrollmentDigest:c.lineage.enrollmentDigest,profileDigest:c.lineage.profileDigest,registryDigest:c.registryDigest,endpointId:c.endpointId,clientBoot:c.peer.boot,serverBoot:c.provider.boot,clientKeyEpoch:c.peer.keyEpoch,serverKeyEpoch:c.provider.keyEpoch,clientNonce:zero,serverNonce:zero,sessionId:zero,transcriptDigest:zero,sequence:512,api:'aux.ReadSourceRanges',originDigest:zero,ttlMs:4500,kind,...(kind==='channel'?{innerWireDigest:zero}:{requestId:zero}),...(kind!=='challenge-request'?{challenge:zero}:{})};
   return this.#walk(this.#node(`auth.${kind}.${direction}.signed`),{schema:'osv-mcp.q2.c3b.auth.v1',direction,keyId:direction==='request'?c.requestKeyId:c.replyKeyId,body,signature:dummySignature});
  });need(requestBytes<=8192&&replyBytes<=8192&&frames.every(n=>n<=16384),'codec_budget_exceeded');
  const h=Object.freeze({kind:'cwc-b-length-proof' as const});this.#proofs.set(h,{digest:hash(q),request:requestBytes,reply:replyBytes,frames,total:requestBytes+replyBytes+frames.reduce((a,b)=>a+b,0)});this.#proofCount++;return h;
 });}
 inspectProof(proof:CwcBProof,expectedCommand:unknown){return this.#run(8192,()=>{const row=this.#proofs.get(proof),q=this.#checked(expectedCommand);need(row&&row.digest===hash(q),'codec_fact_binding_mismatch');return {...structuredClone(row),proofKind:'closed-tree-length-only' as const,contentProven:false,authorityGranted:false,compositionOracleRequired:true};});}
 close(){this.#closed=true;this.#trees.clear();this.#verified.clear();}
 get diagnostics(){return {grammarVersion:CWC_B_GRAMMAR_VERSION,domains:this.#trees.size,fixedFragmentCanonicalCalls:this.#compileCanonical,fixedBytes:this.#fixedBytes,fragments:this.#fragments,logicalWorkspaceReserved:393216,scratchPeak:this.#scratchPeak,workSpent:this.#work,visits:this.#visits,encodes:this.#encodes,proofs:this.#proofCount,closed:this.#closed};}
}
