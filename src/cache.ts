#!/usr/bin/env node
/** Explicit online preparation; never invoked by an MCP scan. */
import {prepareOfflineDatabases,OFFLINE_ECOSYSTEMS} from './osv/offlineCache.js';
import {offlineConfig} from './osv/offline.js';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
export async function runCacheCli(args:string[]){
if(args.length===1&&args[0]==='--help'){
 console.log('Usage: osv-scanner-mcp cache --ecosystems npm,PyPI [--directory /absolute/cache]\nDownloads complete public OSV ecosystem ZIPs. No project files are read.\nSupported: '+OFFLINE_ECOSYSTEMS.join(', '));
}else{
 try{const values=new Map<string,string>();for(let i=0;i<args.length;i+=2){const k=args[i]!,v=args[i+1];if(!['--ecosystems','--directory'].includes(k)||v===undefined||values.has(k))throw Error('Invalid or duplicate argument; use --help');values.set(k,v);}
  const ecosystems=values.get('--ecosystems');if(!ecosystems)throw Error('--ecosystems is required; use --help');
  const manifest=await prepareOfflineDatabases({dir:values.get('--directory')??offlineConfig().dir,ecosystems:ecosystems.split(',')});console.log(JSON.stringify({status:'ready',...manifest},null,2));
 }catch(e){console.error(e instanceof Error?e.message:'Offline cache preparation failed');process.exitCode=1;}
}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await runCacheCli(process.argv.slice(2));
