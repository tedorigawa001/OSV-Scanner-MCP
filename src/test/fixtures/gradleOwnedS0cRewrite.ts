import {sign} from 'node:crypto';
import {canonicalOwnedJson,ownedDigest,ownedSha256 as h} from '../../utils/gradleOwnedJson.js';
import type {Bundle} from './gradleOwnedS0c.js';
const parse=(o:{bytes:Buffer})=>JSON.parse(o.bytes.toString());
/** Adds a canonical object so a later rewrite can reference it; shared objects stay untouched. */
export function addS0cObject(b:Bundle,value:any,role:Bundle['roots'][number]['role']){const bytes=Buffer.from(canonicalOwnedJson(value,8388608)),ref={schema:value.schema,role,sha256:h(bytes),byteLength:bytes.length};b.objects.push({ref,bytes});return ref;}
/** Re-hashes the whole DAG and re-signs compact records, so a semantic check cannot rely on a stale hash. With refreshDigests, root state digests follow too, reaching the checks behind them. */
export function rewriteS0c(b:Bundle,keys:any,change:(o:any)=>void,refreshDigests=false){
 const prior=new Map(b.objects.map(o=>[o.ref.sha256,o])),done=new Map<string,any>();
 const walk=(v:any):any=>{if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object'){if(v.sha256&&v.role&&v.schema&&v.byteLength&&prior.has(v.sha256)){const next=object(v.sha256).ref;return {...v,sha256:next.sha256,byteLength:next.byteLength};}return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));}return v;};
 const byNew=(ref:any)=>parse([...done.values()].find((o:any)=>o.ref.sha256===ref.sha256));
 const rowsOf=(ref:any)=>{const rows=byNew(ref).pages.flatMap((p:any)=>byNew(p.ref).data.rows);rows.sort((x:any,y:any)=>x.ordinal-y.ordinal);return rows.map((r:any)=>r.value);};
 function stateOf(root:any){const state:any={};for(const d of root.directories)state[d.field]=rowsOf(d.ref);if(root.liveness){const live=byNew(root.liveness);Object.assign(state,live.value);if(!live.handoffsPresent)delete state.handoffs;}return state;}
 function object(id:string):any{if(done.has(id))return done.get(id);const old=prior.get(id)!,value=parse(old);change(value);const next=walk(value);if(refreshDigests&&next.schema==='cgp.s0.owner-root.v1')next.stateDigest=ownedDigest(stateOf(next));if(next.schema==='cgp.s0.signed-record.v1')next.signature=sign(null,Buffer.from(canonicalOwnedJson(next.body)),keys.compactPrivate).toString('base64');const bytes=Buffer.from(canonicalOwnedJson(next,8388608)),o={ref:{...old.ref,sha256:h(bytes),byteLength:bytes.length},bytes};done.set(id,o);return o;}
 b.roots=b.roots.map(r=>object(r.sha256).ref);b.retained=b.retained.map(r=>({...r,ref:object(r.ref.sha256).ref}));for(const id of prior.keys())object(id);b.objects=[...new Map([...done.values()].map(o=>[o.ref.sha256,o])).values()];
}
