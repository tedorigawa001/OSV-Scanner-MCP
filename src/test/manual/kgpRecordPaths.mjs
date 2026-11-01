/** Portable path tokens for published KGP availability records; verification sources only. */
import path from 'node:path';
export const recordTokens=['$GRADLE_USER_HOME','$GRADLE_RUNTIME'];
const absolute=/(^|[\s"'=:])(\/(private|Users|var|tmp|home|opt)\/|[A-Za-z]:\\)/;
// roots: [{token, paths:[spelling, realpath, ...]}]; longer spellings are replaced first.
export function tokenizeRecordedPaths(value,roots){
 const pairs=roots.flatMap(r=>r.paths.filter(Boolean).map(p=>[p.replace(/\/+$/,''),r.token])).sort((a,b)=>b[0].length-a[0].length);
 const walk=v=>{
  if(typeof v==='string'){let s=v;for(const [p,token]of pairs)s=s.split(p+'/').join(token+'/');return s;}
  if(Array.isArray(v))return v.map(walk);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));
  return v;
 };
 return walk(value);
}
export function assertNoAbsolutePaths(value,where='record'){
 const walk=(v,at)=>{
  if(typeof v==='string'){if(absolute.test(v))throw Error('kgp_availability_record_path_not_portable: '+at);return;}
  if(Array.isArray(v))v.forEach((x,i)=>walk(x,at+'['+i+']'));
  else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))walk(x,at+'.'+k);
 };
 walk(value,where);
}
export function resolveRecordedPath(recorded,env){
 const token=recordTokens.find(t=>recorded.startsWith(t+'/'));
 if(!token)throw Error('kgp_availability_record_path_not_portable');
 const base=token==='$GRADLE_USER_HOME'?env.GRADLE_USER_HOME:env.OSV_MCP_GRADLE_RUNTIME_ROOT;
 if(!base||!path.isAbsolute(base))throw Error('kgp_availability_record_root_missing: '+token);
 const rest=recorded.slice(token.length+1);
 if(rest.split('/').some(p=>p===''||p==='.'||p==='..'))throw Error('kgp_availability_record_path_not_portable');
 return path.join(base,rest);
}
