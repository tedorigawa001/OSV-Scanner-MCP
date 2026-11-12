/** Independent legacy oracles and mutation corpus: entirely outside the owned command path. */
import {r0Fixture} from './gradleOwnedCwcR0Fixture.js';
import {R0Core,R0Sink,checkOwnedCommand} from './gradleOwnedCwcR0Engine.js';
import {R0Tokens} from './gradleOwnedCwcR0Tokens.js';
import {R0_COMMAND} from './gradleOwnedCwcR0Grammar.js';
import {cprCommandSchema,checkCommand,operation,wireIntent} from './gradleOwnedCprASchema.js';
import {canonicalOwnedJson as canonical,ownedSha256 as sha} from '../../utils/gradleOwnedJson.js';
type Path=(string|number)[];
function loose(v:any):string {if(Array.isArray(v))return '['+v.map(loose).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+loose(v[k])).join(',')+'}';return Object.is(v,-0)?'-0':JSON.stringify(v);}
function locate(q:any,path:Path){let p=q;for(const k of path.slice(0,-1))p=p[k];return p;}
export function r0Differential(){const rows=[];
 for(const role of ['reader','authority-broker'] as const){
  const f=r0Fixture({role}),ctx=Buffer.from(canonical(f.context)),c=new R0Core(Buffer.alloc(f.owner.stats().coreWidth),ctx.length,ctx,f.groups,f.core.seed,f.core.transferId),p=new R0Tokens(Buffer.alloc(8192)),s=new R0Sink(Buffer.alloc(4096),()=>{});
  f.owner.close();const q=f.commands[0]!,inputs:{id:string;text:string;semantic:boolean}[]=[];
  const add=(id:string,v:any,semantic=false)=>inputs.push({id,text:typeof v==='string'?v:loose(v),semantic});
  add('valid',q);add('valid-semantic',q,true);
  const provision=structuredClone(q) as any;provision.binding.mode='provision';provision.binding.selected=null;add('provision-schema',provision);
  const mutate=(id:string,path:Path,value:any,remove=false)=>{const v=structuredClone(q),parent=locate(v,path);if(remove)delete parent[path.at(-1)!];else parent[path.at(-1)!]=value;add(id,v);};
  function walk(v:any,path:Path){
   if(v&&typeof v==='object'){
    if(!Array.isArray(v)){const x=structuredClone(q),at=path.length?locate(x,path)[path.at(-1)!]:x;at.unregistered=0;add('unknown:'+path.join('.'),x);}
    for(const [k,x]of Object.entries(v)){const child=[...path,Array.isArray(v)?Number(k):k];if(!Array.isArray(v))mutate('missing:'+child.join('.'),child,null,true);
     mutate('type:'+child.join('.'),child,x===null?{}:null);walk(x,child);}
   }else if(typeof v==='number')for(const n of [-1,-0,0,1,2,3,4,8,9,18,19,20,256,257,4096,4097,41460,41461,65536,65537,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,1.5])mutate('number:'+path.join('.')+':'+String(n)+(Object.is(n,-0)?':negative-zero':''),path,n);
   else if(typeof v==='string')for(const x of ['', 'a','a'.repeat(64),'Z'.repeat(64),'a'.repeat(128),'a'.repeat(129),'bad value','日本語','read','serving','provision','v1','v2','reader','authority-broker','snapshot'])mutate('string:'+path.join('.')+':'+x,path,x);
  }walk(q,[]);
  add('whitespace',' '+canonical(q));add('reverse-wire',JSON.stringify(Object.fromEntries(Object.entries(q).reverse())));
  add('duplicate-key',canonical(q).replace('{','{"api":"aux.ReadSourceRanges",'));
  add('escape',canonical(q).replace('read"','r\\u0065ad"'));
  add('trailing',canonical(q)+'0');add('invalid-utf8',canonical(q).replace('read"','r\uFFFDad"'));
  // Repair hashes deliberately: schema/semantic violations cannot hide behind a stale digest.
  for(const name of ['seed','transfer','planDigest','inventoryDigest','entryHash','ordinal','budget','bounds','context'] as const){
   const v=structuredClone(q);
   if(name==='seed')v.payload.plan.seed='alternative.seed';if(name==='transfer')v.payload.transferId='alternative.transfer';
   if(name==='planDigest')v.payload.plan.planDigest='b'.repeat(64);if(name==='inventoryDigest')v.payload.plan.inventoryDigest='b'.repeat(64);
   if(name==='entryHash')v.payload.ranges[0]!.entry.sha256='b'.repeat(64);if(name==='ordinal')v.payload.ranges[0]!.ordinal=1;
   if(name==='budget')v.payload.byteBudget++;if(name==='bounds')v.payload.ranges[0]!.offset=41460;if(name==='context')v.peer.instanceId='another.peer';
   v.operationId=operation(f.context,v.payload.plan.seed,v.payload.transferId,v.payload.plan.batchOrdinal);v.requestDigest=wireIntent(v);add('semantic:'+name,v,true);
  }
  for(const input of inputs){const bytes=Buffer.from(input.text);let legacy=false,owned=false;
   try{const v=JSON.parse(input.text);if(input.semantic)checkCommand(f.context,v);else cprCommandSchema.parse(v);legacy=canonical(v)===input.text;}catch{}
   try{p.parse(bytes,bytes.length,R0_COMMAND);if(input.semantic)checkOwnedCommand(p,c,s);owned=true;}catch{}finally{s.abort();p.clear();}
   if(legacy!==owned)throw Error('r0_differential:'+role+':'+input.id+':'+legacy+':'+owned);
   rows.push({role,id:input.id,semantic:input.semantic,bytes:bytes.length,sha256:sha(bytes),legacy,owned,frames:p.metrics.frames,tokensAfter:p.count});
  }c.clear();ctx.fill(0);
 }
 return {schema:'cwc-r0.differential.v1',rows};
}
